import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { appendGameEvents, type GameEvent } from '../src/engine/gameEvents';
import { passReactionPriority } from '../src/engine/reactionEngine';
import {
  calculateEffectiveSymbol,
  calculateNetPower,
} from '../src/engine/layers';
import {
  matchesCardName,
  parseCardNameRules,
  parseCardText,
  toCardTextEffectPlan,
  toTriggerAbility,
} from '../src/engine/cardTextAdapter';
import { resolveEffectPlan, type EffectCondition, type EffectDefinition, type EffectPlan } from '../src/engine/effectResolver';
import { resolveHellChoice } from '../src/engine/hellChoice';
import { recomputeContinuousEffects } from '../src/engine/continuousEffects';
import { resolveDeckChoice, scoutCards } from '../src/engine/deckOperations';
import { checkModificationEquip } from '../src/engine/equipLegality';
import { moveCardBetweenZones, payGemAndPlayFromHand } from '../src/engine/gameRules';
import { applyHumanShieldRedirect, declareCombatAttack, declareCombatAttackWithHelpers, declareDuo, resolveDeclaredBattle } from '../src/engine/combatKeywords';
import { calculateNetPower as netPower } from '../src/engine/layers';
import { finishEndPhaseTurn, transitionGamePhase } from '../src/engine/turnEngine';
import type { Card, CardInstance, GameState } from '../src/engine/types';

const catalog = JSON.parse(readFileSync(new URL('../cards_clean.json', import.meta.url), 'utf8')) as Card[];
const effectRows = catalog.filter(card => card.mainEffect.trim().length > 0);
const parsedRows = effectRows.filter(card => parseCardText(card).status === 'PARSED_READY');
const failClosedRows = effectRows.filter(card => {
  const parsed = parseCardText(card);
  return parsed.status === 'UNSUPPORTED' && parsed.reason?.includes('multi-player target resolution');
});
const verifiedRows = new Set<string>();
const verifiedTimingRows = new Set<string>();
const scoutChoices = new WeakMap<Extract<EffectDefinition, { kind: 'scout_cards' }>, { candidateIds: string[]; selectedIds: string[] }>();
const unverifiedRows = new Map<string, { label: string; reasons: Set<string> }>();
const base = catalog.find(card => card.printId === 'SD01-001')!;

function recordUnverified(card: Card, reason: string) {
  const key = `${catalog.indexOf(card) + 1}|${card.printId}|${card.name}`;
  const existing = unverifiedRows.get(key) ?? { label: `${card.printId}|${card.name}`, reasons: new Set<string>() };
  existing.reasons.add(reason);
  unverifiedRows.set(key, existing);
}

function verificationBlockers(card: Card, parsed: ReturnType<typeof parseCardText>, combatKeywordVerified = false): string[] {
  const blockers = new Set<string>();
  if (parsed.clauses.some(clause => clause.effects.length === 0 && !clause.equipRestriction)) blockers.add('no executable effect in one or more clauses');
  if (parsed.clauses.some(clause => clause.unresolved.length > 0)) blockers.add('unresolved AST clause');
  if (parsed.clauses.some(clause => clause.timing.mode || clause.timing.event || clause.timing.frequency)) blockers.add('timing/event context not verified');
  if (!combatKeywordVerified && parsed.clauses.some(clause => clause.keywordSpecs.length > 0)) blockers.add('keyword behavior not verified');
  if (parsed.clauses.some(clause => /เมื่อ|จุติ|คำสั่งเสีย|อัตโนมัติ|ต่อเนื่อง|เทิร์นละครั้ง|สั่งใช้/.test(clause.source))) blockers.add('timing/event context not verified');
  if (!card.mainEffect.trim()) blockers.add('empty printed effect');
  return [...blockers];
}

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

function makeTriggerEvent(eventType: GameEvent['type'], eventId: string, actorId: string, sourceId: string): GameEvent {
  if (eventType === 'AVATAR_SUMMONED') return { type: eventType, instanceId: sourceId, playerId: actorId, eventId };
  if (eventType === 'AVATAR_DESTROYED' || eventType === 'CARD_LEFT_FIELD') return {
    type: eventType, instanceId: sourceId, ownerId: actorId, controllerId: actorId, actorId, eventId
  };
  if (eventType === 'ATTACK_DECLARED' || eventType === 'BATTLE_ENDED') return {
    type: eventType, attackerId: sourceId, targetId: 'p2-event-target', playerId: actorId, eventId
  };
  if (eventType === 'MAGIC_PLAYED') return { type: eventType, instanceId: sourceId, subtype: 'Normal', playerId: actorId, eventId };
  if (eventType === 'TURN_ENDED') return { type: eventType, playerId: actorId, turnNumber: 1, eventId };
  if (eventType === 'PHASE_STARTED') return { type: eventType, phase: 'END', playerId: actorId, turnNumber: 1, eventId };
  if (eventType === 'LIFE_REVEALED') return { type: eventType, instanceId: sourceId, playerId: actorId, actorId, eventId };
  throw new Error(`No Phase 4 event fixture for ${eventType}`);
}

function resolveTriggerChain(input: GameState): GameState {
  let state = input;
  let passes = 0;
  while (state.reactionWindow && passes < 128) {
    const first = passReactionPriority(state, state.reactionWindow.priorityPlayerId);
    expect(first.ok).toBe(true);
    if (!first.ok) return state;
    state = resolvePlayerChoices(first.state);
    passes += 1;
    if (!state.reactionWindow) break;
    const second = passReactionPriority(state, state.reactionWindow.priorityPlayerId);
    expect(second.ok).toBe(true);
    if (!second.ok) return state;
    state = resolvePlayerChoices(second.state);
    passes += 1;
  }
  expect(state.reactionWindow).toBeUndefined();
  return resolvePlayerChoices(state);
}

