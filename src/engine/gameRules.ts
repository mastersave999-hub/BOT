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

/** Rule Book 3.2 pp.10-11: ordinary, Modification and Land Magic are own-Main actions; all types share the once-per-turn limit. */
export function validateMagicPlay(state: GameState, playerId: string, subtype: NonNullable<import('./types').MagicSubtype>, convertedNormalToReact = false): string | null {
  const player = state.players[playerId];
  if (!player) return 'Player does not exist';
  if (state.playerOrder[state.currentTurnPlayerIndex] !== playerId) return 'Only the active player may play a Magic card';
  if (state.pendingEndPhaseDiscardPlayerId) return 'End Phase discard selection is pending';
  if (subtype === 'React') {
    if (convertedNormalToReact && (state.currentPhase !== 'BATTLE' || state.reactionWindow)) return 'Converted Normal Magic may only use React timing during your Battle Phase';
    if (!convertedNormalToReact && !state.reactionWindow) return 'React Magic requires a valid response window';
  } else {
    if (state.reactionWindow) return 'A card effect or reaction is currently resolving';
    if (state.currentPhase !== 'MAIN') return `${subtype} Magic can only be played during your Main Phase`;
  }
  if (!canUseMagicTypeThisTurn(player, subtype)) return `${subtype} Magic has already been used this turn`;
  return null;
}

