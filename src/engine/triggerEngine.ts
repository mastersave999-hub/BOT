import type { EffectDefinition } from './effectResolver';
import { resolveEffectPlan } from './effectResolver';
import type { GameEvent } from './gameEvents';
import type { CardInstance, GameState } from './types';

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
  for (const player of Object.values(state.players)) {
    [...player.avatarZone, ...player.constructZone, ...player.magicZone].forEach(visit);
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
