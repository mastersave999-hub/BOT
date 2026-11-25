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
import cardCatalog from '../cards_clean.json';

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
  it('audits and parses every checked-in card record and resolves a real catalog ability', () => {
    expect(cardCatalog).toHaveLength(2014);
    const parsedCatalog = (cardCatalog as Card[]).map(card => parseCardAbility(card));
    expect(parsedCatalog).toHaveLength(2014);

    const ishvara = (cardCatalog as Card[]).find(card => card.printId === 'SD01-001')!;
    const source = makeInstance(ishvara, 'p1', 'real-ishvara');
    const target = makeInstance(makeCard({ name: 'Actual target', power: 6 }), 'p2', 'actual-target');
    const p1 = { id: 'p1', name: 'P1', seat: 0, deck: [], hand: [], lifeDeck: [], avatarZone: [source], constructZone: [], magicZone: [], hell: [], darkDimension: [], isCritical: false, reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 }, usedMagicTypesThisTurn: new Set() };
    const p2 = { ...p1, id: 'p2', name: 'P2', seat: 1, avatarZone: [target] };
    const state: GameState = { id: 'catalog-card', mode: 'DUEL', playerOrder: ['p1', 'p2'], currentTurnPlayerIndex: 0, currentPhase: 'MAIN', turnNumber: 1, roundNumber: 1, landMagicZone: null, players: { p1, p2 }, eventLog: [] };

    const result = executeCardAbility(state, 'p1', source, 'SUMMON_JUTI', 'actual-target');
    expect(calculateNetPower(result.state.players.p2.avatarZone[0])).toBe(2);
  });

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

  it('does not execute an ability before its printed trigger, and resolves Last Words at the correct timing', () => {
    const source = makeInstance(makeCard({
      mainEffect: 'คำสั่งเสีย : จั่วการ์ด 1 ใบ'
    }), 'p1', 'last-words');
    const deck = [makeInstance(makeCard({ name: 'Draw target' }), 'p1', 'deck-1')];
    const state: GameState = {
      id: 'trigger-check', mode: 'DUEL', playerOrder: ['p1', 'p2'],
      currentTurnPlayerIndex: 0, currentPhase: 'MAIN', turnNumber: 1, roundNumber: 1,
      landMagicZone: null,
      players: {
        p1: { id: 'p1', name: 'P1', seat: 0, deck, hand: [], lifeDeck: [], avatarZone: [], constructZone: [], magicZone: [], hell: [], darkDimension: [], isCritical: false, reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 }, usedMagicTypesThisTurn: new Set() },
        p2: { id: 'p2', name: 'P2', seat: 1, deck: [], hand: [], lifeDeck: [], avatarZone: [], constructZone: [], magicZone: [], hell: [], darkDimension: [], isCritical: false, reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 }, usedMagicTypesThisTurn: new Set() }
      }, eventLog: []
    };

    const premature = executeCardAbility(state, 'p1', source, 'SUMMON_JUTI');
    expect(premature.state.players.p1.hand).toHaveLength(0);
    expect(premature.state.players.p1.deck).toHaveLength(1);
    const resolved = executeCardAbility(state, 'p1', source, 'LAST_WORDS');
    expect(resolved.state.players.p1.hand).toHaveLength(1);
    expect(resolved.state.players.p1.deck).toHaveLength(0);
  });

  it('rejects missing or illegal targets without partial state changes', () => {
    const source = makeInstance(makeCard({
      mainEffect: 'จุติ : เลือก Avatar ฝ่ายตรงข้าม 1 ใบ POWER -2'
    }), 'p1', 'source');
    const opponent = makeInstance(makeCard({ name: 'Opponent', power: 4 }), 'p2', 'opponent');
    const self = makeInstance(makeCard({ name: 'Self', power: 4 }), 'p1', 'self');
    const players = {
      p1: { id: 'p1', name: 'P1', seat: 0, deck: [], hand: [], lifeDeck: [], avatarZone: [source, self], constructZone: [], magicZone: [], hell: [], darkDimension: [], isCritical: false, reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 }, usedMagicTypesThisTurn: new Set() },
      p2: { id: 'p2', name: 'P2', seat: 1, deck: [], hand: [], lifeDeck: [], avatarZone: [opponent], constructZone: [], magicZone: [], hell: [], darkDimension: [], isCritical: false, reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 }, usedMagicTypesThisTurn: new Set() }
    } satisfies GameState['players'];
    const state: GameState = { id: 'target-check', mode: 'DUEL', playerOrder: ['p1', 'p2'], currentTurnPlayerIndex: 0, currentPhase: 'MAIN', turnNumber: 1, roundNumber: 1, landMagicZone: null, players, eventLog: [] };

    const missing = executeCardAbility(state, 'p1', source, 'SUMMON_JUTI');
    expect(missing.state.players.p2.avatarZone[0]).toBe(opponent);
    expect(missing.logs).toHaveLength(1);
    const illegal = executeCardAbility(state, 'p1', source, 'SUMMON_JUTI', 'self');
    expect(illegal.state.players.p1.avatarZone.find(card => card.instanceId === 'self')?.layerModifiers).toHaveLength(0);
    expect(illegal.state.players.p2.avatarZone[0]).toBe(opponent);
  });

  it('moves targeted and global destruction/bounce effects in actual player zones', () => {
    const target = makeInstance(makeCard({ name: 'Target' }), 'p2', 'target');
    target.attachedInstances = [makeInstance(makeCard({
      name: 'Attached modification', type: 'Magic', subtype: 'Modification'
    }), 'p2', 'attached-mod')];
    const source = makeInstance(makeCard({ mainEffect: 'จุติ : เลือก Avatar 1 ใบ ทำลาย Avatar ตัวนั้น' }), 'p1', 'destroy-source');
    const p1 = { id: 'p1', name: 'P1', seat: 0, deck: [], hand: [], lifeDeck: [], avatarZone: [source], constructZone: [], magicZone: [], hell: [], darkDimension: [], isCritical: false, reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 }, usedMagicTypesThisTurn: new Set() };
    const p2 = { ...p1, id: 'p2', name: 'P2', seat: 1, avatarZone: [target] };
    const state: GameState = { id: 'zone-effects', mode: 'DUEL', playerOrder: ['p1', 'p2'], currentTurnPlayerIndex: 0, currentPhase: 'MAIN', turnNumber: 1, roundNumber: 1, landMagicZone: null, players: { p1, p2 }, eventLog: [] };

    const destroyed = executeCardAbility(state, 'p1', source, 'SUMMON_JUTI', 'target');
    expect(destroyed.state.players.p2.avatarZone).toHaveLength(0);
    expect(destroyed.state.players.p2.hell.map(card => card.instanceId)).toEqual(expect.arrayContaining(['target', 'attached-mod']));

    const bounceSource = makeInstance(makeCard({ mainEffect: 'จุติ : เลือก Avatar 1 ใบ นำ Avatar ตัวนั้นกลับขึ้นมือ' }), 'p1', 'bounce-source');
    const bounced = executeCardAbility(state, 'p1', bounceSource, 'SUMMON_JUTI', 'target');
    expect(bounced.state.players.p2.avatarZone).toHaveLength(0);
    expect(bounced.state.players.p2.hand.map(card => card.instanceId)).toContain('target');
    expect(bounced.state.players.p2.hand.find(card => card.instanceId === 'target')?.attachedInstances).toHaveLength(0);
    expect(bounced.state.players.p2.hell.map(card => card.instanceId)).toContain('attached-mod');

    const globalSource = makeInstance(makeCard({ mainEffect: 'จุติ : ทำลาย Avatar ทุกใบบนสนามฝ่ายตรงข้าม' }), 'p1', 'global-source');
    const globallyDestroyed = executeCardAbility(state, 'p1', globalSource, 'SUMMON_JUTI');
    expect(globallyDestroyed.state.players.p2.avatarZone).toHaveLength(0);
    expect(globallyDestroyed.state.players.p2.hell.map(card => card.instanceId)).toEqual(expect.arrayContaining(['target', 'attached-mod']));
  });

  it('refuses an unsupported conditional instead of partially drawing', () => {
    const conditional = makeInstance(makeCard({
      mainEffect: 'จุติ : ถ้า Avatar Zone ฝ่ายเรามี Avatar ชื่อ "เงื่อนไข" จั่วการ์ด 1 ใบ'
    }), 'p1', 'conditional');
    const deck = [makeInstance(makeCard({ name: 'Do not draw' }), 'p1', 'deck-conditional')];
    const player = { id: 'p1', name: 'P1', seat: 0, deck, hand: [], lifeDeck: [], avatarZone: [conditional], constructZone: [], magicZone: [], hell: [], darkDimension: [], isCritical: false, reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 }, usedMagicTypesThisTurn: new Set() };
    const opponent = { ...player, id: 'p2', name: 'P2', seat: 1, deck: [], avatarZone: [] };
    const state: GameState = { id: 'atomic', mode: 'DUEL', playerOrder: ['p1', 'p2'], currentTurnPlayerIndex: 0, currentPhase: 'MAIN', turnNumber: 1, roundNumber: 1, landMagicZone: null, players: { p1: player, p2: opponent }, eventLog: [] };

    const result = executeCardAbility(state, 'p1', conditional, 'SUMMON_JUTI');
    expect(result.state.players.p1.hand).toHaveLength(0);
    expect(result.state.players.p1.deck).toHaveLength(1);
    expect(result.logs[0]).toContain('conditional requirements');
  });

  it('applies a self-controlled target update without overwriting it with stale actor state', () => {
    const source = makeInstance(makeCard({ mainEffect: 'จุติ : เลือก Avatar 1 ใบ POWER +2' }), 'p1', 'source');
    const target = makeInstance(makeCard({ name: 'Chosen self', power: 3 }), 'p1', 'target-self');
    const player = { id: 'p1', name: 'P1', seat: 0, deck: [], hand: [], lifeDeck: [], avatarZone: [source, target], constructZone: [], magicZone: [], hell: [], darkDimension: [], isCritical: false, reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 }, usedMagicTypesThisTurn: new Set() };
    const opponent = { ...player, id: 'p2', name: 'P2', seat: 1, avatarZone: [] };
    const state: GameState = { id: 'self-target', mode: 'DUEL', playerOrder: ['p1', 'p2'], currentTurnPlayerIndex: 0, currentPhase: 'MAIN', turnNumber: 1, roundNumber: 1, landMagicZone: null, players: { p1: player, p2: opponent }, eventLog: [] };

    const result = executeCardAbility(state, 'p1', source, 'SUMMON_JUTI', 'target-self');
    const resolvedTarget = result.state.players.p1.avatarZone.find(card => card.instanceId === 'target-self')!;
    expect(calculateNetPower(resolvedTarget)).toBe(5);
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
