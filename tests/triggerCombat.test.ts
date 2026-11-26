import { describe, expect, it } from 'vitest';
import { resolveTriggeredEvent } from '../src/engine/triggerEngine';
import { moveCardBetweenZones } from '../src/engine/gameRules';
import { preventDestruction, preventDestructionByReaction } from '../src/engine/prevention';
import { applyHumanShieldRedirect, backstabPenalty, canDeclareAttack, declareCombatAttack, declareDuo, payCombatKeyword, resolveConstructAttack } from '../src/engine/combatKeywords';
import type { Card, CardInstance, GameState, PlayerState } from '../src/engine/types';

function makeInstance(id: string, playerId: string, type: Card['type'] = 'Avatar', power = 3): CardInstance {
  const card: Card = { printId: id, name: id, type, subtype: null, cost: 0, gem: 0, power, color: 'แดง', rarity: 'C', mainEffect: '', isOnlyOne: false, isBias: false, isCollab: false, imageUrl: '' };
  return { instanceId: id, card, ownerId: playerId, controllerId: playerId, isRested: false, isFaceUp: true, attachedInstances: [], layerModifiers: [] };
}
function player(id: string, overrides: Partial<PlayerState> = {}): PlayerState {
  return { id, name: id, seat: id === 'p1' ? 0 : 1, deck: [], hand: [], lifeDeck: [], avatarZone: [], constructZone: [], magicZone: [], hell: [], darkDimension: [], isCritical: false, reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 }, usedMagicTypesThisTurn: new Set(), ...overrides };
}
function game(p1 = player('p1'), p2 = player('p2')): GameState {
  return { id: 'triggers', mode: 'DUEL', playerOrder: ['p1', 'p2'], currentTurnPlayerIndex: 0, currentPhase: 'MAIN', turnNumber: 1, roundNumber: 1, players: { p1, p2 }, landMagicZone: null, eventLog: [] };
}
const event = { type: 'AVATAR_SUMMONED' as const, instanceId: 'summoned', playerId: 'p1', eventId: 'summon:1' };

describe('typed trigger engine', () => {
  it('resolves simultaneous triggers in turn-player order and preserves declared controller ordering', () => {
    const first = makeInstance('first', 'p1');
    const second = makeInstance('second', 'p1');
    first.triggerAbilities = [
      { id: 'draw-a', eventType: 'AVATAR_SUMMONED', effects: [{ kind: 'modify_power', targetId: 'first', amount: 1 }] }
    ];
    second.triggerAbilities = [
      { id: 'draw-b', eventType: 'AVATAR_SUMMONED', effects: [{ kind: 'modify_power', targetId: 'second', amount: 2 }] }
    ];
    const result = resolveTriggeredEvent(game(player('p1', { avatarZone: [first, second] }), player('p2')), event, ['p1', 'p2']);
    expect(result.ok).toBe(true);
    expect(result.resolved).toEqual(['first:draw-a', 'second:draw-b']);
    expect(result.state.players.p1.avatarZone.map(card => card.layerModifiers[0]?.powerMod)).toEqual([1, 2]);
    expect(resolveTriggeredEvent(result.state, event).resolved).toEqual([]);
    const controllerChoice = resolveTriggeredEvent(game(player('p1', { avatarZone: [first, second] }), player('p2')), { ...event, eventId: 'summon:chosen' }, ['p1', 'p2'], ['second:draw-b', 'first:draw-a']);
    expect(controllerChoice.resolved).toEqual(['second:draw-b', 'first:draw-a']);
  });

  it('enforces once-per-turn frequency and permits the next turn', () => {
    const source = makeInstance('once', 'p1');
    source.triggerAbilities = [{ id: 'once', eventType: 'AVATAR_SUMMONED', frequency: 'ONCE_PER_TURN', effects: [{ kind: 'modify_power', targetId: 'once', amount: 1 }] }];
    const current = game(player('p1', { avatarZone: [source] }));
    const first = resolveTriggeredEvent(current, event);
    const repeated = resolveTriggeredEvent(first.state, { ...event, eventId: 'summon:2' });
    expect(repeated.resolved).toEqual([]);
    const nextTurn = resolveTriggeredEvent({ ...repeated.state, turnNumber: 2 }, { ...event, eventId: 'summon:3' });
    expect(nextTurn.resolved).toEqual(['once:once']);
  });

  it('rolls back every trigger when a later trigger fails and does not mark the event consumed', () => {
    const source = makeInstance('rollback', 'p1');
    source.triggerAbilities = [
      { id: 'valid', eventType: 'AVATAR_SUMMONED', effects: [{ kind: 'modify_power', targetId: 'rollback', amount: 1 }] },
      { id: 'invalid', eventType: 'AVATAR_SUMMONED', effects: [{ kind: 'modify_power', targetId: 'missing', amount: 1 }] }
    ];
    const current = game(player('p1', { avatarZone: [source] }));
    const result = resolveTriggeredEvent(current, event);
    expect(result.ok).toBe(false);
    expect(result.state).toBe(current);
    expect(result.state.players.p1.avatarZone[0].layerModifiers).toEqual([]);
    expect(result.state.processedTriggerEventIds).toBeUndefined();
  });

  it('blocks trigger resolution during an open Reaction Window and caps pathological event snapshots', () => {
    const source = makeInstance('loop', 'p1');
    source.triggerAbilities = Array.from({ length: 65 }, (_, index) => ({ id: `loop-${index}`, eventType: 'AVATAR_SUMMONED' as const, effects: [{ kind: 'modify_power' as const, targetId: 'loop', amount: 1 }] }));
    const current = game(player('p1', { avatarZone: [source] }));
    expect(resolveTriggeredEvent({ ...current, reactionWindow: { id: 'window', trigger: { type: 'AVATAR_SUMMONED', actorId: 'p1' }, turnOwnerId: 'p1', priorityPlayerId: 'p2', passedPlayerIds: [] } }, event).ok).toBe(false);
    expect(resolveTriggeredEvent(current, event).reason).toContain('limit');
    expect(current.players.p1.avatarZone[0].layerModifiers).toEqual([]);
  });
});

