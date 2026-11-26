import { describe, expect, it } from 'vitest';
import { appendGameEvents, dispatchGameEvents } from '../src/engine/gameEvents';
import { isReactionWindowStructurallyValid, openReactionWindow } from '../src/engine/reactionEngine';
import { expireModifiersAt } from '../src/engine/abilityEngine';
import { calculateNetPower } from '../src/engine/layers';
import {
  beginEndPhaseDiscard,
  canUseMagicTypeThisTurn,
  changeAvatarControl,
  discardToHandLimit,
  moveCardBetweenZones,
  validateMagicPlay
} from '../src/engine/gameRules';
import { runGameTransaction } from '../src/engine/gameTransaction';
import { resolveEffectPlan } from '../src/engine/effectResolver';
import {
  decodeNetMessage,
  encodeNetMessage,
  isEndPhaseDiscardCommandCurrent,
  isGameStateValidForSync,
  isLegalGameStateSync,
  redactLifeCardsForViewer,
  restoreHiddenZonesFromCanonical
} from '../src/engine/multiplayer';
import { executeDrawPhase, finishEndPhaseTurn, isFirstPlayerFirstTurn, nextPhaseAfterMain } from '../src/engine/turnEngine';
import type { Card, CardInstance, GameState, MagicSubtype, PlayerState } from '../src/engine/types';

function makeCard(name: string, type: Card['type'] = 'Construct', subtype: Card['subtype'] = null): Card {
  return {
    printId: name,
    name,
    type,
    subtype,
    cost: 0,
    gem: 1,
    power: 3,
    color: 'แดง',
    rarity: 'C',
    mainEffect: '',
    isOnlyOne: false,
    isBias: false,
    isCollab: false,
    imageUrl: ''
  };
}

function makeInstance(
  id: string,
  type: Card['type'] = 'Construct',
  ownerId = 'p1',
  name = id,
  subtype: Card['subtype'] = null,
  controllerId = ownerId,
  modifiers: CardInstance['layerModifiers'] = []
): CardInstance {
  return {
    instanceId: id,
    card: makeCard(name, type, subtype),
    ownerId,
    originalOwnerId: ownerId,
    controllerId,
    isRested: false,
    isFaceUp: true,
    attachedInstances: [],
    layerModifiers: modifiers
  };
}

function makePlayer(id: string, overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id,
    name: id,
    seat: id === 'p1' ? 0 : 1,
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
    usedMagicTypesThisTurn: new Set<MagicSubtype>(),
    ...overrides
  };
}

function makeState(p1 = makePlayer('p1'), p2 = makePlayer('p2')): GameState {
  return {
    id: 'phase22',
    mode: 'DUEL',
    playerOrder: ['p1', 'p2'],
    currentTurnPlayerIndex: 0,
    currentPhase: 'MAIN',
    turnNumber: 1,
    roundNumber: 1,
    players: { p1, p2 },
    landMagicZone: null,
    eventLog: []
  };
}

