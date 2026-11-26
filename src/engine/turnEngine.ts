import { GameState, PlayerState, CardInstance, MagicSubtype } from './types';
import { executeCardAbility, expireModifiersAt, clearEndOfTurnModifiers } from './abilityEngine';
import { appendGameEvents } from './gameEvents';

export function isFirstPlayerFirstTurn(state: GameState, playerId: string): boolean {
  return state.turnNumber === 1 && state.playerOrder[0] === playerId && state.playerOrder[state.currentTurnPlayerIndex] === playerId;
}

export function nextPhaseAfterMain(state: GameState, playerId: string): 'BATTLE' | 'END' {
  return isFirstPlayerFirstTurn(state, playerId) ? 'END' : 'BATTLE';
}

export function executeDrawPhase(inputState: GameState): GameState {
  const currentTurnPlayerId = inputState.playerOrder[inputState.currentTurnPlayerIndex];
  const expiredState = expireModifiersAt(inputState, 'DRAW_PHASE', currentTurnPlayerId);
  const state: GameState = {
    ...expiredState,
    players: Object.fromEntries(Object.entries(expiredState.players).map(([playerId, player]) => [playerId, {
      ...player,
      usedMagicTypesThisTurn: new Set<MagicSubtype>(),
      reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 }
    }]))
  };
  const player = state.players[currentTurnPlayerId];

  if (!player) throw new Error('Player not found');

  // RuleBook p.21: Simultaneously awaken rested Avatars and draw cards
  const updatedAvatarZone = player.avatarZone.map(avatar => ({
    ...avatar,
    isRested: false
  }));

  // Reset per-turn magic restrictions
  const updatedMagicTypes = new Set<MagicSubtype>();
  const updatedBudget = {
    ownTurnRemaining: 1,
    opponentTurnRemaining: 1
  };

  // RuleBook p.21 Draw calculation:
  // - First turn player on Turn 1 draws 2 cards
  // - Otherwise: If hand < 3, draw to 3. If hand >= 3, draw 1 card.
  let drawCount = 1;
  if (state.turnNumber === 1 && state.currentTurnPlayerIndex === 0) {
    drawCount = 2;
  } else if (player.hand.length < 3) {
    drawCount = 3 - player.hand.length;
  } else {
    drawCount = 1;
  }

  // LIFE cards are a separate zone and must never enter normal deck drawing.
  const mainDeck = player.deck.filter(card => card.card.type !== 'Life');
  const cardsDrawn = mainDeck.slice(0, drawCount).map(c => ({
    ...c,
    isFaceUp: true
  }));
  const remainingDeck = mainDeck.slice(drawCount);

  // Win/Loss Condition: Main Deck reaches 0 immediately [RuleBook p.21].
  const deckOutEvents = mainDeck.length < drawCount ? [{
    timestamp: Date.now(),
    type: 'PLAYER_DECK_OUT',
    description: `${player.name} ran out of cards in deck and lost the game.`,
    actorId: player.id
  }] : [];

  const updatedHand = [...player.hand, ...cardsDrawn];

  const updatedPlayer: PlayerState = {
    ...player,
    avatarZone: updatedAvatarZone,
    deck: remainingDeck,
    hand: updatedHand,
    pendingLifeEffects: [],
    usedMagicTypesThisTurn: updatedMagicTypes,
    reactMagicBudget: updatedBudget
  };

  let nextState: GameState = {
    ...state,
    currentPhase: 'MAIN',
    players: {
      ...state.players,
      [currentTurnPlayerId]: updatedPlayer
    },
    eventLog: [
      ...state.eventLog,
      ...deckOutEvents,
      {
        timestamp: Date.now(),
        type: 'DRAW_PHASE_COMPLETE',
        description: `${player.name} drew ${cardsDrawn.length} card(s) and awakened avatars. Transitioned to Main Phase.`,
        actorId: player.id
      }
    ]
  };

  // Rule Book 3.2 p.22: resolve LIFE abilities revealed by attacks last turn
  // immediately as this player's Main Phase begins, in queued (top-to-bottom) order.
  for (const lifeCardId of player.pendingLifeEffects ?? []) {
    const lifeCard = updatedPlayer.lifeDeck.find(card => card.instanceId === lifeCardId);
    if (!lifeCard?.isFaceUp) continue;

    const result = executeCardAbility(nextState, currentTurnPlayerId, lifeCard, 'LIFE_FLIP');
    nextState = result.state;
    if (result.logs.length > 0) {
      nextState.eventLog = [
        ...nextState.eventLog,
        ...result.logs.map(description => ({
          timestamp: Date.now(),
          type: 'LIFE_FLIP',
          description,
          actorId: currentTurnPlayerId
        }))
      ];
    }
  }

  return nextState;
}