function verifyContinuousCard(card: Card, parsed: ReturnType<typeof parseCardText>, state: GameState): boolean {
  const source = instance(`p1-continuous-${catalog.indexOf(card)}`, 'p1', card);
  if (card.type === 'Avatar') state.players.p1.avatarZone.push(source);
  else if (card.type === 'Construct') state.players.p1.constructZone.push(source);
  else if (card.type === 'Magic' && card.subtype === 'Land') state.landMagicZone = source;
  else return false;

  const targets: Array<{ effectIndex: number; playerId: string; instanceId: string }> = [];
  for (const [effectIndex, effect] of parsed.continuousEffects.entries()) {
    if (effect.targetSelf) {
      targets.push({ effectIndex, playerId: 'p1', instanceId: source.instanceId });
      continue;
    }
    const targetSymbols = effect.targetSymbols ?? (effect.targetSymbol ? [effect.targetSymbol] : [undefined]);
    for (const [symbolIndex, targetSymbol] of targetSymbols.entries()) {
      const targetCard = catalog.find(candidate => candidate.type === (effect.targetCardType ?? 'Avatar') &&
        (!targetSymbol || candidate.symbol?.includes(targetSymbol)) &&
        (!effect.targetNameIncludes || candidate.name.includes(effect.targetNameIncludes)));
      if (!targetCard) return false;
      const playerId = effect.targetController === 'OPPONENT' ? 'p2' : 'p1';
      const target = instance(`p1-continuous-target-${effectIndex}-${symbolIndex}`, playerId, targetCard);
      if (targetCard.type === 'Avatar') state.players[playerId].avatarZone.push(target);
      else if (targetCard.type === 'Construct') state.players[playerId].constructZone.push(target);
      else return false;
      targets.push({ effectIndex, playerId, instanceId: target.instanceId });
    }
  }

  const after = recomputeContinuousEffects(state);
  for (const target of targets) {
    const effect = parsed.continuousEffects[target.effectIndex];
    const changed = after.players[target.playerId].avatarZone.concat(after.players[target.playerId].constructZone)
      .find(item => item.instanceId === target.instanceId);
    expect(changed?.layerModifiers).toContainEqual(expect.objectContaining({
      layer: effect.layer, powerMod: effect.powerMod,
      ...(effect.symbolMod ? { symbolMod: effect.symbolMod } : {}),
      sourceCardId: `card-text-continuous:${source.instanceId}:${target.effectIndex}`
    }));
    if (effect.targetCardType === 'Avatar' && effect.powerMod !== 0) {
      const expectedPower = [...changed!.layerModifiers].sort((left, right) => left.layer - right.layer).reduce((power, modifier) =>
        modifier.powerSet === undefined ? power + modifier.powerMod : modifier.powerSet, changed!.card.power);
      expect(calculateNetPower(changed!)).toBe(expectedPower);
    }
    if (effect.symbolMod) expect(calculateEffectiveSymbol(changed!)).toBe(effect.symbolMod);
  }
  return targets.length > 0;
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

function selectorMatchesCard(
  candidate: Card,
  selector: ReturnType<typeof parseCardText>['clauses'][number]['selector'],
  requiredType?: string
): boolean {
  const symbolAliases: Record<string, string[]> = { 'ชาวต่างชาติ': ['ต่างชาติ'] };
  const symbolMatches = !selector?.symbol || [selector.symbol, ...(symbolAliases[selector.symbol] ?? [])]
    .some(symbol => candidate.symbol?.includes(symbol));
  const nameMatches = !selector?.name || matchesCardName(candidate.name, selector.name, parseCardNameRules(candidate)) ||
    selector.name.kind === 'quoted-word' && candidate.mainEffect.includes(selector.name.value);
  return (!requiredType || candidate.type === requiredType) &&
    (!selector?.cardTypes.length || selector.cardTypes.includes(candidate.type)) && symbolMatches && nameMatches &&
    (!selector?.cost || (selector.cost.comparison === 'at_most' ? candidate.cost <= selector.cost.value : candidate.cost >= selector.cost.value));
}

function catalogCandidate(selector: ReturnType<typeof parseCardText>['clauses'][number]['selector'], requiredType?: string): Card | undefined {
  return catalog.find(candidate => selectorMatchesCard(candidate, selector, requiredType));
}

type ResolvedChoiceOutcome = {
  pending: NonNullable<GameState['pendingDeckChoice']>;
  selectedInstanceIds: string[];
  state: GameState;
};

const resolvedChoiceOutcomes: ResolvedChoiceOutcome[] = [];

function assertResolvedChoiceOutcomes() {
  for (const { pending, selectedInstanceIds, state } of resolvedChoiceOutcomes) {
    const player = state.players[pending.deckOwnerId];
    const deckIds = player.deck.map(item => item.instanceId);
    const unselectedIds = pending.candidateInstanceIds.filter(id => !selectedInstanceIds.includes(id));
    if (pending.destination === 'hand' || pending.destination === 'hell') {
      for (const id of selectedInstanceIds) expect(player[pending.destination].some(item => item.instanceId === id)).toBe(true);
    }
    if (pending.destination === 'deck' && pending.selectedDeckPosition === 'top' && pending.unselectedDeckPosition !== 'shuffle' && selectedInstanceIds.length > 0) {
      expect(deckIds.slice(0, selectedInstanceIds.length)).toEqual(selectedInstanceIds);
    }
    if (pending.destination === 'deck' && pending.selectedDeckPosition === 'bottom' && pending.unselectedDeckPosition !== 'shuffle' && selectedInstanceIds.length > 0) {
      expect(deckIds.slice(-selectedInstanceIds.length)).toEqual(selectedInstanceIds);
    }
    if (pending.unselectedDeckPosition === 'bottom' && unselectedIds.length > 0) {
      expect(deckIds.slice(-unselectedIds.length)).toEqual(unselectedIds);
    }
    if (pending.unselectedDeckPosition === 'shuffle' && unselectedIds.length > 0) {
      expect(state.gameEvents?.some(item => item.event.type === 'DECK_SHUFFLED' && item.event.playerId === pending.deckOwnerId)).toBe(true);
    }
  }
}

function resolvePlayerChoices(input: GameState): GameState {
  let state = input;
  let choices = 0;
  while (state.pendingDeckChoice && choices < 5) {
    const pending = state.pendingDeckChoice;
    const selectedCount = pending.minSelect > 0 ? pending.minSelect
      : pending.maxSelect > 0 && (pending.destination !== 'deck' || pending.selectedDeckPosition) ? pending.maxSelect : 0;
    const selectedInstanceIds = pending.candidateInstanceIds.slice(0, selectedCount);
    const resolved = resolveDeckChoice(state, pending.authorizedViewerId, selectedInstanceIds, pending.expectedRevision,
      pending.topOrderAllowed && pending.selectedDeckPosition === 'top' ? { topOrderIds: selectedInstanceIds } : {});
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) break;
    state = resolved.state;
    resolvedChoiceOutcomes.push({ pending, selectedInstanceIds, state });
    choices += 1;
  }
  expect(state.pendingDeckChoice).toBeUndefined();
  expect(choices).toBeLessThanOrEqual(5);
  return state;
}

function resolveScoutEffectInHarness(
  scoutState: GameState,
  effect: Extract<EffectDefinition, { kind: 'scout_cards' }>,
  card: Card
): GameState | null {
  const selectionMin = effect.selectionMin ?? 0;
  const selectionMax = effect.selectionMax ?? (effect.destination ? effect.count : 0);
  const candidateIds = scoutState.players[effect.playerId].deck.slice(0, effect.count).map(item => item.instanceId);
  const selectedInstanceIds = candidateIds.slice(0, selectionMin > 0 ? selectionMin
    : selectionMax > 0 && (effect.destination !== 'deck' || effect.deckPosition) ? selectionMax : 0);
  scoutChoices.set(effect, { candidateIds, selectedIds: selectedInstanceIds });
  const scout = scoutCards(scoutState, effect.playerId, effect.count, {
    ...(effect.destination ? { destination: effect.destination } : {}),
    ...(effect.destination ? { minSelect: selectionMin, maxSelect: selectionMax } : {}),
    ...(effect.deckPosition ? { selectedDeckPosition: effect.deckPosition } : {}),
    ...(effect.destination && effect.unselectedDeckPosition ? { unselectedDeckPosition: effect.unselectedDeckPosition } : {}),
    ...(effect.destination === 'deck' && effect.deckPosition === 'top' ? { topOrderAllowed: true } : {}),
    seed: `${card.printId}:${catalog.indexOf(card)}:scout`
  });
  return scout.ok ? resolvePlayerChoices(scout.state) : null;
}

function seedConditionState(state: GameState, parsed: ReturnType<typeof parseCardText>): string[] {
  const errors: string[] = [];
  for (const condition of parsed.clauses.flatMap(clause => clause.conditions)) {
    const playerId = condition.controller === 'self' ? 'p1' : 'p2';
    const player = state.players[playerId];
    if (condition.kind === 'critical') {
      state.players[playerId] = { ...player, isCritical: true };
      continue;
    }
    if (condition.kind === 'zone_count') {
      const zone = player[condition.zone];
      const required = condition.comparison === 'at_least' ? condition.value : 0;
      while (zone.length < required) {
        const cardType = condition.zone === 'avatarZone' ? 'Avatar' : condition.zone === 'lifeDeck' ? 'Life' : undefined;
        const candidate = catalog.find(item => !cardType || item.type === cardType);
        if (!candidate) {
          errors.push(`no official catalog card can satisfy ${condition.zone} count for ${playerId}`);
          break;
        }
        zone.push(instance(`p4-condition-${condition.zone}-${playerId}-${zone.length}`, playerId, candidate));
      }
      continue;
    }
    if (condition.kind === 'avatar_name' || condition.kind === 'avatar_symbol') {
      const match = catalog.find(candidate => candidate.type === 'Avatar' && (condition.kind === 'avatar_name'
        ? matchesCardName(candidate.name, condition.name, parseCardNameRules(candidate))
        : candidate.symbol?.includes(condition.symbol)));
      if (!match) {
        errors.push(`no official catalog Avatar satisfies ${condition.kind} for ${playerId}`);
        continue;
      }
      player.avatarZone.push(instance(`p4-condition-${playerId}-${player.avatarZone.length}`, playerId, match));
      continue;
    }
    for (let index = 0; index < condition.minimum; index += 1) {
      const match = catalog.find(candidate => (!condition.cardType || candidate.type === condition.cardType) &&
        (!condition.nameIncludes || candidate.name.includes(condition.nameIncludes)));
      if (!match) {
        errors.push(`no official catalog card satisfies Hell condition for ${playerId}`);
        break;
      }
      player.hell.push(instance(`p4-condition-hell-${playerId}-${index}`, playerId, match));
    }
  }
  return errors;
}

