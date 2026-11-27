import { describe, expect, it } from 'vitest';
import type { Card, CardInstance, GameState, PlayerState } from '../src/engine/types';
import {
  approveManualOverride,
  autoApproveManualOverride,
  beginManualOverrideQueue,
  rejectManualOverride,
} from '../src/engine/hybridMode';
import { resolveDeckChoice } from '../src/engine/deckOperations';
import { resolveHellChoice } from '../src/engine/hellChoice';
import {
  decodeNetMessage,
  isManualOverrideCommandCurrent,
  redactLifeCardsForViewer,
} from '../src/engine/multiplayer';
import { validateGameState } from '../src/engine/gameRules';

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

function makePlayer(id: string, seat: number, base: Card): PlayerState {
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
    player.deck.push(instance(`${id}-deck-${index}`, id, { ...base, name: `${id} Deck ${index}` }, { isFaceUp: false }));
    player.lifeDeck.push(instance(`${id}-life-${index}`, id, { ...base, type: 'Life', name: `${id} LIFE ${index}` }, { isFaceUp: false }));
  }
  player.hand.push(instance(`${id}-hand-0`, id, { ...base, name: `${id} Hand 0` }));
  player.avatarZone.push(instance(`${id}-avatar-0`, id, { ...base, type: 'Avatar', name: `${id} Avatar`, power: 3 }));
  return player;
}

function makeState(): GameState {
  const base: Card = {
    printId: 'phase8-base',
    name: 'Base',
    type: 'Avatar',
    soi: 1,
    cost: 1,
    gem: 0,
    power: 2,
    color: 'แดง',
    rarity: 'C',
    mainEffect: '',
    isOnlyOne: false,
    isBias: false,
    isCollab: false,
    imageUrl: 'https://cdn.bottcg.com/cards/card-back.png'
  };
  return {
    id: 'phase8-manual',
    mode: 'DUEL',
    ruleMode: 'HYBRID',
    playerOrder: ['p1', 'p2'],
    currentTurnPlayerIndex: 0,
    currentPhase: 'MAIN',
    turnNumber: 1,
    roundNumber: 1,
    landMagicZone: null,
    players: { p1: makePlayer('p1', 0, base), p2: makePlayer('p2', 1, base) },
    stateRevision: 0,
    eventLog: []
  };
}

const CONTEXT = {
  cardInstanceId: 'p1-avatar-0',
  cardName: 'เลือกมันสำหรับพวก จน !!!',
  cardText: 'ค้นหาการ์ดจาก Deck 1 ใบ แล้วสับ Deck',
  cardStatus: 'UNSUPPORTED' as const
};

function approveAll(state: GameState, approverId = 'p2'): GameState {
  const result = approveManualOverride(state, approverId);
  expect(result.ok).toBe(true);
  return result.state;
}

