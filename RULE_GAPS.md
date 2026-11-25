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
| Construct Zone capacity and names | p.2: max 3, unique names per player | `Playmat.tsx` blocks at 4; no duplicate-name check | **Partial / incorrect limit** |
| Avatar + Token capacity and Token exit | pp.1, 19: up to 4 Avatar, 6 total; Token moves to zone then leaves game | State stores shared zone; no complete mixed-capacity or Token removal lifecycle | **Missing / partial** |
| Magic subtype limit | pp.10–11: one use of each type per turn | `Playmat.tsx` exempts Modification from duplicate-use guard | **Partial / source discrepancy** |
| End-of-battle modifiers | pp.7, 16, 21–22: attack-duration and Layer 4 rules | `clearEndOfTurnModifiers` clears only `END_OF_TURN`; Unity writes `END_OF_BATTLE` | **Partial / modifier can persist**; precise transfer/expiry interaction is **RULE_AMBIGUITY** |
| First player’s first-turn Battle Phase | pp.21–22: skipped | Main→Battle UI transition is unconditional | **Missing** |
| End Phase hand size | p.25: discard to 7 as final action | No discard-to-seven action found | **Missing** |
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

Baseline `npm test` on the inspected commit: **10 test files, 72 tests passed**. State-backed scenarios cover selected typed effect transactions/rollback, reaction/LIFO sequences, turn draw/LIFE queue, elimination, privacy projections and some ability transitions. Parser, deck validation, GEM payment, layer arithmetic and combat comparison include helper-level tests. See the detailed test audit in `RULE_ENGINE_GAP_ANALYSIS.md`; passing 72 tests does not mean 72 Rule Book rules or 1,833 effect texts are verified.
