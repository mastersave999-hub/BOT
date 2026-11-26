import { describe, expect, it } from 'vitest';
import type { Card, CardInstance, GameState, PlayerState } from '../src/engine/types';
import { beginEndPhaseDiscard, canUseMagicTypeThisTurn, discardToHandLimit, moveCardBetweenZones, validateConstructZone, validateGameState } from '../src/engine/gameRules';
import { runGameTransaction } from '../src/engine/gameTransaction';
import { redactLifeCardsForViewer } from '../src/engine/multiplayer';

const card = (name: string, type: Card['type'] = 'Construct'): Card => ({ printId: name, name, type, subtype: type === 'Magic' ? 'Normal' : null, cost: 0, gem: 1, power: 1, color: 'แดง', rarity: 'C', mainEffect: '', isOnlyOne: false, isBias: false, isCollab: false, imageUrl: '' });
const instance = (id: string, playerId: string, name = id, type: Card['type'] = 'Construct'): CardInstance => ({ instanceId: id, card: card(name, type), ownerId: playerId, controllerId: playerId, isRested: false, isFaceUp: true, attachedInstances: [], layerModifiers: [] });
const player = (id: string, overrides: Partial<PlayerState> = {}): PlayerState => ({ id, name: id, seat: id === 'p1' ? 0 : 1, deck: [], hand: [], lifeDeck: [], avatarZone: [], constructZone: [], magicZone: [], hell: [], darkDimension: [], isCritical: false, reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 }, usedMagicTypesThisTurn: new Set(), ...overrides });
const state = (p1 = player('p1'), p2 = player('p2')): GameState => ({ id: 'rules', mode: 'DUEL', playerOrder: ['p1', 'p2'], currentTurnPlayerIndex: 0, currentPhase: 'MAIN', turnNumber: 1, roundNumber: 1, players: { p1, p2 }, landMagicZone: null, eventLog: [] });

