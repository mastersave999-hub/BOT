import { GameState, PlayerState, CardInstance, MagicSubtype } from './types';
import { executeCardAbility, expireModifiersAt, clearEndOfTurnModifiers } from './abilityEngine';
import { moveCardBetweenZones } from './gameRules';
import { runGameTransaction } from './gameTransaction';
import { appendGameEvents } from './gameEvents';

export function isFirstPlayerFirstTurn(state: GameState, playerId: string): boolean {
  return state.turnNumber === 1 && state.playerOrder[0] === playerId && state.playerOrder[state.currentTurnPlayerIndex] === playerId;
}

export function nextPhaseAfterMain(state: GameState, playerId: string): 'BATTLE' | 'END' {
  return isFirstPlayerFirstTurn(state, playerId) ? 'END' : 'BATTLE';
}

export function transitionGamePhase(state: GameState, playerId: string, nextPhase: GameState['currentPhase']): GameState {
  if (!state.players[playerId] || state.playerOrder[state.currentTurnPlayerIndex] !== playerId || state.currentPhase === nextPhase) return state;
  const nextTurnNumber = nextPhase === 'DRAW' && state.currentPhase === 'END' ? state.turnNumber + 1 : state.turnNumber;
  return appendGameEvents({ ...state, currentPhase: nextPhase }, [
    { type: 'PHASE_ENDED', phase: state.currentPhase, playerId, turnNumber: state.turnNumber, eventId: `${state.id}:phase-ended:${state.currentPhase}:${state.turnNumber}:${playerId}` },
    { type: 'PHASE_STARTED', phase: nextPhase, playerId, turnNumber: nextTurnNumber, eventId: `${state.id}:phase-started:${nextPhase}:${nextTurnNumber}:${playerId}` }
  ]);
}

export function executeDrawPhase(inputState: GameState): GameState {
  const currentTurnPlayerId = inputState.playerOrder[inputState.currentTurnPlayerIndex];
  if (!currentTurnPlayerId || !inputState.players[currentTurnPlayerId]) throw new Error('Player not found');

  const transaction = runGameTransaction(inputState, draft => {
    const expiredState = expireModifiersAt(draft, 'DRAW_PHASE', currentTurnPlayerId);
    const state: GameState = {
      ...expiredState,
      players: Object.fromEntries(Object.entries(expiredState.players).map(([playerId, player]) => [playerId, {
        ...player,
        usedMagicTypesThisTurn: new Set<MagicSubtype>(),
        reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 }
      }]))
    };
    const player = state.players[currentTurnPlayerId];
    if (!player) return null;

    let drawCount = 1;
    if (state.turnNumber === 1 && state.currentTurnPlayerIndex === 0) drawCount = 2;
    else if (player.hand.length < 3) drawCount = 3 - player.hand.length;

    let nextState = state;
    const misplacedLifeIds = player.deck.filter(card => card.card.type === 'Life').map(card => card.instanceId);
    for (const instanceId of misplacedLifeIds) {
      const movement = moveCardBetweenZones(nextState, {
        instanceId, actorId: currentTurnPlayerId, destination: 'lifeDeck', destinationPlayerId: currentTurnPlayerId
      });
      if (!movement.ok) return null;
      nextState = movement.state;
    }

    const drawIds = nextState.players[currentTurnPlayerId].deck.slice(0, drawCount).map(card => card.instanceId);
    for (const instanceId of drawIds) {
      const movement = moveCardBetweenZones(nextState, {
        instanceId, actorId: currentTurnPlayerId, destination: 'hand', destinationPlayerId: currentTurnPlayerId
      });
      if (!movement.ok) return null;
      const movedPlayer = movement.state.players[currentTurnPlayerId];
      nextState = {
        ...movement.state,
        players: { ...movement.state.players, [currentTurnPlayerId]: {
          ...movedPlayer,
          hand: movedPlayer.hand.map(card => card.instanceId === instanceId ? { ...card, isFaceUp: true } : card)
        } }
      };
    }

    const updatedPlayer = nextState.players[currentTurnPlayerId];
    const deckOutEvents = player.deck.filter(card => card.card.type !== 'Life').length < drawCount ? [{
      timestamp: Date.now(),
      type: 'PLAYER_DECK_OUT',
      description: `${player.name} ran out of cards in deck and lost the game.`,
      actorId: player.id
    }] : [];
    nextState = {
      ...nextState,
      currentPhase: 'MAIN',
      players: { ...nextState.players, [currentTurnPlayerId]: {
        ...updatedPlayer,
        avatarZone: updatedPlayer.avatarZone.map(avatar => ({ ...avatar, isRested: false })),
        pendingLifeEffects: []
      } },
      eventLog: [
        ...nextState.eventLog,
        ...deckOutEvents,
        {
          timestamp: Date.now(),
          type: 'DRAW_PHASE_COMPLETE',
          description: `${player.name} drew ${drawIds.length} card(s) and awakened avatars. Transitioned to Main Phase.`,
          actorId: player.id
        }
      ]
    };

    for (const lifeCardId of player.pendingLifeEffects ?? []) {
      const lifeCard = updatedPlayer.lifeDeck.find(card => card.instanceId === lifeCardId);
      if (!lifeCard?.isFaceUp) continue;
      const result = executeCardAbility(nextState, currentTurnPlayerId, lifeCard, 'LIFE_FLIP');
      nextState = result.state;
      if (result.logs.length > 0) nextState = {
        ...nextState,
        eventLog: [...nextState.eventLog, ...result.logs.map(description => ({
          timestamp: Date.now(), type: 'LIFE_FLIP', description, actorId: currentTurnPlayerId
        }))]
      };
    }
    return nextState;
  }, [
    { type: 'PHASE_ENDED', phase: 'DRAW', playerId: currentTurnPlayerId, turnNumber: inputState.turnNumber, eventId: `${inputState.id}:phase-ended:DRAW:${inputState.turnNumber}:${currentTurnPlayerId}` },
    { type: 'PHASE_STARTED', phase: 'MAIN', playerId: currentTurnPlayerId, turnNumber: inputState.turnNumber, eventId: `${inputState.id}:phase-started:MAIN:${inputState.turnNumber}:${currentTurnPlayerId}` }
  ]);

  if (transaction.ok === false) throw new Error(`Draw Phase transaction failed: ${transaction.reason}`);
  return transaction.state;
}