describe('phase 8 manual Deck Search with mandatory shuffle and redaction', () => {
  it('opens an authorized pending Deck choice, resolves to hand, and shuffles the remainder', () => {
    const state = makeState();
    // 'Deck' matches every deck card, so the search cannot auto-resolve and must open a choice.
    const begun = beginManualOverrideQueue(state, 'p1', [{
      kind: 'MANUAL_SEARCH_DECK',
      deckOwnerId: 'p1',
      criteria: { nameIncludes: 'p1 Deck' },
      selectCount: 1,
      destination: 'hand'
    }], CONTEXT, 'cmd-search-1');
    expect(begun.ok).toBe(true);
    const approved = approveAll(begun.state);
    // The search opens a private pending choice scoped to the acting player only.
    expect(approved.pendingDeckChoice?.kind).toBe('SEARCH');
    expect(approved.pendingDeckChoice?.authorizedViewerId).toBe('p1');
    expect(approved.pendingDeckChoice?.destination).toBe('hand');
    expect(approved.pendingDeckChoice?.candidateInstanceIds).toHaveLength(6);

    // Hidden-state redaction: the opponent sees no candidate identities and a hidden deck.
    const redacted = redactLifeCardsForViewer(approved, 'p2');
    expect(redacted.pendingDeckChoice?.candidateInstanceIds).toEqual([]);
    expect(redacted.players.p1.deck.every(card => card.card.printId === 'hidden-private-card')).toBe(true);

    const chosen = approved.pendingDeckChoice!.candidateInstanceIds[2];
    const resolved = resolveDeckChoice(approved, 'p1', [chosen], approved.pendingDeckChoice!.expectedRevision, { commandId: 'resolve-search-1' });
    expect(resolved.ok).toBe(true);
    expect(resolved.state.players.p1.hand.some(card => card.instanceId === chosen)).toBe(true);
    expect(resolved.state.players.p1.deck.some(card => card.instanceId === chosen)).toBe(false);
    // Rule Book 3.2: the unselected cards are always shuffled after a Deck Search.
    const shuffledEvents = (resolved.state.gameEvents ?? []).filter(event => event.event.type === 'DECK_SHUFFLED');
    expect(shuffledEvents.length).toBeGreaterThan(0);
    expect(validateGameState(resolved.state)).toBeNull();
  });

  it('shuffles and demands opponent verification when the search finds nothing', () => {
    const state = makeState();
    const begun = beginManualOverrideQueue(state, 'p1', [{
      kind: 'MANUAL_SEARCH_DECK',
      deckOwnerId: 'p1',
      criteria: { nameIncludes: 'ไม่มีอยู่จริงในเด็คนี้' },
      selectCount: 1,
      destination: 'hand'
    }], CONTEXT, 'cmd-search-empty');
    expect(begun.ok).toBe(true);
    const approved = approveAll(begun.state);
    expect(approved.pendingDeckSearchVerification?.searcherId).toBe('p1');
    expect(approved.pendingDeckSearchVerification?.verifierPlayerIds).toEqual(['p2']);
    const shuffledEvents = (approved.gameEvents ?? []).filter(event => event.event.type === 'DECK_SHUFFLED');
    expect(shuffledEvents.length).toBeGreaterThan(0);
  });

  it('rejects an unauthorized viewer and out-of-range counts', () => {
    const state = makeState();
    const begun = beginManualOverrideQueue(state, 'p1', [{
      kind: 'MANUAL_SEARCH_DECK',
      deckOwnerId: 'p1',
      criteria: {},
      selectCount: 11,
      destination: 'hand'
    }], CONTEXT, 'cmd-search-big');
    expect(begun.ok).toBe(false);
    const resolved = resolveDeckChoice(state, 'p2', [], 0, {});
    expect(resolved.ok).toBe(false);
  });
});

