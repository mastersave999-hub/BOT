# Battle of Talingchan — Rule Gaps (Phase 1.5)

**Authority:** Battle of Talingchan Rule Book Version 3.2 (`rulebook_raw.txt`, 25 numbered pages).
**Inspection baseline:** Phase 1.5 branch `v0/reaction-window-phase1`, commit `c92cd772715495d450eb1fe76441438e09cbe723`. Phase 2.2 is merged; current Phase 2A Deck Operations status is recorded below.
**Scope:** This file is a concise index, not a substitute for source evidence. The full rule-to-engine matrix, test evidence, card statistics, ambiguities and Phase 2 dependency roadmap are in [`RULE_ENGINE_GAP_ANALYSIS.md`](RULE_ENGINE_GAP_ANALYSIS.md). The complete record-level card/effect mapping is in [`CARD_EFFECT_AUDIT.md`](CARD_EFFECT_AUDIT.md).

## Status definitions

- **Verified:** actual before/after Game State evidence for the named narrow behavior.
- **Implemented but unverified:** source exists, adequate Game State test not found.
- **Partial:** some rule path is implemented/tested, material behavior remains absent or unverified.
- **Unsupported:** no implementation found.
- **Rule ambiguity:** the Rule Book does not settle a specific precedence/interpretation.
- **Unsupported:** the Rule Book does not specify the requested multiplayer extension; do not infer a rule.

Do not infer card correctness from parser/text matching. No catalog card is marked fully **Verified** in the effect inventory.

## Confirmed high-priority gaps

| Gap | Rule Book | Current source evidence | Status / impact |
|---|---|---|---|
| Construct Zone capacity and names | p.2: max 3, unique names per player | `gameRules.ts` validator/move, Playmat guards, multiplayer SYNC validation | **Complete for shared movement paths** — capacity/name rules apply through the central zone API; full Construct build/payment remains outside Phase 2.2 core infrastructure |
| Avatar + Token capacity and Token exit | pp.1, 19: up to 4 Avatar, 6 total; Token moves to zone then leaves game | `gameRules.ts:validateAvatarZone` validates 4 Avatar / 6 combined; shared movement enforces it | **Partial** — capacities have Game State boundary tests; Token destination-then-remove lifecycle remains unsupported |
| Magic subtype limit | p.10: one use of each Magic type per turn, including opponent’s turn | `validateMagicPlay`, Playmat initiation/finalization, reaction eligibility and Draw Phase usage reset | **Partial** — all four types (including Modification) and opponent-turn React are state-tested in supported paths; abilities declaring a consumed Magic type are not globally modeled |
| Effect duration cleanup | pp.7, 16, 21–22: attack/turn/draw timing and Layer 4 | `expireModifiersAt` traverses player zones, attachments and shared Land; called at Avatar/LIFE battle and Draw/turn boundaries | **Partial** — all three durations are tested across Avatar, Construct, LIFE and attached/shared cards; full Construct/LIFE attack integration and Layer 4 transfer ambiguity remain |
| First player’s first-turn Battle Phase | pp.21–22: skipped | `turnEngine.ts` phase helper/turn completion; Playmat and multiplayer SYNC gate | **Partial** — state tests cover skip, next player, and forbidden Battle sync; real reaction-deferred peer flow and reconnect remain unverified |
| End Phase hand size | p.25: player chooses/discards to 7 as the final action; destination is not stated | revisioned pending state, `END_PHASE_DISCARD` command, host validation and owner-routed zone move | **Partial; Rule ambiguity** — state tests cover exact selection, duplicate/stale command, ownership, pending lock and turn transition; Hell is an app convention; browser/reconnect/peer acknowledgment remain unverified |
| Full card-effect transaction | pp.12–13: all-or-nothing, cost only when effect is possible | Typed resolver stages and rolls back; prevention/cancellation decisions roll back with a failed operation | **Partial** — text adapter does not form complete target/condition/cost plans |
| Prevention and cancellation | pp.9–10, 15, 18, 24–25 | Typed shields cover full/partial numeric damage, destruction and opponent targeting; typed Reaction Window API cancels pending Magic, activated abilities and chain entries. Rule Text immunity is an explicit metadata flag. | **Partial, state-tested** — automatic-before-React sequencing/once-per-exit orchestration still depends on out-of-scope Trigger Effects; canceled-Magic destination is unspecified by v3.2. |
| Control change and owner routing | pp.6, 9, 18, 20 | Owner/controller fields exist; no typed control-change movement | **Unsupported** |
| Continuous layers and duration | pp.15–17, 21 | Typed source effects and existing POWER aura subset recalculate on shared zone movement/expiry; layer modifiers are deterministically ordered and base POWER is preserved. | **Partial, state-tested** — dynamic non-POWER text parsing, Layer 3 snapshot creation and Layer 4 transfer remain unsupported/ambiguous. |
| Trigger timing | pp.5, 7–8, 12, 22–24 | A small set of trigger labels and LIFE queue exist; no general event/timing queue | **Partial** |
| Search, Scout and Mill | pp.3, 7, 13–14 | `deckOperations.ts` provides typed shuffle/search/scout/mill, pending choices, privacy projection and transactions | **Core operations tested; card-text parsing/trigger integration remains unsupported** |
| Combat / Construct combat | pp.22–25 | Avatar comparison helper and LIFE helper exist; no complete combat transaction or Construct combat | **Partial / missing** |
| Multiplayer authority and 3+ priority | pp.18–19, official book describes two-player response priority | PeerJS host-authoritative client; 3+ reaction windows deliberately disabled | 3+ order is **Unsupported** (the official Rule Book is silent); client host is not trusted authority |

