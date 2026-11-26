import type { Card, MagicSubtype } from './types';
import type { EffectDefinition } from './effectResolver';

export type CardTextEffect = { kind: 'draw_self'; count: number };

export function toEffectDefinitions(effects: CardTextEffect[], actorId: string): EffectDefinition[] {
  return effects.map(effect => ({ kind: 'draw', playerId: actorId, count: effect.count }));
}

export type CardTextStatus = 'PARSED_READY' | 'UNSUPPORTED' | 'AMBIGUOUS';
export type CardTextKeyword =
  | 'จุติ' | 'คำสั่งเสีย' | 'พอดี' | 'สอดแนม' | 'ธรณีสูบ' | 'เลือกปฏิบัติ'
  | 'สามัคคี' | 'โล่มนุษย์' | 'เตะไข่' | 'ลูกฮึด' | 'แทงหลัง' | 'เนรเทศ'
  | 'เทิร์นละครั้ง' | 'ต่อเนื่อง' | 'สั่งใช้' | 'อัตโนมัติ' | 'คู่หู';
export type NameReference =
  | { kind: 'quoted-word'; value: string; matching: 'DELIMITED_WORD_SEQUENCE' }
  | { kind: 'exact-name'; value: string; matching: 'EXACT_CARD_NAME' };
export interface ParsedCardTextClause {
  source: string;
  costText?: string;
  effectText: string;
  costEffectSeparator: ':' | null;
  keywords: CardTextKeyword[];
  quotedReferences: NameReference[];
  exactNameReferences: NameReference[];
  effects: CardTextEffect[];
  unresolved: string[];
}
export interface CardTextAdapterResult {
  status: CardTextStatus;
  reason?: string;
  attributes: Omit<Card, 'mainEffect' | 'imageUrl'>;
  ruleTexts: string[];
  clauses: ParsedCardTextClause[];
  magicUse: {
    abilityConsumesMagicType?: MagicSubtype;
    magicSubtypeOverride?: MagicSubtype;
  };
}

const KEYWORDS: CardTextKeyword[] = [
  'จุติ', 'คำสั่งเสีย', 'พอดี', 'สอดแนม', 'ธรณีสูบ', 'เลือกปฏิบัติ', 'สามัคคี',
  'โล่มนุษย์', 'เตะไข่', 'ลูกฮึด', 'แทงหลัง', 'เนรเทศ', 'เทิร์นละครั้ง',
  'ต่อเนื่อง', 'สั่งใช้', 'อัตโนมัติ', 'คู่หู'
];
const MAGIC_TYPES: Record<string, MagicSubtype> = {
  Normal: 'Normal', Modification: 'Modification', React: 'React', Land: 'Land'
};
const KNOWN_UNRESOLVED = [
  ['conditional expression requires a typed condition parser', /(?:ถ้า|หาก|เมื่อ|ตราบเท่าที่)\s*/],
  ['target selection or target legality is not represented by this clause grammar', /(?:เลือก|เป้าหมาย|เป้าหมายโจมตี)/],
  ['zone choice, search, or ordering needs a typed choice plan', /(?:จาก Deck|จากใน Deck|จากนรก|สอดแนม|ธรณีสูบ|สับ Deck|เรียงและนำ)/i],
  ['state-changing effect has no verified typed translation', /(?:POWER|ทำลาย|จั่ว|นำขึ้นมือ|กลับขึ้นมือ|อัญเชิญ|เปลี่ยน|ป้องกัน|ยกเลิก|เนรเทศ|ทิ้ง|เซ่นไหว้|สังเวย)/i],
  ['duration requires explicit rule-timed representation', /(?:จนจบ|ตราบเท่าที่|ตลอดเกม|ตลอดไป)/],
  ['unrecognized mechanic or free-form clause', /.+/s]
] as const;
const AMBIGUOUS_WORDING = /(?:ตัวอะไรสักอย่าง|ตามเงื่อนไขที่ไม่ระบุ|ไม่ชัดเจน|หรือไม่ก็แล้วแต่)/;

function splitCostEffect(source: string): { costText?: string; effectText: string; separator: ':' | null } {
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '"') quoted = !quoted;
    if (source[index] === ':' && !quoted) {
      const costText = source.slice(0, index).trim();
      const effectText = source.slice(index + 1).trim();
      if (!costText || !effectText) return { effectText: source.trim(), separator: null };
      return { costText, effectText, separator: ':' };
    }
  }
  return { effectText: source.trim(), separator: null };
}

export function createNameReference(value: string, quoted: boolean): NameReference {
  const normalized = value.trim();
  return quoted
    ? { kind: 'quoted-word', value: normalized, matching: 'DELIMITED_WORD_SEQUENCE' }
    : { kind: 'exact-name', value: normalized, matching: 'EXACT_CARD_NAME' };
}

