import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Card, CardInstance, GameState, PlayerState } from '../src/engine/types';
import {
  executeCardAbility,
  getRuntimeExecutionBlockers,
} from '../src/engine/abilityEngine';
import { beginManualOverrideQueue, classifyCard, getLandMagicActivationPlan, shouldOfferManualResolution } from '../src/engine/hybridMode';
import { getColorlessGemInstanceIds, getEffectiveCost } from '../src/engine/gameRules';
import { canPayCost, validateGemPayment } from '../src/engine/gemPayment';
import { deriveLegalHandActions } from '../src/engine/legalActions';

const catalog = JSON.parse(readFileSync(new URL('../cards_clean.json', import.meta.url), 'utf8')) as Card[];

function instance(instanceId: string, playerId: string, card: Card, overrides: Partial<CardInstance> = {}): CardInstance {
  return {
    instanceId,
    card,
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

function vanillaAvatarCard(name: string, overrides: Partial<Card> = {}): Card {
  return {
    printId: `test-${name}`,
    name,
    type: 'Avatar',
    cost: 0,
    gem: 0,
    power: 3,
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

function makePlayer(id: string, seat: number): PlayerState {
  const player: PlayerState = {
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
  for (let index = 0; index < 6; index += 1) {
    player.deck.push(instance(`${id}-deck-${index}`, id, vanillaAvatarCard(`${id} Deck ${index}`), { isFaceUp: false }));
    player.lifeDeck.push(instance(`${id}-life-${index}`, id, { ...vanillaAvatarCard(`${id} LIFE ${index}`), type: 'Life' }, { isFaceUp: false }));
  }
  player.avatarZone.push(instance(`${id}-avatar-0`, id, vanillaAvatarCard(`${id} Avatar`)));
  return player;
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  return {
    id: 'hotfix-auto-effect',
    mode: 'DUEL',
    ruleMode: 'HYBRID',
    playerOrder: ['p1', 'p2'],
    currentTurnPlayerIndex: 0,
    currentPhase: 'MAIN',
    turnNumber: 1,
    roundNumber: 1,
    landMagicZone: null,
    eventLog: [],
    players: { p1: makePlayer('p1', 0), p2: makePlayer('p2', 1) },
    ...overrides
  };
}

/** A generous state so any verified Magic effect finds everything it needs to resolve. */
function makeGenerousCastState(): { state: GameState; opponentAvatarId: string } {
  const state = makeState();
  state.players.p1.hell.push(
    instance('hell-avatar-1', 'p1', vanillaAvatarCard('Hell Avatar 1')),
    instance('hell-avatar-2', 'p1', vanillaAvatarCard('Hell Avatar 2'))
  );
  const opponentAvatar = instance('opponent-avatar-1', 'p2', vanillaAvatarCard('Opponent Avatar'));
  state.players.p2.avatarZone = [opponentAvatar];
  return { state, opponentAvatarId: opponentAvatar.instanceId };
}

describe('hotfix: verified Magic effects execute at runtime', () => {
  it('casting "ความเจริญ" (BT01-038) draws exactly 2 cards from Deck to Hand', () => {
    const prosperity = catalog.find(card => card.printId === 'BT01-038');
    expect(prosperity).toBeDefined();
    expect(prosperity!.mainEffect).toBe('จั่วการ์ดจาก Deck เรา 2 ใบ');
    expect(classifyCard(prosperity!).status).toBe('VERIFIED_WORKING');

    const state = makeState();
    const prosperityInstance = instance('prosperity-1', 'p1', prosperity!);
    state.players.p1.hand = [prosperityInstance];
    const deckBefore = state.players.p1.deck.length;

    const result = executeCardAbility(state, 'p1', prosperityInstance, 'MAGIC_CAST');
    const logs = result.logs.join('\n');
    expect(logs).not.toContain('ยังไม่รองรับ');
    expect(logs).not.toContain('ยังไม่มีตัวจัดการ');
    expect(logs).toContain('จั่วการ์ด 2 ใบ');
    expect(result.state.players.p1.hand).toHaveLength(3);
    expect(result.state.players.p1.deck).toHaveLength(deckBefore - 2);
    // The drawn cards left the Deck and entered the Hand by instanceId.
    // (The engine-level cast keeps the cast card in hand; the play pipeline moves it first.)
    const handIds = new Set(result.state.players.p1.hand.map(card => card.instanceId));
    expect(handIds.has('prosperity-1')).toBe(true);
    expect(handIds.has('p1-deck-0')).toBe(true);
    expect(handIds.has('p1-deck-1')).toBe(true);
  });

  it('every draw-variant of "ความเจริญ" resolves its draw at runtime', () => {
    for (const printId of ['BT01-038', 'CC01-056', 'ODY1-068', 'PRMO-019', 'KD01-013', 'KD03-012', 'KD04-018', 'APFD-001', 'B2SA-008']) {
      const card = catalog.find(entry => entry.printId === printId);
      expect(card, printId).toBeDefined();
      expect(classifyCard(card!).status, printId).toBe('VERIFIED_WORKING');
      const { state } = makeGenerousCastState();
      const cardInstance = instance(`cast-${printId}`, 'p1', card!);
      state.players.p1.hand = [cardInstance];
      const handBefore = state.players.p1.hand.length;
      const result = executeCardAbility(state, 'p1', cardInstance, 'MAGIC_CAST');
      expect(result.logs.join('\n'), printId).not.toContain('ยังไม่มีตัวจัดการ');
      expect(result.state.players.p1.hand.length, printId).toBe(handBefore + 2);
    }
  });
});

describe('hotfix: "สภาแบงค์" (BT06-061) continuous Land Magic aura', () => {
  const bankCouncil = catalog.find(card => card.printId === 'BT06-061');

  it('classifies BT06-061 as VERIFIED_WORKING through its registered continuous hook', () => {
    expect(bankCouncil).toBeDefined();
    const classification = classifyCard(bankCouncil!);
    expect(classification.status).toBe('VERIFIED_WORKING');
    expect(classification.reason).toContain('BT06-061');
    expect(getLandMagicActivationPlan(bankCouncil!)).toBe('CONTINUOUS_HOOK');
  });

  it('playing it announces the live aura through the LAND_MAGIC trigger', () => {
    const state = makeState();
    const landInstance = instance('land-bank-1', 'p1', bankCouncil!);
    state.landMagicZone = landInstance;
    const result = executeCardAbility(state, 'p1', landInstance, 'LAND_MAGIC');
    expect(result.logs.join('\n')).toContain('ออราต่อเนื่อง');
    expect(result.logs.join('\n')).toContain('แบงค์');
  });

  it('reduces the summon Cost of any "แบงค์" Avatar in hand by 1 (minimum 0)', () => {
    const state = makeState();
    const costlyBank = instance('bank-costly', 'p1', vanillaAvatarCard('นักเรียน แบงค์', { cost: 2, gem: 1, color: 'น้ำเงิน' }));
    const cheapBank = instance('bank-cheap', 'p1', vanillaAvatarCard('เทวดาแบงค์', { cost: 1, gem: 1, color: 'แดง' }));
    const otherAvatar = instance('other-avatar', 'p1', vanillaAvatarCard('พระอิศวร', { cost: 3, gem: 1, color: 'แดง' }));
    state.players.p1.hand = [costlyBank, cheapBank, otherAvatar];

    // Without the Land Magic aura nothing changes.
    expect(getEffectiveCost(state, 'p1', costlyBank)).toBe(2);
    // With "สภาแบงค์" active: Cost -1 for every "แบงค์" Avatar, others untouched.
    state.landMagicZone = instance('land-bank-1', 'p1', bankCouncil!);
    expect(getEffectiveCost(state, 'p1', costlyBank)).toBe(1);
    expect(getEffectiveCost(state, 'p1', cheapBank)).toBe(0);
    expect(getEffectiveCost(state, 'p1', otherAvatar)).toBe(3);
  });

  it('treats the Gem of every "แบงค์" Avatar in hand as colorless (ไร้สี)', () => {
    const state = makeState();
    const blueBank = instance('bank-blue', 'p1', vanillaAvatarCard('นักเรียน แบงค์', { cost: 2, gem: 1, color: 'น้ำเงิน' }));
    const redBank = instance('bank-red', 'p1', vanillaAvatarCard('เทวดาแบงค์', { cost: 1, gem: 1, color: 'แดง' }));
    state.players.p1.hand = [blueBank, redBank];
    state.landMagicZone = instance('land-bank-1', 'p1', bankCouncil!);

    const colorless = getColorlessGemInstanceIds(state, 'p1', state.players.p1.hand);
    expect(colorless.has('bank-red')).toBe(true);
    expect(colorless.has('bank-blue')).toBe(true);

    // The red "แบงค์" Gem may pay for the blue Avatar only while the aura is active.
    expect(validateGemPayment(state.players.p1.hand, blueBank, ['bank-red'], 1, { colorlessGemInstanceIds: colorless }).valid).toBe(true);

    const noLand = { ...state, landMagicZone: null };
    expect(validateGemPayment(noLand.players.p1.hand, blueBank, ['bank-red'], 2).valid).toBe(false);
  });

  it('allows through deriveLegalHandActions a summon that would otherwise fail color/cost checks', () => {
    const state = makeState();
    const blueBank = instance('bank-blue', 'p1', vanillaAvatarCard('นักเรียน แบงค์', { cost: 2, gem: 1, color: 'น้ำเงิน' }));
    const redBank = instance('bank-red', 'p1', vanillaAvatarCard('เทวดาแบงค์', { cost: 1, gem: 1, color: 'แดง' }));
    state.players.p1.hand = [blueBank, redBank];

    // Without the aura: Cost 2 with only a mismatched red Gem — no SUMMON.
    expect(deriveLegalHandActions(state, 'p1', blueBank).map(action => action.kind)).toEqual([]);

    state.landMagicZone = instance('land-bank-1', 'p1', bankCouncil!);
    // With the aura: Cost 1 and a colorless Gem — the summon becomes legal.
    expect(deriveLegalHandActions(state, 'p1', blueBank).map(action => action.kind)).toEqual(['SUMMON']);
    expect(canPayCost(state.players.p1.hand, blueBank, 1, {
      colorlessGemInstanceIds: getColorlessGemInstanceIds(state, 'p1', state.players.p1.hand)
    })).toBe(true);
  });
});

describe('hotfix: strict AUTO classification audit', () => {
  it('every VERIFIED_WORKING card passes runtime execution verification', () => {
    const seen = new Set<string>();
    let autoCards = 0;
    let autoWithText = 0;
    for (const card of catalog) {
      if (seen.has(card.printId)) continue;
      seen.add(card.printId);
      if (classifyCard(card).status !== 'VERIFIED_WORKING') continue;
      autoCards += 1;
      if (!(card.mainEffect ?? '').trim()) continue; // vanilla: the play/summon action itself mutates state
      autoWithText += 1;
      expect(getRuntimeExecutionBlockers(card), `${card.printId} ${card.name}`).toEqual([]);
    }
    expect(autoCards).toBeGreaterThan(0);
    expect(autoWithText).toBeGreaterThan(0);
  });

  it('casting every AUTO Magic card produces a non-noop state change', () => {
    const seen = new Set<string>();
    for (const card of catalog) {
      if (seen.has(card.printId)) continue;
      seen.add(card.printId);
      if (card.type !== 'Magic' || (card.subtype !== 'Normal' && card.subtype !== 'React')) continue;
      if (classifyCard(card).status !== 'VERIFIED_WORKING') continue;
      const { state, opponentAvatarId } = makeGenerousCastState();
      const cardInstance = instance(`audit-${card.printId}`, 'p1', card);
      state.players.p1.hand = [cardInstance];
      const result = executeCardAbility(state, 'p1', cardInstance, 'MAGIC_CAST', opponentAvatarId);
      const logs = result.logs.join('\n');
      expect(logs, card.printId).not.toContain('ยังไม่รองรับ');
      expect(logs, card.printId).not.toContain('ยังไม่มีตัวจัดการ');
      expect(logs, card.printId).not.toContain('Effect Resolver ปฏิเสธ');
      expect(JSON.stringify(result.state), card.printId).not.toBe(JSON.stringify(state));
    }
  });

  it('demotes false-positive AUTO cards whose runtime handlers are missing', () => {
    const demotedPrintIds = ['SD01-018', 'BT08-048', 'ODY1-088', 'BT02-045', 'ODY1-086', 'KD01-014', 'BT08-050'];
    for (const printId of demotedPrintIds) {
      const card = catalog.find(entry => entry.printId === printId);
      expect(card, printId).toBeDefined();
      const classification = classifyCard(card!);
      expect(classification.status, `${printId}: ${classification.reason}`).toBe('UNSUPPORTED');
      expect(classification.reason).toContain('runtime execution not verified');
    }
  });
});

describe('hotfix: Land Magic manual fallback and the always-available escape hatch', () => {
  it('unmodeled Land Magic cards fall back to the Phase 8 Universal Manual Resolver', () => {
    const unsupportedLand = catalog.find(card =>
      card.type === 'Magic' && card.subtype === 'Land' && classifyCard(card).status !== 'VERIFIED_WORKING');
    expect(unsupportedLand).toBeDefined();
    expect(getLandMagicActivationPlan(unsupportedLand!)).toBe('MANUAL_FALLBACK');
    const classification = classifyCard(unsupportedLand!);
    expect(shouldOfferManualResolution(classification, [
      `ร่าย Land Magic "${unsupportedLand!.name}"`,
      `${unsupportedLand!.name}: ยังไม่มีตัวจัดการผลของความสามารถนี้ จึงไม่ทำผลใด ๆ`
    ])).toBe(true);
  });

  it('continuous Land Magic auras resolve through their registered hook, not the fallback', () => {
    const auraLand = catalog.find(card => card.printId === 'BT01-048');
    expect(auraLand).toBeDefined();
    expect(classifyCard(auraLand!).status).toBe('VERIFIED_WORKING');
    expect(getLandMagicActivationPlan(auraLand!)).toBe('CONTINUOUS_HOOK');
  });

  it('the Manual Override escape hatch works even for an AUTO card', () => {
    const autoCard = catalog.find(card => classifyCard(card).status === 'VERIFIED_WORKING');
    expect(autoCard).toBeDefined();
    const state = makeState();
    const begun = beginManualOverrideQueue(
      state,
      'p1',
      [{ kind: 'DRAW_CARD', playerId: 'p1' }],
      {
        cardInstanceId: 'escape-hatch',
        cardName: autoCard!.name,
        cardText: autoCard!.mainEffect,
        cardStatus: 'VERIFIED_WORKING'
      },
      'escape-hatch-cmd-1'
    );
    expect(begun.ok).toBe(true);
    expect(begun.state.pendingManualOverride?.context?.cardStatus).toBe('VERIFIED_WORKING');
  });
});
