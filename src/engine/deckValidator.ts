import { Card } from './types';

export interface DeckValidationResult {
  isValid: boolean;
  errors: string[];
}

export function validateDeck(mainDeck: Card[], lifeDeck: Card[]): DeckValidationResult {
  const errors: string[] = [];

  // Rule 1: Main deck must be exactly 50 cards
  if (mainDeck.length !== 50) {
    errors.push(`Main Deck must contain exactly 50 cards (current: ${mainDeck.length}) [RuleBook p.1]`);
  }

  // Rule 2: Life deck must be exactly 5 cards
  if (lifeDeck.length !== 5) {
    errors.push(`LIFE Deck must contain exactly 5 cards (current: ${lifeDeck.length}) [RuleBook p.1]`);
  }

  // LIFE cards belong exclusively to the separate LIFE Deck (Rule Book 3.2, p.1).
  if (mainDeck.some(card => card.type === 'Life')) {
    errors.push('Main Deck cannot contain LIFE cards; they must remain in the separate LIFE Deck [RuleBook p.1]');
  }
  if (lifeDeck.some(card => card.type !== 'Life')) {
    errors.push('LIFE Deck can contain only LIFE cards [RuleBook p.1]');
  }

  // Rule 3: Life deck cards must have unique names
  const lifeNames = new Set<string>();
  for (const card of lifeDeck) {
    if (lifeNames.has(card.name)) {
      errors.push(`LIFE Deck cards must all have unique names. Duplicate found: "${card.name}" [RuleBook p.1, p.5]`);
    }
    lifeNames.add(card.name);
  }

  // Rule 4: Max 4 copies per card name in Main Deck (excluding dual/secondary name rules)
  const nameCounts: Record<string, number> = {};
  let onlyOneCount = 0;

  for (const card of mainDeck) {
    nameCounts[card.name] = (nameCounts[card.name] || 0) + 1;
    if (card.isOnlyOne) {
      onlyOneCount++;
    }
    if (card.isBias) {
      errors.push(`Card "${card.name}" has symbol "ลำเอียง" and is forbidden in standard competition [RuleBook p.1, p.5]`);
    }
  }

  for (const [name, count] of Object.entries(nameCounts)) {
    if (count > 4) {
      errors.push(`Card "${name}" exceeds maximum allowed 4 copies (found: ${count}) [RuleBook p.1]`);
    }
  }

  // Rule 5: Exactly 1 "Only #1" card in Main Deck
  if (onlyOneCount !== 1) {
    errors.push(`Main Deck must contain exactly 1 card with symbol "Only #1" (found: ${onlyOneCount}) [RuleBook p.1, p.5]`);
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}
