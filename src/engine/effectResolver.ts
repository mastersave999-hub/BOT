import type { CardInstance, GameState } from './types';

export type EffectCondition =
  | { kind: 'player_has_avatar'; playerId: string; nameIncludes: string }
  | { kind: 'target_exists'; targetId: string };

export type EffectCost =
  | { kind: 'discard_from_hand'; playerId: string; instanceIds: string[] }
  | { kind: 'sacrifice_avatar'; playerId: string; instanceId: string };

export type EffectDefinition =
  | { kind: 'draw'; playerId: string; count: number }
  | { kind: 'modify_power'; targetId: string; amount: number; layer?: 1 | 4; expiresAt?: 'END_OF_TURN' | 'END_OF_BATTLE' }
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
    return { ...state, players: { ...state.players, [cost.playerId]: {
      ...player,
      hand: player.hand.filter(card => !cost.instanceIds.includes(card.instanceId)),
      hell: [...player.hell, ...player.hand.filter(card => cost.instanceIds.includes(card.instanceId))]
    } } };
  }
  const avatar = player.avatarZone.find(item => item.instanceId === cost.instanceId);
  if (!avatar) return null;
  return { ...state, players: { ...state.players, [cost.playerId]: {
    ...player,
    avatarZone: player.avatarZone.filter(item => item.instanceId !== avatar.instanceId),
    hell: [...player.hell, avatar, ...avatar.attachedInstances]
  } } };
}

const defaultHandlers: Record<EffectDefinition['kind'], EffectHandler> = {
  draw: ({ state, effect }) => {
    if (effect.kind !== 'draw' || !Number.isInteger(effect.count) || effect.count < 0) return null;
    const player = state.players[effect.playerId];
    if (!player) return null;
    const deck = player.deck.filter(card => card.card.type !== 'Life');
    if (deck.length < effect.count) return null;
    const drawn = deck.slice(0, effect.count).map(card => ({ ...card, isFaceUp: true }));
    return { ...state, players: { ...state.players, [effect.playerId]: {
      ...player, deck: deck.slice(effect.count), hand: [...player.hand, ...drawn]
    } } };
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
  destroy_avatar: ({ state, effect }) => {
    if (effect.kind !== 'destroy_avatar') return null;
    const found = findAvatar(state, effect.targetId);
    if (!found) return null;
    const player = state.players[found.playerId];
    return { ...state, players: { ...state.players, [found.playerId]: {
      ...player, avatarZone: player.avatarZone.filter(item => item.instanceId !== effect.targetId),
      hell: [...player.hell, found.avatar, ...found.avatar.attachedInstances]
    } } };
  },
  bounce_avatar: ({ state, effect }) => {
    if (effect.kind !== 'bounce_avatar') return null;
    const found = findAvatar(state, effect.targetId);
    if (!found) return null;
    const player = state.players[found.playerId];
    const returned = { ...found.avatar, isRested: false, layerModifiers: [], attachedInstances: [] };
    return { ...state, players: { ...state.players, [found.playerId]: {
      ...player, avatarZone: player.avatarZone.filter(item => item.instanceId !== effect.targetId),
      hand: [...player.hand, returned], hell: [...player.hell, ...found.avatar.attachedInstances]
    } } };
  },
  destroy_opponent_avatars: ({ state, plan, effect }) => {
    if (effect.kind !== 'destroy_opponent_avatars' || effect.actorId !== plan.actorId) return null;
    const players = { ...state.players };
    for (const playerId of state.playerOrder) {
      if (playerId === effect.actorId) continue;
      const player = players[playerId];
      if (player) players[playerId] = { ...player, avatarZone: [], hell: [...player.hell, ...player.avatarZone.flatMap(item => [item, ...item.attachedInstances])] };
    }
    return { ...state, players };
  },
  recover_from_hell: ({ state, effect }) => {
    if (effect.kind !== 'recover_from_hell' || !Number.isInteger(effect.count) || effect.count < 0) return null;
    const player = state.players[effect.playerId];
    if (!player) return null;
    const cards = player.hell.filter(card => card.card.type !== 'Life').slice(0, effect.count);
    if (cards.length !== effect.count) return null;
    const ids = new Set(cards.map(card => card.instanceId));
    const destination = cards.map(card => effect.destination === 'deck' ? { ...card, isFaceUp: false } : card);
    return { ...state, players: { ...state.players, [effect.playerId]: {
      ...player, hell: player.hell.filter(card => !ids.has(card.instanceId)),
      [effect.destination]: [...player[effect.destination], ...destination]
    } } };
  },
  summon_from_hell: ({ state, effect }) => {
    if (effect.kind !== 'summon_from_hell') return null;
    const player = state.players[effect.playerId];
    const card = player?.hell.find(item => item.instanceId === effect.instanceId && item.card.type === 'Avatar');
    if (!player || !card || player.avatarZone.length >= 4) return null;
    return { ...state, players: { ...state.players, [effect.playerId]: {
      ...player, hell: player.hell.filter(item => item.instanceId !== effect.instanceId),
      avatarZone: [...player.avatarZone, { ...card, isFaceUp: true, isRested: false, layerModifiers: [] }]
    } } };
  }
};

export function resolveEffectPlan(
  state: GameState,
  plan: EffectPlan,
  handlers: Partial<Record<EffectDefinition['kind'], EffectHandler>> = {}
): EffectResolution {
  if (!state.players[plan.actorId] || plan.effects.length === 0) return fail(state, 'invalid actor or empty effect plan');
  for (const condition of plan.conditions ?? []) {
    const passed = condition.kind === 'player_has_avatar'
      ? !!state.players[condition.playerId]?.avatarZone.some(avatar => avatar.card.name.includes(condition.nameIncludes))
      : !!findAvatar(state, condition.targetId);
    if (!passed) return fail(state, 'effect condition failed');
  }
  for (const effect of plan.effects) {
    if (!Number.isFinite('count' in effect ? effect.count : 'amount' in effect ? effect.amount : 0)) return fail(state, 'invalid effect value');
    if ((effect.kind === 'destroy_avatar' || effect.kind === 'bounce_avatar' || effect.kind === 'modify_power') && !findAvatar(state, effect.targetId)) return fail(state, 'invalid effect target');
  }
  let staged = state;
  for (const cost of plan.costs ?? []) {
    const paid = applyCost(staged, cost);
    if (!paid) return fail(state, 'cost cannot be paid');
    staged = paid;
  }
  for (const effect of plan.effects) {
    const next = (handlers[effect.kind] ?? defaultHandlers[effect.kind])({ state: staged, plan, effect });
    if (!next) return fail(state, `effect handler rejected ${effect.kind}`);
    staged = next;
  }
  return { ok: true, state: staged, logs: [] };
}
