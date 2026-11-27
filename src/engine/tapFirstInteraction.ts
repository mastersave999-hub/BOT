/**
 * Phase 6 tap-first interaction contract (pure and engine-agnostic).
 *
 * Rules enforced here:
 * - The first tap/click on a card only selects or deselects it for inspection.
 *   It never dispatches a gameplay action and never touches GameState.
 * - A gameplay action may only be dispatched through an explicit confirmation
 *   (`isExplicitlyConfirmed`) for the currently selected card — this includes
 *   0-Cost / No-Cost cards, which get no confirmation shortcut.
 * - Canceling a selection simply clears it; the game state is untouched.
 * - A dispatch guard window blocks rapid repeated taps from dispatching
 *   duplicate actions.
 */

export interface TapFirstSelection {
  selectedHandCardId: string | null;
}

export const NO_SELECTION: TapFirstSelection = { selectedHandCardId: null };

/** First tap: select, or deselect when the same card is tapped again. Never dispatches. */
export function tapHandCard(selection: TapFirstSelection, instanceId: string): TapFirstSelection {
  return {
    selectedHandCardId: selection.selectedHandCardId === instanceId ? null : instanceId
  };
}

/** Cancel: clears the selection only. The caller's game state is never modified. */
export function cancelHandSelection(): TapFirstSelection {
  return { ...NO_SELECTION };
}

/**
 * An action may execute only when it was explicitly confirmed for the card that is
 * currently selected. There is deliberately no cost-based bypass: 0-Cost cards must
 * still be confirmed through the confirmation bar.
 */
export function isExplicitlyConfirmed(selection: TapFirstSelection, instanceId: string): boolean {
  return selection.selectedHandCardId === instanceId && instanceId !== null;
}

export interface DispatchGuard {
  lastDispatchKey: string | null;
  lastDispatchAt: number | null;
}

export const EMPTY_DISPATCH_GUARD: DispatchGuard = { lastDispatchKey: null, lastDispatchAt: null };

/** Minimum spacing between two dispatched actions, in milliseconds. */
export const RAPID_TAP_GUARD_MS = 350;

export function isDispatchLocked(guard: DispatchGuard, now: number): boolean {
  return guard.lastDispatchAt !== null && now - guard.lastDispatchAt < RAPID_TAP_GUARD_MS;
}

/**
 * Attempts to open a dispatch slot for `key`. Returns `allowed: false` while the
 * guard window from a previous dispatch is still open, so rapid repeated taps
 * cannot dispatch duplicate actions.
 */
export function beginDispatch(
  guard: DispatchGuard,
  key: string,
  now: number
): { guard: DispatchGuard; allowed: boolean } {
  if (isDispatchLocked(guard, now)) return { guard, allowed: false };
  return { guard: { lastDispatchKey: key, lastDispatchAt: now }, allowed: true };
}
