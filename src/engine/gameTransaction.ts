import type { GameState } from './types';
import { validateGameState } from './gameRules';
import { appendGameEvents, type GameEvent } from './gameEvents';

export type TransactionFailureCode = 'INVALID_INITIAL_STATE' | 'OPERATION_REJECTED' | 'OPERATION_THROWN' | 'INVALID_RESULT';
export type TransactionResult =
  | { ok: true; state: GameState }
  | { ok: false; state: GameState; code: TransactionFailureCode; reason: string };

/** Isolates nested mutable state, validates the candidate, then atomically publishes it and its events. */
export function runGameTransaction(
  original: GameState,
  operation: (draft: GameState) => GameState | null,
  events: GameEvent[] = [],
  options: { allowPendingPlayerChoice?: boolean } = {}
): TransactionResult {
  if ((original.pendingDeckChoice || original.pendingDeckSearchVerification) && !options.allowPendingPlayerChoice) {
    return { ok: false, state: original, code: 'OPERATION_REJECTED', reason: 'A Deck operation choice is pending' };
  }
  const initialError = validateGameState(original);
  if (initialError) return { ok: false, state: original, code: 'INVALID_INITIAL_STATE', reason: initialError };
  try {
    const draft = structuredClone(original);
    const candidate = operation(draft);
    if (!candidate || typeof candidate !== 'object' || !candidate.players) {
      return { ok: false, state: original, code: 'OPERATION_REJECTED', reason: 'Operation rejected' };
    }
    const error = validateGameState(candidate);
    if (error) return { ok: false, state: original, code: 'INVALID_RESULT', reason: error };
    return { ok: true, state: appendGameEvents(candidate, events) };
  } catch (error) {
    return { ok: false, state: original, code: 'OPERATION_THROWN', reason: error instanceof Error ? error.message : 'Operation threw' };
  }
}
