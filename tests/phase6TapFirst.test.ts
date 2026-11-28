import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Card, CardInstance, GameState, PlayerState } from '../src/engine/types';
import { deriveLegalAvatarActions, deriveLegalHandActions, describeBlockedHandReason } from '../src/engine/legalActions';
import {
  beginDispatch,
  cancelHandSelection,
  EMPTY_DISPATCH_GUARD,
  isDispatchLocked,
  isExplicitlyConfirmed,
  NO_SELECTION,
  RAPID_TAP_GUARD_MS,
  tapHandCard,
} from '../src/engine/tapFirstInteraction';
import {
  approveManualOverride,
  beginManualOverride,
  classifyCard,
  engineRequiresManualResolution,
  shouldOfferManualResolution,
} from '../src/engine/hybridMode';
import { redactLifeCardsForViewer } from '../src/engine/multiplayer';
import { validateGameState } from '../src/engine/gameRules';

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
  player.hand.push(instance(`${id}-hand-1`, id, { ...base, name: `${id} Hand 1` }));
  player.avatarZone.push(instance(`${id}-avatar-0`, id, { ...base, type: 'Avatar', name: `${id} Avatar`, power: 3 }));
  return player;
}

function makeState(playerCount: 2 | 3 | 4, overrides: Partial<GameState> = {}): GameState {
  const base = catalog[0];
  const order = Array.from({ length: playerCount }, (_, index) => `p${index + 1}`);
  const players = Object.fromEntries(order.map((id, index) => [id, makePlayer(id, index, base)]));
  return {
    id: 'phase6-tapfirst',
    mode: 'DUEL',
    ruleMode: 'HYBRID',
    playerOrder: order,
    currentTurnPlayerIndex: 0,
    currentPhase: 'MAIN',
    turnNumber: 1,
    roundNumber: 1,
    landMagicZone: null,
    players,
    stateRevision: 0,
    eventLog: [],
    ...overrides
  };
}

const avatarCard = (overrides: Partial<Card> = {}): Card => ({
  ...catalog[0],
  type: 'Avatar',
  subtype: undefined,
  cost: 1,
  gem: 0,
  power: 3,
  mainEffect: '',
  name: 'Test Avatar',
  ...overrides
});

const magicCard = (overrides: Partial<Card> = {}): Card => ({
  ...catalog[0],
  type: 'Magic',
  subtype: 'Normal',
  cost: 0,
  mainEffect: '',
  name: 'Test Magic',
  ...overrides
});

const constructCard = (overrides: Partial<Card> = {}): Card => ({
  ...catalog[0],
  type: 'Construct',
  cost: 0,
  mainEffect: '',
  name: 'Test Construct',
  ...overrides
});

describe('phase 6 tap-first selection contract', () => {
  it('first tap only selects the card and never dispatches a gameplay action', () => {
    const selection = tapHandCard(NO_SELECTION, 'hand-1');
    expect(selection).toEqual({ selectedHandCardId: 'hand-1' });
    // The tap result carries no dispatch channel at all — dispatching is a
    // separate, explicit confirmation step.
    expect(Object.keys(selection)).toEqual(['selectedHandCardId']);
  });

  it('tapping the selected card again only deselects it', () => {
    const selection = tapHandCard({ selectedHandCardId: 'hand-1' }, 'hand-1');
    expect(selection).toEqual(NO_SELECTION);
  });

  it('canceling the selection clears it and leaves the game state untouched', () => {
    const state = makeState(2);
    const before = JSON.stringify(state);
    const selection = cancelHandSelection();
    expect(selection).toEqual(NO_SELECTION);
    // The cancel path is pure: it cannot mutate the game state.
    expect(JSON.stringify(state)).toBe(before);
  });

  it('zero-cost cards are dispatched only through the same explicit confirmation gate', () => {
    const state = makeState(2);
    const zeroCostAvatar = instance('zero-cost-1', 'p1', avatarCard({ cost: 0 }));
    state.players.p1.hand.push(zeroCostAvatar);

    // The card is legal for the engine, but legality alone never dispatches it:
    // the tap result carries no action channel, only the selection.
    expect(deriveLegalHandActions(state, 'p1', zeroCostAvatar).map(action => action.kind)).toEqual(['SUMMON']);
    const tapped = tapHandCard(NO_SELECTION, zeroCostAvatar.instanceId);
    expect(tapped).toEqual({ selectedHandCardId: zeroCostAvatar.instanceId });

    // The confirm gate is passed only by the explicit confirmation step for the
    // selected card — identically to a costly card, with no cost-based bypass.
    expect(isExplicitlyConfirmed(tapped, zeroCostAvatar.instanceId)).toBe(true);
    expect(isExplicitlyConfirmed({ selectedHandCardId: 'other-card' }, zeroCostAvatar.instanceId)).toBe(false);
  });

  it('confirmation is bound to the currently selected card only', () => {
    expect(isExplicitlyConfirmed({ selectedHandCardId: 'hand-1' }, 'hand-2')).toBe(false);
    expect(isExplicitlyConfirmed(NO_SELECTION, 'hand-1')).toBe(false);
  });

  it('rapid repeated taps cannot dispatch duplicate actions', () => {
    const now = 1_000_000;
    const first = beginDispatch(EMPTY_DISPATCH_GUARD, 'hand-1:SUMMON', now);
    expect(first.allowed).toBe(true);

    // A second tap on the same button inside the guard window is rejected.
    const second = beginDispatch(first.guard, 'hand-1:SUMMON', now + RAPID_TAP_GUARD_MS - 1);
    expect(second.allowed).toBe(false);
    expect(second.guard).toBe(first.guard);

    // A different action key is blocked by the same window.
    expect(beginDispatch(first.guard, 'hand-2:CAST', now + 10).allowed).toBe(false);

    // After the window elapses a new dispatch is allowed and the guard clears.
    const later = beginDispatch(first.guard, 'hand-1:SUMMON', now + RAPID_TAP_GUARD_MS);
    expect(later.allowed).toBe(true);
    expect(isDispatchLocked(later.guard, now + 2 * RAPID_TAP_GUARD_MS)).toBe(false);
  });
});

