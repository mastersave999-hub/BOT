import { describe, expect, it } from 'vitest';
import { cancelReactionTarget, openReactionWindow, passReactionPriority, queueReactionCard } from '../src/engine/reactionEngine';
import { moveCardBetweenZones } from '../src/engine/gameRules';
import { resolveEffectPlan } from '../src/engine/effectResolver';
import { expireModifiersAt } from '../src/engine/abilityEngine';
import { calculateNetPower } from '../src/engine/layers';
import { attackLifeZone } from '../src/engine/combatEngine';
import { preventDamage } from '../src/engine/prevention';
import { runGameTransaction } from '../src/engine/gameTransaction';
import type { Card, CardInstance, GameState, PlayerState } from '../src/engine/types';

function card(name: string, type: Card['type'] = 'Avatar', subtype: Card['subtype'] = null, power = 3): Card {
  return {
    printId: name, name, type, subtype, cost: 0, gem: 0, power, color: 'ไร้สี', rarity: 'C',
    mainEffect: '', isOnlyOne: false, isBias: false, isCollab: false, imageUrl: ''
  };
}

function instance(id: string, owner = 'p1', type: Card['type'] = 'Avatar', subtype: Card['subtype'] = null, power = 3): CardInstance {
  return {
    instanceId: id, card: card(id, type, subtype, power), ownerId: owner, controllerId: owner,
    isRested: false, isFaceUp: true, attachedInstances: [], layerModifiers: []
  };
}

function player(id: string, overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id, name: id, seat: id === 'p1' ? 0 : 1, deck: [], hand: [], lifeDeck: [], avatarZone: [],
    constructZone: [], magicZone: [], hell: [], darkDimension: [], isCritical: false,
    reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 }, usedMagicTypesThisTurn: new Set(), ...overrides
  };
}

function state(p1 = player('p1'), p2 = player('p2')): GameState {
  return {
    id: 'phase2b', mode: 'DUEL', playerOrder: ['p1', 'p2'], currentTurnPlayerIndex: 0,
    currentPhase: 'MAIN', turnNumber: 1, roundNumber: 1, players: { p1, p2 }, landMagicZone: null, eventLog: []
  };
}

