import type { CardInstance, DeferredReactionAction, GameState, MagicSubtype } from '../types';
import {
  beginEndPhaseDiscard,
  declineExitPrevention,
  discardToHandLimit,
  getEffectiveCost,
  getColorlessGemInstanceIds,
  moveCardBetweenZones,
  validateMagicPlay
} from '../gameRules';
import {
  getGemPaymentCardUnavailableReason,
  validateGemPayment
} from '../gemPayment';
import { deriveLegalAvatarActions, deriveLegalHandActions, type HandActionKind } from '../legalActions';
import {
  avatarHasKeyword,
  executeCardAbility,
  parseCardAbility,
  recomputeContinuousAuras
} from '../abilityEngine';
import {
  effectiveMagicSubtype,
  getEligibleReactionCards,
  openReactionWindow,
  passReactionPriority,
  queueReactionCard,
  sendResolvedMagicToHell
} from '../reactionEngine';
import { calculateNetPower } from '../layers';
import { checkModificationEquip } from '../equipLegality';
import { declareCombatAttack, resolveDeclaredBattle } from '../combatKeywords';
import { resolveAvatarCombat } from '../combatEngine';
import { confirmNoSearchTarget, resolveDeckChoice } from '../deckOperations';
import { resolveHellChoice } from '../hellChoice';
import { autoApproveManualOverride, classifyCard } from '../hybridMode';
import { eliminatePlayer, executeDrawPhase, finishEndPhaseTurn, nextPhaseAfterMain, transitionGamePhase } from '../turnEngine';

/**
 * Phase A+B of the Hybrid AI Opponent plan: a pure, deterministic AI driver.
 *
 * Every decision is derived from the public game state through the same engine
 * gates the human UI uses (deriveLegalHandActions, getEffectiveCost, canPayCost /
 * validateGemPayment, validateMagicPlay), so the AI can never take an action the
 * engine would reject and always pays its Cost + matching GEM colors exactly.
 * The React layer (Playmat) only schedules delays and dispatches the returned
 * states — no game logic lives there anymore.
 */

export interface AiStepOutcome {
  kind: 'APPLIED' | 'WAITING' | 'DONE';
  state: GameState;
  logs: string[];
  /** Deck-out / combat loss winner detected while applying this step. */
  winnerId?: string;
  /**
   * A deferred reaction action that closed with the window but belongs to the
   * human player; the React layer must route it through its existing
   * finishDeferredReactionAction pipeline (UI prompts, notifications).
   */
  pendingAction?: DeferredReactionAction;
  reason?: string;
}

type EventLogEntry = GameState['eventLog'][number];

function appendEventLog(state: GameState, descriptions: string[], type: string, actorId: string): GameState {
  if (descriptions.length === 0) return state;
  const entries: EventLogEntry[] = descriptions.map(description => ({
    timestamp: Date.now(),
    type,
    description,
    actorId
  }));
  return { ...state, eventLog: [...state.eventLog, ...entries] };
}

function otherPlayerId(state: GameState, playerId: string): string | undefined {
  return state.playerOrder.find(id => id !== playerId);
}

/** Deck-out (DUEL) / elimination (AD_MUA) win detection shared by every step. */
function detectDeckOut(state: GameState): { state: GameState; winnerId?: string } {
  const deckOutPlayer = state.playerOrder.find(id => {
    const player = state.players[id];
    return player && player.deck.filter(card => card.card.type !== 'Life').length === 0;
  });
  if (!deckOutPlayer) return { state };
  if (state.mode === 'AD_MUA') {
    const elimination = eliminatePlayer(state, deckOutPlayer, 'การ์ดในเด็คหมดและถูกกำจัดออกจากเกม');
    const winnerId = elimination.winnerId ??
      (elimination.state.playerOrder.length === 1 ? elimination.state.playerOrder[0] : undefined);
    return { state: elimination.state, winnerId: winnerId ?? undefined };
  }
  return { state, winnerId: otherPlayerId(state, deckOutPlayer) };
}