describe('phase 8 Scout, Mill, Hell choice, and Token spawn', () => {
  it('scouts the top N cards and returns them to the top of the Deck', () => {
    const state = makeState();
    const begun = beginManualOverrideQueue(state, 'p1', [{
      kind: 'MANUAL_SCOUT_DECK', deckOwnerId: 'p1', count: 2, destination: 'deck',
      selectedDeckPosition: 'top', unselectedDeckPosition: 'bottom'
    }], CONTEXT, 'cmd-scout-1');
    expect(begun.ok).toBe(true);
    const approved = approveAll(begun.state);
    expect(approved.pendingDeckChoice?.kind).toBe('SCOUT');
    expect(approved.pendingDeckChoice?.candidateInstanceIds).toHaveLength(2);
    const candidates = approved.pendingDeckChoice!.candidateInstanceIds;
    const resolved = resolveDeckChoice(approved, 'p1', candidates, approved.pendingDeckChoice!.expectedRevision, {
      commandId: 'resolve-scout-1'
    });
    expect(resolved.ok).toBe(true);
    // Both scouted cards return to the top of the Deck in selection order.
    expect(resolved.state.players.p1.deck.slice(0, 2).map(card => card.instanceId)).toEqual(candidates);
    expect(resolved.state.players.p1.deck).toHaveLength(6);
  });

  it('mills the top N cards into Hell and reports the milled identities', () => {
    const state = makeState();
    const begun = beginManualOverrideQueue(state, 'p1', [{
      kind: 'MANUAL_MILL_DECK', deckOwnerId: 'p1', count: 2
    }], CONTEXT, 'cmd-mill-1');
    expect(begun.ok).toBe(true);
    const approved = approveAll(begun.state);
    expect(approved.players.p1.deck).toHaveLength(4);
    expect(approved.players.p1.hell).toHaveLength(2);
    const milledEvents = (approved.gameEvents ?? []).filter(event => event.event.type === 'DECK_MILLED');
    expect(milledEvents).toHaveLength(1);
    expect(milledEvents[0].event.cardInstanceIds).toHaveLength(2);
    expect(validateGameState(approved)).toBeNull();
  });

  it('opens an authorized Hell choice and recovers the selected card to hand', () => {
    const state = makeState();
    const milled = beginManualOverrideQueue(state, 'p1', [{ kind: 'MANUAL_MILL_DECK', deckOwnerId: 'p1', count: 1 }], CONTEXT, 'cmd-mill-2');
    const withMilled = approveAll(milled.state);
    const milledId = withMilled.players.p1.hell[0].instanceId;
    const begun = beginManualOverrideQueue(withMilled, 'p1', [{
      kind: 'MANUAL_HELL_CHOICE', playerId: 'p1', cardType: 'Avatar', count: 1, destination: 'hand'
    }], CONTEXT, 'cmd-hell-1');
    expect(begun.ok).toBe(true);
    const approved = approveAll(begun.state);
    expect(approved.pendingHellChoice?.authorizedViewerId).toBe('p1');
    expect(approved.pendingHellChoice?.candidateInstanceIds).toContain(milledId);
    const resolved = resolveHellChoice(approved, 'p1', [milledId], approved.pendingHellChoice!.expectedRevision, 'resolve-hell-1');
    expect(resolved.ok).toBe(true);
    expect(resolved.state.players.p1.hand.some(card => card.instanceId === milledId)).toBe(true);
    expect(resolved.state.players.p1.hell.some(card => card.instanceId === milledId)).toBe(false);
  });

  it('spawns a Token inside the 6-card Avatar Zone cap and refuses beyond it', () => {
    const state = makeState();
    const begun = beginManualOverrideQueue(state, 'p1', [{
      kind: 'MANUAL_SPAWN_TOKEN', playerId: 'p1', name: 'Token ทดสอบ', power: 2
    }], CONTEXT, 'cmd-token-1');
    expect(begun.ok).toBe(true);
    const approved = approveAll(begun.state);
    const zone = approved.players.p1.avatarZone;
    expect(zone).toHaveLength(2);
    const token = zone[1];
    expect(token.card.type).toBe('Token');
    expect(token.card.name).toBe('Token ทดสอบ');
    expect(token.card.power).toBe(2);
    expect(token.controllerId).toBe('p1');
    expect(validateGameState(approved)).toBeNull();

    // Fill the zone to the 6-card total limit; the next Token must be refused.
    let full = approved;
    for (let index = 0; index < 4; index += 1) {
      const step = beginManualOverrideQueue(full, 'p1', [{ kind: 'MANUAL_SPAWN_TOKEN', playerId: 'p1' }], CONTEXT, `cmd-token-fill-${index}`);
      expect(step.ok).toBe(true);
      full = approveAll(step.state);
    }
    expect(full.players.p1.avatarZone).toHaveLength(6);
    const refused = beginManualOverrideQueue(full, 'p1', [{ kind: 'MANUAL_SPAWN_TOKEN', playerId: 'p1' }], CONTEXT, 'cmd-token-over');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('6-card total limit');
  });
});

