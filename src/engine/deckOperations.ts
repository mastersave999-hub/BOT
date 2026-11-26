import type { GameEvent } from './gameEvents';
import { moveCardBetweenZones } from './gameRules';
import { runGameTransaction, type TransactionResult } from './gameTransaction';
import type { Card, CardInstance, GameState, PendingDeckChoice } from './types';

export interface DeckOperationResult {
  ok: boolean;
  state: GameState;
  reason?: string;
  choiceRequired?: boolean;
  found?: boolean;
  verificationRequired?: boolean;
  deckOutPlayerId?: string;
  winnerId?: string;
}

export interface RandomizationOptions {
  seed?: number | string;
  random?: () => number;
}

export interface ScoutOptions extends RandomizationOptions {
  viewerId?: string;
  destination?: 'hand' | 'hell' | 'deck';
  minSelect?: number;
  maxSelect?: number;
  selectedDeckPosition?: 'top' | 'bottom';
  unselectedDeckPosition?: 'top' | 'bottom' | 'shuffle';
  topOrderAllowed?: boolean;
  selectedInstanceIds?: string[];
  expectedRevision?: number;
  commandId?: string;
}

export interface DeckSearchCriteria {
  types?: Card['type'][];
  colors?: string[];
  minCost?: number;
  maxCost?: number;
  exactName?: string;
  nameIncludes?: string;
  symbols?: string[];
  predicate?: (card: Card, instance: CardInstance) => boolean;
}

export interface SearchOptions extends RandomizationOptions {
  actorId?: string;
  authorizedViewerId?: string;
  destination?: 'hand' | 'hell' | 'deck';
  selectCount?: number;
  selectedInstanceIds?: string[];
  expectedRevision?: number;
  commandId?: string;
}

export interface ResolveDeckChoiceOptions extends RandomizationOptions {
  topOrderIds?: string[];
  commandId?: string;
}

function makeRandom(options: RandomizationOptions = {}): () => number {
  if (options.random) return options.random;
  if (options.seed !== undefined) return createSeededRandom(options.seed);
  return () => {
    const cryptoObject = globalThis.crypto;
    if (cryptoObject?.getRandomValues) {
      const sample = new Uint32Array(1);
      cryptoObject.getRandomValues(sample);
      return sample[0] / 0x1_0000_0000;
    }
    return Math.random();
  };
}

/** Mulberry32 provides a small deterministic PRNG for reproducible engine tests. */
export function createSeededRandom(seed: number | string): () => number {
  let state = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  return hash >>> 0;
}