describe('phase 6 engine-driven legal hand actions', () => {
  it('offers SUMMON for an Avatar in Main Phase with room in the Avatar Zone', () => {
    const state = makeState(2);
    const card = instance('a1', 'p1', avatarCard());
    state.players.p1.hand.push(card);
    expect(deriveLegalHandActions(state, 'p1', card).map(action => action.kind)).toEqual(['SUMMON']);
  });

  it('offers nothing when the Avatar Zone would exceed its 4-Avatar limit', () => {
    const state = makeState(2);
    const card = instance('a1', 'p1', avatarCard());
    state.players.p1.hand.push(card);
    for (let index = 1; index <= 4; index += 1) {
      state.players.p1.avatarZone.push(instance(`zone-avatar-${index}`, 'p1', avatarCard({ name: `Avatar ${index}` })));
    }
    expect(deriveLegalHandActions(state, 'p1', card)).toEqual([]);
  });

  it('offers nothing outside the Main Phase for a plain Avatar', () => {
    const state = makeState(2, { currentPhase: 'BATTLE' });
    const card = instance('a1', 'p1', avatarCard());
    state.players.p1.hand.push(card);
    expect(deriveLegalHandActions(state, 'p1', card)).toEqual([]);
  });

  it('offers nothing when it is not this player\'s turn', () => {
    const state = makeState(2, { currentTurnPlayerIndex: 1 });
    const card = instance('a1', 'p1', avatarCard());
    state.players.p1.hand.push(card);
    expect(deriveLegalHandActions(state, 'p1', card)).toEqual([]);
  });

  it('offers SET for a Construct only while the zone has room and no duplicate name', () => {
    const state = makeState(2);
    const card = instance('c1', 'p1', constructCard());
    state.players.p1.hand.push(card);
    expect(deriveLegalHandActions(state, 'p1', card).map(action => action.kind)).toEqual(['SET']);

    state.players.p1.constructZone.push(instance('c-dup', 'p1', constructCard()));
    expect(deriveLegalHandActions(state, 'p1', card)).toEqual([]);

    const full = makeState(2);
    const other = instance('c2', 'p1', constructCard({ name: 'Other Construct' }));
    full.players.p1.hand.push(other);
    full.players.p1.constructZone.push(
      instance('c-a', 'p1', constructCard({ name: 'A' })),
      instance('c-b', 'p1', constructCard({ name: 'B' })),
      instance('c-c', 'p1', constructCard({ name: 'C' }))
    );
    expect(deriveLegalHandActions(full, 'p1', other)).toEqual([]);
  });

  it('offers CAST for Normal Magic in Main Phase and nothing in Battle Phase', () => {
    const main = makeState(2);
    const card = instance('m1', 'p1', magicCard());
    main.players.p1.hand.push(card);
    expect(deriveLegalHandActions(main, 'p1', card).map(action => action.kind)).toEqual(['CAST']);

    const battle = makeState(2, { currentPhase: 'BATTLE' });
    battle.players.p1.hand.push(instance('m1', 'p1', magicCard()));
    expect(deriveLegalHandActions(battle, 'p1', card)).toEqual([]);
  });

  it('offers CAST_REACT for a Normal Magic with React timing during own Battle Phase', () => {
    const state = makeState(2, { currentPhase: 'BATTLE' });
    const card = instance('m1', 'p1', magicCard({
      mainEffect: 'ส่งการ์ด 1 ใบบนมือลงนรก โดยถือว่าเป็นการใช้ React Magic ใน Battle Phase ของเรา'
    }));
    state.players.p1.hand.push(card);
    expect(deriveLegalHandActions(state, 'p1', card).map(action => action.kind)).toEqual(['CAST_REACT']);
  });

  it('offers nothing while a reaction window or pending choice blocks actions', () => {
    const state = makeState(2);
    const card = instance('a1', 'p1', avatarCard());
    state.players.p1.hand.push(card);

    const withWindow = { ...state, reactionWindow: { id: 'w1' } } as unknown as GameState;
    expect(deriveLegalHandActions(withWindow, 'p1', card)).toEqual([]);

    const withDiscard = { ...state, pendingEndPhaseDiscardPlayerId: 'p1' };
    expect(deriveLegalHandActions(withDiscard, 'p1', card)).toEqual([]);
  });

  it('offers nothing in Auto-Strict rooms for cards the engine cannot fully resolve', () => {
    const state = makeState(2, { ruleMode: 'AUTO_STRICT' });
    const card = instance('a1', 'p1', avatarCard({ mainEffect: 'เมื่อโจมตี : จั่วการ์ด 1 ใบ' }));
    state.players.p1.hand.push(card);
    expect(classifyCard(card.card).status).not.toBe('VERIFIED_WORKING');
    expect(deriveLegalHandActions(state, 'p1', card)).toEqual([]);
  });
});

