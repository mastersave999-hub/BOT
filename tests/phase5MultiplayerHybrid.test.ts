import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Card, CardInstance, GameState, PlayerState } from '../src/engine/types';
import {
  approveManualOverride,
  autoApproveManualOverride,
  beginManualOverride,
  classifyCard,
  deckViolatesAutoStrict,
  rejectManualOverride,
} from '../src/engine/hybridMode';
import { resolveDeckChoice, scoutCards } from '../src/engine/deckOperations';
import { beginHellChoice, resolveHellChoice } from '../src/engine/hellChoice';
import {
  decodeNetMessage,
  isDeckChoiceCommandCurrent,
  isHellChoiceCommandCurrent,
  isLegalGameStateSync,
  isManualOverrideCommandCurrent,
  redactLifeCardsForViewer,
} from '../src/engine/multiplayer';
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

function makeState(ruleMode: GameState['ruleMode'] = 'HYBRID'): GameState {
  const base = catalog[0];
  return {
    id: 'phase5-hybrid',
    mode: 'DUEL',
    ruleMode,
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

describe('phase 5 card classification', () => {
  it('treats vanilla cards as fully verified', () => {
    const vanilla: Card = { ...catalog[0], mainEffect: '' };
    expect(classifyCard(vanilla)).toEqual({ status: 'VERIFIED_WORKING', reason: 'Vanilla card without rule text' });
  });

  it('classifies ambiguous wording as AMBIGUOUS', () => {
    const ambiguous: Card = { ...catalog[0], mainEffect: 'เลือกตัวอะไรสักอย่าง 1 ใบ : ทำลาย' };
    expect(classifyCard(ambiguous).status).toBe('AMBIGUOUS');
  });

  it('requires manual resolution for timing/event text the engine cannot verify', () => {
    const timed: Card = { ...catalog[0], mainEffect: 'เมื่อโจมตี : จั่วการ์ด 1 ใบ' };
    const classification = classifyCard(timed);
    expect(classification.status).not.toBe('VERIFIED_WORKING');
    expect(classification.reason).toContain('timing/event context not verified');
  });

  it('finds fully verified cards with printed effects in the official catalog', () => {
    const verified = catalog.filter(card => card.mainEffect.trim().length > 0 && classifyCard(card).status === 'VERIFIED_WORKING');
    expect(verified.length).toBeGreaterThan(0);
  });

  it('flags decks containing unmodeled cards for Auto-Strict rooms', () => {
    const vanilla: Card = { ...catalog[0], mainEffect: '' };
    expect(deckViolatesAutoStrict([vanilla, vanilla, vanilla])).toBeNull();
    const timed: Card = { ...catalog[0], mainEffect: 'เมื่อโจมตี : จั่วการ์ด 1 ใบ' };
    expect(deckViolatesAutoStrict([vanilla, timed])?.printId).toBe(timed.printId);
  });
});

describe('phase 5 hybrid manual override engine', () => {
  it('stages an override, applies it after approval, and logs both steps', () => {
    const state = makeState();
    const avatar = state.players.p1.avatarZone[0];
    const begun = beginManualOverride(state, 'p1', { kind: 'ADJUST_POWER', instanceId: avatar.instanceId, delta: 2 },
      { cardInstanceId: avatar.instanceId, cardName: avatar.card.name, cardText: avatar.card.mainEffect, cardStatus: 'UNSUPPORTED' },
      'cmd-submit-1');
    expect(begun.ok).toBe(true);
    expect(begun.state.pendingManualOverride?.action).toEqual({ kind: 'ADJUST_POWER', instanceId: avatar.instanceId, delta: 2 });
    expect(begun.state.pendingManualOverride?.expectedRevision).toBe(begun.state.stateRevision);
    expect(begun.state.eventLog.some(entry => entry.description.includes('เสนอ Manual Override'))).toBe(true);
    expect(validateGameState(begun.state)).toBeNull();

    const approved = approveManualOverride(begun.state, 'p2', 'cmd-approve-1');
    expect(approved.ok).toBe(true);
    expect(approved.applied).toBe(true);
    expect(approved.state.pendingManualOverride).toBeUndefined();
    expect(approved.state.players.p1.avatarZone[0].layerModifiers).toContainEqual(expect.objectContaining({
      layer: 2, powerMod: 2, sourceCardId: 'manual-override:cmd-submit-1'
    }));
    expect(approved.state.eventLog.some(entry => entry.description.includes('ถูกนำไปใช้'))).toBe(true);
    expect(validateGameState(approved.state)).toBeNull();
  });

  it('discards the staged action when the opponent rejects it', () => {
    const state = makeState();
    const avatar = state.players.p1.avatarZone[0];
    const begun = beginManualOverride(state, 'p1', { kind: 'SET_WAKE_STATE', instanceId: avatar.instanceId, isRested: true }, undefined, 'cmd-submit-2');
    expect(begun.ok).toBe(true);
    const rejected = rejectManualOverride(begun.state, 'p2', 'cmd-reject-2');
    expect(rejected.ok).toBe(true);
    expect(rejected.state.pendingManualOverride).toBeUndefined();
    expect(rejected.state.players.p1.avatarZone[0].isRested).toBe(false);
    expect(rejected.state.eventLog.some(entry => entry.description.includes('ปฏิเสธ Manual Override'))).toBe(true);
  });

  it('enforces turn ownership, revision checks, and rule bounds', () => {
    const state = makeState();
    const avatar = state.players.p1.avatarZone[0];
    expect(beginManualOverride(state, 'p2', { kind: 'ADJUST_POWER', instanceId: avatar.instanceId, delta: 1 }, undefined, 'cmd-x').ok).toBe(false);
    expect(beginManualOverride(state, 'p1', { kind: 'ADJUST_POWER', instanceId: avatar.instanceId, delta: 0 }, undefined, 'cmd-y').ok).toBe(false);
    expect(beginManualOverride(state, 'p1', { kind: 'ADJUST_POWER', instanceId: 'missing', delta: 1 }, undefined, 'cmd-z').ok).toBe(false);
    expect(beginManualOverride(state, 'p1', { kind: 'DRAW_CARD', playerId: 'p2' }, undefined, 'cmd-w').ok).toBe(false);
    expect(beginManualOverride(state, 'p1', { kind: 'ADJUST_POWER', instanceId: avatar.instanceId, delta: 1 }, undefined, '').ok).toBe(false);
    const strict = makeState('AUTO_STRICT');
    expect(beginManualOverride(strict, 'p1', { kind: 'ADJUST_POWER', instanceId: avatar.instanceId, delta: 1 }, undefined, 'cmd-s').reason)
      .toContain('Auto-Strict');
  });

  it('rejects duplicate command identifiers and double approvals', () => {
    const state = makeState();
    const avatar = state.players.p1.avatarZone[0];
    const begun = beginManualOverride(state, 'p1', { kind: 'ADJUST_POWER', instanceId: avatar.instanceId, delta: 1 }, undefined, 'cmd-dup');
    expect(begun.ok).toBe(true);
    expect(beginManualOverride(begun.state, 'p1', { kind: 'ADJUST_POWER', instanceId: avatar.instanceId, delta: 1 }, undefined, 'cmd-dup').ok).toBe(false);
    const first = approveManualOverride(begun.state, 'p2', 'cmd-approve-dup');
    expect(first.ok).toBe(true);
    expect(approveManualOverride(first.state, 'p2', 'cmd-approve-dup').ok).toBe(false);
  });

  it('moves cards between zones under zone-capacity rules and draws/discards one card', () => {
    const state = makeState();
    const handCard = state.players.p1.hand[0];
    const moved = beginManualOverride(state, 'p1', { kind: 'MOVE_CARD', instanceId: handCard.instanceId, destination: 'constructZone' }, undefined, 'cmd-move-bad');
    expect(moved.ok).toBe(false);

    const discard = beginManualOverride(state, 'p1', { kind: 'DISCARD_CARD', instanceId: handCard.instanceId }, undefined, 'cmd-discard');
    expect(discard.ok).toBe(true);
    const discarded = autoApproveManualOverride(discard.state);
    expect(discarded.ok).toBe(true);
    expect(discarded.state.players.p1.hand.some(card => card.instanceId === handCard.instanceId)).toBe(false);
    expect(discarded.state.players.p1.hell.some(card => card.instanceId === handCard.instanceId)).toBe(true);

    const draw = beginManualOverride(discarded.state, 'p1', { kind: 'DRAW_CARD', playerId: 'p1' }, undefined, 'cmd-draw');
    expect(draw.ok).toBe(true);
    const drawn = autoApproveManualOverride(draw.state);
    expect(drawn.ok).toBe(true);
    expect(drawn.state.players.p1.hand.length).toBe(2);
  });

  it('deals and heals LIFE by flipping face-down and face-up LIFE cards', () => {
    const state = makeState();
    const deal = beginManualOverride(state, 'p1', { kind: 'ADJUST_LIFE', playerId: 'p2', face: 'up' }, undefined, 'cmd-deal');
    expect(deal.ok).toBe(true);
    const dealt = autoApproveManualOverride(deal.state);
    expect(dealt.ok).toBe(true);
    expect(dealt.state.players.p2.lifeDeck.filter(card => card.isFaceUp).length).toBe(1);

    const heal = beginManualOverride(dealt.state, 'p1', { kind: 'ADJUST_LIFE', playerId: 'p2', face: 'down' }, undefined, 'cmd-heal');
    expect(heal.ok).toBe(true);
    const healed = autoApproveManualOverride(heal.state);
    expect(healed.ok).toBe(true);
    expect(healed.state.players.p2.lifeDeck.filter(card => card.isFaceUp).length).toBe(0);
  });
});

describe('phase 5 deck and hell choice commands', () => {
  it('authenticates deck choice commands against the pending revision and applies them once', () => {
    const scouted = scoutCards(makeState(), 'p1', 2, { destination: 'hand', minSelect: 1, maxSelect: 2 });
    expect(scouted.ok).toBe(true);
    const state = scouted.state;
    const pending = state.pendingDeckChoice!;
    const selected = pending.candidateInstanceIds.slice(0, 1);

    expect(isDeckChoiceCommandCurrent(state, {
      playerId: 'p1', commandId: 'deck-cmd-1', expectedRevision: pending.expectedRevision, selectedInstanceIds: selected
    }, 'p1')).toBe(true);
    expect(isDeckChoiceCommandCurrent(state, {
      playerId: 'p1', commandId: 'deck-cmd-1', expectedRevision: pending.expectedRevision - 1, selectedInstanceIds: selected
    }, 'p1')).toBe(false);
    expect(isDeckChoiceCommandCurrent(state, {
      playerId: 'p1', commandId: 'deck-cmd-1', expectedRevision: pending.expectedRevision, selectedInstanceIds: selected
    }, 'p2')).toBe(false);
    expect(isDeckChoiceCommandCurrent(state, {
      playerId: 'p2', commandId: 'deck-cmd-1', expectedRevision: pending.expectedRevision, selectedInstanceIds: selected
    }, 'p2')).toBe(false);
    expect(isDeckChoiceCommandCurrent(state, {
      playerId: 'p1', commandId: 'deck-cmd-1', expectedRevision: pending.expectedRevision, selectedInstanceIds: ['not-a-candidate']
    }, 'p1')).toBe(false);

    const resolved = resolveDeckChoice(state, 'p1', selected, pending.expectedRevision, { commandId: 'deck-cmd-1' });
    expect(resolved.ok).toBe(true);
    expect(resolved.state.pendingDeckChoice).toBeUndefined();
    expect(resolved.state.players.p1.hand.some(card => card.instanceId === selected[0])).toBe(true);
    expect(resolved.state.processedCommandIds).toContain('deck-cmd-1');
    expect(resolveDeckChoice(resolved.state, 'p1', selected, pending.expectedRevision, { commandId: 'deck-cmd-1' }).ok).toBe(false);
  });

  it('keeps deck choice candidates hidden from unauthorized viewers', () => {
    const scouted = scoutCards(makeState(), 'p1', 2, { destination: 'hand', minSelect: 1, maxSelect: 2 });
    expect(scouted.ok).toBe(true);
    const redacted = redactLifeCardsForViewer(scouted.state, 'p2');
    expect(redacted.pendingDeckChoice?.candidateInstanceIds).toEqual([]);
    expect(redacted.pendingDeckChoice?.maxSelect).toBe(0);
    expect(redacted.players.p1.deck.every(card => card.card.printId === 'hidden-private-card')).toBe(true);
    const own = redactLifeCardsForViewer(scouted.state, 'p1');
    expect(own.pendingDeckChoice?.candidateInstanceIds).toEqual(scouted.state.pendingDeckChoice!.candidateInstanceIds);
    const scoutedEvent = redacted.gameEvents?.find(item => item.event.type === 'DECK_SCOUTED');
    expect(scoutedEvent?.event.type === 'DECK_SCOUTED' ? scoutedEvent.event.cardInstanceIds : undefined).toEqual([]);
  });

  it('authenticates hell choice commands and resolves recovery once', () => {
    const state = makeState();
    const hellCard = state.players.p1.deck[0];
    state.players.p1.hell.push({ ...hellCard, instanceId: 'p1-hell-0' });
    state.players.p1.deck = state.players.p1.deck.filter(card => card.instanceId !== hellCard.instanceId);
    const begun = beginHellChoice(state, {
      effectKind: 'recover_from_hell', playerId: 'p1', actorId: 'p1', authorizedViewerId: 'p1',
      cardType: hellCard.card.type === 'Life' ? 'Magic' : hellCard.card.type as 'Avatar' | 'Construct' | 'Magic',
      count: 1, destination: 'hand'
    });
    expect(begun.ok).toBe(true);
    const pending = begun.state.pendingHellChoice!;
    const selected = pending.candidateInstanceIds.slice(0, 1);
    expect(isHellChoiceCommandCurrent(begun.state, {
      playerId: 'p1', commandId: 'hell-cmd-1', expectedRevision: pending.expectedRevision, selectedInstanceIds: selected
    }, 'p1')).toBe(true);
    expect(isHellChoiceCommandCurrent(begun.state, {
      playerId: 'p1', commandId: 'hell-cmd-1', expectedRevision: pending.expectedRevision + 1, selectedInstanceIds: selected
    }, 'p1')).toBe(false);

    const resolved = resolveHellChoice(begun.state, 'p1', selected, pending.expectedRevision, 'hell-cmd-1');
    expect(resolved.ok).toBe(true);
    expect(resolved.state.pendingHellChoice).toBeUndefined();
    expect(resolved.state.players.p1.hand.some(card => card.instanceId === selected[0])).toBe(true);
    expect(resolved.state.processedCommandIds).toContain('hell-cmd-1');
  });
});

describe('phase 5 manual override network commands', () => {
  it('authenticates submit, approve, and reject commands', () => {
    const state = makeState();
    const avatar = state.players.p1.avatarZone[0];
    const submit = {
      kind: 'SUBMIT_MANUAL_OVERRIDE' as const, playerId: 'p1', commandId: 'mo-1',
      expectedRevision: state.stateRevision ?? 0,
      action: { kind: 'ADJUST_POWER' as const, instanceId: avatar.instanceId, delta: 1 }
    };
    expect(isManualOverrideCommandCurrent(state, submit, 'p1')).toBe(true);
    expect(isManualOverrideCommandCurrent(state, submit, 'p2')).toBe(false);
    expect(isManualOverrideCommandCurrent(state, { ...submit, expectedRevision: 99 }, 'p1')).toBe(false);

    const begun = beginManualOverride(state, 'p1', submit.action, undefined, 'mo-1');
    expect(begun.ok).toBe(true);
    const approve = { kind: 'APPROVE_MANUAL_OVERRIDE' as const, playerId: 'p2', commandId: 'mo-2', expectedRevision: begun.state.pendingManualOverride!.expectedRevision };
    expect(isManualOverrideCommandCurrent(begun.state, approve, 'p2')).toBe(true);
    expect(isManualOverrideCommandCurrent(begun.state, approve, 'p1')).toBe(false);
    expect(isManualOverrideCommandCurrent(begun.state, { ...approve, action: submit.action }, 'p2')).toBe(false);
    const reject = { kind: 'REJECT_MANUAL_OVERRIDE' as const, playerId: 'p2', commandId: 'mo-3', expectedRevision: begun.state.pendingManualOverride!.expectedRevision };
    expect(isManualOverrideCommandCurrent(begun.state, reject, 'p2')).toBe(true);
  });

  it('round-trips manual override messages through the network codec', () => {
    const command = {
      kind: 'SUBMIT_MANUAL_OVERRIDE' as const, playerId: 'player-2', commandId: 'mo-net',
      expectedRevision: 4,
      action: { kind: 'MOVE_CARD' as const, instanceId: 'i1', destination: 'hell' as const },
      context: { cardName: 'การ์ดทดสอบ', cardStatus: 'UNSUPPORTED' as const }
    };
    const decoded = decodeNetMessage(JSON.stringify({ type: 'MANUAL_OVERRIDE_COMMAND', command }));
    expect(decoded).toEqual({ type: 'MANUAL_OVERRIDE_COMMAND', command });
    expect(decodeNetMessage(JSON.stringify({ type: 'MANUAL_OVERRIDE_COMMAND', command: { ...command, action: 'nope' } }))).toBeNull();
    expect(decodeNetMessage(JSON.stringify({ type: 'MANUAL_OVERRIDE_COMMAND', command: { ...command, kind: 'APPROVE_MANUAL_OVERRIDE', action: command.action } }))).toBeNull();
    const deckCommand = { playerId: 'player-1', commandId: 'dc-1', expectedRevision: 2, selectedInstanceIds: ['a', 'b'] };
    expect(decodeNetMessage(JSON.stringify({ type: 'DECK_CHOICE_COMMAND', command: deckCommand }))).toEqual({ type: 'DECK_CHOICE_COMMAND', command: deckCommand });
    expect(decodeNetMessage(JSON.stringify({ type: 'HELL_CHOICE_COMMAND', command: { ...deckCommand, selectedInstanceIds: ['a', 'a'] } }))).toBeNull();
  });
});

describe('phase 5 multiplayer sync integrity', () => {
  it('still accepts ordinary guest turn progression but rejects guest state while a choice is pending', () => {
    const previous = { ...makeState(), turnNumber: 2 };
    const advanced: GameState = {
      ...structuredClone(previous),
      currentPhase: 'BATTLE',
      stateRevision: (previous.stateRevision ?? 0) + 1
    };
    expect(isLegalGameStateSync(previous, advanced, 'p1')).toBe(true);

    const scouted = scoutCards(previous, 'p1', 2, { destination: 'hand', minSelect: 1, maxSelect: 2 });
    expect(scouted.ok).toBe(true);
    // A guest may introduce a private choice on its OWN deck as part of a legitimate Scout play.
    expect(isLegalGameStateSync(previous, scouted.state, 'p1')).toBe(true);

    // Fabricating a choice over the opponent's Deck without playing a search/scout Magic is rejected,
    // otherwise the guest could have the host's whole Deck revealed back to it.
    const fabricated: GameState = {
      ...structuredClone(previous),
      stateRevision: (previous.stateRevision ?? 0) + 1,
      pendingDeckChoice: {
        kind: 'SCOUT', deckOwnerId: 'p2', actorId: 'p1', authorizedViewerId: 'p1',
        candidateInstanceIds: previous.players.p2.deck.map(card => card.instanceId),
        minSelect: 0, maxSelect: 0, destination: 'deck', expectedRevision: (previous.stateRevision ?? 0) + 1
      }
    };
    expect(isLegalGameStateSync(previous, fabricated, 'p1')).toBe(false);
  });

  it('keeps rule mode immutable across syncs', () => {
    const previous = makeState('AUTO_STRICT');
    const incoming = { ...structuredClone(previous), stateRevision: (previous.stateRevision ?? 0) + 1, ruleMode: 'HYBRID' as const };
    expect(isLegalGameStateSync(previous, incoming, 'p1')).toBe(false);
  });
});
