import { GameState, PlayerState, CardInstance, MagicSubtype } from './types';

export function executeDrawPhase(state: GameState): GameState {
  const currentTurnPlayerId = state.playerOrder[state.currentTurnPlayerIndex];
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

  // Draw cards from top of deck and set isFaceUp to true for hand
  const cardsDrawn = player.deck.slice(0, drawCount).map(c => ({
    ...c,
    isFaceUp: true
  }));
  const remainingDeck = player.deck.slice(drawCount);

  // Win/Loss Condition: Deck reaches 0 immediately [RuleBook p.21]
  if (player.deck.length < drawCount) {
    state.eventLog.push({
      timestamp: Date.now(),
      type: 'PLAYER_DECK_OUT',
      description: `${player.name} ran out of cards in deck and lost the game.`,
      actorId: player.id
    });
  }

  const updatedHand = [...player.hand, ...cardsDrawn];

  const updatedPlayer: PlayerState = {
    ...player,
    avatarZone: updatedAvatarZone,
    deck: remainingDeck,
    hand: updatedHand,
    usedMagicTypesThisTurn: updatedMagicTypes,
    reactMagicBudget: updatedBudget
  };

  return {
    ...state,
    currentPhase: 'MAIN',
    players: {
      ...state.players,
      [currentTurnPlayerId]: updatedPlayer
    },
    eventLog: [
      ...state.eventLog,
      {
        timestamp: Date.now(),
        type: 'DRAW_PHASE_COMPLETE',
        description: `${player.name} drew ${drawCount} card(s) and awakened avatars. Transitioned to Main Phase.`,
        actorId: player.id
      }
    ]
  };
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