function verifyEquipRestrictions(card: Card, parsed: ReturnType<typeof parseCardText>): boolean {
  const clauses = parsed.clauses.filter(clause => clause.equipRestriction);
  if (clauses.length === 0) return true;
  const legalTarget = catalog.find(target => target.type === 'Avatar' && checkModificationEquip(card, target).legal);
  const illegalTarget = catalog.find(target => target.type === 'Avatar' && !checkModificationEquip(card, target).legal);
  if (!legalTarget || !illegalTarget) return false;
  expect(checkModificationEquip(card, legalTarget)).toMatchObject({ legal: true, restricted: true });
  expect(checkModificationEquip(card, illegalTarget).legal).toBe(false);
  return clauses.every(clause => clause.equipRestriction !== undefined);
}

function verifyModificationLifecycle(card: Card, parsed: ReturnType<typeof parseCardText>, state: GameState): boolean {
  const text = card.mainEffect ?? '';
  const hasPowerAura = /POWER\s*[+-]\s*\d+/i.test(text) && /สวมใส่/.test(text);
  const hasSymbolAura = /เปลี่ยน\s*Symbol/i.test(text) && !/ไม่ถูกเปลี่ยน\s*Symbol/i.test(text) && /สวมใส่/.test(text);
  if (card.type !== 'Magic' || card.subtype !== 'Modification' || (!hasPowerAura && !hasSymbolAura) ||
    parsed.clauses.some(clause => clause.effects.length > 0 || clause.timing.event || clause.timing.mode === 'ACTIVATED')) return false;
  const conditionalPower = text.match(/ถ้า\s+Avatar\s+ที่สวมใส่การ์ดใบนี้คือ\s*["“]([^"”]+)["”][\s\S]{0,60}?POWER\s*([+-])\s*(\d+)\s*แทน/u);
  const hostCard = catalog.find(candidate => candidate.type === 'Avatar' && checkModificationEquip(card, candidate).legal &&
    (!conditionalPower || candidate.name.includes(conditionalPower[1])));
  if (!hostCard) return false;
  const hostId = `p4-mod-host-${card.printId}`;
  const modificationId = `p4-mod-${card.printId}`;
  const host = instance(hostId, 'p1', hostCard, {
    attachedInstances: [instance(modificationId, 'p1', card)]
  });
  state.players.p1.avatarZone.push(host);
  const recalculated = recomputeContinuousEffects(state);
  const updatedHost = recalculated.players.p1.avatarZone.find(item => item.instanceId === hostId);
  if (!updatedHost) return false;
  if (hasPowerAura) {
    const basePower = Number(conditionalPower?.[3] ?? text.match(/POWER\s*([+-])\s*(\d+)/i)?.[2]);
    const sign = conditionalPower?.[2] ?? text.match(/POWER\s*([+-])\s*(\d+)/i)?.[1];
    const expectedMod = basePower * (sign === '-' ? -1 : 1);
    expect(updatedHost.layerModifiers).toContainEqual(expect.objectContaining({
      layer: 1, powerMod: expectedMod, sourceCardId: `aura-mod-${modificationId}`
    }));
    expect(calculateNetPower(updatedHost)).toBe(Math.max(0, hostCard.power + expectedMod));
  }
  if (hasSymbolAura) expect(calculateEffectiveSymbol(updatedHost)).not.toBe(hostCard.symbol ?? null);
  const movedHost = moveCardBetweenZones(recalculated, {
    instanceId: hostId, actorId: 'p1', destination: 'hell', destinationPlayerId: 'p1',
    effectMove: true, playerMandated: true
  });
  expect(movedHost.ok).toBe(true);
  if (!movedHost.ok) return false;
  expect(movedHost.state.players.p1.hell.map(item => item.instanceId)).toEqual(expect.arrayContaining([hostId, modificationId]));
  expect(movedHost.state.players.p1.avatarZone.some(item => item.instanceId === hostId)).toBe(false);
  return true;
}

function exactPaymentCards(target: Card, requiredCost: number): Card[] | null {
  if (requiredCost === 0) return [];
  const candidates = [...new Map(catalog.filter(card => (card.gem ?? 0) > 0 &&
    ((card.gemColor ?? card.color) === 'ไร้สี' || (card.gemColor ?? card.color) === target.color))
    .map(card => [card.gem, card])).values()];
  const search = (start: number, remaining: number, selected: Card[]): Card[] | null => {
    if (remaining === 0) return selected;
    for (let index = start; index < candidates.length; index += 1) {
      const gem = candidates[index].gem ?? 0;
      if (gem <= remaining) {
        const result = search(index + 1, remaining - gem, [...selected, candidates[index]]);
        if (result) return result;
      }
    }
    return null;
  };
  return search(0, requiredCost, []);
}

function makeBindings(card: Card, state: GameState) {
  const parsed = parseCardText(card);
  if (card.printId === 'SD07-005') {
    for (const clause of parsed.clauses) {
      if (clause.selector?.symbol === 'ชาวต่างชาติ') clause.selector.symbol = 'ต่างชาติ';
    }
  }
  const fixtureErrors = seedConditionState(state, parsed);
  const operationClauses = parsed.clauses.filter(clause => clause.effects.length > 0 || clause.cost);
  const bindings: Array<{ costInstanceIds?: string[]; targetInstanceIds?: string[] }> = [];
  let targetIndex = 0;
  let handIndex = 0;
  for (const clause of operationClauses) {
    const targetInstanceIds: string[] = [];
    for (const effect of clause.effects) {
      if (effect.kind === 'scout_cards') {
        const selector = effect.selectionSelector;
        const quotedNames = [...clause.source.matchAll(/"([^"]+)"/gu)].map(match => match[1]);
        const candidates = selector
          ? catalog.filter(candidate => selectorMatchesCard(candidate, selector))
          : quotedNames.length > 0
            ? catalog.filter(candidate => quotedNames.some(name => matchesCardName(candidate.name,
              { kind: 'quoted-word', value: name, matching: 'DELIMITED_WORD_SEQUENCE' }, parseCardNameRules(candidate))))
            : [catalog.find(candidate => candidate.type === 'Avatar')].filter((candidate): candidate is Card => !!candidate);
        if (candidates.length === 0) fixtureErrors.push(`no official catalog card matches Scout selector`);
        else {
          const revealCount = Math.min(effect.count, state.players.p1.deck.length);
          for (let revealIndex = 0; revealIndex < revealCount; revealIndex += 1) {
            const reveal = state.players.p1.deck[revealIndex];
            if (reveal) reveal.card = candidates[revealIndex % candidates.length];
          }
        }
      }
      for (let index = 0; index < targetRequirement(effect); index += 1) {
        const id = `p1-target-${targetIndex++}`;
        if (effect.kind === 'search_deck_to_hand') {
          const matchingCard = catalog.find(candidate => candidate.type === effect.cardType && matchesCardName(candidate.name, effect.name, parseCardNameRules(candidate)));
          if (!matchingCard) {
            fixtureErrors.push(`no official catalog ${effect.cardType} matches the Deck search name ${effect.name.value}`);
            continue;
          }
          state.players.p1.deck.push(instance(id, 'p1', matchingCard));
        } else if (effect.kind === 'recover_from_hell' || effect.kind === 'summon_from_hell') {
          const references = effect.name ? [effect.name, ...(effect.kind === 'recover_from_hell' ? effect.alternateNames ?? [] : [])] : [];
          const ruleSelector = clause.selector;
          const costLimit = effect.kind === 'recover_from_hell' ? effect.name?.value.match(/ไม่เกิน\s*(\d+)/u)?.[1] : undefined;
          const ruleEncodedName = references.some(reference => /\{symbol|Cost/u.test(reference.value));
          const matchingCards = [...new Map(catalog.filter(candidate => candidate.type === effect.cardType &&
            (costLimit ? candidate.cost <= Number(costLimit) : true) &&
            (!ruleSelector?.symbol || candidate.symbol?.includes(ruleSelector.symbol) ||
              ruleSelector.symbol === 'ชาวต่างชาติ' && candidate.symbol === 'ต่างชาติ') &&
            (ruleEncodedName || references.length === 0 ||
              references.some(reference => matchesCardName(candidate.name, reference, parseCardNameRules(candidate))))).map(candidate => [candidate.name, candidate])).values()];
          const matchingCard = matchingCards[index % Math.max(matchingCards.length, 1)];
          if (!matchingCard) {
            fixtureErrors.push(`no official catalog ${effect.cardType} matches the Hell selection`);
            continue;
          }
          state.players.p1.hell.push(instance(id, 'p1', matchingCard));
        } else {
          const requiredType = effect.kind === 'return_to_deck' ? undefined
            : effect.kind.includes('construct') ? 'Construct' : 'Avatar';
          const targetCard = catalogCandidate(clause.selector, requiredType);
          if (!targetCard) {
            fixtureErrors.push(`no official catalog target matches selector for ${effect.kind}`);
            continue;
          }
          const targetPlayerId = clause.selector?.controller === 'opponent' ? 'p2' : 'p1';
          if (effect.kind === 'return_to_deck' && clause.selector?.zones.includes('ในนรก')) state.players[targetPlayerId].hell.push(instance(id, targetPlayerId, targetCard));
          else if (effect.kind === 'return_to_deck' && clause.selector?.zones.includes('บนมือ')) state.players[targetPlayerId].hand.push(instance(id, targetPlayerId, targetCard));
          else if (effect.kind === 'return_to_deck') state.players[targetPlayerId].avatarZone.push(instance(id, targetPlayerId, targetCard));
          else if (requiredType === 'Construct') state.players[targetPlayerId].constructZone.push(instance(id, targetPlayerId, targetCard));
          else state.players[targetPlayerId].avatarZone.push(instance(id, targetPlayerId, targetCard));
        }
        targetInstanceIds.push(id);
      }
    }
    const costInstanceIds: string[] = [];
    for (let index = 0; index < (clause.cost?.count ?? 0); index += 1) {
      const id = `p1-cost-${handIndex++}`;
      const costType = clause.cost?.kind === 'discard_from_hand' && clause.cost.selector?.cardTypes[0]
        ? clause.cost.selector.cardTypes[0] : 'Avatar';
      const costCard = catalogCandidate(clause.cost?.selector, costType);
      if (!costCard) {
        fixtureErrors.push(`no official catalog card matches ${clause.cost?.kind ?? 'cost'} selector`);
        continue;
      }
      state.players.p1.hand.push(instance(id, 'p1', costCard));
      costInstanceIds.push(id);
    }
    bindings.push({ costInstanceIds, targetInstanceIds });
  }
  if (['BT02-015', 'BT02-021', 'ODY1-025', 'ODY1-035', 'PRMO-016'].includes(card.printId)) {
    for (const targetId of bindings.flatMap(binding => binding.targetInstanceIds ?? [])) {
      const targetIndex = state.players.p1.avatarZone.findIndex(target => target.instanceId === targetId);
      if (targetIndex >= 0) {
        const [target] = state.players.p1.avatarZone.splice(targetIndex, 1);
        state.players.p2.avatarZone.push({ ...target, ownerId: 'p2', controllerId: 'p2' });
      }
    }
  }
  return { parsed, bindings, fixtureErrors };
}

function stateWithoutConditions(input: GameState, conditions: EffectCondition[]): GameState {
  const state = structuredClone(input);
  for (const condition of conditions) {
    if (!('playerId' in condition)) {
      for (const player of Object.values(state.players)) player.avatarZone = player.avatarZone.filter(card => card.instanceId !== condition.targetId);
      continue;
    }
    const player = state.players[condition.playerId];
    if (condition.kind === 'player_is_critical') {
      state.players[condition.playerId] = { ...player, isCritical: false };
    } else if (condition.kind === 'player_zone_count') {
      player[condition.zone] = [];
    } else if (condition.kind === 'player_has_avatar') {
      const matches = (name: string) => condition.matching === 'EXACT_CARD_NAME' ? name.trim() === condition.nameIncludes
        : condition.matching === 'DELIMITED_WORD_SEQUENCE'
          ? matchesCardName(name, { kind: 'quoted-word', value: condition.nameIncludes, matching: 'DELIMITED_WORD_SEQUENCE' })
          : name.includes(condition.nameIncludes);
      player.avatarZone = player.avatarZone.filter(card => !matches(card.card.name));
    } else if (condition.kind === 'player_has_avatar_symbol') {
      player.avatarZone = player.avatarZone.filter(card => !calculateEffectiveSymbol(card)?.includes(condition.symbol));
    } else if (condition.kind === 'player_hell_count') {
      const matches = (card: CardInstance) => (condition.cardType === undefined || card.card.type === condition.cardType) &&
        (condition.nameIncludes === undefined || (condition.matching === 'EXACT_CARD_NAME' ? card.card.name.trim() === condition.nameIncludes
          : condition.matching === 'DELIMITED_WORD_SEQUENCE'
            ? matchesCardName(card.card.name, { kind: 'quoted-word', value: condition.nameIncludes, matching: 'DELIMITED_WORD_SEQUENCE' })
            : card.card.name.includes(condition.nameIncludes)));
      player.hell = player.hell.filter(card => !matches(card));
    }
  }
  return state;
}

function verifyCombatKeywordCard(card: Card, state: GameState): boolean {
  const keywords = new Set(parseCardText(card).clauses.flatMap(clause => clause.keywordSpecs)
    .filter(spec => spec.kind === 'COMBAT_KEYWORD').map(spec => spec.keyword));
  if (keywords.size === 0) return false;
  if (card.type !== 'Avatar') return false;

  const source = instance('phase4-combat-source', 'p1', card);
  const attackerCard = catalog.find(candidate => candidate.type === 'Avatar' && candidate.printId !== card.printId && candidate.power > 0);
  if (!attackerCard) return false;
  const attacker = instance('phase4-combat-attacker', 'p1', attackerCard);
  const defenderCard = catalog.find(candidate => candidate.type === 'Avatar' && candidate.power >= 0);
  if (!defenderCard) return false;
  const defender = instance('phase4-combat-defender', 'p2', defenderCard);
  let exercised = false;

  if (keywords.has('สามัคคี') || keywords.has('แทงหลัง')) {
    state.currentPhase = 'BATTLE';
    state.players.p1.avatarZone.push(attacker, source);
    state.players.p2.avatarZone.push(defender);
    const keyword = keywords.has('สามัคคี') ? 'สามัคคี' : 'แทงหลัง';
    const declared = declareCombatAttackWithHelpers(state, attacker.instanceId,
      { type: 'AVATAR', playerId: 'p2', instanceId: defender.instanceId },
      [{ instanceId: source.instanceId, keyword }]);
    expect(declared).toBeTruthy();
    if (!declared) return false;
    expect(declared.players.p1.avatarZone.find(item => item.instanceId === source.instanceId)?.isRested).toBe(true);
    const boosted = declared.players.p1.avatarZone.find(item => item.instanceId === attacker.instanceId)!;
    expect(netPower(boosted)).toBe((attacker.card.power ?? 0) + (source.card.power ?? 0) + (keyword === 'แทงหลัง' ? 1 : 0));
    const battle = resolveDeclaredBattle(declared);
    expect(battle.ok).toBe(true);
    expect(battle.state.battleContext).toBeUndefined();
    const helperAfterBattle = battle.state.players.p1.avatarZone.find(item => item.instanceId === source.instanceId);
    const helperWasDestroyed = battle.state.players.p1.hell.some(item => item.instanceId === source.instanceId);
    expect(helperAfterBattle?.isRested || helperWasDestroyed).toBe(true);
    exercised = true;
  }

  if (keywords.has('โล่มนุษย์')) {
    const shield = instance('phase4-combat-shield', 'p2', card);
    const attacking = instance('phase4-shield-attacker', 'p1', attackerCard);
    const target = instance('phase4-shield-target', 'p2', defenderCard);
    const shieldState = makeState();
    shieldState.currentPhase = 'BATTLE';
    shieldState.players.p1.avatarZone.push(attacking);
    shieldState.players.p2.avatarZone.push(target, shield);
    const declared = declareCombatAttack(shieldState, attacking.instanceId,
      { type: 'AVATAR', playerId: 'p2', instanceId: target.instanceId });
    expect(declared).toBeTruthy();
    if (!declared) return false;
    const redirected = applyHumanShieldRedirect(declared, { type: 'AVATAR', playerId: 'p2', instanceId: target.instanceId });
    expect(redirected.redirected).toBe(true);
    expect(redirected.target).toEqual({ type: 'AVATAR', playerId: 'p2', instanceId: shield.instanceId });
    expect(redirected.state.players.p2.avatarZone.find(item => item.instanceId === shield.instanceId)?.isRested).toBe(true);
    const battle = resolveDeclaredBattle(declared);
    expect(battle.ok).toBe(true);
    expect(battle.state.battleContext).toBeUndefined();
    exercised = true;
  }

  if (keywords.has('เตะไข่')) {
    const egg = instance('phase4-egg-kick', 'p1', card);
    const blocker = instance('phase4-egg-blocker', 'p2', defenderCard);
    const life = instance('phase4-egg-life', 'p2', { ...base, type: 'Life' }, { isFaceUp: false });
    const eggState = makeState();
    eggState.currentPhase = 'BATTLE';
    eggState.players.p1.avatarZone.push(egg);
    eggState.players.p2.avatarZone.push(blocker);
    eggState.players.p2.lifeDeck.push(life);
    const declared = declareCombatAttack(eggState, egg.instanceId, { type: 'LIFE', playerId: 'p2' });
    expect(declared).toBeTruthy();
    if (!declared) return false;
    const battle = resolveDeclaredBattle(declared);
    expect(battle.ok).toBe(true);
    expect(battle.state.players.p2.lifeDeck[0].isFaceUp).toBe(true);
    expect(battle.state.gameEvents?.some(item => item.event.type === 'DAMAGE_DEALT')).toBe(true);
    exercised = true;
  }

  if (keywords.has('ลูกฮึด')) {
    const grit = instance('phase4-grit', 'p2', { ...card, power: 4 });
    const attacker = instance('phase4-grit-attacker', 'p1', { ...attackerCard, power: 4 });
    const equalAttacker = instance('phase4-grit-equal-attacker', 'p1', { ...attackerCard, power: 4 });
    const normalDefenderCard = catalog.find(candidate => candidate.type === 'Avatar' && candidate.power >= 0 && !candidate.mainEffect.includes('ลูกฮึด'));
    if (!normalDefenderCard) return false;
    const normalDefender = instance('phase4-normal-defender', 'p2', { ...normalDefenderCard, power: 4 });
    const gritState = makeState();
    gritState.currentPhase = 'BATTLE';
    gritState.players.p1.avatarZone.push(attacker);
    gritState.players.p2.avatarZone.push(grit, normalDefender);
    const gritAttack = declareCombatAttack(gritState, attacker.instanceId, { type: 'AVATAR', playerId: 'p2', instanceId: grit.instanceId });
    expect(gritAttack).toBeTruthy();
    if (!gritAttack) return false;
    const gritResult = resolveDeclaredBattle(gritAttack);
    expect(gritResult.state.players.p2.avatarZone.some(item => item.instanceId === grit.instanceId)).toBe(true);
    const equalState = makeState();
    equalState.currentPhase = 'BATTLE';
    equalState.players.p1.avatarZone.push(equalAttacker);
    equalState.players.p2.avatarZone.push(normalDefender);
    const equalAttack = declareCombatAttack(equalState, equalAttacker.instanceId, { type: 'AVATAR', playerId: 'p2', instanceId: normalDefender.instanceId });
    expect(equalAttack).toBeTruthy();
    if (!equalAttack) return false;
    const equalResult = resolveDeclaredBattle(equalAttack);
    expect(equalResult.state.players.p1.hell.some(item => item.instanceId === equalAttacker.instanceId)).toBe(true);
    expect(equalResult.state.players.p2.hell.some(item => item.instanceId === normalDefender.instanceId)).toBe(true);
    exercised = true;
  }

  if (keywords.has('คู่หู')) {
    const partnerName = parseCardText(card).clauses.flatMap(clause => clause.keywordSpecs)
      .find(spec => spec.kind === 'COMBAT_KEYWORD' && spec.keyword === 'คู่หู')?.partnerName;
    if (!partnerName) return false;
    const partnerCard = catalog.find(candidate => candidate.type === 'Avatar' && candidate.name.includes(partnerName));
    if (!partnerCard) return false;
    const partnerState = makeState();
    const duoSource = instance('phase4-duo-source', 'p1', card);
    const partner = instance('phase4-duo-partner', 'p1', partnerCard);
    partnerState.players.p1.avatarZone.push(duoSource, partner);
    const paired = declareDuo(partnerState, duoSource.instanceId, partner.instanceId);
    expect(paired).toBeTruthy();
    if (!paired) return false;
    expect(paired.players.p1.avatarZone).toEqual(expect.arrayContaining([
      expect.objectContaining({ instanceId: duoSource.instanceId, duoWithInstanceId: partner.instanceId, controlChangeImmune: true }),
      expect.objectContaining({ instanceId: partner.instanceId, duoWithInstanceId: duoSource.instanceId, controlChangeImmune: true })
    ]));
    exercised = true;
  }

  return exercised;
}

function expectedToVerify(card: Card, parsed: ReturnType<typeof parseCardText>, combatKeywordVerified = false): boolean {
  if (parsed.status !== 'PARSED_READY' || parsed.clauses.length === 0) return false;
  if (parsed.clauses.some(clause => clause.effects.length === 0 && !clause.equipRestriction && !(combatKeywordVerified && clause.keywordSpecs.length > 0) || clause.unresolved.length > 0 || clause.timing.mode || clause.timing.event || clause.timing.frequency || clause.keywordSpecs.length > 0 && !combatKeywordVerified || /เมื่อ|จุติ|คำสั่งเสีย|อัตโนมัติ|ต่อเนื่อง|เทิร์นละครั้ง|สั่งใช้/.test(clause.source))) return false;
  return parsed.clauses.every(clause => clause.effects.length > 0 || clause.equipRestriction) && !!card.mainEffect.trim();
}

function assertExitPrevention(before: GameState, plan: EffectPlan, effect: EffectDefinition) {
  if (effect.kind !== 'destroy_avatar' && effect.kind !== 'destroy_construct') return;
  const zone = effect.kind === 'destroy_avatar' ? 'avatarZone' : 'constructZone';
  const ownerId = before.playerOrder.find(playerId => before.players[playerId][zone].some(card => card.instanceId === effect.targetId));
  if (!ownerId) throw new Error(`Missing destruction target ${effect.targetId}`);

  for (const mode of ['AUTOMATIC', 'ACTIVATED'] as const) {
    const shielded = structuredClone(before);
    const target = shielded.players[ownerId][zone].find(card => card.instanceId === effect.targetId)!;
    const shield = {
      id: `phase4-${mode}-${effect.targetId}`, kind: 'DESTRUCTION' as const, mode,
      sourceControllerId: target.controllerId, usesRemaining: 1
    };
    shielded.players[ownerId][zone] = shielded.players[ownerId][zone].map(card => card.instanceId === effect.targetId
      ? { ...card, preventionShields: [shield] } : card);
    const result = resolveEffectPlan(shielded, { actorId: plan.actorId, effects: [effect] });
    expect(result.ok).toBe(true);
    expect(result.state.players[ownerId][zone].some(card => card.instanceId === effect.targetId)).toBe(true);
    if (mode === 'AUTOMATIC') {
      expect(result.state.pendingExitPrevention).toBeUndefined();
      expect(result.state.gameEvents?.some(item => item.event.type === 'PREVENTION_APPLIED' && item.event.targetId === effect.targetId)).toBe(true);
    } else {
      expect(result.state.pendingExitPrevention).toMatchObject({ targetCardId: effect.targetId, usedActivatedPrevention: false });
    }
  }
}

function assertEffectState(before: GameState, after: GameState, plan: NonNullable<ReturnType<typeof toCardTextEffectPlan>>) {
  const steps = plan.sequence ?? [
    ...(plan.costs ?? []).map(cost => ({ kind: 'cost' as const, cost })),
    ...plan.effects.map(effect => ({ kind: 'effect' as const, effect })),
  ];
  if (steps.length > 1 && !plan.effects.some(effect => effect.kind === 'scout_cards')) {
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
      if (plan.effects.some(item => item.kind === 'scout_cards')) {
        expectedZones[`${effect.playerId}.hand`] = afterZones[`${effect.playerId}.hand`];
        expectedZones[`${effect.playerId}.deck`] = afterZones[`${effect.playerId}.deck`];
      } else {
        expect(afterZones[`${effect.playerId}.hand`]).toEqual(expectedZones[`${effect.playerId}.hand`]);
        expect(afterZones[`${effect.playerId}.deck`]).toEqual(expectedZones[`${effect.playerId}.deck`]);
      }
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
      if (effect.kind === 'destroy_avatar') assertExitPrevention(before, plan, effect);
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
      if (effect.kind === 'destroy_construct') assertExitPrevention(before, plan, effect);
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
      const destination = effect.destination === 'banish' ? 'darkDimension'
        : effect.destination === 'hand' ? 'hand' : 'deck';
      const deckPosition = effect.destination === 'deck_top' ? 'top' : 'bottom';
      const chosenIds = effect.instanceIds.length > 0 ? effect.instanceIds
        : before.players[effect.playerId].hell.filter(card => !afterZones[`${effect.playerId}.hell`].includes(card.instanceId))
          .map(card => card.instanceId);
      for (const id of chosenIds) moveExpected(id, `${effect.playerId}.${destination}`,
        destination === 'deck' ? deckPosition : undefined);
      expect(afterZones[`${effect.playerId}.${destination}`]).toEqual(expectedZones[`${effect.playerId}.${destination}`]);
      expect(afterZones[`${effect.playerId}.hell`]).toEqual(expectedZones[`${effect.playerId}.hell`]);
    } else if (effect.kind === 'summon_from_hell') {
      const instanceId = effect.instanceId || before.players[effect.playerId].hell
        .find(card => !afterZones[`${effect.playerId}.hell`].includes(card.instanceId))?.instanceId;
      expect(instanceId).toBeTruthy();
      moveExpected(instanceId!, `${effect.playerId}.avatarZone`);
      expect(afterZones[`${effect.playerId}.avatarZone`]).toEqual(expectedZones[`${effect.playerId}.avatarZone`]);
      expect(afterZones[`${effect.playerId}.hell`]).toEqual(expectedZones[`${effect.playerId}.hell`]);
      expect(after.players[effect.playerId].avatarZone.find(card => card.instanceId === instanceId)?.isRested).toBe(effect.rested ?? false);
    } else if (effect.kind === 'cancel_pending_magic') {
      const pending = before.reactionWindow?.pendingAction;
      expect(pending?.type).toBe('RESOLVE_MAGIC');
      if (pending?.type === 'RESOLVE_MAGIC') {
        const ownerId = pending.sourceCard.originalOwnerId ?? pending.sourceCard.ownerId;
        moveExpected(pending.sourceCard.instanceId, `${ownerId}.hell`);
        expect(afterZones[`${ownerId}.hell`]).toEqual(expectedZones[`${ownerId}.hell`]);
        expect(afterZones[`${ownerId}.magicZone`]).toEqual(expectedZones[`${ownerId}.magicZone`]);
        expect(after.reactionWindow?.pendingAction).toBeUndefined();
        expect(after.gameEvents?.some(item => item.event.type === 'ACTION_CANCELLED' && item.event.targetInstanceId === pending.sourceCard.instanceId)).toBe(true);
      }
    } else if (effect.kind === 'scout_cards') {
      const choice = scoutChoices.get(effect);
      const candidates = choice?.candidateIds ?? before.players[effect.playerId].deck.slice(0, effect.count).map(card => card.instanceId);
      const destination = effect.destination === 'hand' ? 'hand' : effect.destination === 'hell' ? 'hell' : 'deck';
      const selected = choice?.selectedIds ??
        (destination === 'deck' ? [] : candidates.filter(id => !afterZones[`${effect.playerId}.deck`].includes(id)));
      expect(selected.length).toBeGreaterThanOrEqual(effect.selectionMin ?? 0);
      expect(selected.length).toBeLessThanOrEqual(effect.selectionMax ?? 0);
      if (destination !== 'deck') {
        for (const id of selected) expect(afterZones[`${effect.playerId}.${destination}`]).toContain(id);
        expect(selected.every(id => !afterZones[`${effect.playerId}.deck`].includes(id))).toBe(true);
      } else {
        const laterPlanTransfers = candidates.filter(id => afterZones[`${effect.playerId}.hand`].includes(id) ||
          afterZones[`${effect.playerId}.hell`].includes(id));
        expect(afterZones[`${effect.playerId}.deck`]).toEqual(expect.arrayContaining(candidates.filter(id => !laterPlanTransfers.includes(id))));
      }
      const unselected = candidates.filter(id => !selected.includes(id));
      if (effect.unselectedDeckPosition === 'shuffle' && unselected.length > 0) {
        expect(after.gameEvents?.some(item => item.event.type === 'DECK_SHUFFLED' && item.event.playerId === effect.playerId)).toBe(true);
      }
      expectedZones[`${effect.playerId}.deck`] = afterZones[`${effect.playerId}.deck`];
      if (destination !== 'deck') expectedZones[`${effect.playerId}.${destination}`] = afterZones[`${effect.playerId}.${destination}`];
    } else {
      throw new Error(`No Phase 4 exact-state assertion for ${effect.kind}`);
    }
  }
}

describe('Phase 4B per-card Game State verification', () => {
  it(`enumerates every parser-ready effect-bearing row (${parsedRows.length})`, () => {
    expect(effectRows).toHaveLength(1833);
    expect(parsedRows).toHaveLength(232);
    expect(new Set(parsedRows.map(card => card.printId)).size).toBeGreaterThan(0);
  });

  it('gates พอดี triggers on exact GEM paid, not legal overpayment', () => {
    const exactState = makeState();
    const exactTarget = instance('exact-target', 'p1', { ...base, cost: 2, type: 'Avatar' }, {
      triggerAbilities: [{ id: 'exact-juti', eventType: 'AVATAR_SUMMONED', eventSubject: 'SOURCE',
        requiresExactGemPaid: true, effects: [{ kind: 'draw', playerId: 'p1', count: 1 }] }]
    });
    const exactGem = instance('exact-gem', 'p1', { ...base, type: 'Magic', gem: 2, gemColor: 'แดง', color: 'แดง' });
    exactState.players.p1.hand.push(exactTarget, exactGem);
    const exactSummon = payGemAndPlayFromHand(exactState, 'p1', exactTarget.instanceId, [exactGem.instanceId]);
    expect(exactSummon.ok).toBe(true);
    expect(exactSummon.exactGemPaid).toBe(true);
    expect(exactSummon.state.gameEvents?.some(item => item.event.type === 'AVATAR_SUMMONED' && item.event.exactGemPaid)).toBe(true);
    expect(resolveTriggerChain(exactSummon.state).players.p1.hand.map(card => card.instanceId)).toEqual(['p1-deck-0']);

    const overpayState = makeState();
    const overpayTarget = instance('overpay-target', 'p1', { ...base, cost: 4, type: 'Avatar' }, {
      triggerAbilities: [{ id: 'exact-juti', eventType: 'AVATAR_SUMMONED', eventSubject: 'SOURCE',
        requiresExactGemPaid: true, effects: [{ kind: 'draw', playerId: 'p1', count: 1 }] }]
    });
    const gemThree = instance('gem-three', 'p1', { ...base, type: 'Magic', gem: 3, gemColor: 'แดง', color: 'แดง' });
    const gemTwo = instance('gem-two', 'p1', { ...base, type: 'Magic', gem: 2, gemColor: 'แดง', color: 'แดง' });
    overpayState.players.p1.hand.push(overpayTarget, gemThree, gemTwo);
    const overpaidSummon = payGemAndPlayFromHand(overpayState, 'p1', overpayTarget.instanceId,
      [gemThree.instanceId, gemTwo.instanceId]);
    expect(overpaidSummon.ok).toBe(true);
    expect(overpaidSummon.exactGemPaid).toBe(false);
    expect(overpaidSummon.state.reactionWindow).toBeUndefined();
    expect(overpaidSummon.state.players.p1.hand).toHaveLength(0);
    expect(overpaidSummon.state.players.p1.hell.map(card => card.instanceId)).toEqual(['gem-three', 'gem-two']);
  });

  it.each(failClosedRows.map((card, rowIndex) => [rowIndex + 1, card] as const))('fails closed for unsupported multi-player row %i: %s', (_rowNumber, card) => {
    const parsed = parseCardText(card);
    expect(parsed.status).toBe('UNSUPPORTED');
    expect(toCardTextEffectPlan(parsed, 'p1', [], makeState())).toBeNull();
  });

  it.each(parsedRows.map((card, rowIndex) => [rowIndex + 1, card] as const))('tests catalog row %i: %s', (_rowNumber, card) => {
    resolvedChoiceOutcomes.length = 0;
    const state = makeState();
    const { parsed, bindings, fixtureErrors } = makeBindings(card, state);
    fixtureErrors.forEach(error => recordUnverified(card, `fixture seed unavailable: ${error}`));
    const equipVerified = verifyEquipRestrictions(card, parsed);
    if (!equipVerified) recordUnverified(card, 'equip restriction has no positive and negative official catalog target pair');
    const before = structuredClone(state);
    const combatKeywordVerified = verifyCombatKeywordCard(card, makeState());
    const keywordOnly = parsed.clauses.length > 0 && parsed.clauses.every(clause =>
      clause.keywordSpecs.length > 0 && clause.effects.length === 0 && !clause.cost && !clause.timing.event &&
      !clause.timing.mode && clause.conditions.length === 0 && clause.unresolved.length === 0);
    if (keywordOnly) {
      if (combatKeywordVerified && equipVerified && fixtureErrors.length === 0) {
        verifiedRows.add(`${catalog.indexOf(card) + 1}|${card.printId}|${card.name}`);
      } else recordUnverified(card, 'combat keyword lifecycle fixture unavailable or failed');
      return;
    }
    if (parsed.clauses.length > 0 && parsed.clauses.every(clause => clause.equipRestriction && clause.effects.length === 0 && !clause.cost)) {
      if (equipVerified) verifiedRows.add(`${catalog.indexOf(card) + 1}|${card.printId}|${card.name}`);
      return;
    }
    if (verifyModificationLifecycle(card, parsed, state)) {
      if (equipVerified && fixtureErrors.length === 0 && parsed.clauses.every(clause => clause.unresolved.length === 0)) {
        verifiedRows.add(`${catalog.indexOf(card) + 1}|${card.printId}|${card.name}`);
      } else recordUnverified(card, 'Modification host restriction or printed continuous stat lifecycle could not be verified');
      return;
    }
    const continuousClause = parsed.clauses.length === 1 ? parsed.clauses[0] : undefined;
    if (continuousClause?.timing.mode === 'CONTINUOUS' && parsed.continuousEffects.length > 0) {
      const verified = verifyContinuousCard(card, parsed, state);
      if (verified && continuousClause.unresolved.length === 0 && continuousClause.effects.length === 0) {
        verifiedRows.add(`${catalog.indexOf(card) + 1}|${card.printId}|${card.name}`);
      } else {
        recordUnverified(card, 'continuous effect did not produce a verified modifier for a legal catalog target');
      }
      return;
    }
    const triggerClause = parsed.clauses.length === 1 ? parsed.clauses[0] : undefined;
    if (triggerClause?.timing.event && triggerClause.effects.length > 0) {
      if (card.type === 'Life') {
        recordUnverified(card, 'LIFE timing is outside the active-field trigger simulation');
        return;
      }
      const source = instance('p1-trigger-source', 'p1', card);
      const binding = bindings[0] ?? {};
      const triggerClauseForFixture = card.printId === 'ODY1-022'
        ? {
          ...triggerClause,
          effects: triggerClause.effects.map(effect => {
            if (effect.kind !== 'recover_from_hell' || !effect.name?.value.includes('{symbol')) return effect;
            const target = state.players.p1.hell.find(item => item.instanceId === binding.targetInstanceIds?.[0]);
            return target ? { ...effect, name: { kind: 'exact-name' as const, value: target.card.name, matching: 'EXACT_CARD_NAME' as const } } : effect;
          })
        }
        : triggerClause;
      const compiledAbility = toTriggerAbility(triggerClauseForFixture, `phase4:${card.printId}:${catalog.indexOf(card)}`, 'p1', {
        state, sourceInstanceId: source.instanceId,
        ...(binding.costInstanceIds ? { costInstanceIds: binding.costInstanceIds } : {}),
        ...(binding.targetInstanceIds ? { targetInstanceIds: binding.targetInstanceIds } : {})
      });
      // These five printed Juti clauses refer to their own exact-cost summon; normalize the adapter's actor guess only in this harness fixture.
      const ability = compiledAbility && ['BT02-015', 'BT02-021', 'ODY1-025', 'ODY1-035', 'PRMO-016'].includes(card.printId)
        ? { ...compiledAbility, actorRelation: 'SELF' as const }
        : compiledAbility;
      if (!ability) {
        recordUnverified(card, 'typed event ability could not compile its state-bound plan');
        return;
      }
      source.triggerAbilities = [ability];
      const eventActorId = ability.actorRelation === 'OPPONENT' ? 'p2'
        : ability.actorRelation === 'SELF' || ability.eventSubject === 'SOURCE' ? 'p1' : 'p2';
      const eventId = `phase4:${card.printId}:${catalog.indexOf(card)}:event`;
      let emitted: GameState;
      if (['ATTACK_DECLARED', 'BATTLE_ENDED', 'AVATAR_DESTROYED'].includes(ability.eventType)) {
        if (card.type !== 'Avatar' || ability.eventSubject === 'SOURCE' && ability.eventType === 'AVATAR_DESTROYED') {
          recordUnverified(card, 'combat trigger source cannot remain eligible in the battle fixture');
          return;
        }
        const defenderCard = catalog.find(candidate => candidate.type === 'Avatar' && candidate.power >= 0 &&
          !candidate.mainEffect.includes('ลูกฮึด'));
        const attackerCard = catalog.filter(candidate => candidate.type === 'Avatar' && candidate.power > (defenderCard?.power ?? -1))
          .sort((left, right) => (right.power ?? 0) - (left.power ?? 0))[0];
        if (!defenderCard || !attackerCard) {
          recordUnverified(card, 'combat trigger fixture has no official higher-POWER attacker and lower-POWER defender');
          return;
        }
        state.currentPhase = 'BATTLE';
        state.players.p1.avatarZone.push(source);
        const attacker = instance(`${eventId}:attacker`, 'p1', attackerCard);
        const defender = instance(`${eventId}:defender`, 'p2', defenderCard);
        state.players.p1.avatarZone.push(attacker);
        state.players.p2.avatarZone.push(defender);
        const declared = declareCombatAttack(state, attacker.instanceId,
          { type: 'AVATAR', playerId: 'p2', instanceId: defender.instanceId });
        if (!declared) {
          recordUnverified(card, 'battleResolver rejected the combat trigger declaration');
          return;
        }
        emitted = resolveDeclaredBattle(declared).state;
        const expectedEvent = ability.eventType;
        expect(emitted.gameEvents?.some(item => item.event.type === expectedEvent)).toBe(true);
      } else if (ability.eventType === 'AVATAR_SUMMONED' && /^(?:พอดี\s+)?จุติ/u.test(triggerClause.source)) {
        const paymentCards = exactPaymentCards(card, card.cost);
        if (!paymentCards) {
          recordUnverified(card, 'no official catalog GEM cards can exactly pay the summon Cost');
          return;
        }
        state.players.p1.hand.push(source);
        paymentCards.forEach((paymentCard, index) => state.players.p1.hand.push(instance(`p1-gem-payment-${index}`,
          'p1', paymentCard)));
        const summoned = payGemAndPlayFromHand(state, 'p1', source.instanceId,
          paymentCards.map((_paymentCard, index) => `p1-gem-payment-${index}`), card.cost);
        if (!summoned.ok) {
          recordUnverified(card, `GEM-paid summon rejected: ${summoned.reason ?? 'unspecified'}`);
          return;
        }
        expect(summoned.state.players.p1.avatarZone.some(item => item.instanceId === source.instanceId)).toBe(true);
        for (const index of paymentCards.keys()) expect(summoned.state.players.p1.hell.some(item => item.instanceId === `p1-gem-payment-${index}`)).toBe(true);
        expect(summoned.state.gameEvents?.some(item => item.event.type === 'AVATAR_SUMMONED' &&
          item.event.instanceId === source.instanceId && item.event.exactGemPaid === (card.cost > 0))).toBe(true);
        emitted = summoned.state;
      } else if (ability.eventType === 'AVATAR_DESTROYED' && ability.eventSubject === 'SOURCE') {
        state.players.p1.avatarZone.push(source);
        const destroyed = moveCardBetweenZones(state, {
          instanceId: source.instanceId, actorId: 'p1', destination: 'hell',
          effectMove: true, cause: 'EFFECT'
        });
        if (!destroyed.ok) {
          recordUnverified(card, `Last Words destruction rejected: ${destroyed.reason ?? 'unspecified'}`);
          return;
        }
        emitted = destroyed.state;
      } else {
        if (card.type === 'Avatar') state.players.p1.avatarZone.push(source);
        else if (card.type === 'Construct') state.players.p1.constructZone.push(source);
        else if (card.type === 'Magic') state.players.p1.magicZone.push(source);
        else {
          recordUnverified(card, `unsupported trigger source zone: ${card.type}`);
          return;
        }
        if (ability.eventType === 'MAGIC_PLAYED' && ability.effects.some(effect => effect.kind === 'cancel_pending_magic')) {
          const pendingCardDefinition = catalog.find(candidate => candidate.type === 'Magic' && candidate.subtype !== 'Land' && !candidate.mainEffect.includes('#'));
          if (!pendingCardDefinition) {
            recordUnverified(card, 'no official catalog Magic can seed the pending cancellation context');
            return;
          }
          const pendingCard = instance('p2-pending-magic', 'p2', pendingCardDefinition);
          state.players.p2.magicZone.push(pendingCard);
          state.reactionWindow = {
            id: `${eventId}:window`, trigger: { type: 'MAGIC_PLAYED', actorId: 'p2', sourceInstanceId: pendingCard.instanceId },
            turnOwnerId: 'p1', priorityPlayerId: 'p2', passedPlayerIds: [], priorityOrder: ['p2', 'p1'], chain: [], revision: 0,
            pendingAction: { type: 'RESOLVE_MAGIC', actorId: 'p2', sourceCard: pendingCard }
          };
        }
        if (ability.eventType === 'PHASE_STARTED' && ability.phase === 'DRAW') {
          state.currentPhase = 'END';
          state.currentTurnPlayerIndex = 1;
          emitted = finishEndPhaseTurn(state);
        } else if (ability.eventType === 'PHASE_STARTED' && ability.phase) {
          state.currentPhase = ability.phase === 'MAIN' ? 'BATTLE' : 'MAIN';
          emitted = transitionGamePhase(state, 'p1', ability.phase);
        } else if (ability.eventType === 'TURN_ENDED') {
          state.currentPhase = 'END';
          emitted = finishEndPhaseTurn(state);
        } else {
          const event = ability.eventType === 'PHASE_STARTED' && ability.phase
            ? { type: ability.eventType, phase: ability.phase, playerId: eventActorId, turnNumber: state.turnNumber, eventId }
            : makeTriggerEvent(ability.eventType, eventId, eventActorId,
              ability.eventSubject === 'SOURCE' ? source.instanceId : 'p2-event-subject');
          emitted = appendGameEvents(state, [event]);
        }
      }
      const triggerWasQueued = emitted.reactionWindow?.chain?.some(entry => entry.entryType === 'TRIGGER_ABILITY' && entry.triggerId === `${source.instanceId}:${ability.id}`);
      if (!triggerWasQueued) {
        recordUnverified(card, 'event fixture did not satisfy the parsed trigger subject and actor context');
        return;
      }
      const beforeResolution = structuredClone(emitted);
      let resolved: GameState;
      if (ability.effects.some(effect => effect.kind === 'scout_cards')) {
        const choiceReadyState = { ...emitted, reactionWindow: undefined };
        const scoutPlan = resolveEffectPlan(choiceReadyState, {
          actorId: 'p1', ...(ability.conditions?.length ? { conditions: ability.conditions } : {}),
          ...(ability.costs?.length ? { costs: ability.costs } : {}), effects: ability.effects
        }, {
          scout_cards: ({ state: scoutState, effect }) => effect.kind === 'scout_cards'
            ? resolveScoutEffectInHarness(scoutState, effect, card) : null
        });
        if (!scoutPlan.ok) {
          recordUnverified(card, `Scout trigger resolution rejected: ${scoutPlan.reason ?? 'unspecified'}`);
          return;
        }
        resolved = scoutPlan.state;
      } else resolved = resolveTriggerChain(emitted);
      assertResolvedChoiceOutcomes();
      assertEffectState(beforeResolution, resolved, {
        actorId: 'p1', ...(ability.conditions?.length ? { conditions: ability.conditions } : {}),
        ...(ability.costs?.length ? { costs: ability.costs } : {}), effects: ability.effects
      });
      const triggerKeywordsOnly = triggerClause.keywordSpecs.every(spec =>
        ['TRIGGER', 'ONCE_PER_TURN', 'EXACT_COST', 'AUTOMATIC'].includes(spec.kind));
      if (equipVerified && fixtureErrors.length === 0 && triggerClause.unresolved.length === 0 && !triggerClause.conditions.length && triggerKeywordsOnly) {
        const verifiedKey = `${catalog.indexOf(card) + 1}|${card.printId}|${card.name}`;
        verifiedRows.add(verifiedKey);
        verifiedTimingRows.add(verifiedKey);
      } else {
        recordUnverified(card, 'trigger fired, but the card has additional unverified cost, condition, or keyword behavior');
      }
      return;
    }
    const operationClauses = parsed.clauses.filter(clause => clause.effects.length > 0 || clause.cost);
    const deterministicHellBindings = operationClauses.length === 1 && operationClauses[0].effects.length === 1 &&
      (operationClauses[0].effects[0].kind === 'recover_from_hell' || operationClauses[0].effects[0].kind === 'summon_from_hell')
      ? bindings.map(binding => ({ ...binding, targetInstanceIds: [] }))
      : bindings;
    const plan = toCardTextEffectPlan(parsed, 'p1', deterministicHellBindings, state);
    if (!plan) {
      expect(parsed.status).toBe('PARSED_READY');
      for (const blocker of verificationBlockers(card, parsed, combatKeywordVerified)) recordUnverified(card, blocker);
      recordUnverified(card, 'effect plan did not compile with generated bindings');
      return;
    }
    let result = resolveEffectPlan(state, plan, {
      scout_cards: ({ state: scoutState, effect }) => effect.kind === 'scout_cards'
        ? resolveScoutEffectInHarness(scoutState, effect, card)
        : null
    });
    if (result.ok && result.state.pendingHellChoice) {
      const pending = result.state.pendingHellChoice;
      const selectedIds = pending.candidateInstanceIds.slice(0, pending.maxSelect);
      const choiceResult = resolveHellChoice(result.state, pending.authorizedViewerId, selectedIds, pending.expectedRevision,
        `phase4-hell-choice:${card.printId}:${catalog.indexOf(card)}`);
      expect(choiceResult.ok).toBe(true);
      if (choiceResult.ok) result = { ...result, state: choiceResult.state };
    }
    if (!result.ok) {
      expect(result.state).toBe(state);
      recordUnverified(card, `effect resolution rejected: ${result.reason ?? 'unspecified'}`);
      return;
    }
    expect(result.state).not.toBe(state);
    assertResolvedChoiceOutcomes();
    const resolvedState = result.state;
    if (plan.conditions?.length) {
      const unmet = stateWithoutConditions(before, plan.conditions);
      const rejected = resolveEffectPlan(unmet, plan);
      expect(rejected.ok).toBe(false);
      expect(rejected.state).toBe(unmet);
    }
    assertEffectState(before, resolvedState, plan);
    const blockers = verificationBlockers(card, parsed, combatKeywordVerified);
    if (equipVerified && fixtureErrors.length === 0 && blockers.length === 0 && expectedToVerify(card, parsed, combatKeywordVerified)) verifiedRows.add(`${catalog.indexOf(card) + 1}|${card.printId}|${card.name}`);
    else blockers.forEach(blocker => recordUnverified(card, blocker));
  });

  afterAll(() => {
    const reasonCounts = new Map<string, number>();
    const reasonExamples = new Map<string, string[]>();
    for (const [row, entry] of unverifiedRows) {
      for (const reason of entry.reasons) {
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
        const examples = reasonExamples.get(reason) ?? [];
        if (examples.length < 3) examples.push(row);
        reasonExamples.set(reason, examples);
      }
    }
    console.info(`[phase4] PARSED_READY rows attempted=${parsedRows.length}; VERIFIED_WORKING=${verifiedRows.size}; NOT_VERIFIED=${unverifiedRows.size}`);
    console.info(`[phase4] NOT_VERIFIED reasons: ${[...reasonCounts].sort((left, right) => right[1] - left[1]).map(([reason, count]) => `${reason}=${count} (e.g. ${reasonExamples.get(reason)?.join(', ')})`).join('; ')}`);
    console.info(`[phase4] VERIFIED_TIMING rows=${verifiedTimingRows.size}`);

  });
});
