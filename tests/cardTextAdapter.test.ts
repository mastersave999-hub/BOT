import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveEffectPlan } from '../src/engine/effectResolver';
import { createNameReference, matchesCardName, parseCardText, toCardTextEffectPlan, toEffectDefinitions, toEffectPlan, toTriggerAbility } from '../src/engine/cardTextAdapter';
import { calculateEffectiveSymbol, calculateNetPower } from '../src/engine/layers';
import { payCombatKeyword } from '../src/engine/combatKeywords';
import type { Card, CardInstance, GameState } from '../src/engine/types';

const catalog = JSON.parse(readFileSync(new URL('../cards_clean.json', import.meta.url), 'utf8')) as Card[];
const byPrintId = (printId: string) => {
  const card = catalog.find(item => item.printId === printId);
  if (!card) throw new Error(`Missing catalog card ${printId}`);
  return card;
};
const instance = (id: string, ownerId: string): CardInstance => ({
  instanceId: id, card: byPrintId('SD01-001'), ownerId, controllerId: ownerId,
  isRested: false, isFaceUp: true, attachedInstances: [], layerModifiers: []
});
function gameState(): GameState {
  const makePlayer = (id: string) => ({
    id, name: id, seat: id === 'p1' ? 0 : 1, deck: [instance(`${id}-deck`, id)],
    hand: [instance(`${id}-hand`, id)], lifeDeck: [], avatarZone: [instance(`${id}-avatar`, id)],
    constructZone: [], magicZone: [], hell: [], darkDimension: [], isCritical: false,
    reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 }, usedMagicTypesThisTurn: new Set()
  });
  return {
    id: 'adapter-integration', mode: 'DUEL', playerOrder: ['p1', 'p2'], currentTurnPlayerIndex: 0,
    currentPhase: 'MAIN', turnNumber: 1, roundNumber: 1, players: { p1: makePlayer('p1'), p2: makePlayer('p2') },
    landMagicZone: null, eventLog: []
  };
}

