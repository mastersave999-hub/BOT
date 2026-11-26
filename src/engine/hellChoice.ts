import type { GameEvent } from './gameEvents';
import { appendGameEvents } from './gameEvents';
import { getOriginalOwnerId, moveCardBetweenZones } from './gameRules';
import { runGameTransaction } from './gameTransaction';
import type { GameState, PendingHellChoice } from './types';

export type HellChoiceRequest = Omit<PendingHellChoice, 'candidateInstanceIds' | 'expectedRevision' | 'commandId' | 'minSelect' | 'maxSelect'> & {
  count: number;
};

export type HellChoiceResult =
  | { ok: true; state: GameState; choiceRequired: true }
  | { ok: false; state: GameState; reason: string };

function matchesName(name: string, reference: NonNullable<PendingHellChoice['names']>[number]): boolean {
  if (reference.matching === 'EXACT_CARD_NAME') return name.trim() === reference.value.trim();
  const escaped = reference.value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'u').test(name);
}

export function beginHellChoice(state: GameState, request: HellChoiceRequest): HellChoiceResult {
  const player = state.players[request.playerId];
  if (!player || !state.players[request.actorId] || !state.players[request.authorizedViewerId] || request.playerId !== request.actorId) {
    return { ok: false, state, reason: 'Hell choice player does not exist' };
  }
  if (!Number.isSafeInteger(request.count) || request.count < 1) {
    return { ok: false, state, reason: 'Hell choice count must be a positive integer' };
  }
  if (state.pendingDeckChoice || state.pendingHellChoice || state.pendingDeckSearchVerification ||
    state.pendingEndPhaseDiscardPlayerId || state.pendingExitPrevention || state.reactionWindow) {
    return { ok: false, state, reason: 'Another game action is pending' };
  }
  const candidates = player.hell.filter(card => card.card.type === request.cardType &&
    (!request.names?.length || request.names.some(reference => matchesName(card.card.name, reference)))
  ).map(card => card.instanceId);
  if (candidates.length < request.count) return { ok: false, state, reason: 'Not enough matching cards in Hell' };
  const expectedRevision = (state.stateRevision ?? 0) + 1;
  const pending: PendingHellChoice = {
    effectKind: request.effectKind,
    playerId: request.playerId,
    actorId: request.actorId,
    authorizedViewerId: request.authorizedViewerId,
    candidateInstanceIds: candidates,
    minSelect: request.count,
    maxSelect: request.count,
    cardType: request.cardType,
    ...(request.names?.length ? { names: request.names } : {}),
    destination: request.destination,
    ...(request.rested !== undefined ? { rested: request.rested } : {}),
    expectedRevision,
  };
  const transaction = runGameTransaction(state, draft => ({
    ...draft,
    stateRevision: expectedRevision,
    pendingHellChoice: pending,
  }));
  if ('reason' in transaction) return { ok: false, state, reason: transaction.reason };
  return { ok: true, state: transaction.state, choiceRequired: true };
}

export function resolveHellChoice(
  state: GameState,
  viewerId: string,
  selectedInstanceIds: string[],
  expectedRevision: number,
  commandId?: string
): { ok: true; state: GameState } | { ok: false; state: GameState; reason: string } {
  const pending = state.pendingHellChoice;
  if (!pending || pending.authorizedViewerId !== viewerId) return { ok: false, state, reason: 'No authorized pending Hell choice' };
  if (!Number.isSafeInteger(expectedRevision) || pending.expectedRevision !== expectedRevision || state.stateRevision !== expectedRevision) {
    return { ok: false, state, reason: 'Stale Hell choice revision' };
  }
  if (commandId !== undefined && (!commandId || commandId.length > 128)) return { ok: false, state, reason: 'Invalid Hell choice command identifier' };
  if (commandId && state.processedCommandIds?.includes(commandId)) return { ok: false, state, reason: 'Duplicate Hell choice command' };
  if (!Array.isArray(selectedInstanceIds) || new Set(selectedInstanceIds).size !== selectedInstanceIds.length ||
    selectedInstanceIds.length < pending.minSelect || selectedInstanceIds.length > pending.maxSelect ||
    selectedInstanceIds.some(id => !pending.candidateInstanceIds.includes(id))) {
    return { ok: false, state, reason: 'Invalid Hell choice selection' };
  }
  const events: GameEvent[] = [{
    type: 'EFFECT_RESOLVED', actorId: pending.actorId, effectKind: pending.effectKind,
    eventId: `${state.id}:${state.gameEvents?.length ?? 0}:${pending.actorId}:hell-choice:${selectedInstanceIds.join(',')}`
  }];
  const transaction = runGameTransaction(state, draft => {
    let next: GameState = { ...draft, pendingHellChoice: undefined, stateRevision: expectedRevision + 1 };
    const moveOrder = pending.destination === 'deck_top' ? [...selectedInstanceIds].reverse() : selectedInstanceIds;
    for (const instanceId of moveOrder) {
      const card = next.players[pending.playerId].hell.find(item => item.instanceId === instanceId);
      if (!card || card.card.type !== pending.cardType || (pending.names?.length && !pending.names.some(name => matchesName(card.card.name, name)))) return null;
      const toDeck = pending.destination === 'deck_top' || pending.destination === 'deck_bottom';
      const moved = moveCardBetweenZones(next, {
        instanceId,
        actorId: pending.actorId,
        destination: toDeck ? 'deck' : pending.destination === 'banish' ? 'darkDimension'
          : pending.destination === 'avatarZone' ? 'avatarZone' : 'hand',
        destinationPlayerId: pending.destination === 'avatarZone' ? pending.playerId : getOriginalOwnerId(card),
        effectMove: true,
        ...(toDeck ? { deckPosition: pending.destination === 'deck_top' ? 'top' as const : 'bottom' as const } : {}),
      });
      if (!moved.ok) return null;
      next = moved.state;
      if (toDeck) {
        const owner = next.players[getOriginalOwnerId(card)];
        next = { ...next, players: { ...next.players, [owner.id]: {
          ...owner, deck: owner.deck.map(item => item.instanceId === instanceId ? { ...item, isFaceUp: false } : item)
        } } };
      } else if (pending.destination === 'avatarZone') {
        const player = next.players[pending.playerId];
        next = { ...next, players: { ...next.players, [player.id]: {
          ...player, avatarZone: player.avatarZone.map(item => item.instanceId === instanceId
            ? { ...item, isFaceUp: true, isRested: pending.rested ?? false, layerModifiers: [] }
            : item)
        } } };
      }
    }
    if (commandId) next = { ...next, processedCommandIds: [...(next.processedCommandIds ?? []), commandId].slice(-128) };
    return next;
  }, events, { allowPendingPlayerChoice: true });
  if ('reason' in transaction) return { ok: false, state, reason: transaction.reason };
  return { ok: true, state: transaction.state };
}
