import { readFileSync } from 'node:fs';
import { parseCardText } from '../src/engine/cardTextAdapter';
import type { Card } from '../src/engine/types';

const cards = JSON.parse(readFileSync(new URL('../cards_clean.json', import.meta.url), 'utf8')) as Card[];
const effectCards = cards.filter(card => (card.mainEffect ?? '').trim().length > 0);
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
  if (parsed.reason) {
    for (const reason of new Set(parsed.reason.split('; '))) patternCounts.set(reason, (patternCounts.get(reason) ?? 0) + 1);
  }
  for (const [name, pattern] of Object.entries(structuralPatterns)) {
    if (pattern.test(card.mainEffect ?? '')) structuralCounts[name] += 1;
  }
}

const topUnparsedPatterns = [...patternCounts.entries()]
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
console.log(JSON.stringify({
  databaseRows: cards.length,
  effectBearingRows: effectCards.length,
  uniqueEffectPrintIds: new Set(effectCards.map(card => card.printId)).size,
  statusCounts,
  structuralPatternRows: structuralCounts,
  topUnparsedPatterns
}, null, 2));
