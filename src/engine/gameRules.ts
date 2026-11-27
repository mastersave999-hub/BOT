import type { CardInstance, GameState, PendingExitPrevention, PlayerState } from './types';
import { appendGameEvents, type GameEvent } from './gameEvents';
import { recomputeContinuousEffects } from './continuousEffects';
import { preventDestruction } from './prevention';
import { validateGemPayment } from './gemPayment';

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
  if (state.pendingExitPrevention) return 'Exit-prevention choice is pending';
  if (state.pendingDeckChoice || state.pendingDeckSearchVerification) return 'A Deck operation choice is pending';
  if (state.pendingHellChoice) return 'A Hell recovery choice is pending';
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

function validateCardMechanics(card: CardInstance): string | null {
  if (card.continuousEffects?.some(effect => ![1, 2].includes(effect.layer) || !Number.isFinite(effect.powerMod))) return `${card.instanceId}: Invalid continuous effect`;
  if (card.preventionShields?.some(shield => !shield.id || !['DAMAGE', 'DESTRUCTION', 'TARGETING'].includes(shield.kind) ||
    (shield.amount !== undefined && (!Number.isFinite(shield.amount) || shield.amount <= 0)) ||
    (shield.usesRemaining !== undefined && (!Number.isSafeInteger(shield.usesRemaining) || shield.usesRemaining < 0)))) return `${card.instanceId}: Invalid prevention shield`;
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
    if (player.preventionShields?.some(shield => !shield.id || !['DAMAGE', 'DESTRUCTION', 'TARGETING'].includes(shield.kind) ||
      (shield.amount !== undefined && (!Number.isFinite(shield.amount) || shield.amount <= 0)) ||
      (shield.usesRemaining !== undefined && (!Number.isSafeInteger(shield.usesRemaining) || shield.usesRemaining < 0)))) return `${playerId}: Invalid prevention shield`;
    const avatarError = validateAvatarZone(player);
    if (avatarError) return `${playerId}: ${avatarError}`;
    const constructError = validateConstructZone(player);
    if (constructError) return `${playerId}: ${constructError}`;
    for (const zone of ['deck', 'hand', 'lifeDeck', 'avatarZone', 'constructZone', 'magicZone', 'hell', 'darkDimension'] as const) {
      for (const card of player[zone]) {
        if (zone === 'avatarZone' && card.controllerId !== playerId) return `${card.instanceId}: Avatar Zone does not match its controller`;
        const pending = [card];
        while (pending.length > 0) {
          const current = pending.pop()!;
          if (seen.has(current.instanceId)) return `Duplicate card instance: ${current.instanceId}`;
          if (current.originalOwnerId !== undefined && !state.players[current.originalOwnerId]) return `${current.instanceId}: Original owner does not exist`;
          const mechanicsError = validateCardMechanics(current);
          if (mechanicsError) return mechanicsError;
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
      const mechanicsError = validateCardMechanics(current);
      if (mechanicsError) return mechanicsError;
      seen.add(current.instanceId);
      pending.push(...current.attachedInstances);
    }
  }
  if (state.ruleMode !== undefined && !['HYBRID', 'AUTO_STRICT'].includes(state.ruleMode)) return 'Invalid room rule mode';
  if ([state.pendingDeckChoice, state.pendingHellChoice, state.pendingDeckSearchVerification, state.pendingEndPhaseDiscardPlayerId, state.pendingExitPrevention, state.pendingManualOverride].filter(Boolean).length > 1) return 'Only one pending player choice is allowed';
  if (state.pendingManualOverride) {
    const pending = state.pendingManualOverride;
    const action = pending.action;
    const manualDeckCriteriaValid = (criteria: unknown): boolean => {
      if (criteria === undefined || criteria === null || typeof criteria !== 'object' || Array.isArray(criteria)) return false;
      const value = criteria as Record<string, unknown>;
      const numericOk = (input: unknown) => input === undefined || (typeof input === 'number' && Number.isFinite(input) && input >= 0);
      return (value.types === undefined || (Array.isArray(value.types) && value.types.every(type => typeof type === 'string'))) &&
        (value.colors === undefined || (Array.isArray(value.colors) && value.colors.every(color => typeof color === 'string'))) &&
        (value.symbols === undefined || (Array.isArray(value.symbols) && value.symbols.every(symbol => typeof symbol === 'string'))) &&
        (value.nameIncludes === undefined || typeof value.nameIncludes === 'string') &&
        numericOk(value.minCost) && numericOk(value.maxCost);
    };
    const actionShapeValid = (raw: unknown): boolean => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
      // Validator only inspects shapes; the loose index signature keeps the checks readable.
      const candidate = raw as { [key: string]: any };
      return (
      (candidate.kind === 'ADJUST_POWER' && Number.isSafeInteger(candidate.delta) && candidate.delta !== 0 && typeof candidate.instanceId === 'string') ||
      (candidate.kind === 'SET_WAKE_STATE' && typeof candidate.isRested === 'boolean' && typeof candidate.instanceId === 'string') ||
      (candidate.kind === 'MOVE_CARD' && typeof candidate.instanceId === 'string' &&
        ['deck', 'hand', 'avatarZone', 'constructZone', 'magicZone', 'hell', 'darkDimension'].includes(candidate.destination) &&
        (candidate.deckPosition === undefined || ['top', 'bottom'].includes(candidate.deckPosition)) &&
        (candidate.destinationPlayerId === undefined || !!state.players[candidate.destinationPlayerId])) ||
      (candidate.kind === 'DRAW_CARD' && typeof candidate.playerId === 'string' && !!state.players[candidate.playerId]) ||
      (candidate.kind === 'DISCARD_CARD' && typeof candidate.instanceId === 'string') ||
      (candidate.kind === 'ADJUST_LIFE' && typeof candidate.playerId === 'string' && !!state.players[candidate.playerId] && ['up', 'down'].includes(candidate.face)) ||
      (candidate.kind === 'MANUAL_SEARCH_DECK' && typeof candidate.deckOwnerId === 'string' && !!state.players[candidate.deckOwnerId] &&
        Number.isSafeInteger(candidate.selectCount) && candidate.selectCount >= 1 && candidate.selectCount <= 10 &&
        ['hand', 'hell', 'deck'].includes(candidate.destination) && manualDeckCriteriaValid(candidate.criteria)) ||
      (candidate.kind === 'MANUAL_SCOUT_DECK' && typeof candidate.deckOwnerId === 'string' && !!state.players[candidate.deckOwnerId] &&
        Number.isSafeInteger(candidate.count) && candidate.count >= 1 && candidate.count <= 10 &&
        ['hand', 'hell', 'deck'].includes(candidate.destination) &&
        (candidate.selectedDeckPosition === undefined || (['top', 'bottom'].includes(candidate.selectedDeckPosition) && candidate.destination === 'deck')) &&
        (candidate.unselectedDeckPosition === undefined || ['top', 'bottom', 'shuffle'].includes(candidate.unselectedDeckPosition))) ||
      (candidate.kind === 'MANUAL_MILL_DECK' && typeof candidate.deckOwnerId === 'string' && !!state.players[candidate.deckOwnerId] &&
        Number.isSafeInteger(candidate.count) && candidate.count >= 1 && candidate.count <= 10) ||
      (candidate.kind === 'MANUAL_SHUFFLE_DECK' && typeof candidate.deckOwnerId === 'string' && !!state.players[candidate.deckOwnerId]) ||
      (candidate.kind === 'MANUAL_HELL_CHOICE' && typeof candidate.playerId === 'string' && !!state.players[candidate.playerId] &&
        ['Avatar', 'Construct', 'Magic'].includes(candidate.cardType) &&
        Number.isSafeInteger(candidate.count) && candidate.count >= 1 && candidate.count <= 10 &&
        ['hand', 'deck_top', 'deck_bottom', 'avatarZone', 'banish'].includes(candidate.destination)) ||
      (candidate.kind === 'MANUAL_SPAWN_TOKEN' && typeof candidate.playerId === 'string' && !!state.players[candidate.playerId] &&
        (candidate.name === undefined || (typeof candidate.name === 'string' && candidate.name.length > 0)) &&
        (candidate.power === undefined || Number.isSafeInteger(candidate.power)) &&
        (candidate.color === undefined || typeof candidate.color === 'string')) ||
      (candidate.kind === 'MANUAL_CHANGE_CONTROL' && typeof candidate.instanceId === 'string' &&
        typeof candidate.newControllerId === 'string' && !!state.players[candidate.newControllerId])
    );
    };
    // Phase 8: an optional multi-step queue; a Deck/Hell choice step must be the final step.
    const CHOICE_OPENING_KINDS = ['MANUAL_SEARCH_DECK', 'MANUAL_SCOUT_DECK', 'MANUAL_HELL_CHOICE'];
    const queueValid = pending.actions === undefined || (Array.isArray(pending.actions) && pending.actions.length >= 1 &&
      pending.actions.length <= 8 && pending.actions.every(step => actionShapeValid(step)) &&
      !pending.actions.slice(0, -1).some(step => CHOICE_OPENING_KINDS.includes(step.kind)));
    if (!actionShapeValid(action) || !queueValid || !state.players[pending.actorId] ||
      state.playerOrder[state.currentTurnPlayerIndex] !== pending.actorId ||
      !Number.isSafeInteger(pending.expectedRevision) || pending.expectedRevision !== state.stateRevision ||
      typeof pending.commandId !== 'string' || !pending.commandId || pending.commandId.length > 128 ||
      !Array.isArray(pending.approvals) || !Array.isArray(pending.rejections) ||
      pending.approvals.some(id => typeof id !== 'string' || !state.players[id] || id === pending.actorId) ||
      pending.rejections.some(id => typeof id !== 'string' || !state.players[id] || id === pending.actorId) ||
      pending.approvals.some(id => pending.rejections.includes(id))) {
      return 'Invalid pending manual override';
    }
  }
  if (state.pendingHellChoice) {
    const pending = state.pendingHellChoice;
    const player = state.players[pending.playerId];
    if (!player || !state.players[pending.actorId] || !state.players[pending.authorizedViewerId] ||
      !['recover_from_hell', 'summon_from_hell'].includes(pending.effectKind) ||
      !['Avatar', 'Construct', 'Magic'].includes(pending.cardType) ||
      !['deck_top', 'deck_bottom', 'hand', 'banish', 'avatarZone'].includes(pending.destination) ||
      (pending.destination === 'avatarZone' && (pending.effectKind !== 'summon_from_hell' || pending.cardType !== 'Avatar')) ||
      (pending.effectKind === 'summon_from_hell' && pending.destination !== 'avatarZone') ||
      !Array.isArray(pending.candidateInstanceIds) || !Number.isSafeInteger(pending.expectedRevision) || pending.expectedRevision !== state.stateRevision ||
      !Number.isSafeInteger(pending.minSelect) || !Number.isSafeInteger(pending.maxSelect) || pending.minSelect < 0 ||
      pending.maxSelect < pending.minSelect || pending.maxSelect > pending.candidateInstanceIds.length ||
      new Set(pending.candidateInstanceIds).size !== pending.candidateInstanceIds.length ||
      pending.candidateInstanceIds.some(id => typeof id !== 'string' || !player.hell.some(card => card.instanceId === id && card.card.type === pending.cardType)) ||
      (pending.names !== undefined && (!Array.isArray(pending.names) || pending.names.some(name => !name.value ||
        !['DELIMITED_WORD_SEQUENCE', 'EXACT_CARD_NAME'].includes(name.matching)))) ||
      (pending.symbol !== undefined && !pending.symbol.trim()) ||
      (pending.powerAtMost !== undefined && (!Number.isFinite(pending.powerAtMost) || pending.powerAtMost < 0))) {
      return 'Invalid pending Hell choice';
    }
  }
  if (state.pendingExitPrevention) {
    const pending = state.pendingExitPrevention;
    const targetOnField = Object.values(state.players).some(player =>
      [...player.avatarZone, ...player.constructZone].some(card => card.instanceId === pending.targetCardId));
    if (!targetOnField || !state.players[pending.actorId] || !Number.isSafeInteger(pending.expectedRevision) ||
      pending.expectedRevision !== state.stateRevision || (pending.usedActivatedPrevention && !state.reactionWindow?.chain?.some(entry =>
        entry.entryType === 'ACTIVATED_ABILITY' && entry.exitPreventionTargetId === pending.targetCardId
      ))) {
      return 'Invalid pending exit-prevention state';
    }
  }
  if (state.pendingDeckSearchVerification) {
    const pending = state.pendingDeckSearchVerification;
    if (!state.players[pending.deckOwnerId] || !state.players[pending.searcherId] || !Array.isArray(pending.verifierPlayerIds) ||
      pending.verifierPlayerIds.length === 0 || !Number.isSafeInteger(pending.expectedRevision) ||
      new Set(pending.verifierPlayerIds).size !== pending.verifierPlayerIds.length ||
      pending.verifierPlayerIds.some(id => !state.players[id] || id === pending.searcherId) || pending.expectedRevision !== state.stateRevision) {
      return 'Invalid pending Deck Search verification';
    }
  }
  if (state.pendingDeckChoice) {
    const pending = state.pendingDeckChoice;
    const owner = state.players[pending.deckOwnerId];
    if (!owner || !state.players[pending.actorId] || !state.players[pending.authorizedViewerId] ||
      !['SCOUT', 'SEARCH'].includes(pending.kind) || !['hand', 'hell', 'deck'].includes(pending.destination) ||
      !Array.isArray(pending.candidateInstanceIds) || !Number.isSafeInteger(pending.expectedRevision) || pending.expectedRevision !== state.stateRevision ||
      !Number.isSafeInteger(pending.minSelect) || !Number.isSafeInteger(pending.maxSelect) ||
      pending.minSelect < 0 || pending.maxSelect < pending.minSelect || pending.maxSelect > pending.candidateInstanceIds.length ||
      new Set(pending.candidateInstanceIds).size !== pending.candidateInstanceIds.length ||
      pending.candidateInstanceIds.some(id => typeof id !== 'string' || !owner.deck.some(card => card.instanceId === id))) {
      return 'Invalid pending Deck operation choice';
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
  /** Ability-authorized Deck ordering; ordinary player reordering remains forbidden. */
  deckPosition?: 'top' | 'bottom';
  cause?: 'EFFECT' | 'COMBAT' | 'PLAYER_ACTION' | 'OTHER';
  /** Explicit Rule Book p.10 player-choice removal bypasses all exit protection. */
  playerMandated?: boolean;
  /** Internal continuation after an exit window has already been resolved. */
  skipExitPrevention?: boolean;
  /** Exact payment metadata for the summon trigger (Rule Book 3.2 p.7). */
  exactGemPaid?: boolean;
}

export interface ZoneMoveResult { ok: boolean; state: GameState; reason?: string }

export function getOriginalOwnerId(card: CardInstance): string {
  return card.originalOwnerId ?? card.ownerId;
}

const ZONES: readonly PlayerZone[] = ['deck', 'hand', 'lifeDeck', 'avatarZone', 'constructZone', 'magicZone', 'hell', 'darkDimension'];

/** Changes only control; the Avatar stays on the field and keeps its card holder and attachments. */
export function changeAvatarControl(state: GameState, actorId: string, instanceId: string, controllerId: string): ZoneMoveResult {
  const invalid = validateGameState(state);
  if (invalid) return { ok: false, state, reason: invalid };
  if (state.pendingDeckChoice || state.pendingHellChoice || state.pendingDeckSearchVerification) return { ok: false, state, reason: 'A Deck operation choice is pending' };
  if (!state.players[actorId] || !state.players[controllerId]) return { ok: false, state, reason: 'Actor or new controller does not exist' };
  const sourcePlayerId = state.playerOrder.find(playerId => state.players[playerId]?.avatarZone.some(item => item.instanceId === instanceId));
  const avatar = sourcePlayerId ? state.players[sourcePlayerId].avatarZone.find(item => item.instanceId === instanceId) : undefined;
  if (!avatar || avatar.card.type !== 'Avatar') return { ok: false, state, reason: 'Control change requires an Avatar on an Avatar Zone' };
  if (sourcePlayerId === controllerId) return { ok: false, state, reason: 'Avatar is already controlled by that player' };
  const duoMember = avatar.duoWithInstanceId || state.players[sourcePlayerId].avatarZone.some(item => item.duoWithInstanceId === instanceId);
  if (avatar.controlChangeImmune || duoMember) return { ok: false, state, reason: 'Avatar cannot change control' };
  const destination = state.players[controllerId];
  const destinationZone = [...destination.avatarZone, avatar];
  const capacityError = validateAvatarZone({ avatarZone: destinationZone });
  if (capacityError) return { ok: false, state, reason: capacityError };

  const players = {
    ...state.players,
    [sourcePlayerId]: { ...state.players[sourcePlayerId], avatarZone: state.players[sourcePlayerId].avatarZone.filter(item => item.instanceId !== instanceId) },
    [controllerId]: { ...destination, avatarZone: [...destination.avatarZone, { ...avatar, originalOwnerId: getOriginalOwnerId(avatar), controllerId }] }
  };
  const next = recomputeContinuousEffects({ ...state, players });
  const error = validateGameState(next);
  if (error) return { ok: false, state, reason: error };
  return { ok: true, state: appendGameEvents(next, [{
    type: 'CONTROL_CHANGED', instanceId, ownerId: avatar.ownerId, originalOwnerId: getOriginalOwnerId(avatar),
    previousControllerId: avatar.controllerId, controllerId, actorId,
    eventId: `${state.id}:${state.gameEvents?.length ?? 0}:CONTROL_CHANGED:${instanceId}:${avatar.controllerId}:${controllerId}`
  }]) };
}

/** Moves one existing card instance atomically, preserving identity and original owner. */
export function moveCardBetweenZones(state: GameState, request: ZoneMoveRequest): ZoneMoveResult {
  const invalid = validateGameState(state);
  if (invalid) return { ok: false, state, reason: invalid };
  if (state.pendingDeckChoice || state.pendingHellChoice || state.pendingDeckSearchVerification) return { ok: false, state, reason: 'A Deck operation choice is pending' };
  if (state.pendingExitPrevention && !request.skipExitPrevention) return { ok: false, state, reason: 'Exit-prevention choice is pending' };
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
  if (request.deckPosition && (!request.effectMove || request.destination !== 'deck')) return { ok: false, state, reason: 'Only an explicit effect may set Deck position' };
  if (request.destination === 'landMagicZone' && (card.card.type !== 'Magic' || card.card.subtype !== 'Land')) return { ok: false, state, reason: 'Only Land Magic cards may enter Land Magic Zone' };
  if (request.destination === 'constructZone' && card.card.type !== 'Construct') return { ok: false, state, reason: 'Only Construct cards may enter Construct Zone' };
  if (request.destination === 'avatarZone' && card.card.type !== 'Avatar' && card.card.type !== 'Token') return { ok: false, state, reason: 'Only Avatars and Tokens may enter Avatar Zone' };
  if (request.destination === 'lifeDeck' && card.card.type !== 'Life') return { ok: false, state, reason: 'Only LIFE cards may enter LIFE Zone' };
  if (request.destination === 'deck' && card.card.type === 'Life') return { ok: false, state, reason: 'LIFE cards cannot enter the Main Deck' };
  if (request.destination === 'hand' && card.card.type === 'Life') return { ok: false, state, reason: 'LIFE cards cannot enter a hand' };
  if (request.destination === 'magicZone' && card.card.type !== 'Magic' && card.card.type !== 'Avatar') return { ok: false, state, reason: 'Only Magic cards or relocated Avatars may enter Magic Zone' };
  // Effect-driven field exits use the same protection pipeline even when a producer omits a destruction cause.
  const exitCause = request.cause ?? (request.effectMove ? 'EFFECT' : undefined);
  // Rule Book 3.2 p.10: an effect-mandated player choice bypasses every exit shield.
  if (!request.playerMandated && (exitCause === 'EFFECT' || exitCause === 'COMBAT')) {
    const prevention = preventDestruction(state, request.actorId, card.instanceId, exitCause);
    if (prevention.prevented) return { ok: true, state: prevention.state, reason: 'Destruction was prevented automatically' };
    if (!request.skipExitPrevention && (sourceZone === 'avatarZone' || sourceZone === 'constructZone') &&
      (card.card.type === 'Avatar' || card.card.type === 'Construct')) {
      const activatedShield = (card.preventionShields ?? []).find(shield => shield.kind === 'DESTRUCTION' &&
        shield.mode === 'ACTIVATED' && shield.usesRemaining !== 0 &&
        (shield.sourceControllerId ?? card!.controllerId) === card!.controllerId);
      if (activatedShield) {
        const revision = (state.stateRevision ?? 0) + 1;
        const pending: PendingExitPrevention = {
          targetCardId: card.instanceId, destination: request.destination, destinationPlayerId: request.destinationPlayerId,
          actorId: request.actorId, preventionPlayerId: activatedShield.sourceControllerId ?? card.controllerId,
          effectMove: request.effectMove, deckPosition: request.deckPosition, cause: exitCause,
          expectedRevision: revision, usedActivatedPrevention: false
        };
        return { ok: true, state: { ...state, stateRevision: revision, pendingExitPrevention: pending }, reason: 'Exit-prevention choice is pending' };
      }
    }
  }
  const originalOwnerId = getOriginalOwnerId(card);
  const destinationPlayerId = request.destinationPlayerId ?? originalOwnerId;
  if (request.destination !== 'landMagicZone' && request.destination !== 'removedFromGame' && !state.players[destinationPlayerId]) {
    return { ok: false, state, reason: 'Destination player does not exist' };
  }
  if ((request.destination === 'hell' || request.destination === 'hand' || request.destination === 'deck' || request.destination === 'darkDimension') && destinationPlayerId !== originalOwnerId) {
    return { ok: false, state, reason: 'Card must return to its original owner’s destination zone' };
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
  const destinationCard: CardInstance = {
    ...card,
    originalOwnerId,
    ...(request.destination === 'avatarZone' ? {
      controllerId: destinationPlayerId,
      ...(sourceZone === 'magicZone' ? { isFaceUp: true, isRested: false, layerModifiers: [] } : {})
    } : {}),
    ...(sourceZone === 'avatarZone' && request.destination !== 'avatarZone' && card.duoWithInstanceId ? { duoWithInstanceId: undefined, controlChangeImmune: false } : {}),
    ...(attachmentsLeaveWithAvatar && card.attachedInstances.length > 0 ? { attachedInstances: [] } : {})
  };
  if (sourcePlayerId && sourceZone) {
    players[sourcePlayerId] = { ...players[sourcePlayerId], [sourceZone]: players[sourcePlayerId][sourceZone].filter(item => item.instanceId !== card!.instanceId) };
  }
  let landMagicZone = isLand ? null : state.landMagicZone;
  const replacedLand = request.destination === 'landMagicZone' && landMagicZone?.instanceId !== card.instanceId ? landMagicZone : null;
  if (replacedLand) {
    const landOwner = players[getOriginalOwnerId(replacedLand)];
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
    if (request.destination === 'avatarZone') {
      const err = validateAvatarZone({ avatarZone: [...currentZone, destinationCard] });
      if (err) return { ok: false, state, reason: err };
    }
    const destinationCards = request.destination === 'deck' && request.deckPosition === 'top'
      ? [destinationCard, ...currentZone]
      : [...currentZone, destinationCard];
    players[destinationPlayerId] = { ...destinationPlayer, [request.destination]: destinationCards };
  }
  for (const attached of detachedAttachments) {
    const owner = players[getOriginalOwnerId(attached)];
    if (!owner) return { ok: false, state, reason: 'Attached card owner does not exist' };
    if (request.destination !== 'removedFromGame') {
      players[owner.id] = { ...owner, hell: [...owner.hell, attached] };
    }
  }
  if (sourceZone === 'avatarZone' && request.destination !== 'avatarZone' && card.duoWithInstanceId) {
    for (const playerId of Object.keys(players)) {
      const player = players[playerId];
      players[playerId] = { ...player, avatarZone: player.avatarZone.map(avatar => avatar.instanceId === card!.duoWithInstanceId
        ? { ...avatar, duoWithInstanceId: undefined, controlChangeImmune: false }
        : avatar) };
    }
  }
  const next = recomputeContinuousEffects({ ...state, players, landMagicZone });
  const error = validateGameState(next);
  if (error) return { ok: false, state, reason: error };
  const privateSource = sourceZone === 'deck' || sourceZone === 'hand' || (sourceZone === 'lifeDeck' && !card.isFaceUp);
  const publicDestination = request.destination === 'landMagicZone' || request.destination === 'avatarZone' || request.destination === 'constructZone' || request.destination === 'magicZone' ||
    request.destination === 'hell' || request.destination === 'darkDimension';
  const exposeIdentity = !privateSource || publicDestination;
  events.push({
    type: 'CARD_MOVED',
    ...(exposeIdentity ? { instanceId: card.instanceId } : {}),
    ownerId: destinationCard.ownerId,
    controllerId: destinationCard.controllerId,
    from: isLand ? 'landMagicZone' : `${sourcePlayerId}:${sourceZone}`,
    to: request.destination === 'landMagicZone' ? 'landMagicZone' : request.destination === 'removedFromGame' ? 'removedFromGame' : `${destinationPlayerId}:${request.destination}`,
    actorId: request.actorId,
    eventId: `${state.id}:${(state.gameEvents?.length ?? 0) + events.length}:CARD_MOVED:${exposeIdentity ? card.instanceId : 'hidden'}:${sourcePlayerId ?? 'shared'}:${sourceZone ?? 'landMagicZone'}:${destinationPlayerId ?? 'shared'}:${request.destination}:${request.actorId}`
  });
  detachedAttachments.forEach((attached, index) => {
    events.push({
      type: 'CARD_MOVED', instanceId: attached.instanceId, ownerId: attached.ownerId,
      controllerId: attached.controllerId, from: `${sourcePlayerId}:attached`,
      to: request.destination === 'removedFromGame' ? 'removedFromGame' : `${getOriginalOwnerId(attached)}:hell`,
      actorId: request.actorId,
      eventId: `${state.id}:${state.gameEvents?.length ?? 0}:attached:${index}:${attached.instanceId}:${request.destination}:${request.actorId}`
    });
    events.push({
      type: 'CARD_LEFT_FIELD', instanceId: attached.instanceId, ownerId: getOriginalOwnerId(attached),
      controllerId: attached.controllerId, actorId: request.actorId,
      eventId: `${state.id}:${state.gameEvents?.length ?? 0}:attached-left-field:${index}:${attached.instanceId}:${request.destination}`
    });
  });
  if (sourceZone === 'constructZone' && sourcePlayerId) events.push({
    type: 'CONSTRUCT_LEFT', instanceId: card.instanceId, name: card.card.name, playerId: sourcePlayerId,
    eventId: `${state.id}:${state.gameEvents?.length ?? 0}:construct-left:${card.instanceId}:${sourcePlayerId}`
  });
  if (request.destination === 'constructZone') events.push({
    type: 'CONSTRUCT_ENTERED', instanceId: card.instanceId, name: card.card.name, playerId: destinationPlayerId,
    eventId: `${state.id}:${state.gameEvents?.length ?? 0}:construct-entered:${card.instanceId}:${destinationPlayerId}`
  });
  if (request.destination === 'avatarZone' && card.card.type === 'Avatar') events.push({
    type: 'AVATAR_SUMMONED', instanceId: card.instanceId, playerId: destinationPlayerId,
    exactGemPaid: request.exactGemPaid ?? false,
    eventId: `${state.id}:${state.gameEvents?.length ?? 0}:avatar-summoned:${card.instanceId}:${destinationPlayerId}`
  });
  if (request.destination === 'avatarZone' && card.card.type === 'Token') events.push({
    type: 'TOKEN_CREATED', instanceId: card.instanceId, playerId: destinationPlayerId,
    eventId: `${state.id}:${state.gameEvents?.length ?? 0}:token-created:${card.instanceId}:${destinationPlayerId}`
  });
  if (sourceZone === 'deck' && request.destination === 'hand') events.push({
    type: 'CARD_DRAWN', instanceId: card.instanceId, playerId: destinationPlayerId, actorId: request.actorId,
    eventId: `${state.id}:${state.gameEvents?.length ?? 0}:card-drawn:${card.instanceId}:${request.actorId}`
  });
  if (sourceZone === 'hand' && request.destination === 'hell') events.push({
    type: 'CARD_DISCARDED', instanceId: card.instanceId, playerId: sourcePlayerId!, actorId: request.actorId,
    eventId: `${state.id}:${state.gameEvents?.length ?? 0}:card-discarded:${card.instanceId}:${request.actorId}`
  });
  if (card.card.type === 'Magic' && card.card.subtype && sourceZone === 'hand' && request.destination === 'magicZone') events.push({
    type: 'MAGIC_PLAYED', instanceId: card.instanceId, subtype: card.card.subtype, playerId: request.actorId,
    eventId: `${state.id}:${state.gameEvents?.length ?? 0}:magic-played:${card.instanceId}:${request.actorId}`
  });
  const leavesAvatarField = sourceZone === 'avatarZone' && request.destination !== 'avatarZone' && request.destination !== 'magicZone';
  const leavesOtherFieldZone = (sourceZone === 'constructZone' || sourceZone === 'magicZone') && request.destination !== sourceZone;
  if (leavesAvatarField || leavesOtherFieldZone) events.push({
    type: 'CARD_LEFT_FIELD', instanceId: card.instanceId, ownerId: originalOwnerId,
    controllerId: card.controllerId, actorId: request.actorId,
    eventId: `${state.id}:${state.gameEvents?.length ?? 0}:card-left-field:${card.instanceId}:${request.destination}`
  });
  if (sourceZone === 'avatarZone' && card.card.type === 'Avatar' && request.destination === 'hell' &&
    (exitCause === 'EFFECT' || exitCause === 'COMBAT')) events.push({
    type: 'AVATAR_DESTROYED', instanceId: card.instanceId, ownerId: originalOwnerId,
    controllerId: card.controllerId, actorId: request.actorId,
    eventId: `${state.id}:${state.gameEvents?.length ?? 0}:avatar-destroyed:${card.instanceId}:${request.actorId}`
  });
  if (sourceZone === 'avatarZone' && card.card.type === 'Token' && request.destination === 'removedFromGame') events.push({
    type: 'TOKEN_DESTROYED', instanceId: card.instanceId, playerId: sourcePlayerId!,
    eventId: `${state.id}:${state.gameEvents?.length ?? 0}:token-destroyed:${card.instanceId}`
  });
  return { ok: true, state: appendGameEvents(next, events) };
}

export interface GemPaidPlayResult extends ZoneMoveResult {
  exactGemPaid?: boolean;
}

/** Completes one Cost Step followed by one Avatar Summon or Construct Build (Rule Book 3.2 pp.6–7, 17). */
export function payGemAndPlayFromHand(
  state: GameState,
  actorId: string,
  targetInstanceId: string,
  paymentInstanceIds: string[],
  requiredCost?: number
): GemPaidPlayResult {
  const player = state.players[actorId];
  if (!player || state.playerOrder[state.currentTurnPlayerIndex] !== actorId || state.currentPhase !== 'MAIN') {
    return { ok: false, state, reason: 'GEM payment requires the active player in Main Phase' };
  }
  const target = player.hand.find(card => card.instanceId === targetInstanceId);
  if (!target || (target.card.type !== 'Avatar' && target.card.type !== 'Construct')) {
    return { ok: false, state, reason: 'GEM payment requires an Avatar or Construct in hand' };
  }
  const cost = requiredCost ?? target.card.cost;
  const payment = validateGemPayment(player.hand, target, paymentInstanceIds, cost);
  if (!payment.valid) return { ok: false, state, reason: 'Invalid GEM payment' };

  const paidCards = player.hand.filter(card => paymentInstanceIds.includes(card.instanceId));
  const paidIds = new Set(paymentInstanceIds);
  const players = { ...state.players, [actorId]: { ...player, hand: player.hand.filter(card => !paidIds.has(card.instanceId)) } };
  for (const card of paidCards) {
    const ownerId = getOriginalOwnerId(card);
    if (!players[ownerId]) return { ok: false, state, reason: 'GEM card owner does not exist' };
    players[ownerId] = { ...players[ownerId], hell: [...players[ownerId].hell, { ...card, originalOwnerId: ownerId }] };
  }
  const afterCostStep: GameState = { ...state, players };
  const result = moveCardBetweenZones(afterCostStep, {
    instanceId: targetInstanceId, actorId,
    destination: target.card.type === 'Avatar' ? 'avatarZone' : 'constructZone',
    destinationPlayerId: actorId,
    exactGemPaid: payment.exactGemPaid
  });
  if (!result.ok) return { ok: false, state, reason: result.reason };
  return { ...result, exactGemPaid: payment.exactGemPaid };
}

export function resolveExitPreventionChainEntry(state: GameState, targetCardId: string, prevented: boolean): ZoneMoveResult {
  const pending = state.pendingExitPrevention;
  if (!pending || pending.targetCardId !== targetCardId || !pending.usedActivatedPrevention) {
    return { ok: false, state, reason: 'No matching exit-prevention chain entry' };
  }
  if (prevented) {
    const attemptKey = `${state.id}:${pending.expectedRevision}:${pending.targetCardId}`;
    const { pendingExitPrevention: _pending, ...cleared } = state;
    return { ok: true, state: {
      ...cleared,
      stateRevision: pending.expectedRevision + 1,
      preventionAttempts: [...(state.preventionAttempts ?? []), attemptKey]
    } };
  }
  const { pendingExitPrevention: _pending, ...cleared } = state;
  const moved = moveCardBetweenZones({ ...cleared, stateRevision: pending.expectedRevision }, {
    instanceId: pending.targetCardId, actorId: pending.actorId, destination: pending.destination,
    destinationPlayerId: pending.destinationPlayerId, effectMove: pending.effectMove,
    deckPosition: pending.deckPosition, cause: pending.cause, skipExitPrevention: true
  });
  return moved.ok ? { ...moved, state: { ...moved.state, stateRevision: pending.expectedRevision + 1 } } : moved;
}

export function declineExitPrevention(state: GameState, playerId: string, expectedRevision = state.stateRevision): ZoneMoveResult {
  const pending = state.pendingExitPrevention;
  if (!pending || pending.preventionPlayerId !== playerId || pending.usedActivatedPrevention ||
    expectedRevision !== state.stateRevision || pending.expectedRevision !== expectedRevision) {
    return { ok: false, state, reason: 'No current exit-prevention choice for this player' };
  }
  const { pendingExitPrevention: _pending, ...cleared } = state;
  return moveCardBetweenZones({ ...cleared, stateRevision: pending.expectedRevision }, {
    instanceId: pending.targetCardId, actorId: pending.actorId, destination: pending.destination,
    destinationPlayerId: pending.destinationPlayerId, effectMove: pending.effectMove,
    deckPosition: pending.deckPosition, cause: pending.cause, skipExitPrevention: true
  });
}

export function useExitPrevention(state: GameState, playerId: string, sourceCardId: string): ZoneMoveResult {
  const pending = state.pendingExitPrevention;
  if (!pending || pending.preventionPlayerId !== playerId || pending.usedActivatedPrevention ||
    pending.expectedRevision !== state.stateRevision || state.reactionWindow) return { ok: false, state, reason: 'No current exit-prevention choice for this player' };
  const targetPlayer = Object.values(state.players).find(player =>
    player.avatarZone.some(card => card.instanceId === pending.targetCardId) ||
    player.constructZone.some(card => card.instanceId === pending.targetCardId));
  const target = targetPlayer && [...targetPlayer.avatarZone, ...targetPlayer.constructZone].find(card => card.instanceId === pending.targetCardId);
  const shield = target?.preventionShields?.find(item => item.id === sourceCardId && item.kind === 'DESTRUCTION' && item.mode === 'ACTIVATED' && item.usesRemaining !== 0);
  if (!target || !shield || (shield.sourceControllerId ?? target.controllerId) !== playerId) {
    return { ok: false, state, reason: 'No eligible activated exit-prevention ability' };
  }
  const shields = target.preventionShields ?? [];
  const nextShields = shield.usesRemaining === undefined ? shields
    : shield.usesRemaining <= 1 ? shields.filter(item => item.id !== shield.id)
      : shields.map(item => item.id === shield.id ? { ...item, usesRemaining: item.usesRemaining - 1 } : item);
  const ownerEntry = Object.entries(state.players).find(([, player]) =>
    player.avatarZone.some(card => card.instanceId === target.instanceId) || player.constructZone.some(card => card.instanceId === target.instanceId));
  if (!ownerEntry) return { ok: false, state, reason: 'Exit target left the field' };
  const [ownerId, owner] = ownerEntry;
  const zone = owner.avatarZone.some(card => card.instanceId === target.instanceId) ? 'avatarZone' : 'constructZone';
  const nextPlayers = { ...state.players, [ownerId]: { ...owner, [zone]: owner[zone].map(card =>
    card.instanceId === target.instanceId ? { ...card, preventionShields: nextShields } : card) } };
  const activePlayerId = state.playerOrder[state.currentTurnPlayerIndex];
  const opponentPlayerId = state.playerOrder.find(id => id !== activePlayerId);
  if (!activePlayerId || !opponentPlayerId) return { ok: false, state, reason: 'Exit prevention requires a supported Duel Reaction Window' };
  const sequence = (state.reactionSequence ?? 0) + 1;
  const trigger = { type: 'ABILITY_USED' as const, actorId: playerId, targetInstanceId: sourceCardId, sourceInstanceId: sourceCardId };
  const chainEntry = {
    entryType: 'ACTIVATED_ABILITY' as const,
    sourceCardId,
    controllerId: playerId,
    triggerId: `exit-prevention:${pending.targetCardId}:${sourceCardId}`,
    effects: [],
    cancelled: false,
    eventId: `${state.id}:${pending.expectedRevision}:exit-prevention:${pending.targetCardId}`,
    respondedTo: trigger,
    exitPreventionTargetId: pending.targetCardId
  };
  const nextRevision = pending.expectedRevision + 1;
  return { ok: true, state: {
    ...state,
    players: nextPlayers,
    stateRevision: nextRevision,
    pendingExitPrevention: { ...pending, expectedRevision: nextRevision, usedActivatedPrevention: true },
    reactionSequence: sequence,
    reactionWindow: {
      id: `${state.id}:${sequence}:ABILITY_USED`,
      trigger,
      turnOwnerId: activePlayerId,
      priorityPlayerId: opponentPlayerId,
      passedPlayerIds: [],
      priorityOrder: [opponentPlayerId, activePlayerId],
      chain: [chainEntry],
      revision: 0
    }
  } };
}

export function beginEndPhaseDiscard(state: GameState, playerId: string): ZoneMoveResult {
  const player = state.players[playerId];
  if (!player || state.currentPhase !== 'END' || state.playerOrder[state.currentTurnPlayerIndex] !== playerId) {
    return { ok: false, state, reason: 'Only the active player may begin End Phase discard selection' };
  }
  if (state.pendingEndPhaseDiscardPlayerId || state.pendingDeckChoice || state.pendingHellChoice || state.pendingDeckSearchVerification || player.hand.length <= 7) {
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
  if (!player || state.pendingDeckChoice || state.pendingHellChoice || state.pendingDeckSearchVerification || state.pendingEndPhaseDiscardPlayerId !== playerId || state.currentPhase !== 'END' ||
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
