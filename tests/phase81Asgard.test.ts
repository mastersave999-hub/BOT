import { describe, expect, it } from 'vitest';
import type { Card, CardInstance, GameState, PlayerState } from '../src/engine/types';
import { parseCardText, activateRegisteredCardTextAbility } from '../src/engine/cardTextAdapter';
import { recomputeContinuousEffects } from '../src/engine/continuousEffects';
import { calculateEffectiveSymbol } from '../src/engine/layers';
import { finishEndPhaseTurn, transitionGamePhase } from '../src/engine/turnEngine';
import {
  approveManualOverride,
  beginManualOverrideQueue,
  describeManualOverrideAction,
  rejectManualOverride,
} from '../src/engine/hybridMode';
import { isManualOverrideCommandCurrent } from '../src/engine/multiplayer';

/** The exact printed text shared by BT02-060, PRMO-155 and KD01-020. */
const ASGARD_TEXT_BT02 = 'เปลี่ยน Symbol ของ Avatar ทุกใบบน Avatar Zone เป็น Symbol {เทพ}\n\nเทิร์นละครั้ง สั่งใช้ ทิ้งการ์ด 1 ใบ แล้วเลือก Avatar 1 ตัว บน Avatar Zone ฝั่งตรงข้ามที่ Cost ไม่เกิน 3 และมีสภาพนอน : เปลี่ยนการควบคุมมาบน Avatar Zone ฝ่ายเราในสภาพนอน จนจบเทิร์น';
const ASGARD_TEXT_KD01 = 'เปลี่ยน Symbol ของ Avatar ทุกใบบน Avatar Zone เป็น {Symbol เทพ}\n\nเทิร์นละครั้ง สั่งใช้ ทิ้งการ์ด 1 ใบ แล้วเลือก Avatar 1 ตัว บน Avatar Zone ฝั่งตรงข้ามที่ Cost ไม่เกิน 3 และมีสภาพนอน : เปลี่ยนการควบคุมมาบน Avatar Zone ฝ่ายเราในสภาพนอน จนจบเทิร์น';

function card(overrides: Partial<Card> = {}): Card {
  return {
    printId: 'BT02-060',
    name: 'แอสการ์ดคือสถานที่ไม่ใช่ผู้คน',
    type: 'Magic',
    subtype: 'Land',
    soi: 1,
    cost: 4,
    gem: 0,
    power: 0,
    symbol: 'เทพ',
    color: 'ไร้สี',
    rarity: 'SR',
    mainEffect: ASGARD_TEXT_BT02,
    isOnlyOne: false,
    isBias: false,
    isCollab: false,
    imageUrl: 'https://cdn.bottcg.com/cards/BT02-060.png',
    ...overrides
  };
}

function instance(instanceId: string, playerId: string, cardData: Card, overrides: Partial<CardInstance> = {}): CardInstance {
  return {
    instanceId,
    card: cardData,
    ownerId: playerId,
    originalOwnerId: playerId,
    controllerId: playerId,
    isRested: false,
    isFaceUp: true,
    attachedInstances: [],
    layerModifiers: [],
    ...overrides
  };
}

function makePlayer(id: string, seat: number): PlayerState {
  return {
    id,
    name: id,
    seat,
    deck: [],
    hand: [],
    lifeDeck: [],
    avatarZone: [],
    constructZone: [],
    magicZone: [],
    hell: [],
    darkDimension: [],
    isCritical: false,
    reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 },
    usedMagicTypesThisTurn: new Set()
  };
}

function makeState(): GameState {
  return {
    id: 'phase81-asgard',
    mode: 'DUEL',
    ruleMode: 'HYBRID',
    playerOrder: ['p1', 'p2'],
    currentTurnPlayerIndex: 0,
    currentPhase: 'MAIN',
    turnNumber: 1,
    roundNumber: 1,
    landMagicZone: null,
    players: { p1: makePlayer('p1', 0), p2: makePlayer('p2', 1) },
    stateRevision: 0,
    eventLog: []
  };
}

