import { describe, expect, it } from 'vitest';
import { validateMagicPlay, moveCardBetweenZones } from '../src/engine/gameRules';
import { runGameTransaction } from '../src/engine/gameTransaction';
import {
  confirmNoSearchTarget,
  createSeededRandom,
  millCards,
  resolveDeckChoice,
  scoutCards,
  searchDeck,
  shuffleDeck
} from '../src/engine/deckOperations';
import { redactLifeCardsForViewer } from '../src/engine/multiplayer';
import { openReactionWindow } from '../src/engine/reactionEngine';
import type { Card, CardInstance, GameState, PlayerState } from '../src/engine/types';

function makeCard(name: string, type: Card['type'] = 'Avatar', overrides: Partial<Card> = {}): Card {
  return {
    printId: name,
    name,
    type,
    subtype: null,
    cost: 2,
    gem: 1,
    power: 3,
    color: 'แดง',
    symbol: 'คน',
    rarity: 'C',
    mainEffect: '',
    isOnlyOne: false,
    isBias: false,
    isCollab: false,
    imageUrl: '',
    ...overrides
  };
}

function makeInstance(id: string, ownerId = 'p1', card = makeCard(id)): CardInstance {
  return {
    instanceId: id,
    card,
    ownerId,
    controllerId: ownerId,
    isRested: false,
    isFaceUp: false,
    attachedInstances: [],
    layerModifiers: []
  };
}

