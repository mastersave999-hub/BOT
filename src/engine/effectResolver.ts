import type { CardInstance, GameState } from './types';
import { changeAvatarControl, getOriginalOwnerId, moveCardBetweenZones, validateGameState } from './gameRules';
import { runGameTransaction } from './gameTransaction';
import { preventTargeting } from './prevention';
import { appendGameEvents } from './gameEvents';
import { recomputeContinuousEffects } from './continuousEffects';

export type EffectCondition =
  | { kind: 'player_has_avatar'; playerId: string; nameIncludes: string }
  | { kind: 'target_exists'; targetId: string };

export type EffectCost =
  | { kind: 'discard_from_hand'; playerId: string; instanceIds: string[] }
  | { kind: 'sacrifice_avatar'; playerId: string; instanceId: string };

export type EffectDefinition =
  | { kind: 'draw'; playerId: string; count: number }
  | { kind: 'modify_power'; targetId: string; amount: number; layer?: 1 | 2 | 4; expiresAt?: 'END_OF_TURN' | 'END_OF_BATTLE' | 'DRAW_PHASE' }
  | { kind: 'set_power'; targetId: string; value: number; layer: 1 | 2 | 4; expiresAt?: 'END_OF_TURN' | 'END_OF_BATTLE' | 'DRAW_PHASE' }
  | { kind: 'change_symbol'; targetId: string; symbol: string; layer: 1 | 2; expiresAt?: 'END_OF_TURN' | 'END_OF_BATTLE' | 'DRAW_PHASE' }
  | { kind: 'flip_life'; playerId: string; face: 'up' | 'down'; count: number; allowWhileCritical?: boolean }
  | { kind: 'search_to_hand'; playerId: string; instanceIds: string[]; name: string; matching: 'DELIMITED_WORD_SEQUENCE' | 'EXACT_CARD_NAME'; cardType: string; shuffle: boolean }
  | { kind: 'reset_power'; targetId: string }
  | { kind: 'destroy_avatar'; targetId: string }
  | { kind: 'bounce_avatar'; targetId: string }
  | { kind: 'banish_avatar'; targetId: string }
  | { kind: 'mill'; playerId: string; count: number }
  | { kind: 'destroy_opponent_avatars'; actorId: string }
  | { kind: 'recover_from_hell'; playerId: string; count: number; destination: 'deck' | 'hand' }
  | { kind: 'summon_from_hell'; playerId: string; instanceId: string }
  | { kind: 'change_avatar_control'; targetId: string; controllerId: string }
  | { kind: 'cancel_chain_entry'; targetId: string };

export type EffectPlanStep = { kind: 'cost'; cost: EffectCost } | { kind: 'effect'; effect: EffectDefinition };

export interface EffectPlan {
  actorId: string;
  conditions?: EffectCondition[];
  costs?: EffectCost[];
  effects: EffectDefinition[];
  /** When present, resolves clause costs and effects in source order within one atomic transaction. */
  sequence?: EffectPlanStep[];
}

export interface EffectResolution {
  ok: boolean;
  state: GameState;
  logs: string[];
  reason?: string;
}

export interface EffectHandlerContext {
  state: GameState;
  plan: EffectPlan;
  effect: EffectDefinition;
}

export type EffectHandler = (context: EffectHandlerContext) => GameState | null;

const fail = (state: GameState, reason: string): EffectResolution => ({ ok: false, state, logs: [], reason });

function findAvatar(state: GameState, instanceId: string): { playerId: string; avatar: CardInstance } | undefined {
  for (const playerId of state.playerOrder) {
    const avatar = state.players[playerId]?.avatarZone.find(item => item.instanceId === instanceId);
    if (avatar) return { playerId, avatar };
  }
  return undefined;
}

