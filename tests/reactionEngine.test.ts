import { describe, expect, it } from 'vitest';
import {
  beginReactionCard,
  closeReactionWindowAfterResponse,
  getEligibleReactionCards,
  getReactionEligibility,
  openReactionWindow,
  passReactionPriority,
  queueReactionCard,
  resolveReactionCard
} from '../src/engine/reactionEngine';
import { decodeNetMessage, encodeNetMessage } from '../src/engine/multiplayer';
import type { Card, CardInstance, GameState, PlayerState, ReactionTrigger } from '../src/engine/types';

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    printId: 'TEST-001',
    name: 'Test card',
    type: 'Magic',
    subtype: 'React',
    cost: 0,
    gem: 0,
    power: 0,
    color: 'ไร้สี',
    rarity: 'C',
    mainEffect: '',
    isOnlyOne: false,
    isBias: false,
    isCollab: false,
    imageUrl: '',
    ...overrides
  };
}

function makeInstance(card: Card, ownerId: string, instanceId: string): CardInstance {
  return {
    instanceId,
    card,
    ownerId,
    controllerId: ownerId,
    isRested: false,
    isFaceUp: true,
    attachedInstances: [],
    layerModifiers: []
  };
}

function makePlayer(id: string, hand: CardInstance[] = [], avatarZone: CardInstance[] = [], deck: CardInstance[] = []): PlayerState {
  return {
    id,
    name: id,
    seat: id === 'player-1' ? 0 : 1,
    deck,
    hand,
    lifeDeck: [],
    avatarZone,
    constructZone: [],
    magicZone: [],
    hell: [],
    darkDimension: [],
    isCritical: false,
    reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 },
    usedMagicTypesThisTurn: new Set()
  };
}

function makeState(p2Hand: CardInstance[] = [], p2Avatars: CardInstance[] = [], p2Deck: CardInstance[] = []): GameState {
  return {
    id: 'game',
    mode: 'DUEL',
    playerOrder: ['player-1', 'player-2'],
    currentTurnPlayerIndex: 0,
    currentPhase: 'MAIN',
    turnNumber: 2,
    roundNumber: 1,
    players: {
      'player-1': makePlayer('player-1'),
      'player-2': makePlayer('player-2', p2Hand, p2Avatars, p2Deck)
    },
    landMagicZone: null,
    eventLog: []
  };
}

const summon: ReactionTrigger = { type: 'AVATAR_SUMMONED', actorId: 'player-1', targetInstanceId: 'summoned-1', targetCardName: 'Ghui' };