## Rule-book ambiguities (not invented rulings)

1. **Rule ambiguity — Layer 4 expiry versus transfer (pp.7, 16):** p.7 specifies distinct end points for Avatar combat versus Construct/LIFE attacks; p.16 says Layer 4 effects transfer to Layer 1/2 after combat but does not state how an explicitly temporary “until end of combat/attack” effect interacts with that transfer. See full analysis for the conservative implementation note.
2. **Ad-Mua React order:** the supplied official text does not establish a priority order for three or more players. This is an absence of official rules, not a license to adopt community/APNAP ordering.

The LIFE rules on p.5 and p.22 are compatible: reveal caused by an ability alone does not trigger LIFE; LIFE revealed by an attack is queued for its owner’s next Main Phase.

## Ad-Mua note

The repository has community multiplayer guidance in prior documentation, but it is not Rule Book 3.2 evidence. The engine implements some Ad-Mua elimination/turn-order behaviors; do not call community turn direction, React budgets, target scope or elimination details official unless backed by a separately identified authoritative source. Official Rule Book 3.2 does not define 3+ player Reaction priority, and the current engine correctly refuses to open those windows rather than guessing.

## Historical Phase 2.1 test snapshot

Baseline `npm test` on the Phase 1.5 inspected commit: **10 test files, 72 tests passed**. Final Phase 2.1 rerun: **11 test files, 84 tests passed**. The suites assert actual before/after Game State for the narrow scenarios listed in `RULE_ENGINE_GAP_ANALYSIS.md`; this does not mean 84 rules or 1,833 effect texts are verified. In that historical snapshot, discard reconnect, stale-revision/idempotency and global pending-action lockout were not covered by Game State tests; Phase 2.1 was not declared complete.

## Historical Phase 2.1 implementation snapshot (before Phase 2.2)

- **Partial:** Construct count/name validation is shared across movement, resolver initial/final validation, UI placement, and incoming multiplayer state validation. Same Construct name remains legal on the opponent’s side. Direct legacy mutation paths remain; only validated network snapshots and migrated paths are guarded.
- **Partial:** Rule Book p.10 says each Magic type is usable once each turn, including on the opponent’s turn. Modification Magic is not an exception. Its repeated-use guard is shared; complete React/reaction type accounting still requires broader tests. Existing attachment/leave-field code is preserved.
- **Partial:** duration cleanup now removes only a matching marker, at Avatar combat completion, the affected player’s Draw Phase, or End of Turn. Layer 4 transfer versus explicitly temporary attack duration remains **Rule ambiguity** (pp.7,16); Construct/LIFE attack timing needs integration coverage.
- **Partial:** Rule Book pp.21–22 first-player turn-one skips Battle; tested helper distinguishes player and later turns. Playmat wiring exists; complete multiplayer/reaction phase flow remains unverified.
- **Partial; Rule ambiguity:** Rule Book p.25 requires the player to choose/discard to seven as the final End Phase action but does not specify the destination. Current code uses owner Hell as a declared application convention; UI validates exact distinct IDs and multiplayer transition checks enforce that convention. Browser-level interrupted/cancelled flow remains unverified.
- Shared substrate: `gameTransaction.ts` stages nested state and validates before publishing; `gameEvents.ts` defines typed payloads and deterministic append ordering; `gameRules.ts` centralizes zone movement, Construct/Avatar limits and privacy-safe event payloads. `effectResolver.ts` uses the shared transaction and zone movement for Avatar destroy/bounce, and only successful plans append Effect Resolved events.
- **Partial:** event catalog includes implemented internal movement/effect events and planned event shapes (summon, token, magic, attack/battle, turns, cancellation/prevention); those planned lifecycle events are not yet emitted by every transition. The dispatcher is finite-snapshot, not a trigger engine.
- **Complete for Phase 2.2 core scope:** shared transaction, typed event and zone movement paths cover supported legacy transitions in `gameRules.ts`, `turnEngine.ts`, and `abilityEngine.ts`, including attached-card exit routing, draw, discard, elimination, privacy-safe movement events, and nested rollback. This infrastructure does not implement Trigger Effects. Token post-destination removal, Control Change, Search, Scout, and Mill remain explicitly out of scope.

