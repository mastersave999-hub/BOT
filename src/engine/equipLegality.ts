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

type EquipRestriction =
  | { kind: 'NAME'; name: string; quoted: boolean }
  | { kind: 'SYMBOL'; symbol: string }
  | { kind: 'TEXT_BOX'; phrase: string };

function equipRestriction(card: Card): EquipRestriction | null | undefined {
  const text = card.mainEffect ?? '';
  if (!text.includes('สวมใส่ได้เฉพาะ')) return null;
  const textBox = text.match(/สวมใส่ได้เฉพาะ\s+Avatar\s+ที่มี\s*["“]([^"”]+)["”]\s*อยู่ใน\s*Text Box/u);
  if (textBox) return { kind: 'TEXT_BOX', phrase: textBox[1].trim() };
  const symbol = text.match(/สวมใส่ได้เฉพาะ\s+Avatar\s*\{\s*symbol\s+([^}]+)\}/i);
  if (symbol) return { kind: 'SYMBOL', symbol: symbol[1].trim() };
  const match = text.match(/สวมใส่ได้เฉพาะ\s+(?:Avatar\s+)?(?:""([^"]+)""|"([^"]+)"|“([^”]+)”|([^\n.。]+?))(?=\s+เท่านั้น(?:\s|$)|[.。]|\n|$)/u);
  if (!match) return undefined;
  const quotedName = match[1] ?? match[2] ?? match[3];
  const name = (quotedName ?? match[4])?.trim();
  return name ? { kind: 'NAME', name, quoted: quotedName !== undefined } : undefined;
}

/** Rule Book 3.2 pp.13, 18: quoted names are word-sequence matches; unquoted names are exact. */
export function checkModificationEquip(modification: Card, target: Card): EquipLegalityResult {
  if (target.type !== 'Avatar') return { legal: false, restricted: true, reason: 'Modification Magic can only equip an Avatar' };
  const restriction = equipRestriction(modification);
  if (restriction === null) return { legal: true, restricted: false };
  if (!restriction) return { legal: false, restricted: true, reason: 'Equip restriction is not fully parseable' };
  if (restriction.kind === 'SYMBOL') {
    const legal = target.symbol?.includes(restriction.symbol) ?? false;
    return legal ? { legal: true, restricted: true }
      : { legal: false, restricted: true, reason: `Modification Magic requires Avatar Symbol ${restriction.symbol}` };
  }
  if (restriction.kind === 'TEXT_BOX') {
    const legal = (target.mainEffect ?? '').normalize('NFC').includes(restriction.phrase.normalize('NFC'));
    return legal ? { legal: true, restricted: true }
      : { legal: false, restricted: true, reason: `Modification Magic requires “${restriction.phrase}” in the Avatar Text Box` };
  }
  const legal = restriction.quoted
    ? matchesQuotedWordSequence(target.name, restriction.name)
    : target.name.trim() === restriction.name;
  return legal
    ? { legal: true, restricted: true }
    : { legal: false, restricted: true, reason: `Modification Magic requires Avatar ${restriction.quoted ? `containing “${restriction.name}” as a separate word` : `named exactly “${restriction.name}”`}` };
}
