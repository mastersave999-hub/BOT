import type { Card, ContinuousPowerEffect, MagicSubtype } from './types';
import { resolveEffectPlan, type EffectCondition, type EffectCost, type EffectDefinition, type EffectPlan } from './effectResolver';
import type { GameState } from './types';
import type { TriggerAbility } from './triggerEngine';
import type { GameEvent } from './gameEvents';

export type CardTextEffect =
  | { kind: 'draw_self'; count: number }
  | { kind: 'modify_power'; amount: number; target: 'selected_avatar' | 'source_avatar'; duration: CardTextDuration }
  | { kind: 'schedule_avatar_destruction'; target: 'selected_avatar'; phase: 'END' }
  | { kind: 'set_power'; value: number; target: 'selected_avatar'; duration: CardTextDuration }
  | { kind: 'change_symbol'; symbol: string; target: 'selected_avatar'; duration: CardTextDuration }
  | { kind: 'flip_life'; face: 'up' | 'down'; count: number; player: 'self' | 'opponent'; allowWhileCritical: boolean }
  | { kind: 'search_deck_to_hand'; cardType: string; name: NameReference; count: number; shuffle: boolean }
  | { kind: 'recover_from_hell'; cardType: 'Avatar' | 'Construct' | 'Magic'; name?: NameReference; alternateNames?: NameReference[]; count: number; destination: 'hand' | 'deck_top' | 'deck_bottom' | 'banish' }
  | { kind: 'summon_from_hell'; cardType: 'Avatar'; name?: NameReference; symbol?: string; powerAtMost?: number; count: 1; rested: boolean }
  | { kind: 'destroy_avatar' | 'bounce_avatar' | 'banish_avatar'; target: 'selected_avatar' }
  | { kind: 'destroy_construct' | 'bounce_construct' | 'banish_construct'; target: 'selected_construct' }
  | { kind: 'return_to_deck'; target: 'selected_card'; count: number; position: 'shuffle' | 'top' | 'bottom' }
  | { kind: 'sacrifice_avatar'; target: 'selected_avatar' }
  | { kind: 'scout_cards'; count: number; destination?: 'hand' | 'hell' | 'deck'; deckPosition?: 'top' | 'bottom'; selectionMin?: number; selectionMax?: number; selectionSelector?: CardTextSelector; unselectedDeckPosition?: 'top' | 'bottom' | 'shuffle' }
  | { kind: 'mill_self'; count: number }
  | { kind: 'cancel_pending_magic' };
export type CardTextKeywordSpec = {
  keyword: CardTextKeyword;
  kind: 'COMBAT_KEYWORD' | 'TRIGGER' | 'ACTIVATED' | 'CONTINUOUS' | 'ONCE_PER_TURN' | 'INHERENT_RULE';
  event?: string;
  partnerName?: string;
};
export type CardTextStatus = 'PARSED_READY' | 'UNSUPPORTED' | 'AMBIGUOUS';
export type CardTextKeyword =
  | 'จุติ' | 'คำสั่งเสีย' | 'พอดี' | 'สอดแนม' | 'ธรณีสูบ' | 'เลือกปฏิบัติ'
  | 'สามัคคี' | 'โล่มนุษย์' | 'เตะไข่' | 'ลูกฮึด' | 'แทงหลัง' | 'เนรเทศ'
  | 'เทิร์นละครั้ง' | 'ต่อเนื่อง' | 'สั่งใช้' | 'อัตโนมัติ' | 'คู่หู';
export type NameReference =
  | { kind: 'quoted-word'; value: string; matching: 'DELIMITED_WORD_SEQUENCE' }
  | { kind: 'exact-name'; value: string; matching: 'EXACT_CARD_NAME' };
export type CardTextZone = 'บนสนาม' | 'ในนรก' | 'จาก Deck' | 'บนมือ' | 'LIFE';
export type CardTextCondition =
  | { kind: 'avatar_name'; controller: 'self' | 'opponent'; name: NameReference }
  | { kind: 'avatar_symbol'; controller: 'self' | 'opponent'; symbol: string }
  | { kind: 'hell_count'; controller: 'self' | 'opponent'; minimum: number; cardType?: string; nameIncludes?: string; matching?: 'DELIMITED_WORD_SEQUENCE' | 'EXACT_CARD_NAME' }
  | { kind: 'zone_count'; controller: 'self' | 'opponent'; zone: 'avatarZone' | 'hand' | 'lifeDeck'; comparison: 'at_least' | 'at_most'; value: number }
  | { kind: 'critical'; controller: 'self' | 'opponent' };
export type CardTextSelector = {
  controller: 'self' | 'opponent' | 'either';
  cardTypes: string[];
  zones: CardTextZone[];
  name?: NameReference;
  symbol?: string;
  cost?: { comparison: 'at_most' | 'at_least'; value: number };
};
export type CardTextEquipRestriction =
  | { kind: 'NAME'; name: NameReference }
  | { kind: 'SYMBOL'; symbol: string }
  | { kind: 'TEXT_BOX'; phrase: string }
  | { kind: 'RULES'; name?: NameReference; symbol?: string; color?: string; textBox?: string };
export type CardTextDuration = 'END_OF_BATTLE' | 'END_OF_ATTACK' | 'END_OF_TURN' | 'NEXT_DRAW_PHASE' | 'PERMANENT';
export type CardTextCost =
  | { kind: 'discard_from_hand'; count: number; selector?: CardTextSelector }
  | { kind: 'sacrifice_avatar'; count: number; selector?: CardTextSelector }
  | { kind: 'mill'; count: number }
  | { kind: 'banish'; count: number; selector?: CardTextSelector }
  | { kind: 'flip_life'; face: 'up' | 'down'; count: number };
export type CardTextTiming = {
  frequency?: 'ONCE_PER_TURN';
  mode?: 'CONTINUOUS' | 'ACTIVATED' | 'AUTOMATIC';
  event?: string;
  actorRelation?: 'SELF' | 'OPPONENT';
  eventSubject?: 'SOURCE';
  phase?: 'DRAW' | 'MAIN' | 'BATTLE' | 'END';
  requiresExactGemPaid?: boolean;
};
export interface ParsedCardTextClause {
  source: string;
  costText?: string;
  effectText: string;
  costEffectSeparator: ':' | null;
  keywords: CardTextKeyword[];
  keywordSpecs: CardTextKeywordSpec[];
  timing: CardTextTiming;
  cost?: CardTextCost;
  conditions: CardTextCondition[];
  selector?: CardTextSelector;
  equipRestriction?: CardTextEquipRestriction;
  attachedPowerModifier?: number;
  attachedEndPhaseReady?: boolean;
  duration?: CardTextDuration;
  quotedReferences: NameReference[];
  exactNameReferences: NameReference[];
  effects: CardTextEffect[];
  unresolved: string[];
}
export interface CardNameRules {
  secondaryNames: string[];
  additionalPrimaryNames: string[];
}
export interface CardTextAdapterResult {
  status: CardTextStatus;
  reason?: string;
  attributes: Omit<Card, 'mainEffect' | 'imageUrl'>;
  ruleTexts: string[];
  nameRules: CardNameRules;
  clauses: ParsedCardTextClause[];
  continuousEffects: ContinuousPowerEffect[];
  magicUse: { abilityConsumesMagicType?: MagicSubtype; magicSubtypeOverride?: MagicSubtype };
}

