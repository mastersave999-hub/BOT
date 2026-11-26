# Battle of Talingchan — Rule Gaps (Phase 1.5)

**Authority:** Battle of Talingchan Rule Book Version 3.2 (`rulebook_raw.txt`, 25 numbered pages).
**Inspection baseline:** Phase 1.5 branch `v0/reaction-window-phase1`, commit `c92cd772715495d450eb1fe76441438e09cbe723`. Current Phase 2.2 status is recorded in the section below.
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
| Construct Zone capacity and names | p.2: max 3, unique names per player | `gameRules.ts` validator/move, Playmat guards, multiplayer SYNC validation | **Partial** — tested shared move enforces capacity/name scope, including same-name opposing Construct; some legacy mutations still bypass the shared movement API |
| Avatar + Token capacity and Token exit | pp.1, 19: up to 4 Avatar, 6 total; Token moves to zone then leaves game | `gameRules.ts:validateAvatarZone` validates 4 Avatar / 6 combined; shared movement enforces it | **Partial** — capacities have Game State boundary tests; Token destination-then-remove lifecycle remains unsupported |
| Magic subtype limit | p.10: one use of each Magic type per turn, including opponent’s turn | `validateMagicPlay`, Playmat initiation/finalization, reaction eligibility and Draw Phase usage reset | **Partial** — all four types (including Modification) and opponent-turn React are state-tested in supported paths; abilities declaring a consumed Magic type are not globally modeled |
| Effect duration cleanup | pp.7, 16, 21–22: attack/turn/draw timing and Layer 4 | `expireModifiersAt` traverses player zones, attachments and shared Land; called at Avatar/LIFE battle and Draw/turn boundaries | **Partial** — all three durations are tested across Avatar, Construct, LIFE and attached/shared cards; full Construct/LIFE attack integration and Layer 4 transfer ambiguity remain |
| First player’s first-turn Battle Phase | pp.21–22: skipped | `turnEngine.ts` phase helper/turn completion; Playmat and multiplayer SYNC gate | **Partial** — state tests cover skip, next player, and forbidden Battle sync; real reaction-deferred peer flow and reconnect remain unverified |
| End Phase hand size | p.25: player chooses/discards to 7 as the final action; destination is not stated | revisioned pending state, `END_PHASE_DISCARD` command, host validation and owner-routed zone move | **Partial; Rule ambiguity** — state tests cover exact selection, duplicate/stale command, ownership, pending lock and turn transition; Hell is an app convention; browser/reconnect/peer acknowledgment remain unverified |
| Full card-effect transaction | pp.12–13: all-or-nothing, cost only when effect is possible | Typed resolver stages and rolls back; text adapter does not form complete target/condition/cost plans | **Partial** |
| Prevention and cancellation | pp.10, 15, 18, 24 | Prevention is blocked; cancellation only a narrow React-Magic pattern | **Unsupported / partial** |
| Control change and owner routing | pp.6, 9, 18, 20 | Owner/controller fields exist; no typed control-change movement | **Unsupported** |
| Continuous layers and duration | pp.15–17, 21 | POWER aura subset exists; full layer semantics, snapshot and end-of-battle expiration absent | **Partial** |
| Trigger timing | pp.5, 7–8, 12, 22–24 | A small set of trigger labels and LIFE queue exist; no general event/timing queue | **Partial** |
| Search, Scout and Mill | pp.3, 7, 13–14 | No typed private Deck operation, exact quoted-name semantics, or shuffle/search/scout/mill pipeline | **Unsupported** |
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
- **Partial:** shared zone API supports current player zones plus shared Land Magic and removed-from-game destinations, separates owner and controller, rejects duplicate IDs and capacity violations, and emits ordered movement events. Not all legacy movement paths, attached-card paths, Token post-destination removal, zone-specific destination rules, or control change are migrated. Deck Search/Scout/Mill and Control Change remain out of scope.

## Phase 2.2 implementation status (current branch)

- **Partial — Construct:** engine movement and shared validation enforce the maximum three and per-player unique names; state tests include opposing same-name legality. Direct legacy placement paths are not all migrated.
- **Partial — Magic:** Normal, Modification, React and Land usage is checked at supported play/reaction entry points; all types count once per active turn. Modification is not exempt. General ability text that says a use counts as a Magic type is not comprehensively modeled.
- **Partial — duration/layers:** END_OF_BATTLE, END_OF_TURN and DRAW_PHASE cleanup is tested across Avatar, Construct, LIFE, attached and shared Land card state. Full snapshot/layer transfer and Construct/LIFE attack integration remain incomplete. Layer 4 expiry versus post-combat transfer remains **Rule ambiguity**.
- **Partial — first turn:** first player turn one skips Battle; Game State, next-turn and SYNC gating are tested. Live reaction-deferred multiplayer flow/reconnect remains unverified.
- **Partial; Rule ambiguity — End Phase:** selection is mandatory above seven, exact distinct IDs and current revision are checked, duplicate commands are rejected, the host handles the active peer command, and other actions are locked while pending. Rule Book 3.2 does not specify destination; routing to owner Hell is only an application convention. Browser interaction, live peer behavior, reconnect, and rejection acknowledgement are not verified.
- **Partial — shared infrastructure:** nested transactional rollback, event ordering/ID dedupe/recursion protection, and basic zone movement/ownership/privacy are covered by state assertions. Legacy mutations remain; the event layer is not Trigger Effects.
- **Unsupported:** Control Change, Search, Scout, Mill, Token destination-then-removal, and Trigger Effects are not claimed as implemented. Ad-Mua three-plus-player Reaction priority remains unsupported by the official book and disabled.
- **Catalog cards:** no individual card was promoted to Working or Verified. No claim is made that all 1,833 printed-effect records were tested.

Final Phase 2.2 validation: `npm test` passed **12 files / 95 tests**; `npx tsc --noEmit`, `npm run build`, and `git diff --check` all passed. See `RULE_ENGINE_GAP_ANALYSIS.md` for the source-backed matrix and `CARD_EFFECT_AUDIT.md` for per-record status limits.