export function validateGameState(state: GameState): string | null {
  if (state.stateRevision !== undefined && (!Number.isSafeInteger(state.stateRevision) || state.stateRevision < 0)) return 'Invalid game state revision';
  if (state.processedCommandIds !== undefined && (!Array.isArray(state.processedCommandIds) ||
    state.processedCommandIds.some(id => typeof id !== 'string') || new Set(state.processedCommandIds).size !== state.processedCommandIds.length)) {
    return 'Invalid processed command identifiers';
  }
  const seen = new Set<string>();
  for (const [playerId, player] of Object.entries(state.players)) {
    if (!(player.usedMagicTypesThisTurn instanceof Set) || [...player.usedMagicTypesThisTurn].some(type => !['Normal', 'Modification', 'React', 'Land'].includes(type))) {
      return `${playerId}: Invalid used Magic type state`;
    }
    const avatarError = validateAvatarZone(player);
    if (avatarError) return `${playerId}: ${avatarError}`;
    const constructError = validateConstructZone(player);
    if (constructError) return `${playerId}: ${constructError}`;
    for (const zone of ['deck', 'hand', 'lifeDeck', 'avatarZone', 'constructZone', 'magicZone', 'hell', 'darkDimension'] as const) {
      for (const card of player[zone]) {
        const pending = [card];
        while (pending.length > 0) {
          const current = pending.pop()!;
          if (seen.has(current.instanceId)) return `Duplicate card instance: ${current.instanceId}`;
          seen.add(current.instanceId);
          pending.push(...current.attachedInstances);
        }
      }
    }
  }
  if (state.landMagicZone) {
    const pending = [state.landMagicZone];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (seen.has(current.instanceId)) return `Duplicate card instance: ${current.instanceId}`;
      seen.add(current.instanceId);
      pending.push(...current.attachedInstances);
    }
  }
  if (state.pendingEndPhaseDiscardPlayerId) {
    const playerId = state.pendingEndPhaseDiscardPlayerId;
    const player = state.players[playerId];
    if (state.currentPhase !== 'END' || state.playerOrder[state.currentTurnPlayerIndex] !== playerId || !player || player.hand.length <= 7 ||
      state.pendingEndPhaseDiscardRevision === undefined || state.pendingEndPhaseDiscardRevision !== state.stateRevision) {
      return 'Invalid pending End Phase discard state';
    }
  } else if (state.pendingEndPhaseDiscardRevision !== undefined) {
    return 'Discard revision exists without pending selection';
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
  if (request.destination === 'hand' && card.card.type === 'Life') return { ok: false, state, reason: 'LIFE cards cannot enter a hand' };
  if (request.destination === 'magicZone' && card.card.type !== 'Magic' && card.card.type !== 'Avatar') return { ok: false, state, reason: 'Only Magic cards or relocated Avatars may enter Magic Zone' };
  const destinationPlayerId = request.destinationPlayerId ?? card.ownerId;
  if (request.destination !== 'landMagicZone' && request.destination !== 'removedFromGame' && !state.players[destinationPlayerId]) {
    return { ok: false, state, reason: 'Destination player does not exist' };
  }
  if ((request.destination === 'hell' || request.destination === 'hand' || request.destination === 'deck' || request.destination === 'darkDimension') && destinationPlayerId !== card.ownerId) {
    return { ok: false, state, reason: 'Card must return to its owner’s destination zone' };
  }
  const players = { ...state.players };
  const events: GameEvent[] = [];
  const attachmentsLeaveWithAvatar = sourceZone === 'avatarZone' && request.destination !== 'avatarZone' && request.destination !== 'magicZone';
  const detachedAttachments: CardInstance[] = [];
  const collectAttachments = (attachments: CardInstance[]) => {
    for (const attached of attachments) {
      detachedAttachments.push({ ...attached, attachedInstances: [] });
      collectAttachments(attached.attachedInstances);
    }
  };
  if (attachmentsLeaveWithAvatar) collectAttachments(card.attachedInstances);
  const destinationCard = attachmentsLeaveWithAvatar && card.attachedInstances.length > 0
    ? { ...card, attachedInstances: [] }
    : card;
  if (sourcePlayerId && sourceZone) {
    players[sourcePlayerId] = { ...players[sourcePlayerId], [sourceZone]: players[sourcePlayerId][sourceZone].filter(item => item.instanceId !== card!.instanceId) };
  }
  let landMagicZone = isLand ? null : state.landMagicZone;
  const replacedLand = request.destination === 'landMagicZone' && landMagicZone?.instanceId !== card.instanceId ? landMagicZone : null;
  if (replacedLand) {
    const landOwner = players[replacedLand.ownerId];
    if (!landOwner) return { ok: false, state, reason: 'Land Magic owner does not exist' };
    players[landOwner.id] = { ...landOwner, hell: [...landOwner.hell, replacedLand] };
    events.push({
      type: 'CARD_MOVED', instanceId: replacedLand.instanceId, ownerId: replacedLand.ownerId,
      controllerId: replacedLand.controllerId, from: 'landMagicZone', to: `${landOwner.id}:hell`,
      actorId: request.actorId,
      eventId: `${state.id}:${state.gameEvents?.length ?? 0}:${replacedLand.instanceId}:landMagicZone-to-hell`
    });
    landMagicZone = null;
  }
  if (request.destination === 'landMagicZone') {
    landMagicZone = destinationCard;
  } else if (request.destination !== 'removedFromGame') {
    const destinationPlayer = players[destinationPlayerId];
    const currentZone = destinationPlayer[request.destination];
    if (request.destination === 'constructZone') {
      const err = validateConstructZone({ constructZone: [...currentZone, destinationCard] });
      if (err) return { ok: false, state, reason: err };
    }
    players[destinationPlayerId] = { ...destinationPlayer, [request.destination]: [...currentZone, destinationCard] };
  }
  for (const attached of detachedAttachments) {
    const owner = players[attached.ownerId];
    if (!owner) return { ok: false, state, reason: 'Attached card owner does not exist' };
    if (request.destination !== 'removedFromGame') {
      players[owner.id] = { ...owner, hell: [...owner.hell, attached] };
    }
  }
  const next = { ...state, players, landMagicZone };
  const error = validateGameState(next);
  if (error) return { ok: false, state, reason: error };
  const privateSource = sourceZone === 'deck' || sourceZone === 'hand' || (sourceZone === 'lifeDeck' && !card.isFaceUp);
  const publicDestination = request.destination === 'landMagicZone' || request.destination === 'avatarZone' || request.destination === 'constructZone' || request.destination === 'magicZone' ||
    request.destination === 'hell' || request.destination === 'darkDimension';
  const exposeIdentity = !privateSource || publicDestination;
  events.push({
    type: 'CARD_MOVED',
    ...(exposeIdentity ? { instanceId: card.instanceId } : {}),
    ownerId: card.ownerId,
    controllerId: card.controllerId,
    from: isLand ? 'landMagicZone' : `${sourcePlayerId}:${sourceZone}`,
    to: request.destination === 'landMagicZone' ? 'landMagicZone' : request.destination === 'removedFromGame' ? 'removedFromGame' : `${destinationPlayerId}:${request.destination}`,
    actorId: request.actorId,
    eventId: `${state.id}:${(state.gameEvents?.length ?? 0) + events.length}:CARD_MOVED:${exposeIdentity ? card.instanceId : 'hidden'}:${sourcePlayerId ?? 'shared'}:${sourceZone ?? 'landMagicZone'}:${destinationPlayerId ?? 'shared'}:${request.destination}:${request.actorId}`
  });
  detachedAttachments.forEach((attached, index) => events.push({
    type: 'CARD_MOVED', instanceId: attached.instanceId, ownerId: attached.ownerId,
    controllerId: attached.controllerId, from: `${sourcePlayerId}:attached`,
    to: request.destination === 'removedFromGame' ? 'removedFromGame' : `${attached.ownerId}:hell`,
    actorId: request.actorId,
    eventId: `${state.id}:${state.gameEvents?.length ?? 0}:attached:${index}:${attached.instanceId}:${request.destination}:${request.actorId}`
  }));
  if (sourceZone === 'constructZone' && sourcePlayerId) events.push({
    type: 'CONSTRUCT_LEFT', instanceId: card.instanceId, name: card.card.name, playerId: sourcePlayerId,
    eventId: `${state.id}:${state.gameEvents?.length ?? 0}:construct-left:${card.instanceId}:${sourcePlayerId}`
  });
  if (request.destination === 'constructZone') events.push({
    type: 'CONSTRUCT_ENTERED', instanceId: card.instanceId, name: card.card.name, playerId: destinationPlayerId,
    eventId: `${state.id}:${state.gameEvents?.length ?? 0}:construct-entered:${card.instanceId}:${destinationPlayerId}`
  });
  return { ok: true, state: appendGameEvents(next, events) };
}