/** Final End Phase transition shared by offline and multiplayer discard commands. */
export function finishEndPhaseTurn(state: GameState): GameState {
  const activePlayerId = state.playerOrder[state.currentTurnPlayerIndex];
  if (state.currentPhase !== 'END' || state.pendingEndPhaseDiscardPlayerId || !activePlayerId || state.playerOrder.length === 0 ||
    (state.players[activePlayerId]?.hand.length ?? 0) > 7) return state;
  const turnNumber = state.turnNumber + 1;
  const nextIndex = (state.currentTurnPlayerIndex + 1) % state.playerOrder.length;
  let nextState = clearEndOfTurnModifiers(state);
  nextState = {
    ...nextState,
    currentTurnPlayerIndex: nextIndex,
    currentPhase: 'DRAW',
    turnNumber,
    stateRevision: (state.stateRevision ?? 0) + 1
  };
  const nextPlayerId = nextState.playerOrder[nextIndex];
  const nextPlayer = nextState.players[nextPlayerId];
  nextState.eventLog = [
    ...nextState.eventLog,
    { timestamp: Date.now(), type: 'TURN_ENDED', description: `${state.players[activePlayerId]?.name ?? activePlayerId} ended the turn.`, actorId: activePlayerId },
    { timestamp: Date.now(), type: 'TURN_STARTED', description: `${nextPlayer?.name ?? nextPlayerId} started turn ${turnNumber}.`, actorId: nextPlayerId }
  ];
  return appendGameEvents(nextState, [
    { type: 'TURN_ENDED', playerId: activePlayerId, turnNumber: state.turnNumber, eventId: `${state.id}:turn-ended:${state.turnNumber}:${activePlayerId}` },
    { type: 'TURN_STARTED', playerId: nextPlayerId, turnNumber, eventId: `${state.id}:turn-started:${turnNumber}:${nextPlayerId}` }
  ]);
}

/**
 * Ad-Mua rule 5: an eliminated player's cards leave the game immediately and the
 * turn order closes up. The last surviving player is reported as the winner.
 */
export function eliminatePlayer(
  state: GameState,
  playerId: string,
  reason = 'ถูกกำจัดออกจากเกม'
): { state: GameState; winnerId: string | null } {
  const eliminatedIndex = state.playerOrder.indexOf(playerId);
  if (eliminatedIndex === -1) return { state, winnerId: null };

  const playerOrder = state.playerOrder.filter(id => id !== playerId);
  const wasActive = eliminatedIndex === state.currentTurnPlayerIndex;

  let currentTurnPlayerIndex = state.currentTurnPlayerIndex;
  if (eliminatedIndex < currentTurnPlayerIndex) currentTurnPlayerIndex -= 1;
  if (playerOrder.length > 0) currentTurnPlayerIndex %= playerOrder.length;

  const eliminated = state.players[playerId];
  const clearedPlayer: PlayerState = {
    ...eliminated,
    deck: [],
    hand: [],
    lifeDeck: [],
    avatarZone: [],
    constructZone: [],
    magicZone: [],
    hell: [],
    darkDimension: []
  };

  const nextState: GameState = {
    ...state,
    playerOrder,
    currentTurnPlayerIndex,
    currentPhase: wasActive ? 'DRAW' : state.currentPhase,
    turnNumber: wasActive ? state.turnNumber + 1 : state.turnNumber,
    landMagicZone: state.landMagicZone?.ownerId === playerId ? null : state.landMagicZone,
    players: { ...state.players, [playerId]: clearedPlayer },
    eventLog: [
      ...state.eventLog,
      {
        timestamp: Date.now(),
        type: 'PLAYER_ELIMINATED',
        description: `${eliminated?.name ?? playerId} ${reason}`,
        actorId: playerId
      }
    ]
  };

  return { state: nextState, winnerId: playerOrder.length === 1 ? playerOrder[0] : null };
}