## Phase 2.2 status: COMPLETE (core infrastructure scope)

- **Complete for Phase 2.2 supported movement — Construct:** shared movement and validation enforce the maximum three and per-player unique names; state tests include opposing same-name legality and attachment-preserving exits. Full Construct build/payment remains beyond this infrastructure milestone.
- **Partial — Magic:** Normal, Modification, React and Land usage is checked at supported play/reaction entry points; all types count once per active turn. Modification is not exempt. General ability text that says a use counts as a Magic type is not comprehensively modeled.
- **Partial — duration/layers:** END_OF_BATTLE, END_OF_TURN and DRAW_PHASE cleanup is tested across Avatar, Construct, LIFE, attached and shared Land card state. Full snapshot/layer transfer and Construct/LIFE attack integration remain incomplete. Layer 4 expiry versus post-combat transfer remains **Rule ambiguity**.
- **Partial — first turn:** first player turn one skips Battle; Game State, next-turn and SYNC gating are tested. Snapshot restoration is covered for reaction windows and pending discard; live peer transport behavior is not asserted.
- **Complete for Phase 2.2 state/multiplayer scope; Rule ambiguity — End Phase:** exact distinct IDs and current revision are checked, duplicate commands are rejected, the host handles the active peer command, and state snapshots restore while discard is pending. Rule Book 3.2 does not specify destination; routing to owner Hell is only an application convention. Browser interaction, transport-level reconnect, and rejection acknowledgement are not verified.
- **Complete — shared Phase 2.2 infrastructure:** targeted supported engine mutations use validated transactions and centralized movement; attached-card exits, hidden movement metadata, nested rollback, ordered/deduplicated events, recursion limits, and full-state snapshot restoration are covered by Game State assertions. The event layer is infrastructure, not Trigger Effects.
- **Phase 2B Partial:** typed Prevention and Cancellation APIs and dynamic continuous POWER recalculation are state-tested; see the Phase 2B section below. They are not a general card-text parser or trigger engine.
- **Unsupported:** Control Change, Token destination-then-removal, Trigger Effects, Combat Keywords, and Phase 3 card-text parsing remain unimplemented. Search/Scout/Mill have typed core operations only; catalog text is not parsed or wired to these APIs. Ad-Mua three-plus-player Reaction priority remains unsupported by the official book and disabled.
- **Catalog cards:** no individual card was promoted to Working or Verified. No claim is made that all 1,833 printed-effect records were tested.

Final Phase 2.2 validation: `npm test` passed **12 files / 97 tests**; `npx tsc --noEmit`, `npm run build`, and `git diff --check` all passed. See `RULE_ENGINE_GAP_ANALYSIS.md` for the source-backed matrix and `CARD_EFFECT_AUDIT.md` for per-record status limits.

## Phase 2A — Deck Operations

- **Implemented core APIs:** seeded/live `shuffleDeck`, `millCards`, authorized/revisioned `scoutCards`, and typed `searchDeck`; see `src/engine/deckOperations.ts` and `tests/deckOperations.test.ts`.
- **Verified rule details:** Mill below N mills the remaining cards; p.21 says reaching zero Deck is an immediate loss, so the operation reports deck-out rather than waiting for a failed draw. Search shuffles after a match or no match; a no-match result blocks actions until an opponent verifies it (p.3).
- **Privacy:** unauthorized projections hide Deck identities, Scout candidates and private Search result/success fields. Cards moved into Hell are public.
- **Not implemented:** control change, trigger resolution for “when scouted/milled,” prevention, cancellation, Phase 3 text parsing, and integration of every card-text effect with these primitives. No individual catalog card is verified by these core tests.
- **Rule boundary:** arbitrary top-deck ordering is prohibited; top-order selection is supported only when explicitly authorized by an effect. Search matching grammar/partial exact-count behavior and 3+ player no-target verifier selection are not fully specified by v3.2; see the analysis for conservative API handling.
- **Validation:** `npx tsc --noEmit`, `npm run build`, and `git diff --check` passed; `npm test` passed **13 files / 105 tests**.

