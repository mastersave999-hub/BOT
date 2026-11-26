import collections
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CARDS = json.loads((ROOT / "cards_clean.json").read_text(encoding="utf-8"))

CATEGORIES = [
    ("Juti / summon trigger", r"จุติ|อัญเชิญ"),
    ("Last Words / destruction trigger", r"คำสั่งเสีย"),
    ("Continuous / aura", r"ต่อเนื่อง"),
    ("Attack / combat", r"เมื่อโจมตี|ประกาศโจมตี|เตะไข่|โล่มนุษย์|ลูกฮึด|แทงหลัง|สามัคคี"),
    ("Draw / hand", r"จั่ว|บนมือ|ขึ้นมือ|นำขึ้นมือ"),
    ("Power / stats", r"POWER|Cost|Symbol|สี|ชื่อ"),
    ("Destroy / sacrifice", r"ทำลาย|เซ่นไหว้|สังเวย"),
    ("Bounce / return", r"กลับขึ้นมือ|กลับเข้า Deck|กลับลง Deck|นำกลับ"),
    ("Deck search / tutor", r"จากใน Deck|จาก Deck|เลือก.*Deck|ค้นหา|นำ.*Deck"),
    ("Hell / graveyard", r"นรก|Hell"),
    ("Mill / scout / reveal", r"ธรณีสูบ|สอดแนม|แสดง.*การ์ด|หงาย LIFE|หงายการ์ด"),
    ("Discard / costs", r"ทิ้ง|จ่าย Cost|จ่ายcost|สั่งใช้|เทิร์นละครั้ง"),
    ("React / cancel / prevent", r"React|ยกเลิก|ป้องกัน|ไม่สามารถ|เป้าหมายการโจมตี"),
    ("Control / zone movement", r"เปลี่ยนการควบคุม|ควบคุม|เนรเทศ|มิติมืด|Avatar Zone|Magic Zone"),
    ("Conditions / choice", r"หาก|ถ้า|เมื่อ|อัตโนมัติ|เลือกปฏิบัติ|สามารถ"),
]

# Text matching only generates investigation candidates. It never proves that a
# card's actual Game State behavior is correct; only a per-card runtime test can.
CORE = re.compile(r"จั่ว(?:การ์ด)?\s*\d+\s*ใบ|POWER\s*[+-]\s*\d+|ทำลาย Avatar|กลับขึ้นมือ|นำขึ้นมือ|กลับเป็น POWER ตั้งต้น|อัญเชิญ.*นรก|นำ.*นรก.*กลับเข้า Deck", re.I)
UNSUPPORTED = re.compile(r"ค้นหา|สอดแนม|ธรณีสูบ|ทิ้ง|เซ่นไหว้|สังเวย|ยกเลิก|ป้องกัน|เปลี่ยนการควบคุม|เปลี่ยนชื่อ|เปลี่ยน Symbol|เปลี่ยนสี|เปลี่ยนสภาพ|เนรเทศ|มิติมืด|เลือกปฏิบัติ|สุ่ม|ดูการ์ด|แสดงการ์ด|สับ Deck|เทิร์นละครั้ง|ชื่อแตกต่าง|ค่า Cost|ได้รับความสามารถ|เพิ่มชื่อ|โล่มนุษย์|เตะไข่|แทงหลัง|สามัคคี|ลูกฮึด|ต่อเนื่อง|หาก|ถ้า", re.I)
AMBIGUOUS = re.compile(r"ตัวอะไรสักอย่าง|ตามเงื่อนไขที่ไม่ระบุ|ไม่ชัดเจน", re.I)


def classify(card):
    text = (card.get("mainEffect") or "").strip()
    categories = [name for name, pattern in CATEGORIES if re.search(pattern, text, re.I)]
    if not text:
        return ["No printed effect"], "No printed effect"
    has_candidate_operation = bool(CORE.search(text))
    has_unmodeled_mechanics = bool(UNSUPPORTED.search(text))
    if AMBIGUOUS.search(text):
        status = "Ambiguous wording"
    elif has_candidate_operation and has_unmodeled_mechanics:
        status = "Partial — runtime unverified"
    elif has_candidate_operation:
        status = "Implemented candidate — unverified"
    else:
        status = "Missing / unsupported"
    return categories or ["Unclassified text"], status


rows = []
status_counts = collections.Counter()
category_counts = collections.Counter()
for card in CARDS:
    categories, status = classify(card)
    status_counts[status] += 1
    category_counts.update(categories)
    rows.append((card, categories, status))

out = [
    "# Card Effect Audit — Battle of Talingchan Online",
    "",
    "## Scope and method",
    "",
    f"Audited all {len(CARDS)} catalog records from `cards_clean.json`: {len({c.get('printId') for c in CARDS})} unique printId values; {sum(bool((c.get('mainEffect') or '').strip()) for c in CARDS)} records have printed effect text. Rule Book 3.2 (`rulebook_raw.txt`) is the authority. This conservative text-pattern triage compares mechanics with `src/engine/abilityEngine.ts`, `effectResolver.ts`, `reactionEngine.ts`, `combatEngine.ts`, `layers.ts`, `turnEngine.ts`, and `multiplayer.ts`. Record count, unique printId count, repeated IDs and distinct card behaviors are different measures. `Implemented candidate — unverified` and `Partial — runtime unverified` are not card verification: no record is established as fully Verified in this report. One test exercises a narrow POWER change on catalog print SD01-001 but does not verify its full text. A named before/after Game State test for the exact print is required to establish card verification. No effect text is inferred from card name or image." ,
    "",
    "### Status totals",
    "",
    "| Status | Records |",
    "|---|---:|",
]
for status in (
    "Verified by per-card Game State test",
    "Implemented candidate — unverified",
    "Partial — runtime unverified",
    "Missing / unsupported",
    "Ambiguous wording",
    "No printed effect",
):
    count = status_counts[status] if status != "Verified by per-card Game State test" else 0
    out.append(f"| {status} | {count} |")
