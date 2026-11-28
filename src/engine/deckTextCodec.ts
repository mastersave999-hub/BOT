import type { Card } from './types';
import { validateDeck, type DeckValidationResult } from './deckValidator';

/**
 * One-paste community deck list codec (Rulebook v3.2 authoritative via validateDeck).
 *
 * Community format:
 *   สุดโหด
 *
 *   Main Deck
 *
 *   2x B2SA-008-SR
 *   1x BT01-039-R
 *
 *   Life Cards
 *
 *   1x BT05-072-C
 *
 * Catalog printIds carry no rarity suffix (e.g. "B2SA-008"), so import strips
 * trailing rarity suffixes when an exact match fails. Export always emits the
 * catalog printId so export -> import round-trips exactly.
 */

export interface UnknownCodeEntry {
  code: string;
  lineNumber: number;
  raw: string;
}

export interface DeckTextParseResult {
  /** Detected title line, or null when the list has no title header. */
  deckName: string | null;
  mainDeck: Card[];
  lifeDeck: Card[];
  /** Codes that matched no catalog card, with their source line numbers. */
  unknownCodes: UnknownCodeEntry[];
  /** Non-card, non-header lines that were ignored (after the title). */
  warnings: string[];
  counts: { main: number; life: number };
  /** Authoritative Rulebook v3.2 check over the assembled decks. */
  validation: DeckValidationResult;
}

const SECTION_MAIN = ['main deck', 'main', 'เด็คหลัก', 'เด็คหลักของฉัน'] as const;
const SECTION_LIFE = ['life cards', 'life deck', 'life', 'การ์ดชีวิต', 'เด็คชีวิต', 'ชีวิต'] as const;

/** Rarity suffixes seen in community lists; stripped right-to-left on miss. */
const RARITY_SUFFIXES = ['C', 'R', 'SR', 'SSR', 'UR', 'SCR', 'PR', 'AR', 'SEC', 'SP', 'L', 'P'] as const;

/** "2x CODE", "2X CODE", "2× CODE", "x2 CODE", "×2 CODE" — extra whitespace tolerated. */
const COUNT_PREFIX_RE = /^(\d+)\s*[xX×]\s*(.+)$/;
const COUNT_SUFFIX_RE = /^[xX×]\s*(\d+)\s+(.+)$/;

function parseCardLine(line: string): { code: string; count: number } | null {
  const prefix = line.match(COUNT_PREFIX_RE);
  if (prefix) return { count: Number(prefix[1]), code: prefix[2].trim() };
  const suffix = line.match(COUNT_SUFFIX_RE);
  if (suffix) return { count: Number(suffix[1]), code: suffix[2].trim() };
  return null;
}

function matchSectionHeader(line: string): 'main' | 'life' | null {
  const normalized = line.replace(/[:：]\s*$/, '').trim().toLowerCase();
  if (SECTION_MAIN.includes(normalized as (typeof SECTION_MAIN)[number])) return 'main';
  if (SECTION_LIFE.includes(normalized as (typeof SECTION_LIFE)[number])) return 'life';
  return null;
}

function stripRaritySuffix(code: string): string | null {
  const match = code.match(/^(.+)-([A-Za-z]+)$/);
  if (!match) return null;
  const [, base, suffix] = match;
  if (!RARITY_SUFFIXES.includes(suffix.toUpperCase() as (typeof RARITY_SUFFIXES)[number])) return null;
  return base;
}

/**
 * Resolves one community code against the catalog: exact printId first, then
 * case-insensitive, then by progressively stripping trailing rarity suffixes
 * (B2SA-008-SR -> B2SA-008, PRMO-0562-C -> PRMO-0562).
 */
