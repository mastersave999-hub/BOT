import { describe, it, expect } from 'vitest';
import { Card } from '../src/engine/types';
import { parseDeckText, formatDeckToText, resolveCardCode } from '../src/engine/deckTextCodec';
import cardsData from '../cards_clean.json';

const catalog = cardsData as Card[];

/** The exact "สุดโหด" community deck list: 50 Main + 5 LIFE, all codes with rarity suffixes. */
const SUD_HOD_TEXT = `สุดโหด

Main Deck

4x SD01-001-SR
4x SD01-002-R
4x SD01-003-C
4x SD01-004-SR
4x SD01-006-R
4x SD01-007-SR
4x SD01-008-R
4x SD01-009-C
4x SD01-010-SR
4x SD01-011-R
4x SD01-012-SR
3x SD01-013-R
1x SD01-005-C
2x SD01-014-SR

Life Cards

1x SD01-021-SR
1x SD01-022-R
1x SD01-023-C
1x SD01-024-SR
1x SD01-025-R`;

describe('resolveCardCode', () => {
  it('matches exact catalog printId first', () => {
    expect(resolveCardCode('SD01-001', catalog)?.printId).toBe('SD01-001');
  });

  it('strips a trailing rarity suffix (B2SA-008-SR -> B2SA-008)', () => {
    expect(resolveCardCode('B2SA-008-SR', catalog)?.printId).toBe('B2SA-008');
  });

  it('strips single-letter rarity suffixes (PRMO-0562-C, KD03-022-C)', () => {
    expect(resolveCardCode('PRMO-0562-C', catalog)?.printId).toBe('PRMO-0562');
    expect(resolveCardCode('KD03-022-C', catalog)?.type).toBe('Life');
  });

  it('matches case-insensitively when exact case fails', () => {
    expect(resolveCardCode('sd01-001', catalog)?.printId).toBe('SD01-001');
  });

  it('returns null for codes that match nothing', () => {
    expect(resolveCardCode('XXXX-9999-SR', catalog)).toBeNull();
    expect(resolveCardCode('', catalog)).toBeNull();
  });
});

describe('parseDeckText — "สุดโหด" community deck list', () => {
  const parsed = parseDeckText(SUD_HOD_TEXT, catalog, 'เด็คหลักของฉัน');

  it('detects the deck title header', () => {
    expect(parsed.deckName).toBe('สุดโหด');
  });

  it('resolves all 50 Main cards through rarity suffix stripping', () => {
    expect(parsed.counts.main).toBe(50);
    expect(parsed.mainDeck.every(card => card.type !== 'Life')).toBe(true);
    expect(parsed.unknownCodes).toHaveLength(0);
  });

  it('resolves all 5 LIFE cards through the Life Cards section', () => {
    expect(parsed.counts.life).toBe(5);
    expect(parsed.lifeDeck.every(card => card.type === 'Life')).toBe(true);
  });

  it('passes the authoritative Rulebook v3.2 validateDeck check', () => {
    expect(parsed.validation.isValid).toBe(true);
    expect(parsed.validation.errors).toHaveLength(0);
  });

  it('keeps the Only #1 card exactly once', () => {
    expect(parsed.mainDeck.filter(card => card.isOnlyOne)).toHaveLength(1);
  });
});

describe('parseDeckText — flexible line formats', () => {
  it('accepts 2X, 2×, x2 and extra whitespace', () => {
    const text = [
      'Main Deck',
      '2X SD01-001',
      '2× SD01-002',
      'x2  SD01-003',
      '  3x   SD01-006  ',
      ''
    ].join('\n');
    const parsed = parseDeckText(text, catalog, 'fallback');
    expect(parsed.counts.main).toBe(9);
    expect(parsed.unknownCodes).toHaveLength(0);
  });

  it('recognizes section headers case-insensitively, including Thai', () => {
    const text = [
      'MAIN DECK',
      '2x SD01-001',
      'LIFE CARDS',
      '1x SD01-021'
    ].join('\n');
    const parsed = parseDeckText(text, catalog, 'fallback');
    expect(parsed.counts.main).toBe(2);
    expect(parsed.counts.life).toBe(1);
  });

  it('auto-routes Life-type cards when no Life header is present', () => {
    const text = [
      'เด็คหลัก',
      '2x SD01-001',
      '1x SD01-021'
    ].join('\n');
    const parsed = parseDeckText(text, catalog, 'fallback');
    expect(parsed.counts.main).toBe(2);
    expect(parsed.counts.life).toBe(1);
    expect(parsed.lifeDeck[0].type).toBe('Life');
  });

  it('falls back to the current slot name when no title line exists', () => {
    const parsed = parseDeckText('Main Deck\n1x SD01-001', catalog, 'เด็คหลักของฉัน');
    expect(parsed.deckName).toBeNull();
  });

  it('reports unknown codes with their line numbers', () => {
    const text = [
      'Main Deck',
      '2x SD01-001',
      '1x FAKE-1234-XYZ',
      '',
      'Life Cards',
      '1x NOT-REAL-C'
    ].join('\n');
    const parsed = parseDeckText(text, catalog, 'fallback');
    expect(parsed.unknownCodes).toEqual([
      { code: 'FAKE-1234-XYZ', lineNumber: 3, raw: '1x FAKE-1234-XYZ' },
      { code: 'NOT-REAL-C', lineNumber: 6, raw: '1x NOT-REAL-C' }
    ]);
    expect(parsed.counts.main).toBe(2);
  });
});

