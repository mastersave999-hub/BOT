import type { EffectDefinition } from './effectResolver';
import { resolveEffectPlan } from './effectResolver';
import type { GameEvent } from './gameEvents';
import type { CardInstance, GameState, ReactionTrigger } from './types';

export type TriggerFrequency = 'EACH_EVENT' | 'ONCE_PER_TURN';

export interface TriggerAbility {
  id: string;
  eventType: GameEvent['type'];
  frequency?: TriggerFrequency;
  /** Optional predicates keep trigger matching typed; card text is never parsed here. */
  sourceInstanceId?: string;
  effects: EffectDefinition[];
}

export interface TriggerMatch {
  ability: TriggerAbility;
  source: CardInstance;
  controllerId: string;
  event: GameEvent;
}

export interface TriggerResolution {
  ok: boolean;
  state: GameState;
  resolved: string[];
  pending: TriggerMatch[];
  reason?: string;
}

function allFieldCards(state: GameState): CardInstance[] {
  const cards: CardInstance[] = [];
  const visit = (card: CardInstance) => {
    cards.push(card);
    card.attachedInstances.forEach(visit);
  };
  for (const playerId of state.playerOrder) {
    const player = state.players[playerId];
    if (player) [...player.avatarZone, ...player.constructZone, ...player.magicZone].forEach(visit);
  }
  if (state.landMagicZone) visit(state.landMagicZone);
  return cards;
}

/** Discovers explicitly-declared structured triggers from the immutable event snapshot. */
export function collectTriggers(state: GameState, event: GameEvent): TriggerMatch[] {
  return allFieldCards(state).flatMap(source => (source.triggerAbilities ?? [])
    .filter(ability => ability.eventType === event.type && (!ability.sourceInstanceId || ability.sourceInstanceId === source.instanceId))
    .map(ability => ({ ability, source, controllerId: source.controllerId, event })));
}

function reactionTriggerForEvent(state: GameState, event: GameEvent): ReactionTrigger | undefined {
  const actorId: string | undefined = 'playerId' in event && typeof event.playerId === 'string' ? event.playerId :
    'actorId' in event && typeof event.actorId === 'string' ? event.actorId :
      'controllerId' in event && typeof event.controllerId === 'string' ? event.controllerId : undefined;
  if (!actorId || !state.players[actorId]) return undefined;
  if (event.type === 'AVATAR_SUMMONED') return { type: 'AVATAR_SUMMONED', actorId, targetInstanceId: event.instanceId };
  if (event.type === 'ATTACK_DECLARED') return { type: 'ATTACK_DECLARED', actorId, targetInstanceId: event.targetId };
  if (event.type === 'MAGIC_PLAYED') return { type: 'MAGIC_PLAYED', actorId, sourceInstanceId: event.instanceId };
  if (event.type === 'AVATAR_DESTROYED') return { type: 'AVATAR_DESTROYED', actorId, targetInstanceId: event.instanceId };
  if (event.type === 'PHASE_STARTED' || event.type === 'PHASE_ENDED') return { type: 'BEFORE_PHASE_CHANGE', actorId };
  return { type: 'ABILITY_USED', actorId };
}