function makePlayer(id: string, deck: CardInstance[] = []): PlayerState {
  return {
    id,
    name: id,
    seat: id === 'p1' ? 0 : id === 'p2' ? 1 : 2,
    deck,
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

function makeState(deck: CardInstance[] = [], playerIds = ['p1', 'p2', 'p3']): GameState {
  const players = Object.fromEntries(playerIds.map((id, index) => [
    id,
    { ...makePlayer(id, id === 'p1' ? deck : []), seat: index }
  ]));
  return {
    id: 'deck-ops',
    mode: playerIds.length === 2 ? 'DUEL' : 'AD_MUA',
    playerOrder: playerIds,
    currentTurnPlayerIndex: 0,
    currentPhase: 'MAIN',
    turnNumber: 1,
    roundNumber: 1,
    players,
    landMagicZone: null,
    eventLog: [],
    stateRevision: 0
  };
}

const playerDeck = (...ids: string[]) => ids.map(id => makeInstance(id));

describe('Phase 2A Deck Operations', () => {
  it('shuffles transactionally with seeded, reproducible order and typed events', () => {
    const state = makeState(playerDeck('a', 'b', 'c', 'd', 'e', 'f'));
    const first = shuffleDeck(state, 'p1', { seed: 'phase-2a' });
    const second = shuffleDeck(state, 'p1', { seed: 'phase-2a' });
    expect(first.ok).toBe(true);
    expect(first.state.players.p1.deck.map(card => card.instanceId)).toEqual(second.state.players.p1.deck.map(card => card.instanceId));
    expect(first.state.gameEvents?.at(-1)?.event).toMatchObject({ type: 'DECK_SHUFFLED', playerId: 'p1', cardCount: 6 });
    expect(first.state.stateRevision).toBe(1);

    const failed = shuffleDeck(state, 'p1', { random: () => Number.NaN });
    expect(failed.ok).toBe(false);
    expect(failed.state).toBe(state);
    expect(failed.state.players.p1.deck.map(card => card.instanceId)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(createSeededRandom(9)()).toBe(createSeededRandom(9)());
  });

  it('mills exactly the available top cards, routes them to public Hell, and signals Rule Book deck-out at zero', () => {
    const state = makeState(playerDeck('a', 'b'));
    const result = millCards(state, 'p1', 5);
    expect(result.ok).toBe(true);
    expect(result.state.players.p1.deck).toHaveLength(0);
    expect(result.state.players.p1.hell.map(card => card.instanceId)).toEqual(['a', 'b']);
    expect(result.state.gameEvents?.map(({ event }) => event.type)).toContain('DECK_MILLED');
    expect(result.state.gameEvents?.map(({ event }) => event.type)).toContain('PLAYER_DECKED_OUT');
    expect(result.state.gameEvents?.some(({ event }) => event.type === 'CARD_MOVED' && event.instanceId === 'a' && event.to === 'p1:hell')).toBe(true);
    const exact = millCards(makeState(playerDeck('top-1', 'top-2', 'remain-1', 'remain-2')), 'p1', 2);
    expect(exact.state.players.p1.hell.map(card => card.instanceId)).toEqual(['top-1', 'top-2']);
    expect(exact.state.players.p1.deck.map(card => card.instanceId)).toEqual(['remain-1', 'remain-2']);
    expect(exact.deckOutPlayerId).toBeUndefined();
    expect(result.deckOutPlayerId).toBe('p1');

    const duel = millCards(makeState(playerDeck('last'), ['p1', 'p2']), 'p1', 1);
    expect(duel.winnerId).toBe('p2');
    const shortDeck = makeState(playerDeck('only'));
    const redacted = redactLifeCardsForViewer(result.state, 'p2');
    expect(redacted.players.p1.hell[0].card.name).toBe('a');
    expect(shortDeck.players.p1.deck).toHaveLength(1);
  });

  it('mills an empty deck without throwing and does not report a new deck-out on a zero-card request', () => {
    const state = makeState([]);
    const emptyDeck = millCards(state, 'p1', 4);
    expect(emptyDeck.ok).toBe(true);
    expect(emptyDeck.state.players.p1.deck).toHaveLength(0);
    expect(emptyDeck.deckOutPlayerId).toBe('p1');
    expect(millCards(state, 'p1', 0).state).toBe(state);
    expect(millCards(state, 'p1', -1)).toMatchObject({ ok: false, state });
  });

  it('searches by typed fields, validates eligibility and duplicates, then shuffles after a successful search', () => {
    const cards = [
      makeInstance('match-a', 'p1', makeCard('Alpha', 'Avatar', { cost: 2, color: 'แดง', symbol: 'คน' })),
      makeInstance('match-b', 'p1', makeCard('Alpha', 'Avatar', { cost: 3, color: 'แดง', symbol: 'คน' })),
      makeInstance('other', 'p1', makeCard('Beta', 'Magic', { cost: 1, color: 'ฟ้า' })),
      makeInstance('tail')
    ];
    const state = makeState(cards, ['p1', 'p2']);
    const criteria = { types: ['Avatar'] as Card['type'][], colors: ['แดง'], minCost: 2, maxCost: 3, exactName: 'Alpha', symbols: ['คน'] };
    const pending = searchDeck(state, 'p1', criteria, { selectCount: 1 });
    expect(pending).toMatchObject({ ok: true, choiceRequired: true });
    const custom = searchDeck(state, 'p1', { predicate: card => card.cost === 3 }, { destination: 'hell', seed: 4 });
    expect(custom.ok).toBe(true);
    expect(custom.state.players.p1.hell.map(card => card.instanceId)).toContain('match-b');
    expect(pending.state.pendingDeckChoice?.candidateInstanceIds).toEqual(['match-a', 'match-b']);
    expect(redactLifeCardsForViewer(pending.state, 'p2').players.p1.deck.every(card => card.card.printId === 'hidden-private-card')).toBe(true);
    expect(redactLifeCardsForViewer(pending.state, 'p2').pendingDeckChoice?.candidateInstanceIds).toEqual([]);

    const revision = pending.state.stateRevision!;
    const invalid = resolveDeckChoice(pending.state, 'p1', ['other'], revision, { seed: 5 });
    expect(invalid.ok).toBe(false);
    expect(invalid.state).toBe(pending.state);
    const duplicate = resolveDeckChoice(pending.state, 'p1', ['match-a', 'match-a'], revision, { seed: 5 });
    expect(duplicate.ok).toBe(false);
    const stale = resolveDeckChoice(pending.state, 'p1', ['match-a'], revision - 1, { seed: 5 });
    expect(stale).toMatchObject({ ok: false, reason: 'Stale Deck choice revision' });

    const resolved = resolveDeckChoice(pending.state, 'p1', ['match-a'], revision, { seed: 'search', commandId: 'search-1' });
    expect(resolved.ok).toBe(true);
    expect(resolved.state.pendingDeckChoice).toBeUndefined();
    expect(resolved.state.players.p1.hand.map(card => card.instanceId)).toEqual(['match-a']);
    expect(resolved.state.players.p1.deck.map(card => card.instanceId)).toHaveLength(3);
    const privateResult = redactLifeCardsForViewer(resolved.state, 'p2');
    expect(privateResult.players.p1.hand[0].card.printId).toBe('hidden-private-card');
    expect(privateResult.players.p1.deck.every(card => card.card.printId === 'hidden-private-card')).toBe(true);
    expect(privateResult.gameEvents?.some(({ event }) => event.type === 'DECK_SEARCHED' && ('instanceId' in event || 'found' in event))).toBe(false);
    expect(resolved.state.gameEvents?.some(({ event }) => event.type === 'DECK_SHUFFLED')).toBe(true);
    expect(resolved.state.gameEvents?.find(({ event }) => event.type === 'DECK_SEARCHED')?.event).toMatchObject({ found: true, destination: 'hand' });
    const duplicateCommand = resolveDeckChoice(resolved.state, 'p1', ['match-a'], revision, { commandId: 'search-1' });
    expect(duplicateCommand.ok).toBe(false);
  });

  it('auto-resolves a fixed search, shuffles even on no match, and only publishes searched identities in public Hell', () => {
    const card = makeInstance('unique', 'p1', makeCard('Exact', 'Construct', { cost: 4 }));
    const state = makeState([card, ...playerDeck('x', 'y')], ['p1', 'p2']);
    const found = searchDeck(state, 'p1', { exactName: 'Exact' }, { destination: 'hell', seed: 23 });
    expect(found.ok).toBe(true);
    expect(found.state.players.p1.hell.map(item => item.instanceId)).toContain('unique');
    expect(found.state.players.p1.deck).toHaveLength(2);
    expect(found.state.gameEvents?.some(({ event }) => event.type === 'DECK_SHUFFLED')).toBe(true);
    expect(redactLifeCardsForViewer(found.state, 'p2').gameEvents?.some(({ event }) => event.type === 'DECK_SEARCHED' && event.instanceId === 'unique')).toBe(true);
    const lastCardSearch = searchDeck(makeState([card], ['p1', 'p2']), 'p1', { exactName: 'Exact' }, { destination: 'hand', seed: 2 });
    expect(lastCardSearch.deckOutPlayerId).toBe('p1');
    expect(lastCardSearch.winnerId).toBe('p2');

    const noMatch = searchDeck(state, 'p1', { exactName: 'absent' }, { seed: 23 });
    expect(noMatch).toMatchObject({ ok: true, found: false, verificationRequired: true });
    expect(noMatch.state.players.p1.deck.map(item => item.instanceId)).toEqual(
      searchDeck(state, 'p1', { exactName: 'absent' }, { seed: 23 }).state.players.p1.deck.map(item => item.instanceId)
    );
    expect(noMatch.state.gameEvents?.map(({ event }) => event.type)).toContain('DECK_SHUFFLED');
    expect(noMatch.state.gameEvents?.find(({ event }) => event.type === 'DECK_SEARCHED')?.event).toMatchObject({ found: false });
    expect(noMatch.state.pendingDeckSearchVerification?.verifierPlayerIds).toEqual(['p2']);
    expect(shuffleDeck(noMatch.state, 'p1', { seed: 1 }).ok).toBe(false);
    expect(confirmNoSearchTarget(noMatch.state, 'p1', noMatch.state.stateRevision!, 'verify-wrong').ok).toBe(false);
    expect(confirmNoSearchTarget(noMatch.state, 'p2', noMatch.state.stateRevision! - 1, 'verify-stale').ok).toBe(false);
    const verified = confirmNoSearchTarget(noMatch.state, 'p2', noMatch.state.stateRevision!, 'verify-1');
    expect(verified.ok).toBe(true);
    expect(verified.state.pendingDeckSearchVerification).toBeUndefined();
    expect(verified.state.gameEvents?.map(({ event }) => event.type)).toContain('DECK_SEARCH_VERIFIED');

    const failedSelection = searchDeck(state, 'p1', { exactName: 'Exact' }, { selectedInstanceIds: ['x'] });
    expect(failedSelection.ok).toBe(false);
    expect(failedSelection.state).toBe(state);
  });

  it('scouts only the top N, authorizes the selected viewer, supports explicit top ordering and bottom placement', () => {
    const state = makeState(playerDeck('a', 'b', 'c', 'd', 'e'), ['p1', 'p2', 'p3']);
    const unspecified = scoutCards(state, 'p1', 2);
    expect(unspecified.state.pendingDeckChoice?.maxSelect).toBe(0);
    expect(resolveDeckChoice(unspecified.state, 'p1', ['a'], unspecified.state.stateRevision!).ok).toBe(false);
    const shuffledBack = resolveDeckChoice(unspecified.state, 'p1', [], unspecified.state.stateRevision!, { seed: 'scout-unspecified' });
    expect(shuffledBack.ok).toBe(true);
    expect(shuffledBack.state.gameEvents?.some(({ event }) => event.type === 'DECK_SHUFFLED')).toBe(true);

    const pending = scoutCards(state, 'p1', 3, {
      viewerId: 'p2', destination: 'deck', selectedDeckPosition: 'top',
      unselectedDeckPosition: 'bottom', topOrderAllowed: true
    });
    expect(pending).toMatchObject({ ok: true, choiceRequired: true });
    expect(pending.state.pendingDeckChoice?.candidateInstanceIds).toEqual(['a', 'b', 'c']);
    const authorized = redactLifeCardsForViewer(pending.state, 'p2');
    expect(authorized.players.p1.deck.slice(0, 3).map(card => card.card.name)).toEqual(['a', 'b', 'c']);
    const unauthorized = redactLifeCardsForViewer(pending.state, 'p3');
    expect(unauthorized.players.p1.deck.every(card => card.card.printId === 'hidden-private-card')).toBe(true);
    expect(unauthorized.pendingDeckChoice?.candidateInstanceIds).toEqual([]);
    expect(unauthorized.gameEvents?.find(({ event }) => event.type === 'DECK_SCOUTED')?.event).toMatchObject({ cardInstanceIds: [] });

    const resolved = resolveDeckChoice(pending.state, 'p2', ['a', 'b'], pending.state.stateRevision!, { topOrderIds: ['b', 'a'] });
    expect(resolved.ok).toBe(true);
    expect(resolved.state.players.p1.deck.map(card => card.instanceId)).toEqual(['b', 'a', 'd', 'e', 'c']);
    expect(resolveDeckChoice(pending.state, 'p3', ['a'], pending.state.stateRevision!).ok).toBe(false);

    const bottomState = makeState(playerDeck('a', 'b', 'c', 'd'));
    const bottomPending = scoutCards(bottomState, 'p1', 2, {
      destination: 'deck', selectedDeckPosition: 'bottom', unselectedDeckPosition: 'top'
    });
    const bottom = resolveDeckChoice(bottomPending.state, 'p1', ['a', 'b'], bottomPending.state.stateRevision!);
    expect(bottom.state.players.p1.deck.map(card => card.instanceId)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('locks conflicting actions while a Deck choice is pending', () => {
    const state = makeState(playerDeck('a', 'b'));
    const unauthorizedReorder = moveCardBetweenZones(state, { instanceId: 'a', actorId: 'p1', destination: 'deck', deckPosition: 'top' });
    expect(unauthorizedReorder.ok).toBe(false);
    const pending = scoutCards(state, 'p1', 1);
    expect(pending.ok).toBe(true);
    expect(validateMagicPlay(pending.state, 'p1', 'Normal')).toContain('Deck operation choice');
    const move = moveCardBetweenZones(pending.state, { instanceId: 'a', actorId: 'p1', destination: 'hell' });
    expect(move.ok).toBe(false);
    expect(openReactionWindow(pending.state, { type: 'AVATAR_SUMMONED', actorId: 'p1' })).toBe(pending.state);
    expect(runGameTransaction(pending.state, draft => ({ ...draft, turnNumber: draft.turnNumber + 1 })).ok).toBe(false);
    expect(shuffleDeck(pending.state, 'p1', { seed: 1 }).ok).toBe(false);
  });

  it('rolls back nested deck operations, including private state and event history', () => {
    const state = makeState(playerDeck('a', 'b', 'c'));
    const rollbackMill = runGameTransaction(state, draft => {
      const nested = millCards(draft, 'p1', 2);
      expect(nested.ok).toBe(true);
      return null;
    });
    expect(rollbackMill.ok).toBe(false);
    expect(rollbackMill.state.players.p1.deck.map(card => card.instanceId)).toEqual(['a', 'b', 'c']);
    expect(rollbackMill.state.players.p1.hell).toHaveLength(0);
    expect(rollbackMill.state.gameEvents).toBeUndefined();

    const rollbackChoice = runGameTransaction(state, draft => {
      const nested = scoutCards(draft, 'p1', 2);
      expect(nested.ok).toBe(true);
      expect(nested.state.pendingDeckChoice?.candidateInstanceIds).toEqual(['a', 'b']);
      return null;
    });
    expect(rollbackChoice.ok).toBe(false);
    expect(rollbackChoice.state.pendingDeckChoice).toBeUndefined();
    expect(rollbackChoice.state.players.p1.deck.map(card => card.instanceId)).toEqual(['a', 'b', 'c']);
  });
});