## Phase 2B — verified system scope and Rule Book ambiguities

- **Cancellation (Partial, Game State tested):** LIFO response handling can cancel unresolved pending Magic, an activated ability continuation, or a selected chain entry in a Reaction Window. Cancellation emits a typed `ACTION_CANCELLED`, does not refund a consumed Magic type, and explicit `ruleTextProtected` metadata enforces p.18 immunity. An already resolving effect cannot be interrupted (p.12).
- **Magic destination ambiguity:** p.2 sends Magic cards to Hell after resolution; p.15 specifies cancellation of the Magic effect and continued use of its Magic type but does not specify the cancelled card's physical destination. Current engine uses owner Hell as a declared application convention. Cancelling an Avatar/Construct ability leaves its source on the field; it does not destroy the permanent card.
- **Prevention (Partial, Game State tested):** typed shields cover numeric damage reduction, destruction and opposing effect targeting; finite uses and durations are supported. `preventDestructionByReaction` checks automatic protection first, requires a Reaction Window and enforces one activated use per exit-event key. Existing effect paths apply automatic shields before moving/changing state, and transaction rollback retains shield/event state. Player-directed movement bypasses destruction protection by default (p.10).
- **Prevention timing limitation:** activated protection is not yet automatically scheduled as a Reaction Window candidate or wired to every leave-field action; a caller must invoke it within the exit window. Partial numeric reduction cannot represent fractional LIFE cards under p.25.
- **Continuous effects (Partial, Game State tested):** typed Avatar/Construct/Land sources recalculate derived Layer 1–2 POWER modifiers whenever shared zone movement or duration expiry changes the board. Layer order remains deterministic across 1–4; printed POWER is untouched and source-derived values are removed when a source exits. General card text parsing, Layer 3 snapshot creation and Layer 4 transfer are not implemented.
- **Historical Phase 2B scope boundary:** Trigger Effects and Combat Keywords were outside that earlier branch; Control Change was implemented in its merge PR. Phase 3 card-text parsing remains out of scope. Synthetic tests do not upgrade any catalog card to Verified.
- **Phase 2B validation (historical at merge):** `npx tsc --noEmit` passed; `npm test` passed **14 files / 114 tests**; `npm run build` passed; `git diff --check` passed.

## Phase 2C status at PR #19 merge — branch `v0/phase2c-triggers-combat-keywords`

- **Prevention — COMPLETE for Phase 2 engine scope:** all eligible field exits use the centralized pipeline, automatic protection precedes the optional p.24 choice, and activated prevention is a cancelable LIFO Chain entry. An uncancelled entry preserves the card and records its attempt; a cancelled entry immediately resumes the stored exit without a second optional attempt. Player-mandated removals bypass protection (p.10). Multiplayer use/decline commands enforce authenticated ownership and exact revision matching. Covered by Game State and multiplayer tests. Fractional LIFE damage remains unspecified.
- **Typed Phase 2 engine systems — COMPLETE:** event/trigger infrastructure, Reaction Chain cancellation, continuous-effect and declared-battle systems, control-change routing and implemented combat keyword operations are covered by focused engine tests. This does not mean every printed card effect is implemented or verified.
- **Rule ambiguities retained:** p.23 permits controllers to order their own simultaneous abilities but does not define universal cross-controller trigger ordering; active-player-first is a Duel implementation convention. Ad-Mua 3+ React priority remains undefined by v3.2. Fractional LIFE prevention and cancelled-Magic destination remain unspecified by the Rule Book. Layer 4 transfer follows p.16 and is not an open ambiguity.
- At the time of PR #19 merge, Phase 3 card-text parsing had not started. Verified printed-card count remained **0**; generic tests did not promote catalog records.
- **Merge readiness at that time: READY TO MERGE for Phase 2 engine systems.** PR #19 was subsequently merged into `main`; see the Phase 3 status below.
- **Final validation at merge:** `npx tsc --noEmit` passed; `npm test` passed **17 files / 148 tests**; `npm run build` passed; `git diff --check` passed.

