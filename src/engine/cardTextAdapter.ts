import type { Card, MagicSubtype } from './types';
import type { EffectCost, EffectDefinition, EffectPlan } from './effectResolver';
import type { GameState } from './types';
import type { TriggerAbility } from './triggerEngine';
import type { GameEvent } from './gameEvents';

export type CardTextEffect =
  | { kind: 'draw_self'; count: number }
  | { kind: 'modify_power'; amount: number; target: 'selected_avatar'; duration: CardTextDuration }
  | { kind: 'set_power'; value: number; target: 'selected_avatar'; duration: CardTextDuration }
  | { kind: 'change_symbol'; symbol: string; target: 'selected_avatar'; duration: CardTextDuration }
  | { kind: 'flip_life'; face: 'up' | 'down'; count: number; player: 'self' | 'opponent'; allowWhileCritical: boolean }
  | { kind: 'search_deck_to_hand'; cardType: string; name: NameReference; count: number; shuffle: boolean }
  | { kind: 'destroy_avatar' | 'bounce_avatar' | 'banish_avatar'; target: 'selected_avatar' }
  | { kind: 'destroy_construct' | 'bounce_construct' | 'banish_construct'; target: 'selected_construct' }
  | { kind: 'return_to_deck'; target: 'selected_card'; count: number; position: 'shuffle' | 'top' | 'bottom' }
  | { kind: 'sacrifice_avatar'; target: 'selected_avatar' }
  | { kind: 'scout_cards'; count: number; destination?: 'hand' | 'hell' | 'deck'; deckPosition?: 'top' | 'bottom' }
  | { kind: 'mill_self'; count: number };
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
export type CardTextSelector = {
  controller: 'self' | 'opponent' | 'either';
  cardTypes: string[];
  zones: CardTextZone[];
  name?: NameReference;
  symbol?: string;
  cost?: { comparison: 'at_most' | 'at_least'; value: number };
};
export type CardTextDuration = 'END_OF_BATTLE' | 'END_OF_ATTACK' | 'END_OF_TURN' | 'NEXT_DRAW_PHASE';
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
  selector?: CardTextSelector;
  duration?: CardTextDuration;
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
  [/เมื่อโจมตี/, 'ATTACK_DECLARED'], [/เมื่อต่อสู้/, 'BATTLE_STARTED'],
  [/เมื่อจบเทิร์น|ในช่วง End Phase/i, 'TURN_ENDED'], [/ก่อนเริ่ม Main Phase/, 'BEFORE_MAIN_PHASE'],
  [/เมื่อหงาย LIFE Card|เมื่อ LIFE Card ถูกหงาย/, 'LIFE_REVEALED'],
  [/จุติ\s*\(/, 'AVATAR_SUMMONED'], [/คำสั่งเสีย\s*\(/, 'AVATAR_DESTROYED'],
  [/พอดี\s*\(/, 'EXACT_COST']
];

function splitCostEffect(source: string): { costText?: string; effectText: string; separator: ':' | null } {
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
export function matchesCardName(cardName: string, reference: NameReference): boolean {
  if (reference.kind === 'exact-name') return cardName.trim() === reference.value;
  const escape = reference.value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s\\p{P}])${escape}(?=$|[\\s\\p{P}])`, 'u').test(cardName);
}

function parseSelector(source: string): CardTextSelector | undefined {
  const cardTypes = ['Avatar', 'Construct', 'Magic', 'LIFE Card'].filter(type => source.includes(type));
  const zones: CardTextZone[] = (['บนสนาม', 'ในนรก', 'จาก Deck', 'บนมือ', 'LIFE'] as CardTextZone[]).filter(zone => source.includes(zone));
  const quoted = source.match(/"([^\"]+)"/);
  const exact = source.match(/ชื่อ\s+([^\"“”{},:()]+?)(?=\s+(?:\d+\s*ใบ|จาก|บน|ได้|เท่านั้น)|[,.:：]|$)/);
  const symbol = source.match(/\{\s*symbol\s+([^}]+)\}/i);
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

function parseTiming(source: string): CardTextTiming {
  const event = EVENT_HEADERS.find(([pattern]) => pattern.test(source))?.[1];
  const frequency = /เทิร์นละครั้ง/.test(source) ? 'ONCE_PER_TURN' : undefined;
  const mode = /ต่อเนื่อง/.test(source) ? 'CONTINUOUS' : /สั่งใช้/.test(source) ? 'ACTIVATED' : /อัตโนมัติ/.test(source) ? 'AUTOMATIC' : undefined;
  return { ...(frequency ? { frequency } : {}), ...(mode ? { mode } : {}), ...(event ? { event } : {}) };
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

function parseClause(source: string): ParsedCardTextClause {
  const split = splitCostEffect(source);
  const keywords = KEYWORDS.filter(keyword => source.includes(keyword));
  const quotedReferences = [...split.effectText.matchAll(/"([^\"]+)"/g)].map(match => createNameReference(match[1], true));
  const exactNameReferences = [...split.effectText.matchAll(/ชื่อ\s+([^\"“”{},:()]+?)(?=\s+(?:\d+\s*ใบ|จาก|บน|ได้|เท่านั้น)|[,.:：]|$)/g)].map(match => createNameReference(match[1].trim(), false));
  const timing = parseTiming(source);
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
  const standaloneKeywordDefinition = keywords.some(keyword => ['สามัคคี', 'โล่มนุษย์', 'เตะไข่', 'ลูกฮึด', 'แทงหลัง', 'คู่หู'].includes(keyword)) &&
    !split.costText && !split.separator && /^\s*(?:สามัคคี|โล่มนุษย์|เตะไข่|ลูกฮึด|แทงหลัง|คู่หู)(?:\s*\([^)]*\)|\s*[-–:]\s*[^\n]+)?\s*$/.test(effectText);
  const parts = standaloneKeywordDefinition ? [] : effectText.split(/\s+(?:และ|จากนั้น)\s+/).map(part => part.trim()).filter(Boolean);
  for (const part of parts) {
    const draw = part.match(/^(?:จั่วการ์ด(?:จาก\s+Deck(?:\s+เรา)?)?)\s*(\d+)\s*ใบ(?:\s*หลังจากนั้นสับ Deck)?$/i);
    const flip = part.match(/^(หงาย|คว่ำ)\s*LIFE Card\s*(?:ใบบนสุด\s*)?(?:ของฝ่ายตรงข้าม|ของอีกฝ่าย|ฝ่ายตรงข้าม|ของเรา|ฝ่ายเรา)?\s*(\d+)\s*ใบ/i);
    const power = part.match(/POWER\s*([+-])\s*(\d+)\b/i);
    const setPower = part.match(/POWER\s*(?:เท่ากับ|เป็น)\s*(\d+)\b/i);
    const symbolChange = part.match(/เปลี่ยน\s*Symbol(?:\s+ของ\s+Avatar\s+[^\s,]+)?\s*(?:เป็น)?\s*([^,;]+?)(?:\s+จนจบ(?:การต่อสู้|การโจมตี|เทิร์น)|\s+จนถึง Draw Phase ถัดไป|$)/i);
    const search = part.match(/นำ\s+(Avatar|Construct|Magic)\s+ชื่อ\s+(?:\"([^\"]+)\"|([^\s]+(?:\s+[^\s]+)*?))\s+(\d+)\s*ใบจาก\s+Deck\s+ขึ้นมือ(?:\s+หลังจากนั้นสับ\s+Deck)?/i);
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
    const duration = /จนจบการต่อสู้/.test(part) ? 'END_OF_BATTLE' : /จนจบการโจมตี/.test(part) ? 'END_OF_ATTACK' : /จนจบเทิร์น/.test(part) ? 'END_OF_TURN' : /จนถึง Draw Phase ถัดไป/.test(part) ? 'NEXT_DRAW_PHASE' : undefined;
    if (destroy) effects.push({ kind: 'destroy_avatar', target: 'selected_avatar' });
    else if (bounce) effects.push({ kind: 'bounce_avatar', target: 'selected_avatar' });
    else if (banish) effects.push({ kind: 'banish_avatar', target: 'selected_avatar' });
    else if (destroyConstruct) effects.push({ kind: 'destroy_construct', target: 'selected_construct' });
    else if (constructTarget && /กลับขึ้นมือ/.test(part)) effects.push({ kind: 'bounce_construct', target: 'selected_construct' });
    else if (constructTarget && /เนรเทศ/.test(part)) effects.push({ kind: 'banish_construct', target: 'selected_construct' });
    else if (deckReturn) effects.push({ kind: 'return_to_deck', target: 'selected_card',
      count: Number(deckReturn[0].match(/(\d+)\s*ใบ/)?.[1] ?? 1),
      position: /กลับเข้า\s*Deck/.test(deckReturn[0]) ? 'shuffle' : /บนสุด/.test(deckReturn[0]) ? 'top' : 'bottom' });
    else if (sacrificeEffect && /Avatar/.test(part)) effects.push({ kind: 'sacrifice_avatar', target: 'selected_avatar' });
    else if (scout) effects.push({ kind: 'scout_cards', count: Number(scout[1]),
      ...( /ขึ้นมือ/.test(part) ? { destination: 'hand' as const } : /ลงนรก/.test(part) ? { destination: 'hell' as const } : /ไว้บนสุด/.test(part) ? { destination: 'deck' as const, deckPosition: 'top' as const } : /ไว้ใต้\s*Deck|ล่างสุด/.test(part) ? { destination: 'deck' as const, deckPosition: 'bottom' as const } : {}) });
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
    } else if ((power || setPower) && duration && /Avatar/.test(part) && !/ทุกใบ|ทั้งหมด/.test(part)) {
      effects.push(power
        ? { kind: 'modify_power', amount: Number(power[2]) * (power[1] === '-' ? -1 : 1), target: 'selected_avatar', duration }
        : { kind: 'set_power', value: Number(setPower![1]), target: 'selected_avatar', duration });
    } else {
      unresolved.push('effect clause has no complete verified Phase 2 primitive mapping');
    }
  }
  if (split.costText && !cost) unresolved.push('cost syntax is not represented by a validated typed cost primitive');
  if (split.costText && cost && cost.kind !== 'discard_from_hand' && cost.kind !== 'sacrifice_avatar') unresolved.push('typed cost primitive is not part of the Phase 2 atomic effect resolver');
  const keywordOnly = effects.length === 0 && keywordSpecs.some(spec => spec.kind === 'COMBAT_KEYWORD') && !split.costText && !/(?:เลือก|จั่ว|POWER\s*[+-]|POWER\s*(?:เท่ากับ|เป็น)|หงาย LIFE|คว่ำ LIFE|ทำลาย|กลับขึ้นมือ|เนรเทศ|สอดแนม|ธรณีสูบ|นำ.*(?:Deck|นรก)|อัญเชิญ)/i.test(effectText);
  if (!effects.length && !keywordOnly && !unresolved.length) unresolved.push('effect clause has no complete verified Phase 2 primitive mapping');
  const duration = /จนจบการต่อสู้/.test(effectText) ? 'END_OF_BATTLE' : /จนจบการโจมตี/.test(effectText) ? 'END_OF_ATTACK' : /จนจบเทิร์น/.test(effectText) ? 'END_OF_TURN' : /จนถึง Draw Phase ถัดไป/.test(effectText) ? 'NEXT_DRAW_PHASE' : undefined;
  if (/ถ้า|หาก|ตราบเท่าที่/.test(effectText) && !keywordOnly) unresolved.push('condition expression is not fully represented by the supported condition AST');
  if (/(?:เลือก|POWER|ทำลาย|กลับขึ้นมือ|เนรเทศ|สอดแนม|ธรณีสูบ|นำ.*(?:Deck|นรก)|อัญเชิญ)/i.test(effectText) && !effects.length && !keywordOnly) unresolved.push('targeted or zone-changing operation lacks a complete executable plan');
  return {
    source, ...(split.costText ? { costText: split.costText } : {}), effectText: split.effectText,
    costEffectSeparator: split.separator, keywords, keywordSpecs, timing, ...(cost ? { cost } : {}),
    ...(parseSelector(effectText) ? { selector: parseSelector(effectText) } : {}), ...(duration ? { duration } : {}),
    quotedReferences, exactNameReferences, effects, unresolved: [...new Set(unresolved)]
  };
}

export function toEffectDefinitions(
  effects: CardTextEffect[], actorId: string, targetInstanceIds: string[] = [], targetPlayerId?: string
): EffectDefinition[] {
  let targetIndex = 0;
  return effects.map(effect => {
    if (effect.kind === 'draw_self') return { kind: 'draw', playerId: actorId, count: effect.count };
    if (effect.kind === 'flip_life') return {
      kind: 'flip_life', playerId: targetPlayerId ?? (effect.player === 'self' ? actorId : ''),
      face: effect.face, count: effect.count, allowWhileCritical: effect.allowWhileCritical
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
      ...(effect.destination ? { destination: effect.destination } : {}), ...(effect.deckPosition ? { deckPosition: effect.deckPosition } : {}) };
    if (effect.kind === 'mill_self') return { kind: 'mill', playerId: actorId, count: effect.count };
    if (effect.kind === 'search_deck_to_hand') {
      const instanceIds = targetInstanceIds.slice(targetIndex, targetIndex + effect.count);
      targetIndex += effect.count;
      return { kind: 'search_to_hand', playerId: actorId, instanceIds, name: effect.name.value,
        matching: effect.name.matching, cardType: effect.cardType, shuffle: effect.shuffle };
    }
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
    if (effect.kind === 'modify_power') return {
      kind: 'modify_power', targetId, amount: effect.amount,
      layer: effect.duration === 'END_OF_BATTLE' || effect.duration === 'END_OF_ATTACK' ? 4 : 1,
      expiresAt: effect.duration === 'NEXT_DRAW_PHASE' ? 'DRAW_PHASE' : effect.duration === 'END_OF_BATTLE' || effect.duration === 'END_OF_ATTACK' ? 'END_OF_BATTLE' : 'END_OF_TURN'
    };
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
    (effect.kind === 'return_to_deck' || effect.kind === 'search_deck_to_hand' ? effect.count : effect.kind === 'modify_power' || effect.kind === 'set_power' || effect.kind === 'change_symbol' || effect.kind === 'destroy_avatar' || effect.kind === 'bounce_avatar' || effect.kind === 'banish_avatar' || effect.kind === 'destroy_construct' || effect.kind === 'bounce_construct' || effect.kind === 'banish_construct' || effect.kind === 'sacrifice_avatar' ? 1 : 0), 0);
  if (targetInstanceIds.length !== requiredBindings || new Set(targetInstanceIds).size !== targetInstanceIds.length) return null;
  if (requiredBindings > 0) {
    if (!state) return null;
    const selector = clause.selector;
    let bindingIndex = 0;
    for (const effect of clause.effects) {
      if (effect.kind === 'modify_power' || effect.kind === 'set_power' || effect.kind === 'change_symbol' || effect.kind === 'destroy_avatar' || effect.kind === 'bounce_avatar' || effect.kind === 'banish_avatar' || effect.kind === 'destroy_construct' || effect.kind === 'bounce_construct' || effect.kind === 'banish_construct' || effect.kind === 'return_to_deck' || effect.kind === 'sacrifice_avatar') {
        const targetCount = effect.kind === 'return_to_deck' ? effect.count : 1;
        const targetIds = targetInstanceIds.slice(bindingIndex, bindingIndex + targetCount);
        bindingIndex += targetCount;
        const fieldAndPrivateCards = Object.values(state.players).flatMap(player => [...player.avatarZone, ...player.constructZone, ...player.magicZone, ...player.hand, ...player.hell, ...player.deck]);
        const requiredType = effect.kind === 'destroy_construct' || effect.kind === 'bounce_construct' || effect.kind === 'banish_construct' ? 'Construct' : effect.kind === 'destroy_avatar' || effect.kind === 'bounce_avatar' || effect.kind === 'banish_avatar' || effect.kind === 'sacrifice_avatar' || effect.kind === 'modify_power' || effect.kind === 'set_power' || effect.kind === 'change_symbol' ? 'Avatar' : undefined;
        const targets = targetIds.map(targetId => fieldAndPrivateCards.find(card => card.instanceId === targetId));
        if (targets.some(target => !target || (requiredType && target.card.type !== requiredType) || (selector?.cardTypes.length && !selector.cardTypes.includes(target.card.type)) ||
          (selector?.symbol !== undefined && !target.card.symbol?.includes(selector.symbol)) ||
          (selector?.controller === 'self' && target.controllerId !== actorId) ||
          (selector?.controller === 'opponent' && target.controllerId === actorId) ||
          (effect.kind === 'sacrifice_avatar' && target.controllerId !== actorId))) return null;
      } else if (effect.kind === 'search_deck_to_hand') {
        const player = state.players[actorId];
        const selected = targetInstanceIds.slice(bindingIndex, bindingIndex + effect.count);
        if (!player || selected.some(id => {
          const card = player.deck.find(item => item.instanceId === id);
          return !card || card.card.type !== effect.cardType || !matchesCardName(card.card.name, effect.name);
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
  return { actorId, costs, effects: toEffectDefinitions(clause.effects, actorId, targetInstanceIds, targetPlayerId) };
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
  if (nonEffectClauses.some(clause => !clause.keywordSpecs.some(spec => spec.kind === 'COMBAT_KEYWORD'))) return null;
  const costs: EffectCost[] = [];
  const effects: EffectDefinition[] = [];
  const sequence: NonNullable<EffectPlan['sequence']> = [];
  for (const [index, clause] of operationClauses.entries()) {
    const plan = toEffectPlan(clause, actorId, bindings[index]?.costInstanceIds ?? [], state, bindings[index]?.targetInstanceIds ?? []);
    if (!plan) return null;
    for (const cost of plan.costs ?? []) {
      costs.push(cost);
      sequence.push({ kind: 'cost', cost });
    }
    for (const effect of plan.effects) {
      effects.push(effect);
      sequence.push({ kind: 'effect', effect });
    }
  }
  return effects.length ? { actorId, costs, effects, sequence } : null;
}

const TRIGGER_EVENT_TYPES: Record<string, TriggerAbility['eventType']> = {
  AVATAR_SUMMONED: 'AVATAR_SUMMONED', AVATAR_DESTROYED: 'AVATAR_DESTROYED',
  ATTACK_DECLARED: 'ATTACK_DECLARED', BATTLE_STARTED: 'ATTACK_DECLARED',
  BATTLE_ENDED: 'BATTLE_ENDED', TURN_ENDED: 'TURN_ENDED', LIFE_REVEALED: 'LIFE_REVEALED'
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
  const plan = toEffectPlan(clause, actorId, options.costInstanceIds, options.state, options.targetInstanceIds);
  if (!plan) return null;
  return {
    id, eventType, effects: plan.effects,
    ...(options.sourceInstanceId ? { sourceInstanceId: options.sourceInstanceId } : {}),
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
  const clauses = abilityLines.map(parseClause);
  const taggedMagic = [...source.matchAll(/ความสามารถนี้ถือเป็นการใช้\s+(Normal|Modification|React|Land)\s+Magic/gi)].map(match => MAGIC_TYPES[match[1]]);
  const overrideMagic = [...source.matchAll(/โดยถือว่าเป็นการใช้\s+(Normal|Modification|React|Land)\s+Magic/gi)].map(match => MAGIC_TYPES[match[1]]);
  const magicUse = {
    ...(taggedMagic.length === 1 ? { abilityConsumesMagicType: taggedMagic[0] } : {}),
    ...(overrideMagic.length === 1 ? { magicSubtypeOverride: overrideMagic[0] } : {})
  };
  const reasons = clauses.flatMap(clause => clause.unresolved);
  if (ruleTexts.length > 0) reasons.push('inherent # Rule Text is retained as rule metadata but has no complete executable specification');
  if (taggedMagic.length > 1 || overrideMagic.length > 1) reasons.push('multiple or conflicting Magic type declarations');
  if (taggedMagic.length > 0 && overrideMagic.length > 0 && (taggedMagic.length !== 1 || overrideMagic.length !== 1)) reasons.push('cannot disambiguate mixed Magic-use declarations');
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
      isOnlyOne: card.isOnlyOne, isBias: card.isBias, isCollab: card.isCollab
    }, ruleTexts, clauses: resolvedClauses, magicUse
  };
}

export function parseCardTextDatabase(cards: Card[]): Record<CardTextStatus, number> {
  const totals: Record<CardTextStatus, number> = { PARSED_READY: 0, UNSUPPORTED: 0, AMBIGUOUS: 0 };
  for (const card of cards) totals[parseCardText(card).status] += 1;
  return totals;
}