export function resolveCardCode(code: string, catalog: Card[]): Card | null {
  const trimmed = code.trim();
  if (!trimmed) return null;
  const exact = catalog.find(card => card.printId === trimmed);
  if (exact) return exact;
  const insensitive = catalog.find(card => card.printId.toLowerCase() === trimmed.toLowerCase());
  if (insensitive) return insensitive;

  let candidate = trimmed;
  while (true) {
    const stripped = stripRaritySuffix(candidate);
    if (!stripped) return null;
    const match = catalog.find(card => card.printId === stripped) ??
      catalog.find(card => card.printId.toLowerCase() === stripped.toLowerCase());
    if (match) return match;
    candidate = stripped;
  }
}

export function parseDeckText(
  text: string,
  catalog: Card[],
  fallbackDeckName: string
): DeckTextParseResult {
  const lines = text.split(/\r?\n/);
  const mainDeck: Card[] = [];
  const lifeDeck: Card[] = [];
  const unknownCodes: UnknownCodeEntry[] = [];
  const warnings: string[] = [];
  let deckName: string | null = null;
  // null = no header seen yet (auto-route by card type); otherwise strict routing.
  let section: 'main' | 'life' | null = null;
  let sawLifeHeader = false;

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const line = raw.trim();
    if (!line) continue;

    const header = matchSectionHeader(line);
    if (header) {
      section = header;
      if (header === 'life') sawLifeHeader = true;
      continue;
    }

    const cardLine = parseCardLine(line);
    if (cardLine) {
      if (!Number.isSafeInteger(cardLine.count) || cardLine.count < 1 || cardLine.count > 99) {
        warnings.push(`จำนวนไม่ถูกต้อง (บรรทัด ${index + 1}): "${line}"`);
        continue;
      }
      const card = resolveCardCode(cardLine.code, catalog);
      if (!card) {
        unknownCodes.push({ code: cardLine.code, lineNumber: index + 1, raw: line });
        continue;
      }
      // Strict section routing once a Life header exists; otherwise auto-route
      // by card type so header-less community lists still split correctly.
      const destination = sawLifeHeader
        ? (section === 'life' ? lifeDeck : mainDeck)
        : (card.type === 'Life' ? lifeDeck : mainDeck);
      for (let copy = 0; copy < cardLine.count; copy++) destination.push(card);
      continue;
    }

    // Non-card line before any section header: the deck title (first one wins).
    if (section === null && deckName === null) {
      deckName = line;
      continue;
    }
    warnings.push(`ข้ามบรรทัดที่ไม่รู้จัก (บรรทัด ${index + 1}): "${line}"`);
  }

  const validation = validateDeck(mainDeck, lifeDeck);
  return {
    deckName,
    mainDeck,
    lifeDeck,
    unknownCodes,
    warnings,
    counts: { main: mainDeck.length, life: lifeDeck.length },
    validation
  };
}

/** Applies a parsed result to deck state, keeping the current name when the list had no title. */
export function applyParsedDeck(
  parsed: DeckTextParseResult,
  fallbackDeckName: string
): { mainDeck: Card[]; lifeDeck: Card[]; deckName: string } {
  return {
    mainDeck: parsed.mainDeck,
    lifeDeck: parsed.lifeDeck,
    deckName: parsed.deckName ?? fallbackDeckName
  };
}

/**
 * Exports decks back into the clean community text format. Cards are grouped by
 * printId with counts and sorted by code so the output is deterministic and
 * round-trips through parseDeckText.
 */
export function formatDeckToText(mainDeck: Card[], lifeDeck: Card[], deckName: string): string {
  const group = (cards: Card[]): string[] => {
    const counts = new Map<string, number>();
    for (const card of cards) counts.set(card.printId, (counts.get(card.printId) ?? 0) + 1);
    return Array.from(counts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([printId, count]) => `${count}x ${printId}`);
  };

  const sections: string[] = [deckName.trim() || 'เด็คของฉัน', '', 'Main Deck', '', ...group(mainDeck)];
  if (lifeDeck.length > 0) {
    sections.push('', 'Life Cards', '', ...group(lifeDeck));
  }
  return sections.join('\n');
}
