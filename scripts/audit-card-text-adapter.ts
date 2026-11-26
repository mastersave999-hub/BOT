import { readFileSync } from 'node:fs';
import { parseCardText } from '../src/engine/cardTextAdapter';
import type { Card } from '../src/engine/types';

const cards = JSON.parse(readFileSync(new URL('../cards_clean.json', import.meta.url), 'utf8')) as Card[];
const effectCards = cards.filter(card => (card.mainEffect ?? '').trim().length > 0);
const databaseRows = new Map(cards.map((card, index) => [card, index + 1]));
const unparsedRows: Array<{ dbRow: number; card: Card; reason?: string }> = [];
const statusCounts = { PARSED_READY: 0, UNSUPPORTED: 0, AMBIGUOUS: 0 };
const patternCounts = new Map<string, number>();
const structuralPatterns: Record<string, RegExp> = {
  'Inherent # Rule Text marker': /#/, 
  'Colon / Cost : Effect separator': /:/,
  'Quoted name tokens': /"[^"]+"/,
  'Named keyword markers': /จุติ|คำสั่งเสีย|พอดี|สอดแนม|ธรณีสูบ|เลือกปฏิบัติ|สามัคคี|โล่มนุษย์|เตะไข่|ลูกฮึด|แทงหลัง|เนรเทศ|เทิร์นละครั้ง|ต่อเนื่อง|สั่งใช้|อัตโนมัติ|คู่หู/,
  'Condition/timing terms': /ถ้า|หาก|เมื่อ|ตราบเท่าที่/,
  'Duration terms': /จนจบ|ตราบเท่าที่/,
  'Ability consumes Magic type': /ความสามารถนี้ถือเป็นการใช้/,
  'Magic card subtype override': /โดยถือว่าเป็นการใช้/
};
const structuralCounts = Object.fromEntries(Object.keys(structuralPatterns).map(name => [name, 0]));

for (const card of effectCards) {
  const parsed = parseCardText(card);
  statusCounts[parsed.status] += 1;
  if (parsed.status !== 'PARSED_READY') unparsedRows.push({ dbRow: databaseRows.get(card) ?? 0, card, reason: parsed.reason });
  if (parsed.reason) {
    for (const reason of new Set(parsed.reason.split('; '))) patternCounts.set(reason, (patternCounts.get(reason) ?? 0) + 1);
  }
  for (const [name, pattern] of Object.entries(structuralPatterns)) {
    if (pattern.test(card.mainEffect ?? '')) structuralCounts[name] += 1;
  }
}

const topUnparsedPatterns = [...patternCounts.entries()]
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
const clauseClusterPatterns: Array<[string, RegExp]> = [
  ['React — opponent summons an Avatar', /เมื่อ(?:ฝ่ายตรงข้าม|อีกฝ่าย)[^:]*อัญเชิญ[^:]*Avatar/],
  ['React — opponent uses Magic', /เมื่อ(?:ฝ่ายตรงข้าม|อีกฝ่าย)[^:]*ใช้[^:]*Magic/i],
  ['Cancellation — cancel an action/effect', /ยกเลิก/],
  ['Prevention — prevent destruction', /(?:ป้องกัน[^<\n]*(?:ทำลาย|ถูกทำลาย)|ไม่สามารถถูกทำลาย)/],
  ['Modification — equip restriction', /สวมใส่ได้เฉพาะ/],
  ['Continuous — POWER or Symbol buff', /ต่อเนื่อง[^<\n]*(?:POWER|Symbol)/i],
  ['End-of-turn — self exit/removal', /(?:เมื่อจบเทิร์น|จบเทิร์น|End Phase)[^<\n]*(?:ทำลาย|เนรเทศ|ลงนรก|กลับเข้า Deck|ใต้ Deck)/i],
  ['Conditional — if/when colon clause', /(?:^|<br\s*\/?\s*>\s*)(?:ถ้า|หาก)[^:]{1,180}:/i],
  ['Hell — recover, summon, or banish', /นรก[^<\n]*(?:ขึ้นมือ|กลับขึ้นมือ|อัญเชิญ|เนรเทศ|กลับเข้า Deck)|(?:ขึ้นมือ|กลับขึ้นมือ|อัญเชิญ|เนรเทศ|กลับเข้า Deck)[^<\n]*นรก/],
  ['Magic quota — ability counts as Normal Magic', /ความสามารถนี้ถือเป็นการใช้\s*Normal\s*Magic/i]
];
const unparsedClauseClusters = clauseClusterPatterns.map(([name, pattern]) => {
  const matches = unparsedRows.filter(({ card }) => pattern.test(card.mainEffect ?? ''));
  return {
    name,
    rowCount: matches.length,
    examples: matches.slice(0, 5).map(({ dbRow, card }) => ({
      dbRow, printId: card.printId, name: card.name,
      excerpt: (card.mainEffect ?? '').replace(/<br\s*\/?\s*>/gi, ' / ').replace(/\s+/g, ' ').slice(0, 200)
    }))
  };
});
console.log(JSON.stringify({
  databaseRows: cards.length,
  effectBearingRows: effectCards.length,
  uniqueEffectPrintIds: new Set(effectCards.map(card => card.printId)).size,
  statusCounts,
  structuralPatternRows: structuralCounts,
  topUnparsedPatterns,
  unparsedClauseClusters
}, null, 2));
