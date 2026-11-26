# Battle of Talingchan — Rule Gaps (Phase 1.5)

**Authority:** Battle of Talingchan Rule Book Version 3.2 (`rulebook_raw.txt`, 25 numbered pages).
**Inspection baseline:** branch `v0/reaction-window-phase1`, commit `c92cd772715495d450eb1fe76441438e09cbe723`.
**Scope:** This file is a concise index, not a substitute for source evidence. The full rule-to-engine matrix, test evidence, card statistics, ambiguities and Phase 2 dependency roadmap are in [`RULE_ENGINE_GAP_ANALYSIS.md`](RULE_ENGINE_GAP_ANALYSIS.md). The complete record-level card/effect mapping is in [`CARD_EFFECT_AUDIT.md`](CARD_EFFECT_AUDIT.md).

## Status definitions

- **Verified:** actual before/after Game State evidence for the named narrow behavior.
- **Implemented but unverified:** source exists, adequate Game State test not found.
- **Partial:** some rule path is implemented/tested, material behavior remains absent or unverified.
- **Missing:** no implementation found.
- **RULE_AMBIGUITY:** the Rule Book does not settle a specific precedence/interpretation.
- **Unsupported / not official:** the Rule Book does not specify the requested multiplayer extension; do not infer a rule.

Do not infer card correctness from parser/text matching. No catalog card is marked fully **Verified** in the effect inventory.

## Confirmed high-priority gaps

| Gap | Rule Book | Current source evidence | Status / impact |
|---|---|---|---|
| Construct Zone capacity and names | p.2: max 3, unique names per player | `gameRules.ts` validator and shared zone move; UI checks and multiplayer SYNC validator | **Partial** — engine/UI/sync boundaries now reject over-capacity and duplicate names; direct in-memory producers must use shared movement or validate before commit |
| Avatar + Token capacity and Token exit | pp.1, 19: up to 4 Avatar, 6 total; Token moves to zone then leaves game | State stores shared zone; no complete mixed-capacity or Token removal lifecycle | **Missing / partial** |
| Magic subtype limit | p.10: one use of each Magic type per turn, including opponent’s turn | `gameRules.ts:canUseMagicTypeThisTurn`; `Playmat.tsx` checks effective type | **Partial** — Modification exemption removed and helper tests cover repeated use; some reaction/ability granted-use paths remain unverified |
| Effect duration cleanup | pp.7, 16, 21–22: attack/turn/draw timing and Layer 4 | `expireModifiersAt` filters only the matching expiry; called after Avatar combat and at that player’s Draw Phase | **Partial** — direct Game State timing tests pass for END_OF_BATTLE, DRAW_PHASE, END_OF_TURN and unrelated modifiers; Construct/LIFE attack routes and Layer 4 transfer ambiguity remain |
| First player’s first-turn Battle Phase | pp.21–22: skipped | `turnEngine.ts:isFirstPlayerFirstTurn` / `nextPhaseAfterMain`; Playmat transitions to END | **Partial** — helper boundary tests pass for both players and later turns; full reaction/network turn flow lacks an integration test |
| End Phase hand size | p.25: choose/discard to 7 as the final action; destination is not stated | `gameRules.ts:discardToHandLimit`; Playmat selection; multiplayer outgoing-turn validator | **Partial; Rule ambiguity** — selection/count and transition tests pass; Hell is the current implementation convention, not a destination established by Rule Book 3.2; browser flow remains unverified |
| Full card-effect transaction | pp.12–13: all-or-nothing, cost only when effect is possible | Typed resolver stages and rolls back; text adapter does not form complete target/condition/cost plans | **Partial** |
| Prevention and cancellation | pp.10, 15, 18, 24 | Prevention is blocked; cancellation only a narrow React-Magic pattern | **Missing / partial** |
| Control change and owner routing | pp.6, 9, 18, 20 | Owner/controller fields exist; no typed control-change movement | **Missing** |
| Continuous layers and duration | pp.15–17, 21 | POWER aura subset exists; full layer semantics, snapshot and end-of-battle expiration absent | **Partial** |
| Trigger timing | pp.5, 7–8, 12, 22–24 | A small set of trigger labels and LIFE queue exist; no general event/timing queue | **Partial** |
| Search, Scout and Mill | pp.3, 7, 13–14 | No typed private Deck operation, exact quoted-name semantics, or shuffle/search/scout/mill pipeline | **Missing** |
| Combat / Construct combat | pp.22–25 | Avatar comparison helper and LIFE helper exist; no complete combat transaction or Construct combat | **Partial / missing** |
| Multiplayer authority and 3+ priority | pp.18–19, official book describes two-player response priority | PeerJS host-authoritative client; 3+ reaction windows deliberately disabled | 3+ order is **Unsupported / not official**, not inferred; client host is not trusted authority |