/** Rule Book 3.2 p.13: quoted names match a separated word sequence; unquoted names match exactly. */
export function matchesCardName(cardName: string, reference: NameReference): boolean {
  if (reference.kind === 'exact-name') return cardName.trim() === reference.value;
  // Thai dictionary segmentation can split compounds (e.g. นาย in นายนิรยบาล).
  // Only accept an explicitly delimited phrase; ambiguous unspaced matches fail closed.
  const escape = reference.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s\\p{P}])${escape}(?=$|[\\s\\p{P}])`, 'u').test(cardName);
}

function parseClause(source: string): ParsedCardTextClause {
  const split = splitCostEffect(source);
  const quotedReferences = [...split.effectText.matchAll(/"([^"]+)"/g)].map(match => createNameReference(match[1], true));
  const exactNameReferences = [...split.effectText.matchAll(/ชื่อ\s+([^"“”,:()]+?)(?=\s+(?:\d+\s*ใบ|จาก|บน|ได้|เท่านั้น)|[,.:：]|$)/g)]
    .map(match => createNameReference(match[1].trim(), false));
  const keywords = KEYWORDS.filter(keyword => source.includes(keyword));
  const draw = split.effectText.match(/^จั่วการ์ด(?:จาก\s+Deck(?:\s+เรา)?)?\s+(\d+)\s*ใบ$/);
  const effects: CardTextEffect[] = draw ? [{ kind: 'draw_self', count: Number(draw[1]) }] : [];
  const unresolved: string[] = effects.length > 0 ? [] : KNOWN_UNRESOLVED
    .filter(([, pattern]) => pattern.test(split.effectText))
    .map(([reason]) => reason);
  if (split.costText) {
    unresolved.push('cost payment requires a typed cost plan and atomic feasibility validation');
  }
  return {
    source,
    ...(split.costText ? { costText: split.costText } : {}),
    effectText: split.effectText,
    costEffectSeparator: split.separator,
    keywords,
    quotedReferences,
    exactNameReferences,
    effects,
    unresolved: [...new Set(unresolved)]
  };
}

export function parseCardText(card: Card): CardTextAdapterResult {
  const source = (card.mainEffect ?? '').normalize('NFC').trim();
  const lines = source.replace(/<br\s*\/?>/gi, '\n').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const ruleTexts: string[] = [];
  const abilityLines: string[] = [];
  for (const line of lines) {
    const marker = line.match(/#(?=\s|[ก-๙])/);
    const hashIndex = marker ? marker.index : -1;
    if (hashIndex >= 0) {
      if (line.slice(0, hashIndex).trim()) abilityLines.push(line.slice(0, hashIndex).trim());
      const ruleText = line.slice(hashIndex + 1).trim();
      if (ruleText) ruleTexts.push(ruleText);
    } else abilityLines.push(line);
  }
  const clauses = abilityLines.map(parseClause);
  const taggedMagic = [...source.matchAll(/ความสามารถนี้ถือเป็นการใช้\s+(Normal|Modification|React|Land)\s+Magic/gi)]
    .map(match => MAGIC_TYPES[match[1] as keyof typeof MAGIC_TYPES]);
  const overrideMagic = [...source.matchAll(/โดยถือว่าเป็นการใช้\s+(Normal|Modification|React|Land)\s+Magic/gi)]
    .map(match => MAGIC_TYPES[match[1] as keyof typeof MAGIC_TYPES]);
  const magicUse = {
    ...(taggedMagic.length === 1 ? { abilityConsumesMagicType: taggedMagic[0] } : {}),
    ...(overrideMagic.length === 1 ? { magicSubtypeOverride: overrideMagic[0] } : {})
  };
  const reasons = clauses.flatMap(clause => clause.unresolved);
  if (AMBIGUOUS_WORDING.test(source)) reasons.push('wording explicitly matches an unresolved or ambiguous-rule marker');
  if (taggedMagic.length > 1 || overrideMagic.length > 1) reasons.push('multiple or conflicting Magic type declarations');
  if (taggedMagic.length > 0 && overrideMagic.length > 0) {
    // These are distinct Rule Book p.11 semantics; never collapse them into a single type override.
    if (taggedMagic.length !== 1 || overrideMagic.length !== 1) reasons.push('cannot disambiguate mixed Magic-use declarations');
  }
  const status: CardTextStatus = AMBIGUOUS_WORDING.test(source) || reasons.some(reason => /conflicting|cannot disambiguate|ambiguous-rule/.test(reason))
    ? 'AMBIGUOUS'
    : reasons.length > 0 ? 'UNSUPPORTED' : 'PARSED_READY';
  const resolvedClauses = status === 'PARSED_READY' ? clauses : clauses.map(clause => ({ ...clause, effects: [] }));
  return {
    status,
    ...(reasons.length ? { reason: [...new Set(reasons)].join('; ') } : {}),
    attributes: {
      printId: card.printId, name: card.name, type: card.type, subtype: card.subtype ?? null,
      soi: card.soi, cost: card.cost, gem: card.gem, gemColor: card.gemColor ?? null,
      power: card.power, symbol: card.symbol ?? null, color: card.color, rarity: card.rarity,
      dropRate: card.dropRate, favorText: card.favorText, creator: card.creator,
      isOnlyOne: card.isOnlyOne, isBias: card.isBias, isCollab: card.isCollab
    },
    ruleTexts,
    clauses: resolvedClauses,
    magicUse
  };
}

export function parseCardTextDatabase(cards: Card[]): Record<CardTextStatus, number> {
  const totals: Record<CardTextStatus, number> = { PARSED_READY: 0, UNSUPPORTED: 0, AMBIGUOUS: 0 };
  for (const card of cards) totals[parseCardText(card).status] += 1;
  return totals;
}
