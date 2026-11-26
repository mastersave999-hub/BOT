import type { CardInstance, GameState, PlayerState } from './types';
import { appendGameEvents, type GameEvent } from './gameEvents';

export type PlayerZone = 'deck' | 'hand' | 'lifeDeck' | 'avatarZone' | 'constructZone' | 'magicZone' | 'hell' | 'darkDimension';

export function validateAvatarZone(player: Pick<PlayerState, 'avatarZone'>): string | null {
  const avatars = player.avatarZone.filter(card => card.card.type === 'Avatar').length;
  if (avatars > 4) return 'Avatar Zone limit is 4 Avatars';
  if (player.avatarZone.length > 6) return 'Avatar Zone limit is 6 total Avatars and Tokens';
  if (player.avatarZone.some(card => card.card.type !== 'Avatar' && card.card.type !== 'Token')) return 'Avatar Zone contains an invalid card type';
  return null;
}

export function validateConstructZone(player: Pick<PlayerState, 'constructZone'>): string | null {
  const constructs = player.constructZone;
  if (constructs.length > 3) return 'Construct Zone limit is 3';
  const names = constructs.map(card => card.card.name);
  if (new Set(names).size !== names.length) return 'Construct names must be unique per player';
  if (constructs.some(card => card.card.type !== 'Construct')) return 'Construct Zone contains a non-Construct card';
  return null;
}

export function canUseMagicTypeThisTurn(player: Pick<PlayerState, 'usedMagicTypesThisTurn'>, subtype: NonNullable<import('./types').MagicSubtype>): boolean {
  return !player.usedMagicTypesThisTurn.has(subtype);
}

export function validateGameState(state: GameState): string | null {
  const seen = new Set<string>();
  for (const [playerId, player] of Object.entries(state.players)) {
    const avatarError = validateAvatarZone(player);
    if (avatarError) return `${playerId}: ${avatarError}`;
    const constructError = validateConstructZone(player);
    if (constructError) return `${playerId}: ${constructError}`;
    for (const zone of ['deck', 'hand', 'lifeDeck', 'avatarZone', 'constructZone', 'magicZone', 'hell', 'darkDimension'] as const) {
      for (const card of player[zone]) {
        if (seen.has(card.instanceId)) return `Duplicate card instance: ${card.instanceId}`;
        seen.add(card.instanceId);
      }
    }
  }
  if (state.landMagicZone && seen.has(state.landMagicZone.instanceId)) return `Duplicate card instance: ${state.landMagicZone.instanceId}`;
  if (state.pendingEndPhaseDiscardPlayerId) {
    const playerId = state.pendingEndPhaseDiscardPlayerId;
    const player = state.players[playerId];
    if (state.currentPhase !== 'END' || state.playerOrder[state.currentTurnPlayerIndex] !== playerId || !player || player.hand.length <= 7) {
      return 'Invalid pending End Phase discard state';
    }
  }
  return null;
}

export interface ZoneMoveRequest {
  instanceId: string;
  /** The controlling player authorizing this move; ownership is checked independently. */
  actorId: string;
  destination: PlayerZone | 'landMagicZone' | 'removedFromGame';
  destinationPlayerId?: string;
  /** Explicitly allow a move initiated by an effect rather than the current controller. */
  effectMove?: boolean;
}

export interface ZoneMoveResult { ok: boolean; state: GameState; reason?: string }

const ZONES: readonly PlayerZone[] = ['deck', 'hand', 'lifeDeck', 'avatarZone', 'constructZone', 'magicZone', 'hell', 'darkDimension'];