function avatarCard(name: string, symbol: string, cost: number, printId = 'asgard-target'): Card {
  return {
    printId,
    name,
    type: 'Avatar',
    subtype: null,
    soi: 1,
    cost,
    gem: 0,
    power: 2,
    symbol,
    color: 'ม่วง',
    rarity: 'C',
    mainEffect: '',
    isOnlyOne: false,
    isBias: false,
    isCollab: false,
    imageUrl: 'https://cdn.bottcg.com/cards/card-back.png'
  };
}

function placeAsgard(state: GameState, controllerId = 'p1'): GameState {
  // Playing a Land Magic card runs the continuous-effect recompute, which also
  // registers the card's parsed activated abilities on the zone instance.
  return recomputeContinuousEffects({
    ...state,
    landMagicZone: instance('asgard-land', controllerId, card(), { controllerId })
  });
}

describe('Phase 8.1 — Asgard card text parsing (BT02-060 / PRMO-155 / KD01-020)', () => {
  it('parses both printings PARSED_READY with a Layer 2 all-Avatars Symbol aura', () => {
    for (const text of [ASGARD_TEXT_BT02, ASGARD_TEXT_KD01]) {
      const parsed = parseCardText(card({ mainEffect: text }));
      expect(parsed.status).toBe('PARSED_READY');
      expect(parsed.continuousEffects).toEqual([
        { layer: 2, powerMod: 0, symbolMod: 'เทพ', targetCardType: 'Avatar', targetController: 'ANY' }
      ]);
    }
  });

  it('binds the activated ability: discard 1, opposing rested Avatar Cost <= 3, until end of turn', () => {
    const parsed = parseCardText(card());
    const activated = parsed.clauses.filter(clause => clause.timing.mode === 'ACTIVATED');
    expect(activated).toHaveLength(1);
    const clause = activated[0];
    expect(clause.timing.frequency).toBe('ONCE_PER_TURN');
    expect(clause.cost).toEqual({ kind: 'discard_from_hand', count: 1, selector: undefined });
    expect(clause.selector).toMatchObject({
      controller: 'opponent',
      cardTypes: ['Avatar'],
      zones: ['บนสนาม'],
      cost: { comparison: 'at_most', value: 3 },
      rested: true
    });
    expect(clause.effects).toEqual([{ kind: 'change_control', target: 'selected_avatar', duration: 'END_OF_TURN' }]);
    expect(clause.unresolved).toEqual([]);
  });
});

describe('Phase 8.1 — Asgard continuous Symbol effect in Game State', () => {
  it('changes every Avatar on both Avatar Zones to {เทพ} without mutating printed Symbols', () => {
    const state = placeAsgard(makeState());
    state.players.p1.avatarZone.push(instance('p1-av', 'p1', avatarCard('กุ่ย', 'มนุษย์', 2)));
    state.players.p2.avatarZone.push(instance('p2-av', 'p2', avatarCard('ยักษ์ใหญ่', 'ยักษ์', 3)));
    const next = recomputeContinuousEffects(state);
    expect(calculateEffectiveSymbol(next.players.p1.avatarZone[0])).toBe('เทพ');
    expect(calculateEffectiveSymbol(next.players.p2.avatarZone[0])).toBe('เทพ');
    // Printed Symbols are preserved on the underlying card data.
    expect(next.players.p1.avatarZone[0].card.symbol).toBe('มนุษย์');
    expect(next.players.p2.avatarZone[0].card.symbol).toBe('ยักษ์');
  });

  it('overrides Layer 1 equipment Symbol changes per Rule Book 3.2 p.17 Ex.1', () => {
    const state = placeAsgard(makeState());
    const guay = instance('p1-av', 'p1', avatarCard('กุ่ย', 'มนุษย์', 2));
    const modification = instance('mod-1', 'p1', card({
      printId: 'MOD-1', name: 'มนุษย์ดัดแปลง', type: 'Magic', subtype: 'Modification',
      mainEffect: 'เปลี่ยน Symbol เป็น เครื่องจักร'
    }));
    guay.attachedInstances.push(modification);
    state.players.p1.avatarZone.push(guay);
    const next = recomputeContinuousEffects(state);
    // Layer 1 (equipment) says เครื่องจักร, Layer 2 (Asgard) overrides it to เทพ.
    expect(calculateEffectiveSymbol(next.players.p1.avatarZone[0])).toBe('เทพ');
  });

  it('affects Avatars that enter the zone later and stops affecting Avatars that leave', () => {
    let state = placeAsgard(makeState());
    state.players.p1.avatarZone.push(instance('p1-av', 'p1', avatarCard('กุ่ย', 'มนุษย์', 2)));
    state = recomputeContinuousEffects(state);
    // A new Avatar enters the Avatar Zone.
    state = {
      ...state,
      players: {
        ...state.players,
        p2: { ...state.players.p2, avatarZone: [instance('p2-new', 'p2', avatarCard('ใหม่', 'สัตว์', 1))] }
      }
    };
    state = recomputeContinuousEffects(state);
    expect(calculateEffectiveSymbol(state.players.p2.avatarZone[0])).toBe('เทพ');
    // The Avatar leaves every Avatar Zone (moved to hand).
    state = {
      ...state,
      players: {
        ...state.players,
        p2: { ...state.players.p2, avatarZone: [], hand: [instance('p2-new', 'p2', avatarCard('ใหม่', 'สัตว์', 1))] }
      }
    };
    state = recomputeContinuousEffects(state);
    expect(calculateEffectiveSymbol(state.players.p2.hand[0])).toBe('สัตว์');
  });

  it('restores the effective Symbol when the Land Magic leaves the zone', () => {
    let state = placeAsgard(makeState());
    state.players.p1.avatarZone.push(instance('p1-av', 'p1', avatarCard('กุ่ย', 'มนุษย์', 2)));
    state = recomputeContinuousEffects(state);
    expect(calculateEffectiveSymbol(state.players.p1.avatarZone[0])).toBe('เทพ');
    state = { ...state, landMagicZone: null };
    state = recomputeContinuousEffects(state);
    expect(calculateEffectiveSymbol(state.players.p1.avatarZone[0])).toBe('มนุษย์');
  });
});