describe('prevention timing', () => {
  it('resolves automatic shields before activated protection and permits one React attempt per exit event', () => {
    const target = makeInstance('guarded', 'p2');
    target.preventionShields = [{ id: 'automatic', kind: 'DESTRUCTION', usesRemaining: 1 }];
    const current = game(player('p1'), player('p2', { avatarZone: [target] }));
    const automatic = preventDestruction(current, 'p1', 'guarded', 'COMBAT');
    expect(automatic.prevented).toBe(true);
    const withActivated = { ...automatic.state, reactionWindow: { id: 'exit-window', trigger: { type: 'AVATAR_WOULD_BE_DESTROYED' as const, actorId: 'p1', targetInstanceId: 'guarded' }, turnOwnerId: 'p1', priorityPlayerId: 'p2', passedPlayerIds: [] }, players: { ...automatic.state.players, p2: { ...automatic.state.players.p2, avatarZone: [{ ...automatic.state.players.p2.avatarZone[0], preventionShields: [{ id: 'react-shield', kind: 'DESTRUCTION' as const, mode: 'ACTIVATED' as const, usesRemaining: 1, sourceControllerId: 'p2' }] }] } } };
    const reacted = preventDestructionByReaction(withActivated, 'p2', 'guarded', 'exit-1', 'react-shield', 'COMBAT');
    expect(reacted.prevented).toBe(true);
    expect(preventDestructionByReaction(reacted.state, 'p2', 'guarded', 'exit-1', 'react-shield', 'COMBAT').prevented).toBe(false);
  });
});

