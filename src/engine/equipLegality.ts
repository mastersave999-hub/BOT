import type { Card } from './types';

export interface EquipLegalityResult {
  legal: boolean;
  restricted: boolean;
  reason?: string;
}

function matchesQuotedWordSequence(cardName: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s\\p{P}])${escaped}(?=$|[\\s\\p{P}])`, 'u').test(cardName);
}

function equipRestriction(card: Card): { name: string; quoted: boolean } | null | undefined {
  const text = card.mainEffect ?? '';
  if (!text.includes('สวมใส่ได้เฉพาะ')) return null;
  const match = text.match(/สวมใส่ได้เฉพาะ\s+(?:Avatar\s+)?(?:"([^"]+)"|“([^”]+)”|([^\n.。]+?))(?=\s+เท่านั้น(?:\s|$)|[.。]|\n|$)/u);
  if (!match) return undefined;
  const quotedName = match[1] ?? match[2];
  const name = (quotedName ?? match[3])?.trim();
  return name ? { name, quoted: quotedName !== undefined } : undefined;
}

/** Rule Book 3.2 pp.13, 18: quoted names are word-sequence matches; unquoted names are exact. */
export function checkModificationEquip(modification: Card, target: Card): EquipLegalityResult {
  if (target.type !== 'Avatar') return { legal: false, restricted: true, reason: 'Modification Magic can only equip an Avatar' };
  const restriction = equipRestriction(modification);
  if (restriction === null) return { legal: true, restricted: false };
  if (!restriction) return { legal: false, restricted: true, reason: 'Equip restriction is not fully parseable' };
  const legal = restriction.quoted
    ? matchesQuotedWordSequence(target.name, restriction.name)
    : target.name.trim() === restriction.name;
  return legal
    ? { legal: true, restricted: true }
    : { legal: false, restricted: true, reason: `Modification Magic requires Avatar ${restriction.quoted ? `containing “${restriction.name}” as a separate word` : `named exactly “${restriction.name}”`}` };
}