describe('phase 8 multi-step queue with opponent Confirm/Reject', () => {
  it('applies a queued Mill + Draw effect after one opponent approval and logs every step', () => {
    const state = makeState();
    const handBefore = state.players.p1.hand.length;
    const begun = beginManualOverrideQueue(state, 'p1', [
      { kind: 'MANUAL_MILL_DECK', deckOwnerId: 'p1', count: 2 },
      { kind: 'DRAW_CARD', playerId: 'p1' }
    ], CONTEXT, 'cmd-queue-1');
    expect(begun.ok).toBe(true);
    expect(begun.state.pendingManualOverride?.actions).toHaveLength(2);
    const proposalEntry = begun.state.eventLog.at(-1)!;
    expect(proposalEntry.description).toContain('2 ขั้นตอน');

    const approved = approveAll(begun.state);
    expect(approved.pendingManualOverride).toBeUndefined();
    // Mill 2 (6 -> 4) then draw 1 (4 -> 3).
    expect(approved.players.p1.deck).toHaveLength(3);
    expect(approved.players.p1.hell).toHaveLength(2);
    expect(approved.players.p1.hand).toHaveLength(handBefore + 1);
    const appliedEntry = approved.eventLog.at(-1)!;
    expect(appliedEntry.description).toContain('Manual Override ได้รับการยืนยัน');
    expect(appliedEntry.description).toContain('→');
    expect(validateGameState(approved)).toBeNull();
  });

  it('cancels the whole queue all-or-nothing when a later step fails at application time', () => {
    const state = makeState();
    // p1 has a 6-card deck; seven draws exceed it, so the final step must fail and roll everything back.
    const begun = beginManualOverrideQueue(state, 'p1', Array.from({ length: 7 }, (_, index) => ({
      kind: 'DRAW_CARD' as const,
      playerId: 'p1',
      // Unique per-step context is unnecessary; the queue itself is one override.
      ...(index === -1 ? {} : {})
    })), CONTEXT, 'cmd-queue-fail');
    expect(begun.ok).toBe(true);
    const approved = approveAll(begun.state);
    expect(approved.pendingManualOverride).toBeUndefined();
    expect(approved.players.p1.hand).toHaveLength(1);
    expect(approved.players.p1.deck).toHaveLength(6);
    expect(approved.eventLog.at(-1)!.description).toContain('นำไปใช้ไม่สำเร็จ');
  });

  it('discards the whole queue when the opponent rejects it', () => {
    const state = makeState();
    const begun = beginManualOverrideQueue(state, 'p1', [
      { kind: 'MANUAL_MILL_DECK', deckOwnerId: 'p1', count: 1 },
      { kind: 'DRAW_CARD', playerId: 'p1' }
    ], CONTEXT, 'cmd-queue-reject');
    expect(begun.ok).toBe(true);
    const rejected = rejectManualOverride(begun.state, 'p2');
    expect(rejected.ok).toBe(true);
    expect(rejected.state.pendingManualOverride).toBeUndefined();
    expect(rejected.state.players.p1.deck).toHaveLength(6);
    expect(rejected.state.players.p1.hell).toHaveLength(0);
    expect(rejected.state.eventLog.at(-1)!.description).toContain('ปฏิเสธ');
  });

  it('forces a Deck/Hell choice step to be the final queue step', () => {
    const state = makeState();
    const begun = beginManualOverrideQueue(state, 'p1', [
      { kind: 'MANUAL_SEARCH_DECK', deckOwnerId: 'p1', criteria: {}, selectCount: 1, destination: 'hand' },
      { kind: 'DRAW_CARD', playerId: 'p1' }
    ], CONTEXT, 'cmd-queue-order');
    expect(begun.ok).toBe(false);
    expect(begun.reason).toContain('final step');
  });

  it('applies offline through the auto-approval path', () => {
    const state = makeState();
    const begun = beginManualOverrideQueue(state, 'p1', [
      { kind: 'MANUAL_SHUFFLE_DECK', deckOwnerId: 'p1' },
      { kind: 'MANUAL_MILL_DECK', deckOwnerId: 'p1', count: 1 }
    ], CONTEXT, 'cmd-queue-offline');
    expect(begun.ok).toBe(true);
    const applied = autoApproveManualOverride(begun.state);
    expect(applied.ok).toBe(true);
    expect(applied.state.players.p1.deck).toHaveLength(5);
    const shuffledEvents = (applied.state.gameEvents ?? []).filter(event => event.event.type === 'DECK_SHUFFLED');
    expect(shuffledEvents.length).toBeGreaterThan(0);
  });
});

describe('phase 8 network command surface', () => {
  it('authenticates and decodes a queued SUBMIT_MANUAL_OVERRIDE command', () => {
    const state = makeState();
    const actions = [
      { kind: 'MANUAL_MILL_DECK' as const, deckOwnerId: 'p1', count: 1 },
      { kind: 'DRAW_CARD' as const, playerId: 'p1' }
    ];
    const command = {
      kind: 'SUBMIT_MANUAL_OVERRIDE' as const,
      playerId: 'p1',
      commandId: 'net-queue-1',
      expectedRevision: 0,
      actions,
      context: CONTEXT
    };
    expect(isManualOverrideCommandCurrent(state, command, 'p1')).toBe(true);
    const decoded = decodeNetMessage(JSON.stringify({ type: 'MANUAL_OVERRIDE_COMMAND', command }));
    expect(decoded?.type).toBe('MANUAL_OVERRIDE_COMMAND');
    // Approve/reject commands must never carry an action payload.
    expect(isManualOverrideCommandCurrent(state, { ...command, kind: 'APPROVE_MANUAL_OVERRIDE' }, 'p1')).toBe(false);
    const tampered = decodeNetMessage(JSON.stringify({
      type: 'MANUAL_OVERRIDE_COMMAND',
      command: { ...command, kind: 'APPROVE_MANUAL_OVERRIDE' }
    }));
    expect(tampered).toBeNull();
  });
});