## Phase 3 — Card Text Adapter (at PR #20 merge)

- **Rule Book 3.2 adapter (final scoped Phase 3):** Selected Avatar/Construct exits, Deck return/shuffle/top/bottom, sacrifice and Scout pending-choice routing compile into typed effects. Supported activated abilities and continuous Layer 1/2 POWER/Symbol modifiers register on active Avatar/Construct/Land Magic instances and clean up on field exit. The two p.14 `#` alias forms now affect exact/quoted live name matching and deck limits; Rule Text is immune to cancellation. The two p.11 Magic declarations stay distinct: ability text atomically consumes its Magic-type quota but remains an Avatar/card ability; a played Magic subtype override uses the effective subtype for quota and typed cancellation. Unsupported syntax stays fail-closed.
- **Full-corpus dry run:** 2,014 catalog rows; 1,833 effect-bearing rows (1,462 distinct effect-bearing `printId` values). `PARSED_READY: 231`, `UNSUPPORTED: 1,598`, `AMBIGUOUS: 4`. This is adapter parsing/execution-path coverage, not individual card verification. **Phase 4 per-card Game State verified: 0.** Reproduce using `npx tsx scripts/audit-card-text-adapter.ts`.
- **Overlapping text patterns:** `#` Rule Text 184; colon 1,401; quoted token 794; named keywords 1,335; condition/timing terms 1,211; duration 378; ability consumes Magic type 2; Magic subtype override 5.
- **Most frequent unresolved categories (overlapping reasons):** no complete effect mapping 1,523; targeted/zone-changing operation without a complete bound plan 1,117; condition gap 409; unrecognized cost 195; inherent `#` rule without executable spec 103; unsupported cost primitive 47; ambiguity markers 4. These are overlapping text-triage reasons, not unique-card totals.
- **Phase 3 status at PR #20 merge: READY TO MERGE** for the requested final three adapter items. Its validation passed: `npx tsc --noEmit`, `npm test` (**18 files / 172 tests**), `npm run build`, and `git diff --check`. The Phase 4 checkpoint below supersedes the then-zero verified-card count.

## Phase 4B — Fixture-driven verification and grammar-cluster expansion

- **Current full-corpus counts:** `VERIFIED_WORKING 71` (subset), `PARSED_READY 226` (including verified), `UNSUPPORTED 1,603`, `AMBIGUOUS 4`; total is 1,833 effect-bearing rows across 2,014 official catalog rows. The 155 parser-ready rows not yet verified are not counted as working. Reproduce the dry-run with `npx tsx scripts/audit-card-text-adapter.ts`; see `CARD_EFFECT_AUDIT.md` for per-row evidence.
- **Fixture verification:** the suite attempts all 226 `PARSED_READY` rows and asserts exact game-state mutations for the 71 passing rows. Fixtures use matching official catalog cards for legal targets, Deck/Hell and LIFE context where supported, and include relevant event/exit-prevention paths. Remaining blockers include timing/event context (91), keyword behavior (83), Scout choice (55), plan-binding failures (32), and selector/target-fixture gaps; reasons overlap. Therefore the original goal of converting all remaining 211 Phase 4A rows is not fully achieved: 155 current parser-ready rows remain unverified.
- **Rule/adapter scope:** the current typed paths retain fail-closed condition AST, named Hell recovery/summon, quoted-word/exact-name equip restrictions, continuous POWER/Symbol subset and Reaction Chain/exit-prevention infrastructure. New fixture coverage does not imply every cancellation, opponent-action trigger, conditional, end-of-turn, equip, or continuous card text is fully parsed or lifecycle-verified.
- **Top remaining unparsed clusters from the repository database:** opponent Avatar-summon reaction 2; opponent Magic-use 10; cancellation 44; destruction prevention 2; Modification equip restriction 38; continuous POWER/Symbol modifiers 170; end-of-turn self-exit/removal 37; conditional `ถ้า...:` 18; Hell recovery/summon/banish 310; ability-counts-as-Normal-Magic phrase 0. These are overlapping text-pattern counts, not unique-card counts; exact examples and names are in `CARD_EFFECT_AUDIT.md` and the audit script output.
- **Still fail-closed:** unresolved multi-player targeting, unknown cost/condition syntax, Scout choices without a player-selected ordering, and unsupported event timing. No interpretation beyond Rule Book 3.2 is added.
- **Full validation:** `npx tsc --noEmit` passed; `npm test` passed (**20 files / 440 tests**); `npm run build` passed; `git diff --check` passed.
