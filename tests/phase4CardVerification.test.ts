import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  calculateEffectiveSymbol,
  calculateNetPower,
} from '../src/engine/layers';
import {
  matchesCardName,
  parseCardNameRules,
  parseCardText,
  toCardTextEffectPlan,
} from '../src/engine/cardTextAdapter';
import { resolveEffectPlan } from '../src/engine/effectResolver';
import type { Card, CardInstance, GameState } from '../src/engine/types';

const catalog = JSON.parse(readFileSync(new URL('../cards_clean.json', import.meta.url), 'utf8')) as Card[];
const effectRows = catalog.filter(card => card.mainEffect.trim().length > 0);
const parsedRows = effectRows.filter(card => parseCardText(card).status === 'PARSED_READY');
const failClosedRows = effectRows.filter(card => {
  const parsed = parseCardText(card);
  return parsed.status === 'UNSUPPORTED' && parsed.reason?.includes('multi-player target resolution');
});
const verifiedRows = new Set<string>();
const base = catalog.find(card => card.printId === 'SD01-001')!;

type ZoneName = 'deck' | 'hand' | 'lifeDeck' | 'avatarZone' | 'constructZone' | 'magicZone' | 'hell' | 'darkDimension';

function instance(instanceId: string, playerId: string, card: Card, overrides: Partial<CardInstance> = {}): CardInstance {
  return {
    instanceId,
    card,
    ownerId: playerId,
    controllerId: playerId,
    isRested: false,
    isFaceUp: true,
    attachedInstances: [],
    layerModifiers: [],
    ...overrides,
  };
}

function makeState(): GameState {
  const player = (id: string, seat: number) => ({
    id,
    name: id,
    seat,
    deck: [] as CardInstance[],
    hand: [] as CardInstance[],
    lifeDeck: [] as CardInstance[],
    avatarZone: [] as CardInstance[],
    constructZone: [] as CardInstance[],
    magicZone: [] as CardInstance[],
    hell: [] as CardInstance[],
    darkDimension: [] as CardInstance[],
    isCritical: false,
    reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 },
    usedMagicTypesThisTurn: new Set(),
  });
  const p1 = player('p1', 0);
  const p2 = player('p2', 1);
  for (let index = 0; index < 6; index += 1) {
    p1.deck.push(instance(`p1-deck-${index}`, 'p1', { ...base, name: `Fixture Deck ${index}` }));
    p1.lifeDeck.push(instance(`p1-life-${index}`, 'p1', { ...base, type: 'Life', name: `Fixture LIFE ${index}` }, { isFaceUp: false }));
    p2.lifeDeck.push(instance(`p2-life-${index}`, 'p2', { ...base, type: 'Life', name: `Opponent LIFE ${index}` }, { isFaceUp: false }));
  }
  return {
    id: 'phase4-card-verification',
    mode: 'DUEL',
    playerOrder: ['p1', 'p2'],
    currentTurnPlayerIndex: 0,
    currentPhase: 'MAIN',
    turnNumber: 1,
    roundNumber: 1,
    players: { p1, p2 },
    landMagicZone: null,
    eventLog: [],
  };
}

function zoneIds(state: GameState): Record<string, string[]> {
  const zones: Record<string, string[]> = {};
  for (const playerId of state.playerOrder) {
    const player = state.players[playerId];
    for (const zone of ['deck', 'hand', 'lifeDeck', 'avatarZone', 'constructZone', 'magicZone', 'hell', 'darkDimension'] as ZoneName[]) {
      zones[`${playerId}.${zone}`] = player[zone].map(card => card.instanceId);
    }
  }
  zones['shared.landMagicZone'] = state.landMagicZone ? [state.landMagicZone.instanceId] : [];
  return zones;
}

function targetRequirement(effect: ReturnType<typeof parseCardText>['clauses'][number]['effects'][number]): number {
  if (effect.kind === 'return_to_deck' || effect.kind === 'search_deck_to_hand' || effect.kind === 'recover_from_hell') return effect.count;
  if (effect.kind === 'summon_from_hell') return 1;
  return ['modify_power', 'set_power', 'change_symbol', 'destroy_avatar', 'bounce_avatar', 'banish_avatar',
    'destroy_construct', 'bounce_construct', 'banish_construct', 'sacrifice_avatar'].includes(effect.kind) ? 1 : 0;
}