function shuffled<T>(items: readonly T[], options: RandomizationOptions = {}): T[] {
  const result = [...items];
  const random = makeRandom(options);
  for (let i = result.length - 1; i > 0; i--) {
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new RangeError('Random source must return a value in [0, 1)');
    const j = Math.floor(sample * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function eventId(state: GameState, label: string): string {
  return `${state.id}:${state.gameEvents?.length ?? 0}:${state.stateRevision ?? 0}:deck:${label}`;
}

function failure(state: GameState, result: TransactionResult): DeckOperationResult {
  if ('reason' in result) return { ok: false, state, reason: result.reason };
  return { ok: true, state: result.state };
}

function shuffleInside(state: GameState, playerId: string, random: RandomizationOptions, events: GameEvent[]): GameState | null {
  const player = state.players[playerId];
  if (!player) return null;
  const deck = shuffled(player.deck, random);
  events.push({ type: 'DECK_SHUFFLED', playerId, cardCount: deck.length, eventId: eventId(state, `shuffle:${playerId}`) });
  return {
    ...state,
    players: { ...state.players, [playerId]: { ...player, deck } },
    stateRevision: (state.stateRevision ?? 0) + 1
  };
}

export function shuffleDeck(state: GameState, playerId: string, options: RandomizationOptions = {}): DeckOperationResult {
  const events: GameEvent[] = [];
  const transaction = runGameTransaction(state, draft => {
    if (draft.pendingDeckChoice || draft.pendingDeckSearchVerification || draft.pendingEndPhaseDiscardPlayerId || draft.reactionWindow) return null;
    return shuffleInside(draft, playerId, options, events);
  }, events);
  return failure(state, transaction);
}

export function millCards(state: GameState, playerId: string, count: number): DeckOperationResult {
  if (!Number.isSafeInteger(count) || count < 0) return { ok: false, state, reason: 'Mill count must be a non-negative integer' };
  if (count === 0) return { ok: true, state };
  const events: GameEvent[] = [];
  let milledIds: string[] = [];
  const transaction = runGameTransaction(state, draft => {
    if (draft.pendingDeckChoice || draft.pendingDeckSearchVerification || draft.pendingEndPhaseDiscardPlayerId || draft.reactionWindow) return null;
    let next: GameState = draft;
    const available = Math.min(count, draft.players[playerId]?.deck.length ?? 0);
    if (!draft.players[playerId]) return null;
    for (let i = 0; i < available; i++) {
      const currentTop = next.players[playerId].deck[0];
      if (!currentTop) return null;
      const moved = moveCardBetweenZones(next, {
        instanceId: currentTop.instanceId,
        actorId: playerId,
        destination: 'hell',
        effectMove: true
      });
      if (!moved.ok) return null;
      next = moved.state;
      milledIds.push(currentTop.instanceId);
    }
    if (milledIds.length > 0) {
      events.push({ type: 'DECK_MILLED', playerId, cardInstanceIds: [...milledIds], eventId: eventId(next, `mill:${playerId}:${milledIds.join(',')}`) });
    }
    const deckOut = next.players[playerId].deck.length === 0 && count > 0;
    if (deckOut) {
      events.push({ type: 'PLAYER_DECKED_OUT', playerId, eventId: eventId(next, `deck-out:${playerId}`) });
    }
    return { ...next, stateRevision: (state.stateRevision ?? 0) + 1 };
  }, events);
  if (!transaction.ok) return failure(state, transaction);
  const deckOutPlayerId = count > 0 && transaction.state.players[playerId]?.deck.length === 0 ? playerId : undefined;
  const winnerId = deckOutPlayerId && state.mode === 'DUEL' ? state.playerOrder.find(id => id !== playerId) : undefined;
  return { ok: true, state: transaction.state, deckOutPlayerId, winnerId };
}

function criteriaMatch(card: Card, instance: CardInstance, criteria: DeckSearchCriteria): boolean {
  return (!criteria.types || criteria.types.includes(card.type)) &&
    (!criteria.colors || criteria.colors.includes(card.color)) &&
    (criteria.minCost === undefined || card.cost >= criteria.minCost) &&
    (criteria.maxCost === undefined || card.cost <= criteria.maxCost) &&
    (criteria.exactName === undefined || card.name === criteria.exactName) &&
    (criteria.nameIncludes === undefined || card.name.includes(criteria.nameIncludes)) &&
    (!criteria.symbols || criteria.symbols.includes(card.symbol ?? '')) &&
    (!criteria.predicate || criteria.predicate(structuredClone(card), structuredClone(instance)));
}

function makePendingChoice(
  state: GameState,
  values: Omit<PendingDeckChoice, 'expectedRevision'>
): PendingDeckChoice {
  return { ...values, expectedRevision: (state.stateRevision ?? 0) + 1 };
}

function moveDeckCard(
  state: GameState,
  instanceId: string,
  actorId: string,
  destination: PendingDeckChoice['destination'],
  deckOwnerId: string,
  deckPosition?: 'top' | 'bottom'
): GameState | null {
  const moved = moveCardBetweenZones(state, {
    instanceId,
    actorId,
    destination,
    destinationPlayerId: deckOwnerId,
    effectMove: true,
    deckPosition
  });
  return moved.ok ? moved.state : null;
}

function applyChoice(
  initial: GameState,
  pending: PendingDeckChoice,
  selectedIds: string[],
  options: ResolveDeckChoiceOptions,
  events: GameEvent[]
): GameState | null {
  if (!Array.isArray(selectedIds) || new Set(selectedIds).size !== selectedIds.length ||
    selectedIds.some(id => !pending.candidateInstanceIds.includes(id)) ||
    selectedIds.length < pending.minSelect || selectedIds.length > pending.maxSelect) return null;
  if (pending.topOrderAllowed && options.topOrderIds &&
    (options.topOrderIds.length !== selectedIds.length || new Set(options.topOrderIds).size !== selectedIds.length ||
      options.topOrderIds.some(id => !selectedIds.includes(id)))) return null;
  if (!pending.topOrderAllowed && options.topOrderIds) return null;

  let next: GameState = { ...initial, pendingDeckChoice: undefined };
  const selectedOrder = options.topOrderIds ?? selectedIds;
  const selectedForMove = pending.destination === 'deck' && pending.selectedDeckPosition === 'top'
    ? [...selectedOrder].reverse()
    : selectedOrder;
  for (const id of selectedForMove) {
    const moved = moveDeckCard(next, id, pending.actorId, pending.destination, pending.deckOwnerId, pending.selectedDeckPosition);
    if (!moved) return null;
    next = moved;
  }

  const unselected = pending.candidateInstanceIds.filter(id => !selectedIds.includes(id));
  if (pending.unselectedDeckPosition === 'top') {
    for (const id of [...unselected].reverse()) {
      const moved = moveDeckCard(next, id, pending.actorId, 'deck', pending.deckOwnerId, 'top');
      if (!moved) return null;
      next = moved;
    }
  } else if (pending.unselectedDeckPosition === 'bottom') {
    for (const id of unselected) {
      const moved = moveDeckCard(next, id, pending.actorId, 'deck', pending.deckOwnerId, 'bottom');
      if (!moved) return null;
      next = moved;
    }
  }

  if (pending.unselectedDeckPosition === 'shuffle' || pending.kind === 'SEARCH') {
    const shuffledState = shuffleInside(next, pending.deckOwnerId, options, events);
    if (!shuffledState) return null;
    next = shuffledState;
  }
  if (pending.kind === 'SEARCH') {
    const searched = selectedIds.length === 0 ? undefined : selectedIds[0];
    events.push({
      type: 'DECK_SEARCHED', deckOwnerId: pending.deckOwnerId, actorId: pending.actorId,
      destination: pending.destination, ...(pending.destination === 'hell' && searched ? { instanceId: searched } : {}),
      found: selectedIds.length > 0, eventId: eventId(next, `search:${pending.deckOwnerId}:${selectedIds.join(',') || 'none'}`)
    });
  }
  if (initial.players[pending.deckOwnerId].deck.length > 0 && next.players[pending.deckOwnerId].deck.length === 0) {
    events.push({ type: 'PLAYER_DECKED_OUT', playerId: pending.deckOwnerId, eventId: eventId(next, `deck-out:${pending.deckOwnerId}`) });
  }
  if (options.commandId) {
    next = {
      ...next,
      processedCommandIds: [...(next.processedCommandIds ?? []), options.commandId].slice(-128)
    };
  }
  return { ...next, stateRevision: (initial.stateRevision ?? 0) + 1 };
}

export function resolveDeckChoice(
  state: GameState,
  viewerId: string,
  selectedInstanceIds: string[],
  expectedRevision: number,
  options: ResolveDeckChoiceOptions = {}
): DeckOperationResult {
  const pending = state.pendingDeckChoice;
  if (!pending || pending.authorizedViewerId !== viewerId) return { ok: false, state, reason: 'No authorized pending Deck choice' };
  if (!Number.isSafeInteger(expectedRevision) || pending.expectedRevision !== expectedRevision || state.stateRevision !== expectedRevision) {
    return { ok: false, state, reason: 'Stale Deck choice revision' };
  }
  if (options.commandId && state.processedCommandIds?.includes(options.commandId)) return { ok: false, state, reason: 'Duplicate Deck choice command' };
  if (!Array.isArray(selectedInstanceIds) || new Set(selectedInstanceIds).size !== selectedInstanceIds.length ||
    selectedInstanceIds.some(id => !pending.candidateInstanceIds.includes(id)) ||
    selectedInstanceIds.length < pending.minSelect || selectedInstanceIds.length > pending.maxSelect) {
    return { ok: false, state, reason: 'Invalid Deck choice selection' };
  }
  const events: GameEvent[] = [];
  const transaction = runGameTransaction(state, draft => applyChoice(draft, pending, selectedInstanceIds, options, events), events, { allowPendingPlayerChoice: true });
  if (!transaction.ok) return failure(state, transaction);
  const deckOutPlayerId = state.players[pending.deckOwnerId].deck.length > 0 && transaction.state.players[pending.deckOwnerId].deck.length === 0
    ? pending.deckOwnerId
    : undefined;
  const winnerId = deckOutPlayerId && state.mode === 'DUEL' ? state.playerOrder.find(id => id !== deckOutPlayerId) : undefined;
  return { ok: true, state: transaction.state, deckOutPlayerId, winnerId, found: pending.kind === 'SEARCH' && selectedInstanceIds.length > 0 };
}

export function scoutCards(
  state: GameState,
  deckOwnerId: string,
  count: number,
  options: ScoutOptions = {}
): DeckOperationResult {
  if (!Number.isSafeInteger(count) || count < 0) return { ok: false, state, reason: 'Scout count must be a non-negative integer' };
  const owner = state.players[deckOwnerId];
  if (!owner) return { ok: false, state, reason: 'Deck owner does not exist' };
  if (state.pendingDeckChoice || state.pendingDeckSearchVerification || state.pendingEndPhaseDiscardPlayerId || state.reactionWindow) return { ok: false, state, reason: 'Another game action is pending' };
  if (options.expectedRevision !== undefined && options.expectedRevision !== state.stateRevision) return { ok: false, state, reason: 'Stale Scout revision' };
  const viewerId = options.viewerId ?? deckOwnerId;
  if (!state.players[viewerId]) return { ok: false, state, reason: 'Authorized viewer does not exist' };
  const candidates = owner.deck.slice(0, count).map(card => card.instanceId);
  const hasExplicitDestination = options.destination !== undefined;
  const destination = options.destination ?? 'deck';
  const minSelect = options.minSelect ?? 0;
  const maxSelect = options.maxSelect ?? (hasExplicitDestination ? candidates.length : 0);
  if (!hasExplicitDestination && (options.minSelect !== undefined || options.maxSelect !== undefined || options.selectedDeckPosition ||
    options.unselectedDeckPosition || options.topOrderAllowed)) return { ok: false, state, reason: 'Scout resolution requires an explicit effect destination' };
  if (!Number.isSafeInteger(minSelect) || !Number.isSafeInteger(maxSelect) || minSelect < 0 || maxSelect < minSelect || maxSelect > candidates.length) return { ok: false, state, reason: 'Invalid Scout selection limits' };
  if (options.selectedDeckPosition && destination !== 'deck') return { ok: false, state, reason: 'Deck position only applies when Scout cards return to Deck' };
  if (options.topOrderAllowed && (destination !== 'deck' || options.selectedDeckPosition !== 'top')) return { ok: false, state, reason: 'Chosen top order requires an explicit top-Deck destination' };
  const pending = makePendingChoice(state, {
    kind: 'SCOUT', deckOwnerId, actorId: viewerId, authorizedViewerId: viewerId,
    candidateInstanceIds: candidates, minSelect, maxSelect,
    destination: options.destination ?? 'deck',
    selectedDeckPosition: options.selectedDeckPosition,
    unselectedDeckPosition: options.unselectedDeckPosition ?? 'shuffle',
    topOrderAllowed: options.topOrderAllowed
  });
  const events: GameEvent[] = [{ type: 'DECK_SCOUTED', deckOwnerId, viewerId, cardInstanceIds: candidates, eventId: eventId(state, `scout:${deckOwnerId}:${viewerId}`) }];
  const transaction = runGameTransaction(state, draft => ({
    ...draft,
    stateRevision: pending.expectedRevision,
    pendingDeckChoice: pending
  }), events);
  if (!transaction.ok) return failure(state, transaction);
  if (options.selectedInstanceIds) {
    const resolved = resolveDeckChoice(transaction.state, viewerId, options.selectedInstanceIds, pending.expectedRevision, options);
    return resolved.ok ? resolved : { ...resolved, state };
  }
  return { ok: true, state: transaction.state, choiceRequired: true };
}

export function searchDeck(
  state: GameState,
  deckOwnerId: string,
  criteria: DeckSearchCriteria,
  options: SearchOptions = {}
): DeckOperationResult {
  const owner = state.players[deckOwnerId];
  if (!owner) return { ok: false, state, reason: 'Deck owner does not exist' };
  if (state.pendingDeckChoice || state.pendingDeckSearchVerification || state.pendingEndPhaseDiscardPlayerId || state.reactionWindow) return { ok: false, state, reason: 'Another game action is pending' };
  if (options.expectedRevision !== undefined && options.expectedRevision !== state.stateRevision) return { ok: false, state, reason: 'Stale Search revision' };
  if (!Number.isSafeInteger(options.selectCount ?? 1) || (options.selectCount ?? 1) < 1) return { ok: false, state, reason: 'Search count must be a positive integer' };
  const actorId = options.actorId ?? deckOwnerId;
  const authorizedViewerId = options.authorizedViewerId ?? actorId;
  if (!state.players[actorId] || !state.players[authorizedViewerId]) return { ok: false, state, reason: 'Search actor or authorized viewer does not exist' };
  const count = options.selectCount ?? 1;
  if ((criteria.minCost !== undefined && (!Number.isFinite(criteria.minCost) || criteria.minCost < 0)) ||
    (criteria.maxCost !== undefined && (!Number.isFinite(criteria.maxCost) || criteria.maxCost < 0)) ||
    (criteria.minCost !== undefined && criteria.maxCost !== undefined && criteria.minCost > criteria.maxCost)) {
    return { ok: false, state, reason: 'Invalid Deck Search criteria' };
  }
  let candidates: string[];
  try {
    candidates = owner.deck.filter(instance => criteriaMatch(instance.card, instance, criteria)).map(card => card.instanceId);
  } catch (error) {
    return { ok: false, state, reason: error instanceof Error ? error.message : 'Deck Search predicate failed' };
  }
  const destination = options.destination ?? 'hand';
  const events: GameEvent[] = [];
  const pending = makePendingChoice(state, {
    kind: 'SEARCH', deckOwnerId, actorId, authorizedViewerId,
    candidateInstanceIds: candidates, minSelect: count, maxSelect: count,
    destination, unselectedDeckPosition: 'shuffle'
  });

  if (candidates.length === 0) {
    const verifierPlayerIds = state.playerOrder.filter(id => id !== actorId);
    if (verifierPlayerIds.length === 0) return { ok: false, state, reason: 'A second player is required to verify an empty search' };
    const transaction = runGameTransaction(state, draft => {
      if (draft.pendingDeckChoice || draft.pendingDeckSearchVerification || draft.pendingEndPhaseDiscardPlayerId || draft.reactionWindow) return null;
      const next = shuffleInside(draft, deckOwnerId, options, events);
      if (!next) return null;
      events.push({ type: 'DECK_SEARCHED', deckOwnerId, actorId, destination, found: false, eventId: eventId(next, `search:${deckOwnerId}:none`) });
      return {
        ...next,
        pendingDeckSearchVerification: {
          deckOwnerId,
          searcherId: actorId,
          verifierPlayerIds,
          expectedRevision: next.stateRevision ?? 0
        }
      };
    }, events);
    if (!transaction.ok) return failure(state, transaction);
    return { ok: true, state: transaction.state, found: false, verificationRequired: true };
  }

  if (candidates.length < count) return { ok: false, state, reason: 'Not enough eligible cards for the requested Search count' };
  const selectedIds = options.selectedInstanceIds ?? (candidates.length === count ? candidates : undefined);
  if (selectedIds) {
    const transaction = runGameTransaction(state, draft => {
      if (draft.pendingDeckChoice || draft.pendingDeckSearchVerification || draft.pendingEndPhaseDiscardPlayerId || draft.reactionWindow) return null;
      const staged = { ...draft, pendingDeckChoice: pending, stateRevision: pending.expectedRevision };
      return applyChoice(staged, pending, selectedIds, { seed: options.seed, random: options.random, commandId: options.commandId }, events);
    }, events);
    if (!transaction.ok) return failure(state, transaction);
    const deckOutPlayerId = state.players[deckOwnerId].deck.length > 0 && transaction.state.players[deckOwnerId].deck.length === 0
      ? deckOwnerId
      : undefined;
    const winnerId = deckOutPlayerId && state.mode === 'DUEL' ? state.playerOrder.find(id => id !== deckOutPlayerId) : undefined;
    return { ok: true, state: transaction.state, found: true, deckOutPlayerId, winnerId };
  }

  const transaction = runGameTransaction(state, draft => ({
    ...draft,
    stateRevision: pending.expectedRevision,
    pendingDeckChoice: pending
  }), events);
  return transaction.ok ? { ok: true, state: transaction.state, choiceRequired: true } : failure(state, transaction);
}

export function confirmNoSearchTarget(
  state: GameState,
  verifierId: string,
  expectedRevision: number,
  commandId: string
): DeckOperationResult {
  const pending = state.pendingDeckSearchVerification;
  if (!pending) return { ok: false, state, reason: 'No Deck Search verification is pending' };
  if (!pending.verifierPlayerIds.includes(verifierId)) return { ok: false, state, reason: 'Player is not authorized to verify this search' };
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== pending.expectedRevision || expectedRevision !== state.stateRevision) {
    return { ok: false, state, reason: 'Stale Deck Search verification revision' };
  }
  if (!commandId || commandId.length > 128 || state.processedCommandIds?.includes(commandId)) {
    return { ok: false, state, reason: 'Invalid or duplicate Deck Search verification command' };
  }
  const events: GameEvent[] = [{
    type: 'DECK_SEARCH_VERIFIED', deckOwnerId: pending.deckOwnerId, searcherId: pending.searcherId,
    verifierId, eventId: eventId(state, `search-verified:${commandId}`)
  }];
  const transaction = runGameTransaction(state, draft => ({
    ...draft,
    pendingDeckSearchVerification: undefined,
    stateRevision: expectedRevision + 1,
    processedCommandIds: [...(draft.processedCommandIds ?? []), commandId].slice(-128)
  }), events, { allowPendingPlayerChoice: true });
  return failure(state, transaction);
}