describe('parseDeckText — Rulebook v3.2 violations', () => {
  it('flags more than 4 copies of one card', () => {
    const text = ['Main Deck', '5x SD01-001', '1x SD01-005'].join('\n');
    const parsed = parseDeckText(text, catalog, 'fallback');
    expect(parsed.validation.isValid).toBe(false);
    expect(parsed.validation.errors.some(error => error.includes('exceeds maximum allowed 4 copies'))).toBe(true);
  });

  it('flags a Main Deck without exactly one Only #1 card', () => {
    const text = ['Main Deck', '2x SD01-001'].join('\n');
    const parsed = parseDeckText(text, catalog, 'fallback');
    expect(parsed.validation.errors.some(error => error.includes('Only #1'))).toBe(true);
  });

  it('flags duplicate LIFE card names', () => {
    const text = ['Life Cards', '2x SD01-021'].join('\n');
    const parsed = parseDeckText(text, catalog, 'fallback');
    expect(parsed.validation.errors.some(error => error.includes('unique names'))).toBe(true);
  });

  it('flags LIFE cards placed in the Main Deck via strict section routing', () => {
    // A Life header present means strict routing: a later Life-type card under
    // the Main Deck header stays in Main and validateDeck must reject it.
    const text = ['Life Cards', '1x SD01-021', 'Main Deck', '1x SD01-022'].join('\n');
    const parsed = parseDeckText(text, catalog, 'fallback');
    expect(parsed.mainDeck).toHaveLength(1);
    expect(parsed.validation.errors.some(error => error.includes('Main Deck cannot contain LIFE cards'))).toBe(true);
  });

  it('flags wrong deck sizes', () => {
    const parsed = parseDeckText('Main Deck\n1x SD01-001', catalog, 'fallback');
    expect(parsed.validation.errors.some(error => error.includes('exactly 50'))).toBe(true);
    expect(parsed.validation.errors.some(error => error.includes('exactly 5'))).toBe(true);
  });
});

describe('formatDeckToText — symmetric exporter', () => {
  it('emits the clean community format with grouped counts', () => {
    const mainDeck = [catalog.find(c => c.printId === 'SD01-001')!, catalog.find(c => c.printId === 'SD01-001')!];
    const lifeDeck = [catalog.find(c => c.printId === 'SD01-021')!];
    const text = formatDeckToText(mainDeck, lifeDeck, 'สุดโหด');
    const lines = text.split('\n');
    expect(lines[0]).toBe('สุดโหด');
    expect(lines).toContain('Main Deck');
    expect(lines).toContain('Life Cards');
    expect(lines.filter(line => line === '2x SD01-001')).toHaveLength(1);
    expect(lines).toContain('1x SD01-021');
  });

  it('round-trips export -> import with identical decks and name', () => {
    const parsed = parseDeckText(SUD_HOD_TEXT, catalog, 'เด็คหลักของฉัน');
    const exported = formatDeckToText(parsed.mainDeck, parsed.lifeDeck, parsed.deckName ?? 'เด็คหลักของฉัน');
    const reparsed = parseDeckText(exported, catalog, 'เด็คหลักของฉัน');

    expect(reparsed.deckName).toBe('สุดโหด');
    expect(reparsed.counts).toEqual(parsed.counts);
    expect(reparsed.unknownCodes).toHaveLength(0);
    // Exporter groups and sorts by printId, so compare multiset order-insensitively.
    expect(reparsed.mainDeck.map(card => card.printId).sort()).toEqual(parsed.mainDeck.map(card => card.printId).sort());
    expect(reparsed.lifeDeck.map(card => card.printId).sort()).toEqual(parsed.lifeDeck.map(card => card.printId).sort());
    expect(reparsed.validation.isValid).toBe(true);
  });
});