describe('Card Text Adapter — Rule Book 3.2', () => {
  it('preserves printed attributes and separates inherent # Rule Text from abilities', () => {
    const parsed = parseCardText(byPrintId('SD03-003'));
    expect(parsed.attributes.printId).toBe('SD03-003');
    expect(parsed.ruleTexts).toContain('การ์ดใบนี้ไม่สามารถลงสนามจากบนมือได้');
    expect(parsed.clauses.some(clause => clause.source.includes('ธรณีสูบ') && clause.effectText.includes('อัญเชิญ'))).toBe(true);
    expect(parsed.status).toBe('UNSUPPORTED');
    expect(parsed.reason).toContain('typed');
  });

  it('parses Cost : Effect into a selector-bearing typed cost and defers concrete payment binding', () => {
    const parsed = parseCardText(byPrintId('SD01-018'));
    const clause = parsed.clauses.find(item => item.costEffectSeparator === ':');
    expect(clause?.costText).toContain('ทิ้ง Avatar');
    expect(clause?.effectText).toContain('จั่วการ์ด 2 ใบ');
    expect(parsed.status).toBe('PARSED_READY');
    expect(clause?.cost).toMatchObject({ kind: 'discard_from_hand', count: 1, selector: { cardTypes: ['Avatar'], symbol: 'เทพ' } });
    expect(toEffectPlan(clause!, 'p1')).toBeNull();
  });

  it('parses and atomically executes real Cost : Effect text with a selector-checked payment', () => {
    const parsed = parseCardText(byPrintId('SD01-018'));
    expect(parsed.status).toBe('PARSED_READY');
    const clause = parsed.clauses[0];
    expect(clause.cost).toMatchObject({ kind: 'discard_from_hand', count: 1, selector: { cardTypes: ['Avatar'], symbol: 'เทพ' } });
    expect(clause.effects).toEqual([{ kind: 'draw_self', count: 2 }]);

    const initial = gameState();
    initial.players.p1.deck.push(instance('p1-deck-2', 'p1'));
    expect(toEffectPlan(clause, 'p1', ['p1-hand'], initial)).not.toBeNull();
    const result = resolveEffectPlan(initial, toEffectPlan(clause, 'p1', ['p1-hand'], initial)!);
    expect(result.ok).toBe(true);
    expect(result.state.players.p1.hand.map(card => card.instanceId)).toEqual(['p1-deck', 'p1-deck-2']);
    expect(result.state.players.p1.hell.map(card => card.instanceId)).toContain('p1-hand');
    expect(initial.players.p1.hand.map(card => card.instanceId)).toEqual(['p1-hand']);

    const invalid = toEffectPlan(clause, 'p1', ['p1-deck'], initial);
    expect(invalid).toBeNull();
    const incomplete = resolveEffectPlan(initial, {
      actorId: 'p1', costs: [{ kind: 'discard_from_hand', playerId: 'p1', instanceIds: ['missing-cost-card'] }],
      effects: [{ kind: 'draw', playerId: 'p1', count: 1 }]
    });
    expect(incomplete.ok).toBe(false);
    expect(incomplete.state).toBe(initial);
  });

  it('distinguishes quoted word-sequence references from unquoted exact names (p.13)', () => {
    const quoted = createNameReference('นาย', true);
    const exact = createNameReference('นาย', false);
    expect(quoted.kind).toBe('quoted-word');
    expect(exact.kind).toBe('exact-name');
    expect(matchesCardName('นาย ผู้เจริญนาย', quoted)).toBe(true);
    expect(matchesCardName('นายนิรยบาล', quoted)).toBe(false);
    expect(matchesCardName('นาย', exact)).toBe(true);
    expect(matchesCardName('นาย ผู้เจริญนาย', exact)).toBe(false);
  });

  it('preserves unsupported scouting while compiling standalone combat keywords as typed specs', () => {
    const parsed = parseCardText(byPrintId('SD04-001'));
    expect(parsed.clauses.flatMap(clause => clause.keywords)).toContain('สอดแนม');
    expect(parsed.clauses.flatMap(clause => clause.keywords)).toContain('เทิร์นละครั้ง');
    expect(parsed.status).toBe('UNSUPPORTED');
    for (const keyword of ['สามัคคี', 'โล่มนุษย์', 'เตะไข่', 'ลูกฮึด', 'แทงหลัง']) {
      const keywordCard = parseCardText({ ...byPrintId('SD01-001'), mainEffect: keyword });
      expect(keywordCard.status).toBe('PARSED_READY');
      expect(keywordCard.clauses[0].keywordSpecs).toContainEqual({ keyword, kind: 'COMBAT_KEYWORD' });
    }
    const duo = parseCardText({ ...byPrintId('SD01-001'), mainEffect: 'คู่หู - โลกิ เจ้าชายยักษ์น้ำแข็ง' });
    expect(duo.clauses[0].keywordSpecs).toContainEqual(expect.objectContaining({ keyword: 'คู่หู', kind: 'COMBAT_KEYWORD', partnerName: 'โลกิ เจ้าชายยักษ์น้ำแข็ง' }));
  });

  it('records quoted and unquoted name references with distinct matching modes', () => {
    const parsed = parseCardText({
      ...byPrintId('SD01-001'),
      mainEffect: 'นำ Avatar ชื่อ อาเธอร์ ราชาแห่งอัศวินโต๊ะกลม 1 ใบ และ Avatar ชื่อ "นาย" 1 ใบ จาก Deck ขึ้นมือ'
    });
    expect(parsed.clauses[0].exactNameReferences[0]).toMatchObject({ kind: 'exact-name', value: 'อาเธอร์ ราชาแห่งอัศวินโต๊ะกลม' });
    expect(parsed.clauses[0].quotedReferences[0]).toMatchObject({ kind: 'quoted-word', value: 'นาย' });
  });

  it('keeps the two Rule Book p.11 Magic-type statements semantically separate', () => {
    const base = byPrintId('SD01-001');
    const abilityUse = parseCardText({ ...base, mainEffect: 'สั่งใช้ ทิ้งการ์ด 1 ใบ : จั่วการ์ด 1 ใบ ความสามารถนี้ถือเป็นการใช้ Normal Magic' });
    const cardOverride = parseCardText({ ...base, mainEffect: 'สามารถใช้การ์ดใบนี้ใน Battle Phase โดยถือว่าเป็นการใช้ React Magic' });
    expect(abilityUse.magicUse.abilityConsumesMagicType).toBe('Normal');
    expect(abilityUse.magicUse.magicSubtypeOverride).toBeUndefined();
    expect(cardOverride.magicUse.magicSubtypeOverride).toBe('React');
    expect(cardOverride.magicUse.abilityConsumesMagicType).toBeUndefined();
  });

  it('converts an exact draw clause into a typed effect and resolves it atomically in Game State', () => {
    const parsed = parseCardText({ ...byPrintId('SD01-001'), mainEffect: 'จั่วการ์ดจาก Deck เรา 1 ใบ' });
    expect(parsed.status).toBe('PARSED_READY');
    expect(parsed.clauses[0].effects).toEqual([{ kind: 'draw_self', count: 1 }]);

    const initial = gameState();
    const result = resolveEffectPlan(initial, {
      actorId: 'p1', effects: toEffectDefinitions(parsed.clauses.flatMap(clause => clause.effects), 'p1')
    });
    expect(result.ok).toBe(true);
    expect(result.state.players.p1.hand.map(card => card.instanceId)).toEqual(['p1-hand', 'p1-deck']);
    expect(initial.players.p1.hand.map(card => card.instanceId)).toEqual(['p1-hand']);
  });

  it('compiles a real triggered Thai card into a typed timing/effect AST and resolves it deterministically', () => {
    const parsed = parseCardText(byPrintId('SD01-005'));
    expect(parsed.status).toBe('PARSED_READY');
    expect(parsed.clauses[0].timing).toMatchObject({ event: 'AVATAR_SUMMONED' });
    expect(parsed.clauses[0].effects).toEqual([{ kind: 'draw_self', count: 3 }]);
    const plan = toEffectPlan(parsed.clauses[0], 'p1');
    expect(plan?.effects).toEqual([{ kind: 'draw', playerId: 'p1', count: 3 }]);
    expect(toTriggerAbility(parsed.clauses[0], 'on-summon-draw', 'p1', { sourceInstanceId: 'p1-avatar' }))
      .toMatchObject({ id: 'on-summon-draw', eventType: 'AVATAR_SUMMONED', sourceInstanceId: 'p1-avatar', effects: plan?.effects });

    const initial = gameState();
    initial.players.p1.deck.push(instance('p1-deck-2', 'p1'), instance('p1-deck-3', 'p1'));
    const first = resolveEffectPlan(initial, plan!);
    const second = resolveEffectPlan(initial, plan!);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.state.players.p1.hand.map(card => card.instanceId)).toEqual(['p1-hand', 'p1-deck', 'p1-deck-2', 'p1-deck-3']);
    expect(second.state.players.p1.hand.map(card => card.instanceId)).toEqual(first.state.players.p1.hand.map(card => card.instanceId));
    expect(initial.players.p1.hand.map(card => card.instanceId)).toEqual(['p1-hand']);
  });

  it('does not expose partial typed effects when a later clause is unsupported', () => {
    const parsed = parseCardText({ ...byPrintId('SD01-001'), mainEffect: 'จั่วการ์ด 1 ใบ<br>เลือก Avatar 1 ใบ' });
    expect(parsed.status).toBe('UNSUPPORTED');
    expect(parsed.clauses.flatMap(clause => clause.effects)).toEqual([]);
    expect(parsed.clauses[1].unresolved.length).toBeGreaterThan(0);
  });

  it('fails closed for ambiguous clauses and retains a specific reason', () => {
    const parsed = parseCardText({ ...byPrintId('SD01-001'), mainEffect: 'ถ้าเงื่อนไขไม่ชัดเจน : เลือก Avatar 1 ใบ' });
    expect(parsed.status).toBe('AMBIGUOUS');
    expect(parsed.reason).toMatch(/ambiguous|condition parser|target legality/i);
  });

  it('compiles and atomically executes the real SD02-001 Juti tutor after binding the chosen Deck card', () => {
    const parsed = parseCardText(byPrintId('SD02-001'));
    expect(parsed.status).toBe('PARSED_READY');
    expect(parsed.clauses[0].keywordSpecs).toContainEqual(expect.objectContaining({ keyword: 'สามัคคี', kind: 'COMBAT_KEYWORD' }));
    expect(parsed.clauses[1].timing.event).toBe('AVATAR_SUMMONED');
    expect(parsed.clauses[1].effects).toEqual([expect.objectContaining({ kind: 'search_deck_to_hand', count: 1, shuffle: true })]);

    const initial = gameState();
    const hall = catalog.find(card => card.printId === 'SD02-002')!;
    initial.players.p1.deck.push({ ...instance('p1-hall', 'p1'), card: hall });
    const trigger = toTriggerAbility(parsed.clauses[1], 'juti-hall-search', 'p1', {
      sourceInstanceId: 'p1-avatar', targetInstanceIds: ['p1-hall'], state: initial
    });
    expect(trigger).toMatchObject({ eventType: 'AVATAR_SUMMONED', effects: [expect.objectContaining({ kind: 'search_to_hand' })] });
    expect(trigger).not.toHaveProperty('frequency');
    const plan = toCardTextEffectPlan(parsed, 'p1', [{ targetInstanceIds: ['p1-hall'] }], initial);
    expect(plan?.effects).toEqual([expect.objectContaining({ kind: 'search_to_hand', instanceIds: ['p1-hall'], name: 'ฮอล' })]);
    const result = resolveEffectPlan(initial, plan!);
    expect(result.ok).toBe(true);
    expect(result.state.players.p1.hand.map(card => card.instanceId)).toContain('p1-hall');
    expect(result.state.players.p1.deck.map(card => card.instanceId)).not.toContain('p1-hall');
    expect(result.state.gameEvents?.some(item => item.event.type === 'DECK_SHUFFLED')).toBe(true);
    expect(initial.players.p1.deck.map(card => card.instanceId)).toContain('p1-hall');
  });

  it('compiles compound effects in printed order and fails the full card closed if a later operation is unknown', () => {
    const compound = parseCardText({ ...byPrintId('SD01-001'), mainEffect: 'จั่วการ์ด 1 ใบ และ จั่วการ์ด 1 ใบ' });
    expect(compound.status).toBe('PARSED_READY');
    const plan = toCardTextEffectPlan(compound, 'p1');
    expect(plan?.effects).toEqual([
      { kind: 'draw', playerId: 'p1', count: 1 },
      { kind: 'draw', playerId: 'p1', count: 1 }
    ]);
    const initial = gameState();
    initial.players.p1.deck.push(instance('p1-deck-2', 'p1'));
    const resolved = resolveEffectPlan(initial, plan!);
    expect(resolved.ok).toBe(true);
    expect(resolved.state.players.p1.hand.map(card => card.instanceId)).toEqual(['p1-hand', 'p1-deck', 'p1-deck-2']);

    const unsupportedTail = parseCardText({ ...byPrintId('SD01-001'), mainEffect: 'จั่วการ์ด 1 ใบ และ เลือก Avatar 1 ใบ' });
    expect(unsupportedTail.status).toBe('UNSUPPORTED');
    expect(unsupportedTail.clauses.flatMap(clause => clause.effects)).toEqual([]);
    expect(toCardTextEffectPlan(unsupportedTail, 'p1')).toBeNull();
  });

  it('executes exact POWER addition and assignment durations as layer modifiers', () => {
    const initial = gameState();
    const add = parseCardText({ ...byPrintId('SD01-001'), mainEffect: 'เลือก Avatar 1 ใบ POWER +2 จนจบเทิร์น' });
    expect(add.status).toBe('PARSED_READY');
    const addPlan = toEffectPlan(add.clauses[0], 'p1', [], initial, ['p1-avatar']);
    expect(addPlan?.effects[0]).toMatchObject({ kind: 'modify_power', amount: 2, layer: 1, expiresAt: 'END_OF_TURN' });
    const added = resolveEffectPlan(initial, addPlan!);
    expect(added.ok).toBe(true);
    expect(calculateNetPower(added.state.players.p1.avatarZone[0])).toBe(byPrintId('SD01-001').power + 2);

    const set = parseCardText({ ...byPrintId('SD01-001'), mainEffect: 'เลือก Avatar 1 ใบ POWER เท่ากับ 3 จนถึง Draw Phase ถัดไป' });
    expect(set.status).toBe('PARSED_READY');
    const setPlan = toEffectPlan(set.clauses[0], 'p1', [], initial, ['p1-avatar']);
    expect(setPlan?.effects[0]).toMatchObject({ kind: 'set_power', value: 3, expiresAt: 'DRAW_PHASE' });
    const assigned = resolveEffectPlan(initial, setPlan!);
    expect(assigned.ok).toBe(true);
    expect(calculateNetPower(assigned.state.players.p1.avatarZone[0])).toBe(3);
  });

  it('maps the SD02-001 Unity keyword spec into the existing Game State combat operation', () => {
    const initial = gameState();
    const helper = { ...instance('p1-unity-helper', 'p1'), card: byPrintId('SD02-001') };
    initial.players.p1.avatarZone.push(helper);
    const parsed = parseCardText(helper.card);
    expect(parsed.clauses[0].keywordSpecs).toContainEqual(expect.objectContaining({ keyword: 'สามัคคี', kind: 'COMBAT_KEYWORD' }));
    const paid = payCombatKeyword(initial, 'p1-avatar', helper.instanceId, 'สามัคคี');
    expect(paid).not.toBeNull();
    expect(paid?.players.p1.avatarZone.find(card => card.instanceId === helper.instanceId)?.isRested).toBe(true);
    expect(paid?.players.p1.avatarZone.find(card => card.instanceId === 'p1-avatar')?.layerModifiers).toContainEqual(
      expect.objectContaining({ layer: 4, powerMod: helper.card.power, expiresAt: 'END_OF_BATTLE' })
    );
    expect(initial.players.p1.avatarZone.find(card => card.instanceId === helper.instanceId)?.isRested).toBe(false);
  });

  it('executes Symbol changes in layer order and preserves the printed Symbol', () => {
    const initial = gameState();
    const parsed = parseCardText({ ...byPrintId('SD01-001'), mainEffect: 'เลือก Avatar 1 ใบ เปลี่ยน Symbol ของ Avatar ใบนั้นเป็น ผี จนจบเทิร์น' });
    expect(parsed.status).toBe('PARSED_READY');
    const plan = toEffectPlan(parsed.clauses[0], 'p1', [], initial, ['p1-avatar']);
    expect(plan?.effects[0]).toMatchObject({ kind: 'change_symbol', symbol: 'ผี', layer: 1, expiresAt: 'END_OF_TURN' });
    const result = resolveEffectPlan(initial, plan!);
    expect(result.ok).toBe(true);
    expect(calculateEffectiveSymbol(result.state.players.p1.avatarZone[0])).toBe('ผี');
    expect(result.state.players.p1.avatarZone[0].card.symbol).toBe('เทพ');
  });

  it('executes LIFE flips atomically and blocks turning LIFE face-down while Critical', () => {
    const initial = gameState();
    const lifeCard = { ...instance('p2-life', 'p2'), card: { ...byPrintId('SD01-001'), type: 'Life' as const }, isFaceUp: false };
    initial.players.p2.lifeDeck.push(lifeCard);
    const reveal = parseCardText({ ...byPrintId('SD01-001'), mainEffect: 'หงาย LIFE Card ใบบนสุดของฝ่ายตรงข้าม 1 ใบ' });
    expect(reveal.status).toBe('PARSED_READY');
    const revealPlan = toEffectPlan(reveal.clauses[0], 'p1', [], initial);
    const revealed = resolveEffectPlan(initial, revealPlan!);
    expect(revealed.ok).toBe(true);
    expect(revealed.state.players.p2.lifeDeck[0].isFaceUp).toBe(true);

    const hide = parseCardText({ ...byPrintId('SD01-001'), mainEffect: 'คว่ำ LIFE Card ใบบนสุดของฝ่ายตรงข้าม 1 ใบ' });
    const critical = structuredClone(revealed.state);
    critical.players.p2.isCritical = true;
    expect(toEffectPlan(hide.clauses[0], 'p1', [], critical)).toBeNull();
    critical.players.p2.isCritical = false;
    const hidePlan = toEffectPlan(hide.clauses[0], 'p1', [], critical);
    expect(hidePlan?.effects[0]).toMatchObject({ kind: 'flip_life', face: 'down', allowWhileCritical: false });
    const hidden = resolveEffectPlan(critical, hidePlan!);
    expect(hidden.ok).toBe(true);
    expect(hidden.state.players.p2.lifeDeck[0].isFaceUp).toBe(false);
  });
});
