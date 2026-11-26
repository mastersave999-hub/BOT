import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveEffectPlan } from '../src/engine/effectResolver';
import { activateRegisteredCardTextAbility, createNameReference, effectiveMagicSubtype, magicCancellationTargetType, matchesCardName, parseCardNameRules, parseCardText, toCardTextEffectPlan, toEffectDefinitions, toEffectPlan, toTriggerAbility, validateAbilityMagicQuota } from '../src/engine/cardTextAdapter';
import { moveCardBetweenZones } from '../src/engine/gameRules';
import { validateMagicPlay } from '../src/engine/gameRules';
import { validateDeck } from '../src/engine/deckValidator';
import { calculateEffectiveSymbol, calculateNetPower } from '../src/engine/layers';
import { beginReactionCard, canCancelMagicCard, resolveReactionCard } from '../src/engine/reactionEngine';
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

  it('compiles and executes Thai destroy, bounce, banish, and mill clauses in Game State', () => {
    const base = byPrintId('SD01-001');
    const cases = [
      ['ทำลาย Avatar ตัวนั้น', 'destroy_avatar', 'hell'],
      ['นำ Avatar ตัวนั้นกลับขึ้นมือ', 'bounce_avatar', 'hand'],
      ['เนรเทศ Avatar ตัวนั้น', 'banish_avatar', 'darkDimension']
    ] as const;
    for (const [text, kind, destination] of cases) {
      const parsed = parseCardText({ ...base, mainEffect: text });
      expect(parsed.status).toBe('PARSED_READY');
      expect(parsed.clauses[0].effects[0]).toMatchObject({ kind });
      const initial = gameState();
      const plan = toEffectPlan(parsed.clauses[0], 'p1', [], initial, ['p1-avatar']);
      expect(plan).not.toBeNull();
      const result = resolveEffectPlan(initial, plan!);
      expect(result.ok).toBe(true);
      expect(result.state.players.p1[destination as 'hell' | 'hand' | 'darkDimension'].map(card => card.instanceId)).toContain('p1-avatar');
      expect(initial.players.p1.avatarZone.map(card => card.instanceId)).toContain('p1-avatar');
    }

    const milled = parseCardText({ ...base, mainEffect: 'ธรณีสูบ 1 ใบ' });
    expect(milled.status).toBe('PARSED_READY');
    const initial = gameState();
    const result = resolveEffectPlan(initial, toCardTextEffectPlan(milled, 'p1')!);
    expect(result.ok).toBe(true);
    expect(result.state.players.p1.hell.map(card => card.instanceId)).toContain('p1-deck');
    expect(result.state.players.p1.deck).toHaveLength(0);
    expect(result.state.gameEvents?.some(item => item.event.type === 'PLAYER_DECKED_OUT')).toBe(true);
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

  it('registers a summoned Avatar activated ability and continuous POWER/Symbol layers, then unregisters on exit', () => {
    const base = byPrintId('SD01-001');
    const activatedText = 'เทิร์นละครั้ง สั่งใช้ ทิ้งการ์ด 1 ใบ : จั่วการ์ด 1 ใบ ความสามารถนี้ถือเป็นการใช้ Normal Magic';
    const continuousText = 'ต่อเนื่อง ตราบเท่าที่ Avatar ใบนี้อยู่บน Avatar Zone POWER +1 ให้ Avatar {symbol เทพ} ทุกใบบน Avatar Zone ฝ่ายเรา';
    const continuousSymbolText = 'ต่อเนื่อง Avatar ใบนี้เปลี่ยน Symbol เป็น ผี';
    const initial = gameState();
    initial.players.p1.hand = [{ ...instance('p1-ability', 'p1'), card: { ...base, mainEffect: `${activatedText}<br>${continuousText}<br>${continuousSymbolText}` } }];
    initial.players.p1.hand.push(instance('p1-cost', 'p1'));
    const entered = moveCardBetweenZones(initial, {
      instanceId: 'p1-ability', actorId: 'p1', destination: 'avatarZone', destinationPlayerId: 'p1'
    });
    expect(entered.ok).toBe(true);
    const source = entered.state.players.p1.avatarZone.find(card => card.instanceId === 'p1-ability')!;
    expect(source.registeredActivatedAbilities).toHaveLength(1);
    expect(source.registeredContinuousAbilities).toHaveLength(2);
    expect(source.cardTextContinuousEffects).toEqual([
      { layer: 2, powerMod: 1, targetCardType: 'Avatar', targetController: 'SOURCE_CONTROLLER', targetSymbol: 'เทพ' },
      { layer: 1, powerMod: 0, symbolMod: 'ผี', targetCardType: 'Avatar', targetController: 'ANY', targetSelf: true }
    ]);
    expect(calculateNetPower(entered.state.players.p1.avatarZone.find(card => card.instanceId === 'p1-avatar')!)).toBe(base.power + 1);
    expect(calculateEffectiveSymbol(source)).toBe('ผี');

    const activated = activateRegisteredCardTextAbility(entered.state, 'p1-ability', 0, { costInstanceIds: ['p1-cost'] });
    expect(activated.ok).toBe(true);
    expect(activated.state.players.p1.usedMagicTypesThisTurn.has('Normal')).toBe(true);
    expect(activated.state.players.p1.hell.map(card => card.instanceId)).toContain('p1-cost');
    expect(activated.state.players.p1.hand.map(card => card.instanceId)).toContain('p1-deck');
    expect(activateRegisteredCardTextAbility(activated.state, 'p1-ability', 0, { costInstanceIds: ['missing'] }).reason).toContain('already been used');

    const exited = moveCardBetweenZones(activated.state, {
      instanceId: 'p1-ability', actorId: 'p1', destination: 'hell'
    });
    expect(exited.ok).toBe(true);
    expect(exited.state.players.p1.hell.map(card => card.instanceId)).toContain('p1-ability');
    expect(exited.state.players.p1.avatarZone.find(card => card.instanceId === 'p1-avatar')?.layerModifiers)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ sourceCardId: expect.stringContaining('p1-ability') })]));
    expect(exited.state.players.p1.hell.find(card => card.instanceId === 'p1-ability')).not.toHaveProperty('registeredActivatedAbilities');
    expect(exited.state.players.p1.hell.find(card => card.instanceId === 'p1-ability')).not.toHaveProperty('registeredContinuousAbilities');
  });

  it('executes inherent secondary and second-primary name rules for searches and deck limits', () => {
    const base = byPrintId('SD01-001');
    const secondary = { ...base, name: 'Moon Guard', mainEffect: '#การ์ดใบนี้นับว่าเป็น "Camp Name" ซึ่งจะถือว่าเป็นชื่อเสริม' };
    const dualPrimary = { ...base, name: 'Sea Temple', mainEffect: '#การ์ดใบนี้นับเป็นชื่อ Black Marsh ซึ่งจะถือว่าเป็นชื่อหลักอีกชื่อ' };
    const secondaryRules = parseCardNameRules(secondary);
    const primaryRules = parseCardNameRules(dualPrimary);
    expect(secondaryRules.secondaryNames).toEqual(['Camp Name']);
    expect(primaryRules.additionalPrimaryNames).toEqual(['Black Marsh']);
    expect(matchesCardName('Moon Guard', createNameReference('Camp Name', true), secondaryRules)).toBe(true);
    expect(matchesCardName('Moon Guard', createNameReference('Camp Name', false), secondaryRules)).toBe(false);
    expect(matchesCardName('Sea Temple', createNameReference('Black Marsh', false), primaryRules)).toBe(true);
    expect(parseCardText(secondary).attributes.ruleTextProtected).toBe(true);
    expect(parseCardText(dualPrimary).attributes.ruleTextProtected).toBe(true);

    const mainDeck = [
      ...Array.from({ length: 4 }, () => secondary),
      ...Array.from({ length: 4 }, () => ({ ...base, name: 'Camp Name' })),
      ...Array.from({ length: 42 }, (_, index) => ({ ...base, name: `Filler ${index}`, isOnlyOne: index === 0 }))
    ];
    const lifeDeck = Array.from({ length: 5 }, (_, index) => ({ ...base, type: 'Life' as const, name: `Life ${index}` }));
    expect(validateDeck(mainDeck, lifeDeck).isValid).toBe(true);

    const dualNameDeck = [
      dualPrimary,
      ...Array.from({ length: 4 }, () => ({ ...base, name: 'Black Marsh' })),
      ...Array.from({ length: 45 }, (_, index) => ({ ...base, name: `Dual filler ${index}`, isOnlyOne: index === 0 }))
    ];
    expect(validateDeck(dualNameDeck, lifeDeck).isValid).toBe(false);
  });

  it('enforces ability Magic quotas separately from effective Magic type conversion and cancellation', () => {
    const base = byPrintId('SD01-001');
    const ability = parseCardText({ ...base, mainEffect: 'สั่งใช้ ทิ้งการ์ด 1 ใบ : จั่วการ์ด 1 ใบ ความสามารถนี้ถือเป็นการใช้ Normal Magic' });
    expect(ability.magicUse.abilityConsumesMagicType).toBe('Normal');
    expect(validateAbilityMagicQuota(gameState(), 'p1', ability)).toBeNull();
    const used = gameState();
    used.players.p1.usedMagicTypesThisTurn.add('Normal');
    expect(validateAbilityMagicQuota(used, 'p1', ability)).toContain('already been used');
    expect(magicCancellationTargetType(ability)).toBeUndefined();

    const converted = parseCardText({ ...base, subtype: 'Normal', mainEffect: 'สามารถใช้การ์ดใบนี้ใน Battle Phase โดยถือว่าเป็นการใช้ React Magic' });
    expect(effectiveMagicSubtype(converted, 'Normal')).toBe('React');
    expect(magicCancellationTargetType(converted)).toBe('React');
    expect(canCancelMagicCard('ยกเลิกการใช้ React Magic', { ...base, type: 'Magic', subtype: 'Normal', mainEffect: 'สามารถใช้การ์ดใบนี้ใน Battle Phase โดยถือว่าเป็นการใช้ React Magic' })).toBe(true);
    expect(canCancelMagicCard('ยกเลิกการใช้ Normal Magic', { ...base, type: 'Magic', subtype: 'Normal', mainEffect: 'สามารถใช้การ์ดใบนี้ใน Battle Phase โดยถือว่าเป็นการใช้ React Magic' })).toBe(false);
    expect(canCancelMagicCard('ยกเลิกการใช้ Normal Magic', { ...base, type: 'Avatar', mainEffect: ability.clauses[0].source })).toBe(false);
    const state = gameState();
    state.currentPhase = 'BATTLE';
    expect(validateMagicPlay(state, 'p1', 'React', true)).toBeNull();
    state.players.p1.usedMagicTypesThisTurn.add('React');
    expect(validateMagicPlay(state, 'p1', 'React', true)).toContain('already been used');
    expect(magicCancellationTargetType(converted)).not.toBe(magicCancellationTargetType(ability));

    const target = { ...instance('p1-converted-magic', 'p1'), card: { ...base, type: 'Magic' as const, subtype: 'Normal' as const,
      mainEffect: 'สามารถใช้การ์ดใบนี้ใน Battle Phase โดยถือว่าเป็นการใช้ React Magic' } };
    const cancelCard = { ...instance('p2-cancel-react', 'p2'), card: { ...base, type: 'Magic' as const,
      subtype: 'React' as const, mainEffect: 'ยกเลิกการใช้ React Magic' } };
    const cancellationState = gameState();
    cancellationState.players.p1.magicZone.push(target);
    cancellationState.players.p1.usedMagicTypesThisTurn.add('React');
    cancellationState.players.p2.hand = [cancelCard];
    cancellationState.reactionWindow = {
      id: 'react-conversion-window', trigger: { type: 'MAGIC_PLAYED', actorId: 'p1', sourceInstanceId: target.instanceId },
      turnOwnerId: 'p1', priorityPlayerId: 'p2', passedPlayerIds: [], priorityOrder: ['p2', 'p1'], chain: [], revision: 0,
      pendingAction: { type: 'RESOLVE_MAGIC', actorId: 'p1', sourceCard: target }
    };
    const begun = beginReactionCard(cancellationState, 'p2', cancelCard.instanceId);
    expect(begun.ok, begun.ok ? '' : begun.reason).toBe(true);
    if (begun.ok) {
      const cancelled = resolveReactionCard(begun.state);
      expect(cancelled.ok).toBe(true);
      if (cancelled.ok) {
        expect(cancelled.state.players.p1.hell.map(card => card.instanceId)).toContain(target.instanceId);
        expect(cancelled.state.gameEvents?.some(event => event.event.type === 'ACTION_CANCELLED' && event.event.targetInstanceId === target.instanceId)).toBe(true);
        expect(cancelled.pendingAction).toBeUndefined();
      }
    }
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

  it('executes Construct destruction, Deck returns with shuffle, and exact top/bottom placement', () => {
    const base = byPrintId('SD01-001');
    const initial = gameState();
    const construct = { ...instance('p1-construct', 'p1'), card: { ...base, type: 'Construct' as const } };
    initial.players.p1.constructZone.push(construct);
    const destroy = parseCardText({ ...base, mainEffect: 'ทำลาย Construct ตัวนั้น' });
    expect(destroy.status).toBe('PARSED_READY');
    expect(destroy.clauses[0].effects[0]).toMatchObject({ kind: 'destroy_construct' });
    const destroyPlan = toEffectPlan(destroy.clauses[0], 'p1', [], initial, ['p1-construct']);
    expect(destroyPlan).not.toBeNull();
    const destroyed = resolveEffectPlan(initial, destroyPlan!);
    expect(destroyed.ok).toBe(true);
    expect(destroyed.state.players.p1.hell.map(card => card.instanceId)).toContain('p1-construct');

    for (const [text, kind, zone] of [
      ['นำ Construct ตัวนั้นกลับขึ้นมือ', 'bounce_construct', 'hand'],
      ['เนรเทศ Construct ตัวนั้น', 'banish_construct', 'darkDimension']
    ] as const) {
      const state = gameState();
      state.players.p1.constructZone.push(construct);
      const parsed = parseCardText({ ...base, mainEffect: text });
      expect(parsed.status).toBe('PARSED_READY');
      expect(parsed.clauses[0].effects[0]).toMatchObject({ kind });
      const plan = toEffectPlan(parsed.clauses[0], 'p1', [], state, ['p1-construct']);
      expect(plan).not.toBeNull();
      const result = resolveEffectPlan(state, plan!);
      expect(result.ok).toBe(true);
      expect(result.state.players.p1[zone].map(card => card.instanceId)).toContain('p1-construct');
    }

    for (const [text, position] of [
      ['นำ Avatar ตัวนั้นกลับเข้า Deck แล้วสับ Deck', 'shuffle'],
      ['นำ Avatar ตัวนั้นไว้บนสุดของ Deck', 'top'],
      ['นำ Avatar ตัวนั้นไว้ใต้ Deck', 'bottom']
    ] as const) {
      const state = gameState();
      state.players.p1.deck.push(instance('p1-deck-2', 'p1'));
      const parsed = parseCardText({ ...base, mainEffect: text });
      expect(parsed.status).toBe('PARSED_READY');
      expect(parsed.clauses[0].effects[0]).toMatchObject({ kind: 'return_to_deck', position });
      const plan = toEffectPlan(parsed.clauses[0], 'p1', [], state, ['p1-avatar']);
      expect(plan).not.toBeNull();
      const result = resolveEffectPlan(state, plan!);
      expect(result.ok).toBe(true);
      const ids = result.state.players.p1.deck.map(card => card.instanceId);
      if (position === 'top') expect(ids[0]).toBe('p1-avatar');
      if (position === 'bottom') expect(ids.at(-1)).toBe('p1-avatar');
      expect(result.state.gameEvents?.some(item => item.event.type === 'DECK_SHUFFLED')).toBe(position === 'shuffle');
    }

    const ordered = gameState();
    ordered.players.p1.avatarZone.push({ ...instance('p1-avatar-2', 'p1'), card: base });
    const orderedText = parseCardText({ ...base, mainEffect: 'นำ Avatar 2 ใบไว้บนสุดของ Deck' });
    expect(orderedText.status).toBe('PARSED_READY');
    const orderedPlan = toEffectPlan(orderedText.clauses[0], 'p1', [], ordered, ['p1-avatar', 'p1-avatar-2']);
    expect(orderedPlan?.effects[0]).toMatchObject({ kind: 'return_to_deck', instanceIds: ['p1-avatar', 'p1-avatar-2'], position: 'top' });
    const orderedResult = resolveEffectPlan(ordered, orderedPlan!);
    expect(orderedResult.ok).toBe(true);
    expect(orderedResult.state.players.p1.deck.slice(0, 2).map(card => card.instanceId)).toEqual(['p1-avatar', 'p1-avatar-2']);
  });

  it('pays sacrifice costs immediately and executes sacrifice effects through Game State', () => {
    const base = byPrintId('SD01-001');
    const cost = parseCardText({ ...base, mainEffect: 'เซ่นไหว้ Avatar 1 ใบ : จั่วการ์ด 1 ใบ' });
    expect(cost.status).toBe('PARSED_READY');
    expect(cost.clauses[0].cost).toMatchObject({ kind: 'sacrifice_avatar', count: 1 });
    const initial = gameState();
    initial.players.p1.avatarZone[0] = { ...initial.players.p1.avatarZone[0], preventionShields: [{ id: 'test', kind: 'DESTRUCTION', mode: 'AUTOMATIC' }] };
    const plan = toEffectPlan(cost.clauses[0], 'p1', ['p1-avatar'], initial);
    expect(plan).not.toBeNull();
    const paid = resolveEffectPlan(initial, plan!);
    expect(paid.ok).toBe(true);
    expect(paid.state.players.p1.hell.map(card => card.instanceId)).toContain('p1-avatar');
    expect(paid.state.players.p1.hand.map(card => card.instanceId)).toContain('p1-deck');
    expect(initial.players.p1.avatarZone.map(card => card.instanceId)).toContain('p1-avatar');

    const effectState = gameState();
    const effect = parseCardText({ ...base, mainEffect: 'เซ่นไหว้ Avatar 1 ใบ' });
    expect(effect.status).toBe('PARSED_READY');
    expect(effect.clauses[0].effects[0]).toMatchObject({ kind: 'sacrifice_avatar' });
    const effectPlan = toEffectPlan(effect.clauses[0], 'p1', [], effectState, ['p1-avatar']);
    expect(effectPlan).not.toBeNull();
    const sacrificed = resolveEffectPlan(effectState, effectPlan!);
    expect(sacrificed.ok).toBe(true);
    expect(sacrificed.state.players.p1.hell.map(card => card.instanceId)).toContain('p1-avatar');
  });

  it('routes Scout through pending deck choices and automatically shuffles when no destination is given', () => {
    const base = byPrintId('SD01-001');
    const initial = gameState();
    initial.players.p1.deck.push(instance('p1-deck-2', 'p1'));
    const scout = parseCardText({ ...base, mainEffect: 'สอดแนม 1 ใบ' });
    expect(scout.status).toBe('PARSED_READY');
    expect(scout.clauses[0].effects[0]).toMatchObject({ kind: 'scout_cards', count: 1 });
    const automatic = resolveEffectPlan(initial, toEffectPlan(scout.clauses[0], 'p1')!);
    expect(automatic.ok).toBe(true);
    expect(automatic.state.pendingDeckChoice).toBeUndefined();
    expect(automatic.state.gameEvents?.some(item => item.event.type === 'DECK_SHUFFLED')).toBe(true);

    const routed = parseCardText({ ...base, mainEffect: 'สอดแนม 1 ใบ นำการ์ดใบนั้นขึ้นมือ' });
    expect(routed.status).toBe('PARSED_READY');
    expect(routed.clauses[0].effects.some(effect => effect.kind === 'scout_cards' && effect.destination === 'hand')).toBe(true);
    const routePlan = toEffectPlan(routed.clauses[0], 'p1');
    expect(routePlan).not.toBeNull();
    const choice = resolveEffectPlan(initial, routePlan!);
    expect(choice.ok).toBe(true);
    expect(choice.state.pendingDeckChoice).toMatchObject({ kind: 'SCOUT', destination: 'hand', candidateInstanceIds: ['p1-deck'] });
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