describe('Phase 2B cancellation, prevention, and continuous effects', () => {
  it('resolves a response above a cancellation first, then cancels the pending Magic without executing it', () => {
    const original = instance('original-magic', 'p1', 'Magic', 'Normal');
    original.card.mainEffect = 'จั่วการ์ด 1 ใบ';
    const cancel = instance('cancel-react', 'p2', 'Magic', 'React');
    cancel.card.mainEffect = 'เมื่อมีการใช้ Magic Card : ยกเลิกการใช้ Magic Card ใบนั้น';
    const laterResponse = instance('later-react', 'p1', 'Magic', 'React');
    laterResponse.card.mainEffect = 'จั่วการ์ด 1 ใบ';
    const draw = instance('draw-card', 'p1', 'Avatar');
    const p1 = player('p1', { hand: [laterResponse], deck: [draw], magicZone: [original], usedMagicTypesThisTurn: new Set(['Normal']) });
    const p2 = player('p2', { hand: [cancel] });
    const initial = state(p1, p2);
    const opened = openReactionWindow(initial, {
      type: 'MAGIC_PLAYED', actorId: 'p1', sourceInstanceId: original.instanceId, sourceCardName: original.card.name
    }, { type: 'RESOLVE_MAGIC', actorId: 'p1', sourceCard: original });

    const first = queueReactionCard(opened, 'p2', cancel.instanceId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = queueReactionCard(first.state, 'p1', laterResponse.instanceId);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const passA = passReactionPriority(second.state, 'p2');
    expect(passA.ok).toBe(true);
    if (!passA.ok) return;
    const firstResolve = passReactionPriority(passA.state, 'p1');
    expect(firstResolve.ok).toBe(true);
    if (!firstResolve.ok) return;
    expect(firstResolve.resolvedCard).toBe('later-react');
    expect(firstResolve.state.players.p1.hand.map(item => item.instanceId)).toContain('draw-card');
    expect(firstResolve.state.reactionWindow?.chain).toHaveLength(1);

    const passB = passReactionPriority(firstResolve.state, 'p2');
    expect(passB.ok).toBe(true);
    if (!passB.ok) return;
    const cancelResolve = passReactionPriority(passB.state, 'p1');
    expect(cancelResolve.ok).toBe(true);
    if (!cancelResolve.ok) return;
    expect(cancelResolve.resolvedCard).toBe('cancel-react');
    expect(cancelResolve.state.players.p1.hell.map(item => item.instanceId)).toContain('original-magic');
    expect(cancelResolve.state.players.p1.deck).toHaveLength(0);
    expect(cancelResolve.pendingAction).toBeUndefined();
    expect(cancelResolve.state.players.p1.usedMagicTypesThisTurn.has('Normal')).toBe(true);
    expect(cancelResolve.state.players.p2.hell.map(item => item.instanceId)).toContain('cancel-react');
    expect(cancelResolve.state.gameEvents?.some(item => item.event.type === 'ACTION_CANCELLED' && item.event.targetInstanceId === 'original-magic')).toBe(true);
  });

  it('cancels an activated ability continuation without moving its Avatar', () => {
    const source = instance('activated-source');
    const reaction = {
      id: 'cancel-window', trigger: { type: 'ABILITY_USED' as const, actorId: 'p1', sourceInstanceId: source.instanceId },
      turnOwnerId: 'p1', priorityPlayerId: 'p2', passedPlayerIds: [],
      pendingAction: { type: 'RESOLVE_ABILITY' as const, actorId: 'p1', sourceCard: source, abilityTrigger: 'CONSTRUCT_ACTIVATE' as const }
    };
    const current = state(player('p1', { avatarZone: [source] }), player('p2'));
    current.reactionWindow = reaction;
    const canceled = cancelReactionTarget(current, 'p2', { kind: 'ABILITY', instanceId: source.instanceId });
    expect(canceled.ok).toBe(true);
    expect(canceled.state.players.p1.avatarZone.map(item => item.instanceId)).toEqual(['activated-source']);
    expect(canceled.state.reactionWindow?.pendingAction).toBeUndefined();
    expect(canceled.state.gameEvents?.at(-1)?.event).toMatchObject({ type: 'ACTION_CANCELLED', targetKind: 'ABILITY' });
  });

  it('cancels a chain entry once and routes only that response card out of the resolving chain', () => {
    const queued = instance('queued-response', 'p2', 'Magic', 'React');
    const current = state(player('p1'), player('p2', { magicZone: [queued] }));
    current.reactionWindow = {
      id: 'chain-cancel', trigger: { type: 'MAGIC_PLAYED', actorId: 'p2', sourceInstanceId: queued.instanceId },
      turnOwnerId: 'p1', priorityPlayerId: 'p1', passedPlayerIds: [],
      chain: [{ playerId: 'p2', sourceCard: queued, treatedAsReact: false, respondedTo: { type: 'MAGIC_PLAYED', actorId: 'p1', sourceInstanceId: 'older' } }]
    };
    const canceled = cancelReactionTarget(current, 'p1', { kind: 'CHAIN_ENTRY', instanceId: queued.instanceId });
    expect(canceled.ok).toBe(true);
    expect(canceled.state.reactionWindow?.chain).toEqual([]);
    expect(canceled.state.players.p2.hell.map(item => item.instanceId)).toContain('queued-response');
    expect(canceled.state.gameEvents?.at(-1)?.event.type).toBe('ACTION_CANCELLED');

    const protectedEntry = instance('protected-entry', 'p2', 'Magic', 'React');
    protectedEntry.card.ruleTextProtected = true;
    const protectedState = state(player('p1'), player('p2', { magicZone: [protectedEntry] }));
    protectedState.reactionWindow = {
      id: 'protected-window', trigger: { type: 'MAGIC_PLAYED', actorId: 'p2' },
      turnOwnerId: 'p1', priorityPlayerId: 'p1', passedPlayerIds: [],
      chain: [{ playerId: 'p2', sourceCard: protectedEntry, treatedAsReact: false, respondedTo: { type: 'MAGIC_PLAYED', actorId: 'p1' } }]
    };
    const protectedResult = cancelReactionTarget(protectedState, 'p1', { kind: 'CHAIN_ENTRY', instanceId: 'protected-entry' });
    expect(protectedResult.ok).toBe(false);
    expect(protectedResult.state.reactionWindow?.chain).toHaveLength(1);
  });

  it('applies a full-use damage shield before LIFE damage changes and leaves 0-POWER attacks unable to consume it', () => {
    const life = instance('life-one', 'p2', 'Life');
    life.isFaceUp = false;
    const defender = player('p2', { lifeDeck: [life], preventionShields: [{ id: 'life-hit', kind: 'DAMAGE', usesRemaining: 1 }] });
    const attacker = instance('life-attacker', 'p1', 'Avatar', null, 2);
    const prevented = attackLifeZone(attacker, defender);
    expect(prevented.damageDealt).toBe(false);
    expect(prevented.event).toContain('life-hit');
    expect(defender.lifeDeck[0].isFaceUp).toBe(false);
    expect(defender.preventionShields).toEqual([]);

    const zeroPowerDefender = player('p2', { lifeDeck: [instance('life-two', 'p2', 'Life')], preventionShields: [{ id: 'not-consumed', kind: 'DAMAGE', usesRemaining: 1 }] });
    const zeroPower = attackLifeZone(instance('zero-attacker', 'p1', 'Avatar', null, 0), zeroPowerDefender);
    expect(zeroPower.damageDealt).toBe(false);
    expect(zeroPowerDefender.preventionShields?.[0]?.usesRemaining).toBe(1);
  });

  it('applies finite full and partial damage shields deterministically and expires duration shields', () => {
    const defended = player('p2', { preventionShields: [
      { id: 'partial-first', kind: 'DAMAGE', amount: 1, usesRemaining: 1, expiresAt: 'END_OF_TURN' }
    ] });
    const current = state(player('p1'), defended);
    const partial = preventDamage(current, 'p2', 3, 'p1');
    expect(partial.preventedAmount).toBe(1);
    expect(partial.remainingAmount).toBe(2);
    expect(partial.state.players.p2.preventionShields).toEqual([]);
    const withFullShield = { ...partial.state, players: { ...partial.state.players, p2: {
      ...partial.state.players.p2, preventionShields: [{ id: 'full-next', kind: 'DAMAGE' as const, usesRemaining: 1 }]
    } } };
    const full = preventDamage(withFullShield, 'p2', 2, 'p1');
    expect(full.remainingAmount).toBe(0);
    expect(full.state.players.p2.preventionShields).toEqual([]);
    expect(full.state.gameEvents?.filter(item => item.event.type === 'PREVENTION_APPLIED')).toHaveLength(2);

    const expiring = { ...current, players: { ...current.players, p2: {
      ...current.players.p2, preventionShields: [
        { id: 'battle-shield', kind: 'DAMAGE' as const, expiresAt: 'END_OF_BATTLE' as const },
        { id: 'turn-shield', kind: 'DAMAGE' as const, expiresAt: 'END_OF_TURN' as const },
        { id: 'draw-shield', kind: 'DAMAGE' as const, expiresAt: 'DRAW_PHASE' as const }
      ]
    } } };
    const afterBattle = expireModifiersAt(expiring, 'END_OF_BATTLE', 'p2');
    expect(afterBattle.players.p2.preventionShields?.map(shield => shield.id)).toEqual(['turn-shield', 'draw-shield']);
    const afterTurn = expireModifiersAt(afterBattle, 'END_OF_TURN', 'p2');
    expect(afterTurn.players.p2.preventionShields?.map(shield => shield.id)).toEqual(['draw-shield']);
    expect(expireModifiersAt(afterTurn, 'DRAW_PHASE', 'p2').players.p2.preventionShields).toEqual([]);
  });

  it('prevents destruction and targeting before changes, while player-directed movement bypasses destruction protection', () => {
    const guarded = instance('guarded', 'p2');
    guarded.preventionShields = [{ id: 'destroy-once', kind: 'DESTRUCTION', usesRemaining: 1, sourceControllerId: 'p2' }];
    const targetProtected = instance('target-protected', 'p2');
    targetProtected.preventionShields = [{ id: 'target-once', kind: 'TARGETING', usesRemaining: 1, sourceControllerId: 'p2' }];
    const targetTimed = instance('target-timed', 'p2');
    targetTimed.preventionShields = [{ id: 'target-until-battle', kind: 'TARGETING', sourceControllerId: 'p2', expiresAt: 'END_OF_BATTLE' }];
    const destructionTimed = instance('destruction-timed', 'p2');
    destructionTimed.preventionShields = [{ id: 'destruction-until-turn', kind: 'DESTRUCTION', sourceControllerId: 'p2', expiresAt: 'END_OF_TURN' }];
    const current = state(player('p1'), player('p2', { avatarZone: [guarded, targetProtected, targetTimed, destructionTimed] }));
    const destruction = resolveEffectPlan(current, { actorId: 'p1', effects: [{ kind: 'destroy_avatar', targetId: 'guarded' }] });
    expect(destruction.ok).toBe(true);
    expect(destruction.state.players.p2.avatarZone.some(item => item.instanceId === 'guarded')).toBe(true);
    expect(destruction.state.players.p2.avatarZone.find(item => item.instanceId === 'guarded')?.preventionShields).toEqual([]);
    expect(destruction.state.gameEvents?.some(item => item.event.type === 'PREVENTION_APPLIED' && item.event.kind === 'DESTRUCTION')).toBe(true);

    const blockedPower = resolveEffectPlan(destruction.state, { actorId: 'p1', effects: [{ kind: 'modify_power', targetId: 'target-protected', amount: 4 }] });
    expect(blockedPower.ok).toBe(true);
    const protectedTarget = blockedPower.state.players.p2.avatarZone.find(item => item.instanceId === 'target-protected')!;
    expect(protectedTarget.preventionShields).toEqual([]);
    expect(calculateNetPower(protectedTarget)).toBe(3);
    expect(blockedPower.state.gameEvents?.some(item => item.event.type === 'PREVENTION_APPLIED' && item.event.kind === 'TARGETING')).toBe(true);

    const timedTargetBlocked = resolveEffectPlan(blockedPower.state, { actorId: 'p1', effects: [{ kind: 'modify_power', targetId: 'target-timed', amount: 1 }] });
    expect(timedTargetBlocked.ok).toBe(true);
    expect(calculateNetPower(timedTargetBlocked.state.players.p2.avatarZone.find(item => item.instanceId === 'target-timed')!)).toBe(3);
    const afterBattle = expireModifiersAt(timedTargetBlocked.state, 'END_OF_BATTLE', 'p2');
    const timedTargetAllowed = resolveEffectPlan(afterBattle, { actorId: 'p1', effects: [{ kind: 'modify_power', targetId: 'target-timed', amount: 1 }] });
    expect(timedTargetAllowed.ok).toBe(true);
    expect(calculateNetPower(timedTargetAllowed.state.players.p2.avatarZone.find(item => item.instanceId === 'target-timed')!)).toBe(4);

    const timedDestroyBlocked = resolveEffectPlan(timedTargetAllowed.state, { actorId: 'p1', effects: [{ kind: 'destroy_avatar', targetId: 'destruction-timed' }] });
    expect(timedDestroyBlocked.ok).toBe(true);
    expect(timedDestroyBlocked.state.players.p2.avatarZone.some(item => item.instanceId === 'destruction-timed')).toBe(true);
    const afterTurn = expireModifiersAt(timedDestroyBlocked.state, 'END_OF_TURN', 'p2');
    const timedDestroyAllowed = resolveEffectPlan(afterTurn, { actorId: 'p1', effects: [{ kind: 'destroy_avatar', targetId: 'destruction-timed' }] });
    expect(timedDestroyAllowed.ok).toBe(true);
    expect(timedDestroyAllowed.state.players.p2.avatarZone.some(item => item.instanceId === 'destruction-timed')).toBe(false);

    const playerAction = moveCardBetweenZones(destruction.state, {
      instanceId: 'guarded', actorId: 'p2', destination: 'hell', destinationPlayerId: 'p2', effectMove: true, cause: 'PLAYER_ACTION'
    });
    expect(playerAction.ok).toBe(true);
    expect(playerAction.state.players.p2.avatarZone.some(item => item.instanceId === 'guarded')).toBe(false);
  });

  it('recalculates Layer 1–4 values as Avatar, Construct, and Land sources enter or leave, without changing printed power', () => {
    const target = instance('layered-target', 'p1', 'Avatar', null, 3);
    target.preventionShields = [{ id: 'source-bound-shield', kind: 'DESTRUCTION', sourceInstanceId: 'avatar-aura' }];
    target.layerModifiers = [
      { layer: 1, powerMod: 1, sourceCardId: 'direct' },
      { layer: 3, powerMod: 4, sourceCardId: 'snapshot' },
      { layer: 4, powerMod: 5, sourceCardId: 'combat' }
    ];
    const p1 = player('p1', { avatarZone: [target] });
    const p2 = player('p2');
    let current = state(p1, p2);
    const avatarSource = instance('avatar-aura', 'p1');
    avatarSource.continuousEffects = [{ layer: 2, powerMod: 1, targetCardType: 'Avatar' }];
    const constructSource = instance('construct-aura', 'p1', 'Construct');
    constructSource.continuousEffects = [{ layer: 2, powerMod: 2, targetCardType: 'Avatar' }];
    const landSource = instance('land-aura', 'p1', 'Magic', 'Land');
    landSource.continuousEffects = [{ layer: 2, powerMod: 3, targetCardType: 'Avatar', targetController: 'ANY' }];
    current.players.p1.hand = [avatarSource, constructSource, landSource];

    for (const [id, destination] of [
      ['avatar-aura', 'avatarZone'], ['construct-aura', 'constructZone'], ['land-aura', 'landMagicZone']
    ] as const) {
      const moved = moveCardBetweenZones(current, { instanceId: id, actorId: 'p1', destination, destinationPlayerId: 'p1' });
      expect(moved.ok).toBe(true);
      current = moved.state;
    }
    const buffed = current.players.p1.avatarZone.find(item => item.instanceId === 'layered-target')!;
    expect(calculateNetPower(buffed)).toBe(19);
    expect(buffed.card.power).toBe(3);

    const removeLand = moveCardBetweenZones(current, { instanceId: 'land-aura', actorId: 'p1', destination: 'hell', destinationPlayerId: 'p1', effectMove: true });
    expect(removeLand.ok).toBe(true);
    const afterLandLeaves = removeLand.state.players.p1.avatarZone.find(item => item.instanceId === 'layered-target')!;
    expect(calculateNetPower(afterLandLeaves)).toBe(16);
    expect(afterLandLeaves.layerModifiers.some(modifier => modifier.sourceCardId === 'continuous:land-aura:0')).toBe(false);

    const removeAvatar = moveCardBetweenZones(removeLand.state, { instanceId: 'avatar-aura', actorId: 'p1', destination: 'hell', destinationPlayerId: 'p1', effectMove: true });
    expect(removeAvatar.ok).toBe(true);
    const afterAvatarLeaves = removeAvatar.state.players.p1.avatarZone.find(item => item.instanceId === 'layered-target')!;
    expect(calculateNetPower(afterAvatarLeaves)).toBe(15);
    expect(afterAvatarLeaves.preventionShields).toEqual([]);
    const removeConstruct = moveCardBetweenZones(removeAvatar.state, { instanceId: 'construct-aura', actorId: 'p1', destination: 'hell', destinationPlayerId: 'p1', effectMove: true });
    expect(removeConstruct.ok).toBe(true);
    const clean = removeConstruct.state.players.p1.avatarZone.find(item => item.instanceId === 'layered-target')!;
    expect(calculateNetPower(clean)).toBe(13);
    expect(clean.layerModifiers.filter(modifier => modifier.sourceCardId.startsWith('continuous:'))).toEqual([]);
    expect(clean.card.power).toBe(3);
  });

  it('recalculates the supported legacy printed POWER aura when its Avatar source enters and leaves', () => {
    const target = instance('legacy-target', 'p1', 'Avatar', null, 3);
    target.card.symbol = 'เทพ';
    const source = instance('legacy-source', 'p1');
    source.card.mainEffect = 'ต่อเนื่อง ตราบเท่าที่ Avatar ใบนี้อยู่บน Avatar Zone POWER +2 ให้ Avatar {symbol เทพ} ทุกใบบน Avatar Zone ฝ่ายเรา';
    const current = state(player('p1', { avatarZone: [target], hand: [source] }), player('p2'));
    const entered = moveCardBetweenZones(current, { instanceId: source.instanceId, actorId: 'p1', destination: 'avatarZone', destinationPlayerId: 'p1' });
    expect(entered.ok).toBe(true);
    if (!entered.ok) return;
    expect(calculateNetPower(entered.state.players.p1.avatarZone.find(item => item.instanceId === target.instanceId)!)).toBe(5);
    const left = moveCardBetweenZones(entered.state, { instanceId: source.instanceId, actorId: 'p1', destination: 'hell', destinationPlayerId: 'p1', effectMove: true });
    expect(left.ok).toBe(true);
    if (!left.ok) return;
    const cleanTarget = left.state.players.p1.avatarZone.find(item => item.instanceId === target.instanceId)!;
    expect(calculateNetPower(cleanTarget)).toBe(3);
    expect(cleanTarget.card.power).toBe(3);
  });

  it('rolls back consumed shields, cancellations, modifier recalculation, and events when a later transaction step fails', () => {
    const target = instance('rollback-target', 'p2');
    target.preventionShields = [{ id: 'rollback-shield', kind: 'DESTRUCTION', usesRemaining: 1, sourceControllerId: 'p2' }];
    const current = state(player('p1'), player('p2', { avatarZone: [target] }));
    const failedPlan = resolveEffectPlan(current, {
      actorId: 'p1', effects: [
        { kind: 'destroy_avatar', targetId: 'rollback-target' },
        { kind: 'draw', playerId: 'p1', count: 1 }
      ]
    });
    expect(failedPlan.ok).toBe(false);
    expect(failedPlan.state).toBe(current);
    expect(current.players.p2.avatarZone[0].preventionShields?.[0]?.usesRemaining).toBe(1);
    expect(current.gameEvents).toBeUndefined();

    const reaction = instance('rollback-react', 'p2', 'Magic', 'React');
    const pending = { ...current, players: { ...current.players, p2: { ...current.players.p2, magicZone: [reaction] } }, reactionWindow: {
      id: 'rollback-window', trigger: { type: 'MAGIC_PLAYED' as const, actorId: 'p1' }, turnOwnerId: 'p1', priorityPlayerId: 'p2', passedPlayerIds: [],
      chain: [{ playerId: 'p2', sourceCard: reaction, treatedAsReact: false, respondedTo: { type: 'MAGIC_PLAYED' as const, actorId: 'p1', sourceInstanceId: 'older' } }]
    } } satisfies GameState;
    const transaction = runGameTransaction(pending, draft => {
      const canceled = cancelReactionTarget(draft, 'p2', { kind: 'CHAIN_ENTRY', instanceId: 'rollback-react' });
      if (!canceled.ok) return null;
      return { ...canceled.state, players: { ...canceled.state.players, p1: { ...canceled.state.players.p1, avatarZone: [target] } } };
    });
    expect(transaction.ok).toBe(false);
    expect(transaction.state).toBe(pending);
    expect(transaction.state.reactionWindow?.chain).toHaveLength(1);
    expect(transaction.state.gameEvents).toBeUndefined();

    const auraTarget = instance('rollback-aura-target', 'p1');
    const auraSource = instance('rollback-aura-source', 'p1');
    auraSource.continuousEffects = [{ layer: 2, powerMod: 2, targetCardType: 'Avatar' }];
    const withSourceInHand = state(player('p1', { avatarZone: [auraTarget], hand: [auraSource] }), player('p2'));
    const sourceEnters = moveCardBetweenZones(withSourceInHand, {
      instanceId: auraSource.instanceId, actorId: 'p1', destination: 'avatarZone', destinationPlayerId: 'p1'
    });
    expect(sourceEnters.ok).toBe(true);
    if (!sourceEnters.ok) return;
    expect(calculateNetPower(sourceEnters.state.players.p1.avatarZone[0])).toBe(5);
    const eventCount = sourceEnters.state.gameEvents?.length ?? 0;
    const recalcFailure = runGameTransaction(sourceEnters.state, draft => {
      const leaves = moveCardBetweenZones(draft, {
        instanceId: auraSource.instanceId, actorId: 'p1', destination: 'hell', destinationPlayerId: 'p1', effectMove: true
      });
      if (!leaves.ok) return null;
      return { ...leaves.state, players: { ...leaves.state.players, p1: {
        ...leaves.state.players.p1, hand: [...leaves.state.players.p1.hand, auraTarget]
      } } };
    });
    expect(recalcFailure.ok).toBe(false);
    expect(recalcFailure.state).toBe(sourceEnters.state);
    expect(calculateNetPower(recalcFailure.state.players.p1.avatarZone[0])).toBe(5);
    expect(recalcFailure.state.gameEvents).toHaveLength(eventCount);
  });
});
