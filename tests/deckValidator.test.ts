import { describe, it, expect } from 'vitest';
import { validateDeck } from '../src/engine/deckValidator.js';
import { Card } from '../src/engine/types.js';

function createDummyCard(id: string, name: string, isOnlyOne = false, isBias = false): Card {
  return {
    printId: id,
    name,
    type: 'Avatar',
    cost: 2,
    gem: 1,
    power: 2,
    color: 'แดง',
    rarity: 'C',
    isOnlyOne,
    isBias,
    isCollab: false,
    mainEffect: '',
    imageUrl: `https://cdn.bottcg.com/cards/${id}.png`
  };
}

function createLifeCard(id: string, name: string): Card {
  return { ...createDummyCard(id, name), type: 'Life' };
}

describe('Deck Validator (Official Rule Book 3.2)', () => {
  it('should accept a valid 50-card Main Deck with exactly 1 Only#1 card and 5 unique LIFE cards', () => {
    const mainDeck: Card[] = [];
    // 48 normal cards (12 unique names x 4 copies)
    for (let i = 1; i <= 12; i++) {
      for (let j = 0; j < 4; j++) {
        mainDeck.push(createDummyCard(`SD01-${i.toString().padStart(3, '0')}`, `Avatar ${i}`));
      }
    }
    // 1 regular card
    mainDeck.push(createDummyCard('SD01-013', 'Avatar 13'));
    // 1 Only #1 card
    mainDeck.push(createDummyCard('SD01-014', 'Super Hero', true));

    // 5 unique LIFE cards
    const lifeDeck: Card[] = [
      createLifeCard('LIFE-001', 'Life 1'),
      createLifeCard('LIFE-002', 'Life 2'),
      createLifeCard('LIFE-003', 'Life 3'),
      createLifeCard('LIFE-004', 'Life 4'),
      createLifeCard('LIFE-005', 'Life 5')
    ];

    const result = validateDeck(mainDeck, lifeDeck);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject a Main Deck with wrong card count', () => {
    const mainDeck = [createDummyCard('SD01-001', 'Card 1', true)];
    const lifeDeck = [createLifeCard('LIFE-001', 'Life 1')];

    const result = validateDeck(mainDeck, lifeDeck);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('exactly 50 cards'))).toBe(true);
    expect(result.errors.some(e => e.includes('exactly 5 cards'))).toBe(true);
  });

  it('should reject LIFE Deck with duplicate names', () => {
    const mainDeck = Array(49).fill(null).map((_, i) => createDummyCard(`C-${i}`, `Name-${Math.floor(i/4)}`));
    mainDeck.push(createDummyCard('ONLY-1', 'Only One Boss', true));

    const duplicateLifeDeck = [
      createLifeCard('L-1', 'Twin Life'),
      createLifeCard('L-2', 'Twin Life'), // Duplicate name!
      createLifeCard('L-3', 'Life 3'),
      createLifeCard('L-4', 'Life 4'),
      createLifeCard('L-5', 'Life 5')
    ];

    const result = validateDeck(mainDeck, duplicateLifeDeck);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('unique names'))).toBe(true);
  });

  it('should reject more than 4 copies of the same card', () => {
    const mainDeck: Card[] = [];
    for (let i = 0; i < 5; i++) {
      mainDeck.push(createDummyCard(`C-${i}`, 'Overused Card'));
    }
    while (mainDeck.length < 49) {
      mainDeck.push(createDummyCard(`F-${mainDeck.length}`, `Filler ${mainDeck.length}`));
    }
    mainDeck.push(createDummyCard('ONLY-1', 'Only One', true));

    const lifeDeck = Array(5).fill(null).map((_, i) => createLifeCard(`L-${i}`, `Unique Life ${i}`));
    const result = validateDeck(mainDeck, lifeDeck);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('exceeds maximum allowed 4 copies'))).toBe(true);
  });

  it('should reject decks containing ลำเอียง (Bias) cards', () => {
    const mainDeck = Array(49).fill(null).map((_, i) => createDummyCard(`C-${i}`, `Card ${i}`));
    mainDeck[0] = createDummyCard('PROMO-1', 'Promo Biased Card', false, true); // Bias card
    mainDeck.push(createDummyCard('ONLY-1', 'Only One', true));

    const lifeDeck = Array(5).fill(null).map((_, i) => createLifeCard(`L-${i}`, `Unique Life ${i}`));
    const result = validateDeck(mainDeck, lifeDeck);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('ลำเอียง'))).toBe(true);
  });
});