function makeBindings(card: Card, state: GameState) {
  const parsed = parseCardText(card);
  const operationClauses = parsed.clauses.filter(clause => clause.effects.length > 0 || clause.cost);
  const bindings: Array<{ costInstanceIds?: string[]; targetInstanceIds?: string[] }> = [];
  let targetIndex = 0;
  let handIndex = 0;
  for (const clause of operationClauses) {
    const targetInstanceIds: string[] = [];
    for (const effect of clause.effects) {
      for (let index = 0; index < targetRequirement(effect); index += 1) {
        const id = `p1-target-${targetIndex++}`;
        if (effect.kind === 'search_deck_to_hand') {
          const matchingCard = catalog.find(candidate => candidate.type === effect.cardType && matchesCardName(candidate.name, effect.name, parseCardNameRules(candidate)));
          if (!matchingCard) continue;
          state.players.p1.deck.push(instance(id, 'p1', matchingCard));
        } else if (effect.kind === 'recover_from_hell' || effect.kind === 'summon_from_hell') {
          const matchingCard = catalog.find(candidate => candidate.type === effect.cardType &&
            (!effect.name || matchesCardName(candidate.name, effect.name, parseCardNameRules(candidate))));
          if (!matchingCard) continue;
          state.players.p1.hell.push(instance(id, 'p1', matchingCard));
        } else {
          const cardType = effect.kind === 'return_to_deck' && clause.selector?.cardTypes[0]
            ? clause.selector.cardTypes[0] as Card['type']
            : effect.kind.includes('construct') ? 'Construct' : 'Avatar';
          const targetCard: Card = {
            ...base,
            type: cardType,
            cost: clause.selector?.cost?.value ?? base.cost,
            symbol: clause.selector?.symbol ?? base.symbol,
            name: clause.selector?.name?.value ?? `Fixture target ${targetIndex}`,
          };
          const targetPlayerId = clause.selector?.controller === 'opponent' ? 'p2' : 'p1';
          if (effect.kind === 'return_to_deck' && clause.selector?.zones.includes('ในนรก')) state.players[targetPlayerId].hell.push(instance(id, targetPlayerId, targetCard));
          else if (effect.kind === 'return_to_deck') state.players[targetPlayerId].hand.push(instance(id, targetPlayerId, targetCard));
          else if (cardType === 'Construct') state.players[targetPlayerId].constructZone.push(instance(id, targetPlayerId, targetCard));
          else state.players[targetPlayerId].avatarZone.push(instance(id, targetPlayerId, targetCard));
        }
        targetInstanceIds.push(id);
      }
    }
    const costInstanceIds: string[] = [];
    for (let index = 0; index < (clause.cost?.count ?? 0); index += 1) {
      const id = `p1-cost-${handIndex++}`;
      const costType = clause.cost?.kind === 'discard_from_hand' && clause.cost.selector?.cardTypes[0]
        ? clause.cost.selector.cardTypes[0]
        : 'Avatar';
      const costCard = { ...base, type: costType as Card['type'], symbol: clause.cost?.kind === 'discard_from_hand' ? clause.cost.selector?.symbol ?? base.symbol : base.symbol };
      state.players.p1.hand.push(instance(id, 'p1', costCard));
      costInstanceIds.push(id);
    }
    bindings.push({ costInstanceIds, targetInstanceIds });
  }
  return { parsed, bindings };
}

function expectedToVerify(card: Card, parsed: ReturnType<typeof parseCardText>): boolean {
  if (parsed.status !== 'PARSED_READY' || parsed.clauses.length === 0) return false;
  if (parsed.clauses.some(clause => clause.effects.length === 0 || clause.unresolved.length > 0 || clause.conditions.length > 0 || clause.timing.mode || clause.timing.event || clause.timing.frequency || clause.keywordSpecs.length > 0 || /เมื่อ|จุติ|คำสั่งเสีย|อัตโนมัติ|ต่อเนื่อง|เทิร์นละครั้ง|สั่งใช้|ถ้า|หาก|ตราบเท่าที่/.test(clause.source))) return false;
  if (parsed.clauses.some(clause => clause.effects.some(effect => effect.kind === 'scout_cards'))) return false;
  return parsed.clauses.every(clause => clause.effects.length > 0) && !!card.mainEffect.trim();
}

