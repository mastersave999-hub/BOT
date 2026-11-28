import type { GameState } from './types';
import type { LocalMatchSide } from './localMatch';

export interface StoredLocalMatch {
  state: GameState;
  /** Deck pools the match was created from, kept so Restart can rebuild it. */
  sides?: [LocalMatchSide, LocalMatchSide];
  /** Set once the match has a winner; a finished match is never resumable. */
  winnerName?: string | null;
  savedAt: number;
}

const STORAGE_KEY = 'botc:local-match:v1';

// GameState stores usedMagicTypesThisTurn as a Set, which JSON cannot round-trip.
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Set) return { __set: [...value] };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && Array.isArray((value as { __set?: unknown }).__set)) {
    return new Set((value as { __set: unknown[] }).__set);
  }
  return value;
}

function readRecord(): Partial<StoredLocalMatch> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw, reviver) as Partial<StoredLocalMatch>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeRecord(record: Partial<StoredLocalMatch>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(record, replacer));
}

/** Merges the current match state into the stored record, preserving the deck sides. */
export function saveLocalMatch(state: GameState, winnerName: string | null): void {
  try {
    const existing = readRecord();
    writeRecord({ ...existing, state, winnerName, savedAt: Date.now() });
  } catch {
    // Storage can be unavailable (private mode / quota); the match simply won't resume.
  }
}

export function saveLocalMatchSides(sides: [LocalMatchSide, LocalMatchSide]): void {
  try {
    const existing = readRecord();
    writeRecord({ ...existing, sides, savedAt: Date.now() });
  } catch {
    // Ignore storage failures.
  }
}

/** Returns the stored match only when it is still unfinished and therefore resumable. */
export function loadLocalMatch(): StoredLocalMatch | null {
  const record = readRecord();
  if (!record?.state || record.winnerName) return null;
  return {
    state: record.state,
    sides: record.sides,
    savedAt: record.savedAt
  };
}

export function clearLocalMatch(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}
