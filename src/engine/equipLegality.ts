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

type EquipRestriction = {
  name?: { value: string; quoted: boolean };
  symbol?: string;
  color?: string;
  textBox?: string;
};

function equipRestriction(card: Card): EquipRestriction | null | undefined {
  const text = card.mainEffect ?? '';
  if (!/สวมใส่ได้(?:เฉพาะ|แค่)/u.test(text)) return null;
  const phrase = text.match(/สวมใส่ได้(?:เฉพาะ|แค่)\s+([\s\S]{1,180})/u)?.[1];
  if (!phrase) return undefined;
  const restrictionText = phrase.split(/เท่านั้น|(?=Avatar\s+ที่สวมใส่การ์ดใบนี้)/u, 1)[0].trim();
  const textBox = restrictionText.match(/Avatar\s+ที่มี\s*["“]([^"”]+)["”]\s*อยู่ใน\s*Text Box/u)?.[1]?.trim();
  const symbol = restrictionText.match(/(?:\{\s*symbol\s+([^}]+)\}|\bSymbol\s+([\p{L}\p{N}ก-๙_-]+))/iu);
  const color = restrictionText.match(/สี\s*(แดง|ฟ้า|เขียว|ม่วง|ไร้สี)/u)?.[1];
  const quotedName = textBox ? undefined : restrictionText.match(/["“]([^"”]+)["”]/u)?.[1]?.trim();
  const plainName = restrictionText.replace(/^Avatar\s*/iu, '').replace(/\{\s*symbol\s+[^}]+\}|\bSymbol\s+[\p{L}\p{N}ก-๙_-]+/giu, '')
    .replace(/สี\s*(?:แดง|ฟ้า|เขียว|ม่วง|ไร้สี)|ที่เป็น|อยู่ใน Text Box/gu, '')
    .replace(/["“][^"”]+["”]/gu, '').trim();
  const name = quotedName ?? (plainName && plainName !== 'ที่มี' ? plainName : undefined);
  return {
    ...(name ? { name: { value: name, quoted: quotedName !== undefined } } : {}),
    ...(symbol ? { symbol: (symbol[1] ?? symbol[2]).trim() } : {}),
    ...(color ? { color } : {}), ...(textBox ? { textBox } : {})
  };
}

/** Rule Book 3.2 pp.13, 18: every declared equip criterion must match its host. */
export function checkModificationEquip(modification: Card, target: Card): EquipLegalityResult {
  if (target.type !== 'Avatar') return { legal: false, restricted: true, reason: 'Modification Magic can only equip an Avatar' };
  const restriction = equipRestriction(modification);
  if (restriction === null) return { legal: true, restricted: false };
  if (!restriction) return { legal: false, restricted: true, reason: 'Equip restriction is not fully parseable' };
  const valid = (!restriction.name || (restriction.name.quoted
    ? matchesQuotedWordSequence(target.name, restriction.name.value)
    : target.name.trim() === restriction.name.value)) &&
    (!restriction.symbol || !!target.symbol?.includes(restriction.symbol)) &&
    (!restriction.color || target.color === restriction.color) &&
    (!restriction.textBox || (target.mainEffect ?? '').normalize('NFC').includes(restriction.textBox.normalize('NFC')));
  return valid ? { legal: true, restricted: true } : {
    legal: false, restricted: true,
    reason: 'Modification Magic equip criteria do not match the Avatar'
  };
}