function assertEffectState(before: GameState, after: GameState, plan: NonNullable<ReturnType<typeof toCardTextEffectPlan>>) {
  const steps = plan.sequence ?? [
    ...(plan.costs ?? []).map(cost => ({ kind: 'cost' as const, cost })),
    ...plan.effects.map(effect => ({ kind: 'effect' as const, effect })),
  ];
  if (steps.length > 1) {
    let current = before;
    for (const step of steps) {
      const stepPlan = step.kind === 'cost'
        ? { actorId: plan.actorId, costs: [step.cost], effects: [] }
        : { actorId: plan.actorId, effects: [step.effect] };
      const resolvedStep = resolveEffectPlan(current, stepPlan);
      expect(resolvedStep.ok).toBe(true);
      if (!resolvedStep.ok) return;
      if (step.kind === 'effect') assertEffectState(current, resolvedStep.state, stepPlan);
      else {
        const priorZones = zoneIds(current);
        const nextZones = zoneIds(resolvedStep.state);
        if (step.cost.kind === 'discard_from_hand') {
          for (const id of step.cost.instanceIds) {
            expect(nextZones[`${step.cost.playerId}.hand`]).not.toContain(id);
            expect(nextZones[`${step.cost.playerId}.hell`]).toContain(id);
          }
        } else {
          expect(nextZones[`${step.cost.playerId}.avatarZone`]).not.toContain(step.cost.instanceId);
          expect(nextZones[`${step.cost.playerId}.hell`]).toContain(step.cost.instanceId);
        }
        expect(Object.values(nextZones).flat().sort()).toEqual(Object.values(priorZones).flat().sort());
      }
      current = resolvedStep.state;
    }
    expect(zoneIds(current)).toEqual(zoneIds(after));
    return;
  }
  const beforeZones = zoneIds(before);
  const afterZones = zoneIds(after);
  const expectedZones = structuredClone(beforeZones);
  const allBefore = Object.values(beforeZones).flat();
  const allAfter = Object.values(afterZones).flat();
  expect([...allAfter].sort()).toEqual([...allBefore].sort());
  expect(new Set(allAfter).size).toBe(allAfter.length);

  const moveExpected = (instanceId: string, destination: string, position: 'top' | 'bottom' = 'bottom') => {
    const source = Object.entries(expectedZones).find(([key, ids]) => key !== 'shared.landMagicZone' && ids.includes(instanceId));
    expect(source).toBeDefined();
    if (!source) return;
    expectedZones[source[0]] = source[1].filter(id => id !== instanceId);
    const destinationIds = expectedZones[destination] ?? [];
    expectedZones[destination] = position === 'top' ? [instanceId, ...destinationIds] : [...destinationIds, instanceId];
  };

  for (const cost of plan.costs ?? []) {
    if (cost.kind === 'discard_from_hand') {
      for (const id of cost.instanceIds) {
        expect(expectedZones[`${cost.playerId}.hand`]).toContain(id);
        moveExpected(id, `${cost.playerId}.hell`);
      }
    } else if (cost.kind === 'sacrifice_avatar') {
      moveExpected(cost.instanceId, `${cost.playerId}.hell`);
    }
  }

  for (const effect of plan.effects) {
    if (effect.kind === 'draw') {
      const ids = expectedZones[`${effect.playerId}.deck`].slice(0, effect.count);
      for (const id of ids) moveExpected(id, `${effect.playerId}.hand`);
      expect(afterZones[`${effect.playerId}.hand`]).toEqual(expectedZones[`${effect.playerId}.hand`]);
      expect(afterZones[`${effect.playerId}.deck`]).toEqual(expectedZones[`${effect.playerId}.deck`]);
    } else if (effect.kind === 'mill') {
      const ids = expectedZones[`${effect.playerId}.deck`].slice(0, effect.count);
      for (const id of ids) moveExpected(id, `${effect.playerId}.hell`);
      expect(afterZones[`${effect.playerId}.hell`]).toEqual(expectedZones[`${effect.playerId}.hell`]);
      expect(afterZones[`${effect.playerId}.deck`]).toEqual(expectedZones[`${effect.playerId}.deck`]);
    } else if (effect.kind === 'flip_life') {
      const changed = after.players[effect.playerId].lifeDeck.filter((card, index) => card.isFaceUp !== before.players[effect.playerId].lifeDeck[index]?.isFaceUp);
      expect(changed).toHaveLength(effect.count);
      expect(changed.every(card => card.isFaceUp === (effect.face === 'up'))).toBe(true);
    } else if (effect.kind === 'modify_power' || effect.kind === 'set_power' || effect.kind === 'change_symbol') {
      const target = after.playerOrder.flatMap(playerId => after.players[playerId].avatarZone).find(card => card.instanceId === effect.targetId);
      const original = before.playerOrder.flatMap(playerId => before.players[playerId].avatarZone).find(card => card.instanceId === effect.targetId);
      expect(target).toBeDefined();
      if (target && effect.kind === 'modify_power') expect(calculateNetPower(target)).toBe((original?.card.power ?? 0) + effect.amount);
      if (target && effect.kind === 'set_power') expect(calculateNetPower(target)).toBe(effect.value);
      if (target && effect.kind === 'change_symbol') {
        expect(calculateEffectiveSymbol(target)).toBe(effect.symbol);
        expect(target.card.symbol).toBe(original?.card.symbol);
      }
    } else if (effect.kind === 'destroy_avatar' || effect.kind === 'sacrifice_avatar') {
      const old = before.playerOrder.flatMap(id => before.players[id].avatarZone).find(card => card.instanceId === effect.targetId);
      expect(old).toBeDefined();
      moveExpected(effect.targetId, `${old!.ownerId}.hell`);
      expect(afterZones[`${old!.ownerId}.avatarZone`]).toEqual(expectedZones[`${old!.ownerId}.avatarZone`]);
      expect(afterZones[`${old!.ownerId}.hell`]).toEqual(expectedZones[`${old!.ownerId}.hell`]);
    } else if (effect.kind === 'bounce_avatar' || effect.kind === 'banish_avatar') {
      const old = before.playerOrder.flatMap(id => before.players[id].avatarZone).find(card => card.instanceId === effect.targetId)!;
      const destination = effect.kind === 'bounce_avatar' ? 'hand' : 'darkDimension';
      moveExpected(effect.targetId, `${old.ownerId}.${destination}`);
      expect(afterZones[`${old.ownerId}.avatarZone`]).toEqual(expectedZones[`${old.ownerId}.avatarZone`]);
      expect(afterZones[`${old.ownerId}.${destination}`]).toEqual(expectedZones[`${old.ownerId}.${destination}`]);
    } else if (effect.kind === 'destroy_construct' || effect.kind === 'bounce_construct' || effect.kind === 'banish_construct') {
      const old = before.playerOrder.flatMap(id => before.players[id].constructZone).find(card => card.instanceId === effect.targetId)!;
      const destination = effect.kind === 'destroy_construct' ? 'hell' : effect.kind === 'bounce_construct' ? 'hand' : 'darkDimension';
      moveExpected(effect.targetId, `${old.ownerId}.${destination}`);
      expect(afterZones[`${old.ownerId}.constructZone`]).toEqual(expectedZones[`${old.ownerId}.constructZone`]);
      expect(afterZones[`${old.ownerId}.${destination}`]).toEqual(expectedZones[`${old.ownerId}.${destination}`]);
    } else if (effect.kind === 'return_to_deck') {
      for (const id of effect.instanceIds) moveExpected(id, 'p1.deck', effect.position === 'top' ? 'top' : 'bottom');
      const afterDeck = afterZones['p1.deck'];
      for (const id of effect.instanceIds) expect(afterDeck).toContain(id);
      if (effect.position === 'top') expect(afterDeck.slice(0, effect.instanceIds.length)).toEqual([...effect.instanceIds].reverse());
      if (effect.position === 'bottom') expect(afterDeck.slice(-effect.instanceIds.length)).toEqual(effect.instanceIds);
      if (effect.position === 'shuffle') {
        expect(after.gameEvents?.some(item => item.event.type === 'DECK_SHUFFLED')).toBe(true);
        expectedZones['p1.deck'] = afterDeck;
      }
    } else if (effect.kind === 'search_to_hand') {
      for (const id of effect.instanceIds) moveExpected(id, `${effect.playerId}.hand`);
      expect(afterZones[`${effect.playerId}.hand`]).toEqual(expectedZones[`${effect.playerId}.hand`]);
      if (effect.shuffle) {
        expect(after.gameEvents?.some(item => item.event.type === 'DECK_SHUFFLED')).toBe(true);
        expectedZones[`${effect.playerId}.deck`] = afterZones[`${effect.playerId}.deck`];
      } else expect(afterZones[`${effect.playerId}.deck`]).toEqual(expectedZones[`${effect.playerId}.deck`]);
    } else if (effect.kind === 'recover_from_hell') {
      for (const id of effect.instanceIds) moveExpected(id, `${effect.playerId}.hand`);
      expect(afterZones[`${effect.playerId}.hand`]).toEqual(expectedZones[`${effect.playerId}.hand`]);
      expect(afterZones[`${effect.playerId}.hell`]).toEqual(expectedZones[`${effect.playerId}.hell`]);
    } else if (effect.kind === 'summon_from_hell') {
      moveExpected(effect.instanceId, `${effect.playerId}.avatarZone`);
      expect(afterZones[`${effect.playerId}.avatarZone`]).toEqual(expectedZones[`${effect.playerId}.avatarZone`]);
      expect(afterZones[`${effect.playerId}.hell`]).toEqual(expectedZones[`${effect.playerId}.hell`]);
      expect(after.players[effect.playerId].avatarZone.find(card => card.instanceId === effect.instanceId)?.isRested).toBe(effect.rested ?? false);
    } else if (effect.kind === 'scout_cards') {
      throw new Error('Scout requires an explicit player-choice resolution and is not verified by an automatic selection');
    } else {
      throw new Error(`No Phase 4 exact-state assertion for ${effect.kind}`);
    }
  }
}

