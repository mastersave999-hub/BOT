import { describe, expect, it } from 'vitest';
import { declareCombatAttack, declareCombatAttackWithHelpers, resolveDeclaredBattle } from '../src/engine/combatKeywords';
import { openReactionWindow, passReactionPriority, queueReactionCard } from '../src/engine/reactionEngine';
import type { Card, CardInstance, GameState, PlayerState } from '../src/engine/types';

function makeCard(id: string, type: Card['type'], power: number, effect = ''): CardInstance {
  return {
    instanceId: id,
    card: {
      printId: id, name: id, type, subtype: null, cost: 0, gem: 0, power,
      color: 'แดง', rarity: 'C', mainEffect: effect,
      isOnlyOne: false, isBias: false, isCollab: false, imageUrl: ''
    },
    ownerId: id.startsWith('p2') ? 'p2' : 'p1',
    controllerId: id.startsWith('p2') ? 'p2' : 'p1',
    isRested: false, isFaceUp: true, attachedInstances: [], layerModifiers: []
  };
}

function makePlayer(id: string, partial: Partial<PlayerState> = {}): PlayerState {
  return {
    id, name: id, seat: id === 'p1' ? 0 : 1, deck: [], hand: [], lifeDeck: [],
    avatarZone: [], constructZone: [], magicZone: [], hell: [], darkDimension: [],
    isCritical: false, reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 },
    usedMagicTypesThisTurn: new Set(), ...partial
  };
}

function makeGame(p1: PlayerState, p2: PlayerState): GameState {
  return {
    id: 'battle-lifecycle', mode: 'DUEL', playerOrder: ['p1', 'p2'], currentTurnPlayerIndex: 0,
    currentPhase: 'BATTLE', turnNumber: 2, roundNumber: 1, players: { p1, p2 },
    landMagicZone: null, eventLog: []
  };
}