/** Moves one existing card instance atomically, preserving identity and original owner. */
export function moveCardBetweenZones(state: GameState, request: ZoneMoveRequest): ZoneMoveResult {
  const invalid = validateGameState(state);
  if (invalid) return { ok: false, state, reason: invalid };
  let card: CardInstance | undefined;
  let sourcePlayerId: string | undefined;
  let sourceZone: PlayerZone | undefined;
  for (const playerId of state.playerOrder) {
    const player = state.players[playerId];
    if (!player) continue;
    for (const zone of ZONES) {
      const found = player[zone].find(item => item.instanceId === request.instanceId);
      if (found) { card = found; sourcePlayerId = playerId; sourceZone = zone; break; }
    }
    if (card) break;
  }
  const isLand = state.landMagicZone?.instanceId === request.instanceId;
  if (isLand) card = state.landMagicZone ?? undefined;
  if (!card || (!isLand && !sourcePlayerId) || (!request.effectMove && card.controllerId !== request.actorId)) {
    return { ok: false, state, reason: 'Card not found or actor is not its controller' };
  }
  if (request.destination === 'landMagicZone' && (card.card.type !== 'Magic' || card.card.subtype !== 'Land')) return { ok: false, state, reason: 'Only Land Magic cards may enter Land Magic Zone' };
  if (request.destination === 'constructZone' && card.card.type !== 'Construct') return { ok: false, state, reason: 'Only Construct cards may enter Construct Zone' };
  if (request.destination === 'avatarZone' && card.card.type !== 'Avatar' && card.card.type !== 'Token') return { ok: false, state, reason: 'Only Avatars and Tokens may enter Avatar Zone' };
  if (request.destination === 'lifeDeck' && card.card.type !== 'Life') return { ok: false, state, reason: 'Only LIFE cards may enter LIFE Zone' };
  if (request.destination === 'deck' && card.card.type === 'Life') return { ok: false, state, reason: 'LIFE cards cannot enter the Main Deck' };
  const destinationPlayerId = request.destinationPlayerId ?? card.ownerId;
  if (request.destination !== 'landMagicZone' && request.destination !== 'removedFromGame' && !state.players[destinationPlayerId]) {
    return { ok: false, state, reason: 'Destination player does not exist' };
  }
  if ((request.destination === 'hell' || request.destination === 'hand' || request.destination === 'deck' || request.destination === 'darkDimension') && destinationPlayerId !== card.ownerId) {
    return { ok: false, state, reason: 'Card must return to its owner’s destination zone' };
  }
  const players = { ...state.players };
  if (sourcePlayerId && sourceZone) {
    players[sourcePlayerId] = { ...players[sourcePlayerId], [sourceZone]: players[sourcePlayerId][sourceZone].filter(item => item.instanceId !== card!.instanceId) };
  }
  let landMagicZone = isLand ? null : state.landMagicZone;
  if (request.destination === 'landMagicZone') {
    if (landMagicZone && landMagicZone.instanceId !== card.instanceId) {
      return { ok: false, state, reason: 'Land Magic Zone is occupied' };
    }
    landMagicZone = card;
  } else if (request.destination !== 'removedFromGame') {
    const destinationPlayer = players[destinationPlayerId];
    const currentZone = destinationPlayer[request.destination];
    if (request.destination === 'constructZone') {
      const err = validateConstructZone({ constructZone: [...currentZone, card] });
      if (err) return { ok: false, state, reason: err };
    }
    players[destinationPlayerId] = { ...destinationPlayer, [request.destination]: [...currentZone, card] };
  }
  const next = { ...state, players, landMagicZone };
  const error = validateGameState(next);
  if (error) return { ok: false, state, reason: error };
  const privateSource = sourceZone === 'deck' || sourceZone === 'hand' || (sourceZone === 'lifeDeck' && !card.isFaceUp);
  const publicDestination = request.destination === 'landMagicZone' || request.destination === 'avatarZone' || request.destination === 'constructZone' || request.destination === 'magicZone' ||
    request.destination === 'hell' || request.destination === 'darkDimension';
  const exposeIdentity = !privateSource || publicDestination;
  const events: GameEvent[] = [{
    type: 'CARD_MOVED',
    ...(exposeIdentity ? { instanceId: card.instanceId } : {}),
    ownerId: card.ownerId,
    controllerId: card.controllerId,
    from: isLand ? 'landMagicZone' : `${sourcePlayerId}:${sourceZone}`,
    to: request.destination === 'landMagicZone' ? 'landMagicZone' : request.destination === 'removedFromGame' ? 'removedFromGame' : `${destinationPlayerId}:${request.destination}`,
    actorId: request.actorId
  }];
  if (sourceZone === 'constructZone' && sourcePlayerId) events.push({ type: 'CONSTRUCT_LEFT' as const, instanceId: card.instanceId, name: card.card.name, playerId: sourcePlayerId });
  if (request.destination === 'constructZone') events.push({ type: 'CONSTRUCT_ENTERED' as const, instanceId: card.instanceId, name: card.card.name, playerId: destinationPlayerId });
  return { ok: true, state: appendGameEvents(next, events) };
}

export function discardToHandLimit(state: GameState, playerId: string, selectedInstanceIds: string[]): ZoneMoveResult {
  const player = state.players[playerId];
  if (!player) return { ok: false, state, reason: 'Player does not exist' };
  const excess = Math.max(0, player.hand.length - 7);
  if (selectedInstanceIds.length !== excess || new Set(selectedInstanceIds).size !== excess || selectedInstanceIds.some(id => !player.hand.some(card => card.instanceId === id))) {
    return { ok: false, state, reason: `Select exactly ${excess} distinct cards from your hand` };
  }
  let next: GameState = state.pendingEndPhaseDiscardPlayerId
    ? { ...state, pendingEndPhaseDiscardPlayerId: undefined }
    : state;
  for (const instanceId of selectedInstanceIds) {
    const moved = moveCardBetweenZones(next, { instanceId, actorId: playerId, destination: 'hell', effectMove: true });
    if (!moved.ok) return { ok: false, state, reason: moved.reason };
    next = moved.state;
  }
  return { ok: true, state: next };
}