describe('Phase 8.1 — Asgard activated control-change ability', () => {
  function abilityState(): GameState {
    const state = placeAsgard(makeState());
    state.players.p1.hand.push(instance('p1-cost', 'p1', card({ printId: 'HAND-1', name: 'Cost Card', type: 'Magic', subtype: 'Normal', mainEffect: '' })));
    state.players.p2.avatarZone.push(
      instance('p2-valid', 'p2', avatarCard('เป้าถูก', 'สัตว์', 2), { isRested: true }),
      instance('p2-expensive', 'p2', avatarCard('เป้าแพง', 'สัตว์', 4), { isRested: true }),
      instance('p2-awake', 'p2', avatarCard('เป้าตื่น', 'สัตว์', 2))
    );
    state.players.p1.avatarZone.push(instance('p1-own', 'p1', avatarCard('ของเรา', 'เทพ', 2), { isRested: true }));
    return state;
  }

  it('steals a valid rested Cost<=3 opposing Avatar, keeps it Resting, and pays the discard cost', () => {
    const state = abilityState();
    const result = activateRegisteredCardTextAbility(state, 'asgard-land', 0, {
      costInstanceIds: ['p1-cost'],
      targetInstanceIds: ['p2-valid']
    });
    expect(result.ok).toBe(true);
    const next = result.state;
    const stolen = next.players.p1.avatarZone.find(item => item.instanceId === 'p2-valid');
    expect(stolen).toBeDefined();
    expect(stolen?.controllerId).toBe('p1');
    expect(stolen?.isRested).toBe(true);
    expect(next.players.p2.avatarZone.some(item => item.instanceId === 'p2-valid')).toBe(false);
    expect(next.players.p1.hand.some(item => item.instanceId === 'p1-cost')).toBe(false);
    expect(next.players.p1.hell.some(item => item.instanceId === 'p1-cost')).toBe(true);
    expect(next.temporaryControlChanges).toEqual([{
      instanceId: 'p2-valid',
      previousControllerId: 'p2',
      temporaryControllerId: 'p1',
      turnNumber: 1
    }]);
  });

  it('rejects Cost > 3 targets, standing targets, own Avatars, and missing cost payment', () => {
    const state = abilityState();
    for (const targetId of ['p2-expensive', 'p2-awake', 'p1-own']) {
      const result = activateRegisteredCardTextAbility(state, 'asgard-land', 0, {
        costInstanceIds: ['p1-cost'],
        targetInstanceIds: [targetId]
      });
      expect(result.ok).toBe(false);
      // Nothing changed: the discard cost is not paid on a rejected activation.
      expect(result.state.players.p1.hand.some(item => item.instanceId === 'p1-cost')).toBe(true);
    }
    const noCost = activateRegisteredCardTextAbility(state, 'asgard-land', 0, {
      costInstanceIds: [],
      targetInstanceIds: ['p2-valid']
    });
    expect(noCost.ok).toBe(false);
  });

  it('cannot be activated twice in one turn but is available again next turn', () => {
    let state = abilityState();
    const first = activateRegisteredCardTextAbility(state, 'asgard-land', 0, {
      costInstanceIds: ['p1-cost'],
      targetInstanceIds: ['p2-valid']
    });
    expect(first.ok).toBe(true);
    state = first.state;
    state.players.p1.hand.push(instance('p1-cost-2', 'p1', card({ printId: 'HAND-2', name: 'Cost Card 2', type: 'Magic', subtype: 'Normal', mainEffect: '' })));
    const second = activateRegisteredCardTextAbility(state, 'asgard-land', 0, {
      costInstanceIds: ['p1-cost-2'],
      targetInstanceIds: ['p2-expensive']
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('already been used this turn');
    // Next turn the usage key no longer matches.
    state = { ...state, turnNumber: 2 };
    const nextTurn = activateRegisteredCardTextAbility(state, 'asgard-land', 0, {
      costInstanceIds: ['p1-cost-2'],
      targetInstanceIds: ['p2-expensive']
    });
    expect(nextTurn.ok).toBe(false); // Cost 4 is still illegal — but the once-per-turn gate is gone.
    expect(nextTurn.reason).not.toContain('already been used this turn');
  });

  it('restores the previous controller at the End Phase of the same turn', () => {
    let state = abilityState();
    const first = activateRegisteredCardTextAbility(state, 'asgard-land', 0, {
      costInstanceIds: ['p1-cost'],
      targetInstanceIds: ['p2-valid']
    });
    expect(first.ok).toBe(true);
    state = transitionGamePhase(first.state, 'p1', 'END');
    state = finishEndPhaseTurn(state);
    const restored = state.players.p2.avatarZone.find(item => item.instanceId === 'p2-valid');
    expect(restored).toBeDefined();
    expect(restored?.controllerId).toBe('p2');
    expect(restored?.isRested).toBe(true);
    expect(state.temporaryControlChanges ?? []).toHaveLength(0);
  });

  it('does not restore an Avatar that left the field before the End Phase', () => {
    let state = abilityState();
    const first = activateRegisteredCardTextAbility(state, 'asgard-land', 0, {
      costInstanceIds: ['p1-cost'],
      targetInstanceIds: ['p2-valid']
    });
    expect(first.ok).toBe(true);
    state = first.state;
    // The stolen Avatar is destroyed and sent to its original owner's Hell.
    state = {
      ...state,
      players: {
        ...state.players,
        p1: {
          ...state.players.p1,
          avatarZone: state.players.p1.avatarZone.filter(item => item.instanceId !== 'p2-valid'),
          hell: [...state.players.p1.hell, instance('p2-valid', 'p2', avatarCard('เป้าถูก', 'สัตว์', 2), { isRested: true })]
        }
      }
    };
    state = transitionGamePhase(state, 'p1', 'END');
    state = finishEndPhaseTurn(state);
    expect(state.players.p2.avatarZone.some(item => item.instanceId === 'p2-valid')).toBe(false);
    expect(state.players.p1.hell.some(item => item.instanceId === 'p2-valid')).toBe(true);
  });
});

describe('Phase 8.1 — Manual Resolver primitives', () => {
  it('MANUAL_SET_SYMBOL changes the effective Symbol and END_OF_TURN expires at the End Phase', () => {
    const state = makeState();
    state.players.p1.avatarZone.push(instance('p1-av', 'p1', avatarCard('กุ่ย', 'มนุษย์', 2)));
    const begun = beginManualOverrideQueue(state, 'p1', [{
      kind: 'MANUAL_SET_SYMBOL', instanceId: 'p1-av', symbol: 'เทพ', duration: 'END_OF_TURN'
    }], { cardName: 'Manual Symbol', cardStatus: 'UNSUPPORTED' }, 'cmd-symbol-1');
    expect(begun.ok).toBe(true);
    // Nothing is applied before the opponent confirms.
    expect(calculateEffectiveSymbol(begun.state.players.p1.avatarZone[0])).toBe('มนุษย์');
    const approved = approveManualOverride(begun.state, 'p2');
    expect(approved.ok).toBe(true);
    expect(calculateEffectiveSymbol(approved.state.players.p1.avatarZone[0])).toBe('เทพ');
    expect(approved.state.players.p1.avatarZone[0].card.symbol).toBe('มนุษย์');
    let ended = transitionGamePhase(approved.state, 'p1', 'END');
    ended = finishEndPhaseTurn(ended);
    expect(calculateEffectiveSymbol(ended.players.p1.avatarZone[0])).toBe('มนุษย์');
  });

  it('MANUAL_CHANGE_CONTROL_TEMPORARY transfers control and restores it at the End Phase', () => {
    const state = makeState();
    state.players.p2.avatarZone.push(instance('p2-av', 'p2', avatarCard('เป้า', 'สัตว์', 2), { isRested: true }));
    const begun = beginManualOverrideQueue(state, 'p1', [{
      kind: 'MANUAL_CHANGE_CONTROL_TEMPORARY', instanceId: 'p2-av', newControllerId: 'p1'
    }], { cardName: 'Manual Control', cardStatus: 'UNSUPPORTED' }, 'cmd-control-1');
    expect(begun.ok).toBe(true);
    const approved = approveManualOverride(begun.state, 'p2');
    expect(approved.ok).toBe(true);
    const stolen = approved.state.players.p1.avatarZone.find(item => item.instanceId === 'p2-av');
    expect(stolen?.controllerId).toBe('p1');
    expect(stolen?.isRested).toBe(true);
    let ended = transitionGamePhase(approved.state, 'p1', 'END');
    ended = finishEndPhaseTurn(ended);
    expect(ended.players.p2.avatarZone.some(item => item.instanceId === 'p2-av')).toBe(true);
    expect(ended.players.p2.avatarZone.find(item => item.instanceId === 'p2-av')?.controllerId).toBe('p2');
  });

  it('MANUAL_ACTIVATE_ABILITY runs the engine pipeline through opponent confirmation', () => {
    const state = placeAsgard(abilityStateForManual());
    const begun = beginManualOverrideQueue(state, 'p1', [{
      kind: 'MANUAL_ACTIVATE_ABILITY',
      sourceInstanceId: 'asgard-land',
      abilityIndex: 0,
      costInstanceIds: ['p1-cost'],
      targetInstanceIds: ['p2-valid']
    }], { cardInstanceId: 'asgard-land', cardName: 'แอสการ์ดคือสถานที่ไม่ใช่ผู้คน', cardStatus: 'UNSUPPORTED' }, 'cmd-ability-1');
    expect(begun.ok).toBe(true);
    expect(begun.state.pendingManualOverride?.action.kind).toBe('MANUAL_ACTIVATE_ABILITY');
    expect(isManualOverrideCommandCurrent(begun.state, {
      kind: 'APPROVE_MANUAL_OVERRIDE',
      playerId: 'p2',
      expectedRevision: begun.state.pendingManualOverride!.expectedRevision,
      commandId: 'approve-1'
    }, 'p2')).toBe(true);
    const approved = approveManualOverride(begun.state, 'p2');
    expect(approved.ok).toBe(true);
    expect(approved.state.players.p1.avatarZone.some(item => item.instanceId === 'p2-valid')).toBe(true);
    expect(approved.state.players.p1.hell.some(item => item.instanceId === 'p1-cost')).toBe(true);
    // The engine recorded the once-per-turn usage.
    expect(approved.state.triggerUsage?.some(key => key.includes('asgard-land:card-text:0'))).toBe(true);
  });

  it('rejects invalid ability staging and enforces All-or-Nothing on application failure', () => {
    const state = placeAsgard(abilityStateForManual());
    const badIndex = beginManualOverrideQueue(state, 'p1', [{
      kind: 'MANUAL_ACTIVATE_ABILITY', sourceInstanceId: 'asgard-land', abilityIndex: 5,
      costInstanceIds: [], targetInstanceIds: []
    }], undefined, 'cmd-bad-index');
    expect(badIndex.ok).toBe(false);
    const badCost = beginManualOverrideQueue(state, 'p1', [{
      kind: 'MANUAL_ACTIVATE_ABILITY', sourceInstanceId: 'asgard-land', abilityIndex: 0,
      costInstanceIds: ['not-in-hand'], targetInstanceIds: ['p2-valid']
    }], undefined, 'cmd-bad-cost');
    expect(badCost.ok).toBe(false);
    // All-or-Nothing: a queue whose ability step fails at application cancels everything.
    const queue = beginManualOverrideQueue(state, 'p1', [
      { kind: 'DISCARD_CARD', instanceId: 'p1-cost' },
      { kind: 'MANUAL_ACTIVATE_ABILITY', sourceInstanceId: 'asgard-land', abilityIndex: 0,
        costInstanceIds: ['p1-cost'], targetInstanceIds: ['p2-expensive'] }
    ], undefined, 'cmd-queue-1');
    expect(queue.ok).toBe(true);
    const approved = approveManualOverride(queue.state, 'p2');
    expect(approved.ok).toBe(true);
    // The discard was rolled back with the failed ability step.
    expect(approved.state.players.p1.hand.some(item => item.instanceId === 'p1-cost')).toBe(true);
    expect(approved.state.players.p1.hell.some(item => item.instanceId === 'p1-cost')).toBe(false);
    expect(approved.state.pendingManualOverride).toBeUndefined();
  });

  it('rejects a rejected override and logs both outcomes', () => {
    const state = makeState();
    state.players.p1.avatarZone.push(instance('p1-av', 'p1', avatarCard('กุ่ย', 'มนุษย์', 2)));
    const begun = beginManualOverrideQueue(state, 'p1', [{
      kind: 'MANUAL_SET_SYMBOL', instanceId: 'p1-av', symbol: 'เทพ', duration: 'PERMANENT'
    }], undefined, 'cmd-reject-1');
    expect(begun.ok).toBe(true);
    const rejected = rejectManualOverride(begun.state, 'p2');
    expect(rejected.ok).toBe(true);
    expect(rejected.state.pendingManualOverride).toBeUndefined();
    expect(calculateEffectiveSymbol(rejected.state.players.p1.avatarZone[0])).toBe('มนุษย์');
    expect(rejected.state.eventLog.some(entry => entry.description.includes('ปฏิเสธ'))).toBe(true);
  });

  it('describes the new primitives in Thai for the Match Action Log', () => {
    const state = makeState();
    state.players.p2.avatarZone.push(instance('p2-av', 'p2', avatarCard('เป้า', 'สัตว์', 2)));
    expect(describeManualOverrideAction(state, { kind: 'MANUAL_SET_SYMBOL', instanceId: 'p2-av', symbol: 'เทพ', duration: 'END_OF_TURN' }))
      .toContain('เปลี่ยน Symbol');
    expect(describeManualOverrideAction(state, { kind: 'MANUAL_CHANGE_CONTROL_TEMPORARY', instanceId: 'p2-av', newControllerId: 'p1' }))
      .toContain('จนจบเทิร์น');
    expect(describeManualOverrideAction(state, {
      kind: 'MANUAL_ACTIVATE_ABILITY', sourceInstanceId: 'p2-av', abilityIndex: 0,
      costInstanceIds: [], targetInstanceIds: []
    })).toContain('สั่งใช้ความสามารถ');
  });
});

function abilityStateForManual(): GameState {
  const state = makeState();
  state.players.p1.hand.push(instance('p1-cost', 'p1', card({ printId: 'HAND-1', name: 'Cost Card', type: 'Magic', subtype: 'Normal', mainEffect: '' })));
  state.players.p2.avatarZone.push(
    instance('p2-valid', 'p2', avatarCard('เป้าถูก', 'สัตว์', 2), { isRested: true }),
    instance('p2-expensive', 'p2', avatarCard('เป้าแพง', 'สัตว์', 4), { isRested: true })
  );
  return state;
}
