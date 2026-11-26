import { describe, expect, it } from 'vitest';
import { appendGameEvents } from '../src/engine/gameEvents';
import { passReactionPriority, queueReactionCard } from '../src/engine/reactionEngine';
import type { Card, CardInstance, GameState, PlayerState } from '../src/engine/types';

function cardInstance(id: string, ownerId: string, overrides: Partial<Card> = {}): CardInstance {
  const card: Card = {
    printId: id, name: id, type: 'Avatar', subtype: null, cost: 0, gem: 0, power: 3,
    color: 'ไร้สี', rarity: 'C', mainEffect: '', isOnlyOne: false, isBias: false,
    isCollab: false, imageUrl: '', ...overrides
  };
  return {
    instanceId: id, card, ownerId, controllerId: ownerId, isRested: false,
    isFaceUp: true, attachedInstances: [], layerModifiers: []
  };
}

function player(id: string, overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id, name: id, seat: id === 'p1' ? 0 : 1, deck: [], hand: [], lifeDeck: [],
    avatarZone: [], constructZone: [], magicZone: [], hell: [], darkDimension: [],
    isCritical: false, reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 },
    usedMagicTypesThisTurn: new Set(), ...overrides
  };
}

function game(p1 = player('p1'), p2 = player('p2')): GameState {
  return {
    id: 'chain-triggers', mode: 'DUEL', playerOrder: ['p1', 'p2'], currentTurnPlayerIndex: 0,
    currentPhase: 'MAIN', turnNumber: 1, roundNumber: 1, players: { p1, p2 },
    landMagicZone: null, eventLog: []
  };
}

function emitLiveEvent(state: GameState): GameState {
  return appendGameEvents(state, [{
    type: 'ATTACK_DECLARED', attackerId: 'attacker', targetId: 'target', playerId: 'p1', eventId: 'attack:1'
  }]);
}

function passTwice(state: GameState): GameState {
  if (!state.reactionWindow) return state;
  const first = passReactionPriority(state, state.reactionWindow.priorityPlayerId);
  expect(first.ok).toBe(true);
  if (!first.ok) return state;
  const second = passReactionPriority(first.state, first.state.reactionWindow!.priorityPlayerId);
  expect(second.ok).toBe(true);
  return second.ok ? second.state : first.state;
}

describe('event-driven Reaction Chain triggers', () => {
  it('pushes an active source trigger onto the Reaction Chain when its event is emitted', () => {
    const source = cardInstance('trigger-source', 'p1');
    source.triggerAbilities = [{
      id: 'attack-trigger', eventType: 'ATTACK_DECLARED',
      effects: [{ kind: 'modify_power', targetId: 'trigger-source', amount: 2 }]
    }];
    const state = emitLiveEvent(game(player('p1', { avatarZone: [source] })));
    expect(state.reactionWindow?.chain).toEqual([
      expect.objectContaining({
        entryType: 'TRIGGER_ABILITY', sourceCardId: 'trigger-source', controllerId: 'p1',
        triggerId: 'trigger-source:attack-trigger', cancelled: false
      })
    ]);
  });

  it('lets the opponent cancel the queued trigger before its LIFO resolution', () => {
    const source = cardInstance('trigger-source', 'p1');
    source.triggerAbilities = [{
      id: 'attack-trigger', eventType: 'ATTACK_DECLARED',
      effects: [{ kind: 'modify_power', targetId: 'trigger-source', amount: 2 }]
    }];
    const canceller = cardInstance('cancel-card', 'p2', {
      type: 'Magic', subtype: 'React', mainEffect: 'ยกเลิกความสามารถนี้'
    });
    let state = emitLiveEvent(game(player('p1', { avatarZone: [source] }), player('p2', { hand: [canceller] })));
    const queued = queueReactionCard(state, 'p2', 'cancel-card');
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    state = passTwice(queued.state);
    expect(state.reactionWindow?.chain?.[0]).toMatchObject({ entryType: 'TRIGGER_ABILITY', cancelled: true });
    state = passTwice(state);
    expect(state.players.p1.avatarZone[0].layerModifiers).toEqual([]);
    expect(state.players.p2.hell.map(item => item.instanceId)).toContain('cancel-card');
  });

  it('resolves uncancelled effects and rolls back the whole trigger when a later effect fails', () => {
    const successfulSource = cardInstance('successful', 'p1');
    successfulSource.triggerAbilities = [{
      id: 'success', eventType: 'ATTACK_DECLARED',
      effects: [{ kind: 'modify_power', targetId: 'successful', amount: 2 }]
    }];
    let state = emitLiveEvent(game(player('p1', { avatarZone: [successfulSource] })));
    state = passTwice(passTwice(state));
    expect(state.players.p1.avatarZone[0].layerModifiers[0]?.powerMod).toBe(2);

    const rollbackSource = cardInstance('rollback', 'p1');
    rollbackSource.triggerAbilities = [{
      id: 'rollback-trigger', eventType: 'ATTACK_DECLARED', effects: [
        { kind: 'modify_power', targetId: 'rollback', amount: 5 },
        { kind: 'draw', playerId: 'p1', count: 1 }
      ]
    }];
    state = emitLiveEvent(game(player('p1', { avatarZone: [rollbackSource] })));
    state = passTwice(passTwice(state));
    expect(state.players.p1.avatarZone[0].layerModifiers).toEqual([]);
  });
});