/** Final End Phase transition shared by offline and multiplayer discard commands. */
export function finishEndPhaseTurn(state: GameState): GameState {
  const activePlayerId = state.playerOrder[state.currentTurnPlayerIndex];
  if (state.currentPhase !== 'END' || state.pendingEndPhaseDiscardPlayerId || !activePlayerId || state.playerOrder.length === 0 ||
    (state.players[activePlayerId]?.hand.length ?? 0) > 7) return state;
  const turnNumber = state.turnNumber + 1;
  const nextIndex = (state.currentTurnPlayerIndex + 1) % state.playerOrder.length;
  const nextPlayerId = state.playerOrder[nextIndex];
  const transaction = runGameTransaction(state, draft => {
    const nextState = clearEndOfTurnModifiers(draft);
    const nextPlayer = nextState.players[nextPlayerId];
    return {
      ...nextState,
      currentTurnPlayerIndex: nextIndex,
      currentPhase: 'DRAW',
      turnNumber,
      stateRevision: (state.stateRevision ?? 0) + 1,
      eventLog: [
        ...nextState.eventLog,
        { timestamp: Date.now(), type: 'TURN_ENDED', description: `${state.players[activePlayerId]?.name ?? activePlayerId} ended the turn.`, actorId: activePlayerId },
        { timestamp: Date.now(), type: 'TURN_STARTED', description: `${nextPlayer?.name ?? nextPlayerId} started turn ${turnNumber}.`, actorId: nextPlayerId }
      ]
    };
  }, [
    { type: 'PHASE_ENDED', phase: 'END', playerId: activePlayerId, turnNumber: state.turnNumber, eventId: `${state.id}:phase-ended:END:${state.turnNumber}:${activePlayerId}` },
    { type: 'TURN_ENDED', playerId: activePlayerId, turnNumber: state.turnNumber, eventId: `${state.id}:turn-ended:${state.turnNumber}:${activePlayerId}` },
    { type: 'TURN_STARTED', playerId: nextPlayerId, turnNumber, eventId: `${state.id}:turn-started:${turnNumber}:${nextPlayerId}` },
    { type: 'PHASE_STARTED', phase: 'DRAW', playerId: nextPlayerId, turnNumber, eventId: `${state.id}:phase-started:DRAW:${turnNumber}:${nextPlayerId}` }
  ]);
  return transaction.ok ? transaction.state : state;
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
  if (!eliminated) return { state, winnerId: null };

  const transaction = runGameTransaction(state, draft => {
    let nextState = draft;
    const zoneNames = ['deck', 'hand', 'lifeDeck', 'avatarZone', 'constructZone', 'magicZone', 'hell', 'darkDimension'] as const;
    const cardIds = zoneNames.flatMap(zone => eliminated[zone].map(card => card.instanceId));
    if (draft.landMagicZone?.ownerId === playerId) cardIds.push(draft.landMagicZone.instanceId);
    for (const instanceId of cardIds) {
      const movement = moveCardBetweenZones(nextState, {
        instanceId, actorId: playerId, destination: 'removedFromGame', effectMove: true
      });
      if (!movement.ok) return null;
      nextState = movement.state;
    }

    const clearedPlayer: PlayerState = {
      ...nextState.players[playerId],
      deck: [], hand: [], lifeDeck: [], avatarZone: [], constructZone: [], magicZone: [], hell: [], darkDimension: []
    };
    return {
      ...nextState,
      playerOrder,
      currentTurnPlayerIndex,
      currentPhase: wasActive ? 'DRAW' : nextState.currentPhase,
      turnNumber: wasActive ? nextState.turnNumber + 1 : nextState.turnNumber,
      players: { ...nextState.players, [playerId]: clearedPlayer },
      eventLog: [...nextState.eventLog, {
        timestamp: Date.now(),
        type: 'PLAYER_ELIMINATED',
        description: `${eliminated.name} ${reason}`,
        actorId: playerId
      }]
    };
  });
  if (!transaction.ok) return { state, winnerId: null };
  return { state: transaction.state, winnerId: playerOrder.length === 1 ? playerOrder[0] : null };
}
