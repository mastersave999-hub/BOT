import { GameState, PlayerState, CardInstance, MagicSubtype } from './types';
import { executeCardAbility, expireModifiersAt, clearEndOfTurnModifiers } from './abilityEngine';
import { changeAvatarControl, moveCardBetweenZones } from './gameRules';
import { runGameTransaction } from './gameTransaction';
import { appendGameEvents } from './gameEvents';

export function isFirstPlayerFirstTurn(state: GameState, playerId: string): boolean {
  return state.turnNumber === 1 && state.playerOrder[0] === playerId && state.playerOrder[state.currentTurnPlayerIndex] === playerId;
}

export function nextPhaseAfterMain(state: GameState, playerId: string): 'BATTLE' | 'END' {
  return isFirstPlayerFirstTurn(state, playerId) ? 'END' : 'BATTLE';
}

/**
 * UI label for the MAIN-phase advance button. Derived from nextPhaseAfterMain()
 * so the button always describes the transition the engine will actually perform
 * (the first player's Turn 1 has no Battle Phase — Rule Book 3.2 p.22).
 */
export function mainPhaseAdvanceLabel(state: GameState, playerId: string): string {
  return nextPhaseAfterMain(state, playerId) === 'END' ? 'จบ Main → End Phase' : 'เข้า Battle Phase';
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
  let prepared = state;
  // Temporary control changes (e.g. "แอสการ์ดคือสถานที่ไม่ใช่ผู้คน") expire at the
  // End Phase of the turn they were made in: the Avatar returns to its previous
  // controller while it is still on a field zone under the temporary controller.
  for (const entry of state.temporaryControlChanges ?? []) {
    if (entry.turnNumber !== state.turnNumber) continue;
    const holderId = state.playerOrder.find(pid => state.players[pid]?.avatarZone.some(item => item.instanceId === entry.instanceId));
    const avatar = holderId ? state.players[holderId].avatarZone.find(item => item.instanceId === entry.instanceId) : undefined;
    if (!avatar || avatar.controllerId !== entry.temporaryControllerId) continue;
    const restored = changeAvatarControl(prepared, activePlayerId, entry.instanceId, entry.previousControllerId);
    if (restored.ok) {
      prepared = restored.state;
    } else {
      // Rule gap: the previous controller's Avatar Zone may have filled up during
      // the turn. The Avatar stays where it is and the failure is logged publicly.
      prepared = {
        ...prepared,
        eventLog: [...prepared.eventLog, {
          timestamp: Date.now(),
          type: 'CONTROL_RESTORE_FAILED',
          description: `ไม่สามารถคืนการควบคุม "${avatar.card.name}" ให้ ${state.players[entry.previousControllerId]?.name ?? entry.previousControllerId} ได้ (${restored.reason ?? 'unknown'})`,
          actorId: activePlayerId
        }]
      };
    }
  }
  prepared = {
    ...prepared,
    temporaryControlChanges: (prepared.temporaryControlChanges ?? []).filter(entry => entry.turnNumber !== state.turnNumber)
  };
  const dueDestructions = state.playerOrder.flatMap(id => state.players[id]?.avatarZone ?? [])
    .filter(avatar => avatar.destroyAtEndPhase?.playerId === activePlayerId &&
      avatar.destroyAtEndPhase.turnNumber === state.turnNumber);
  for (const avatar of dueDestructions) {
    const moved = moveCardBetweenZones(prepared, {
      instanceId: avatar.instanceId, actorId: activePlayerId, destination: 'hell',
      destinationPlayerId: avatar.originalOwnerId ?? avatar.ownerId, effectMove: true, cause: 'EFFECT'
    });
    if (!moved.ok) return state;
    prepared = moved.state;
    if (prepared.pendingExitPrevention) return prepared;
  }
  const transaction = runGameTransaction(prepared, draft => {
    let nextState = clearEndOfTurnModifiers(draft);
    for (const playerId of state.playerOrder) {
      const player = nextState.players[playerId];
      if (!player) continue;
      nextState = { ...nextState, players: { ...nextState.players, [playerId]: {
        ...player, avatarZone: player.avatarZone.map(avatar => avatar.controllerId === activePlayerId &&
          avatar.attachedInstances.some(attached => attached.card.type === 'Magic' && attached.card.subtype === 'Modification' &&
            attached.card.mainEffect.trim() === 'Avatar ที่สวมใส่การ์ดใบนี้จะกลับมาเป็นสภาพตื่น ตอน End Phase')
          ? { ...avatar, isRested: false } : avatar)
      } } };
    }
    const nextPlayer = nextState.players[nextPlayerId];
    return {
      ...nextState,
      currentTurnPlayerIndex: nextIndex,
      currentPhase: 'DRAW',
      turnNumber,
      stateRevision: (prepared.stateRevision ?? 0) + 1,
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