describe('Battle lifecycle integration — Rule Book 3.2', () => {
  it('declares and resolves a full Avatar battle, moving only the loser and emitting lifecycle events', () => {
    const attacker = makeCard('p1-attacker', 'Avatar', 5);
    const defender = makeCard('p2-defender', 'Avatar', 3);
    const state = makeGame(makePlayer('p1', { avatarZone: [attacker] }), makePlayer('p2', { avatarZone: [defender] }));
    const declared = declareCombatAttack(state, attacker.instanceId, { type: 'AVATAR', playerId: 'p2', instanceId: defender.instanceId });
    expect(declared?.players.p1.avatarZone[0].isRested).toBe(true);
    expect(declared?.battleContext?.snapshotPower).toBe(5);
    const result = resolveDeclaredBattle(declared!);
    expect(result.ok).toBe(true);
    expect(result.state.players.p1.avatarZone.map(card => card.instanceId)).toContain(attacker.instanceId);
    expect(result.state.players.p2.avatarZone).toHaveLength(0);
    expect(result.state.players.p2.hell.map(card => card.instanceId)).toContain(defender.instanceId);
    expect(result.state.battleContext).toBeUndefined();
    expect(result.state.gameEvents?.map(item => item.event.type)).toContain('AVATAR_DESTROYED');
    expect(result.state.gameEvents?.map(item => item.event.type)).toContain('BATTLE_ENDED');
  });

  it('resolves the Reaction Window chain before the declared battle and its cleanup', () => {
    const attacker = makeCard('p1-attacker', 'Avatar', 5);
    const defender = makeCard('p2-defender', 'Avatar', 3);
    const react = makeCard('p2-react', 'Magic', 0);
    react.card.subtype = 'React';
    react.card.mainEffect = 'เมื่อ Avatar ประกาศโจมตี : จั่วการ์ด 1 ใบ';
    const drawn = makeCard('p2-drawn', 'Avatar', 2);
    const state = makeGame(
      makePlayer('p1', { avatarZone: [attacker] }),
      makePlayer('p2', { avatarZone: [defender], hand: [react], deck: [drawn] })
    );
    const declared = declareCombatAttack(state, attacker.instanceId, {
      type: 'AVATAR', playerId: 'p2', instanceId: defender.instanceId
    })!;
    const window = openReactionWindow(declared, {
      type: 'ATTACK_DECLARED', actorId: 'p1', targetInstanceId: defender.instanceId,
      targetCardName: defender.card.name, sourceCardName: attacker.card.name
    }, { type: 'START_ATTACK', actorId: 'p1', sourceCard: attacker });
    expect(window.reactionWindow).toBeDefined();
    const queued = queueReactionCard(window, 'p2', react.instanceId);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const passToAttacker = passReactionPriority(queued.state, 'p1');
    expect(passToAttacker.ok).toBe(true);
    if (!passToAttacker.ok) return;
    const resolveResponse = passReactionPriority(passToAttacker.state, 'p2');
    expect(resolveResponse.ok).toBe(true);
    if (!resolveResponse.ok) return;
    expect(resolveResponse.state.reactionWindow).toBeUndefined();
    expect(resolveResponse.state.players.p2.hand.map(card => card.instanceId)).toContain(drawn.instanceId);
    expect(resolveResponse.pendingAction?.type).toBe('START_ATTACK');

    const result = resolveDeclaredBattle(resolveResponse.state);
    expect(result.state.players.p2.hell.map(card => card.instanceId)).toContain(defender.instanceId);
    expect(result.state.players.p1.avatarZone[0].layerModifiers).toEqual([]);
  });

  it('redirects an attack to a ready Human Shield and applies Grit on an equal-power battle', () => {
    const attacker = makeCard('p1-attacker', 'Avatar', 4);
    const target = makeCard('p2-target', 'Avatar', 4);
    const shield = makeCard('p2-shield', 'Avatar', 4, 'โล่มนุษย์ ลูกฮึด');
    const state = makeGame(makePlayer('p1', { avatarZone: [attacker] }), makePlayer('p2', { avatarZone: [target, shield] }));
    const declared = declareCombatAttack(state, attacker.instanceId, { type: 'AVATAR', playerId: 'p2', instanceId: target.instanceId });
    const result = resolveDeclaredBattle(declared!);
    expect(result.ok).toBe(true);
    expect(result.state.players.p2.avatarZone.map(card => card.instanceId)).toEqual([target.instanceId, shield.instanceId]);
    expect(result.state.players.p1.hell.map(card => card.instanceId)).toContain(attacker.instanceId);
    expect(result.state.players.p2.avatarZone.find(card => card.instanceId === shield.instanceId)?.isRested).toBe(true);
  });

  it('applies Unity at declaration, rests the helper, and resolves with Layer 4 power', () => {
    const attacker = makeCard('p1-attacker', 'Avatar', 2);
    const helper = makeCard('p1-unity', 'Avatar', 3, 'สามัคคี');
    const defender = makeCard('p2-defender', 'Avatar', 4);
    const state = makeGame(makePlayer('p1', { avatarZone: [attacker, helper] }), makePlayer('p2', { avatarZone: [defender] }));
    const declared = declareCombatAttackWithHelpers(state, attacker.instanceId, {
      type: 'AVATAR', playerId: 'p2', instanceId: defender.instanceId
    }, [{ instanceId: helper.instanceId, keyword: 'สามัคคี' }]);
    expect(declared?.players.p1.avatarZone.find(card => card.instanceId === helper.instanceId)?.isRested).toBe(true);
    expect(declared?.players.p1.avatarZone.find(card => card.instanceId === attacker.instanceId)?.layerModifiers).toContainEqual(
      expect.objectContaining({ layer: 4, powerMod: 3, expiresAt: 'END_OF_BATTLE' })
    );
    const result = resolveDeclaredBattle(declared!);
    expect(result.state.players.p2.hell.map(card => card.instanceId)).toContain(defender.instanceId);
    expect(result.state.players.p1.avatarZone.map(card => card.instanceId)).toContain(attacker.instanceId);
  });

  it('applies the Backstab post-attack destruction only after a different-color helper is used', () => {
    const attacker = makeCard('p1-attacker', 'Avatar', 5);
    const backstab = makeCard('p1-backstab', 'Avatar', 1, 'แทงหลัง');
    backstab.card.color = 'ฟ้า';
    const defender = makeCard('p2-defender', 'Avatar', 3);
    const state = makeGame(makePlayer('p1', { avatarZone: [attacker, backstab] }), makePlayer('p2', { avatarZone: [defender] }));
    const declared = declareCombatAttackWithHelpers(state, attacker.instanceId, {
      type: 'AVATAR', playerId: 'p2', instanceId: defender.instanceId
    }, [{ instanceId: backstab.instanceId, keyword: 'แทงหลัง' }]);
    const result = resolveDeclaredBattle(declared!);
    expect(result.state.players.p2.hell.map(card => card.instanceId)).toContain(defender.instanceId);
    expect(result.state.players.p1.hell.map(card => card.instanceId)).toContain(attacker.instanceId);
    expect(result.events.some(message => message.includes('Backstab'))).toBe(true);
  });

  it('uses the declaration snapshot for Construct comparison and routes prevention through zone movement', () => {
    const attacker = makeCard('p1-attacker', 'Avatar', 5);
    const construct = makeCard('p2-construct', 'Construct', 4);
    construct.preventionShields = [{ id: 'automatic-construction-ward', kind: 'DESTRUCTION', usesRemaining: 1 }];
    const state = makeGame(makePlayer('p1', { avatarZone: [attacker] }), makePlayer('p2', { constructZone: [construct] }));
    const declared = declareCombatAttack(state, attacker.instanceId, { type: 'CONSTRUCT', playerId: 'p2', instanceId: construct.instanceId });
    const result = resolveDeclaredBattle(declared!);
    expect(result.ok).toBe(true);
    expect(result.state.players.p2.constructZone.map(card => card.instanceId)).toContain(construct.instanceId);
    expect(result.state.players.p2.constructZone[0].preventionShields).toEqual([]);
    expect(result.state.players.p1.avatarZone[0].isRested).toBe(true);
  });

  it('resolves an Egg Kick LIFE attack with one damage event and removes end-of-battle modifiers', () => {
    const attacker = makeCard('p1-attacker', 'Avatar', 3, 'เตะไข่');
    attacker.layerModifiers.push({ layer: 4, powerMod: 2, sourceCardId: 'battle-react', expiresAt: 'END_OF_BATTLE' });
    const life = makeCard('p2-life', 'Life', 0);
    life.isFaceUp = false;
    const state = makeGame(makePlayer('p1', { avatarZone: [attacker] }), makePlayer('p2', { avatarZone: [makeCard('p2-blocker', 'Avatar', 2)], lifeDeck: [life] }));
    const declared = declareCombatAttack(state, attacker.instanceId, { type: 'LIFE', playerId: 'p2' });
    const result = resolveDeclaredBattle(declared!);
    expect(result.ok).toBe(true);
    expect(result.state.players.p2.lifeDeck[0].isFaceUp).toBe(true);
    expect(result.state.gameEvents?.filter(item => item.event.type === 'DAMAGE_DEALT' || item.event.type === 'DAMAGE_TAKEN')).toHaveLength(2);
    expect(result.state.players.p1.avatarZone[0].layerModifiers).toEqual([]);
  });
});
