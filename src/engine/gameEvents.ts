export type GameEvent =
  | { type: 'CARD_MOVED'; instanceId?: string; ownerId: string; controllerId: string; from: string; to: string; actorId: string }
  | { type: 'CONSTRUCT_ENTERED'; instanceId: string; name: string; playerId: string }
  | { type: 'CONSTRUCT_LEFT'; instanceId: string; name: string; playerId: string }
  | { type: 'MAGIC_PLAYED'; instanceId: string; subtype: string; playerId: string }
  | { type: 'MAGIC_RESOLVED'; instanceId: string; playerId: string }
  | { type: 'AVATAR_SUMMONED'; instanceId: string; playerId: string }
  | { type: 'TOKEN_CREATED' | 'TOKEN_DESTROYED'; instanceId: string; playerId: string }
  | { type: 'ATTACK_DECLARED'; attackerId: string; targetId: string; playerId: string }
  | { type: 'BATTLE_ENDED'; attackerId: string; targetId: string; playerId: string }
  | { type: 'TURN_STARTED' | 'TURN_ENDED'; playerId: string; turnNumber: number }
  | { type: 'EFFECT_RESOLVED' | 'EFFECT_PREVENTED' | 'EFFECT_CANCELLED'; actorId: string; effectKind: string };

export interface PendingGameEvent { sequence: number; event: GameEvent }

/** Deterministic append-only event collection. Events are committed only after a transaction succeeds. */
export function appendGameEvents<T extends { gameEvents?: PendingGameEvent[] }>(target: T, events: GameEvent[]): T {
  const existing = target.gameEvents ?? [];
  const appended = events.map((event, index) => ({ sequence: existing.length + index, event }));
  return { ...target, gameEvents: [...existing, ...appended] };
}

export type GameEventHandler = (event: GameEvent) => void;

/** Dispatches a fixed snapshot once; nested dispatches must be explicitly initiated by callers. */
export function dispatchGameEvents(events: readonly GameEvent[], handlers: readonly GameEventHandler[]): void {
  for (const event of events) for (const handler of handlers) handler(event);
}