/** Parse "X ... lost the game" combat events into a winner id. */
function detectCombatLoss(state: GameState, events: string[]): string | undefined {
  for (const event of events) {
    const match = event.match(/^(.+?)\s+(?:has lost the game|took lethal damage and has lost)/);
    if (!match) continue;
    const loser = state.playerOrder.find(id => state.players[id]?.name === match[1]);
    if (!loser) continue;
    return otherPlayerId(state, loser);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// GEM payment: the AI must pay exact Cost with matching GEM colors.
// ---------------------------------------------------------------------------

/**
 * Picks a legal GEM payment for `targetCard` (Rule Book 3.2 Cost Step).
 * Prefers an exact total, then fewer discarded cards, then spending
 * unplayable (UNSUPPORTED/AMBIGUOUS) cards before verified ones.
 */
export function selectGemPayment(
  hand: CardInstance[],
  targetCard: CardInstance,
  requiredCost: number,
  colorlessGemInstanceIds: ReadonlySet<string> = new Set()
): string[] | null {
  if (requiredCost === 0) return [];
  const candidates = hand
    .filter(card =>
      card.instanceId !== targetCard.instanceId &&
      (card.card.gem ?? 0) > 0 &&
      getGemPaymentCardUnavailableReason(card, targetCard, { colorlessGemInstanceIds }) === null)
    .sort((left, right) => (right.card.gem ?? 0) - (left.card.gem ?? 0))
    .slice(0, 16);
  if (candidates.length === 0) return null;

  const supportRank = (card: CardInstance) =>
    classifyCard(card.card).status === 'VERIFIED_WORKING' ? 0 : 1;

  interface PaymentPlan {
    ids: string[];
    exact: boolean;
    size: number;
    supportSpent: number;
    waste: number;
  }
  const improves = (candidate: PaymentPlan, best: PaymentPlan | null): boolean => {
    if (!best) return true;
    if (candidate.exact !== best.exact) return candidate.exact;
    if (candidate.size !== best.size) return candidate.size < best.size;
    if (candidate.supportSpent !== best.supportSpent) return candidate.supportSpent > best.supportSpent;
    return candidate.waste < best.waste;
  };

  let best: PaymentPlan | null = null;
  const count = candidates.length;
  for (let mask = 1; mask < (1 << count); mask += 1) {
    let total = 0;
    let smallestGem = Number.POSITIVE_INFINITY;
    const ids: string[] = [];
    let supportSpent = 0;
    for (let index = 0; index < count; index += 1) {
      if ((mask & (1 << index)) === 0) continue;
      const candidate = candidates[index];
      const gem = candidate.card.gem ?? 0;
      total += gem;
      if (gem < smallestGem) smallestGem = gem;
      ids.push(candidate.instanceId);
      supportSpent += supportRank(candidate);
    }
    // Same validity rule as validateGemPayment: covers the Cost, no card redundant.
    if (total < requiredCost || total - smallestGem >= requiredCost) continue;
    const plan: PaymentPlan = {
      ids,
      exact: total === requiredCost,
      size: ids.length,
      supportSpent,
      waste: total - requiredCost
    };
    if (improves(plan, best)) best = plan;
  }
  if (!best) return null;
  // The engine is the final authority; never dispatch an illegal payment.
  const validation = validateGemPayment(hand, targetCard, best.ids, requiredCost, { colorlessGemInstanceIds });
  return validation.valid ? best.ids : null;
}

// ---------------------------------------------------------------------------
// Card value heuristics
// ---------------------------------------------------------------------------

interface CardValueContext {
  state: GameState;
  aiPlayerId: string;
}

/** Higher keep-score = more worth holding; the lowest scores are discarded first. */
function endPhaseDiscardKeepScore(card: CardInstance, context: CardValueContext): number {
  const parsed = parseCardAbility(card.card);
  const verification = classifyCard(card.card).status;
  let score = 10 - (verification === 'VERIFIED_WORKING' ? 0 : verification === 'AMBIGUOUS' ? 5 : 10);
  if (card.card.type === 'Avatar') score += 6 + card.card.power / 10;
  else if (card.card.type === 'Magic') score += 5 + parsed.drawCount;
  else if (card.card.type === 'Construct') score += 4;
  score -= card.card.cost * 0.5;
  const player = context.state.players[context.aiPlayerId];
  if (player && card.card.type === 'Construct' &&
    player.constructZone.some(owned => owned.card.name === card.card.name)) {
    score -= 8; // duplicate Construct can never be set
  }
  return score;
}

function deckChoiceCandidateScore(card: CardInstance): number {
  const parsed = parseCardAbility(card.card);
  const verification = classifyCard(card.card).status;
  let score = 10 - (verification === 'VERIFIED_WORKING' ? 0 : verification === 'AMBIGUOUS' ? 6 : 12);
  if (card.card.type === 'Avatar') {
    score += 6 + card.card.power / 10;
    if (card.card.cost <= 3) score += 3; // smooth curve: playable next turn
  } else if (card.card.type === 'Magic') {
    score += 5 + parsed.drawCount * 2 + (parsed.destroysTarget ? 3 : 0);
  } else if (card.card.type === 'Construct') {
    score += 4;
  } else if (card.card.type === 'Life') {
    score += 2;
  }
  return score;
}

function hellChoiceCandidateScore(card: CardInstance, pendingCardType: string): number {
  const verification = classifyCard(card.card).status;
  let score = 8 - (verification === 'VERIFIED_WORKING' ? 0 : verification === 'AMBIGUOUS' ? 5 : 10);
  if (card.card.type === 'Avatar') score += 6 + card.card.power / 10;
  else if (card.card.type === 'Magic') score += 4;
  else if (card.card.type === 'Construct') score += 3;
  if (card.card.type !== pendingCardType) score -= 100; // the effect only accepts this type
  return score;
}

function chooseAbilityTarget(
  state: GameState,
  aiPlayerId: string,
  parsed: ReturnType<typeof parseCardAbility>
): string | undefined {
  const ai = state.players[aiPlayerId];
  const opponentId = otherPlayerId(state, aiPlayerId);
  const opponent = opponentId ? state.players[opponentId] : undefined;
  const wantsOpponent = parsed.targetScope === 'OPPONENT_AVATAR' ||
    (parsed.targetScope === 'ANY_AVATAR' &&
      (parsed.destroysTarget || parsed.bouncesTarget || parsed.resetsPower || parsed.powerMod < 0));
  if (wantsOpponent && opponent && opponent.avatarZone.length > 0) {
    const target = [...opponent.avatarZone].sort((a, b) => calculateNetPower(b) - calculateNetPower(a))[0];
    return target?.instanceId;
  }
  if (!ai || ai.avatarZone.length === 0) return undefined;
  const sorted = [...ai.avatarZone].sort((a, b) => calculateNetPower(b) - calculateNetPower(a));
  // A negative effect on our own side should hit the weakest Avatar.
  if (parsed.powerMod < 0 && parsed.targetScope !== 'OPPONENT_AVATAR') {
    return sorted[sorted.length - 1]?.instanceId;
  }
  return sorted[0]?.instanceId;
}

// ---------------------------------------------------------------------------
// Pending-state resolvers (Phase B)
// ---------------------------------------------------------------------------

function resolveEndPhaseDiscardForAi(state: GameState, aiPlayerId: string): AiStepOutcome {
  const pending = state.pendingEndPhaseDiscardPlayerId;
  const player = state.players[aiPlayerId];
  if (!pending || pending !== aiPlayerId || !player) {
    return { kind: 'WAITING', state, logs: [], reason: 'End Phase discard is not the AI decision' };
  }
  const required = Math.max(0, player.hand.length - 7);
  const context: CardValueContext = { state, aiPlayerId };
  const discardIds = [...player.hand]
    .sort((a, b) => endPhaseDiscardKeepScore(a, context) - endPhaseDiscardKeepScore(b, context))
    .slice(0, required)
    .map(card => card.instanceId);
  const result = discardToHandLimit(state, aiPlayerId, discardIds);
  if (!result.ok) {
    return { kind: 'WAITING', state, logs: [], reason: result.reason ?? 'End Phase discard failed' };
  }
  const discardedNames = player.hand
    .filter(card => discardIds.includes(card.instanceId))
    .map(card => `"${card.card.name}"`);
  const finished = finishEndPhaseTurn(result.state);
  const nextPlayerId = finished.playerOrder[finished.currentTurnPlayerIndex];
  const nextPlayerName = finished.players[nextPlayerId]?.name ?? nextPlayerId;
  const logs = [
    `${player.name} ทิ้งการ์ดเกินลิมิต ${required} ใบ (${discardedNames.join(', ')})`,
    `จบเทิร์นของ ${player.name} — เริ่มเทิร์นของ ${nextPlayerName}`
  ];
  return { kind: 'DONE', state: appendEventLog(finished, logs, 'TURN_CHANGE', aiPlayerId), logs };
}

function resolveDeckChoiceForAi(state: GameState, aiPlayerId: string): AiStepOutcome {
  const pending = state.pendingDeckChoice;
  if (!pending || pending.authorizedViewerId !== aiPlayerId) {
    return { kind: 'WAITING', state, logs: [], reason: 'Deck choice is not authorized for the AI' };
  }
  const deckOwner = state.players[pending.deckOwnerId];
  const candidates = pending.candidateInstanceIds
    .map(instanceId => deckOwner?.deck.find(card => card.instanceId === instanceId))
    .filter((card): card is CardInstance => !!card)
    .sort((a, b) => deckChoiceCandidateScore(b) - deckChoiceCandidateScore(a));
  const goodCount = candidates.filter(card => deckChoiceCandidateScore(card) > 0).length;
  const selectCount = Math.min(pending.maxSelect, Math.max(pending.minSelect, goodCount));
  const selected = candidates.slice(0, Math.max(0, selectCount)).map(card => card.instanceId);
  const result = resolveDeckChoice(state, aiPlayerId, selected, pending.expectedRevision, {
    commandId: pending.commandId ?? `ai-deck-choice:${pending.expectedRevision}:${aiPlayerId}`
  });
  if (!result.ok) {
    return { kind: 'WAITING', state, logs: [], reason: result.reason ?? 'Deck choice failed' };
  }
  const chosenNames = selected.length > 0
    ? selected
      .map(instanceId => deckOwner?.deck.find(card => card.instanceId === instanceId)?.card.name)
      .filter(Boolean).map(name => `"${name}"`).join(', ')
    : 'ไม่เลือกการ์ด';
  const logs = [`${state.players[aiPlayerId]?.name ?? aiPlayerId} เลือกการ์ดจาก ${pending.kind === 'SCOUT' ? 'Scout' : 'Deck Search'}: ${chosenNames} (ส่วนที่เหลือถูกสับตามกติกา)`];
  const deckOut = detectDeckOut(result.state);
  return {
    kind: 'APPLIED',
    state: appendEventLog(deckOut.state, logs, 'DECK_CHOICE', aiPlayerId),
    logs,
    winnerId: result.winnerId ?? deckOut.winnerId
  };
}

function resolveHellChoiceForAi(state: GameState, aiPlayerId: string): AiStepOutcome {
  const pending = state.pendingHellChoice;
  if (!pending || pending.authorizedViewerId !== aiPlayerId) {
    return { kind: 'WAITING', state, logs: [], reason: 'Hell choice is not authorized for the AI' };
  }
  const owner = state.players[pending.playerId];
  const candidates = pending.candidateInstanceIds
    .map(instanceId => owner?.hell.find(card => card.instanceId === instanceId) ??
      owner?.darkDimension.find(card => card.instanceId === instanceId))
    .filter((card): card is CardInstance => !!card)
    .sort((a, b) => hellChoiceCandidateScore(b, pending.cardType) - hellChoiceCandidateScore(a, pending.cardType));
  const goodCount = candidates.filter(card => hellChoiceCandidateScore(card, pending.cardType) > 0).length;
  const selectCount = Math.min(pending.maxSelect, Math.max(pending.minSelect, goodCount));
  const selected = candidates.slice(0, Math.max(0, selectCount)).map(card => card.instanceId);
  const result = resolveHellChoice(state, aiPlayerId, selected, pending.expectedRevision,
    pending.commandId ?? `ai-hell-choice:${pending.expectedRevision}:${aiPlayerId}`);
  if (!result.ok) {
    const reason = 'reason' in result ? result.reason : 'Hell choice failed';
    return { kind: 'WAITING', state, logs: [], reason };
  }
  const chosenNames = selected.length > 0
    ? selected
      .map(instanceId => candidates.find(card => card.instanceId === instanceId)?.card.name)
      .filter(Boolean).map(name => `"${name}"`).join(', ')
    : 'ไม่เลือกการ์ด';
  const logs = [`${state.players[aiPlayerId]?.name ?? aiPlayerId} เลือกการ์ดจาก Hell: ${chosenNames}`];
  return { kind: 'APPLIED', state: appendEventLog(result.state, logs, 'HELL_CHOICE', aiPlayerId), logs };
}

/** Rule Book 3.2 p.3: a Deck Search with no target needs public verification. */
function resolveSearchVerificationForAi(state: GameState, aiPlayerId: string): AiStepOutcome {
  const pending = state.pendingDeckSearchVerification;
  if (!pending || !pending.verifierPlayerIds.includes(aiPlayerId)) {
    return { kind: 'WAITING', state, logs: [], reason: 'Search verification is not the AI decision' };
  }
  const result = confirmNoSearchTarget(state, aiPlayerId, pending.expectedRevision,
    `ai-search-verify:${pending.expectedRevision}:${aiPlayerId}`);
  if (!result.ok) {
    return { kind: 'WAITING', state, logs: [], reason: result.reason ?? 'Search verification failed' };
  }
  const logs = [`${state.players[aiPlayerId]?.name ?? aiPlayerId} ยืนยันผลการค้นเด็ค (ไม่พบเป้าหมาย)`];
  return { kind: 'APPLIED', state: appendEventLog(result.state, logs, 'DECK_CHOICE', aiPlayerId), logs };
}

function resolveManualOverrideForAi(state: GameState, aiPlayerId: string): AiStepOutcome {
  const pending = state.pendingManualOverride;
  if (!pending || pending.actorId === aiPlayerId) {
    return { kind: 'WAITING', state, logs: [], reason: 'Manual override is not awaiting AI approval' };
  }
  const result = autoApproveManualOverride(state);
  if (!result.ok) {
    return { kind: 'WAITING', state, logs: [], reason: result.reason ?? 'Manual override approval failed' };
  }
  const logs = [`${state.players[aiPlayerId]?.name ?? aiPlayerId} อนุมัติ Manual Override` +
    (pending.context?.cardName ? ` สำหรับ "${pending.context.cardName}"` : '')];
  return { kind: 'APPLIED', state: appendEventLog(result.state, logs, 'MANUAL_OVERRIDE', aiPlayerId), logs };
}

// ---------------------------------------------------------------------------
// Reaction window policy (Phase B item 5)
// ---------------------------------------------------------------------------

interface ReactionDecision {
  play: CardInstance;
  targetAvatarId?: string;
  reason: string;
}

/**
 * Defensive reaction policy: react only when the window threatens one of our
 * Avatars (destruction / targeting / attack declaration) and an eligible
 * VERIFIED_WORKING card answers it. Everything else is passed.
 */
export function chooseAiReaction(state: GameState, aiPlayerId: string): ReactionDecision | null {
  const window = state.reactionWindow;
  if (!window || window.priorityPlayerId !== aiPlayerId || window.pendingReaction) return null;
  const eligible = getEligibleReactionCards(state, aiPlayerId)
    .filter(card => classifyCard(card.card).status === 'VERIFIED_WORKING');
  if (eligible.length === 0) return null;

  const trigger = window.trigger;
  const ownAvatarIds = new Set(state.players[aiPlayerId]?.avatarZone.map(card => card.instanceId) ?? []);
  const targetIsOwnAvatar = !!trigger.targetInstanceId && ownAvatarIds.has(trigger.targetInstanceId);
  const attackDeclaredByOpponent = trigger.type === 'ATTACK_DECLARED' &&
    !!trigger.targetInstanceId &&
    state.playerOrder.some(id => id !== aiPlayerId &&
      state.players[id]?.avatarZone.some(card => card.instanceId === trigger.targetInstanceId));
  if (trigger.type === 'ATTACK_DECLARED' ? !attackDeclaredByOpponent : !targetIsOwnAvatar) return null;

  for (const card of eligible) {
    const parsed = parseCardAbility(card.card);
    if (trigger.type === 'ATTACK_DECLARED') {
      // The defender is not chosen yet, so only removing the attacker helps.
      if ((parsed.destroysTarget || parsed.bouncesTarget) && parsed.targetScope !== 'OWN_AVATAR') {
        return { play: card, targetAvatarId: trigger.targetInstanceId, reason: 'กำจัดผู้โจมตีเพื่อหยุดการโจมตี' };
      }
      continue;
    }
    // Buff / shield our threatened Avatar.
    if (parsed.powerMod > 0 || parsed.hasHumanShield || parsed.hasGrit) {
      const targetId = parsed.targetScope === 'OPPONENT_AVATAR'
        ? undefined
        : (trigger.targetInstanceId ?? chooseAbilityTarget(state, aiPlayerId, parsed));
      if (!parsed.needsTargetAvatar || targetId) {
        return { play: card, targetAvatarId: targetId, reason: 'ป้องกัน Avatar ของเราจากการถูกทำลาย' };
      }
    }
    // Remove the source of the threat.
    if (parsed.destroysTarget || parsed.bouncesTarget) {
      const sourceId = trigger.sourceInstanceId ?? trigger.targetInstanceId;
      if (sourceId && !ownAvatarIds.has(sourceId) && parsed.targetScope !== 'OWN_AVATAR') {
        return { play: card, targetAvatarId: sourceId, reason: 'กำจัดแหล่งของการทำลาย' };
      }
    }
  }
  return null;
}

function runAiReactionStep(state: GameState, aiPlayerId: string): AiStepOutcome {
  const ai = state.players[aiPlayerId];
  const window = state.reactionWindow;
  if (!ai || !window) {
    return { kind: 'WAITING', state, logs: [], reason: 'No reaction window for the AI' };
  }
  const decision = chooseAiReaction(state, aiPlayerId);
  if (decision) {
    const queued = queueReactionCard(state, aiPlayerId, decision.play.instanceId, decision.targetAvatarId);
    if (queued.ok) {
      const logs = [`${ai.name} ตอบโต้ด้วย "${decision.play.card.name}" — ${decision.reason}`];
      return { kind: 'APPLIED', state: appendEventLog(queued.state, logs, 'REACTION', aiPlayerId), logs };
    }
  }
  const passed = passReactionPriority(state, aiPlayerId);
  if (!passed.ok) {
    const reason = 'reason' in passed ? passed.reason : 'Passing priority failed';
    return { kind: 'WAITING', state, logs: [], reason };
  }
  const logs = passed.logs ?? [`${ai.name} ผ่านสิทธิ์ตอบโต้`];
  const nextState = appendEventLog(passed.state, logs, 'REACTION', aiPlayerId);
  const pendingAction = passed.pendingAction;
  if (pendingAction && pendingAction.actorId === aiPlayerId) {
    const applied = applyAiDeferredAction(nextState, pendingAction, aiPlayerId);
    return {
      kind: applied.kind === 'DONE' ? 'DONE' : 'APPLIED',
      state: applied.state,
      logs: [...logs, ...applied.logs],
      winnerId: applied.winnerId
    };
  }
  return { kind: 'APPLIED', state: nextState, logs, pendingAction };
}

// ---------------------------------------------------------------------------
// Deferred reaction actions (AI actor only)
// ---------------------------------------------------------------------------

interface CombatResolution {
  state: GameState;
  events: string[];
}

/** Pure mirror of the Playmat's resolveCombatAction, including destruction windows. */
function resolveAiCombat(
  state: GameState,
  attackerPlayerId: string,
  targetPlayerId: string,
  attackerInstanceId: string,
  targetAvatarId: string,
  checkedAvatarIds: string[] = []
): CombatResolution {
  const attacker = state.players[attackerPlayerId]?.avatarZone.find(card => card.instanceId === attackerInstanceId);
  const target = state.players[targetPlayerId]?.avatarZone.find(card => card.instanceId === targetAvatarId);
  if (!attacker || !target) {
    return { state, events: [`${attacker?.card.name ?? 'Avatar'} — เป้าหมายไม่อยู่บนสนาม การโจมตีสิ้นสุดลง`] };
  }
  const declared = declareCombatAttack(state, attackerInstanceId, { type: 'AVATAR', playerId: targetPlayerId, instanceId: targetAvatarId });
  if (!declared) return { state, events: [] };
  const layerFourPower = attacker.layerModifiers
    .filter(modifier => modifier.layer === 4)
    .reduce((total, modifier) => total + modifier.powerMod, 0);
  const preview = resolveAvatarCombat(attacker, target, declared.battleContext!.snapshotPower + layerFourPower);
  const leavingAvatars = [
    ...(preview.attackerDestroyed ? [attacker] : []),
    ...(preview.defenderDestroyed ? [target] : [])
  ].sort((left, right) => Number(left.controllerId !== attackerPlayerId) - Number(right.controllerId !== attackerPlayerId));
  for (const leaving of leavingAvatars) {
    const automaticShield = leaving.preventionShields?.some(shield =>
      shield.kind === 'DESTRUCTION' && (shield.mode ?? 'AUTOMATIC') === 'AUTOMATIC' && shield.usesRemaining !== 0);
    if (checkedAvatarIds.includes(leaving.instanceId) || automaticShield) continue;
    const reactionState = openReactionWindow(state, {
      type: 'AVATAR_WOULD_BE_DESTROYED',
      actorId: attackerPlayerId,
      targetInstanceId: leaving.instanceId,
      targetCardName: leaving.card.name,
      sourceCardName: attacker.card.name
    }, {
      type: 'RESOLVE_COMBAT',
      actorId: attackerPlayerId,
      sourceCard: attacker,
      targetPlayerId,
      targetAvatarId,
      checkedAvatarIds: [...checkedAvatarIds, leaving.instanceId]
    });
    if (reactionState !== state) {
      return { state: reactionState, events: [`${leaving.card.name} กำลังจะออกจากสนาม — เปิด Reaction Window`] };
    }
  }
  const result = resolveDeclaredBattle(declared);
  if (!result.ok) return { state, events: [result.reason ?? 'การต่อสู้ไม่สำเร็จ'] };
  return { state: appendEventLog(result.state, result.events, 'COMBAT', attackerPlayerId), events: result.events };
}

/** Direct LIFE attack mirrors the Playmat's handleAttackLifeZone engine path. */
function resolveAiLifeAttack(
  state: GameState,
  attackerPlayerId: string,
  targetPlayerId: string,
  attackerInstanceId: string
): CombatResolution {
  const declared = declareCombatAttack(state, attackerInstanceId, { type: 'LIFE', playerId: targetPlayerId });
  if (!declared) return { state, events: ['การโจมตี LIFE ไม่ถูกต้อง'] };
  const result = resolveDeclaredBattle(declared);
  if (!result.ok) return { state, events: [result.reason ?? 'การโจมตี LIFE ไม่สำเร็จ'] };
  return { state: appendEventLog(result.state, result.events, 'ATTACK_LIFE', attackerPlayerId), events: result.events };
}

interface AttackTargetChoice {
  targetPlayerId: string;
  /** undefined = direct LIFE attack */
  targetInstanceId?: string;
}

/** Picks the best legal target for an attacker, honouring the โล่มนุษย์ shield rule. */
export function chooseCombatTarget(state: GameState, aiPlayerId: string, attacker: CardInstance): AttackTargetChoice | null {
  const attackerPower = calculateNetPower(attacker);
  const canBypassShield = avatarHasKeyword(attacker, 'แทงหลัง') || avatarHasKeyword(attacker, 'เตะไข่');
  const directLifeAllowed = avatarHasKeyword(attacker, 'เตะไข่');
  let best: { choice: AttackTargetChoice; score: number } | null = null;
  for (const opponentId of state.playerOrder) {
    if (opponentId === aiPlayerId) continue;
    const opponent = state.players[opponentId];
    if (!opponent) continue;
    const shieldAvatars = opponent.avatarZone.filter(avatar => avatarHasKeyword(avatar, 'โล่มนุษย์'));
    for (const defender of opponent.avatarZone) {
      const mustHitShield = shieldAvatars.length > 0 && !avatarHasKeyword(defender, 'โล่มนุษย์') && !canBypassShield;
      if (mustHitShield) continue;
      const defenderPower = calculateNetPower(defender);
      let score: number;
      if (attackerPower > defenderPower) score = 20 + defenderPower;
      else if (attackerPower === defenderPower) score = 4; // even trade
      else continue;
      if (!best || score > best.score) {
        best = { choice: { targetPlayerId: opponentId, targetInstanceId: defender.instanceId }, score };
      }
    }
    if (opponent.avatarZone.length === 0 || directLifeAllowed) {
      const lifeScore = 12 + (opponent.avatarZone.length === 0 ? 8 : 0);
      if (!best || lifeScore > best.score) {
        best = { choice: { targetPlayerId: opponentId }, score: lifeScore };
      }
    }
  }
  return best?.choice ?? null;
}

/** Applies a deferred reaction action owned by the AI player. */
export function applyAiDeferredAction(state: GameState, action: DeferredReactionAction, aiPlayerId: string): AiStepOutcome {
  const ai = state.players[aiPlayerId];
  if (!ai) return { kind: 'WAITING', state, logs: [], reason: 'AI player not found' };
  let nextState = state;
  const logs: string[] = [];

  switch (action.type) {
    case 'SUMMON_JUTI': {
      const parsed = parseCardAbility(action.sourceCard.card);
      if (!action.paidCost || !parsed.hasJuti) break;
      const targetId = parsed.needsTargetAvatar ? chooseAbilityTarget(nextState, aiPlayerId, parsed) : undefined;
      if (parsed.needsTargetAvatar && !targetId) break;
      const result = executeCardAbility(nextState, aiPlayerId, action.sourceCard, 'SUMMON_JUTI', targetId);
      nextState = appendEventLog(result.state, result.logs, 'ABILITY', aiPlayerId);
      logs.push(...result.logs);
      break;
    }
    case 'RESOLVE_MAGIC': {
      const parsed = parseCardAbility(action.sourceCard.card);
      const targetId = action.targetAvatarId ??
        (parsed.needsTargetAvatar ? chooseAbilityTarget(nextState, aiPlayerId, parsed) : undefined);
      if (parsed.needsTargetAvatar && !targetId) {
        // No legal target: the Magic still leaves the field for Hell.
        nextState = sendResolvedMagicToHell(nextState, aiPlayerId, action.sourceCard);
        logs.push(`${action.sourceCard.card.name}: ไม่มีเป้าหมายที่ถูกต้อง — การ์ดลงนรก`);
        break;
      }
      const result = executeCardAbility(nextState, aiPlayerId, action.sourceCard, 'MAGIC_CAST', targetId);
      nextState = appendEventLog(
        result.state,
        [`✨ ${ai.name} ร่าย Magic "${action.sourceCard.card.name}"`, ...result.logs],
        'MAGIC',
        aiPlayerId
      );
      nextState = sendResolvedMagicToHell(nextState, aiPlayerId, action.sourceCard);
      logs.push(...result.logs);
      break;
    }
    case 'RESOLVE_COMBAT': {
      const combat = resolveAiCombat(
        nextState,
        action.actorId,
        action.targetPlayerId,
        action.sourceCard.instanceId,
        action.targetAvatarId,
        action.checkedAvatarIds ?? []
      );
      nextState = combat.state;
      logs.push(...combat.events);
      break;
    }
    case 'START_ATTACK': {
      const attacker = nextState.players[action.actorId]?.avatarZone
        .find(card => card.instanceId === action.sourceCard.instanceId);
      if (!attacker) break;
      const parsed = parseCardAbility(attacker.card);
      if (parsed.hasOnAttack) {
        const result = executeCardAbility(nextState, aiPlayerId, attacker, 'ON_ATTACK');
        nextState = appendEventLog(result.state, result.logs, 'ABILITY', aiPlayerId);
        logs.push(...result.logs);
      }
      const freshAttacker = nextState.players[aiPlayerId]?.avatarZone
        .find(card => card.instanceId === action.sourceCard.instanceId);
      if (!freshAttacker) break;
      const target = chooseCombatTarget(nextState, aiPlayerId, freshAttacker);
      if (!target) {
        logs.push(`${ai.name} ไม่พบเป้าหมายที่โจมตีได้ — งดโจมตี`);
        break;
      }
      const combat = target.targetInstanceId
        ? resolveAiCombat(nextState, aiPlayerId, target.targetPlayerId, freshAttacker.instanceId, target.targetInstanceId)
        : resolveAiLifeAttack(nextState, aiPlayerId, target.targetPlayerId, freshAttacker.instanceId);
      nextState = combat.state;
      logs.push(...combat.events);
      break;
    }
    case 'ADVANCE_PHASE': {
      const actorName = nextState.players[action.actorId]?.name ?? 'ผู้เล่น';
      if (action.nextPhase === 'BATTLE' || action.nextPhase === 'END') {
        const phaseLogs = [`${actorName} เข้าสู่ ${action.nextPhase === 'BATTLE' ? 'Battle' : 'End'} Phase`];
        nextState = appendEventLog(
          transitionGamePhase(nextState, action.actorId, action.nextPhase),
          phaseLogs,
          'PHASE_CHANGE',
          action.actorId
        );
        logs.push(...phaseLogs);
      } else if (action.nextPhase === 'DRAW') {
        const activePlayer = nextState.players[action.actorId];
        if (nextState.currentPhase === 'END' && (activePlayer?.hand.length ?? 0) > 7) {
          const discardState = beginEndPhaseDiscard(nextState, action.actorId);
          if (!discardState.ok) {
            return { kind: 'WAITING', state: nextState, logs, reason: discardState.reason };
          }
          nextState = discardState.state;
          logs.push(`${actorName} ต้องทิ้งการ์ดเกินลิมิตก่อนจบเทิร์น`);
          break;
        }
        nextState = finishEndPhaseTurn(nextState);
        const nextPlayerId = nextState.playerOrder[nextState.currentTurnPlayerIndex];
        const nextPlayerName = nextState.players[nextPlayerId]?.name ?? nextPlayerId;
        const turnLogs = [`จบเทิร์นของ ${actorName} — เริ่มเทิร์นของ ${nextPlayerName}`];
        nextState = appendEventLog(nextState, turnLogs, 'TURN_CHANGE', action.actorId);
        logs.push(...turnLogs);
        const deckOut = detectDeckOut(nextState);
        return { kind: 'DONE', state: deckOut.state, logs, winnerId: deckOut.winnerId };
      }
      break;
    }
    case 'AI_TURN_CONTINUATION': {
      logs.push(...action.logs);
      break;
    }
  }
  const deckOut = detectDeckOut(nextState);
  const combatWinner = detectCombatLoss(nextState, logs);
  const stillAiTurn = nextState.playerOrder[nextState.currentTurnPlayerIndex] === aiPlayerId;
  return {
    kind: deckOut.winnerId || combatWinner || !stillAiTurn ? 'DONE' : 'APPLIED',
    state: deckOut.state,
    logs,
    winnerId: deckOut.winnerId ?? combatWinner
  };
}

// ---------------------------------------------------------------------------
// Main Phase: legal hand actions with legitimate Cost/GEM payment (Phase A)
// ---------------------------------------------------------------------------

interface ScoredHandAction {
  card: CardInstance;
  kind: HandActionKind;
  score: number;
}

export function chooseMainPhaseAction(state: GameState, aiPlayerId: string): ScoredHandAction | null {
  const ai = state.players[aiPlayerId];
  if (!ai) return null;
  let best: ScoredHandAction | null = null;
  for (const card of ai.hand) {
    // AI never wastes cards on unmodeled no-op effects: only fully verified cards.
    if (classifyCard(card.card).status !== 'VERIFIED_WORKING') continue;
    for (const action of deriveLegalHandActions(state, aiPlayerId, card)) {
      const parsed = parseCardAbility(card.card);
      let score = 0;
      if (action.kind === 'SUMMON') {
        score = 10 + card.card.power / 10 + (parsed.hasJuti ? 2 : 0) - card.card.cost * 0.5;
      } else if (action.kind === 'CAST') {
        const subtype = effectiveMagicSubtype(card.card);
        if (subtype === 'Land') {
          if (state.landMagicZone && state.landMagicZone.ownerId === aiPlayerId) continue;
          score = 3;
        } else if (subtype === 'Modification') {
          const hasTarget = ai.avatarZone.some(avatar => checkModificationEquip(card.card, avatar.card).legal);
          if (!hasTarget) continue;
          score = 6 + Math.max(0, parsed.powerMod);
        } else {
          if (!card.card.mainEffect.trim()) continue; // vanilla Magic would be a wasted no-op
          score = 8 + parsed.drawCount * 3 + (parsed.destroysAllOpponentAvatars ? 12 : 0) +
            (parsed.destroysTarget ? 8 : 0) + (parsed.recoversFromHell > 0 ? 4 : 0) +
            (parsed.powerMod > 0 ? 2 : 0);
        }
      } else if (action.kind === 'SET') {
        score = 5;
      } else {
        continue; // CAST_REACT belongs to the reaction policy, not the Main Phase
      }
      if (!best || score > best.score) best = { card, kind: action.kind, score };
    }
  }
  return best && best.score > 0 ? best : null;
}

interface HandActionResult {
  state: GameState;
  logs: string[];
}

/** Applies one legal hand action with an exact, rule-compliant GEM payment. */
export function applyHandAction(
  state: GameState,
  aiPlayerId: string,
  handCard: CardInstance,
  kind: HandActionKind
): HandActionResult | null {
  const ai = state.players[aiPlayerId];
  if (!ai) return null;
  // The engine gate is re-checked here so the AI can never dispatch an illegal action.
  if (!deriveLegalHandActions(state, aiPlayerId, handCard).some(action => action.kind === kind)) return null;

  const requiredCost = getEffectiveCost(state, aiPlayerId, handCard);
  const requiresGemPayment = (handCard.card.type === 'Avatar' || handCard.card.type === 'Construct') && requiredCost > 0;
  let discardIds: string[] = [];
  if (requiresGemPayment) {
    const colorlessGemInstanceIds = getColorlessGemInstanceIds(state, aiPlayerId, ai.hand);
    const payment = selectGemPayment(ai.hand, handCard, requiredCost, colorlessGemInstanceIds);
    if (!payment) return null;
    const validation = validateGemPayment(ai.hand, handCard, payment, requiredCost, { colorlessGemInstanceIds });
    if (!validation.valid) return null;
    discardIds = payment;
  }
  const paidCost = requiredCost === 0 || discardIds.length > 0;
  const discardedCards = ai.hand.filter(card => discardIds.includes(card.instanceId));
  const remainingHand = ai.hand.filter(card =>
    card.instanceId !== handCard.instanceId && !discardIds.includes(card.instanceId));
  const paymentNote = discardedCards.length > 0
    ? ` (จ่าย Cost ${requiredCost} ด้วย GEM ${discardedCards.map(card => `"${card.card.name}"`).join(' + ')})`
    : '';
  const aiName = ai.name;

  if (handCard.card.type === 'Avatar' && kind === 'SUMMON') {
    const summoned: CardInstance = { ...handCard, isFaceUp: true, isRested: false };
    let nextState: GameState = {
      ...state,
      players: {
        ...state.players,
        [aiPlayerId]: {
          ...ai,
          hand: remainingHand,
          hell: [...ai.hell, ...discardedCards],
          avatarZone: [...ai.avatarZone, summoned]
        }
      }
    };
    nextState = recomputeContinuousAuras(nextState);
    const logs = [`${aiName} อัญเชิญ Avatar "${handCard.card.name}" (PWR ${handCard.card.power})${paymentNote}`];
    const parsed = parseCardAbility(handCard.card);
    const summonWindow = openReactionWindow(
      nextState,
      {
        type: 'AVATAR_SUMMONED',
        actorId: aiPlayerId,
        targetInstanceId: summoned.instanceId,
        targetCardName: summoned.card.name,
        sourceCardName: summoned.card.name
      },
      paidCost && parsed.hasJuti
        ? { type: 'SUMMON_JUTI', actorId: aiPlayerId, sourceCard: summoned, paidCost: true }
        : undefined
    );
    if (summonWindow !== nextState) {
      return { state: summonWindow, logs };
    }
    if (paidCost && parsed.hasJuti) {
      const result = executeCardAbility(
        nextState,
        aiPlayerId,
        summoned,
        'SUMMON_JUTI',
        parsed.needsTargetAvatar ? chooseAbilityTarget(nextState, aiPlayerId, parsed) : undefined
      );
      nextState = appendEventLog(result.state, result.logs, 'ABILITY', aiPlayerId);
      logs.push(...result.logs);
    }
    return { state: nextState, logs };
  }

  if (handCard.card.type === 'Construct' && kind === 'SET') {
    const movement = moveCardBetweenZones(state, {
      instanceId: handCard.instanceId,
      actorId: aiPlayerId,
      destination: 'constructZone',
      destinationPlayerId: aiPlayerId
    });
    if (!movement.ok) return null;
    const movedPlayer = movement.state.players[aiPlayerId];
    let nextState: GameState = {
      ...movement.state,
      players: {
        ...movement.state.players,
        [aiPlayerId]: { ...movedPlayer, hand: remainingHand, hell: [...ai.hell, ...discardedCards] }
      }
    };
    nextState = recomputeContinuousAuras(nextState);
    return {
      state: nextState,
      logs: [`${aiName} วาง Construct "${handCard.card.name}" ลงใน Construct Zone${paymentNote}`]
    };
  }

  if (handCard.card.type === 'Magic' && kind === 'CAST') {
    const subtype: MagicSubtype = effectiveMagicSubtype(handCard.card);
    const restriction = validateMagicPlay(state, aiPlayerId, subtype, false);
    if (restriction) return null;
    const parsed = parseCardAbility(handCard.card);
    const updatedAi = {
      ...ai,
      hand: remainingHand,
      hell: [...ai.hell, ...discardedCards],
      usedMagicTypesThisTurn: new Set<MagicSubtype>([...ai.usedMagicTypesThisTurn, subtype])
    };
    let nextState: GameState = { ...state, players: { ...state.players, [aiPlayerId]: updatedAi } };

    if (subtype === 'Land') {
      if (nextState.landMagicZone) {
        const prevOwner = nextState.players[nextState.landMagicZone.ownerId];
        if (prevOwner) {
          nextState = {
            ...nextState,
            players: {
              ...nextState.players,
              [prevOwner.id]: { ...prevOwner, hell: [...prevOwner.hell, nextState.landMagicZone] }
            }
          };
        }
      }
      const landInstance: CardInstance = { ...handCard, isFaceUp: true };
      nextState = { ...nextState, landMagicZone: landInstance };
      nextState = recomputeContinuousAuras(nextState);
      const result = executeCardAbility(nextState, aiPlayerId, landInstance, 'LAND_MAGIC');
      nextState = appendEventLog(nextState, [
        `${aiName} ร่าย Land Magic "${handCard.card.name}" ลงใน Land Magic Zone`,
        ...result.logs
      ], 'MAGIC_LAND', aiPlayerId);
      return { state: nextState, logs: [`ร่าย Land Magic "${handCard.card.name}"`, ...result.logs] };
    }

    if (subtype === 'Modification') {
      const target = [...updatedAi.avatarZone]
        .filter(avatar => checkModificationEquip(handCard.card, avatar.card).legal)
        .sort((a, b) => calculateNetPower(b) - calculateNetPower(a))[0];
      if (!target) return null;
      const updatedAvatars = updatedAi.avatarZone.map(avatar =>
        avatar.instanceId === target.instanceId
          ? { ...avatar, attachedInstances: [...(avatar.attachedInstances || []), handCard] }
          : avatar);
      nextState = {
        ...nextState,
        players: { ...nextState.players, [aiPlayerId]: { ...updatedAi, avatarZone: updatedAvatars } }
      };
      nextState = recomputeContinuousAuras(nextState);
      const logs = [`${aiName} สวมใส่ "${handCard.card.name}" ให้กับ "${target.card.name}"`];
      return { state: appendEventLog(nextState, logs, 'EQUIP', aiPlayerId), logs };
    }

    // Normal Magic (React timing is handled by the reaction policy instead).
    const targetId = parsed.needsTargetAvatar ? chooseAbilityTarget(state, aiPlayerId, parsed) : undefined;
    if (parsed.needsTargetAvatar && !targetId) return null;
    updatedAi.magicZone = [...updatedAi.magicZone, { ...handCard, isFaceUp: true }];
    nextState = { ...state, players: { ...state.players, [aiPlayerId]: updatedAi } };
    const magicWindow = openReactionWindow(
      nextState,
      {
        type: 'MAGIC_PLAYED',
        actorId: aiPlayerId,
        ...(targetId ? {
          targetInstanceId: targetId,
          targetCardName: state.playerOrder
            .map(id => state.players[id])
            .flatMap(player => player?.avatarZone ?? [])
            .find(avatar => avatar.instanceId === targetId)?.card.name
        } : {}),
        sourceCardName: handCard.card.name,
        sourceInstanceId: handCard.instanceId
      },
      { type: 'RESOLVE_MAGIC', actorId: aiPlayerId, sourceCard: handCard, targetAvatarId: targetId }
    );
    if (magicWindow !== nextState) {
      return { state: magicWindow, logs: [`${aiName} ร่าย "${handCard.card.name}" — เปิด Reaction Window ก่อนออกผล`] };
    }
    const result = executeCardAbility(nextState, aiPlayerId, handCard, 'MAGIC_CAST', targetId);
    nextState = appendEventLog(
      result.state,
      [`✨ ${aiName} ร่าย Magic "${handCard.card.name}"`, ...result.logs],
      'MAGIC',
      aiPlayerId
    );
    nextState = sendResolvedMagicToHell(nextState, aiPlayerId, handCard);
    return { state: nextState, logs: [`ร่าย Magic "${handCard.card.name}"`, ...result.logs] };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Turn-phase steps
// ---------------------------------------------------------------------------

function runAiDrawStep(state: GameState, aiPlayerId: string): AiStepOutcome {
  const ai = state.players[aiPlayerId];
  if (!ai) return { kind: 'WAITING', state, logs: [], reason: 'AI player not found' };
  const nextState = recomputeContinuousAuras(executeDrawPhase(state));
  const logs = [`${ai.name} จั่วการ์ดและเข้าสู่ Main Phase`];
  const deckOut = detectDeckOut(nextState);
  if (deckOut.winnerId) {
    return {
      kind: 'DONE',
      state: appendEventLog(deckOut.state, [...logs, `${ai.name} หมดเด็ค — จบเกม`], 'AI_TURN', aiPlayerId),
      logs,
      winnerId: deckOut.winnerId
    };
  }
  return { kind: 'APPLIED', state: appendEventLog(nextState, logs, 'AI_TURN', aiPlayerId), logs };
}

function advanceFromPhase(state: GameState, aiPlayerId: string, phase: 'MAIN' | 'BATTLE'): AiStepOutcome {
  const ai = state.players[aiPlayerId];
  if (!ai) return { kind: 'WAITING', state, logs: [], reason: 'AI player not found' };
  const nextPhase = phase === 'MAIN' ? nextPhaseAfterMain(state, aiPlayerId) : 'END';
  const reactionState = openReactionWindow(
    state,
    { type: 'BEFORE_PHASE_CHANGE', actorId: aiPlayerId },
    { type: 'ADVANCE_PHASE', actorId: aiPlayerId, nextPhase }
  );
  if (reactionState !== state) {
    return {
      kind: 'APPLIED',
      state: reactionState,
      logs: [`${ai.name} กำลังจะ${nextPhase === 'BATTLE' ? 'เข้าสู่ Battle Phase' : 'จบเทิร์น'} — เปิด Reaction Window`]
    };
  }
  return applyAiDeferredAction(state, { type: 'ADVANCE_PHASE', actorId: aiPlayerId, nextPhase }, aiPlayerId);
}

function runAiMainStep(state: GameState, aiPlayerId: string): AiStepOutcome {
  const choice = chooseMainPhaseAction(state, aiPlayerId);
  if (!choice) return advanceFromPhase(state, aiPlayerId, 'MAIN');
  const result = applyHandAction(state, aiPlayerId, choice.card, choice.kind);
  if (!result) return advanceFromPhase(state, aiPlayerId, 'MAIN');
  return { kind: 'APPLIED', state: result.state, logs: result.logs };
}

function runAiBattleStep(state: GameState, aiPlayerId: string): AiStepOutcome {
  const ai = state.players[aiPlayerId];
  if (!ai) return { kind: 'WAITING', state, logs: [], reason: 'AI player not found' };
  if (state.battleContext && !state.reactionWindow) {
    // A declared battle was interrupted before resolution; finish it.
    const result = resolveDeclaredBattle(state);
    if (result.ok) {
      return {
        kind: 'APPLIED',
        state: appendEventLog(result.state, result.events, 'COMBAT', aiPlayerId),
        logs: result.events
      };
    }
  }
  let best: { attacker: CardInstance; score: number } | null = null;
  for (const avatar of ai.avatarZone) {
    if (!deriveLegalAvatarActions(state, aiPlayerId, avatar).some(action => action.kind === 'DECLARE_ATTACK')) continue;
    const target = chooseCombatTarget(state, aiPlayerId, avatar);
    if (!target) continue;
    const score = target.targetInstanceId ? 20 : 12;
    if (!best || score > best.score) best = { attacker: avatar, score };
  }
  if (!best) return advanceFromPhase(state, aiPlayerId, 'BATTLE');
  const attackWindow = openReactionWindow(
    state,
    {
      type: 'ATTACK_DECLARED',
      actorId: aiPlayerId,
      targetInstanceId: best.attacker.instanceId,
      targetCardName: best.attacker.card.name,
      sourceCardName: best.attacker.card.name
    },
    { type: 'START_ATTACK', actorId: aiPlayerId, sourceCard: best.attacker }
  );
  if (attackWindow !== state) {
    return {
      kind: 'APPLIED',
      state: attackWindow,
      logs: [`${ai.name} ประกาศโจมตีด้วย "${best.attacker.card.name}" — เปิด Reaction Window`]
    };
  }
  return applyAiDeferredAction(state, { type: 'START_ATTACK', actorId: aiPlayerId, sourceCard: best.attacker }, aiPlayerId);
}

function runAiEndStep(state: GameState, aiPlayerId: string): AiStepOutcome {
  const ai = state.players[aiPlayerId];
  if (!ai) return { kind: 'WAITING', state, logs: [], reason: 'AI player not found' };
  if (ai.hand.length > 7) {
    const discardState = beginEndPhaseDiscard(state, aiPlayerId);
    if (!discardState.ok) {
      return { kind: 'WAITING', state, logs: [], reason: discardState.reason };
    }
    return {
      kind: 'APPLIED',
      state: discardState.state,
      logs: [`${ai.name} ต้องทิ้งการ์ด ${ai.hand.length - 7} ใบก่อนจบเทิร์น`]
    };
  }
  // END → DRAW passes the turn directly (the human path opens no window here).
  return applyAiDeferredAction(state, { type: 'ADVANCE_PHASE', actorId: aiPlayerId, nextPhase: 'DRAW' }, aiPlayerId);
}

// ---------------------------------------------------------------------------
// Step machine entry points
// ---------------------------------------------------------------------------

/** True when the AI owns the next decision in the current state. */
export function shouldAiAct(state: GameState, aiPlayerId: string): boolean {
  if (state.pendingEndPhaseDiscardPlayerId === aiPlayerId) return true;
  if (state.pendingDeckChoice?.authorizedViewerId === aiPlayerId) return true;
  if (state.pendingHellChoice?.authorizedViewerId === aiPlayerId) return true;
  if (state.pendingManualOverride && state.pendingManualOverride.actorId !== aiPlayerId) return true;
  if (state.pendingDeckSearchVerification?.verifierPlayerIds.includes(aiPlayerId)) return true;
  if (state.pendingExitPrevention?.preventionPlayerId === aiPlayerId &&
    !state.pendingExitPrevention.usedActivatedPrevention) return true;
  const window = state.reactionWindow;
  if (window && window.priorityPlayerId === aiPlayerId && !window.pendingReaction) return true;
  return state.playerOrder[state.currentTurnPlayerIndex] === aiPlayerId;
}

/**
 * Applies exactly one AI decision to the given state and returns the next state.
 * Deterministic and side-effect free: the React layer schedules the delays.
 */
export function runAiTurnStep(state: GameState, aiPlayerId: string): AiStepOutcome {
  const ai = state.players[aiPlayerId];
  if (!ai) return { kind: 'WAITING', state, logs: [], reason: 'AI player not found' };

  if (state.pendingEndPhaseDiscardPlayerId === aiPlayerId) {
    return resolveEndPhaseDiscardForAi(state, aiPlayerId);
  }
  if (state.pendingDeckChoice?.authorizedViewerId === aiPlayerId) {
    return resolveDeckChoiceForAi(state, aiPlayerId);
  }
  if (state.pendingHellChoice?.authorizedViewerId === aiPlayerId) {
    return resolveHellChoiceForAi(state, aiPlayerId);
  }
  if (state.pendingManualOverride && state.pendingManualOverride.actorId !== aiPlayerId) {
    return resolveManualOverrideForAi(state, aiPlayerId);
  }
  if (state.pendingDeckSearchVerification) {
    if (state.pendingDeckSearchVerification.verifierPlayerIds.includes(aiPlayerId)) {
      return resolveSearchVerificationForAi(state, aiPlayerId);
    }
    return { kind: 'WAITING', state, logs: [], reason: 'Deck Search verification is pending' };
  }
  if (state.pendingExitPrevention && state.pendingExitPrevention.preventionPlayerId !== aiPlayerId) {
    return { kind: 'WAITING', state, logs: [], reason: 'Exit-prevention choice is pending for the opponent' };
  }
  if (state.pendingExitPrevention?.preventionPlayerId === aiPlayerId &&
    !state.pendingExitPrevention.usedActivatedPrevention) {
    const pending = state.pendingExitPrevention;
    const result = declineExitPrevention(state, aiPlayerId, pending.expectedRevision);
    if (!result.ok) {
      return { kind: 'WAITING', state, logs: [], reason: result.reason };
    }
    const logs = [`${ai.name} ไม่ใช้การ์ดป้องกันการออกจากสนาม`];
    return { kind: 'APPLIED', state: appendEventLog(result.state, logs, 'REACTION', aiPlayerId), logs };
  }
  if (state.reactionWindow) {
    if (state.reactionWindow.priorityPlayerId !== aiPlayerId) {
      return { kind: 'WAITING', state, logs: [], reason: 'Reaction priority belongs to the opponent' };
    }
    return runAiReactionStep(state, aiPlayerId);
  }
  if (state.playerOrder[state.currentTurnPlayerIndex] !== aiPlayerId) {
    return { kind: 'WAITING', state, logs: [], reason: 'Not the AI turn' };
  }

  switch (state.currentPhase) {
    case 'DRAW':
      return runAiDrawStep(state, aiPlayerId);
    case 'MAIN':
      return runAiMainStep(state, aiPlayerId);
    case 'BATTLE':
      return runAiBattleStep(state, aiPlayerId);
    case 'END':
      return runAiEndStep(state, aiPlayerId);
  }
}
