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

---

## 5. Phase 5 — Multiplayer Integration + Hybrid Auto-100% & Anti-Cheat Manual Fallback

### 5.1 เครื่องยนต์กติกา v3.2 ในห้องออนไลน์
- ไปป์ไลน์ห้องเล่น (host/guest) ใช้เอนจิน `gameRules.ts` + `effectResolver.ts` + `cardTextAdapter.ts` เต็มรูปแบบ
- ซ่อนข้อมูลลับทุกชั้น: LIFE คว่ำ / Deck / มือคู่แข่งถูก redact ก่อนส่งทุกครั้ง (`redactLifeCardsForViewer`) และผู้เล่นจะเห็นตัวตนการ์ดเฉพาะเมื่อเป็น `authorizedViewerId` ของ `pendingDeckChoice` / `pendingHellChoice` เท่านั้น
- ทุกคำสั่งผู้เล่น (Reaction / End Phase Discard / Exit Prevention / Deck Choice / Hell Choice / Manual Override) ต้องผ่านตรวจ `expectedRevision` แบบ monotonic และ `commandId` แบบ idempotent ก่อนเจ้าของห้องจะนำไปใช้
- ป้องกันการสร้าง `pendingDeckChoice` / `pendingHellChoice` ปลอมผ่าน SYNC: ผู้ส่งต้องเป็น `actorId` และ `authorizedViewerId` เอง และถ้าเลือกจากโซนของผู้เล่นอื่น ต้องมีการเล่น Magic ที่มีเอฟเฟกต์ search/scout/recover จริงในเทิร์นนั้นด้วย
- UI Modal สำหรับ `pendingDeckChoice` (Scout / ค้นหา Deck) และ `pendingHellChoice` (นำกลับ/อัญเชิญจากนรก) ใน `Phase5Modals.tsx`

### 5.2 Hybrid Auto-100% + Manual Fallback
- `classifyCard` (`src/engine/hybridMode.ts`) จำแนกการ์ดเป็น `VERIFIED_WORKING` / `UNSUPPORTED` / `AMBIGUOUS` ตามผล parse ของ `cardTextAdapter` และเกณฑ์ verification เดียวกับ Phase 4
- การ์ด `VERIFIED_WORKING` ออกผลอัตโนมัติ 100% ไม่มีพรอมต์เพิ่ม
- การ์ด `UNSUPPORTED` / `AMBIGUOUS` จะขึ้นแบนเนอร์ "Manual Effect Resolution" แสดงข้อความการ์ดภาษาไทยจริง พร้อมช่องทางจัดการด้วยมือแบบมีขอบเขตกติกา: ปรับ POWER ±, เปลี่ยนสภาพตื่น/นอน, ย้ายการ์ดระหว่างโซน, จั่ว/ทิ้ง 1 ใบ, เซ็น/ฮีล LIFE, ค้นหา/สอดแนม/Mill/สับ Deck, เลือกการ์ดจากนรก, สร้าง Token, เปลี่ยนผู้ควบคุม (ถาวรหรือชั่วคราวจนจบเทิร์น), เปลี่ยน Symbol (layer modifier), และสั่งใช้ความสามารถ Activated ที่เอนจินแยกวิเคราะห์ได้ครบ (`MANUAL_ACTIVATE_ABILITY` — เอนจินตรวจ Cost/เป้าหมาย/เทิร์นละครั้งเอง)
- Phase 8.1: "แอสการ์ดคือสถานที่ไม่ใช่ผู้คน" (BT02-060 / PRMO-155 / KD01-020) — ผลต่อเนื่องเปลี่ยน Symbol ทุก Avatar เป็น {เทพ} ทำงานใน Game State จริง (Layer 2 ทับ Layer 1 ตาม Rule Book หน้า 17) ส่วนความสามารถสั่งใช้ยึด Avatar ใช้ผ่าน Manual Resolver พร้อมการคืนการควบคุมอัตโนมัติจนจบเทิร์น
- ทุก Manual Override ต้องได้ **ยืนยัน/ปฏิเสธจากคู่แข่ง** (หรือบันทึกอัตโนมัติใน Match Action Log สาธารณะ) ก่อนนำไปใช้ — ใครก็หลอกใช้เอฟเฟกต์เงียบ ๆ ไม่ได้

### 5.3 เลือกโหมดห้อง (Room Mode Selector)
- **Hybrid (ค่าเริ่มต้น)** — เล่นได้ครบทั้ง 1,833 การ์ด: อัตโนมัติสำหรับการ์ดที่รองรับ + Manual Fallback สำหรับการ์ดที่ยังไม่รองรับ
- **Auto-Strict** — จำกัดเด็ค/เอฟเฟกต์เฉพาะการ์ด `VERIFIED_WORKING` ปิด Manual Controls ทั้งหมด (ตรวจเด็คทั้งฝั่งโฮสต์และผู้เข้าร่วมตอน HELLO)

### 5.4 เทสต์และการตรวจสอบ
- `tests/phase5MultiplayerHybrid.test.ts` — ครอบคลุมการไหลของเทิร์นออนไลน์, การ resolve `pendingDeckChoice` / `pendingHellChoice`, การ redact ข้อมูลลับ, และ flow ยืนยัน/ปฏิเสธ Manual Override
- ตรวจด้วย `npx tsc --noEmit`, `npm test`, `npm run build`, `git diff --check` ทั้งหมดผ่าน
#   B O T 
 
 