function applyCost(state: GameState, cost: EffectCost): GameState | null {
  const player = state.players[cost.playerId];
  if (!player) return null;
  if (cost.kind === 'discard_from_hand') {
    if (cost.instanceIds.length === 0 || new Set(cost.instanceIds).size !== cost.instanceIds.length ||
      cost.instanceIds.some(id => !player.hand.some(card => card.instanceId === id))) return null;
    let next = state;
    for (const instanceId of cost.instanceIds) {
      const card = player.hand.find(item => item.instanceId === instanceId);
      if (!card) return null;
      const moved = moveCardBetweenZones(next, {
        instanceId, actorId: cost.playerId, destination: 'hell', destinationPlayerId: getOriginalOwnerId(card), effectMove: true
      });
      if (!moved.ok) return null;
      next = moved.state;
    }
    return next;
  }
  const avatar = player.avatarZone.find(item => item.instanceId === cost.instanceId);
  if (!avatar) return null;
  const moved = moveCardBetweenZones(state, {
    instanceId: avatar.instanceId, actorId: cost.playerId, destination: 'hell', destinationPlayerId: getOriginalOwnerId(avatar), effectMove: true
  });
  if (!moved.ok) return null;
  return moved.state;
}

function matchesExpectedName(cardName: string, name: string, matching: 'DELIMITED_WORD_SEQUENCE' | 'EXACT_CARD_NAME'): boolean {
  if (matching === 'EXACT_CARD_NAME') return cardName.trim() === name;
  const escaped = name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s\\p{P}])${escaped}(?=$|[\\s\\p{P}])`, 'u').test(cardName);
}

function deterministicRandom(seedText: string): () => number {
  let seed = 2166136261;
  for (const char of seedText) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

const defaultHandlers: Record<EffectDefinition['kind'], EffectHandler> = {
  draw: ({ state, plan, effect }) => {
    if (effect.kind !== 'draw' || !Number.isInteger(effect.count) || effect.count < 0) return null;
    const player = state.players[effect.playerId];
    if (!player) return null;
    const deck = player.deck.filter(card => card.card.type !== 'Life');
    if (deck.length < effect.count) return null;
    let next = state;
    for (const card of deck.slice(0, effect.count)) {
      const moved = moveCardBetweenZones(next, {
        instanceId: card.instanceId, actorId: plan.actorId, destination: 'hand',
        destinationPlayerId: effect.playerId, effectMove: true
      });
      if (!moved.ok) return null;
      next = moved.state;
      const recipient = next.players[effect.playerId];
      next = { ...next, players: { ...next.players, [effect.playerId]: {
        ...recipient, hand: recipient.hand.map(item => item.instanceId === card.instanceId ? { ...item, isFaceUp: true } : item)
      } } };
    }
    return next;
  },
  modify_power: ({ state, plan, effect }) => {
    if (effect.kind !== 'modify_power' || !Number.isFinite(effect.amount)) return null;
    const found = findAvatar(state, effect.targetId);
    if (!found) return null;
    const targeting = preventTargeting(state, plan.actorId, effect.targetId);
    if (targeting.prevented) return targeting.state;
    const player = state.players[found.playerId];
    const avatarZone = player.avatarZone.map(avatar => avatar.instanceId !== effect.targetId ? avatar : {
      ...avatar,
      layerModifiers: [...avatar.layerModifiers, {
        layer: effect.layer ?? 1, powerMod: effect.amount, sourceCardId: `effect-${effect.targetId}-${state.eventLog.length}`,
        expiresAt: effect.expiresAt ?? 'END_OF_TURN'
      }]
    });
    return { ...state, players: { ...state.players, [found.playerId]: { ...player, avatarZone } } };
  },
  set_power: ({ state, plan, effect }) => {
    if (effect.kind !== 'set_power' || !Number.isFinite(effect.value)) return null;
    const found = findAvatar(state, effect.targetId);
    if (!found) return null;
    const targeting = preventTargeting(state, plan.actorId, effect.targetId);
    if (targeting.prevented) return targeting.state;
    const player = state.players[found.playerId];
    const avatarZone = player.avatarZone.map(avatar => avatar.instanceId !== effect.targetId ? avatar : {
      ...avatar,
      layerModifiers: [...avatar.layerModifiers, {
        layer: effect.layer, powerMod: 0, powerSet: effect.value,
        sourceCardId: `effect-${effect.targetId}-${state.eventLog.length}`,
        expiresAt: effect.expiresAt ?? 'END_OF_TURN'
      }]
    });
    return { ...state, players: { ...state.players, [found.playerId]: { ...player, avatarZone } } };
  },
  change_symbol: ({ state, plan, effect }) => {
    if (effect.kind !== 'change_symbol' || !effect.symbol.trim()) return null;
    const found = findAvatar(state, effect.targetId);
    if (!found) return null;
    const targeting = preventTargeting(state, plan.actorId, effect.targetId);
    if (targeting.prevented) return targeting.state;
    const player = state.players[found.playerId];
    const avatarZone = player.avatarZone.map(avatar => avatar.instanceId !== effect.targetId ? avatar : {
      ...avatar,
      layerModifiers: [...avatar.layerModifiers, {
        layer: effect.layer, powerMod: 0, symbolMod: effect.symbol,
        sourceCardId: `effect-symbol-${effect.targetId}-${state.eventLog.length}`,
        expiresAt: effect.expiresAt ?? 'END_OF_TURN'
      }]
    });
    return recomputeContinuousEffects({ ...state, players: { ...state.players, [found.playerId]: { ...player, avatarZone } } });
  },
  flip_life: ({ state, plan, effect }) => {
    if (effect.kind !== 'flip_life' || !Number.isSafeInteger(effect.count) || effect.count < 1) return null;
    const player = state.players[effect.playerId];
    if (!player || (effect.face === 'down' && player.isCritical && !effect.allowWhileCritical)) return null;
    const eligible = player.lifeDeck.filter(card => card.isFaceUp !== (effect.face === 'up'));
    if (eligible.length < effect.count) return null;
    const selected = eligible.slice(0, effect.count);
    const selectedIds = new Set(selected.map(card => card.instanceId));
    const next = { ...state, players: { ...state.players, [effect.playerId]: {
      ...player, lifeDeck: player.lifeDeck.map(card => selectedIds.has(card.instanceId)
        ? { ...card, isFaceUp: effect.face === 'up' } : card)
    } } };
    return effect.face === 'up' ? appendGameEvents(next, selected.map((card, index) => ({
      type: 'LIFE_REVEALED' as const, instanceId: card.instanceId, playerId: effect.playerId,
      actorId: plan.actorId, eventId: `${state.id}:${state.gameEvents?.length ?? 0}:life-revealed:${card.instanceId}:${index}`
    }))) : next;
  },
  search_to_hand: ({ state, plan, effect }) => {
    if (effect.kind !== 'search_to_hand' || !state.players[effect.playerId] || !effect.instanceIds.length ||
      new Set(effect.instanceIds).size !== effect.instanceIds.length) return null;
    const owner = state.players[effect.playerId];
    const selected = effect.instanceIds.map(id => owner.deck.find(card => card.instanceId === id));
    if (selected.some(card => !card || card.card.type !== effect.cardType || !matchesExpectedName(card.card.name, effect.name, effect.matching))) return null;
    let next = state;
    for (const card of selected as CardInstance[]) {
      const moved = moveCardBetweenZones(next, {
        instanceId: card.instanceId, actorId: plan.actorId, destination: 'hand',
        destinationPlayerId: getOriginalOwnerId(card), effectMove: true
      });
      if (!moved.ok) return null;
      next = moved.state;
    }
    if (effect.shuffle) {
      const player = next.players[effect.playerId];
      const deck = [...player.deck];
      const random = deterministicRandom(`${state.id}:${state.turnNumber}:${state.eventLog.length}:${effect.instanceIds.join(',')}`);
      for (let index = deck.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
      }
      next = { ...next, players: { ...next.players, [effect.playerId]: { ...player, deck } } };
      next = appendGameEvents(next, [{ type: 'DECK_SHUFFLED', playerId: effect.playerId, cardCount: deck.length,
        eventId: `${state.id}:${state.gameEvents?.length ?? 0}:card-text-search-shuffle:${effect.instanceIds.join(',')}` }]);
    }
    return next;
  },
  reset_power: ({ state, plan, effect }) => {
    if (effect.kind !== 'reset_power') return null;
    const found = findAvatar(state, effect.targetId);
    if (!found) return null;
    const targeting = preventTargeting(state, plan.actorId, effect.targetId);
    if (targeting.prevented) return targeting.state;
    const player = state.players[found.playerId];
    return { ...state, players: { ...state.players, [found.playerId]: {
      ...player, avatarZone: player.avatarZone.map(avatar => avatar.instanceId !== effect.targetId ? avatar : {
        ...avatar, layerModifiers: avatar.layerModifiers.filter(modifier => modifier.sourceCardId.startsWith('aura-') || modifier.sourceCardId.startsWith('continuous:'))
      })
    } } };
  },
  destroy_avatar: ({ state, plan, effect }) => {
    if (effect.kind !== 'destroy_avatar') return null;
    const found = findAvatar(state, effect.targetId);
    if (!found) return null;
    const targeting = preventTargeting(state, plan.actorId, effect.targetId);
    if (targeting.prevented) return targeting.state;
    const movement = moveCardBetweenZones(state, {
      instanceId: effect.targetId, actorId: plan.actorId, destination: 'hell',
      destinationPlayerId: getOriginalOwnerId(found.avatar), effectMove: true, cause: 'EFFECT'
    });
    if (!movement.ok) return null;
    return movement.state;
  },
  bounce_avatar: ({ state, plan, effect }) => {
    if (effect.kind !== 'bounce_avatar') return null;
    const found = findAvatar(state, effect.targetId);
    if (!found) return null;
    const targeting = preventTargeting(state, plan.actorId, effect.targetId);
    if (targeting.prevented) return targeting.state;
    const movement = moveCardBetweenZones(state, {
      instanceId: effect.targetId, actorId: plan.actorId, destination: 'hand',
      destinationPlayerId: getOriginalOwnerId(found.avatar), effectMove: true
    });
    if (!movement.ok) return null;
    const owner = movement.state.players[getOriginalOwnerId(found.avatar)];
    if (!owner) return null;
    return { ...movement.state, players: { ...movement.state.players, [owner.id]: {
      ...owner,
      hand: owner.hand.map(item => item.instanceId === found.avatar.instanceId
        ? { ...item, isRested: false, layerModifiers: [], attachedInstances: [] }
        : item)
    } } };
  },
  banish_avatar: ({ state, plan, effect }) => {
    if (effect.kind !== 'banish_avatar') return null;
    const found = findAvatar(state, effect.targetId);
    if (!found) return null;
    const targeting = preventTargeting(state, plan.actorId, effect.targetId);
    if (targeting.prevented) return targeting.state;
    const movement = moveCardBetweenZones(state, {
      instanceId: effect.targetId, actorId: plan.actorId, destination: 'darkDimension',
      destinationPlayerId: getOriginalOwnerId(found.avatar), effectMove: true, cause: 'EFFECT'
    });
    return movement.ok ? movement.state : null;
  },
  mill: ({ state, plan, effect }) => {
    if (effect.kind !== 'mill' || !Number.isSafeInteger(effect.count) || effect.count < 0) return null;
    const player = state.players[effect.playerId];
    if (!player) return null;
    let next = state;
    const milled: string[] = [];
    for (const card of player.deck.slice(0, effect.count)) {
      const moved = moveCardBetweenZones(next, {
        instanceId: card.instanceId, actorId: plan.actorId, destination: 'hell',
        destinationPlayerId: getOriginalOwnerId(card), effectMove: true, cause: 'EFFECT'
      });
      if (!moved.ok) return null;
      next = moved.state;
      milled.push(card.instanceId);
    }
    const emitted = [];
    if (milled.length) emitted.push({
      type: 'DECK_MILLED' as const, playerId: effect.playerId, cardInstanceIds: milled,
      eventId: `${state.id}:${state.gameEvents?.length ?? 0}:card-text-mill:${milled.join(',')}`
    });
    if (effect.count > 0 && next.players[effect.playerId].deck.length === 0) emitted.push({
      type: 'PLAYER_DECKED_OUT' as const, playerId: effect.playerId,
      eventId: `${state.id}:${state.gameEvents?.length ?? 0}:card-text-deck-out:${effect.playerId}`
    });
    if (emitted.length) next = appendGameEvents(next, emitted);
    return next;
  },
  destroy_opponent_avatars: ({ state, plan, effect }) => {
    if (effect.kind !== 'destroy_opponent_avatars' || effect.actorId !== plan.actorId) return null;
    let next = state;
    for (const playerId of state.playerOrder) {
      if (playerId === effect.actorId) continue;
      const avatars = next.players[playerId]?.avatarZone ?? [];
      for (const avatar of avatars) {
        const moved = moveCardBetweenZones(next, {
          instanceId: avatar.instanceId, actorId: plan.actorId, destination: 'hell',
          destinationPlayerId: getOriginalOwnerId(avatar), effectMove: true, cause: 'EFFECT'
        });
        if (!moved.ok) return null;
        next = moved.state;
      }
    }
    return next;
  },
  recover_from_hell: ({ state, plan, effect }) => {
    if (effect.kind !== 'recover_from_hell' || !Number.isInteger(effect.count) || effect.count < 0) return null;
    const player = state.players[effect.playerId];
    if (!player) return null;
    const cards = player.hell.filter(card => card.card.type !== 'Life').slice(0, effect.count);
    if (cards.length !== effect.count) return null;
    let next = state;
    for (const card of cards) {
      const moved = moveCardBetweenZones(next, {
        instanceId: card.instanceId, actorId: plan.actorId, destination: effect.destination,
        destinationPlayerId: getOriginalOwnerId(card), effectMove: true
      });
      if (!moved.ok) return null;
      next = moved.state;
      if (effect.destination === 'deck') {
        const owner = next.players[getOriginalOwnerId(card)];
        next = { ...next, players: { ...next.players, [owner.id]: {
          ...owner, deck: owner.deck.map(item => item.instanceId === card.instanceId ? { ...item, isFaceUp: false } : item)
        } } };
      }
    }
    return next;
  },
  change_avatar_control: ({ state, plan, effect }) => {
    if (effect.kind !== 'change_avatar_control') return null;
    const moved = changeAvatarControl(state, plan.actorId, effect.targetId, effect.controllerId);
    return moved.ok ? moved.state : null;
  },
  cancel_chain_entry: ({ state, effect }) => {
    if (effect.kind !== 'cancel_chain_entry' || !state.reactionWindow) return null;
    let found = false;
    const chain = (state.reactionWindow.chain ?? []).map(entry => {
      if ((entry.entryType === 'TRIGGER_ABILITY' || entry.entryType === 'ACTIVATED_ABILITY') &&
        (entry.sourceCardId === effect.targetId || entry.triggerId === effect.targetId)) {
        found = true;
        return { ...entry, cancelled: true };
      }
      return entry;
    });
    return found ? { ...state, reactionWindow: { ...state.reactionWindow, chain } } : null;
  },
  summon_from_hell: ({ state, plan, effect }) => {
    if (effect.kind !== 'summon_from_hell') return null;
    const player = state.players[effect.playerId];
    const card = player?.hell.find(item => item.instanceId === effect.instanceId && item.card.type === 'Avatar');
    if (!player || !card) return null;
    const moved = moveCardBetweenZones(state, {
      instanceId: effect.instanceId, actorId: plan.actorId, destination: 'avatarZone',
      destinationPlayerId: effect.playerId, effectMove: true
    });
    if (!moved.ok) return null;
    const updated = moved.state.players[effect.playerId];
    return { ...moved.state, players: { ...moved.state.players, [effect.playerId]: {
      ...updated, avatarZone: updated.avatarZone.map(item => item.instanceId === effect.instanceId
        ? { ...item, isFaceUp: true, isRested: false, layerModifiers: [] }
        : item)
    } } };
  }
};

function resolveEffectPlanInTransaction(
  state: GameState,
  plan: EffectPlan,
  handlers: Partial<Record<EffectDefinition['kind'], EffectHandler>> = {}
): EffectResolution {
  const plannedEffects = plan.sequence ? plan.sequence.flatMap(step => step.kind === 'effect' ? [step.effect] : []) : plan.effects;
  const plannedCosts = plan.sequence ? plan.sequence.flatMap(step => step.kind === 'cost' ? [step.cost] : []) : plan.costs ?? [];
  if (!state.players[plan.actorId] || (plannedEffects.length === 0 && plannedCosts.length === 0)) return fail(state, 'invalid actor or empty effect plan');
  const invariantError = validateGameState(state);
  if (invariantError) return fail(state, invariantError);
  for (const condition of plan.conditions ?? []) {
    const passed = condition.kind === 'player_has_avatar'
      ? !!state.players[condition.playerId]?.avatarZone.some(avatar => avatar.card.name.includes(condition.nameIncludes))
      : condition.kind === 'target_exists' && !!findAvatar(state, condition.targetId);
    if (!passed) return fail(state, 'effect condition failed');
  }
  for (const effect of plannedEffects) {
    if (!effect || !Object.hasOwn(defaultHandlers, effect.kind)) return fail(state, 'unsupported effect');
    if ('count' in effect && (!Number.isInteger(effect.count) || effect.count < 0)) return fail(state, 'invalid effect count');
    if ('amount' in effect && !Number.isFinite(effect.amount)) return fail(state, 'invalid effect value');
    if (('targetId' in effect) && effect.kind !== 'cancel_chain_entry' && !findAvatar(state, effect.targetId)) return fail(state, 'invalid effect target');
  }
  for (const cost of plannedCosts) {
    if (cost.playerId !== plan.actorId) return fail(state, 'cost payer must be the acting player');
  }

  // Handlers are extensible and may mutate nested data. Isolate the entire transaction
  // so a later rejection or exception cannot leak partial changes into the caller's state.
  let staged = structuredClone(state);
  const applyEffect = (effect: EffectDefinition): boolean => {
    try {
      const handler = handlers[effect.kind] ?? defaultHandlers[effect.kind];
      const next = handler({ state: staged, plan, effect });
      if (!next || typeof next !== 'object' || !next.players) return false;
      staged = next;
      return true;
    } catch {
      return false;
    }
  };
  if (plan.sequence) {
    for (const step of plan.sequence) {
      if (step.kind === 'cost') {
        const paid = applyCost(staged, step.cost);
        if (!paid) return fail(state, 'cost cannot be paid');
        staged = paid;
      } else if (!applyEffect(step.effect)) {
        return fail(state, `effect handler rejected ${step.effect.kind}`);
      }
    }
  } else {
    for (const cost of plan.costs ?? []) {
      const paid = applyCost(staged, cost);
      if (!paid) return fail(state, 'cost cannot be paid');
      staged = paid;
    }
    for (const effect of plan.effects) {
      if (!applyEffect(effect)) return fail(state, `effect handler rejected ${effect.kind}`);
    }
  }
  return { ok: true, state: staged, logs: [] };
}

export function resolveEffectPlan(
  state: GameState,
  plan: EffectPlan,
  handlers: Partial<Record<EffectDefinition['kind'], EffectHandler>> = {}
): EffectResolution {
  let failure: EffectResolution | null = null;
  const plannedEffects = plan.sequence ? plan.sequence.flatMap(step => step.kind === 'effect' ? [step.effect] : []) : plan.effects;
  const transaction = runGameTransaction(state, draft => {
    const result = resolveEffectPlanInTransaction(draft, plan, handlers);
    if (!result.ok) {
      failure = result;
      return null;
    }
    return result.state;
  }, plannedEffects.map((effect, index) => ({ type: 'EFFECT_RESOLVED' as const, actorId: plan.actorId, effectKind: effect.kind, eventId: `${state.id}:${state.gameEvents?.length ?? 0}:${plan.actorId}:${index}:${effect.kind}` })));
  if (transaction.ok === false) return fail(state, failure?.reason ?? transaction.reason);
  return { ok: true, state: transaction.state, logs: [] };
}