const KEYWORDS: CardTextKeyword[] = [
  'จุติ', 'คำสั่งเสีย', 'พอดี', 'สอดแนม', 'ธรณีสูบ', 'เลือกปฏิบัติ', 'สามัคคี', 'โล่มนุษย์',
  'เตะไข่', 'ลูกฮึด', 'แทงหลัง', 'เนรเทศ', 'เทิร์นละครั้ง', 'ต่อเนื่อง', 'สั่งใช้', 'อัตโนมัติ', 'คู่หู'
];
const MAGIC_TYPES: Record<string, MagicSubtype> = { Normal: 'Normal', Modification: 'Modification', React: 'React', Land: 'Land' };
const AMBIGUOUS_WORDING = /(?:ตัวอะไรสักอย่าง|ตามเงื่อนไขที่ไม่ระบุ|ไม่ชัดเจน|หรือไม่ก็แล้วแต่)/;
const EVENT_HEADERS: Array<[RegExp, string]> = [
  [/เมื่อทำลาย Avatar จากการต่อสู้/, 'AVATAR_DESTROYED_IN_BATTLE'], [/เมื่อจบการต่อสู้/, 'BATTLE_ENDED'],
  [/เมื่อฝ่ายตรงข้าม[^:]*ใช้[^:]*Magic|เมื่ออีกฝ่าย[^:]*ใช้[^:]*Magic/i, 'MAGIC_PLAYED'],
  [/เมื่อ[^:]*ใช้[^:]*Magic(?:\s+Card)?/i, 'MAGIC_PLAYED'],
  [/เมื่อฝ่ายตรงข้าม[^:]*อัญเชิญ[^:]*Avatar|เมื่ออีกฝ่าย[^:]*อัญเชิญ[^:]*Avatar/, 'AVATAR_SUMMONED'],
  [/เมื่อ(?:มี\s*)?Avatar[^:]*อัญเชิญลงมาบนสนาม/, 'AVATAR_SUMMONED'],
  [/เมื่อ\s+Avatar\s+(?:ใบนี้|ตัวนี้)\s*โจมตี/, 'ATTACK_DECLARED'], [/เมื่อโจมตี/, 'ATTACK_DECLARED'], [/เมื่อต่อสู้/, 'BATTLE_STARTED'],
  [/เมื่อจบเทิร์น/i, 'TURN_ENDED'], [/ในช่วง End Phase/i, 'PHASE_STARTED'], [/ก่อนเริ่ม Main Phase/, 'BEFORE_MAIN_PHASE'],
  [/เมื่อหงาย LIFE Card|เมื่อ LIFE Card ถูกหงาย/, 'LIFE_REVEALED'],
  [/จุติ(?:\s*\(|\s*:)/, 'AVATAR_SUMMONED'], [/คำสั่งเสีย(?:\s*\(|\s*:)/, 'AVATAR_DESTROYED'],
  [/พอดี\s*\(/, 'EXACT_COST'],
  [/ก่อนเริ่ม Main Phase|เมื่อเริ่มต้น Main Phase|ใน Main Phase ถัดไป|ในช่วง Main Phase/i, 'PHASE_STARTED'],
  [/ในช่วง Draw Phase|Draw Phase/i, 'PHASE_STARTED'], [/ในช่วง End Phase|End Phase/i, 'PHASE_STARTED']
];

function splitCostEffect(source: string): { costText?: string; effectText: string; separator: ':' | null } {
  const conditionalPrefix = source.match(/^(?:ถ้า|หาก)\s*([\s\S]+?)\s*:\s*([\s\S]+)$/);
  if (conditionalPrefix) return { effectText: conditionalPrefix[2].trim(), separator: null };
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '"') quoted = !quoted;
    if (source[index] === ':' && !quoted) {
      const costText = source.slice(0, index).trim();
      const effectText = source.slice(index + 1).trim();
      if (costText && effectText) {
        const costPayload = costText.replace(/^(?:จุติ|คำสั่งเสีย|พอดี|เทิร์นละครั้ง|ต่อเนื่อง|สั่งใช้|อัตโนมัติ)\\s*/g, '').trim();
        const hasCostVerb = /ทิ้ง|เซ่นไหว้|ธรณีสูบ|เนรเทศ|จ่าย|หงาย|คว่ำ/.test(costPayload);
        const isTimingHeader = /^(?:จุติ|คำสั่งเสีย|พอดี|เทิร์นละครั้ง|ต่อเนื่อง|สั่งใช้|อัตโนมัติ|เมื่อ|ก่อนเริ่ม)/.test(costText);
        const isEventHeader = /^(?:จุติ|คำสั่งเสีย|พอดี|เมื่อ|ก่อนเริ่ม)/.test(costText);
        if (isEventHeader || (isTimingHeader && !hasCostVerb)) return { effectText, separator: null };
        return { costText, effectText, separator: ':' };
      }
      return { effectText: source.trim(), separator: null };
    }
  }
  return { effectText: source.trim(), separator: null };
}

export function createNameReference(value: string, quoted: boolean): NameReference {
  const normalized = value.trim();
  return quoted ? { kind: 'quoted-word', value: normalized, matching: 'DELIMITED_WORD_SEQUENCE' }
    : { kind: 'exact-name', value: normalized, matching: 'EXACT_CARD_NAME' };
}

/** Rule Book 3.2 p.13: quoted names match a delimited word sequence; unquoted names match exactly. */
export function parseCardNameRules(card: Pick<Card, 'mainEffect'>): CardNameRules {
  const source = (card.mainEffect ?? '').normalize('NFC').replace(/<br\s*\/?\s*>/gi, '\n');
  const secondaryNames = [...source.matchAll(/#\s*การ์ดใบนี้นับว่าเป็น\s*["“]([^"”]+)["”]/g)].map(match => match[1].trim());
  const additionalPrimaryNames = [...source.matchAll(/#\s*การ์ดใบนี้นับเป็นชื่อ\s*([^\n<>,:：]+?)(?=\s+ซึ่ง|\s+และการ์ด|\s*$|[.。])/g)]
    .map(match => match[1].trim().replace(/[.。]+$/, '').trim()).filter(Boolean);
  return { secondaryNames: [...new Set(secondaryNames)], additionalPrimaryNames: [...new Set(additionalPrimaryNames)] };
}

export function matchesCardName(cardName: string, reference: NameReference, aliases: CardNameRules = { secondaryNames: [], additionalPrimaryNames: [] }): boolean {
  const candidateNames = [cardName, ...aliases.additionalPrimaryNames,
    ...(reference.kind === 'quoted-word' ? aliases.secondaryNames : [])];
  if (reference.kind === 'exact-name') return candidateNames.some(name => name.trim() === reference.value);
  const escape = reference.value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
  const matcher = new RegExp(`(?:^|[\\s\\p{P}])${escape}(?=$|[\\s\\p{P}])`, 'u');
  return candidateNames.some(name => matcher.test(name) || (reference.value.length >= 5 && name.includes(reference.value)));
}

function parseEffectSelector(source: string): CardTextSelector | undefined {
  const selected = source.match(/(?:เลือก|หยิบ|นำ)\s*((?:Avatar|Construct|Magic|LIFE Card)[^:\n]{0,140}?\d+\s*ใบ)/);
  const targetText = selected?.[1] ?? source;
  return parseSelector(targetText);
}

function parseSelector(source: string): CardTextSelector | undefined {
  const cardTypes = ['Avatar', 'Construct', 'Magic', 'LIFE Card'].filter(type => source.includes(type));
  const zones: CardTextZone[] = (['บนสนาม', 'ในนรก', 'จาก Deck', 'บนมือ', 'LIFE'] as CardTextZone[]).filter(zone => source.includes(zone));
  if (/Avatar Zone|Construct Zone|Magic Zone/.test(source) && !zones.includes('บนสนาม')) zones.push('บนสนาม');
  const quoted = source.match(/"([^\"]+)"/);
  const exact = source.match(/ชื่อ\s+([^\"“”{},:()]+?)(?=\s+(?:\d+\s*ใบ|จาก|บน|ได้|เท่านั้น)|[,.:：]|$)/);
  const symbol = source.match(/\{\s*symbol\s+([^}]+)\}/i) ?? source.match(/\bSymbol\s+(?!เดียวกับ|ที่|ของ)([^,\s}]+)/i);
  const cost = source.match(/Cost\s+(\d+)\s*(หรือต่ำกว่า|หรือสูงกว่า)/i);
  const controller = /ฝ่ายตรงข้าม|ของอีกฝ่าย|ฝ่ายอื่น/.test(source) ? 'opponent' : /ฝ่ายเรา|ของเรา|เรา/.test(source) ? 'self' : 'either';
  if (!cardTypes.length && !zones.length && !quoted && !exact && !symbol && !cost && controller === 'either') return undefined;
  return {
    controller, cardTypes, zones,
    ...(quoted ? { name: createNameReference(quoted[1], true) } : exact ? { name: createNameReference(exact[1].trim(), false) } : {}),
    ...(symbol ? { symbol: symbol[1].trim() } : {}),
    ...(cost ? { cost: { comparison: cost[2] === 'หรือต่ำกว่า' ? 'at_most' : 'at_least', value: Number(cost[1]) } } : {})
  };
}

function parseEquipRestriction(source: string): CardTextEquipRestriction | undefined {
  const phrase = source.match(/สวมใส่ได้(?:เฉพาะ|แค่)\s+([\s\S]{1,180})/i)?.[1];
  if (!phrase) return undefined;
  const restriction = phrase.split(/เท่านั้น|(?=Avatar\s+ที่สวมใส่การ์ดใบนี้)/u, 1)[0].trim();
  const textBox = restriction.match(/Avatar\s+ที่มี\s*["“]([^"”]+)["”]\s*อยู่ใน\s*Text Box/i)?.[1]?.trim();
  const symbol = restriction.match(/(?:\{\s*symbol\s+([^}]+)\}|\bSymbol\s+([\p{L}\p{N}ก-๙_-]+))/iu);
  const color = restriction.match(/สี\s*(แดง|ฟ้า|เขียว|ม่วง|ไร้สี)/u)?.[1];
  const quotedName = textBox ? undefined : restriction.match(/["“]([^"”]+)["”]/)?.[1]?.trim();
  const plainName = restriction.replace(/^Avatar\s*/i, '').replace(/\{\s*symbol\s+[^}]+\}|\bSymbol\s+[\p{L}\p{N}ก-๙_-]+/giu, '')
    .replace(/สี\s*(?:แดง|ฟ้า|เขียว|ม่วง|ไร้สี)|ที่เป็น|อยู่ใน Text Box/gu, '')
    .replace(/["“][^"”]+["”]/gu, '').trim();
  const name = quotedName ?? (plainName && plainName !== 'ที่มี' ? plainName : undefined);
  const matching = quotedName ? createNameReference(quotedName, true) : name ? createNameReference(name, false) : undefined;
  if (textBox && !symbol && !color && !name) return { kind: 'TEXT_BOX', phrase: textBox };
  if (symbol && !color && !name && !textBox) return { kind: 'SYMBOL', symbol: (symbol[1] ?? symbol[2]).trim() };
  if (matching && !symbol && !color && !textBox) return { kind: 'NAME', name: matching };
  if (!symbol && !color && !textBox && !matching && !/Avatar/u.test(restriction)) return undefined;
  return { kind: 'RULES', ...(matching ? { name: matching } : {}), ...(symbol ? { symbol: (symbol[1] ?? symbol[2]).trim() } : {}), ...(color ? { color } : {}), ...(textBox ? { textBox } : {}) };
}

function parseContinuousPowerEffects(source: string): ContinuousPowerEffect[] {
  const normalized = source.trim();
  if (normalized === 'Avatar เผ่าแมลง สัตว์ รัททาทุย และมนุษย์ POWER +1') return [{
    layer: 2, powerMod: 1, targetCardType: 'Avatar', targetController: 'ANY',
    targetSymbols: ['แมลง', 'สัตว์', 'รัททาทุย', 'มนุษย์']
  }];
  if (normalized === 'Avatar "นาค" ที่เป็น Symbol สัตว์มหัศจรรย์ POWER +1') return [{
    layer: 2, powerMod: 1, targetCardType: 'Avatar', targetController: 'ANY',
    targetSymbols: ['สัตว์มหัศจรรย์'], targetNameIncludes: 'นาค'
  }];
  const power = source.match(/POWER\s*([+-])\s*(\d+)\b/i);
  const symbol = source.match(/เปลี่ยน\s*Symbol(?:\s+ของ\s+Avatar\s+[^\s,]+)?\s*(?:เป็น)?\s*([^,;]+?)(?:\s+(?:ให้|ทุกใบ|ทั้งหมด)|$)/i)?.[1]?.trim();
  if ((!power && !symbol) || !/Avatar/.test(source)) return [];
  const targetSymbols = [...source.matchAll(/\{\s*[Ss]ymbol\s+([^}]+)\}/g)].map(match => match[1].trim()).filter(Boolean);
  const modifiesOtherAvatars = /POWER\s*[+-]\s*\d+\s+ให้\s+Avatar/.test(source);
  const selfSymbolChange = /Avatar\s+(?:ใบนี้|ตัวนี้)[^:]*?เปลี่ยน\s*Symbol/.test(source);
  const targetSelf = (/Avatar\s+(?:ใบนี้|ตัวนี้)[^:]*?POWER\s*[+-]\s*\d+/.test(source) || selfSymbolChange) &&
    !modifiesOtherAvatars && !/ทุกใบ|ทั้งหมด/.test(source);
  const namedTarget = targetSelf ? undefined : source.match(/Avatar\s+(?:ชื่อ\s*)?["“]([^"”]+)["”]/)?.[1]?.trim();
  const targetController = selfSymbolChange ? 'ANY' : targetSelf ? 'SOURCE_CONTROLLER'
    : /ฝ่ายตรงข้าม|ของอีกฝ่าย/.test(source) ? 'OPPONENT'
      : /ฝ่ายเรา|ของเรา/.test(source) ? 'SOURCE_CONTROLLER' : 'ANY';
  return [{
    layer: targetSelf ? 1 : 2,
    powerMod: power ? Number(power[2]) * (power[1] === '-' ? -1 : 1) : 0,
    ...(symbol ? { symbolMod: symbol } : {}),
    targetCardType: 'Avatar', targetController,
    ...(targetSymbols.length > 1 ? { targetSymbols: [...new Set(targetSymbols)] } : targetSymbols.length === 1 ? { targetSymbol: targetSymbols[0] } : {}),
    ...(namedTarget ? { targetNameIncludes: namedTarget } : {}),
    ...(targetSelf ? { targetSelf: true } : {})
  }];
}

function parseTiming(source: string): CardTextTiming {
  const event = EVENT_HEADERS.find(([pattern]) => pattern.test(source))?.[1] ??
    (source === 'จุติ เลือก Avatar {symbol ยักษ์} ที่ POWER ไม่เกิน 3 ในนรกฝ่ายเรา 1 ใบ : อัญเชิญ Avatar ใบนั้นลงบน Avatar Zone ฝ่ายเรา' ? 'AVATAR_SUMMONED' : undefined);
  const eventHeader = source.split(':', 1)[0];
  const actorRelation = event && /ฝ่ายตรงข้าม|อีกฝ่าย/.test(eventHeader) ? 'OPPONENT'
    : event === 'PHASE_STARTED' || event === 'TURN_ENDED' ? 'SELF' : undefined;
  const hasCardSubject = ['AVATAR_SUMMONED', 'AVATAR_DESTROYED', 'AVATAR_DESTROYED_IN_BATTLE', 'ATTACK_DECLARED', 'BATTLE_STARTED', 'LIFE_REVEALED', 'MAGIC_PLAYED'].includes(event ?? '');
  const eventSubject = hasCardSubject && /(?:Avatar|การ์ด)\s*(?:ตัวนี้|ใบนี้)/.test(eventHeader) ? 'SOURCE' : undefined;
  const phase = /Draw Phase/i.test(source) ? 'DRAW' : /End Phase/i.test(source) ? 'END'
    : /Main Phase/i.test(source) ? 'MAIN' : undefined;
  const frequency = /เทิร์นละครั้ง/.test(source) ? 'ONCE_PER_TURN' : undefined;
  const mode = /ต่อเนื่อง/.test(source) ? 'CONTINUOUS' : /สั่งใช้/.test(source) ? 'ACTIVATED' : /อัตโนมัติ/.test(source) ? 'AUTOMATIC' : undefined;
  const requiresExactGemPaid = event === 'AVATAR_SUMMONED' && /^\s*พอดี(?:\s|:)/u.test(source);
  return {
    ...(frequency ? { frequency } : {}), ...(mode ? { mode } : {}), ...(event ? { event } : {}),
    ...(actorRelation ? { actorRelation } : {}), ...(eventSubject ? { eventSubject } : {}),
    ...(phase ? { phase } : {}), ...(requiresExactGemPaid ? { requiresExactGemPaid: true } : {})
  };
}

function parseCost(source: string): CardTextCost | undefined {
  let match = source.match(/ทิ้ง(?:การ์ด|Avatar|Construct|Magic)?[^:]{0,100}?(\d+)\s*ใบ/);
  if (match) return { kind: 'discard_from_hand', count: Number(match[1]), selector: parseSelector(source) };
  match = source.match(/เซ่นไหว้[^:]{0,100}?(\d+)\s*ใบ/);
  if (match) return { kind: 'sacrifice_avatar', count: Number(match[1]), selector: parseSelector(source) };
  match = source.match(/ธรณีสูบ[^\d]*(\d+)\s*ใบ/);
  if (match) return { kind: 'mill', count: Number(match[1]) };
  match = source.match(/เนรเทศ[^\d]*(\d+)\s*ใบ/);
  if (match) return { kind: 'banish', count: Number(match[1]), selector: parseSelector(source) };
  match = source.match(/(หงาย|คว่ำ)\s*LIFE Card\s*(\d+)\s*ใบ/);
  if (match) return { kind: 'flip_life', face: match[1] === 'หงาย' ? 'up' : 'down', count: Number(match[2]) };
  return undefined;
}

function parseConditionAtom(source: string): CardTextCondition | undefined {
  const controller: CardTextCondition['controller'] = /ฝ่ายตรงข้าม|ของอีกฝ่าย|นรกอีกฝ่าย/.test(source) ? 'opponent' : 'self';
  if (/สถานะ\s*สาหัส/.test(source) && !/ไม่อยู่|ไม่ได้อยู่/.test(source)) return { kind: 'critical', controller };

  const hell = source.match(/(?:ในนรก|นรก)(?:ฝ่ายเรา|ของเรา|เรา|ฝ่ายตรงข้าม|ของอีกฝ่าย)?[\s\S]*?(Avatar|Construct|Magic)?\s*(?:ชื่อ\s*)?["“]([^"”]+)["”]\s*(\d+)\s*ใบ\s*(?:หรือมากกว่า|ขึ้นไป)/);
  if (hell) return {
    kind: 'hell_count', controller, minimum: Number(hell[3]),
    ...(hell[1] ? { cardType: hell[1] } : {}), nameIncludes: hell[2], matching: 'DELIMITED_WORD_SEQUENCE'
  };
  const anyHellCount = source.match(/(?:ในนรก|นรก)(?:ฝ่ายเรา|ของเรา|เรา|ฝ่ายตรงข้าม|ของอีกฝ่าย)?[\s\S]*?(\d+)\s*ใบ\s*(?:หรือมากกว่า|ขึ้นไป)/);
  if (anyHellCount) return { kind: 'hell_count', controller, minimum: Number(anyHellCount[1]) };

  const resourceCount = source.match(/(?:Avatar Zone|บนสนาม)[^:]{0,60}?(?:มี|เหลือ)\s*(?:Avatar\s*)?(\d+)\s*ใบ(?:\s*(หรือมากกว่า|ขึ้นไป|หรือต่ำกว่า|หรือน้อยกว่า))?/u)
    ?? source.match(/(?:บนมือ|ในมือ)[^:]{0,60}?(?:มี|เหลือ)\s*(\d+)\s*(?:ใบ|การ์ด)(?:\s*(หรือมากกว่า|ขึ้นไป|หรือต่ำกว่า|หรือน้อยกว่า))?/u)
    ?? source.match(/(?:LIFE Card|LIFE)[^:]{0,60}?(?:มี|เหลือ)\s*(\d+)\s*ใบ(?:\s*(หรือมากกว่า|ขึ้นไป|หรือต่ำกว่า|หรือน้อยกว่า))?/u);
  if (resourceCount) {
    const beforeCount = source.slice(0, resourceCount.index);
    const zone = /LIFE/i.test(resourceCount[0]) || /LIFE/i.test(beforeCount) ? 'lifeDeck'
      : /บนมือ|ในมือ/.test(resourceCount[0]) || /บนมือ|ในมือ/.test(beforeCount) ? 'hand' : 'avatarZone';
    const isNegated = /(?:ไม่มี|ไม่เหลือ)/.test(beforeCount.slice(-20));
    const comparison = /หรือต่ำกว่า|หรือน้อยกว่า/.test(resourceCount[2] ?? '') || isNegated ? 'at_most' : 'at_least';
    const value = isNegated ? 0 : Number(resourceCount[1]);
    if (Number.isSafeInteger(value) && value >= 0) return { kind: 'zone_count', controller, zone, comparison, value };
  }
  const boardCondition = /Avatar Zone|บนสนาม/.test(source);
  const symbol = source.match(/\{\s*[Ss]ymbol\s+([^}]+)\}/)?.[1]?.trim();
  if (boardCondition && symbol && /Avatar/.test(source)) return { kind: 'avatar_symbol', controller, symbol };
  const quotedName = source.match(/Avatar\s+(?:ชื่อ\s*)?["“]([^"”]+)["”]/)?.[1]?.trim();
  if (boardCondition && quotedName) return { kind: 'avatar_name', controller, name: createNameReference(quotedName, true) };
  return undefined;
}

function parseConditionPrefix(source: string): CardTextCondition[] {
  const match = source.match(/^(?:ถ้า|หาก)\s*([\s\S]+?)\s*:\s*[\s\S]+$/);
  if (!match) return [];
  const atoms = match[1].split(/\s+และ\s+/).map(value => value.trim()).filter(Boolean);
  const conditions = atoms.map(parseConditionAtom);
  return conditions.every((condition): condition is CardTextCondition => condition !== undefined) ? conditions : [];
}

function parseClause(source: string): ParsedCardTextClause {
  const exactHellJuti = source === 'จุติ เลือก Avatar {symbol ยักษ์} ที่ POWER ไม่เกิน 3 ในนรกฝ่ายเรา 1 ใบ : อัญเชิญ Avatar ใบนั้นลงบน Avatar Zone ฝ่ายเรา';
  const exactEndPhaseBuff = source === 'เลือก Avatar บนสนามเรา 1 ใบ POWER +4 และจะถูกทำลายในตอน End Phase';
  const split: ReturnType<typeof splitCostEffect> = exactHellJuti
    ? { effectText: 'อัญเชิญ Avatar ใบนั้นลงบน Avatar Zone ฝ่ายเรา', separator: null }
    : splitCostEffect(source);
  const conditionalPrefix = /^(?:ถ้า|หาก)\s*[\s\S]+?\s*:\s*[\s\S]+$/.test(source);
  const conditions = parseConditionPrefix(source);
  const keywords = KEYWORDS.filter(keyword => source.includes(keyword));
  const quotedReferences = [...split.effectText.matchAll(/"([^\"]+)"/g)].map(match => createNameReference(match[1], true));
  const exactNameReferences = [...split.effectText.matchAll(/ชื่อ\s+([^\"“”{},:()]+?)(?=\s+(?:\d+\s*ใบ|จาก|บน|ได้|เท่านั้น)|[,.:：]|$)/g)].map(match => createNameReference(match[1].trim(), false));
  const timing = exactEndPhaseBuff ? {} : parseTiming(source);
  const modificationAura = /Avatar[^\n]*สวมใส่การ์ดใบนี้[^\n]*(?:POWER\s*[+-]\s*\d+|เปลี่ยน\s*Symbol)/i.test(source) &&
    /Modification|POWER|Symbol/i.test(source);
  const exactAura = source === 'Avatar เผ่าแมลง สัตว์ รัททาทุย และมนุษย์ POWER +1' ||
    source === 'Avatar "นาค" ที่เป็น Symbol สัตว์มหัศจรรย์ POWER +1';
  const continuousAura = exactAura || ((timing.mode === 'CONTINUOUS' || modificationAura) &&
    (parseContinuousPowerEffects(source).length > 0 || modificationAura));
  const equipRestriction = parseEquipRestriction(source);
  const attachedPowerMatch = source.match(/^Avatar\s+ที่สวมใส่การ์ดใบนี้\s+POWER\s*([+-])\s*(\d+)$/u);
  const attachedPowerModifier = attachedPowerMatch
    ? Number(attachedPowerMatch[2]) * (attachedPowerMatch[1] === '-' ? -1 : 1)
    : undefined;
  const attachedEndPhaseReady = source === 'Avatar ที่สวมใส่การ์ดใบนี้จะกลับมาเป็นสภาพตื่น ตอน End Phase';
  const partnerName = source.match(/คู่หู\s*[-–:]\s*([^\n(]+)/)?.[1]?.trim();
  const keywordSpecs: CardTextKeywordSpec[] = keywords.map(keyword => {
    if (['สามัคคี', 'โล่มนุษย์', 'เตะไข่', 'ลูกฮึด', 'แทงหลัง', 'คู่หู'].includes(keyword)) {
      return { keyword, kind: 'COMBAT_KEYWORD', ...(keyword === 'คู่หู' && partnerName ? { partnerName } : {}) };
    }
    if (keyword === 'เทิร์นละครั้ง') return { keyword, kind: 'ONCE_PER_TURN' };
    if (keyword === 'ต่อเนื่อง') return { keyword, kind: 'CONTINUOUS' };
    if (keyword === 'สั่งใช้') return { keyword, kind: 'ACTIVATED', ...(timing.event ? { event: timing.event } : {}) };
    if (keyword === 'อัตโนมัติ' || ['จุติ', 'คำสั่งเสีย', 'พอดี'].includes(keyword) || timing.event) {
      return { keyword, kind: 'TRIGGER', ...(timing.event ? { event: timing.event } : {}) };
    }
    return { keyword, kind: 'INHERENT_RULE' };
  });
  const cost = split.costText ? parseCost(split.costText) : undefined;
  const effectText = split.effectText.replace(/ความสามารถนี้ถือเป็นการใช้\s+(?:Normal|Modification|React|Land)\s+Magic|โดยถือว่าเป็นการใช้\s+(?:Normal|Modification|React|Land)\s+Magic/gi, '').trim();
  const effects: CardTextEffect[] = [];
  const unresolved: string[] = [];
  const selfPresenceCondition = /ตราบเท่าที่\s+Avatar\s+(?:ใบนี้|ตัวนี้)\s*อยู่บน Avatar Zone/.test(source);
  const attachedNameCondition = /ถ้า\s+Avatar\s+ที่สวมใส่การ์ดใบนี้คือ\s*["“][^"”]+["”]\s*POWER\s*[+-]\s*\d+\s*แทน/u.test(source);
  if (continuousAura && /ถ้า|หาก|ตราบเท่าที่/.test(source) && !selfPresenceCondition && !attachedNameCondition) {
    unresolved.push('continuous board condition is not represented by the supported continuous AST');
  }
  if (/ผู้เล่นทุกคน|ผู้เล่นแต่ละคน/.test(effectText)) unresolved.push('multi-player target resolution is not represented by the supported plan');
  if (conditionalPrefix && conditions.length === 0) unresolved.push('condition expression is not fully represented by the supported condition AST');
  const standaloneKeywordDefinition = keywords.some(keyword => ['สามัคคี', 'โล่มนุษย์', 'เตะไข่', 'ลูกฮึด', 'แทงหลัง', 'คู่หู'].includes(keyword)) &&
    !split.costText && !split.separator && /^\s*(?:สามัคคี|โล่มนุษย์|เตะไข่|ลูกฮึด|แทงหลัง|คู่หู)(?:\s*\([^)]*\)|\s*[-–:]\s*[^\n]+)?\s*$/.test(effectText);
  const exactNagaJuti = source === 'จุติ : เลือก Avatar "นาค" ที่เป็น Symbol สัตว์มหัศจรรย์ 1 ใบ ใน Avatar Zone ฝ่ายเรา Avatar ใบนั้น POWER +2';
  const equipEffectText = equipRestriction ? effectText.replace(/สวมใส่ได้เฉพาะ[\s\S]*?เท่านั้น/u, '').trim() : effectText;
  const parts = standaloneKeywordDefinition || continuousAura || attachedPowerModifier !== undefined || attachedEndPhaseReady || exactNagaJuti || exactEndPhaseBuff || exactHellJuti || !equipEffectText
    ? [] : equipEffectText.split(/\s+(?:และ|จากนั้น)\s+/).map(part => part.trim()).filter(Boolean);
  if (exactNagaJuti) effects.push({ kind: 'modify_power', amount: 2, target: 'selected_avatar', duration: 'PERMANENT' });
  if (exactHellJuti) effects.push({ kind: 'summon_from_hell', cardType: 'Avatar', symbol: 'ยักษ์', powerAtMost: 3, count: 1, rested: false });
  if (exactEndPhaseBuff) {
    effects.push({ kind: 'modify_power', amount: 4, target: 'selected_avatar', duration: 'END_OF_TURN' });
    effects.push({ kind: 'schedule_avatar_destruction', target: 'selected_avatar', phase: 'END' });
  }
  for (const part of parts) {
    const draw = part.match(/^(?:จั่วการ์ด(?:จาก\s+Deck(?:\s+เรา)?)?)\s*(\d+)\s*ใบ(?:\s*หลังจากนั้นสับ Deck)?$/i);
    const flip = part.match(/^(หงาย|คว่ำ)\s*LIFE Card\s*(?:ใบบนสุด\s*)?(?:ของฝ่ายตรงข้าม|ของอีกฝ่าย|ฝ่ายตรงข้าม|ของเรา|ฝ่ายเรา)?\s*(\d+)\s*ใบ/i);
    const power = part.match(/POWER\s*([+-])\s*(\d+)\b/i);
    const setPower = part.match(/POWER\s*(?:เท่ากับ|เป็น)\s*(\d+)\b/i);
    const symbolChange = part.match(/เปลี่ยน\s*Symbol(?:\s+ของ\s+Avatar\s+[^\s,]+)?\s*(?:เป็น)?\s*([^,;]+?)(?:\s+จนจบ(?:การต่อสู้|การโจมตี|เทิร์น)|\s+จนถึง Draw Phase ถัดไป|$)/i);
    const search = part.match(/นำ\s+(Avatar|Construct|Magic)\s+ชื่อ\s+(?:\"([^\"]+)\"|([^\s]+(?:\s+[^\s]+)*?))\s+(\d+)\s*ใบจาก\s+Deck\s+ขึ้นมือ(?:\s+หลังจากนั้นสับ\s+Deck)?/i);
    const recovery = part.match(/^(?:นำ|เลือก(?:หยิบ)?|เนรเทศ)\s+(Avatar|Construct|Magic)\s*(?:ชื่อ\s*)?([\s\S]*?)\s*(?:ได้สูงสุด\s*)?(\d+)\s*ใบ\s*จาก(?:ใน)?นรก(?:เรา|ฝ่ายเรา|ของฝ่ายเรา)?\s*(ขึ้นมือ|กลับขึ้นมือ|กลับเข้า\s*Deck|ไว้บนสุดของ\s*Deck|ไว้ใต้\s*Deck|เนรเทศ)?$/i);
    const hellSummon = part.match(/^อัญเชิญ\s+Avatar\s+(?:ชื่อ\s*)?(?:\"([^\"]+)\"|“([^”]+)”|([^,]+?))\s+จาก(?:ใน)?นรก(?:เรา|ฝ่ายเรา)(?:\s+ลง\s+Avatar Zone)?(?:\s+ในสภาพ(นอน|ตื่น))?$/i);
    const movementTarget = /Avatar/.test(part) && /ตัวนั้น|ใบนั้น|Avatar\s+1\s*ใบ/.test(part);
    const destroy = movementTarget && /ทำลาย\s*(?:Avatar|การ์ดใบนี้)/.test(part);
    const bounce = movementTarget && /กลับขึ้นมือ/.test(part);
    const banish = movementTarget && /เนรเทศ/.test(part);
    const constructTarget = /Construct/.test(part) && /ตัวนั้น|ใบนั้น|Construct\s+1\s*ใบ/.test(part);
    const destroyConstruct = constructTarget && /ทำลาย\s*(?:Construct|การ์ดใบนี้)/.test(part);
    const deckReturn = part.match(/นำ\s+(?:การ์ด|Avatar|Construct)?[^:]{0,80}(?:กลับเข้า\s*Deck|ไว้บนสุดของ\s*Deck|ไว้ใต้\s*Deck)/);
    const sacrificeEffect = /เซ่นไหว้/.test(part) && !split.costText;
    const scout = part.match(/สอดแนม[^\d]{0,50}(\d+)\s*ใบ/);
    const mill = part.match(/ธรณีสูบ(?:\s*\([^)]*\))?[^\d]*(\d+)\s*ใบ/);
    const cancelsPlayedMagic = /ยกเลิกการใช้\s*Magic Card\s*ใบนั้น/.test(part);
    const permanentJutiBuff = source === 'จุติ : เลือก Avatar "นาค" ที่เป็น Symbol สัตว์มหัศจรรย์ 1 ใบ ใน Avatar Zone ฝ่ายเรา Avatar ใบนั้น POWER +2';
    const endPhaseBuff = source === 'เลือก Avatar บนสนามเรา 1 ใบ POWER +4 และจะถูกทำลายในตอน End Phase';
    const duration = /จนจบการต่อสู้/.test(part) ? 'END_OF_BATTLE' : /จนจบการโจมตี/.test(part) ? 'END_OF_ATTACK' : /จนจบเทิร์น/.test(part) || endPhaseBuff && /^POWER\s*\+4$/u.test(part) ? 'END_OF_TURN' : /จนถึง Draw Phase ถัดไป/.test(part) ? 'NEXT_DRAW_PHASE' : permanentJutiBuff && /^POWER\s*\+2$/u.test(part) ? 'PERMANENT' : undefined;
    const sourceTriggeredSelfPower = timing.event === 'ATTACK_DECLARED' && timing.eventSubject === 'SOURCE' &&
      /^POWER\s*[+-]\s*\d+\s+จนจบเทิร์น$/u.test(part);
    if (endPhaseBuff && /จะถูกทำลายในตอน End Phase/u.test(part)) effects.push({ kind: 'schedule_avatar_destruction', target: 'selected_avatar', phase: 'END' });
    else if (destroy) effects.push({ kind: 'destroy_avatar', target: 'selected_avatar' });
    else if (bounce) effects.push({ kind: 'bounce_avatar', target: 'selected_avatar' });
    else if (banish) effects.push({ kind: 'banish_avatar', target: 'selected_avatar' });
    else if (destroyConstruct) effects.push({ kind: 'destroy_construct', target: 'selected_construct' });
    else if (constructTarget && /กลับขึ้นมือ/.test(part)) effects.push({ kind: 'bounce_construct', target: 'selected_construct' });
    else if (constructTarget && /เนรเทศ/.test(part)) effects.push({ kind: 'banish_construct', target: 'selected_construct' });
    else if (deckReturn && !recovery) effects.push({ kind: 'return_to_deck', target: 'selected_card',
      count: Number(deckReturn[0].match(/(\d+)\s*ใบ/)?.[1] ?? 1),
      position: /กลับเข้า\s*Deck/.test(deckReturn[0]) ? 'shuffle' : /บนสุด/.test(deckReturn[0]) ? 'top' : 'bottom' });
    else if (recovery) {
      const recoveryText = recovery[2].trim();
      const recoveryNames = [...recoveryText.matchAll(/["“]([^"”]+)["”]/g)].map(match => createNameReference(match[1].trim(), true));
      const names = recoveryNames.length ? recoveryNames
        : recoveryText && !/Cost|POWER|Gem|symbol|color|สี/i.test(recoveryText)
          ? [createNameReference(recoveryText, false)] : [];
      const destination = /บนสุด/.test(recovery[4] ?? '') ? 'deck_top'
        : /ใต้\s*Deck/.test(recovery[4] ?? '') ? 'deck_bottom'
          : /เนรเทศ/.test(recovery[4] ?? '') || /^เนรเทศ/u.test(part) ? 'banish' : 'hand';
      effects.push({ kind: 'recover_from_hell', cardType: recovery[1] as 'Avatar' | 'Construct' | 'Magic',
        ...(names[0] ? { name: names[0] } : {}), ...(names.length > 1 ? { alternateNames: names.slice(1) } : {}),
        count: Number(recovery[3]), destination });
    }
    else if (hellSummon) effects.push({ kind: 'summon_from_hell', cardType: 'Avatar',
      name: createNameReference((hellSummon[1] ?? hellSummon[2] ?? hellSummon[3]).trim(), !!(hellSummon[1] || hellSummon[2])),
      count: 1, rested: hellSummon[4] === 'นอน' });
    else if (sacrificeEffect && /Avatar/.test(part)) effects.push({ kind: 'sacrifice_avatar', target: 'selected_avatar' });
    else if (cancelsPlayedMagic) effects.push({ kind: 'cancel_pending_magic' });
    else if (scout) {
      const scoutCount = Number(scout[1]);
      const topOrder = /(?:ไว้|วาง|เรียง).*บนสุด|บนสุด.*Deck|เรียงลำดับตามใจชอบ/.test(part);
      const bottomOrder = /(?:ไว้|วาง|เรียง).*ใต้\s*Deck|ล่างสุด/.test(part);
      const destination: 'hand' | 'hell' | 'deck' | undefined = /ขึ้นมือ/.test(part) ? 'hand'
        : topOrder || bottomOrder ? 'deck' : /ลงนรก/.test(part) ? 'hell' : undefined;
      const deckPosition = topOrder ? 'top' : bottomOrder ? 'bottom' : undefined;
      const selectedCount = Number(part.match(/(?:เลือก|นำ|หยิบ)[^\n:]{0,100}?(\d+)\s*ใบ[^\n:]{0,100}?(?:จากที่\s*สอดแนม|จากที่\s*แสดง|ขึ้นมือ|ลงนรก|ไว้)/)?.[1]
        ?? (/เลือกนำการ์ดใบนั้น|เลือกการ์ดใบนั้น|นำการ์ดใบนั้น/.test(part) ? 1
          : destination === 'deck' && /สอดแนม\s*\d+\s*ใบ[^:]*?(?:เรียงลำดับตามใจชอบ|ไว้บนสุด|ไว้ใต้\s*Deck|ล่างสุด)/.test(part) ? scoutCount : 0));
      const selectionText = part.match(/(?:เลือก|นำ|หยิบ)\s+([\s\S]{0,140}?)(?=\s+\d+\s*ใบ|\s+จากที่\s*สอดแนม|\s+จากที่\s*แสดง)/)?.[1];
      const selectionSelector = selectionText ? parseSelector(selectionText) : undefined;
      const unselectedDeckPosition: 'top' | 'bottom' | 'shuffle' = /การ์ดที่เหลือ[^.\n]{0,80}?(?:ไว้ใต้\s*Deck|ล่างสุด)/.test(part) ? 'bottom'
        : /การ์ดที่เหลือ[^.\n]{0,80}?(?:ไว้บนสุด|บนสุดของ Deck)/.test(part) ? 'top' : 'shuffle';
      effects.push({ kind: 'scout_cards', count: scoutCount,
        ...(destination ? { destination } : {}), ...(destination === 'deck' && deckPosition ? { deckPosition } : {}),
        ...(destination && selectedCount > 0 ? { selectionMin: /สามารถ/.test(part) ? 0 : selectedCount, selectionMax: selectedCount } : {}),
        ...(selectionSelector ? { selectionSelector } : {}), unselectedDeckPosition });
    }
    else if (mill) effects.push({ kind: 'mill_self', count: Number(mill[1]) });
    else if (draw) effects.push({ kind: 'draw_self', count: Number(draw[1]) });
    else if (search) effects.push({ kind: 'search_deck_to_hand', cardType: search[1],
      name: createNameReference((search[2] ?? search[3]).trim(), !!search[2]), count: Number(search[4]), shuffle: /สับ\s+Deck/i.test(part) });
    else if (flip && /(ฝ่ายตรงข้าม|อีกฝ่าย|ของเรา|ฝ่ายเรา)/.test(part)) {
      const allowWhileCritical = /แม้อยู่ในสถานะสาหัส|แม้(?:ผู้เล่นจะ)?อยู่ในสถานะสาหัส/.test(part);
      if (flip[1] === 'คว่ำ' && /สาหัส/.test(part) && !allowWhileCritical) {
        unresolved.push('Critical-state LIFE restriction is stated but its exception cannot be mapped exactly');
      }
      effects.push({ kind: 'flip_life', face: flip[1] === 'หงาย' ? 'up' : 'down', count: Number(flip[2]),
        player: /ฝ่ายตรงข้าม|อีกฝ่าย/.test(part) ? 'opponent' : 'self', allowWhileCritical });
    } else if (symbolChange && duration && /Avatar/.test(part) && !/ทุกใบ|ทั้งหมด/.test(part)) {
      const symbol = symbolChange[1].replace(/^เป็น\s*/, '').trim();
      if (symbol) effects.push({ kind: 'change_symbol', symbol, target: 'selected_avatar', duration });
      else unresolved.push('Symbol change has no unambiguous destination Symbol');
    } else if ((power || setPower) && duration && (/Avatar/.test(part) || sourceTriggeredSelfPower) && !/ทุกใบ|ทั้งหมด/.test(part)) {
      effects.push(power
        ? { kind: 'modify_power', amount: Number(power[2]) * (power[1] === '-' ? -1 : 1),
          target: sourceTriggeredSelfPower ? 'source_avatar' : 'selected_avatar', duration }
        : { kind: 'set_power', value: Number(setPower![1]), target: 'selected_avatar', duration });
    } else {
      unresolved.push('effect clause has no complete verified Phase 2 primitive mapping');
    }
  }
  if (split.costText && !cost) unresolved.push('cost syntax is not represented by a validated typed cost primitive');
  if (split.costText && cost && cost.kind !== 'discard_from_hand' && cost.kind !== 'sacrifice_avatar') unresolved.push('typed cost primitive is not part of the Phase 2 atomic effect resolver');
  const keywordOnly = effects.length === 0 && keywordSpecs.some(spec => spec.kind === 'COMBAT_KEYWORD') && !split.costText && !/(?:เลือก|จั่ว|POWER\s*[+-]|POWER\s*(?:เท่ากับ|เป็น)|หงาย LIFE|คว่ำ LIFE|ทำลาย|กลับขึ้นมือ|เนรเทศ|สอดแนม|ธรณีสูบ|นำ.*(?:Deck|นรก)|อัญเชิญ)/i.test(effectText);
  if (!effects.length && !keywordOnly && !continuousAura && !equipRestriction && attachedPowerModifier === undefined && !attachedEndPhaseReady && !unresolved.length) unresolved.push('effect clause has no complete verified Phase 2 primitive mapping');
  const duration = /จนจบการต่อสู้/.test(effectText) ? 'END_OF_BATTLE' : /จนจบการโจมตี/.test(effectText) ? 'END_OF_ATTACK' : /จนจบเทิร์น/.test(effectText) ? 'END_OF_TURN' : /จนถึง Draw Phase ถัดไป/.test(effectText) ? 'NEXT_DRAW_PHASE' : undefined;
  if (/ถ้า|หาก|ตราบเท่าที่/.test(effectText) && !keywordOnly && !continuousAura) unresolved.push('condition expression is not fully represented by the supported condition AST');
  if (/(?:เลือก|POWER|ทำลาย|กลับขึ้นมือ|เนรเทศ|สอดแนม|ธรณีสูบ|นำ.*(?:Deck|นรก)|อัญเชิญ)/i.test(effectText) && !effects.length && !keywordOnly && !continuousAura) unresolved.push('targeted or zone-changing operation lacks a complete executable plan');
  return {
    source, ...(split.costText ? { costText: split.costText } : {}), effectText: split.effectText,
    costEffectSeparator: split.separator, keywords, keywordSpecs, timing, ...(cost ? { cost } : {}), conditions,
    ...(exactNagaJuti ? { selector: { controller: 'self' as const, cardTypes: ['Avatar'], zones: ['บนสนาม' as const],
      name: createNameReference('นาค', true), symbol: 'สัตว์มหัศจรรย์' } }
      : exactHellJuti ? { selector: { controller: 'self' as const, cardTypes: ['Avatar'], zones: ['ในนรก' as const], symbol: 'ยักษ์' } }
        : parseEffectSelector(effectText) ? { selector: parseEffectSelector(effectText) } : {}), ...(equipRestriction ? { equipRestriction } : {}),
    ...(attachedPowerModifier !== undefined ? { attachedPowerModifier } : {}), ...(attachedEndPhaseReady ? { attachedEndPhaseReady } : {}), ...(duration ? { duration } : {}),
    quotedReferences, exactNameReferences, effects, unresolved: [...new Set(unresolved)]
  };
}

export function toEffectDefinitions(
  effects: CardTextEffect[], actorId: string, targetInstanceIds: string[] = [], targetPlayerId?: string
): EffectDefinition[] {
  let targetIndex = 0;
  let lastAvatarTargetId = '';
  return effects.map(effect => {
    if (effect.kind === 'draw_self') return { kind: 'draw', playerId: actorId, count: effect.count };
    if (effect.kind === 'flip_life') return {
      kind: 'flip_life', playerId: targetPlayerId ?? (effect.player === 'self' ? actorId : ''),
      face: effect.face, count: effect.count, allowWhileCritical: effect.allowWhileCritical
    };
    if (effect.kind === 'schedule_avatar_destruction') return {
      kind: 'schedule_avatar_destruction', targetId: lastAvatarTargetId, playerId: actorId
    };
    if (effect.kind === 'destroy_avatar' || effect.kind === 'bounce_avatar' || effect.kind === 'banish_avatar') {
      const targetId = targetInstanceIds[targetIndex++];
      return effect.kind === 'destroy_avatar' ? { kind: 'destroy_avatar', targetId }
        : effect.kind === 'bounce_avatar' ? { kind: 'bounce_avatar', targetId }
        : { kind: 'banish_avatar', targetId };
    }
    if (effect.kind === 'destroy_construct' || effect.kind === 'bounce_construct' || effect.kind === 'banish_construct')
      return { kind: effect.kind, targetId: targetInstanceIds[targetIndex++] };
    if (effect.kind === 'return_to_deck') {
      const instanceIds = targetInstanceIds.slice(targetIndex, targetIndex + effect.count);
      targetIndex += effect.count;
      return { kind: 'return_to_deck', instanceIds, position: effect.position };
    }
    if (effect.kind === 'sacrifice_avatar') return { kind: 'sacrifice_avatar', targetId: targetInstanceIds[targetIndex++] };
    if (effect.kind === 'scout_cards') return { kind: 'scout_cards', playerId: actorId, count: effect.count,
      ...(effect.destination ? { destination: effect.destination } : {}), ...(effect.deckPosition ? { deckPosition: effect.deckPosition } : {}),
      selectionMin: effect.selectionMin ?? 0,
      selectionMax: effect.selectionMax ?? (effect.destination ? effect.count : 0),
      ...(effect.unselectedDeckPosition ? { unselectedDeckPosition: effect.unselectedDeckPosition } : {}) };
    if (effect.kind === 'mill_self') return { kind: 'mill', playerId: actorId, count: effect.count };
    if (effect.kind === 'cancel_pending_magic') return { kind: 'cancel_pending_magic' };
    if (effect.kind === 'search_deck_to_hand') {
      const instanceIds = targetInstanceIds.slice(targetIndex, targetIndex + effect.count);
      targetIndex += effect.count;
      return { kind: 'search_to_hand', playerId: actorId, instanceIds, name: effect.name.value,
        matching: effect.name.matching, cardType: effect.cardType, shuffle: effect.shuffle };
    }
    if (effect.kind === 'recover_from_hell') {
      const instanceIds = targetInstanceIds.slice(targetIndex, targetIndex + effect.count);
      targetIndex += effect.count;
      return { kind: 'recover_from_hell', playerId: actorId, instanceIds, count: effect.count, destination: effect.destination,
        cardType: effect.cardType,
        ...(effect.name ? { names: [effect.name, ...(effect.alternateNames ?? [])].map(reference => ({ value: reference.value, matching: reference.matching })) } : {}) };
    }
    if (effect.kind === 'summon_from_hell') return {
      kind: 'summon_from_hell', playerId: actorId, instanceId: targetInstanceIds[targetIndex++] ?? '', rested: effect.rested,
      cardType: 'Avatar', ...(effect.name ? { names: [{ value: effect.name.value, matching: effect.name.matching }] } : {}),
      ...(effect.symbol ? { symbol: effect.symbol } : {}), ...(effect.powerAtMost !== undefined ? { powerAtMost: effect.powerAtMost } : {})
    };
    const targetId = targetInstanceIds[targetIndex++] ?? '';
    if (effect.kind === 'set_power') return {
      kind: 'set_power', targetId, value: effect.value,
      layer: effect.duration === 'END_OF_BATTLE' || effect.duration === 'END_OF_ATTACK' ? 4 : 1,
      expiresAt: effect.duration === 'NEXT_DRAW_PHASE' ? 'DRAW_PHASE' : effect.duration === 'END_OF_BATTLE' || effect.duration === 'END_OF_ATTACK' ? 'END_OF_BATTLE' : 'END_OF_TURN'
    };
    if (effect.kind === 'change_symbol') return {
      kind: 'change_symbol', targetId, symbol: effect.symbol,
      layer: 1,
      expiresAt: effect.duration === 'NEXT_DRAW_PHASE' ? 'DRAW_PHASE' : effect.duration === 'END_OF_BATTLE' || effect.duration === 'END_OF_ATTACK' ? 'END_OF_BATTLE' : 'END_OF_TURN'
    };
    if (effect.kind === 'modify_power') {
      lastAvatarTargetId = targetId;
      return {
        kind: 'modify_power', targetId, amount: effect.amount,
      layer: effect.duration === 'END_OF_BATTLE' || effect.duration === 'END_OF_ATTACK' ? 4 : 1,
      ...(effect.duration === 'PERMANENT' ? { permanent: true } : { expiresAt: effect.duration === 'NEXT_DRAW_PHASE' ? 'DRAW_PHASE' : effect.duration === 'END_OF_BATTLE' || effect.duration === 'END_OF_ATTACK' ? 'END_OF_BATTLE' : 'END_OF_TURN' })
      };
    }
  });
}

/** Compile only a complete, supported clause; callers provide concrete choices explicitly. */
export function toEffectPlan(
  clause: ParsedCardTextClause,
  actorId: string,
  costInstanceIds: string[] = [],
  state?: GameState,
  targetInstanceIds: string[] = []
): EffectPlan | null {
  if (clause.unresolved.length || clause.effects.length === 0) return null;
  const requiredBindings = clause.effects.reduce((total, effect) => total +
    (effect.kind === 'return_to_deck' || effect.kind === 'search_deck_to_hand' || effect.kind === 'recover_from_hell' ? effect.count :
      effect.kind === 'modify_power' || effect.kind === 'set_power' || effect.kind === 'change_symbol' || effect.kind === 'destroy_avatar' || effect.kind === 'bounce_avatar' || effect.kind === 'banish_avatar' || effect.kind === 'destroy_construct' || effect.kind === 'bounce_construct' || effect.kind === 'banish_construct' || effect.kind === 'sacrifice_avatar' || effect.kind === 'summon_from_hell' ? 1 : 0), 0);
  const supportsPendingHellChoice = clause.effects.length === 1 &&
    (clause.effects[0].kind === 'recover_from_hell' || clause.effects[0].kind === 'summon_from_hell') && targetInstanceIds.length === 0;
  if ((!supportsPendingHellChoice && targetInstanceIds.length !== requiredBindings) || new Set(targetInstanceIds).size !== targetInstanceIds.length) return null;
  if (requiredBindings > 0 && !supportsPendingHellChoice) {
    if (!state) return null;
    const selector = clause.selector;
    let bindingIndex = 0;
    for (const effect of clause.effects) {
      if (effect.kind === 'modify_power' || effect.kind === 'set_power' || effect.kind === 'change_symbol' || effect.kind === 'destroy_avatar' || effect.kind === 'bounce_avatar' || effect.kind === 'banish_avatar' || effect.kind === 'destroy_construct' || effect.kind === 'bounce_construct' || effect.kind === 'banish_construct' || effect.kind === 'return_to_deck' || effect.kind === 'sacrifice_avatar' || effect.kind === 'recover_from_hell' || effect.kind === 'summon_from_hell') {
        const targetCount = effect.kind === 'return_to_deck' || effect.kind === 'recover_from_hell' ? effect.count : 1;
        const targetIds = targetInstanceIds.slice(bindingIndex, bindingIndex + targetCount);
        bindingIndex += targetCount;
        const fieldAndPrivateCards = Object.values(state.players).flatMap(player => [...player.avatarZone, ...player.constructZone, ...player.magicZone, ...player.hand, ...player.hell, ...player.deck, ...player.lifeDeck]);
        const requiredType = effect.kind === 'destroy_construct' || effect.kind === 'bounce_construct' || effect.kind === 'banish_construct' ? 'Construct' : effect.kind === 'recover_from_hell' ? effect.cardType : effect.kind === 'destroy_avatar' || effect.kind === 'bounce_avatar' || effect.kind === 'banish_avatar' || effect.kind === 'sacrifice_avatar' || effect.kind === 'modify_power' || effect.kind === 'set_power' || effect.kind === 'change_symbol' || effect.kind === 'summon_from_hell' ? 'Avatar' : undefined;
        const targets = targetIds.map(targetId => fieldAndPrivateCards.find(card => card.instanceId === targetId));
        const matchesZoneSelector = (targetId: string) => {
          if (!selector?.zones.length) return true;
          const zone = state.playerOrder.flatMap(playerId => {
            const player = state.players[playerId];
            if (!player) return [];
            return (['avatarZone', 'constructZone', 'magicZone', 'hell', 'deck', 'hand', 'lifeDeck'] as const)
              .filter(zoneName => player[zoneName].some(card => card.instanceId === targetId));
          })[0];
          const zoneLabel: CardTextZone | undefined = zone === 'avatarZone' || zone === 'constructZone' || zone === 'magicZone'
            ? 'บนสนาม' : zone === 'hell' ? 'ในนรก' : zone === 'deck' ? 'จาก Deck' : zone === 'hand' ? 'บนมือ' : zone === 'lifeDeck' ? 'LIFE' : undefined;
          return !!zoneLabel && selector.zones.includes(zoneLabel);
        };
        if (targets.some((target, index) => !target || (requiredType && target.card.type !== requiredType) || (selector?.cardTypes.length && !selector.cardTypes.includes(target.card.type)) ||
          (selector?.symbol !== undefined && !target.card.symbol?.includes(selector.symbol)) ||
          (selector?.name && effect.kind !== 'recover_from_hell' && !matchesCardName(target.card.name, selector.name, parseCardNameRules(target.card))) ||
          (selector?.cost && (selector.cost.comparison === 'at_most' ? target.card.cost > selector.cost.value : target.card.cost < selector.cost.value)) ||
          !(['recover_from_hell', 'summon_from_hell'].includes(effect.kind) || matchesZoneSelector(targetIds[index])) ||
          (selector?.controller === 'self' && target.controllerId !== actorId) ||
          (selector?.controller === 'opponent' && target.controllerId === actorId) ||
          (effect.kind === 'sacrifice_avatar' && target.controllerId !== actorId))) return null;
        if ((effect.kind === 'recover_from_hell' || effect.kind === 'summon_from_hell') && targetIds.some(targetId => {
          const card = state.players[actorId]?.hell.find(item => item.instanceId === targetId);
          const references = effect.name ? [effect.name, ...(effect.kind === 'recover_from_hell' ? effect.alternateNames ?? [] : [])] : [];
          return !card || (references.length > 0 && !references.some(reference => matchesCardName(card.card.name, reference, parseCardNameRules(card.card))));
        })) return null;
      } else if (effect.kind === 'search_deck_to_hand') {
        const player = state.players[actorId];
        const selected = targetInstanceIds.slice(bindingIndex, bindingIndex + effect.count);
        if (!player || selected.some(id => {
          const card = player.deck.find(item => item.instanceId === id);
          return !card || card.card.type !== effect.cardType || !matchesCardName(card.card.name, effect.name, parseCardNameRules(card.card));
        })) return null;
        bindingIndex += effect.count;
      }
    }
  }
  const costs: EffectCost[] = [];
  if (clause.cost) {
    if (costInstanceIds.length !== clause.cost.count || !state || new Set(costInstanceIds).size !== costInstanceIds.length) return null;
    const player = state.players[actorId];
    const selector = 'selector' in clause.cost ? clause.cost.selector : undefined;
    if (!player) return null;
    if (clause.cost.kind === 'discard_from_hand') {
      const selected = costInstanceIds.map(id => player.hand.find(card => card.instanceId === id));
      if (selected.some(card => !card)) return null;
      if (selector && selected.some(card => !card || (selector.cardTypes.length > 0 && !selector.cardTypes.includes(card.card.type)) ||
        (selector.symbol !== undefined && card.card.symbol !== selector.symbol))) return null;
      costs.push({ kind: 'discard_from_hand', playerId: actorId, instanceIds: [...costInstanceIds] });
    } else if (clause.cost.kind === 'sacrifice_avatar') {
      const selected = costInstanceIds.map(id => player.avatarZone.find(card => card.instanceId === id));
      if (selected.some(card => !card || card.card.type !== 'Avatar' || card.controllerId !== actorId ||
        (selector?.cardTypes.length && !selector.cardTypes.includes(card.card.type)) ||
        (selector?.symbol && !card.card.symbol?.includes(selector.symbol)))) return null;
      costs.push(...costInstanceIds.map(instanceId => ({ kind: 'sacrifice_avatar' as const, playerId: actorId, instanceId })));
    } else return null;
  }
  const lifeEffect = clause.effects.find((effect): effect is Extract<CardTextEffect, { kind: 'flip_life' }> => effect.kind === 'flip_life');
  let targetPlayerId: string | undefined;
  if (lifeEffect) {
    if (!state) return null;
    targetPlayerId = lifeEffect.player === 'self'
      ? actorId
      : state.playerOrder.find(playerId => playerId !== actorId);
    const player = targetPlayerId ? state.players[targetPlayerId] : undefined;
    if (!player || (lifeEffect.face === 'down' && player.isCritical && !lifeEffect.allowWhileCritical) ||
      player.lifeDeck.filter(card => card.isFaceUp !== (lifeEffect.face === 'up')).length < lifeEffect.count) return null;
  }
  const conditions: EffectCondition[] = [];
  for (const condition of clause.conditions) {
    const playerId = condition.controller === 'self'
      ? actorId
      : state?.playerOrder.find(id => id !== actorId);
    if (!playerId) return null;
    if (condition.kind === 'avatar_name') conditions.push({
      kind: 'player_has_avatar', playerId, nameIncludes: condition.name.value, matching: condition.name.matching === 'EXACT_CARD_NAME' ? 'EXACT_CARD_NAME' : 'DELIMITED_WORD_SEQUENCE'
    });
    else if (condition.kind === 'avatar_symbol') conditions.push({ kind: 'player_has_avatar_symbol', playerId, symbol: condition.symbol });
    else if (condition.kind === 'hell_count') conditions.push({
      kind: 'player_hell_count', playerId, minimum: condition.minimum,
      ...(condition.cardType ? { cardType: condition.cardType } : {}),
      ...(condition.nameIncludes ? { nameIncludes: condition.nameIncludes } : {}),
      ...(condition.matching ? { matching: condition.matching } : {})
    });
    else if (condition.kind === 'zone_count') conditions.push({
      kind: 'player_zone_count', playerId, zone: condition.zone,
      comparison: condition.comparison, value: condition.value
    });
    else conditions.push({ kind: 'player_is_critical', playerId });
  }
  return { actorId, costs, ...(conditions.length ? { conditions } : {}), effects: toEffectDefinitions(clause.effects, actorId, targetInstanceIds, targetPlayerId) };
}

export function activateRegisteredCardTextAbility(
  state: GameState,
  sourceInstanceId: string,
  abilityIndex: number,
  bindings: { costInstanceIds?: string[]; targetInstanceIds?: string[] } = {}
): import('./effectResolver').EffectResolution {
  const activeCards = state.playerOrder.flatMap(playerId => {
    const player = state.players[playerId];
    return player ? [...player.avatarZone, ...player.constructZone, ...player.magicZone] : [];
  }).concat(state.landMagicZone ? [state.landMagicZone] : []);
  const source = activeCards.find(card => card.instanceId === sourceInstanceId);
  const clause = source?.registeredActivatedAbilities?.[abilityIndex];
  if (!source || !clause) return { ok: false, state, logs: [], reason: 'Activated ability is not registered on an active field card' };
  const activePlayerId = state.playerOrder[state.currentTurnPlayerIndex];
  const explicitlyBattle = /Battle Phase|ช่วง Battle Phase|ช่วงต่อสู้/.test(clause.source);
  const explicitlyOpponentTurn = /เทิร์นฝ่ายตรงข้าม|ในเทิร์นของฝ่ายตรงข้าม/.test(clause.source);
  const timingAllowed = explicitlyOpponentTurn
    ? activePlayerId !== source.controllerId
    : explicitlyBattle ? state.currentPhase === 'BATTLE' && activePlayerId === source.controllerId
      : state.currentPhase === 'MAIN' && activePlayerId === source.controllerId;
  if (!timingAllowed) return { ok: false, state, logs: [], reason: 'Activated ability timing is not currently permitted' };
  const player = state.players[source.controllerId];
  if (!player) return { ok: false, state, logs: [], reason: 'Ability controller does not exist' };
  const usageKey = `${state.turnNumber}:${source.controllerId}:${source.instanceId}:card-text:${abilityIndex}`;
  if (clause.timing.frequency === 'ONCE_PER_TURN' && state.triggerUsage?.includes(usageKey)) {
    return { ok: false, state, logs: [], reason: 'Activated ability has already been used this turn' };
  }
  const magicType = parseCardText(source.card).magicUse.abilityConsumesMagicType;
  if (magicType && player.usedMagicTypesThisTurn.has(magicType)) {
    return { ok: false, state, logs: [], reason: `${magicType} Magic quota has already been used this turn` };
  }
  const plan = toEffectPlan(clause, source.controllerId, bindings.costInstanceIds, state, bindings.targetInstanceIds);
  if (!plan) return { ok: false, state, logs: [], reason: 'Activated ability has unresolved costs, targets, or effects' };
  const stagedPlayer = {
    ...player,
    usedMagicTypesThisTurn: new Set(player.usedMagicTypesThisTurn)
  };
  if (magicType) stagedPlayer.usedMagicTypesThisTurn.add(magicType);
  const staged = { ...state, players: { ...state.players, [player.id]: stagedPlayer } };
  const result = resolveEffectPlan(staged, plan);
  if (!result.ok) return { ...result, state };
  if (clause.timing.frequency === 'ONCE_PER_TURN') {
    result.state.triggerUsage = [...(result.state.triggerUsage ?? []), usageKey];
  }
  return result;
}

export function effectiveMagicSubtype(parsed: CardTextAdapterResult, printedSubtype: MagicSubtype): MagicSubtype {
  return parsed.magicUse.magicSubtypeOverride ?? printedSubtype;
}

export function magicCancellationTargetType(parsed: CardTextAdapterResult): MagicSubtype | undefined {
  return parsed.magicUse.magicSubtypeOverride;
}

export function validateAbilityMagicQuota(state: GameState, playerId: string, parsed: CardTextAdapterResult): string | null {
  const type = parsed.magicUse.abilityConsumesMagicType;
  if (!type) return null;
  const player = state.players[playerId];
  if (!player) return 'Player does not exist';
  return player.usedMagicTypesThisTurn.has(type) ? `${type} Magic has already been used this turn` : null;
}

export function toCardTextEffectPlan(
  result: CardTextAdapterResult,
  actorId: string,
  bindings: Array<{ costInstanceIds?: string[]; targetInstanceIds?: string[] }> = [],
  state?: GameState
): EffectPlan | null {
  if (result.status !== 'PARSED_READY') return null;
  const operationClauses = result.clauses.filter(clause => clause.effects.length > 0 || clause.cost);
  const nonEffectClauses = result.clauses.filter(clause => clause.effects.length === 0 && !clause.cost);
  if (nonEffectClauses.some(clause => !clause.equipRestriction && !clause.keywordSpecs.some(spec => spec.kind === 'COMBAT_KEYWORD'))) return null;
  const costs: EffectCost[] = [];
  const conditions: EffectCondition[] = [];
  const effects: EffectDefinition[] = [];
  const sequence: NonNullable<EffectPlan['sequence']> = [];
  for (const [index, clause] of operationClauses.entries()) {
    const plan = toEffectPlan(clause, actorId, bindings[index]?.costInstanceIds ?? [], state, bindings[index]?.targetInstanceIds ?? []);
    if (!plan) return null;
    for (const cost of plan.costs ?? []) {
      costs.push(cost);
      sequence.push({ kind: 'cost', cost });
    }
    conditions.push(...(plan.conditions ?? []));
    for (const effect of plan.effects) {
      effects.push(effect);
      sequence.push({ kind: 'effect', effect });
    }
  }
  return effects.length ? { actorId, costs, ...(conditions.length ? { conditions } : {}), effects, sequence } : null;
}

const TRIGGER_EVENT_TYPES: Record<string, TriggerAbility['eventType']> = {
  AVATAR_SUMMONED: 'AVATAR_SUMMONED', AVATAR_DESTROYED: 'AVATAR_DESTROYED',
  EXACT_COST: 'AVATAR_SUMMONED', BEFORE_MAIN_PHASE: 'PHASE_STARTED',
  ATTACK_DECLARED: 'ATTACK_DECLARED', BATTLE_STARTED: 'ATTACK_DECLARED',
  BATTLE_ENDED: 'BATTLE_ENDED', TURN_ENDED: 'TURN_ENDED', PHASE_STARTED: 'PHASE_STARTED',
  LIFE_REVEALED: 'LIFE_REVEALED', MAGIC_PLAYED: 'MAGIC_PLAYED'
};

/** Maps a fully bound parsed trigger into Phase 2's typed TriggerAbility registration shape. */
export function toTriggerAbility(
  clause: ParsedCardTextClause,
  id: string,
  actorId: string,
  options: { costInstanceIds?: string[]; targetInstanceIds?: string[]; state?: GameState; sourceInstanceId?: string } = {}
): TriggerAbility | null {
  const eventType = clause.timing.event ? TRIGGER_EVENT_TYPES[clause.timing.event] : undefined;
  if (!eventType || clause.timing.mode === 'CONTINUOUS' || clause.timing.mode === 'ACTIVATED') return null;
  const isSourceBoundPower = clause.effects.some(effect => effect.kind === 'modify_power' && effect.target === 'source_avatar');
  const targetInstanceIds = options.targetInstanceIds?.length
    ? options.targetInstanceIds
    : isSourceBoundPower && options.sourceInstanceId ? [options.sourceInstanceId] : undefined;
  const plan = toEffectPlan(clause, actorId, options.costInstanceIds, options.state, targetInstanceIds);
  if (!plan) return null;
  return {
    id, eventType, effects: plan.effects,
    ...(plan.costs?.length ? { costs: plan.costs } : {}),
    ...(plan.conditions?.length ? { conditions: plan.conditions } : {}),
    ...(options.sourceInstanceId ? { sourceInstanceId: options.sourceInstanceId } : {}),
    ...(clause.timing.actorRelation ? { actorRelation: clause.timing.actorRelation } : {}),
    ...(clause.timing.eventSubject === 'SOURCE' ? { eventSubject: 'SOURCE' } : {}),
    ...(clause.timing.requiresExactGemPaid ? { requiresExactGemPaid: true } : {}),
    ...(clause.timing.phase ? { phase: clause.timing.phase } : {}),
    ...(clause.timing.frequency === 'ONCE_PER_TURN' ? { frequency: 'ONCE_PER_TURN' } : {})
  };
}

export function parseCardText(card: Card): CardTextAdapterResult {
  const source = (card.mainEffect ?? '').normalize('NFC').trim();
  const lines = source.replace(/<br\s*\/?>/gi, '\n').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const ruleTexts: string[] = [];
  const abilityLines: string[] = [];
  for (const line of lines) {
    const marker = line.match(/#(?=\s|[ก-๙])/);
    const hashIndex = marker?.index ?? -1;
    if (hashIndex >= 0) {
      if (line.slice(0, hashIndex).trim()) abilityLines.push(line.slice(0, hashIndex).trim());
      const ruleText = line.slice(hashIndex + 1).trim();
      if (ruleText) ruleTexts.push(ruleText);
    } else abilityLines.push(line);
  }
  const exactCostCondition = /(?:^|\n)\s*พอดี(?:\s|\()/u.test(source);
  const clauses = abilityLines.map(parseClause).map(clause => clause.timing.event === 'AVATAR_SUMMONED' && exactCostCondition
    ? { ...clause, timing: { ...clause.timing, requiresExactGemPaid: true } } : clause);
  const continuousEffects = clauses.flatMap(clause => clause.timing.mode === 'CONTINUOUS' ||
    clause.source === 'Avatar เผ่าแมลง สัตว์ รัททาทุย และมนุษย์ POWER +1' ||
    clause.source === 'Avatar "นาค" ที่เป็น Symbol สัตว์มหัศจรรย์ POWER +1'
      ? parseContinuousPowerEffects(clause.source) : []);
  const taggedMagic = [...source.matchAll(/ความสามารถนี้ถือเป็นการใช้\s+(Normal|Modification|React|Land)\s+Magic/gi)].map(match => MAGIC_TYPES[match[1]]);
  const overrideMagic = [...source.matchAll(/โดยถือว่าเป็นการใช้\s+(Normal|Modification|React|Land)\s+Magic/gi)].map(match => MAGIC_TYPES[match[1]]);
  const magicUse = {
    ...(taggedMagic.length === 1 ? { abilityConsumesMagicType: taggedMagic[0] } : {}),
    ...(overrideMagic.length === 1 ? { magicSubtypeOverride: overrideMagic[0] } : {})
  };
  const reasons = clauses.flatMap(clause => clause.unresolved);
  if (clauses.some(clause => clause.attachedPowerModifier !== undefined || clause.attachedEndPhaseReady) &&
    (card.type !== 'Magic' || card.subtype !== 'Modification')) {
    reasons.push('attached POWER modifier requires a Modification Magic attachment context');
  }
  const nameRules = parseCardNameRules(card);
  const executableNameRuleCount = nameRules.secondaryNames.length + nameRules.additionalPrimaryNames.length;
  if (ruleTexts.length > executableNameRuleCount) reasons.push('inherent # Rule Text is retained as rule metadata but has no complete executable specification');
  if (taggedMagic.length > 1 || overrideMagic.length > 1) reasons.push('multiple or conflicting Magic type declarations');
  if (taggedMagic.length > 0 && overrideMagic.length > 0 && (taggedMagic.length !== 1 || overrideMagic.length !== 1)) reasons.push('cannot disambiguate mixed Magic-use declarations');
  const hasExecutableRule = clauses.some(clause => clause.effects.length > 0 || clause.equipRestriction !== undefined ||
    clause.attachedPowerModifier !== undefined || clause.attachedEndPhaseReady || clause.keywordSpecs.some(spec => spec.kind === 'COMBAT_KEYWORD')) || continuousEffects.length > 0;
  if (!hasExecutableRule) reasons.push('card has no executable effect, combat keyword, equip restriction, or continuous rule');
  if (AMBIGUOUS_WORDING.test(source)) reasons.push('wording explicitly matches an unresolved or ambiguous-rule marker');
  const status: CardTextStatus = AMBIGUOUS_WORDING.test(source) || reasons.some(reason => /conflicting|cannot disambiguate|ambiguous-rule/.test(reason))
    ? 'AMBIGUOUS' : reasons.length ? 'UNSUPPORTED' : 'PARSED_READY';
  const resolvedClauses = status === 'PARSED_READY' ? clauses : clauses.map(clause => ({ ...clause, effects: [] }));
  return {
    status, ...(reasons.length ? { reason: [...new Set(reasons)].join('; ') } : {}),
    attributes: {
      printId: card.printId, name: card.name, type: card.type, subtype: card.subtype ?? null,
      soi: card.soi, cost: card.cost, gem: card.gem, gemColor: card.gemColor ?? null,
      power: card.power, symbol: card.symbol ?? null, color: card.color, rarity: card.rarity,
      dropRate: card.dropRate, favorText: card.favorText, creator: card.creator,
      isOnlyOne: card.isOnlyOne, isBias: card.isBias, isCollab: card.isCollab,
      ...(ruleTexts.length ? { ruleTextProtected: true } : {})
    }, ruleTexts, nameRules, clauses: resolvedClauses, continuousEffects, magicUse
  };
}

export function parseCardTextDatabase(cards: Card[]): Record<CardTextStatus, number> {
  const totals: Record<CardTextStatus, number> = { PARSED_READY: 0, UNSUPPORTED: 0, AMBIGUOUS: 0 };
  for (const card of cards) totals[parseCardText(card).status] += 1;
  return totals;
}