describe('phase 6 engine-driven avatar attack actions', () => {
  it('offers DECLARE_ATTACK for an awake Avatar during own Battle Phase', () => {
    const state = makeState(2, { currentPhase: 'BATTLE' });
    const avatar = state.players.p1.avatarZone[0];
    expect(deriveLegalAvatarActions(state, 'p1', avatar).map(action => action.kind)).toEqual(['DECLARE_ATTACK']);
  });

  it('offers nothing outside the Battle Phase, for rested Avatars, or on the opponent turn', () => {
    const main = makeState(2);
    expect(deriveLegalAvatarActions(main, 'p1', main.players.p1.avatarZone[0])).toEqual([]);

    const battle = makeState(2, { currentPhase: 'BATTLE' });
    const rested = instance('rested', 'p1', avatarCard(), { isRested: true });
    battle.players.p1.avatarZone.push(rested);
    expect(deriveLegalAvatarActions(battle, 'p1', rested)).toEqual([]);
    expect(deriveLegalAvatarActions(battle, 'p2', battle.players.p2.avatarZone[0])).toEqual([]);
  });

  it('enforces the AD_MUA first-round attack lock', () => {
    const locked = makeState(2, { mode: 'AD_MUA', currentPhase: 'BATTLE', turnNumber: 1 });
    expect(deriveLegalAvatarActions(locked, 'p1', locked.players.p1.avatarZone[0])).toEqual([]);

    const unlocked = makeState(2, { mode: 'AD_MUA', currentPhase: 'BATTLE', turnNumber: 2 });
    expect(deriveLegalAvatarActions(unlocked, 'p1', unlocked.players.p1.avatarZone[0]).map(action => action.kind))
      .toEqual(['DECLARE_ATTACK']);
  });
});

describe('phase 6 granular MANUAL resolution', () => {
  it('never offers manual resolution for fully verified cards', () => {
    const classification = classifyCard({ ...catalog[0], mainEffect: '' });
    expect(classification.status).toBe('VERIFIED_WORKING');
    expect(shouldOfferManualResolution(classification, ['X: ยังไม่รองรับ จึงไม่ทำผลใด ๆ'])).toBe(false);
  });

  it('offers manual resolution only when the engine itself reported an unresolved effect', () => {
    const classification = classifyCard({ ...catalog[0], mainEffect: 'เมื่อโจมตี : จั่วการ์ด 1 ใบ' });
    expect(classification.status).not.toBe('VERIFIED_WORKING');

    expect(shouldOfferManualResolution(classification, [
      'ร่าย Magic "X"',
      'X: ยังไม่รองรับเงื่อนไขพิเศษ จึงไม่ทำผลใด ๆ'
    ])).toBe(true);

    expect(shouldOfferManualResolution(classification, [
      'ร่าย Magic "X"',
      'X: จั่วการ์ด 1 ใบ'
    ])).toBe(false);
  });

  it('treats an empty log as no engine request for manual resolution', () => {
    expect(engineRequiresManualResolution([])).toBe(false);
    expect(engineRequiresManualResolution(['ผู้เล่น A อัญเชิญ Avatar'])).toBe(false);
  });
});

