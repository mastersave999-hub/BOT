import { Card } from './types';
import { parseCardNameRules } from './cardTextAdapter';

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

  // Rule 4: enforce primary-name caps; secondary aliases permit up to eight combined copies.
  const nameCounts = new Map<string, number>();
  const secondaryPairs = new Set<string>();
  let onlyOneCount = 0;

  for (const card of mainDeck) {
    const rules = parseCardNameRules(card);
    const primaryNames = [card.name, ...rules.additionalPrimaryNames];
    for (const name of new Set(primaryNames)) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    for (const alias of rules.secondaryNames) {
      const pair = [card.name, alias].sort().join('\\u0000');
      secondaryPairs.add(pair);
    }
    if (card.isOnlyOne) onlyOneCount++;
    if (card.isBias) errors.push(`Card "${card.name}" has symbol "ลำเอียง" and is forbidden in standard competition [RuleBook p.1, p.5]`);
  }

  for (const [name, count] of nameCounts) {
    if (count > 4) errors.push(`Card "${name}" exceeds maximum allowed 4 copies (found: ${count}) [RuleBook p.1]`);
  }
  for (const pair of secondaryPairs) {
    const [primaryName, secondaryName] = pair.split('\\u0000');
    const combined = (nameCounts.get(primaryName) ?? 0) + (nameCounts.get(secondaryName) ?? 0);
    if (combined > 8) errors.push(`Cards named "${primaryName}" and secondary alias "${secondaryName}" exceed 8 combined copies (found: ${combined}) [RuleBook p.14]`);
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
