import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveEffectPlan } from '../src/engine/effectResolver';
import { createNameReference, matchesCardName, parseCardText, toEffectDefinitions } from '../src/engine/cardTextAdapter';
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

  it('parses Cost : Effect into separate immutable text fields without guessing a cost operation', () => {
    const parsed = parseCardText(byPrintId('SD01-018'));
    const clause = parsed.clauses.find(item => item.costEffectSeparator === ':');
    expect(clause?.costText).toContain('ทิ้ง Avatar');
    expect(clause?.effectText).toContain('จั่วการ์ด 2 ใบ');
    expect(parsed.status).toBe('UNSUPPORTED');
    expect(parsed.reason).toContain('cost plan');
  });

  it('keeps costed catalog text unsupported and Phase 2 rejects an incomplete cost plan atomically', () => {
    const parsed = parseCardText(byPrintId('SD01-018'));
    expect(parsed.status).toBe('UNSUPPORTED');
    const initial = gameState();
    const result = resolveEffectPlan(initial, {
      actorId: 'p1',
      costs: [{ kind: 'discard_from_hand', playerId: 'p1', instanceIds: ['missing-cost-card'] }],
      effects: [{ kind: 'draw', playerId: 'p1', count: 1 }]
    });
    expect(result.ok).toBe(false);
    expect(result.state).toBe(initial);
    expect(initial.players.p1.hand.map(card => card.instanceId)).toEqual(['p1-hand']);
    expect(initial.players.p1.deck.map(card => card.instanceId)).toEqual(['p1-deck']);
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

  it('recognizes declared keywords without pretending their effects have been implemented', () => {
    const parsed = parseCardText(byPrintId('SD04-001'));
    expect(parsed.clauses.flatMap(clause => clause.keywords)).toContain('สอดแนม');
    expect(parsed.clauses.flatMap(clause => clause.keywords)).toContain('เทิร์นละครั้ง');
    expect(parsed.status).toBe('UNSUPPORTED');
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

  it('fails closed for real multi-part triggered text rather than returning a guessed partial plan', () => {
    const parsed = parseCardText(byPrintId('SD02-001'));
    expect(parsed.clauses.length).toBeGreaterThan(1);
    expect(parsed.status).toBe('UNSUPPORTED');
    expect(parsed.reason).toBeTruthy();
  });
});