describe('shared game rules', () => {
  it('limits every Magic subtype, including Modification, to one use per turn', () => {
    const fresh = player('p1');
    expect(canUseMagicTypeThisTurn(fresh, 'Normal')).toBe(true);
    expect(canUseMagicTypeThisTurn(fresh, 'Modification')).toBe(true);
    const afterModification = player('p1', { usedMagicTypesThisTurn: new Set(['Modification']) });
    expect(canUseMagicTypeThisTurn(afterModification, 'Modification')).toBe(false);
    expect(canUseMagicTypeThisTurn(afterModification, 'Normal')).toBe(true);
    const afterNormal = player('p1', { usedMagicTypesThisTurn: new Set(['Normal']) });
    expect(canUseMagicTypeThisTurn(afterNormal, 'Normal')).toBe(false);
  });
  it('enforces the combined Avatar and Token limits at legal boundaries', () => {
    const avatars = Array.from({ length: 3 }, (_, index) => instance(`avatar-${index}`, 'p1', `Avatar ${index}`, 'Avatar'));
    const tokens = Array.from({ length: 2 }, (_, index) => instance(`token-${index}`, 'p1', `Token ${index}`, 'Token'));
    const nextAvatar = instance('avatar-3', 'p1', 'Avatar 3', 'Avatar');
    const atLimit = state(player('p1', { avatarZone: [...avatars, ...tokens], hand: [nextAvatar, instance('extra-token', 'p1', 'Extra token', 'Token')] }));
    const fourthAvatar = moveCardBetweenZones(atLimit, { instanceId: nextAvatar.instanceId, actorId: 'p1', destination: 'avatarZone', destinationPlayerId: 'p1' });
    expect(fourthAvatar.ok).toBe(true);
    expect(validateGameState(fourthAvatar.state)).toBeNull();
    const tooMany = moveCardBetweenZones(fourthAvatar.state, { instanceId: 'extra-token', actorId: 'p1', destination: 'avatarZone', destinationPlayerId: 'p1' });
    expect(tooMany.ok).toBe(false);
    const fiveAvatars = state(player('p1', { avatarZone: [...avatars, nextAvatar, instance('avatar-4', 'p1', 'Avatar 4', 'Avatar')] }));
    expect(validateGameState(fiveAvatars)).toMatch(/limit is 4 Avatars/);
  });

  it('enforces three unique Constructs per player but permits the same name for the opponent', () => {
    const first = instance('a', 'p1', 'Shared'), second = instance('b', 'p1', 'B'), third = instance('c', 'p1', 'C');
    const current = state(player('p1', { hand: [first, second, third] }), player('p2', { constructZone: [instance('other', 'p2', 'Shared')] }));
    let next = current;
    for (const item of [first, second, third]) {
      const moved = moveCardBetweenZones(next, { instanceId: item.instanceId, actorId: 'p1', destination: 'constructZone', destinationPlayerId: 'p1' });
      expect(moved.ok).toBe(true);
      next = moved.state;
    }
    expect(next.players.p1.constructZone).toHaveLength(3);
    const fourth = instance('d', 'p1', 'D');
    next = { ...next, players: { ...next.players, p1: { ...next.players.p1, hand: [fourth] } } };
    expect(moveCardBetweenZones(next, { instanceId: 'd', actorId: 'p1', destination: 'constructZone', destinationPlayerId: 'p1' }).ok).toBe(false);
    const duplicate = instance('e', 'p1', 'Shared');
    const dupeState = { ...current, players: { ...current.players, p1: { ...current.players.p1, hand: [duplicate], constructZone: [first] } } };
    expect(moveCardBetweenZones(dupeState, { instanceId: 'e', actorId: 'p1', destination: 'constructZone', destinationPlayerId: 'p1' }).ok).toBe(false);
    expect(validateConstructZone({ constructZone: [first, second, third, fourth] })).not.toBeNull();
  });

  it('rejects invalid incoming state and duplicate card instances', () => {
    const duplicate = instance('same', 'p1');
    const invalid = state(player('p1', { constructZone: [duplicate, instance('b', 'p1', 'B'), instance('c', 'p1', 'C'), instance('d', 'p1', 'D')] }));
    expect(validateGameState(invalid)).toMatch(/limit is 3/);
    const collision = state(player('p1', { hand: [duplicate] }), player('p2', { hand: [instance('same', 'p2')] }));
    expect(validateGameState(collision)).toMatch(/Duplicate card instance/);
  });

  it('does not expose a private card face in a Deck-to-hand movement event or opponent projection', () => {
    const topCard = instance('private-card-id', 'p1', 'Secret card', 'Magic');
    const current = state(player('p1', { deck: [topCard] }));
    const moved = moveCardBetweenZones(current, { instanceId: topCard.instanceId, actorId: 'p1', destination: 'hand' });
    expect(moved.ok).toBe(true);
    const event = moved.state.gameEvents?.[0].event;
    expect(event?.type).toBe('CARD_MOVED');
    expect(event).not.toHaveProperty('instanceId');
    const opponentView = redactLifeCardsForViewer(moved.state, 'p2');
    expect(opponentView.players.p1.hand[0].card.name).toBe('Hidden card');
    expect(opponentView.players.p1.hand[0].instanceId).toBe('private-card-id');
    const publicDrawEvent = opponentView.gameEvents?.find(item => item.event.type === 'CARD_DRAWN')?.event;
    expect(publicDrawEvent).not.toHaveProperty('instanceId');
    const ownerDrawEvent = redactLifeCardsForViewer(moved.state, 'p1').gameEvents?.find(item => item.event.type === 'CARD_DRAWN')?.event;
    expect(ownerDrawEvent?.type).toBe('CARD_DRAWN');
    expect(ownerDrawEvent).toHaveProperty('instanceId', 'private-card-id');
  });

  it('does not let destruction shields block a player-mandated removal', () => {
    const selectedAvatar = {
      ...instance('chosen-avatar', 'p1', 'Chosen Avatar', 'Avatar'),
      preventionShields: [{ id: 'destruction-shield', kind: 'DESTRUCTION' as const, includePlayerActions: true }]
    };
    const current = state(player('p1', { avatarZone: [selectedAvatar] }));
    const moved = moveCardBetweenZones(current, {
      instanceId: selectedAvatar.instanceId,
      actorId: 'p1',
      destination: 'deck',
      deckPosition: 'bottom',
      effectMove: true,
      cause: 'PLAYER_ACTION'
    });
    expect(moved.ok).toBe(true);
    expect(moved.state.players.p1.avatarZone).toHaveLength(0);
    expect(moved.state.players.p1.deck.map(item => item.instanceId)).toContain(selectedAvatar.instanceId);
    expect(moved.state.players.p1.avatarZone[0]?.preventionShields).toBeUndefined();
  });

  it('uses controller authorization separately from original-owner return routing', () => {
    const borrowed = { ...instance('borrowed', 'p1', 'Owned by p1', 'Avatar'), controllerId: 'p2' };
    const current = state(player('p1'), player('p2', { avatarZone: [borrowed] }));
    expect(moveCardBetweenZones(current, { instanceId: 'borrowed', actorId: 'p1', destination: 'hell', destinationPlayerId: 'p1' }).ok).toBe(false);
    const moved = moveCardBetweenZones(current, { instanceId: 'borrowed', actorId: 'p2', destination: 'hell', destinationPlayerId: 'p1' });
    expect(moved.ok).toBe(true);
    expect(moved.state.players.p1.hell[0].ownerId).toBe('p1');
    expect(moved.state.players.p1.hell[0].controllerId).toBe('p2');
    expect(moved.state.gameEvents?.map(item => item.event.type)).toEqual(['CARD_MOVED', 'CARD_LEFT_FIELD']);
  });

  it('discards exactly the selected excess hand cards after End Phase selection opens', () => {
    const hand = Array.from({ length: 9 }, (_, index) => instance(`h${index}`, 'p1', `Card ${index}`, 'Magic'));
    const current = { ...state(player('p1', { hand })), currentPhase: 'END' as const };
    const pending = beginEndPhaseDiscard(current, 'p1');
    expect(pending.ok).toBe(true);
    expect(discardToHandLimit(current, 'p1', ['h1', 'h7']).ok).toBe(false);
    expect(discardToHandLimit(pending.state, 'p1', ['h0']).ok).toBe(false);
    expect(discardToHandLimit(pending.state, 'p1', ['h0', 'h0']).ok).toBe(false);
    expect(discardToHandLimit(pending.state, 'p1', ['missing', 'h1']).ok).toBe(false);
    const result = discardToHandLimit(pending.state, 'p1', ['h1', 'h7']);
    expect(result.ok).toBe(true);
    expect(result.state.pendingEndPhaseDiscardPlayerId).toBeUndefined();
    expect(result.state.players.p1.hand).toHaveLength(7);
    expect(result.state.players.p1.hell.map(item => item.instanceId)).toEqual(['h1', 'h7']);
    const exactlySeven = { ...state(player('p1', { hand: hand.slice(0, 7) })), currentPhase: 'END' as const };
    expect(beginEndPhaseDiscard(exactlySeven, 'p1').ok).toBe(false);
  });

  it('rolls back nested mutations and emits no committed events on rejection or throw', () => {
    const initial = state(player('p1', { hand: [instance('hand', 'p1', 'hand', 'Magic')] }));
    const event = { type: 'MAGIC_RESOLVED' as const, instanceId: 'hand', playerId: 'p1' };
    const rejected = runGameTransaction(initial, draft => { draft.players.p1.hand.splice(0); return null; }, [event]);
    expect(rejected.ok).toBe(false);
    expect(rejected.state).toBe(initial);
    expect(initial.players.p1.hand).toHaveLength(1);
    expect(initial.gameEvents).toBeUndefined();
    const thrown = runGameTransaction(initial, draft => { draft.players.p1.hand[0].attachedInstances.push(instance('nested', 'p1')); throw new Error('failed'); }, [event]);
    expect(thrown.ok).toBe(false);
    expect(thrown.state).toBe(initial);
    expect(initial.players.p1.hand[0].attachedInstances).toHaveLength(0);
    expect(initial.gameEvents).toBeUndefined();
  });
});
