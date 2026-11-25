import { describe, it, expect } from 'vitest';
import {
  parseCardAbility,
  avatarHasKeyword,
  recomputeContinuousAuras,
  executeCardAbility,
  clearEndOfTurnModifiers
} from '../src/engine/abilityEngine';
import { calculateNetPower } from '../src/engine/layers';
import { Card, CardInstance, GameState } from '../src/engine/types';

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    printId: 'TEST-001',
    name: 'Test Card',
    type: 'Avatar',
    subtype: null,
    soi: 1,
    cost: 1,
    gem: 1,
    power: 2,
    color: 'แดง',
    rarity: 'C',
    isOnlyOne: false,
    isBias: false,
    isCollab: false,
    mainEffect: '',
    imageUrl: '',
    ...overrides
  };
}

function makeInstance(card: Card, ownerId = 'p1', instanceId = 'inst-1'): CardInstance {
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

describe('Ability Engine', () => {
  it('parses จุติ, draw count, power mods, and keywords accurately', () => {
    const ishvara = makeCard({
      name: 'พระอิศวร',
      mainEffect: 'จุติ (เมื่อ Avatar ตัวนี้ถูกอัญเชิญลงสนามแบบจ่าย Cost) : เลือก Avatar 1 ใบ POWER -4 จนจบเทิร์น'
    });
    const parsed = parseCardAbility(ishvara);
    expect(parsed.hasJuti).toBe(true);
    expect(parsed.powerMod).toBe(-4);
    expect(parsed.needsTargetAvatar).toBe(true);
    expect(parsed.targetScope).toBe('ANY_AVATAR');

    const wife = makeCard({
      name: 'เมียพระอิศวร',
      mainEffect: 'จุติ (เมื่อ Avatar ตัวนี้ถูกอัญเชิญลงสนามแบบจ่าย Cost) : จั่วการ์ด 3 ใบ'
    });
    expect(parseCardAbility(wife).drawCount).toBe(3);
  });

  it('recognizes keywords granted by attached Modification Magic', () => {
    const avatar = makeInstance(makeCard({ name: 'กุ่ย', mainEffect: '' }));
    const modMagic = makeInstance(
      makeCard({
        name: 'ไม้เกาหลัง',
        type: 'Magic',
        subtype: 'Modification',
        mainEffect: 'Avatar ที่สวมใส่การ์ดใบนี้ได้รับความสามารถ เตะไข่'
      }),
      'p1',
      'mod-1'
    );
    avatar.attachedInstances.push(modMagic);
    expect(avatarHasKeyword(avatar, 'เตะไข่')).toBe(true);
  });

  it('recomputes Layer 1 Modification Magic & Layer 2 Land Magic + Continuous auras', () => {
    const godAvatar = makeInstance(
      makeCard({ name: 'พระนารายณ์', power: 4, symbol: 'เทพ' }),
      'p1',
      'av-1'
    );
    const nontok = makeInstance(
      makeCard({
        name: 'นนทก',
        power: 1,
        mainEffect: 'ต่อเนื่อง ตราบเท่าที่ Avatar ใบนี้อยู่บน Avatar Zone POWER +1 ให้ Avatar {symbol เทพ} ทุกใบบน Avatar Zone ฝ่ายเรา'
      }),
      'p1',
      'av-2'
    );
    const redDrink = makeInstance(
      makeCard({
        name: 'น้ำแดง',
        type: 'Magic',
        subtype: 'Modification',
        mainEffect: 'Avatar ที่สวมใส่การ์ดใบนี้ POWER +1'
      }),
      'p1',
      'mod-1'
    );
    godAvatar.attachedInstances.push(redDrink);

    const kailash = makeInstance(
      makeCard({
        name: 'เขาไกรลาส',
        type: 'Magic',
        subtype: 'Land',
        mainEffect: 'POWER +1 ให้ Avatar {symbol เทพ} บนสนามทุกใบ'
      }),
      'p1',
      'land-1'
    );

    const state: GameState = {
      id: 'g1',
      mode: 'DUEL',
      playerOrder: ['p1', 'p2'],
      currentTurnPlayerIndex: 0,
      currentPhase: 'MAIN',
      turnNumber: 1,
      roundNumber: 1,
      landMagicZone: kailash,
      players: {
        p1: {
          id: 'p1',
          name: 'P1',
          seat: 0,
          deck: [],
          hand: [],
          lifeDeck: [],
          avatarZone: [godAvatar, nontok],
          constructZone: [],
          magicZone: [],
          hell: [],
          darkDimension: [],
          isCritical: false,
          reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 },
          usedMagicTypesThisTurn: new Set()
        },
        p2: {
          id: 'p2',
          name: 'P2',
          seat: 1,
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
        }
      },
      eventLog: []
    };

    const updated = recomputeContinuousAuras(state);
    const updatedGod = updated.players.p1.avatarZone.find(a => a.instanceId === 'av-1')!;
    // Base 4 + น้ำแดง (+1) + นนทก (+1) + เขาไกรลาส (+1) = 7
    expect(calculateNetPower(updatedGod)).toBe(7);
  });

  it('executes จุติ draw, targeted POWER mod, and clears temporary modifiers at End of Turn', () => {
    const deckCards = [
      makeInstance(makeCard({ name: 'Draw 1' }), 'p1', 'd1'),
      makeInstance(makeCard({ name: 'Draw 2' }), 'p1', 'd2'),
      makeInstance(makeCard({ name: 'Draw 3' }), 'p1', 'd3')
    ];
    const wife = makeInstance(
      makeCard({
        name: 'เมียพระอิศวร',
        mainEffect: 'จุติ (เมื่อ Avatar ตัวนี้ถูกอัญเชิญลงสนามแบบจ่าย Cost) : จั่วการ์ด 3 ใบ'
      }),
      'p1',
      'av-wife'
    );
    const oppAvatar = makeInstance(
      makeCard({ name: 'Enemy', power: 5 }),
      'p2',
      'opp-1'
    );
    const ishvara = makeInstance(
      makeCard({
        name: 'พระอิศวร',
        mainEffect: 'จุติ (เมื่อ Avatar ตัวนี้ถูกอัญเชิญลงสนามแบบจ่าย Cost) : เลือก Avatar 1 ใบ POWER -4 จนจบเทิร์น'
      }),
      'p1',
      'av-ish'
    );

    const state: GameState = {
      id: 'g2',
      mode: 'DUEL',
      playerOrder: ['p1', 'p2'],
      currentTurnPlayerIndex: 0,
      currentPhase: 'MAIN',
      turnNumber: 1,
      roundNumber: 1,
      landMagicZone: null,
      players: {
        p1: {
          id: 'p1',
          name: 'P1',
          seat: 0,
          deck: deckCards,
          hand: [],
          lifeDeck: [],
          avatarZone: [wife, ishvara],
          constructZone: [],
          magicZone: [],
          hell: [],
          darkDimension: [],
          isCritical: false,
          reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 },
          usedMagicTypesThisTurn: new Set()
        },
        p2: {
          id: 'p2',
          name: 'P2',
          seat: 1,
          deck: [],
          hand: [],
          lifeDeck: [],
          avatarZone: [oppAvatar],
          constructZone: [],
          magicZone: [],
          hell: [],
          darkDimension: [],
          isCritical: false,
          reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 },
          usedMagicTypesThisTurn: new Set()
        }
      },
      eventLog: []
    };

    const res1 = executeCardAbility(state, 'p1', wife, 'SUMMON_JUTI');
    expect(res1.state.players.p1.hand.length).toBe(3);
    expect(res1.state.players.p1.deck.length).toBe(0);

    const res2 = executeCardAbility(res1.state, 'p1', ishvara, 'SUMMON_JUTI', 'opp-1');
    const debuffedOpp = res2.state.players.p2.avatarZone[0];
    expect(calculateNetPower(debuffedOpp)).toBe(1);

    const endTurnState = clearEndOfTurnModifiers(res2.state);
    expect(calculateNetPower(endTurnState.players.p2.avatarZone[0])).toBe(5);
  });
});