export function beginEndPhaseDiscard(state: GameState, playerId: string): ZoneMoveResult {
  const player = state.players[playerId];
  if (!player || state.currentPhase !== 'END' || state.playerOrder[state.currentTurnPlayerIndex] !== playerId) {
    return { ok: false, state, reason: 'Only the active player may begin End Phase discard selection' };
  }
  if (state.pendingEndPhaseDiscardPlayerId || player.hand.length <= 7) {
    return { ok: false, state, reason: 'End Phase discard selection is not required or is already pending' };
  }
  const revision = (state.stateRevision ?? 0) + 1;
  return { ok: true, state: {
    ...state,
    stateRevision: revision,
    pendingEndPhaseDiscardPlayerId: playerId,
    pendingEndPhaseDiscardRevision: revision
  } };
}

/** Discard destination is unspecified by Rule Book 3.2; owner Hell is this app's routing convention. */
export function discardToHandLimit(
  state: GameState,
  playerId: string,
  selectedInstanceIds: string[],
  expectedRevision: number = state.stateRevision ?? 0,
  commandId?: string
): ZoneMoveResult {
  const player = state.players[playerId];
  if (commandId && state.processedCommandIds?.includes(commandId)) {
    return { ok: false, state, reason: 'Duplicate End Phase discard command' };
  }
  if (!player || state.pendingEndPhaseDiscardPlayerId !== playerId || state.currentPhase !== 'END' ||
    state.playerOrder[state.currentTurnPlayerIndex] !== playerId) {
    return { ok: false, state, reason: 'No pending End Phase discard selection for this player' };
  }
  if (state.pendingEndPhaseDiscardRevision !== expectedRevision || state.stateRevision !== expectedRevision) {
    return { ok: false, state, reason: 'Stale End Phase discard revision' };
  }
  const excess = Math.max(0, player.hand.length - 7);
  if (!Array.isArray(selectedInstanceIds) || selectedInstanceIds.length !== excess ||
    new Set(selectedInstanceIds).size !== excess || selectedInstanceIds.some(id => typeof id !== 'string' || !player.hand.some(card => card.instanceId === id))) {
    return { ok: false, state, reason: `Select exactly ${excess} distinct cards from your hand` };
  }
  let next: GameState = {
    ...state,
    pendingEndPhaseDiscardPlayerId: undefined,
    pendingEndPhaseDiscardRevision: undefined
  };
  for (const instanceId of selectedInstanceIds) {
    const moved = moveCardBetweenZones(next, { instanceId, actorId: playerId, destination: 'hell', effectMove: true });
    if (!moved.ok) return { ok: false, state, reason: moved.reason };
    next = moved.state;
  }
  next = {
    ...next,
    stateRevision: expectedRevision + 1,
    processedCommandIds: commandId
      ? [...(state.processedCommandIds ?? []), commandId].slice(-128)
      : state.processedCommandIds
  };
  return { ok: true, state: next };
}