out += ["", "### Effect category coverage (categories overlap)", "", "| Category | Records |", "|---|---:|"]
for category, count in category_counts.most_common():
    out.append(f"| {category} | {count} |")
record_counts = collections.Counter(card.get("printId", "") for card in CARDS)
repeated_ids = sum(count > 1 for count in record_counts.values())
extra_records = sum(count - 1 for count in record_counts.values() if count > 1)
ambiguous_records = sum(status == "Ambiguous wording" for _, _, status in rows)
out += [
    "",
    "### Database row identity",
    "",
    f"- Repeated printId values: {repeated_ids}; additional records beyond one per ID: {extra_records}. Repeated IDs are not automatically called alternate printings; inspect the individual row fields before treating them as print variants.",
    f"- Explicit wording marker matches from the conservative ambiguity regex: {ambiguous_records}. This is a flagged-text count, not a legal ruling that every other description is unambiguous.",
    "- Parser errors: not measurable from the current parser API, because `parseCardAbility` returns default flags and has no parse-error result. Use `Missing / unsupported` for text with no candidate operation match; do not describe it as a parser failure.",
    "- `tests/abilityEngine.test.ts` resolves the real catalog record SD01-001 against a Game State and checks POWER changes from 6 to 2. It does not verify all text details (notably duration); therefore the record is not marked Verified. Other tests use synthetic card fixtures, not individually audited catalog records.",
    "",
    "## Engine findings (current source, not prior report claims)",
    "",
    "- `parseCardAbility` uses Thai substring/regex flags. `getUnsupportedEffectReason` blocks several free-text patterns, but there is no grammar, complete target/cost choice model, or parse-error channel.",
    "- `executeCardAbility` now has trigger guards and calls `resolveEffectPlan` for its supported operation subset. Its resolver preflights basic targets/counts and actor-owned explicit costs, stages a structured clone, and rolls back rejected/throwing handlers. Card text is not converted into complete cost/condition plans.",
    "- Reaction chain entries and ordinary ability resolution both eventually call `executeCardAbility`, but React uses additional eligibility, timing, priority and payment paths. Existing tests do not establish parity for all operation types. `resolveReactionCard` and queued-chain resolution are separate code paths.",
    "- `recomputeContinuousAuras` is limited POWER parsing and symbol/name heuristics; it is not a complete effect-layer engine for keywords, non-POWER changes, conditions, or all zones.",
    "- Catalog category counts below are overlapping text-pattern matches. They are a workload map only, not supported-mechanics or successful-card counts.",
    "",
    "## Per-record effect-to-mechanics mapping",
    "",
    "One row per catalog record with printed effect text (repeated printId values remain separate rows). `Mechanics` are text markers/categories to investigate, not proof an effect is parsed or functions. The candidate labels are heuristic only. No card is marked Verified: SD01-001 has one Game State test for a POWER change but not its full printed semantics; the rest have no per-print Game State evidence identified.",
    "",
    "| DB row | Print ID | Card | Required mechanic categories (text-derived) | Triage status | Test evidence | Printed effect (verbatim) |",
    "|---:|---|---|---|---|---|---|",
]
first_record_by_id = {}
for record_index, (card, categories, status) in enumerate(rows, start=1):
    first_record_by_id.setdefault(card.get("printId", ""), record_index)
    effect = (card.get("mainEffect") or "").replace("\r", "").replace("\n", "<br>").replace("|", "\\|")
    if not effect:
        effect = "—"
    cats = ", ".join(categories).replace("|", "\\|")
    name = (card.get("name") or "").replace("|", "\\|")
    evidence = "None found"
    if card.get("printId") == "SD01-001" and first_record_by_id[card.get("printId", "")] == record_index:
        evidence = "`tests/abilityEngine.test.ts`: catalog ability POWER change only; incomplete full-text proof"
    if effect.strip() != "—":
        out.append(f"| {record_index} | {card.get('printId', '')} | {name} | {cats} | {status} | {evidence} | {effect} |")
out += [

    "",
    "## Rule Book 3.2 issues deliberately not guessed",
    "",
    "- Page 7 defines keyword semantics (including Juti, Last Words, sacrifice, scout, mill, choice, Unite, Human Shield, Egg Kick, once-per-turn, continuous, activated and automatic abilities). Card text alone does not supply missing target selections, costs, prevention windows, or resolution order for every interaction.",
    "- Pages 12–13 require all-or-nothing resolution and payment only when an ability is usable. Existing ability callers do not provide a complete choice/cost declaration model; implementing such cards requires UX/state-machine work rather than guessing selections.",
    "- Pages 18, 22–23 define Duel reaction/LIFO, Life timing and simultaneous Last Words. Ad-Mua reaction priority is explicitly not defined by the supplied book; existing engine appropriately disables that window for 3+ players.",
    "- This catalog classifier can over/under-classify phrasing. Review per-card text and official rulings before promoting any unsupported row to Working.",
    "",
]
(ROOT / "CARD_EFFECT_AUDIT.md").write_text("\n".join(out), encoding="utf-8")
print(f"Audited {len(CARDS)} records; statuses={dict(status_counts)}; categories={dict(category_counts)}")