describe('Phase 2.2 core rules and infrastructure', () => {
  it('enforces Construct capacity and per-player name uniqueness through shared movement', () => {
    const sameName = makeInstance('opponent-shared-name', 'Construct', 'p2', 'Shared');
    const cards = [
      makeInstance('c1', 'Construct', 'p1', 'Shared'),
      makeInstance('c2', 'Construct', 'p1', 'Second'),
      makeInstance('c3', 'Construct', 'p1', 'Third')
    ];
    let current = makeState(makePlayer('p1', { hand: cards }), makePlayer('p2', { constructZone: [sameName] }));
    for (const card of cards) {
      const moved = moveCardBetweenZones(current, { instanceId: card.instanceId, actorId: 'p1', destination: 'constructZone', destinationPlayerId: 'p1' });
      expect(moved.ok).toBe(true);
      current = moved.state;
    }
    expect(current.players.p1.constructZone.map(card => card.card.name)).toEqual(['Shared', 'Second', 'Third']);
    expect(current.players.p2.constructZone[0].card.name).toBe('Shared');

    const duplicate = makeInstance('duplicate', 'Construct', 'p1', 'Shared');
    current = { ...current, players: { ...current.players, p1: { ...current.players.p1, hand: [duplicate] } } };
    const rejected = moveCardBetweenZones(current, { instanceId: 'duplicate', actorId: 'p1', destination: 'constructZone', destinationPlayerId: 'p1' });
    expect(rejected.ok).toBe(false);
    expect(rejected.state).toBe(current);
    expect(rejected.state.gameEvents).toEqual(current.gameEvents);
  });

  it('changes an Avatar controller atomically while preserving original owner and attached cards', () => {
    const attachment = makeInstance('borrowed-modification', 'Magic', 'p1', 'Attachment', 'Modification');
    const borrowed = {
      ...makeInstance('borrowed-avatar', 'Avatar', 'p1', 'Borrowed'),
      attachedInstances: [attachment],
      continuousEffects: [{ layer: 1 as const, powerMod: 1, targetCardType: 'Avatar' as const, targetController: 'SOURCE_CONTROLLER' as const }]
    };
    const companion = makeInstance('original-companion', 'Avatar', 'p1');
    const state = makeState(makePlayer('p1', { avatarZone: [borrowed, companion] }));
    const controlChange = changeAvatarControl(state, 'p1', borrowed.instanceId, 'p2');
    expect(controlChange.ok, controlChange.reason).toBe(true);
    const result = resolveEffectPlan(state, {
      actorId: 'p1',
      effects: [{ kind: 'change_avatar_control', targetId: borrowed.instanceId, controllerId: 'p2' }]
    });

    expect(result.ok).toBe(true);
    expect(result.state.players.p1.avatarZone.map(item => item.instanceId)).toEqual(['original-companion']);
    expect(result.state.players.p1.avatarZone[0].layerModifiers).toEqual([]);
    const changed = result.state.players.p2.avatarZone.find(item => item.instanceId === borrowed.instanceId)!;
    expect(changed).toMatchObject({ ownerId: 'p1', originalOwnerId: 'p1', controllerId: 'p2' });
    expect(changed.attachedInstances).toEqual([attachment]);
    expect(changed.layerModifiers).toContainEqual(expect.objectContaining({ sourceCardId: 'continuous:borrowed-avatar:0', powerMod: 1 }));
    expect(result.state.gameEvents?.some(({ event }) => event.type === 'CONTROL_CHANGED' && event.controllerId === 'p2')).toBe(true);
  });

  it('rejects control changes for Duo, immune, and over-capacity Avatars without state loss', () => {
    const duoAvatar = { ...makeInstance('duo-avatar', 'Avatar', 'p1'), duoWithInstanceId: 'duo-mate' };
    const duoMate = makeInstance('duo-mate', 'Avatar', 'p1');
    const duoState = makeState(makePlayer('p1', { avatarZone: [duoAvatar, duoMate] }));
    expect(changeAvatarControl(duoState, 'p1', 'duo-avatar', 'p2')).toMatchObject({ ok: false, state: duoState });

    const immune = { ...makeInstance('immune-avatar', 'Avatar', 'p1'), controlChangeImmune: true };
    const immuneState = makeState(makePlayer('p1', { avatarZone: [immune] }));
    expect(changeAvatarControl(immuneState, 'p1', 'immune-avatar', 'p2')).toMatchObject({ ok: false, state: immuneState });

    const target = makeInstance('target-avatar', 'Avatar', 'p1');
    const fullZone = Array.from({ length: 4 }, (_, index) => makeInstance(`p2-avatar-${index}`, 'Avatar', 'p2'));
    const fullState = makeState(makePlayer('p1', { avatarZone: [target] }), makePlayer('p2', { avatarZone: fullZone }));
    expect(changeAvatarControl(fullState, 'p1', 'target-avatar', 'p2')).toMatchObject({ ok: false, state: fullState });
  });

  it('re-summons a relocated Avatar under its new controller and returns it to the original Hell', () => {
    const relocated = {
      ...makeInstance('relocated-avatar', 'Avatar', 'p1', 'Relocated', null, 'p1', [{ layer: 4, powerMod: 2, sourceCardId: 'temporary' }]),
      isRested: true,
      isFaceUp: false
    };
    const state = makeState(makePlayer('p1', { magicZone: [relocated] }));
    const summoned = moveCardBetweenZones(state, {
      instanceId: relocated.instanceId, actorId: 'p2', destination: 'avatarZone', destinationPlayerId: 'p2', effectMove: true
    });
    expect(summoned.ok).toBe(true);
    expect(summoned.state.players.p2.avatarZone[0]).toMatchObject({
      ownerId: 'p1', originalOwnerId: 'p1', controllerId: 'p2', isRested: false, isFaceUp: true, layerModifiers: []
    });

    const returned = moveCardBetweenZones(summoned.state, {
      instanceId: relocated.instanceId, actorId: 'p2', destination: 'hell', destinationPlayerId: 'p1', effectMove: true
    });
    expect(returned.ok).toBe(true);
    expect(returned.state.players.p1.hell.map(card => card.instanceId)).toContain(relocated.instanceId);
    expect(returned.state.players.p2.hell).toHaveLength(0);
    const wrongOwnerDestination = moveCardBetweenZones(summoned.state, {
      instanceId: relocated.instanceId, actorId: 'p2', destination: 'hell', destinationPlayerId: 'p2', effectMove: true
    });
    expect(wrongOwnerDestination.ok).toBe(false);
    expect(wrongOwnerDestination.state).toBe(summoned.state);
  });

  it('applies once-per-active-turn Magic restrictions to all four types, including Modification', () => {
    const current = makeState();
    const validResponse = {
      ...current,
      reactionWindow: {
        id: 'response', trigger: { type: 'AVATAR_SUMMONED' as const, actorId: 'p2' },
        turnOwnerId: 'p1', priorityPlayerId: 'p1', passedPlayerIds: []
      }
    };
    const subtypes: MagicSubtype[] = ['Normal', 'Modification', 'React', 'Land'];
    for (const subtype of subtypes) {
      const playableState = subtype === 'React' ? validResponse : current;
      expect(validateMagicPlay(playableState, 'p1', subtype)).toBeNull();
      if (subtype === 'React') expect(validateMagicPlay(current, 'p1', subtype)).toMatch(/response window/);
      const alreadyUsed = { ...current.players.p1, usedMagicTypesThisTurn: new Set([subtype]) };
      expect(canUseMagicTypeThisTurn(alreadyUsed, subtype)).toBe(false);
      expect(validateMagicPlay({ ...playableState, players: { ...playableState.players, p1: alreadyUsed } }, 'p1', subtype)).toMatch(/already been used/);
    }
    const outsideMain = { ...current, currentPhase: 'BATTLE' as const };
    for (const subtype of ['Normal', 'Modification', 'Land'] as const) {
      expect(validateMagicPlay(outsideMain, 'p1', subtype)).toMatch(/Main Phase/);
    }
    expect(validateMagicPlay(outsideMain, 'p1', 'React')).toMatch(/response window/);
    expect(validateMagicPlay(outsideMain, 'p1', 'React', true)).toBeNull();
    expect(validateMagicPlay(current, 'p2', 'Normal')).toMatch(/active player/);
  });

  it('rejects multiplayer SYNC attempts to bypass or repeat a Magic subtype', () => {
    const firstCard = makeInstance('sync-magic-first', 'Magic', 'p1', 'First Normal', 'Normal');
    const basePlayer = makePlayer('p1', { hand: [firstCard] });
    const base = makeState(basePlayer, makePlayer('p2'));
    const legalPlay = {
      ...base,
      players: { ...base.players, p1: { ...basePlayer, hand: [], magicZone: [firstCard], usedMagicTypesThisTurn: new Set<MagicSubtype>(['Normal']) } }
    };
    expect(isLegalGameStateSync(base, legalPlay, 'p1')).toBe(true);

    const bypassedPlay = {
      ...base,
      players: { ...base.players, p1: { ...basePlayer, hand: [], magicZone: [firstCard] } }
    };
    expect(isLegalGameStateSync(base, bypassedPlay, 'p1')).toBe(false);

    const secondCard = makeInstance('sync-magic-second', 'Magic', 'p1', 'Second Normal', 'Normal');
    const alreadyUsedPlayer = { ...legalPlay.players.p1, hand: [secondCard] };
    const alreadyUsed = { ...legalPlay, players: { ...legalPlay.players, p1: alreadyUsedPlayer } };
    const repeatedPlay = {
      ...alreadyUsed,
      players: { ...alreadyUsed.players, p1: { ...alreadyUsedPlayer, hand: [], magicZone: [firstCard, secondCard] } }
    };
    expect(isLegalGameStateSync(alreadyUsed, repeatedPlay, 'p1')).toBe(false);
  });

  it('expires only the requested duration across Avatar, Construct, LIFE, attached, and shared Land cards', () => {
    const makeMods = (prefix: string): CardInstance['layerModifiers'] => [
      { layer: 1, powerMod: 2, sourceCardId: `${prefix}-turn`, expiresAt: 'END_OF_TURN' },
      { layer: 4, powerMod: 4, sourceCardId: `${prefix}-battle`, expiresAt: 'END_OF_BATTLE' },
      { layer: 1, powerMod: 1, sourceCardId: `${prefix}-draw`, expiresAt: 'DRAW_PHASE' }
    ];
    const p1Avatar = makeInstance('p1-avatar', 'Avatar', 'p1', 'P1 Avatar', null, 'p1', makeMods('avatar'));
    p1Avatar.attachedInstances = [makeInstance('p1-attached', 'Magic', 'p1', 'Attached', 'Modification', 'p1', makeMods('attached'))];
    const p1Construct = makeInstance('p1-construct', 'Construct', 'p1', 'P1 Construct', null, 'p1', makeMods('construct'));
    const p1Life = makeInstance('p1-life', 'Life', 'p1', 'P1 LIFE', null, 'p1', makeMods('life'));
    const p2Avatar = makeInstance('p2-avatar', 'Avatar', 'p2', 'P2 Avatar', null, 'p2', makeMods('opponent'));
    const land = makeInstance('land', 'Magic', 'p1', 'Land', 'Land', 'p1', makeMods('land'));
    const start = makeState(
      makePlayer('p1', { avatarZone: [p1Avatar], constructZone: [p1Construct], lifeDeck: [p1Life] }),
      makePlayer('p2', { avatarZone: [p2Avatar] })
    );
    const withLand = { ...start, landMagicZone: land };
    const atDraw = expireModifiersAt(withLand, 'DRAW_PHASE', 'p1');
    expect(atDraw.players.p1.avatarZone[0].layerModifiers.map(modifier => modifier.expiresAt)).toEqual(['END_OF_TURN', 'END_OF_BATTLE']);
    expect(atDraw.players.p1.avatarZone[0].attachedInstances[0].layerModifiers.map(modifier => modifier.expiresAt)).toEqual(['END_OF_TURN', 'END_OF_BATTLE']);
    expect(atDraw.players.p1.constructZone[0].layerModifiers.map(modifier => modifier.expiresAt)).toEqual(['END_OF_TURN', 'END_OF_BATTLE']);
    expect(atDraw.players.p1.lifeDeck[0].layerModifiers.map(modifier => modifier.expiresAt)).toEqual(['END_OF_TURN', 'END_OF_BATTLE']);
    expect(atDraw.players.p2.avatarZone[0].layerModifiers).toHaveLength(3);
    expect(atDraw.landMagicZone?.layerModifiers).toHaveLength(2);

    const atBattleEnd = expireModifiersAt(atDraw, 'END_OF_BATTLE', 'p1');
    expect(atBattleEnd.players.p1.avatarZone[0].layerModifiers.map(modifier => modifier.expiresAt)).toEqual(['END_OF_TURN']);
    const atTurnEnd = expireModifiersAt(atBattleEnd, 'END_OF_TURN', 'p1');
    expect(atTurnEnd.players.p1.avatarZone[0].layerModifiers).toHaveLength(0);
    expect(calculateNetPower(p1Avatar)).toBe(10);
    expect(atTurnEnd.players.p1.avatarZone[0].layerModifiers).toEqual([]);
  });

  it('opens a revisioned discard selection and commits exactly the chosen excess cards to owner Hell', () => {
    const hand = Array.from({ length: 9 }, (_, index) => makeInstance(`h${index}`, 'Magic', 'p1', `Card ${index}`, 'Normal', index === 1 ? 'p2' : 'p1'));
    const start = makeState(makePlayer('p1', { hand }), makePlayer('p2'));
    start.currentPhase = 'END';
    const pending = beginEndPhaseDiscard(start, 'p1');
    expect(pending.ok).toBe(true);
    expect(pending.state.pendingEndPhaseDiscardPlayerId).toBe('p1');
    expect(pending.state.pendingEndPhaseDiscardRevision).toBe(pending.state.stateRevision);
    expect(start.players.p1.hand).toHaveLength(9);

    const badCount = discardToHandLimit(pending.state, 'p1', ['h0']);
    const duplicateId = discardToHandLimit(pending.state, 'p1', ['h0', 'h0']);
    const unknownId = discardToHandLimit(pending.state, 'p1', ['h0', 'missing']);
    const stale = discardToHandLimit(pending.state, 'p1', ['h0', 'h1'], (pending.state.stateRevision ?? 0) - 1, 'stale');
    for (const failure of [badCount, duplicateId, unknownId, stale]) {
      expect(failure.ok).toBe(false);
      expect(failure.state).toBe(pending.state);
    }

    const expectedRevision = pending.state.stateRevision!;
    const result = discardToHandLimit(pending.state, 'p1', ['h0', 'h1'], expectedRevision, 'discard-once');
    expect(result.ok).toBe(true);
    expect(result.state.players.p1.hand.map(card => card.instanceId)).toEqual(['h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8']);
    expect(result.state.players.p1.hell.map(card => card.instanceId)).toEqual(['h0', 'h1']);
    expect(result.state.players.p1.hell[1]).toMatchObject({ ownerId: 'p1', controllerId: 'p2' });
    expect(result.state.pendingEndPhaseDiscardPlayerId).toBeUndefined();
    expect(discardToHandLimit(result.state, 'p1', ['h2', 'h3'], result.state.stateRevision, 'discard-once').reason).toMatch(/Duplicate/);
    const nextTurn = finishEndPhaseTurn(result.state);
    expect(nextTurn.currentTurnPlayerIndex).toBe(1);
    expect(nextTurn.currentPhase).toBe('DRAW');
    expect(nextTurn.turnNumber).toBe(2);
    expect(nextTurn.gameEvents?.map(item => item.event.type)).toEqual(['CARD_MOVED', 'CARD_MOVED', 'TURN_ENDED', 'TURN_STARTED']);
  });

  it('accepts only the active player’s current revisioned multiplayer discard command', () => {
    const hand = Array.from({ length: 8 }, (_, index) => makeInstance(`sync-${index}`, 'Magic', 'p1', `Sync ${index}`, 'Normal'));
    const previous = makeState(makePlayer('p1', { hand }), makePlayer('p2'));
    previous.currentPhase = 'END';
    const pending = beginEndPhaseDiscard(previous, 'p1');
    expect(pending.ok).toBe(true);
    expect(isLegalGameStateSync(previous, pending.state, 'p1')).toBe(true);
    expect(isLegalGameStateSync(previous, pending.state, 'p2')).toBe(false);

    const command = {
      playerId: 'p1',
      commandId: 'sync-discard-1',
      expectedRevision: pending.state.stateRevision!,
      selectedInstanceIds: ['sync-0']
    };
    const encoded = encodeNetMessage({ type: 'END_PHASE_DISCARD', command });
    const decoded = decodeNetMessage(encoded);
    expect(decoded?.type).toBe('END_PHASE_DISCARD');
    if (decoded?.type !== 'END_PHASE_DISCARD') return;
    expect(isEndPhaseDiscardCommandCurrent(pending.state, decoded.command, 'p1')).toBe(true);
    expect(isEndPhaseDiscardCommandCurrent(pending.state, decoded.command, 'p2')).toBe(false);
    expect(isEndPhaseDiscardCommandCurrent(pending.state, { ...decoded.command, expectedRevision: 0 }, 'p1')).toBe(false);
    expect(decodeNetMessage(JSON.stringify({ type: 'END_PHASE_DISCARD', command: { ...command, selectedInstanceIds: ['sync-0', 'sync-0'] } }))).toBeNull();
  });

  it('round-trips full-state reconnect snapshots during pending discard and Reaction Windows', () => {
    const hiddenDeckCard = makeInstance('reconnect-deck', 'Magic', 'p1', 'Private deck card', 'Normal');
    const hand = Array.from({ length: 8 }, (_, index) => makeInstance(`reconnect-hand-${index}`, 'Magic', 'p1', `Private hand ${index}`, 'Normal'));
    const canonical = makeState(makePlayer('p1', { deck: [hiddenDeckCard], hand }), makePlayer('p2'));
    canonical.currentPhase = 'END';
    const pendingDiscard = beginEndPhaseDiscard(canonical, 'p1');
    expect(pendingDiscard.ok).toBe(true);
    if (!pendingDiscard.ok) return;
    expect(isLegalGameStateSync(canonical, pendingDiscard.state, 'p1')).toBe(true);

    const encodedDiscardSync = encodeNetMessage({ type: 'SYNC', state: redactLifeCardsForViewer(pendingDiscard.state, 'p2'), winner: null });
    const decodedDiscardSync = decodeNetMessage(encodedDiscardSync);
    expect(decodedDiscardSync?.type).toBe('SYNC');
    if (decodedDiscardSync?.type !== 'SYNC') return;
    const restoredDiscardState = restoreHiddenZonesFromCanonical(decodedDiscardSync.state, pendingDiscard.state, 'p2');
    expect(isGameStateValidForSync(restoredDiscardState)).toBe(true);
    expect(restoredDiscardState.pendingEndPhaseDiscardPlayerId).toBe('p1');
    expect(restoredDiscardState.pendingEndPhaseDiscardRevision).toBe(pendingDiscard.state.stateRevision);
    expect(restoredDiscardState.players.p1.hand.map(card => card.instanceId)).toEqual(hand.map(card => card.instanceId));
    expect(restoredDiscardState.players.p1.deck[0].card.name).toBe('Private deck card');

    const reactCard = makeInstance('reconnect-react', 'Magic', 'p2', 'Cancel', 'React');
    reactCard.card.mainEffect = 'ยกเลิกการใช้ Magic Card';
    const reactionBase = makeState(makePlayer('p1'), makePlayer('p2', { hand: [reactCard] }));
    const activeWindow = openReactionWindow(reactionBase, {
      type: 'MAGIC_PLAYED', actorId: 'p1', sourceInstanceId: 'pending-magic'
    });
    expect(activeWindow.reactionWindow).toBeDefined();
    expect(isReactionWindowStructurallyValid(activeWindow)).toBe(true);
    expect(isLegalGameStateSync(reactionBase, activeWindow, 'p1')).toBe(true);

    const encodedReactionSync = encodeNetMessage({ type: 'SYNC', state: redactLifeCardsForViewer(activeWindow, 'p2'), winner: null });
    const decodedReactionSync = decodeNetMessage(encodedReactionSync);
    expect(decodedReactionSync?.type).toBe('SYNC');
    if (decodedReactionSync?.type !== 'SYNC') return;
    const restoredReactionState = restoreHiddenZonesFromCanonical(decodedReactionSync.state, activeWindow, 'p2');
    expect(isGameStateValidForSync(restoredReactionState)).toBe(true);
    expect(restoredReactionState.reactionWindow).toEqual(activeWindow.reactionWindow);
    expect(isReactionWindowStructurallyValid(restoredReactionState)).toBe(true);
    expect(restoredReactionState.players.p2.hand[0].card.name).toBe('Cancel');
  });

  it('keeps private deck identities out of movement metadata while preserving public ownership', () => {
    const hiddenCard = makeInstance('private-card-identity', 'Magic', 'p1', 'Secret draw', 'Normal');
    const start = makeState(makePlayer('p1', { deck: [hiddenCard] }), makePlayer('p2'));
    const result = moveCardBetweenZones(start, { instanceId: hiddenCard.instanceId, actorId: 'p1', destination: 'hand' });
    expect(result.ok).toBe(true);
    const event = result.state.gameEvents?.[0]?.event;
    expect(event).toMatchObject({ type: 'CARD_MOVED', ownerId: 'p1', controllerId: 'p1', from: 'p1:deck', to: 'p1:hand' });
    expect(event).not.toHaveProperty('instanceId');
    expect(event?.eventId).not.toContain(hiddenCard.instanceId);
  });

  it('replaces the single shared Land Magic slot atomically and routes the old card to its owner', () => {
    const oldLand = makeInstance('old-land', 'Magic', 'p2', 'Old Land', 'Land', 'p2');
    const nextLand = makeInstance('new-land', 'Magic', 'p1', 'New Land', 'Land', 'p1');
    const current = { ...makeState(makePlayer('p1', { hand: [nextLand] }), makePlayer('p2')), landMagicZone: oldLand };
    const result = moveCardBetweenZones(current, { instanceId: 'new-land', actorId: 'p1', destination: 'landMagicZone' });
    expect(result.ok).toBe(true);
    expect(result.state.landMagicZone?.instanceId).toBe('new-land');
    expect(result.state.players.p2.hell).toEqual([oldLand]);
    expect(result.state.gameEvents?.map(item => (item.event as { from?: string; to?: string }).to && item.event.type)).toEqual(['CARD_MOVED', 'CARD_MOVED']);
    expect(result.state.players.p2.hell[0]).toMatchObject({ ownerId: 'p2', controllerId: 'p2' });
  });

  it('routes an Avatar and its attached cards through shared movement events on field exit', () => {
    const attached = makeInstance('equipped-mod', 'Magic', 'p1', 'Equipped Modification', 'Modification', 'p2');
    const target = makeInstance('attached-target', 'Avatar', 'p2', 'Target');
    target.attachedInstances = [attached];
    const start = makeState(makePlayer('p1'), makePlayer('p2', { avatarZone: [target] }));
    const result = resolveEffectPlan(start, { actorId: 'p1', effects: [{ kind: 'destroy_avatar', targetId: target.instanceId }] });
    expect(result.ok).toBe(true);
    expect(result.state.players.p2.hell.map(card => card.instanceId)).toEqual(['attached-target']);
    expect(result.state.players.p1.hell.map(card => card.instanceId)).toEqual(['equipped-mod']);
    expect(result.state.players.p2.hell[0].attachedInstances).toEqual([]);
    expect(result.state.gameEvents?.filter(item => item.event.type === 'CARD_MOVED').map(item => item.event.instanceId)).toEqual([
      'attached-target', 'equipped-mod'
    ]);
  });

  it('prevents duplicate explicit events and reentrant event recursion', () => {
    const base = makeState();
    const event = { type: 'MAGIC_RESOLVED' as const, instanceId: 'magic-1', playerId: 'p1', eventId: 'event-once' };
    const appended = appendGameEvents(base, [event, event]);
    expect(appended.gameEvents?.map(item => item.sequence)).toEqual([0]);
    expect(appendGameEvents(appended, [event]).gameEvents).toHaveLength(1);

    let dispatchCount = 0;
    const handler = (received: typeof event) => {
      dispatchCount += 1;
      dispatchGameEvents([received], [handler]);
    };
    dispatchGameEvents([event], [handler]);
    expect(dispatchCount).toBe(1);

    let deepDispatchCount = 0;
    const deepHandler = (received: typeof event) => {
      deepDispatchCount += 1;
      dispatchGameEvents([{ ...received, eventId: `deep-${deepDispatchCount}` }], [deepHandler]);
    };
    const stateBeforeDeepDispatch = makeState();
    dispatchGameEvents([{ ...event, eventId: 'deep-root' }], [deepHandler]);
    expect(deepDispatchCount).toBe(32);
    expect(stateBeforeDeepDispatch).toEqual(makeState());
    dispatchGameEvents([{ ...event, eventId: 'deep-after-limit' }], [() => { deepDispatchCount += 1; }]);
    expect(deepDispatchCount).toBe(33);
  });

  it('rolls back nested transactions on rejection or throw with no partial mutations or leaked events', () => {
    const initial = makeState(makePlayer('p1', { hand: [makeInstance('transaction-card', 'Magic', 'p1', 'Txn', 'Normal')] }));
    const event = { type: 'MAGIC_RESOLVED' as const, instanceId: 'transaction-card', playerId: 'p1', eventId: 'failed-txn' };
    const rejected = runGameTransaction(initial, draft => {
      const nested = runGameTransaction(draft, child => {
        child.players.p1.hand[0].attachedInstances.push(makeInstance('rejected-nested-card'));
        child.players.p1.hand.splice(0);
        return null;
      }, [event]);
      expect(nested.ok).toBe(false);
      expect(nested.state).toBe(draft);
      return null;
    }, [event]);
    const thrown = runGameTransaction(initial, draft => {
      const nested = runGameTransaction(draft, child => {
        child.players.p1.hand[0].attachedInstances.push(makeInstance('thrown-nested-card'));
        return child;
      }, [event]);
      if (!nested.ok) throw new Error('nested transaction unexpectedly rejected');
      draft.players = nested.state.players;
      draft.gameEvents = nested.state.gameEvents;
      throw new Error('outer rollback');
    }, [event]);
    expect(rejected.ok).toBe(false);
    expect(thrown.ok).toBe(false);
    expect(initial.players.p1.hand).toHaveLength(1);
    expect(initial.players.p1.hand[0].attachedInstances).toEqual([]);
    expect(initial.gameEvents).toBeUndefined();
    expect(rejected.state).toBe(initial);
    expect(thrown.state).toBe(initial);
  });

  it('enforces the first-player turn-one Battle Phase skip and synchronizes the next turn and usage reset', () => {
    const current = makeState(
      makePlayer('p1', { hand: Array.from({ length: 7 }, (_, index) => makeInstance(`first-${index}`, 'Magic', 'p1', `First ${index}`, 'Normal')), usedMagicTypesThisTurn: new Set(['Normal']) }),
      makePlayer('p2', { deck: Array.from({ length: 3 }, (_, index) => makeInstance(`second-deck-${index}`, 'Magic', 'p2', `Second ${index}`, 'Normal')), usedMagicTypesThisTurn: new Set(['React']) })
    );
    expect(isFirstPlayerFirstTurn(current, 'p1')).toBe(true);
    expect(nextPhaseAfterMain(current, 'p1')).toBe('END');
    const forbiddenBattle = { ...current, currentPhase: 'BATTLE' as const };
    expect(isLegalGameStateSync(current, forbiddenBattle, 'p1')).toBe(false);

    const endPhase = { ...current, currentPhase: 'END' as const };
    const nextTurn = finishEndPhaseTurn(endPhase);
    expect(nextTurn.currentTurnPlayerIndex).toBe(1);
    expect(nextTurn.currentPhase).toBe('DRAW');
    expect(nextTurn.turnNumber).toBe(2);
    expect(isLegalGameStateSync(endPhase, nextTurn, 'p1')).toBe(true);
    const draw = executeDrawPhase(nextTurn);
    expect(draw.players.p1.usedMagicTypesThisTurn.size).toBe(0);
    expect(draw.players.p2.usedMagicTypesThisTurn.size).toBe(0);
    expect(isLegalGameStateSync(nextTurn, draw, 'p2')).toBe(true);
    expect(isFirstPlayerFirstTurn(draw, 'p2')).toBe(false);
    expect(nextPhaseAfterMain(draw, 'p2')).toBe('BATTLE');
  });
});