describe('phase 6 multiplayer 2-4 player state integrity', () => {
  it.each([2, 3, 4] as const)('builds a valid %i-player state', playerCount => {
    const state = makeState(playerCount);
    expect(state.playerOrder).toHaveLength(playerCount);
    expect(validateGameState(state)).toBeNull();
  });

  it.each([2, 3, 4] as const)('redacts hidden state for every non-viewer in a %i-player game', playerCount => {
    const state = makeState(playerCount);
    const redacted = redactLifeCardsForViewer(state, 'p1');

    // The viewer keeps full knowledge of their own zones.
    expect(redacted.players.p1.hand[0].card.name).toBe('p1 Hand 0');
    expect(redacted.players.p1.lifeDeck[0].card.name).toBe('p1 LIFE 0');

    for (const other of state.playerOrder.filter(id => id !== 'p1')) {
      const rival = redacted.players[other];
      expect(rival.hand.every(card => card.card.printId === 'hidden-private-card' && !card.isFaceUp)).toBe(true);
      expect(rival.deck.every(card => card.card.printId === 'hidden-private-card' && !card.isFaceUp)).toBe(true);
      expect(rival.lifeDeck.every(card => !card.isFaceUp && card.card.printId === 'hidden-life-card')).toBe(true);
      // Instance identity is preserved so zone membership stays verifiable.
      expect(rival.lifeDeck.map(card => card.instanceId)).toEqual(state.players[other].lifeDeck.map(card => card.instanceId));
    }
  });

  it.each([3, 4] as const)('keeps revisions monotonic through the manual override flow with %i players', playerCount => {
    const state = makeState(playerCount);
    const avatar = state.players.p1.avatarZone[0];
    const begun = beginManualOverride(state, 'p1',
      { kind: 'ADJUST_POWER', instanceId: avatar.instanceId, delta: 1 },
      { cardInstanceId: avatar.instanceId, cardName: avatar.card.name, cardText: avatar.card.mainEffect, cardStatus: 'UNSUPPORTED' },
      'cmd-1');
    expect(begun.ok).toBe(true);
    expect(begun.state.stateRevision).toBe((state.stateRevision ?? 0) + 1);

    let current = begun.state;
    const others = state.playerOrder.filter(id => id !== 'p1');
    // Every approval keeps the revision monotonic (never decreasing).
    others.forEach((approver, index) => {
      const approved = approveManualOverride(current, approver, `cmd-approve-${index}`);
      expect(approved.ok).toBe(true);
      expect(approved.state.stateRevision ?? 0).toBeGreaterThanOrEqual(current.stateRevision ?? 0);
      current = approved.state;
    });
    // After the final approval the override applied and the revision advanced exactly once more.
    expect(current.stateRevision).toBe((state.stateRevision ?? 0) + 2);
    expect(current.pendingManualOverride).toBeUndefined();
  });
});

describe('blocked hand-card reasons are truthful about the phase', () => {
  const reactMagic = instance('react-0', 'p1', magicCard({ subtype: 'React', name: 'อย่าให้มีครั้งที่ 2' }));

  it('a React Magic in Main Phase explains the missing response window, not "wait for Main Phase"', () => {
    const state = makeState(2, { currentPhase: 'MAIN' });
    state.players.p1.hand.push(reactMagic);
    const reason = describeBlockedHandReason(state, 'p1', reactMagic);
    expect(reason).toContain('React Magic');
    expect(reason).toContain('ตอบโต้');
    expect(reason).not.toBe(`รอ Main Phase (ตอนนี้ช่วง Main Phase)`);
  });

  it('a Normal Magic outside Main Phase still says which phase is expected', () => {
    const state = makeState(2, { currentPhase: 'BATTLE' });
    const normal = instance('normal-0', 'p1', magicCard({ subtype: 'Normal' }));
    state.players.p1.hand.push(normal);
    expect(describeBlockedHandReason(state, 'p1', normal)).toBe('รอ Main Phase (ตอนนี้ช่วง Battle Phase)');
  });

  it('a Normal Magic in Main Phase that already spent its Normal cast says so', () => {
    const state = makeState(2, { currentPhase: 'MAIN' });
    state.players.p1.usedMagicTypesThisTurn.add('Normal');
    const normal = instance('normal-1', 'p1', magicCard({ subtype: 'Normal' }));
    state.players.p1.hand.push(normal);
    expect(describeBlockedHandReason(state, 'p1', normal)).toBe('Normal Magic ใช้ไปแล้วเทิร์นนี้');
  });
});