describe('Phase 4A per-card Game State verification', () => {
  it(`enumerates every parser-ready effect-bearing row (${parsedRows.length})`, () => {
    expect(parsedRows).toHaveLength(229);
    expect(new Set(parsedRows.map(card => card.printId)).size).toBeGreaterThan(0);
  });

  it.each(failClosedRows.map((card, rowIndex) => [rowIndex + 1, card] as const))('fails closed for unsupported multi-player row %i: %s', (_rowNumber, card) => {
    const parsed = parseCardText(card);
    expect(parsed.status).toBe('UNSUPPORTED');
    expect(toCardTextEffectPlan(parsed, 'p1', [], makeState())).toBeNull();
  });

  it.each(parsedRows.map((card, rowIndex) => [rowIndex + 1, card] as const))('tests catalog row %i: %s', (_rowNumber, card) => {
    const state = makeState();
    const { parsed, bindings } = makeBindings(card, state);
    const before = structuredClone(state);
    const plan = toCardTextEffectPlan(parsed, 'p1', bindings, state);
    if (!plan) {
      expect(parsed.status).toBe('PARSED_READY');
      return;
    }
    if (plan.effects.some(effect => effect.kind === 'scout_cards')) {
      expect(parsed.clauses.some(clause => clause.effects.some(effect => effect.kind === 'scout_cards'))).toBe(true);
      return;
    }
    const result = resolveEffectPlan(state, plan);
    if (!result.ok) {
      expect(result.state).toBe(state);
      return;
    }
    expect(result.state).not.toBe(state);
    assertEffectState(before, result.state, plan);
    if (expectedToVerify(card, parsed)) verifiedRows.add(`${catalog.indexOf(card) + 1}|${card.printId}|${card.name}`);
  });

  afterAll(() => {
    console.info(`[phase4] PARSED_READY rows attempted=${parsedRows.length}; VERIFIED_WORKING=${verifiedRows.size}`);
    console.info(`[phase4] VERIFIED_WORKING rows: ${[...verifiedRows].sort().join('; ')}`);
  });
});