## Rule-book ambiguities (not invented rulings)

1. **RULE_AMBIGUITY — Layer 4 expiry versus transfer (pp.7, 16):** p.7 specifies distinct end points for Avatar combat versus Construct/LIFE attacks; p.16 says Layer 4 effects transfer to Layer 1/2 after combat but does not state how an explicitly temporary “until end of combat/attack” effect interacts with that transfer. See full analysis for the conservative implementation note.
2. **Ad-Mua React order:** the supplied official text does not establish a priority order for three or more players. This is an absence of official rules, not a license to adopt community/APNAP ordering.

The LIFE rules on p.5 and p.22 are compatible: reveal caused by an ability alone does not trigger LIFE; LIFE revealed by an attack is queued for its owner’s next Main Phase.

## Ad-Mua note

The repository has community multiplayer guidance in prior documentation, but it is not Rule Book 3.2 evidence. The engine implements some Ad-Mua elimination/turn-order behaviors; do not call community turn direction, React budgets, target scope or elimination details official unless backed by a separately identified authoritative source. Official Rule Book 3.2 does not define 3+ player Reaction priority, and the current engine correctly refuses to open those windows rather than guessing.

## Test snapshot

Baseline `npm test` on the Phase 1.5 inspected commit: **10 test files, 72 tests passed**. The Phase 2.1 implementation branch now has **11 test files, 83 tests passing** (current rerun); the added `gameRules.test.ts` and expanded engine suites assert actual before/after Game State. This does not mean 83 rules or 1,833 effect texts are verified.

## Phase 2.1 implementation status (current branch)

- **Partial:** Construct count/name validation is shared across movement, resolver initial/final validation, UI placement, and incoming multiplayer state validation. Same Construct name remains legal on the opponent’s side. Direct legacy mutation paths remain; only validated network snapshots and migrated paths are guarded.
- **Partial:** Rule Book p.10 says each Magic type is usable once each turn, including on the opponent’s turn. Modification Magic is not an exception. Its repeated-use guard is shared; complete React/reaction type accounting still requires broader tests. Existing attachment/leave-field code is preserved.
- **Partial:** duration cleanup now removes only a matching marker, at Avatar combat completion, the affected player’s Draw Phase, or End of Turn. Layer 4 transfer versus explicitly temporary attack duration remains **RULE_AMBIGUITY** (pp.7,16); Construct/LIFE attack timing needs integration coverage.
- **Partial:** Rule Book pp.21–22 first-player turn-one skips Battle; tested helper distinguishes player and later turns. Playmat wiring exists; complete multiplayer/reaction phase flow remains unverified.
- **Partial; Rule ambiguity:** Rule Book p.25 requires the player to choose/discard to seven as the final End Phase action but does not specify the destination. Current code uses owner Hell as a declared application convention; UI validates exact distinct IDs and multiplayer transition checks enforce that convention. Browser-level interrupted/cancelled flow remains unverified.
- Shared substrate: `gameTransaction.ts` stages nested state and validates before publishing; `gameEvents.ts` defines typed payloads and deterministic append ordering; `gameRules.ts` centralizes zone movement, Construct/Avatar limits and privacy-safe event payloads. `effectResolver.ts` uses the shared transaction and zone movement for Avatar destroy/bounce, and only successful plans append Effect Resolved events.
- **Partial:** event catalog includes implemented internal movement/effect events and planned event shapes (summon, token, magic, attack/battle, turns, cancellation/prevention); those planned lifecycle events are not yet emitted by every transition. The dispatcher is finite-snapshot, not a trigger engine.
- **Partial:** shared zone API supports current player zones plus shared Land Magic and removed-from-game destinations, separates owner and controller, rejects duplicate IDs and capacity violations, and emits ordered movement events. Not all legacy movement paths, attached-card paths, Token post-destination removal, zone-specific destination rules, or control change are migrated. Deck Search/Scout/Mill and Control Change remain out of scope.

See `RULE_ENGINE_GAP_ANALYSIS.md` for exact references, source locations, tests and remaining unsupported areas. No card-level status was promoted based on this infrastructure.
