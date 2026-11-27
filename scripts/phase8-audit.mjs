// Phase 8 audit: classify every card effect record in cards_clean.json into the
// concrete manual action primitives the Universal Manual Effect Resolver supports.
// Run: node scripts/phase8-audit.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const db = JSON.parse(readFileSync(new URL('../cards_clean.json', import.meta.url), 'utf8'));
const cards = Array.isArray(db) ? db : (db.cards ?? Object.values(db)[0]);

/** Each primitive maps to one ManualOverrideAction kind (or an existing engine flow). */
const PRIMITIVES = [
  { id: 'DECK_SEARCH', label: 'Deck Search (Name/Type/Color/Cost/Symbol) + mandatory shuffle', action: 'MANUAL_SEARCH_DECK', patterns: [/ค้น(?:หา|จาก|ดู)?/, /จาก ?Deck/, /ใน ?Deck/, /หยิบจาก Deck/] },
  { id: 'SCOUT', label: 'Scout top N cards', action: 'MANUAL_SCOUT_DECK', patterns: [/สอดแนม/, /ดูการ์ด ?(?:ด้าน)?บนสุด/, /เปิดดูการ์ด/] },
  { id: 'MILL', label: 'Mill top N cards to Hell', action: 'MANUAL_MILL_DECK', patterns: [/(?:ด้านบนสุดของ ?Deck|บนสุดของ Deck)[^\n]{0,40}(?:ลง|ไป)นรก/, /ส่ง(?:การ์ด)?(?:ด้าน)?บนสุด[^\n]{0,30}นรก/] },
  { id: 'SHUFFLE', label: 'Shuffle Deck', action: 'MANUAL_SHUFFLE_DECK', patterns: [/สับ(?:การ์ด|Deck|เด็ค)/, /สับใหม่/] },
  { id: 'HELL_RECOVER', label: 'Recover from Hell to Hand/Field/Deck', action: 'MANUAL_HELL_CHOICE', patterns: [/จากนรก/, /ในนรก/, /นรก[^\n]{0,30}(?:ขึ้น|กลับ|อัญเชิญ|วาง)/, /กู้คืน/] },
  { id: 'DARK_DIMENSION', label: 'Move to/from Dark Dimension (Banish)', action: 'MOVE_CARD (darkDimension)', patterns: [/มิติมืด/, /เนรเทศ/] },
  { id: 'TOKEN', label: 'Create/Remove Token (Avatar Zone cap 6 total)', action: 'MANUAL_SPAWN_TOKEN', patterns: [/Token/, /โทเคน/] },
  { id: 'POWER_MOD', label: 'POWER ± modifier', action: 'ADJUST_POWER', patterns: [/POWER ?[+−-]/, /พลัง(?:การ์ด)?[^\n]{0,20}[+−-]/] },
  { id: 'WAKE_REST', label: 'Wake / Rest state change', action: 'SET_WAKE_STATE', patterns: [/(?:สภาพ)?(?:ตื่น|นอน)(?:สนิท)?/, /Rest/, /Wake/] },
  { id: 'CONTROL_CHANGE', label: 'Change Controller', action: 'MANUAL_CHANGE_CONTROL', patterns: [/เปลี่ยน(?:ฝ่าย|ผู้ควบคุม|การควบคุม)/, /ควบคุม(?:การ์ด)?(?:นี้)?[^\n]{0,20}(?:จนจบเทิร์น|ของ)/] },
  { id: 'NAME_COLOR_SYMBOL', label: 'Temporary Name/Color/Symbol override', action: 'ADJUST_POWER + layerModifiers (symbolMod)', patterns: [/(?:ชื่อ|สี|สัญลักษณ์)[^\n]{0,30}(?:เป็น|ถือเป็น|กลายเป็น)/, /ถือเป็น/] },
  { id: 'DESTROY_SACRIFICE', label: 'Destroy / Sacrifice target card on field', action: 'MOVE_CARD (hell)', patterns: [/ทำลาย/, /สังหาร/, /เสียสละ/, /เข้าโจมตี[^\n]{0,20}ทำลาย/] },
  { id: 'MOVE_ZONE', label: 'Move card between zones', action: 'MOVE_CARD', patterns: [/ย้าย/, /ยกไป/, /วาง(?:ลง|ไว้)/, /กลับ(?:ขึ้น|ลง|ไป)/] },
  { id: 'DRAW', label: 'Draw N cards', action: 'DRAW_CARD', patterns: [/จั่ว/] },
  { id: 'DISCARD', label: 'Discard N selected hand cards', action: 'DISCARD_CARD', patterns: [/ทิ้ง/] },
  { id: 'LIFE', label: 'LIFE Sacrifice (face-up) / Heal (face-down)', action: 'ADJUST_LIFE', patterns: [/LIFE/, /เซ็น/, /ฮีล/, /ชีวิต/] },
];

const hasEffect = card => typeof card.mainEffect === 'string' && card.mainEffect.trim().length > 0;
const effectCards = cards.filter(hasEffect);

const counts = Object.fromEntries(PRIMITIVES.map(p => [p.id, 0]));
const examples = Object.fromEntries(PRIMITIVES.map(p => [p.id, []]));
for (const card of effectCards) {
  const text = card.mainEffect;
  for (const primitive of PRIMITIVES) {
    if (primitive.patterns.some(pattern => pattern.test(text))) {
      counts[primitive.id]++;
      if (examples[primitive.id].length < 2) examples[primitive.id].push(`${card.printId} ${card.name}`);
    }
  }
}

const total = effectCards.length;
const covered = effectCards.filter(card =>
  PRIMITIVES.some(primitive => primitive.patterns.some(pattern => pattern.test(card.mainEffect)))
).length;

const lines = [];
lines.push('## Phase 8 — Universal Manual Effect Resolver coverage matrix');
lines.push('');
lines.push(`Programmatic audit over all ${cards.length} database rows (${total} carry printed effect text).`);
lines.push('Each row is classified against the manual action primitives the Phase 8 resolver exposes.');
lines.push('Categories overlap: one card effect may map to several primitives.');
lines.push('');
lines.push('| Primitive | Manual action | Cards matched | Example cards |');
lines.push('|---|---|---|---|');
for (const primitive of PRIMITIVES) {
  lines.push(`| ${primitive.label} | \`${primitive.action}\` | ${counts[primitive.id]} | ${examples[primitive.id].join(' · ') || '—'} |`);
}
lines.push('');
lines.push(`**Coverage:** ${covered}/${total} effect-bearing cards (${((covered / total) * 100).toFixed(1)}%) match at least one`);
lines.push('manual primitive, so the resolver can legitimately resolve them under Rule Book 3.2 with');
lines.push('opponent Confirm/Reject oversight. Effects outside these primitives remain resolvable through');
lines.push('the generic Field/Hand/LIFE tabs plus free-form judge discussion.');
lines.push('');

const report = lines.join('\n');
writeFileSync(new URL('../phase8-audit-output.md', import.meta.url), report);
console.log(report);