/** Queues a deterministic event snapshot as a cancelable LIFO trigger chain. */
export function dispatchTriggersForEvent(state: GameState, event: GameEvent): GameState {
  if (state.processedTriggerEventIds?.includes(event.eventId)) return state;
  const matches = collectTriggers(state, event);
  if (matches.length === 0) return {
    ...state,
    processedTriggerEventIds: [...(state.processedTriggerEventIds ?? []), event.eventId]
  };
  if (matches.length > 64) return state;
  const activePlayerId = state.playerOrder[state.currentTurnPlayerIndex];
  const controllerRank = new Map([activePlayerId, ...state.playerOrder.filter(id => id !== activePlayerId)]
    .map((id, index) => [id, index]));
  const ordered = matches.map((match, index) => ({ match, index })).sort((a, b) =>
    (controllerRank.get(a.match.controllerId) ?? Number.MAX_SAFE_INTEGER) - (controllerRank.get(b.match.controllerId) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index
  );
  const actorTrigger = reactionTriggerForEvent(state, event);
  if (!actorTrigger) return state;
  const fresh = ordered.filter(({ match }) => {
    const key = `${state.turnNumber}:${match.controllerId}:${match.source.instanceId}:${match.ability.id}`;
    return !state.triggerUsage?.includes(key) && (state.triggerLoopCounts?.[key] ?? 0) < 64;
  });
  if (!fresh.length) return { ...state, processedTriggerEventIds: [...(state.processedTriggerEventIds ?? []), event.eventId] };
  const additions = [...fresh].reverse().map(({ match }) => ({
    entryType: 'TRIGGER_ABILITY' as const,
    sourceCardId: match.source.instanceId,
    controllerId: match.controllerId,
    triggerId: `${match.source.instanceId}:${match.ability.id}`,
    effects: match.ability.effects,
    cancelled: false,
    eventId: event.eventId,
    respondedTo: { ...actorTrigger, targetInstanceId: match.source.instanceId }
  }));
  const existingWindow = state.reactionWindow;
  const turnOwnerId = state.playerOrder[state.currentTurnPlayerIndex];
  if (!turnOwnerId || state.playerOrder.length !== 2) return state;
  const opponent = state.playerOrder.find(id => id !== turnOwnerId);
  if (!opponent) return state;
  const nextSequence = (state.reactionSequence ?? 0) + Number(!existingWindow);
  const reactionWindow = existingWindow
    ? { ...existingWindow, chain: [...(existingWindow.chain ?? []), ...additions], revision: (existingWindow.revision ?? 0) + 1 }
    : {
        id: `${state.id}:${nextSequence}:trigger:${event.eventId}`,
        trigger: actorTrigger,
        turnOwnerId,
        priorityPlayerId: opponent,
        passedPlayerIds: [],
        priorityOrder: [opponent, turnOwnerId],
        chain: additions,
        revision: 0
      };
  const usageKeys = fresh.filter(({ match }) => match.ability.frequency === 'ONCE_PER_TURN').map(({ match }) =>
    `${state.turnNumber}:${match.controllerId}:${match.source.instanceId}:${match.ability.id}`);
  const triggerLoopCounts = { ...(state.triggerLoopCounts ?? {}) };
  for (const { match } of fresh) {
    const key = `${state.turnNumber}:${match.controllerId}:${match.source.instanceId}:${match.ability.id}`;
    triggerLoopCounts[key] = (triggerLoopCounts[key] ?? 0) + 1;
  }
  return {
    ...state,
    reactionSequence: nextSequence,
    reactionWindow,
    triggerLoopCounts,
    triggerUsage: [...(state.triggerUsage ?? []), ...usageKeys],
    processedTriggerEventIds: [...(state.processedTriggerEventIds ?? []), event.eventId]
  };
}

/**
 * Resolves a finite snapshot. Same-controller simultaneous triggers follow the supplied
 * controller order (the controller chooses the order); otherwise deterministic active-player
 * first ordering is used as a documented Duel implementation convention.
 */
export function resolveTriggeredEvent(
  state: GameState,
  event: GameEvent,
  controllerOrder?: string[],
  triggerOrder?: string[]
): TriggerResolution {
  if (state.reactionWindow) return { ok: false, state, resolved: [], pending: [], reason: 'Resolve the open Reaction Window before queued triggers' };
  if (state.processedTriggerEventIds?.includes(event.eventId)) return { ok: true, state, resolved: [], pending: [] };
  const turnPlayerId = state.playerOrder[state.currentTurnPlayerIndex];
  const rank = new Map((controllerOrder?.length ? controllerOrder : [turnPlayerId, ...state.playerOrder.filter(id => id !== turnPlayerId)]).map((id, index) => [id, index]));
  const abilityRank = new Map((triggerOrder ?? []).map((id, index) => [id, index]));
  const matches = collectTriggers(state, event).sort((a, b) =>
    (rank.get(a.controllerId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.controllerId) ?? Number.MAX_SAFE_INTEGER) ||
    (abilityRank.get(`${a.source.instanceId}:${a.ability.id}`) ?? Number.MAX_SAFE_INTEGER) - (abilityRank.get(`${b.source.instanceId}:${b.ability.id}`) ?? Number.MAX_SAFE_INTEGER));
  if (matches.length > 64) return { ok: false, state, resolved: [], pending: matches, reason: 'Trigger recursion/volume limit exceeded' };
  let current = state;
  const resolved: string[] = [];
  for (const match of matches) {
    const { ability, source, controllerId } = match;
    const usageKey = `${state.turnNumber}:${controllerId}:${source.instanceId}:${ability.id}`;
    if (ability.frequency === 'ONCE_PER_TURN' && current.triggerUsage?.includes(usageKey)) continue;
    if (!current.players[controllerId] || ability.effects.length === 0) {
      return { ok: false, state, resolved: [], pending: matches, reason: 'Trigger has no valid controller or effects' };
    }
    const result = resolveEffectPlan(current, { actorId: controllerId, effects: ability.effects });
    if (!result.ok) return { ok: false, state, resolved: [], pending: matches, reason: result.reason ?? 'Trigger resolution failed' };
    current = result.state;
    if (ability.frequency === 'ONCE_PER_TURN') current = {
      ...current,
      triggerUsage: [...(current.triggerUsage ?? []), usageKey]
    };
    resolved.push(`${source.instanceId}:${ability.id}`);
  }
  current = { ...current, processedTriggerEventIds: [...(current.processedTriggerEventIds ?? []), event.eventId] };
  return { ok: true, state: current, resolved, pending: [] };
}