describe('Rule Book 3.2 combat keywords', () => {
  it('allows Egg Kick to select LIFE past enemy Avatars, but not ordinary attacks', () => {
    const attacker = makeInstance('attacker', 'p1');
    const defender = makeInstance('defender', 'p2');
    const current = { ...game(player('p1', { avatarZone: [attacker] }), player('p2', { avatarZone: [defender] })), currentPhase: 'BATTLE' as const };
    expect(canDeclareAttack(current, 'attacker', { type: 'LIFE', playerId: 'p2' })).toBe(false);
    attacker.card.mainEffect = 'เตะไข่';
    expect(canDeclareAttack(current, 'attacker', { type: 'LIFE', playerId: 'p2' })).toBe(true);
  });

  it('rests the attacker, snapshots POWER, and emits ATTACK_DECLARED', () => {
    const attacker = makeInstance('attacker', 'p1', 'Avatar', 4);
    const target = makeInstance('target', 'p2');
    const current = { ...game(player('p1', { avatarZone: [attacker] }), player('p2', { avatarZone: [target] })), currentPhase: 'BATTLE' as const };
    const declared = declareCombatAttack(current, 'attacker', { type: 'AVATAR', playerId: 'p2', instanceId: 'target' });
    expect(declared?.players.p1.avatarZone[0].isRested).toBe(true);
    expect(declared?.battleContext?.snapshotPower).toBe(4);
    expect(declared?.gameEvents?.at(-1)?.event.type).toBe('ATTACK_DECLARED');
  });

  it('uses Human Shield to rest the ready Avatar and redirect the attack', () => {
    const target = makeInstance('target', 'p2');
    const guard = makeInstance('guard', 'p2');
    guard.card.mainEffect = 'โล่มนุษย์';
    const result = applyHumanShieldRedirect(game(player('p1'), player('p2', { avatarZone: [target, guard] })), { type: 'AVATAR', playerId: 'p2', instanceId: 'target' });
    expect(result.redirected).toBe(true);
    expect(result.target.instanceId).toBe('guard');
    expect(result.state.players.p2.avatarZone.find(item => item.instanceId === 'guard')?.isRested).toBe(true);
  });

  it('destroys a Construct only when the attacker has strictly greater POWER, without counter-destruction', () => {
    const attacker = makeInstance('attacker', 'p1', 'Avatar', 5);
    const construct = makeInstance('construct', 'p2', 'Construct', 4);
    const current = game(player('p1', { avatarZone: [attacker] }), player('p2', { constructZone: [construct] }));
    const destroyed = resolveConstructAttack(current, 'attacker', 'construct');
    expect(destroyed.ok).toBe(true);
    expect(destroyed.constructDestroyed).toBe(true);
    expect(destroyed.state.players.p2.constructZone).toHaveLength(0);
    expect(destroyed.state.players.p2.hell.map(card => card.instanceId)).toContain('construct');
    const tieState = game(player('p1', { avatarZone: [makeInstance('tie-attacker', 'p1', 'Avatar', 4)] }), player('p2', { constructZone: [makeInstance('tie-construct', 'p2', 'Construct', 4)] }));
    expect(resolveConstructAttack(tieState, 'tie-attacker', 'tie-construct').constructDestroyed).toBe(false);
    expect(tieState.players.p1.avatarZone).toHaveLength(1);
  });

  it('pays Unity and Backstab with a rested helper and temporary Layer 4 power, and applies Backstab penalty condition', () => {
    const attacker = makeInstance('attacker', 'p1', 'Avatar', 2);
    const unity = makeInstance('unity', 'p1', 'Avatar', 4);
    unity.card.mainEffect = 'สามัคคี';
    const current = game(player('p1', { avatarZone: [attacker, unity] }));
    const aided = payCombatKeyword(current, 'attacker', 'unity', 'สามัคคี')!;
    expect(aided.players.p1.avatarZone[1].isRested).toBe(true);
    expect(aided.players.p1.avatarZone[0].layerModifiers).toContainEqual(expect.objectContaining({ powerMod: 4, layer: 4, expiresAt: 'END_OF_BATTLE' }));
    const backstabber = makeInstance('backstab', 'p1', 'Avatar', 2);
    backstabber.card.mainEffect = 'แทงหลัง';
    const withBackstab = game(player('p1', { avatarZone: [attacker, backstabber] }));
    expect(payCombatKeyword(withBackstab, 'attacker', 'backstab', 'แทงหลัง')?.players.p1.avatarZone[0].layerModifiers[0].powerMod).toBe(3);
    const red = makeInstance('red', 'p1');
    const blue = makeInstance('blue', 'p1'); blue.card.color = 'ฟ้า';
    expect(backstabPenalty(red, blue)).toBe(true);
    expect(backstabPenalty(red, red)).toBe(false);
  });

  it('declares a pair only once per turn and clears the partner state when broken', () => {
    const a = makeInstance('a', 'p1'); const b = makeInstance('b', 'p1');
    a.card.mainEffect = 'คู่หู';
    const current = game(player('p1', { avatarZone: [a, b] }));
    const paired = declareDuo(current, 'a', 'b')!;
    expect(paired.players.p1.avatarZone.every(card => card.controlChangeImmune && card.duoWithInstanceId)).toBe(true);
    expect(declareDuo(paired, 'a', 'b')).toBeNull();
    const left = moveCardBetweenZones(paired, { instanceId: 'a', actorId: 'p1', destination: 'hand', destinationPlayerId: 'p1', effectMove: true });
    expect(left.ok).toBe(true);
    expect(left.state.players.p1.avatarZone[0]).toMatchObject({ controlChangeImmune: false, duoWithInstanceId: undefined });
  });
});
