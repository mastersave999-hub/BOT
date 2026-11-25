# BATTLE OF TALINGCHAN - RULE GAPS & COMMUNITY MULTIPLAYER REPORT

## 1. OFFICIAL 2-PLAYER RULE AMBIGUITIES & ENGINE EDGE CASES
| ID | Area / Subject | Specific Ambiguity / Conflict | Recommended Engine Handling |
|---|---|---|---|
| **GAP-01** | Simultaneous Trigger Ordering | When both players have simultaneous triggers (e.g., matching Last Words / คำสั่งเสีย), Page 23 notes turn player triggers first and resolves second (LIFO). Does this strictly follow Magic the Gathering APNAP (Active Player, Non-Active Player)? | Implement strict APNAP priority queue for trigger registration and resolution. |
| **GAP-02** | Layer 4 to Layer 1 Relocation Timing | Page 16 notes Layer 4 combat modifiers move to Layer 1 or 2 after combat. How does this interact if the card was temporarily boosted "จนจบการต่อสู้" (until end of combat)? | Modifiers specifying "until end of combat" expire at Step 3 of Battle Phase. Only persistent modifiers migrate to Layer 1/2. |
| **GAP-03** | LIFE Card Trigger Timing | Rulebook Page 22 states LIFE cards revealed in the previous turn resolve at the start of Main Phase. However, Fandom and tournament players report some immediate trigger LIFE cards. | Support two LIFE effect timing tags: `IMMEDIATE` (resolved right upon reveal) and `NEXT_MAIN_PHASE` (queued until start of owner's next Main Phase). Default to official Rulebook Page 22 unless card text specifies immediate. |
| **GAP-04** | Discard Cost in Nullified Summons | In Page 6, Cost payment occurs before Avatar Summon. If a summon is intercepted/prevented, are discarded GEM cards already in Hell? | Rulebook Page 6 specifies cards in Cost Step are NOT in Hell until resolution finishes. If summon fails, cards transition to Hell upon resolution failure. |

---

## 2. AD-MUA (อัดมั่ว) 3-4 PLAYER MULTIPLAYER RULES
> [!IMPORTANT]
> Official Rulebook 3.2 is strictly written for 2-player Duel format. Ad-Mua rules are derived from community guidelines, tournament rules (Fanmeet 2025), and special Kudsan Deck cards (KD00 series).

### Verified Ad-Mua Rules:
1. **Turn Direction**: Determined by highest dice roll, proceeds clockwise (to the left player).
2. **First Turn Attack Restriction**: Attack declarations are forbidden until the **last player of round 1** takes their turn. (e.g. In a 4-player game A -> B -> C -> D, players A, B, and C cannot attack on Turn 1; player D is the first who may attack).
3. **React Magic Budget in Multiplayer**:
   - Each player has **1 React Magic per turn of their own**, and **1 React Magic across all opponents' turns combined** until the round returns to them.
   - Example: Player A uses React in Player B's turn. Player A CANNOT use React during Player C's or Player D's turns.
4. **Targeting Scope**:
   - "เลือก Avatar 1 ใบ" -> Player must explicitly declare the target player and the target card.
   - "ทำลาย Avatar ทุกใบของฝ่ายตรงข้าม" -> Affects ALL other players (global opponents).
   - "ผู้เล่นทั้งสองฝ่าย" -> Affects the casting player and exactly ONE chosen opponent.
5. **LIFE Elimination & Win Condition**:
   - Last surviving player wins (Free-For-All), or special card win condition.
   - When a player is eliminated, all of their cards on field, hand, deck, and Hell are removed from the game immediately. Any cards borrowed via control change return to original owners.
