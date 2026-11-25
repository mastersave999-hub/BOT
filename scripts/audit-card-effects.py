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

# This is intentionally conservative: anything beyond effects the current engine
# can resolve atomically with its present state/choice model is not called working.
CORE = re.compile(r"จั่ว(?:การ์ด)?\s*\d+\s*ใบ|POWER\s*[+-]\s*\d+|ทำลาย Avatar|กลับขึ้นมือ|นำขึ้นมือ|กลับเป็น POWER ตั้งต้น|อัญเชิญ.*นรก|นำ.*นรก.*กลับเข้า Deck", re.I)
UNSUPPORTED = re.compile(r"ค้นหา|สอดแนม|ธรณีสูบ|ทิ้ง|เซ่นไหว้|สังเวย|ยกเลิก|ป้องกัน|เปลี่ยนการควบคุม|เปลี่ยนชื่อ|เปลี่ยน Symbol|เปลี่ยนสี|เปลี่ยนสภาพ|เนรเทศ|มิติมืด|เลือกปฏิบัติ|สุ่ม|ดูการ์ด|แสดงการ์ด|สับ Deck|เทิร์นละครั้ง|ชื่อแตกต่าง|ค่า Cost|ได้รับความสามารถ|เพิ่มชื่อ|โล่มนุษย์|เตะไข่|แทงหลัง|สามัคคี|ลูกฮึด|ต่อเนื่อง|หาก|ถ้า", re.I)


def classify(card):
    text = (card.get("mainEffect") or "").strip()
    categories = [name for name, pattern in CATEGORIES if re.search(pattern, text, re.I)]
    if not text:
        return ["No printed effect"], "Working"
    core = bool(CORE.search(text))
    unsupported = bool(UNSUPPORTED.search(text))
    if core and unsupported:
        status = "Partially working"
    elif core:
        status = "Working"
    elif re.search(r"ลูกฮึด", text):
        status = "Partially working"
    elif not categories or re.search(r"\?|ไม่ชัดเจน|ตามเงื่อนไขที่ไม่ระบุ", text):
        status = "Unsupported/unclear"
    else:
        status = "Not implemented"
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
    f"Audited every row in `cards_clean.json`: **{len(CARDS)} card records** ({len({c.get('printId') for c in CARDS})} distinct print IDs). Card text is taken verbatim from the checked-in catalog; Rule Book 3.2 (`rulebook_raw.txt`) is authoritative. This report uses a conservative, text-pattern audit against handlers currently present in `src/engine/abilityEngine.ts`, `combatEngine.ts`, and `reactionEngine.ts`. It is a triage/status inventory, not a claim of official card rulings or per-card runtime verification. A card marked Working means its obvious simple operation maps to an engine handler; it does not prove that the full effect works in game state or every context-specific ruling for that print.",
    "",
    "### Status totals",
    "",
    "| Status | Records |",
    "|---|---:|",
]
for status in ("Working", "Partially working", "Not implemented", "Unsupported/unclear"):
    out.append(f"| {status} | {status_counts[status]} |")
out += ["", "### Effect category coverage (categories overlap)", "", "| Category | Records |", "|---|---:|"]
for category, count in category_counts.most_common():
    out.append(f"| {category} | {count} |")
out += [
    "",
    "## Root causes confirmed in the engine",
    "",
    "- Ability text was reduced to a few global regex/substring flags. Most of the catalog's search, discard/payment, mill/scout, prevention/cancellation, control-change, zone movement, conditional, and choice effects have no resolvers.",
    "- `executeCardAbility` previously ran draw, destruction, recovery, and targeting logic regardless of the supplied trigger. A Last Words or Life effect could therefore resolve at the wrong timing.",
    "- Target resolution accepted any Avatar in any player zone without enforcing the parsed own/opponent scope; absent targets could result in a silent no-op or partial resolution.",
    "- Multi-clause effects and costs cannot be modeled atomically with the existing API: it lacks a choice/payment/target plan and a resolution result that can refuse the entire effect. Rule Book 3.2 pp.12–13 requires all effects to be achievable before using an ability and costs must be paid before resolution.",
    "- Continuous effects only interpret limited POWER text and a few symbol/name patterns; keyword, stat, zone and condition effects are not generally represented as layers.",
    "- Reaction legality has a conservative supported-effect gate, but the shared resolver and card-by-card timing/cost/target vocabulary are still incomplete.",
    "- Removing an Avatar from the field must also send its attached Modification Magic to Hell (Rule Book 3.2 p.18); the shared destroy and bounce operations now preserve those cards instead of dropping them.",
    "- Status labels are text-pattern triage only, not per-card runtime verification. A Working label is not evidence that a card's full effect has passed a game-state test; no eligible-card completion total can be claimed from this audit." ,
    "",
    "## Ambiguity and unsupported card inventory",
    "",
    "Rows below include all 2,014 records and verbatim effect text for review. `Unsupported/unclear` means the wording itself is insufficiently specific for a deterministic ruling; `Not implemented` means the intention is readable but no reliable handler exists; `Partially working` indicates at least one recognized operation mixed with an unsupported mechanic/condition.",
    "",
    "| Print ID | Card | Categories | Status | Printed effect (verbatim) |",
    "|---|---|---|---|---|",
]
for card, categories, status in rows:
    effect = (card.get("mainEffect") or "").replace("\r", "").replace("\n", "<br>").replace("|", "\\|")
    if not effect:
        effect = "—"
    cats = ", ".join(categories).replace("|", "\\|")
    name = (card.get("name") or "").replace("|", "\\|")
    out.append(f"| {card.get('printId', '')} | {name} | {cats} | {status} | {effect} |")
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
