# BATTLE OF TALINGCHAN ONLINE (ศึกตลิ่งชัน ออนไลน์)

ระบบการ์ดเกมไทยออนไลน์ Battle of Talingchan รองรับทั้งโหมด **Duel (2 ผู้เล่น)** และโหมด **Ad-Mua / อัดมั่ว (3–4 ผู้เล่น)** พัฒนาด้วยสถาปัตยกรรม Server-Authoritative พร้อม TypeScript, Vitest, และ Supabase PostgreSQL

---

## 1. เอกสารอ้างอิงและกฎของเกม (Source of Truth)
- [RULE_CATALOG.md](file:///c:/Users/Administrator/Downloads/BOT/RULE_CATALOG.md) - ดัชนีและแคตตาล็อกกฎกติกาอย่างเป็นทางการ 25 หน้า อ้างอิงจาก Rule Book ของแทร่ Ver. 3.2
- [RULE_GAPS.md](file:///c:/Users/Administrator/Downloads/BOT/RULE_GAPS.md) - รายงานจุดกำกวมของกฎและกติกาโหมด Multiplayer (อัดมั่ว 3–4 คน)
- [SCHEMA.sql](file:///c:/Users/Administrator/Downloads/BOT/SCHEMA.sql) - โครงสร้างฐานข้อมูล Supabase PostgreSQL และระบบสิทธิ์ความปลอดภัย

---

## 2. ข้อมูลการ์ด (Card Database)
- **การ์ดทั้งหมด**: 2,014 เรคอร์ด (1,633 print IDs ที่ไม่ซ้ำกัน)
- **แหล่งข้อมูล**: คลังข้อมูลทางการ `https://bottcg.com/cards` และ CDN ทางการ
- **ที่เก็บไฟล์คลีนแล้ว**: `cards_clean.json`

---

## 3. สถาปัตยกรรม Game Engine และชุดทดสอบ (Vitest Unit Tests)
ระบบ State Machine ตรวจสอบกฎแบบ Deterministic ครอบคลุม:
1. **Deck Validator** (`src/engine/deckValidator.ts`):
   - ตรวจ Main Deck 50 ใบพอดี
   - ตรวจ LIFE Deck 5 ใบชื่อไม่ซ้ำ
   - ตรวจการ์ด Only #1 ต้องมี 1 ใบพอดี
   - ตรวจห้ามใส่การ์ดซ้ำเกิน 4 ใบ และแบนการ์ดสัญลักษณ์ "ลำเอียง"
2. **Effect Layers Calculator (L0–L4)** (`src/engine/layers.ts`):
   - คำนวณ Layer 0 (ค่าตั้งต้น) -> Layer 1 (บัฟตรง/อุปกรณ์) -> Layer 2 (ออร่าสนาม) -> Layer 3 (Snapshot) -> Layer 4 (React)
3. **Turn & Phase Engine** (`src/engine/turnEngine.ts`):
   - Draw Phase ตามกฎ p.21 (มือ < 3 จั่วให้ครบ 3, มือ >= 3 จั่ว 1, P1 Turn 1 จั่ว 2)
   - ปลุก Avatar ตื่นพร้อมกันกับการจั่ว
4. **Combat Engine** (`src/engine/combatEngine.ts`):
   - การปะทะ Avatar vs Avatar, พลังเท่ากันทำลายคู่
   - ระบบลูกฮึด (Grit) ตัดสินชนะเมื่อพลังเท่ากัน
   - พลัง 0 vs 0 ไม่มีอะไรเกิดขึ้น
   - การโจมตี LIFE Zone (พลัง 0 ทำดาเมจไม่ได้)
   - สถานะสาหัส (Critical State) เมื่อ LIFE หงายครบ 5 ใบ และเงื่อนไขพ่ายแพ้เมื่อโดนดาเมจซ้ำ

---

## 4. ผลการรันเทสต์ (Vitest)
```bash
npx vitest run
```
- `tests/deckValidator.test.ts` (5 passed)
- `tests/layers.test.ts` (4 passed)
- `tests/turnEngine.test.ts` (3 passed)
- `tests/combatEngine.test.ts` (6 passed)
**รวมทั้งหมด 18/18 Unit Tests ผ่าน 100%**
