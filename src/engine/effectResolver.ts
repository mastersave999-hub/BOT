import type { CardInstance, GameState } from './types';
import { moveCardBetweenZones, validateGameState } from './gameRules';
import { runGameTransaction } from './gameTransaction';

export type EffectCondition =
  | { kind: 'player_has_avatar'; playerId: string; nameIncludes: string }
  | { kind: 'target_exists'; targetId: string };

export type EffectCost =
  | { kind: 'discard_from_hand'; playerId: string; instanceIds: string[] }
  | { kind: 'sacrifice_avatar'; playerId: string; instanceId: string };

export type EffectDefinition =
  | { kind: 'draw'; playerId: string; count: number }
  | { kind: 'modify_power'; targetId: string; amount: number; layer?: 1 | 4; expiresAt?: 'END_OF_TURN' | 'END_OF_BATTLE' | 'DRAW_PHASE' }
  | { kind: 'reset_power'; targetId: string }
  | { kind: 'destroy_avatar'; targetId: string }
  | { kind: 'bounce_avatar'; targetId: string }
  | { kind: 'destroy_opponent_avatars'; actorId: string }
  | { kind: 'recover_from_hell'; playerId: string; count: number; destination: 'deck' | 'hand' }
  | { kind: 'summon_from_hell'; playerId: string; instanceId: string };

export interface EffectPlan {
  actorId: string;
  conditions?: EffectCondition[];
  costs?: EffectCost[];
  effects: EffectDefinition[];
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
        instanceId, actorId: cost.playerId, destination: 'hell', destinationPlayerId: card.ownerId, effectMove: true
      });
      if (!moved.ok) return null;
      next = moved.state;
    }
    return next;
  }
  const avatar = player.avatarZone.find(item => item.instanceId === cost.instanceId);
  if (!avatar) return null;
  const moved = moveCardBetweenZones(state, {
    instanceId: avatar.instanceId, actorId: cost.playerId, destination: 'hell', destinationPlayerId: avatar.ownerId, effectMove: true
  });
  if (!moved.ok) return null;
  return moved.state;
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
  modify_power: ({ state, effect }) => {
    if (effect.kind !== 'modify_power' || !Number.isFinite(effect.amount)) return null;
    const found = findAvatar(state, effect.targetId);
    if (!found) return null;
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
  reset_power: ({ state, effect }) => {
    if (effect.kind !== 'reset_power') return null;
    const found = findAvatar(state, effect.targetId);
    if (!found) return null;
    const player = state.players[found.playerId];
    return { ...state, players: { ...state.players, [found.playerId]: {
      ...player, avatarZone: player.avatarZone.map(avatar => avatar.instanceId !== effect.targetId ? avatar : {
        ...avatar, layerModifiers: avatar.layerModifiers.filter(modifier => modifier.sourceCardId.startsWith('aura-'))
      })
    } } };
  },
  destroy_avatar: ({ state, plan, effect }) => {
    if (effect.kind !== 'destroy_avatar') return null;
    const found = findAvatar(state, effect.targetId);
    if (!found) return null;
    const movement = moveCardBetweenZones(state, {
      instanceId: effect.targetId, actorId: plan.actorId, destination: 'hell',
      destinationPlayerId: found.avatar.ownerId, effectMove: true
    });
    if (!movement.ok) return null;
    return movement.state;
  },
  bounce_avatar: ({ state, plan, effect }) => {
    if (effect.kind !== 'bounce_avatar') return null;
    const found = findAvatar(state, effect.targetId);
    if (!found) return null;
    const movement = moveCardBetweenZones(state, {
      instanceId: effect.targetId, actorId: plan.actorId, destination: 'hand',
      destinationPlayerId: found.avatar.ownerId, effectMove: true
    });
    if (!movement.ok) return null;
    const owner = movement.state.players[found.avatar.ownerId];
    if (!owner) return null;
    return { ...movement.state, players: { ...movement.state.players, [owner.id]: {
      ...owner,
      hand: owner.hand.map(item => item.instanceId === found.avatar.instanceId
        ? { ...item, isRested: false, layerModifiers: [], attachedInstances: [] }
        : item)
    } } };
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
          destinationPlayerId: avatar.ownerId, effectMove: true
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
        destinationPlayerId: card.ownerId, effectMove: true
      });
      if (!moved.ok) return null;
      next = moved.state;
      if (effect.destination === 'deck') {
        const owner = next.players[card.ownerId];
        next = { ...next, players: { ...next.players, [owner.id]: {
          ...owner, deck: owner.deck.map(item => item.instanceId === card.instanceId ? { ...item, isFaceUp: false } : item)
        } } };
      }
    }
    return next;
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
  if (!state.players[plan.actorId] || plan.effects.length === 0) return fail(state, 'invalid actor or empty effect plan');
  const invariantError = validateGameState(state);
  if (invariantError) return fail(state, invariantError);
  for (const condition of plan.conditions ?? []) {
    const passed = condition.kind === 'player_has_avatar'
      ? !!state.players[condition.playerId]?.avatarZone.some(avatar => avatar.card.name.includes(condition.nameIncludes))
      : condition.kind === 'target_exists' && !!findAvatar(state, condition.targetId);
    if (!passed) return fail(state, 'effect condition failed');
  }
  for (const effect of plan.effects) {
    if (!effect || !Object.hasOwn(defaultHandlers, effect.kind)) return fail(state, 'unsupported effect');
    if ('count' in effect && (!Number.isInteger(effect.count) || effect.count < 0)) return fail(state, 'invalid effect count');
    if ('amount' in effect && !Number.isFinite(effect.amount)) return fail(state, 'invalid effect value');
    if (('targetId' in effect) && !findAvatar(state, effect.targetId)) return fail(state, 'invalid effect target');
  }
  for (const cost of plan.costs ?? []) {
    if (cost.playerId !== plan.actorId) return fail(state, 'cost payer must be the acting player');
  }

  // Handlers are extensible and may mutate nested data. Isolate the entire transaction
  // so a later rejection or exception cannot leak partial changes into the caller's state.
  let staged = structuredClone(state);
  for (const cost of plan.costs ?? []) {
    const paid = applyCost(staged, cost);
    if (!paid) return fail(state, 'cost cannot be paid');
    staged = paid;
  }
  for (const effect of plan.effects) {
    try {
      const handler = handlers[effect.kind] ?? defaultHandlers[effect.kind];
      const next = handler({ state: staged, plan, effect });
      if (!next || typeof next !== 'object' || !next.players) return fail(state, `effect handler rejected ${effect.kind}`);
      staged = next;
    } catch {
      return fail(state, `effect handler failed ${effect.kind}`);
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
  const transaction = runGameTransaction(state, draft => {
    const result = resolveEffectPlanInTransaction(draft, plan, handlers);
    if (!result.ok) {
      failure = result;
      return null;
    }
    return result.state;
  }, plan.effects.map((effect, index) => ({ type: 'EFFECT_RESOLVED' as const, actorId: plan.actorId, effectKind: effect.kind, eventId: `${state.id}:${state.gameEvents?.length ?? 0}:${plan.actorId}:${index}:${effect.kind}` })));
  if (transaction.ok === false) return fail(state, failure?.reason ?? transaction.reason);
  return { ok: true, state: transaction.state, logs: [] };
}