describe('reaction window engine', () => {
  it('opens for an opposing Avatar summon and lets the matching React resolve before Juti', () => {
    const eligible = makeCard({ printId: 'SD01-017', name: 'อุบัติเหตุ!!!', mainEffect: 'เมื่อมี Avatar อัญเชิญลงมาบนสนาม : ทำลาย Avatar ตัวนั้น' });
    const summoned = makeInstance(makeCard({ type: 'Avatar', subtype: null, mainEffect: 'จุติ' }), 'player-1', 'summoned-1');
    const state = makeState([makeInstance(eligible, 'player-2', 'react-1')]);
    state.players['player-1'].avatarZone = [summoned];
    const opened = openReactionWindow(state, summon, { type: 'SUMMON_JUTI', actorId: 'player-1', sourceCard: summoned, paidCost: true });

    expect(opened.reactionWindow?.trigger).toEqual(summon);
    expect(opened.reactionWindow?.priorityPlayerId).toBe('player-2');
    expect(opened.reactionWindow?.pendingAction?.type).toBe('SUMMON_JUTI');
    expect(getEligibleReactionCards(opened, 'player-2')).toHaveLength(1);

    const started = beginReactionCard(opened, 'player-2', 'react-1');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.state.players['player-2'].reactMagicBudget.opponentTurnRemaining).toBe(0);
    expect(started.state.players['player-2'].usedMagicTypesThisTurn.has('React')).toBe(true);
    const resolved = resolveReactionCard(started.state);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.state.players['player-1'].avatarZone).toHaveLength(0);
    expect(resolved.state.players['player-2'].magicZone).toHaveLength(0);
    expect(resolved.state.players['player-2'].hell.map(card => card.instanceId)).toContain('react-1');
    expect(resolved.pendingAction?.type).toBe('SUMMON_JUTI');
    expect(resolved.state.reactionWindow).toBeUndefined();

    const secondReact = makeInstance(eligible, 'player-2', 'react-2');
    const afterFirstReact = {
      ...resolved.state,
      players: { ...resolved.state.players, 'player-2': { ...resolved.state.players['player-2'], hand: [secondReact] } }
    };
    expect(openReactionWindow(afterFirstReact, summon, { type: 'SUMMON_JUTI', actorId: 'player-1', sourceCard: summoned, paidCost: true })).toBe(afterFirstReact);
  });

  it('blocks protection effects until their prevention semantics are implemented', () => {
    const protectReact = makeCard({ mainEffect: 'เมื่อ Avatar ใบนี้กำลังจะถูกทำลาย : ป้องกันการทำลาย' });
    const state = makeState([makeInstance(protectReact, 'player-2', 'protect-react')]);
    const trigger = {
      type: 'AVATAR_WOULD_BE_DESTROYED' as const,
      actorId: 'player-1',
      targetInstanceId: 'avatar-2',
      targetCardName: 'Target'
    };

    expect(openReactionWindow(state, trigger)).toBe(state);
    expect(getReactionEligibility({ ...state, reactionWindow: {
      id: 'window', trigger, turnOwnerId: 'player-1', priorityPlayerId: 'player-2', passedPlayerIds: []
    } }, 'player-2', protectReact).eligible).toBe(false);
  });

  it('does not invent multi-player Reaction priority outside the official Duel rules', () => {
    const react = makeInstance(makeCard({ mainEffect: 'จั่วการ์ด 1 ใบ' }), 'player-2', 'react');
    const state = makeState([react]);
    state.mode = 'AD_MUA';
    state.playerOrder = ['player-1', 'player-2', 'player-3'];
    state.players['player-3'] = makePlayer('player-3');

    expect(openReactionWindow(state, summon)).toBe(state);
  });

  it('opens only for matching attack and ability trigger text', () => {
    const attackReact = makeCard({ mainEffect: 'เมื่อฝ่ายตรงข้ามประกาศโจมตี : ทำลาย Avatar ตัวนั้น' });
    const attackState = makeState([makeInstance(attackReact, 'player-2', 'attack-react')]);
    const attackWindow = openReactionWindow(attackState, {
      type: 'ATTACK_DECLARED', actorId: 'player-1', targetInstanceId: 'attacker-1', targetCardName: 'Ghui'
    });
    expect(attackWindow.reactionWindow?.priorityPlayerId).toBe('player-2');

    const abilityReact = makeCard({ mainEffect: 'เมื่อฝ่ายตรงข้ามใช้ความสามารถของ Avatar : จั่วการ์ด 1 ใบ' });
    const abilityState = makeState([makeInstance(abilityReact, 'player-2', 'ability-react')]);
    const abilityWindow = openReactionWindow(abilityState, { type: 'ABILITY_USED', actorId: 'player-1', sourceCardName: 'Avatar' });
    expect(abilityWindow.reactionWindow?.trigger.type).toBe('ABILITY_USED');
    expect(openReactionWindow(abilityState, summon)).toBe(abilityState);
  });

  it('rejects an unrelated explicitly timed React while allowing a generic React at a rulebook timing', () => {
    const attackOnly = makeCard({ mainEffect: 'เมื่อฝ่ายตรงข้ามประกาศโจมตี : จั่วการ์ด 1 ใบ' });
    const state = makeState([makeInstance(attackOnly, 'player-2', 'react-attack')]);
    expect(openReactionWindow(state, summon)).toBe(state);

    const genericReact = makeCard({ printId: 'GENERIC-REACT', mainEffect: 'จั่วการ์ด 1 ใบ' });
    const stateWithGeneric = makeState([makeInstance(genericReact, 'player-2', 'generic-react')]);
    const beforePhase = openReactionWindow(stateWithGeneric, { type: 'BEFORE_PHASE_CHANGE', actorId: 'player-1' });
    expect(beforePhase.reactionWindow?.trigger.type).toBe('BEFORE_PHASE_CHANGE');
    expect(getEligibleReactionCards(beforePhase, 'player-2')).toHaveLength(1);
  });

  it('does not allow ordinary Normal Magic during the opponent turn', () => {
    const ordinaryNormal = makeCard({ subtype: 'Normal', mainEffect: 'จั่วการ์ด 1 ใบ' });
    const state = makeState([makeInstance(ordinaryNormal, 'player-2', 'normal-1')]);
    const opened = openReactionWindow(state, summon);
    const fakeWindowState = {
      ...state,
      reactionWindow: {
        id: 'forged-test-window',
        trigger: summon,
        turnOwnerId: 'player-1',
        priorityPlayerId: 'player-2',
        passedPlayerIds: []
      }
    };

    expect(opened).toBe(state);
    expect(getReactionEligibility(fakeWindowState, 'player-2', ordinaryNormal).eligible).toBe(false);
  });

  it('allows a Normal Magic explicitly treated as React only at its printed timing and condition', () => {
    const police = makeInstance(makeCard({ type: 'Avatar', subtype: null, name: 'ตำรวจ' }), 'player-2', 'police-1');
    const powerReset = makeCard({
      printId: 'BT07-049',
      subtype: 'Normal',
      mainEffect: 'เลือก Avatar 1 ใบ บนสนาม : ปรับ POWER ของ Avatar ใบนั้น ให้กลับเป็น POWER ตั้งต้น หากบน Avatar Zone ฝ่ายเรามี "ตำรวจ" การ์ดใบนี้สามารถใช้ในเทิร์นฝ่ายตรงข้ามได้ โดยถือว่าเป็นการใช้ React Magic'
    });
    const state = makeState([makeInstance(powerReset, 'player-2', 'normal-react')], [police]);
    const opened = { ...state, reactionWindow: { id: 'window', trigger: summon, turnOwnerId: 'player-1', priorityPlayerId: 'player-2', passedPlayerIds: [] } };

    expect(getReactionEligibility(opened, 'player-2', powerReset).eligible).toBe(true);
    expect(getReactionEligibility({ ...opened, players: { ...opened.players, 'player-2': { ...opened.players['player-2'], avatarZone: [] } } }, 'player-2', powerReset).eligible).toBe(false);
  });

  it('resolves the qualifying Normal-as-React card against a selected legal Avatar', () => {
    const police = makeInstance(makeCard({ type: 'Avatar', subtype: null, name: 'ตำรวจ' }), 'player-2', 'police-1');
    const changedTarget = makeInstance(makeCard({ type: 'Avatar', subtype: null }), 'player-1', 'target-1');
    changedTarget.layerModifiers = [{ layer: 4, powerMod: 3, sourceCardId: 'buff-1' }];
    const powerReset = makeCard({
      printId: 'BT07-049',
      subtype: 'Normal',
      mainEffect: 'เลือก Avatar 1 ใบ บนสนาม : ปรับ POWER ของ Avatar ใบนั้น ให้กลับเป็น POWER ตั้งต้น หากบน Avatar Zone ฝ่ายเรามี "ตำรวจ" การ์ดใบนี้สามารถใช้ในเทิร์นฝ่ายตรงข้ามได้ โดยถือว่าเป็นการใช้ React Magic'
    });
    const state = makeState([makeInstance(powerReset, 'player-2', 'normal-react')], [police]);
    state.players['player-1'].avatarZone = [changedTarget];
    const opened = openReactionWindow(state, summon);
    const started = beginReactionCard(opened, 'player-2', 'normal-react');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const resolved = resolveReactionCard(started.state, 'target-1');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.state.players['player-1'].avatarZone[0].layerModifiers).toHaveLength(0);
  });

  it('assigns a new synchronized identifier to every reaction window', () => {
    const genericReact = makeCard({ mainEffect: 'จั่วการ์ด 1 ใบ' });
    const state = makeState([makeInstance(genericReact, 'player-2', 'generic-react')]);
    const firstWindow = openReactionWindow(state, summon);
    const firstPass = passReactionPriority(firstWindow, 'player-2');
    expect(firstPass.ok).toBe(true);
    if (!firstPass.ok) return;
    const secondPass = passReactionPriority(firstPass.state, 'player-1');
    expect(secondPass.ok).toBe(true);
    if (!secondPass.ok) return;
    const secondWindow = openReactionWindow(secondPass.state, summon);

    expect(secondWindow.reactionWindow?.id).not.toBe(firstWindow.reactionWindow?.id);
    expect(secondWindow.reactionSequence).toBe(2);
  });

  it('requires a valid window and enforces opponent-first then active-player priority', () => {
    const state = makeState();
    const invalidPass = passReactionPriority(state, 'player-2');
    expect(invalidPass.ok).toBe(false);

    const reactCard = makeCard({ mainEffect: 'เมื่อมี Avatar อัญเชิญลงมาบนสนาม : ทำลาย Avatar ตัวนั้น' });
    const opened = openReactionWindow(makeState([makeInstance(reactCard, 'player-2', 'react-1')]), summon);
    const opponentPass = passReactionPriority(opened, 'player-2');
    expect(opponentPass.ok).toBe(true);
    if (!opponentPass.ok) return;
    expect(opponentPass.state.reactionWindow?.priorityPlayerId).toBe('player-1');

    const wrongPlayer = passReactionPriority(opponentPass.state, 'player-2');
    expect(wrongPlayer.ok).toBe(false);
    const activePass = passReactionPriority(opponentPass.state, 'player-1');
    expect(activePass.ok).toBe(true);
    if (activePass.ok) expect(activePass.state.reactionWindow).toBeUndefined();
  });

  it('keeps a phase change pending until both priority passes are recorded', () => {
    const genericReact = makeCard({ mainEffect: 'จั่วการ์ด 1 ใบ' });
    const state = makeState([makeInstance(genericReact, 'player-2', 'generic-react')]);
    const opened = openReactionWindow(
      state,
      { type: 'BEFORE_PHASE_CHANGE', actorId: 'player-1' },
      { type: 'ADVANCE_PHASE', actorId: 'player-1', nextPhase: 'BATTLE' }
    );
    expect(opened.currentPhase).toBe('MAIN');
    const opponentPass = passReactionPriority(opened, 'player-2');
    expect(opponentPass.ok).toBe(true);
    if (!opponentPass.ok) return;
    const ownerPass = passReactionPriority(opponentPass.state, 'player-1');
    expect(ownerPass.ok).toBe(true);
    if (!ownerPass.ok) return;
    expect(ownerPass.state.currentPhase).toBe('MAIN');
    expect(ownerPass.pendingAction?.type).toBe('ADVANCE_PHASE');
  });

  it('queues multiple responses and resolves the chain last-in-first-out after consecutive passes', () => {
    const reactA = makeInstance(makeCard({ name: 'First response', mainEffect: 'จั่วการ์ด 1 ใบ' }), 'player-2', 'react-a');
    const reactB = makeInstance(makeCard({ name: 'Second response', mainEffect: 'จั่วการ์ด 1 ใบ' }), 'player-1', 'react-b');
    const drawCard = makeInstance(makeCard({ type: 'Avatar', subtype: null }), 'player-1', 'deck-p1');
    const drawCard2 = makeInstance(makeCard({ type: 'Avatar', subtype: null }), 'player-2', 'deck-p2');
    const state = makeState([reactA], [], [drawCard2]);
    state.players['player-1'].hand = [reactB];
    state.players['player-1'].deck = [drawCard];
    const opened = openReactionWindow(state, summon);

    const first = queueReactionCard(opened, 'player-2', 'react-a');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.state.reactionWindow?.priorityPlayerId).toBe('player-1');
    const second = queueReactionCard(first.state, 'player-1', 'react-b');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state.reactionWindow?.chain?.map(entry => entry.sourceCard.card.name)).toEqual([
      'First response', 'Second response'
    ]);

    const passOne = passReactionPriority(second.state, 'player-2');
    expect(passOne.ok).toBe(true);
    if (!passOne.ok) return;
    expect(passOne.state.reactionWindow?.chain).toHaveLength(2);
    const resolveTop = passReactionPriority(passOne.state, 'player-1');
    expect(resolveTop.ok).toBe(true);
    if (!resolveTop.ok) return;
    expect(resolveTop.resolvedCard).toBe('Second response');
    expect(resolveTop.state.players['player-1'].deck).toHaveLength(0);
    expect(resolveTop.state.players['player-2'].deck).toHaveLength(1);
    expect(resolveTop.state.reactionWindow?.chain).toHaveLength(1);
    const synchronized = decodeNetMessage(encodeNetMessage({ type: 'SYNC', state: resolveTop.state, winner: null }));
    expect(synchronized?.type).toBe('SYNC');
    if (synchronized?.type === 'SYNC') {
      expect(synchronized.state.players['player-1'].deck).toHaveLength(0);
      expect(synchronized.state.players['player-2'].deck).toHaveLength(1);
      expect(synchronized.state.reactionWindow?.chain).toHaveLength(1);
      expect(synchronized.state.reactionWindow?.revision).toBe(resolveTop.state.reactionWindow?.revision);
    }

    const passThree = passReactionPriority(resolveTop.state, 'player-2');
    expect(passThree.ok).toBe(true);
    if (!passThree.ok) return;
    const resolveBottom = passReactionPriority(passThree.state, 'player-1');
    expect(resolveBottom.ok).toBe(true);
    if (!resolveBottom.ok) return;
    expect(resolveBottom.resolvedCard).toBe('First response');
    expect(resolveBottom.state.players['player-2'].deck).toHaveLength(0);
    expect(resolveBottom.state.reactionWindow).toBeUndefined();
  });

  it('uses the triggering Avatar as an implicit target and sends the resolved React to Hell', () => {
    const react = makeInstance(makeCard({
      name: 'Accident',
      mainEffect: 'เมื่อมี Avatar อัญเชิญลงมาบนสนาม : ทำลาย Avatar ตัวนั้น'
    }), 'player-2', 'accident');
    const summoned = makeInstance(makeCard({ type: 'Avatar', subtype: null }), 'player-1', 'summoned');
    const state = makeState([react]);
    state.players['player-1'].avatarZone = [summoned];
    const opened = openReactionWindow(state, {
      type: 'AVATAR_SUMMONED', actorId: 'player-1', targetInstanceId: 'summoned', targetCardName: 'Test card'
    });
    const queued = queueReactionCard(opened, 'player-2', 'accident');
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const passOpponent = passReactionPriority(queued.state, 'player-1');
    expect(passOpponent.ok).toBe(true);
    if (!passOpponent.ok) return;
    const resolved = passReactionPriority(passOpponent.state, 'player-2');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.state.players['player-1'].avatarZone).toHaveLength(0);
    expect(resolved.state.players['player-2'].hell.some(card => card.instanceId === 'accident')).toBe(true);
  });

  it('rejects a response from the wrong priority or a card whose required target is missing', () => {
    const targetReact = makeInstance(makeCard({ mainEffect: 'เลือก Avatar 1 ใบ บนสนามฝ่ายตรงข้าม : ทำลาย Avatar ตัวนั้น' }), 'player-2', 'target-react');
    const opened = openReactionWindow(makeState([targetReact]), summon);
    expect(queueReactionCard(opened, 'player-1', 'target-react').ok).toBe(false);
    expect(queueReactionCard(opened, 'player-2', 'target-react').ok).toBe(false);
  });

  it('rejects structurally forged priority and avoids resolving a target that left before chain resolution', () => {
    const react = makeInstance(makeCard({ mainEffect: 'เลือก Avatar 1 ใบ บนสนามฝ่ายตรงข้าม : ทำลาย Avatar ตัวนั้น' }), 'player-2', 'react-target');
    const target = makeInstance(makeCard({ type: 'Avatar', subtype: null }), 'player-1', 'target-1');
    const state = makeState([react]);
    state.players['player-1'].avatarZone = [target];
    const opened = openReactionWindow(state, summon);
    const queued = queueReactionCard(opened, 'player-2', 'react-target', 'target-1');
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const stateAfterTargetLeaves = {
      ...queued.state,
      players: { ...queued.state.players, 'player-1': { ...queued.state.players['player-1'], avatarZone: [] } }
    };
    const passOne = passReactionPriority(stateAfterTargetLeaves, 'player-1');
    expect(passOne.ok).toBe(true);
    if (!passOne.ok) return;
    const resolved = passReactionPriority(passOne.state, 'player-2');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.logs?.[0]).toContain('เป้าหมายไม่ถูกต้อง');
  });

  it('preserves the pending action through window sync and closes without resolving it early', () => {
    const sourceCard = makeInstance(makeCard({ type: 'Avatar', subtype: null }), 'player-1', 'summoned-1');
    const state = makeState([makeInstance(makeCard({ mainEffect: 'เมื่อมี Avatar อัญเชิญลงมาบนสนาม : ทำลาย Avatar ตัวนั้น' }), 'player-2', 'react-1')]);
    const opened = openReactionWindow(state, summon, { type: 'SUMMON_JUTI', actorId: 'player-1', sourceCard, paidCost: true });
    const synced = JSON.parse(JSON.stringify(opened)) as GameState;

    expect(synced.reactionWindow?.pendingAction?.sourceCard.instanceId).toBe('summoned-1');
    expect(closeReactionWindowAfterResponse(synced).reactionWindow).toBeUndefined();
    expect(synced.reactionWindow).toBeDefined();
  });
});
