import type { Card, MagicSubtype } from './types';
import type { EffectCost, EffectDefinition, EffectPlan } from './effectResolver';
import type { GameState } from './types';

export type CardTextEffect = { kind: 'draw_self'; count: number };
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
  [/เมื่อทำลาย Avatar จากการต่อสู้/, 'AVATAR_DESTROYED_IN_BATTLE'], [/เมื่อโจมตี/, 'ATTACK_DECLARED'],
  [/เมื่อต่อสู้/, 'BATTLE_STARTED'], [/เมื่อจบการต่อสู้/, 'BATTLE_ENDED'], [/เมื่อจบเทิร์น|ในช่วง End Phase/i, 'TURN_ENDED'],
  [/ก่อนเริ่ม Main Phase/, 'BEFORE_MAIN_PHASE'], [/เมื่อหงาย LIFE Card|เมื่อ LIFE Card ถูกหงาย/, 'LIFE_REVEALED'],
  [/จุติ\s*\(/, 'AVATAR_SUMMONED'], [/คำสั่งเสีย\s*\(/, 'AVATAR_DESTROYED'], [/พอดี\s*\(/, 'EXACT_COST']
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
  match = source.match(/เซ่นไหว้\s*(?:Avatar)?\s*(\d+)\s*ใบ/);
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
  const cost = split.costText ? parseCost(split.costText) : undefined;
  const effectText = split.effectText.replace(/ความสามารถนี้ถือเป็นการใช้\s+(?:Normal|Modification|React|Land)\s+Magic|โดยถือว่าเป็นการใช้\s+(?:Normal|Modification|React|Land)\s+Magic/gi, '').trim();
  const draw = effectText.match(/^(?:(?:จั่วการ์ด(?:จาก\s+Deck(?:\s+เรา)?)?)\s*(\d+)\s*ใบ)(?:\s*(?:หลังจากนั้นสับ Deck)?)$/i);
  const effects: CardTextEffect[] = draw ? [{ kind: 'draw_self', count: Number(draw[1]) }] : [];
  const unresolved: string[] = [];
  if (split.costText && !cost) unresolved.push('cost syntax is not represented by a validated typed cost primitive');
  if (split.costText && cost && cost.kind !== 'discard_from_hand') unresolved.push('typed cost primitive is not part of the Phase 2 atomic effect resolver');
  if (!effects.length) unresolved.push('effect clause has no complete verified Phase 2 primitive mapping');
  const duration = /จนจบการต่อสู้/.test(effectText) ? 'END_OF_BATTLE' : /จนจบการโจมตี/.test(effectText) ? 'END_OF_ATTACK' : /จนจบเทิร์น/.test(effectText) ? 'END_OF_TURN' : /จนถึง Draw Phase ถัดไป/.test(effectText) ? 'NEXT_DRAW_PHASE' : undefined;
  if (duration && !effects.length) unresolved.push('duration is recognized but the associated effect is not executable by the text adapter');
  if (/ถ้า|หาก|ตราบเท่าที่/.test(effectText)) unresolved.push('condition expression is not fully represented by the supported condition AST');
  if (/(?:เลือก|POWER|ทำลาย|กลับขึ้นมือ|เนรเทศ|สอดแนม|ธรณีสูบ|นำ.*(?:Deck|นรก)|อัญเชิญ)/i.test(effectText) && !effects.length) unresolved.push('targeted or zone-changing operation lacks a complete executable plan');
  return {
    source, ...(split.costText ? { costText: split.costText } : {}), effectText: split.effectText,
    costEffectSeparator: split.separator, keywords, timing: parseTiming(source), ...(cost ? { cost } : {}),
    ...(parseSelector(effectText) ? { selector: parseSelector(effectText) } : {}), ...(duration ? { duration } : {}),
    quotedReferences, exactNameReferences, effects, unresolved: [...new Set(unresolved)]
  };
}

export function toEffectDefinitions(effects: CardTextEffect[], actorId: string): EffectDefinition[] {
  return effects.map(effect => ({ kind: 'draw', playerId: actorId, count: effect.count }));
}

/** Compile only a complete, supported clause; callers provide concrete cost choices explicitly. */
export function toEffectPlan(
  clause: ParsedCardTextClause,
  actorId: string,
  costInstanceIds: string[] = [],
  state?: GameState
): EffectPlan | null {
  if (clause.unresolved.length || clause.effects.length === 0) return null;
  const costs: EffectCost[] = [];
  if (clause.cost) {
    if (clause.cost.kind !== 'discard_from_hand' || costInstanceIds.length !== clause.cost.count || !state ||
      new Set(costInstanceIds).size !== costInstanceIds.length) return null;
    const player = state.players[actorId];
    const selected = costInstanceIds.map(id => player?.hand.find(card => card.instanceId === id));
    if (!player || selected.some(card => !card)) return null;
    const selector = clause.cost.selector;
    if (selector && selected.some(card => !card ||
      (selector.cardTypes.length > 0 && !selector.cardTypes.includes(card.card.type)) ||
      (selector.symbol !== undefined && card.card.symbol !== selector.symbol) ||
      (selector.zones.includes('บนมือ') === false))) return null;
    costs.push({ kind: 'discard_from_hand', playerId: actorId, instanceIds: [...costInstanceIds] });
  }
  return { actorId, costs, effects: toEffectDefinitions(clause.effects, actorId) };
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
