type GameEventPayload =
  | { type: 'CARD_MOVED'; instanceId?: string; ownerId: string; controllerId: string; from: string; to: string; actorId: string }
  | { type: 'CONTROL_CHANGED'; instanceId: string; ownerId: string; originalOwnerId: string; previousControllerId: string; controllerId: string; actorId: string }
  | { type: 'CONSTRUCT_ENTERED'; instanceId: string; name: string; playerId: string }
  | { type: 'CONSTRUCT_LEFT'; instanceId: string; name: string; playerId: string }
  | { type: 'MAGIC_PLAYED'; instanceId: string; subtype: import('./types').MagicSubtype; playerId: string }
  | { type: 'MAGIC_RESOLVED'; instanceId: string; playerId: string }
  | { type: 'AVATAR_SUMMONED'; instanceId: string; playerId: string }
  | { type: 'TOKEN_CREATED' | 'TOKEN_DESTROYED'; instanceId: string; playerId: string }
  | { type: 'ATTACK_DECLARED'; attackerId: string; targetId: string; playerId: string }
  | { type: 'BATTLE_ENDED'; attackerId: string; targetId: string; playerId: string }
  | { type: 'CARD_DRAWN'; instanceId?: string; playerId: string; actorId: string }
  | { type: 'CARD_DISCARDED'; instanceId: string; playerId: string; actorId: string }
  | { type: 'DAMAGE_DEALT' | 'DAMAGE_TAKEN'; amount: number; sourceId?: string; targetPlayerId: string; actorId: string }
  | { type: 'AVATAR_DESTROYED' | 'CARD_LEFT_FIELD'; instanceId: string; ownerId: string; controllerId: string; actorId: string }
  | { type: 'PHASE_STARTED' | 'PHASE_ENDED'; phase: import('./types').Phase; playerId: string; turnNumber: number }
  | { type: 'TURN_STARTED' | 'TURN_ENDED'; playerId: string; turnNumber: number }
  | { type: 'DECK_SHUFFLED'; playerId: string; cardCount: number }
  | { type: 'DECK_MILLED'; playerId: string; cardInstanceIds: string[] }
  | { type: 'DECK_SCOUTED'; deckOwnerId: string; viewerId: string; cardInstanceIds: string[] }
  | { type: 'DECK_SEARCHED'; deckOwnerId: string; actorId: string; destination: 'hand' | 'hell' | 'deck'; instanceId?: string; found?: boolean }
  | { type: 'DECK_SEARCH_VERIFIED'; deckOwnerId: string; searcherId: string; verifierId: string }
  | { type: 'PLAYER_DECKED_OUT'; playerId: string }
  | { type: 'EFFECT_RESOLVED' | 'EFFECT_PREVENTED' | 'EFFECT_CANCELLED'; actorId: string; effectKind: 'draw' | 'modify_power' | 'reset_power' | 'destroy_avatar' | 'bounce_avatar' | 'destroy_opponent_avatars' | 'recover_from_hell' | 'summon_from_hell' | 'change_avatar_control' }
  | { type: 'ACTION_CANCELLED'; actorId: string; targetInstanceId: string; targetKind: 'MAGIC_PLAY' | 'ABILITY' | 'CHAIN_ENTRY'; eventId: string }
  | { type: 'PREVENTION_APPLIED'; shieldId: string; kind: 'DAMAGE' | 'DESTRUCTION' | 'TARGETING'; actorId: string; targetId: string; targetPlayerId: string; preventedAmount: number; eventId: string };

export type GameEvent = GameEventPayload & { eventId: string };

export interface PendingGameEvent { sequence: number; event: GameEvent }

/** Deterministic append-only event collection. Explicit event IDs make retries idempotent. */
export function appendGameEvents<T extends { gameEvents?: PendingGameEvent[] }>(target: T, events: GameEvent[]): T {
  const existing = target.gameEvents ?? [];
  const seenIds = new Set(existing.map(({ event }) => event.eventId));
  const appended: PendingGameEvent[] = [];
  for (const event of events) {
    if (!event.eventId) throw new TypeError('Game events require a stable eventId');
    if (seenIds.has(event.eventId)) continue;
    seenIds.add(event.eventId);
    appended.push({ sequence: existing.length + appended.length, event });
  }
  return appended.length ? { ...target, gameEvents: [...existing, ...appended] } : target;
}

export type GameEventHandler = (event: GameEvent) => void;

const activeDispatchKeys = new Set<string>();
let dispatchDepth = 0;
const MAX_EVENT_DISPATCH_DEPTH = 32;

/** Dispatches an immutable snapshot and stops reentrant cycles for the same identified event. */
export function dispatchGameEvents(events: readonly GameEvent[], handlers: readonly GameEventHandler[]): void {
  if (dispatchDepth >= MAX_EVENT_DISPATCH_DEPTH) return;
  dispatchDepth += 1;
  try {
    for (const event of [...events]) {
      const key = event.eventId ?? JSON.stringify(event);
      if (activeDispatchKeys.has(key)) continue;
      activeDispatchKeys.add(key);
      try {
        for (const handler of handlers) handler(event);
      } finally {
        activeDispatchKeys.delete(key);
      }
    }
  } finally {
    dispatchDepth -= 1;
  }
}
