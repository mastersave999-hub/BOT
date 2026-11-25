import { describe, expect, it } from 'vitest';
import { resolveEffectPlan, type EffectDefinition } from '../src/engine/effectResolver';
import type { Card, CardInstance, GameState } from '../src/engine/types';

const card: Card = { printId: 'T1', name: 'Token', type: 'Avatar', cost: 1, gem: 1, power: 2, color: 'แดง', rarity: 'C', mainEffect: '', isOnlyOne: false, isBias: false, isCollab: false, imageUrl: '' };
function instance(id: string, ownerId: string): CardInstance {
  return { instanceId: id, card, ownerId, controllerId: ownerId, isRested: false, isFaceUp: true, attachedInstances: [], layerModifiers: [] };
}
function gameState(): GameState {
  const player = (id: string) => ({ id, name: id, seat: 0, deck: [instance(`${id}-deck`, id)], hand: [instance(`${id}-hand`, id)], lifeDeck: [], avatarZone: [instance(`${id}-avatar`, id)], constructZone: [], magicZone: [], hell: [], darkDimension: [], isCritical: false, reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 }, usedMagicTypesThisTurn: new Set() });
  return { id: 'resolver-test', mode: 'DUEL', playerOrder: ['p1', 'p2'], currentTurnPlayerIndex: 0, currentPhase: 'MAIN', turnNumber: 1, roundNumber: 1, players: { p1: player('p1'), p2: player('p2') }, landMagicZone: null, eventLog: [] };
}

describe('typed effect resolver', () => {
  it('applies ordered effects and explicit costs to actual state', () => {
    const initial = gameState();
    const result = resolveEffectPlan(initial, {
      actorId: 'p1',
      costs: [{ kind: 'discard_from_hand', playerId: 'p1', instanceIds: ['p1-hand'] }],
      effects: [
        { kind: 'draw', playerId: 'p1', count: 1 },
        { kind: 'modify_power', targetId: 'p2-avatar', amount: 3 }
      ]
    });
    expect(result.ok).toBe(true);
    expect(result.state.players.p1.hand.map(item => item.instanceId)).toEqual(['p1-deck']);
    expect(result.state.players.p1.hell.map(item => item.instanceId)).toEqual(['p1-hand']);
    expect(result.state.players.p2.avatarZone[0].layerModifiers[0].powerMod).toBe(3);
  });

  it('executes ordered operations against the updated staged Game State', () => {
    const initial = gameState();
    const result = resolveEffectPlan(initial, {
      actorId: 'p1',
      effects: [
        { kind: 'modify_power', targetId: 'p2-avatar', amount: 3 },
        { kind: 'destroy_avatar', targetId: 'p2-avatar' }
      ]
    });
    expect(result.ok).toBe(true);
    expect(result.state.players.p2.avatarZone).toHaveLength(0);
    expect(result.state.players.p2.hell[0].instanceId).toBe('p2-avatar');
    expect(result.state.players.p2.hell[0].layerModifiers[0].powerMod).toBe(3);
    expect(initial.players.p2.avatarZone).toHaveLength(1);
    expect(initial.players.p2.hell).toHaveLength(0);
  });

  it('rejects invalid target, failed condition, and insufficient costs with unchanged state', () => {
    const initial = gameState();
    const invalidTarget = resolveEffectPlan(initial, { actorId: 'p1', effects: [{ kind: 'destroy_avatar', targetId: 'missing' }] });
    const conditionFailed = resolveEffectPlan(initial, { actorId: 'p1', conditions: [{ kind: 'player_has_avatar', playerId: 'p2', nameIncludes: 'Absent' }], effects: [{ kind: 'draw', playerId: 'p1', count: 1 }] });
    const costFailed = resolveEffectPlan(initial, { actorId: 'p1', costs: [{ kind: 'discard_from_hand', playerId: 'p1', instanceIds: ['missing'] }], effects: [{ kind: 'draw', playerId: 'p1', count: 1 }] });
    for (const result of [invalidTarget, conditionFailed, costFailed]) {
      expect(result.ok).toBe(false);
      expect(result.state).toBe(initial);
    }
  });

  it('rolls back rejected, mutating, and throwing handlers while supporting safe extensions', () => {
    const initial = gameState();
    const rejected = resolveEffectPlan(initial, { actorId: 'p1', effects: [
      { kind: 'draw', playerId: 'p1', count: 1 },
      { kind: 'destroy_avatar', targetId: 'missing' }
    ] });
    expect(rejected.ok).toBe(false);
    expect(rejected.state).toBe(initial);
    expect(initial.players.p1.hand.map(item => item.instanceId)).toEqual(['p1-hand']);
    expect(initial.players.p1.deck.map(item => item.instanceId)).toEqual(['p1-deck']);

    const custom: EffectDefinition = { kind: 'draw', playerId: 'p1', count: 1 };
    const extended = resolveEffectPlan(initial, { actorId: 'p1', effects: [custom] }, {
      draw: ({ state }) => ({ ...state, turnNumber: state.turnNumber + 1 })
    });
    expect(extended.ok).toBe(true);
    expect(extended.state.turnNumber).toBe(2);
    expect(initial.turnNumber).toBe(1);

    const mutatingFailure = resolveEffectPlan(initial, { actorId: 'p1', effects: [custom, custom] }, {
      draw: ({ state }) => {
        state.players.p1.hand.splice(0);
        state.players.p1.deck.splice(0);
        throw new Error('handler failure');
      }
    });
    expect(mutatingFailure.ok).toBe(false);
    expect(mutatingFailure.state).toBe(initial);
    expect(initial.players.p1.hand.map(item => item.instanceId)).toEqual(['p1-hand']);
    expect(initial.players.p1.deck.map(item => item.instanceId)).toEqual(['p1-deck']);
  });

  it('rejects an unsupported runtime effect without changing state', () => {
    const initial = gameState();
    const unsupported = resolveEffectPlan(initial, {
      actorId: 'p1',
      effects: [{ kind: 'unimplemented_control_change' } as unknown as EffectDefinition]
    });
    expect(unsupported.ok).toBe(false);
    expect(unsupported.reason).toBe('unsupported effect');
    expect(unsupported.state).toBe(initial);
  });

  it('rejects invalid counts and costs paid from another player\'s state without mutation', () => {
    const initial = gameState();
    const invalidCount = resolveEffectPlan(initial, { actorId: 'p1', effects: [{ kind: 'draw', playerId: 'p1', count: 0.5 }] });
    const foreignCost = resolveEffectPlan(initial, {
      actorId: 'p1',
      costs: [{ kind: 'discard_from_hand', playerId: 'p2', instanceIds: ['p2-hand'] }],
      effects: [{ kind: 'draw', playerId: 'p1', count: 1 }]
    });
    for (const result of [invalidCount, foreignCost]) {
      expect(result.ok).toBe(false);
      expect(result.state).toBe(initial);
    }
    expect(initial.players.p2.hand.map(item => item.instanceId)).toEqual(['p2-hand']);
  });
});
