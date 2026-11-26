import { executeCardAbility, getUnsupportedEffectReason, parseCardAbility } from './abilityEngine';
import { resolveEffectPlan } from './effectResolver';
import { canUseMagicTypeThisTurn, resolveExitPreventionChainEntry } from './gameRules';
import type {
  Card,
  CardInstance,
  DeferredReactionAction,
  GameState,
  ReactionChainEntry,
  ReactionTrigger,
  ReactionTriggerType,
  ReactionWindow
} from './types';
import { appendGameEvents } from './gameEvents';

const REACT_MAGIC_TIMING_TEXT = /โดยถือว่าเป็นการใช้\s*React Magic|ถือว่าเป็นการใช้\s*React Magic/;
const OPPONENT_TURN_TEXT = /เทิร์นฝ่ายตรงข้าม|เทิร์นอีกฝ่าย/;
const OWN_BATTLE_TEXT = /Battle Phase เรา|Battle Phase ของเรา/;

function isRuleTextProtected(card: Card): boolean {
  return !!card.ruleTextProtected || /#(?=\s|[ก-๙])/.test(card.mainEffect ?? '');
}

export interface ReactionEligibility {
  eligible: boolean;
  reason?: string;
  treatedAsReact: boolean;
}

function triggerMatchesCardText(card: Card, trigger: ReactionTrigger, playerId: string): boolean {
  const effect = card.mainEffect ?? '';
  const condition = effect.split(/[：:]/, 1)[0].trim();
  const normalized = condition.replace(/\s+/g, ' ');

  const specificType: ReactionTriggerType | null =
    /ประกาศโจมตี|สั่งโจมตี/.test(normalized)
      ? 'ATTACK_DECLARED'
      : /เป็นเป้าโจมตี|เป็นเป้าหมายการโจมตี/.test(normalized)
        ? 'AVATAR_TARGETED'
        : /ใช้\s*Magic Card|ใช้การ์ด\s*Magic/.test(normalized)
          ? 'MAGIC_PLAYED'
          : /ใช้ความสามารถ/.test(normalized)
            ? 'ABILITY_USED'
            : /Avatar.*(?:จะถูกทำลาย|ถูกทำลาย)|Avatar.*ทำลาย/.test(normalized)
              ? /จะถูกทำลาย/.test(normalized)
                ? 'AVATAR_WOULD_BE_DESTROYED'
                : 'AVATAR_DESTROYED'
              : /อัญเชิญ/.test(normalized) && /Avatar/.test(normalized)
                ? 'AVATAR_SUMMONED'
                : null;

  if (specificType === null) {
    // Only untimed React effects use the Rule Book's general response window; unknown explicit timings stay blocked.
    const hasExplicitActionTiming = /เมื่อ|อัตโนมัติ|ประกาศโจมตี|เป็นเป้าโจมตี|ใช้\s*Magic|ใช้ความสามารถ|ถูกทำลาย|อัญเชิญ/.test(normalized);
    if (hasExplicitActionTiming) return false;
    if (trigger.type === 'BEFORE_PHASE_CHANGE' && /ก่อนเปลี่ยน Phase|ก่อนเข้าสู่ Phase/i.test(normalized)) return true;
    return true;
  }
  if (specificType !== trigger.type) return false;
  if (/ฝ่ายตรงข้าม|อีกฝ่าย/.test(normalized) && trigger.actorId === playerId) return false;

  const namedAvatar = normalized.match(/Avatar\s*["“]([^"”]+)["”]/)?.[1];
  if (namedAvatar && trigger.targetCardName && !trigger.targetCardName.includes(namedAvatar)) {
    return false;
  }

  return true;
}

function hasRequiredBoardCondition(card: Card, state: GameState, playerId: string): boolean {
  const effect = card.mainEffect ?? '';
  const player = state.players[playerId];
  if (!player) return false;

  const requiredAvatar = effect.match(/(?:หาก|ถ้า)บน Avatar Zone ฝ่ายเรามี\s*["“]([^"”]+)["”]/)?.[1];
  if (requiredAvatar && !player.avatarZone.some(avatar => avatar.card.name.includes(requiredAvatar))) {
    return false;
  }

  const requiredSacrifice = effect.match(/ส่ง Avatar\s*["“]([^"”]+)["”].*?จาก Avatar Zone ฝ่ายเรา ลงนรก/);
  if (requiredSacrifice && !player.avatarZone.some(avatar => avatar.card.name.includes(requiredSacrifice[1]))) {
    return false;
  }

  if (effect.includes('ที่มีชื่อแตกต่างกับ Avatar ที่ส่งไป')) {
    const rickyOnField = player.avatarZone.filter(avatar => avatar.card.name.includes('ริกกี้'));
    const rickyInDeck = player.deck.some(
      avatar => avatar.card.type === 'Avatar' && avatar.card.name.includes('ริกกี้') &&
        rickyOnField.every(fieldAvatar => fieldAvatar.card.name !== avatar.card.name)
    );
    if (rickyOnField.length === 0 || !rickyInDeck) return false;
  }

  return true;
}

export function isReactionEffectExecutable(card: Card): boolean {
  const effect = card.mainEffect ?? '';
  const parsed = parseCardAbility(card);
  if (getUnsupportedEffectReason(card)) return false;
  const cancelsMagic = /ยกเลิกการใช้\s*Magic Card/.test(effect) || !!magicCancellationType(effect);
  const cancelsAbility = /ยกเลิก.*(?:ความสามารถ|Ability)/i.test(effect);
  const hasSupportedEffect = cancelsMagic || cancelsAbility || parsed.drawCount > 0 || parsed.powerMod !== 0 ||
    parsed.resetsPower || parsed.destroysTarget || parsed.destroysAllOpponentAvatars ||
    parsed.bouncesTarget || parsed.summonsFromHell || parsed.recoversFromHell > 0;
  if (!hasSupportedEffect) return false;
  if (/ยกเลิก(?!การใช้\s*(?:Magic Card|(?:Normal|Modification|React|Land)\s*Magic)|.*(?:ความสามารถ|Ability))|ป้องกัน|สอดแนม|ค้นหา|สุ่ม|เปลี่ยนสภาพ|สับ Deck|เตะไข่/.test(effect)) return false;
  if (/ทิ้ง\s*Avatar|ส่ง Avatar.*ลงนรก|เซ่นไหว้|นอน Avatar/.test(effect)) return false;
  if (/(?:หาก|ถ้า)/.test(effect) && !/(?:หาก|ถ้า)บน Avatar Zone ฝ่ายเรามี\s*["“][^"”]+["”]/.test(effect)) return false;
  return true;
}

export function effectiveMagicSubtype(card: Card): NonNullable<Card['subtype']> {
  const override = (card.mainEffect ?? '').match(/โดยถือว่าเป็นการใช้\s*(Normal|Modification|React|Land)\s*Magic/i)?.[1];
  const implicitReact = REACT_MAGIC_TIMING_TEXT.test(card.mainEffect ?? '') ? 'React' : undefined;
  return (override ?? implicitReact ?? card.subtype ?? 'Normal') as NonNullable<Card['subtype']>;
}

export function magicCancellationType(text: string): NonNullable<Card['subtype']> | undefined {
  const type = text.match(/ยกเลิกการใช้\s*(Normal|Modification|React|Land)\s*Magic/i)?.[1];
  return type as NonNullable<Card['subtype']> | undefined;
}

export function canCancelMagicCard(cancellationText: string, targetCard: Card): boolean {
  const type = magicCancellationType(cancellationText);
  if (targetCard.type !== 'Magic') return false;
  return type ? effectiveMagicSubtype(targetCard) === type : /ยกเลิกการใช้\s*Magic Card/i.test(cancellationText);
}

export function isNormalMagicTreatedAsReact(card: Card): boolean {
  return card.type === 'Magic' && card.subtype !== 'React' && effectiveMagicSubtype(card) === 'React';
}

export function canUseNormalMagicAsReactOnOwnBattle(state: GameState, playerId: string, card: Card): boolean {
  return isNormalMagicTreatedAsReact(card) &&
    state.playerOrder[state.currentTurnPlayerIndex] === playerId &&
    state.currentPhase === 'BATTLE' &&
    OWN_BATTLE_TEXT.test(card.mainEffect ?? '') &&
    hasRequiredBoardCondition(card, state, playerId) &&
    (state.players[playerId]?.reactMagicBudget.ownTurnRemaining ?? 0) > 0;
}

function getWindowPriorityOrder(state: GameState, window: ReactionWindow): string[] {
  if (window.priorityOrder?.length === state.playerOrder.length) return window.priorityOrder;
  const ownerIndex = state.playerOrder.indexOf(window.turnOwnerId);
  return [...state.playerOrder.slice(ownerIndex + 1), ...state.playerOrder.slice(0, ownerIndex + 1)];
}

function rotatePriorityOrder(state: GameState, playerId: string): string[] {
  const index = state.playerOrder.indexOf(playerId);
  return [...state.playerOrder.slice(index + 1), ...state.playerOrder.slice(0, index + 1)];
}

export function isReactionWindowStructurallyValid(state: GameState): boolean {
  if (state.playerOrder.length > 2) return false;
  const window = state.reactionWindow;
  if (!window || window.turnOwnerId !== state.playerOrder[state.currentTurnPlayerIndex]) return false;
  if (!state.playerOrder.includes(window.priorityPlayerId)) return false;
  if (window.passedPlayerIds.includes(window.priorityPlayerId)) return false;
  if (window.pendingReaction && window.pendingReaction.playerId !== window.priorityPlayerId) return false;
  const priorityOrder = getWindowPriorityOrder(state, window);
  if (priorityOrder.length !== state.playerOrder.length || new Set(priorityOrder).size !== state.playerOrder.length) return false;
  if (window.passedPlayerIds.length >= priorityOrder.length) return false;
  const expectedPassed = priorityOrder.slice(0, window.passedPlayerIds.length);
  const expectedPriority = priorityOrder[window.passedPlayerIds.length];
  const validPriority = window.priorityPlayerId === expectedPriority &&
    window.passedPlayerIds.every((playerId, index) => playerId === expectedPassed[index]);
  if (!validPriority) return false;
  if (window.passedPlayerIds.length > 0 || window.pendingReaction) return true;
  return (window.chain?.length ?? 0) > 0 || state.playerOrder.some(playerId => {
    const candidateWindow = { ...window, priorityPlayerId: playerId };
    return state.players[playerId]?.hand.some(({ card }) =>
      getReactionEligibility({ ...state, reactionWindow: candidateWindow }, playerId, card).eligible
    );
  });
}

export function getReactionEligibility(
  state: GameState,
  playerId: string,
  card: Card,
  trigger: ReactionTrigger | undefined = state.reactionWindow?.trigger
): ReactionEligibility {
  if (!trigger || !state.reactionWindow) {
    return { eligible: false, reason: 'No valid Reaction Window is open.', treatedAsReact: false };
  }

  const window = state.reactionWindow;
  if (window.priorityPlayerId !== playerId) {
    return { eligible: false, reason: 'Priority belongs to another player.', treatedAsReact: false };
  }
  const player = state.players[playerId];
  const ownTurnUse = window.turnOwnerId === playerId;
  if (
    window.pendingReaction ||
    !player ||
    !canUseMagicTypeThisTurn(player, 'React')
  ) {
    return { eligible: false, reason: 'React Magic is unavailable at this time.', treatedAsReact: false };
  }

  const isPrintedReact = card.type === 'Magic' && card.subtype === 'React';
  const treatedAsReact = isNormalMagicTreatedAsReact(card);
  if (!isPrintedReact && !treatedAsReact) {
    return { eligible: false, reason: 'This card is not a React Magic.', treatedAsReact: false };
  }
  if (!isReactionEffectExecutable(card)) {
    return { eligible: false, reason: 'This card effect is not implemented; the engine blocks unsupported effects rather than resolving them incorrectly.', treatedAsReact };
  }

  if (treatedAsReact) {
    const effect = card.mainEffect ?? '';
    const activePlayerId = state.playerOrder[state.currentTurnPlayerIndex];
    const hasOpponentTiming = OPPONENT_TURN_TEXT.test(effect) && activePlayerId !== playerId;
    const hasOwnBattleTiming = OWN_BATTLE_TEXT.test(effect) && activePlayerId === playerId && state.currentPhase === 'BATTLE';
    if (!hasOpponentTiming && !hasOwnBattleTiming) {
      return { eligible: false, reason: 'The card text does not allow this timing.', treatedAsReact: true };
    }
    if (!hasRequiredBoardCondition(card, state, playerId)) {
      return { eligible: false, reason: 'A card-specific condition is not satisfied.', treatedAsReact: true };
    }
    return { eligible: true, treatedAsReact: true };
  }

  if (!triggerMatchesCardText(card, trigger, playerId)) {
    return { eligible: false, reason: 'This card text does not match the pending action.', treatedAsReact: false };
  }

  if (!hasRequiredBoardCondition(card, state, playerId)) {
    return { eligible: false, reason: 'A card-specific condition is not satisfied.', treatedAsReact: false };
  }

  return { eligible: true, treatedAsReact: false };
}

function nextEligiblePriority(state: GameState, window: ReactionWindow): string | null {
  const order = state.playerOrder;
  const currentIndex = order.indexOf(window.priorityPlayerId);
  for (let offset = 1; offset <= order.length; offset += 1) {
    const candidateId = order[(currentIndex + offset) % order.length];
    if (candidateId && !window.passedPlayerIds.includes(candidateId)) return candidateId;
  }
  return null;
}

export function openReactionWindow(
  state: GameState,
  trigger: ReactionTrigger,
  pendingAction?: ReactionWindow['pendingAction']
): GameState {
  // Rule Book 3.2 p.18 defines priority for Duel only; do not invent a 3–4 player order.
  if (state.playerOrder.length > 2 || state.reactionWindow || state.pendingDeckChoice || state.pendingHellChoice || state.pendingDeckSearchVerification || state.pendingEndPhaseDiscardPlayerId || !state.playerOrder.includes(trigger.actorId)) return state;
  const turnOwnerId = state.playerOrder[state.currentTurnPlayerIndex];
  if (!turnOwnerId || turnOwnerId !== trigger.actorId) return state;

  const ownerIndex = state.playerOrder.indexOf(turnOwnerId);
  const opponentPriorityOrder = [
    ...state.playerOrder.slice(ownerIndex + 1),
    ...state.playerOrder.slice(0, ownerIndex)
  ];
  const priorityPlayerId = opponentPriorityOrder[0];
  if (!priorityPlayerId) return state;

  const nextSequence = (state.reactionSequence ?? 0) + 1;
  const provisional: ReactionWindow = {
    id: `${state.id}:${nextSequence}:${trigger.type}`,
    trigger,
    turnOwnerId,
    priorityPlayerId,
    passedPlayerIds: [],
    priorityOrder: [...opponentPriorityOrder, turnOwnerId],
    chain: [],
    revision: 0,
    pendingAction
  };
  const candidateExists = state.playerOrder.some(playerId => {
      const candidateWindow = { ...provisional, priorityPlayerId: playerId };
      return state.players[playerId]?.hand.some(({ card }) =>
        getReactionEligibility({ ...state, reactionWindow: candidateWindow }, playerId, card).eligible
      );
    });
  if (!candidateExists) return state;

  return { ...state, reactionSequence: nextSequence, reactionWindow: provisional };
}

// Rule Book 3.2 pp.12,18: responses enter a LIFO chain and priority restarts with the turn player's opponent.
export function queueReactionCard(
  state: GameState,
  playerId: string,
  cardInstanceId: string,
  targetAvatarId?: string
): { ok: false; state: GameState; reason: string } | { ok: true; state: GameState } {
  const window = state.reactionWindow;
  if (!window || !isReactionWindowStructurallyValid(state)) {
    return { ok: false, state, reason: 'No valid Reaction Window is open.' };
  }
  if (window.pendingReaction) return { ok: false, state, reason: 'A reaction card is already being resolved.' };
  const player = state.players[playerId];
  const sourceCard = player?.hand.find(card => card.instanceId === cardInstanceId);
  if (!player || !sourceCard) return { ok: false, state, reason: 'The selected card is not in your hand.' };
  const eligibility = getReactionEligibility(state, playerId, sourceCard.card);
  if (!eligibility.eligible) return { ok: false, state, reason: eligibility.reason ?? 'This card is not eligible.' };

  const parsed = parseCardAbility(sourceCard.card);
  const requiresAvatarTarget = parsed.needsTargetAvatar || parsed.destroysTarget || parsed.bouncesTarget || parsed.resetsPower || parsed.powerMod !== 0;
  const selectedTargetId = parsed.needsTargetAvatar ? targetAvatarId : targetAvatarId ?? window.trigger.targetInstanceId;
  if (requiresAvatarTarget && !selectedTargetId) {
    return { ok: false, state, reason: 'This React Magic requires a legal target.' };
  }
  if (selectedTargetId && requiresAvatarTarget) {
    const targetOwnerId = state.playerOrder.find(id =>
      state.players[id]?.avatarZone.some(avatar => avatar.instanceId === selectedTargetId)
    );
    if (!targetOwnerId) return { ok: false, state, reason: 'The selected Avatar is not on the field.' };
    if (parsed.targetScope === 'OWN_AVATAR' && targetOwnerId !== playerId) {
      return { ok: false, state, reason: 'The selected Avatar must be controlled by the reacting player.' };
    }
    if (parsed.targetScope === 'OPPONENT_AVATAR' && targetOwnerId === playerId) {
      return { ok: false, state, reason: 'The selected Avatar must be controlled by an opponent.' };
    }
  }

  const ownTurnUse = window.turnOwnerId === playerId;
  const updatedPlayer = {
    ...player,
    hand: player.hand.filter(card => card.instanceId !== cardInstanceId),
    magicZone: [...player.magicZone, { ...sourceCard, isFaceUp: true }],
    reactMagicBudget: {
      ...player.reactMagicBudget,
      ownTurnRemaining: Math.max(0, player.reactMagicBudget.ownTurnRemaining - Number(ownTurnUse)),
      opponentTurnRemaining: Math.max(0, player.reactMagicBudget.opponentTurnRemaining - Number(!ownTurnUse))
    },
    usedMagicTypesThisTurn: new Set(player.usedMagicTypesThisTurn)
  };
  updatedPlayer.usedMagicTypesThisTurn.add('React');
  const chainEntry: ReactionChainEntry = {
    entryType: 'REACT_MAGIC',
    playerId,
    sourceCard,
    treatedAsReact: eligibility.treatedAsReact,
    targetAvatarId: selectedTargetId,
    respondedTo: window.trigger
  };
  const priorityOrder = rotatePriorityOrder(state, playerId);
  return {
    ok: true,
    state: {
      ...state,
      players: { ...state.players, [playerId]: updatedPlayer },
      reactionWindow: {
        ...window,
        trigger: {
          type: 'MAGIC_PLAYED',
          actorId: playerId,
          sourceCardName: sourceCard.card.name,
          sourceInstanceId: sourceCard.instanceId
        },
        priorityOrder,
        priorityPlayerId: priorityOrder[0],
        passedPlayerIds: [],
        chain: [...(window.chain ?? []), chainEntry],
        revision: (window.revision ?? 0) + 1
      }
    }
  };
}

export type ReactionPassResult =
  | { ok: false; state: GameState; reason: string }
  | { ok: true; state: GameState; pendingAction?: ReactionWindow['pendingAction']; logs?: string[]; resolvedCard?: string };

function sendResolvedMagicToHell(state: GameState, playerId: string, instance: CardInstance): GameState {
  const player = state.players[playerId];
  if (!player) return state;
  return {
    ...state,
    players: {
      ...state.players,
      [playerId]: {
        ...player,
        magicZone: player.magicZone.filter(card => card.instanceId !== instance.instanceId),
        hell: player.hell.some(card => card.instanceId === instance.instanceId)
          ? player.hell
          : [...player.hell, instance]
      }
    }
  };
}

export type CancellationTargetKind = 'MAGIC_PLAY' | 'ABILITY' | 'CHAIN_ENTRY';

function applyCancellation(
  state: GameState,
  actorId: string,
  targetInstanceId: string,
  targetKind: CancellationTargetKind
): { state: GameState; applied: boolean } {
  const window = state.reactionWindow;
  if (!window) return { state, applied: false };
  const chain = [...(window.chain ?? [])];
  let nextState = state;
  let pendingAction = window.pendingAction;
  let applied = false;
  if (targetKind === 'CHAIN_ENTRY') {
    const index = chain.findIndex(entry => entry.entryType === 'TRIGGER_ABILITY' || entry.entryType === 'ACTIVATED_ABILITY'
      ? entry.sourceCardId === targetInstanceId || entry.triggerId === targetInstanceId
      : entry.sourceCard.instanceId === targetInstanceId);
    const entry = chain[index];
    if (!entry) return { state, applied: false };
    if (entry.entryType === 'TRIGGER_ABILITY' || entry.entryType === 'ACTIVATED_ABILITY') {
      chain[index] = { ...entry, cancelled: true };
    } else {
      if (isRuleTextProtected(entry.sourceCard.card)) return { state, applied: false };
      chain.splice(index, 1);
      nextState = sendResolvedMagicToHell(nextState, entry.playerId, entry.sourceCard);
    }
    applied = true;
  } else if (pendingAction && 'sourceCard' in pendingAction && pendingAction.sourceCard.instanceId === targetInstanceId && !isRuleTextProtected(pendingAction.sourceCard.card)) {
    if (targetKind === 'MAGIC_PLAY' && pendingAction.type === 'RESOLVE_MAGIC') {
      nextState = sendResolvedMagicToHell(nextState, pendingAction.actorId, pendingAction.sourceCard);
      pendingAction = undefined;
      applied = true;
    } else if (targetKind === 'ABILITY' && pendingAction.type !== 'RESOLVE_MAGIC') {
      pendingAction = undefined;
      applied = true;
    }
  }
  if (!applied) return { state, applied: false };
  const eventId = `${state.id}:${state.gameEvents?.length ?? 0}:cancel:${targetKind}:${targetInstanceId}:${actorId}`;
  nextState = appendGameEvents({
    ...nextState,
    reactionWindow: { ...window, chain, pendingAction, revision: (window.revision ?? 0) + 1 }
  }, [{ type: 'ACTION_CANCELLED', actorId, targetInstanceId, targetKind, eventId }]);
  return { state: nextState, applied: true };
}

/** Cancels only an unresolved action/chain entry inside an open Reaction Window. */
export function cancelReactionTarget(
  state: GameState,
  actorId: string,
  target: { kind: CancellationTargetKind; instanceId: string }
): { ok: true; state: GameState } | { ok: false; state: GameState; reason: string } {
  const window = state.reactionWindow;
  if (!window || window.priorityPlayerId !== actorId || window.pendingReaction) {
    return { ok: false, state, reason: 'Cancellation requires priority in an open Reaction Window.' };
  }
  const result = applyCancellation(state, actorId, target.instanceId, target.kind);
  return result.applied
    ? { ok: true, state: result.state }
    : { ok: false, state, reason: 'The selected action or chain entry is no longer pending.' };
}

function resolveQueuedReaction(state: GameState, window: ReactionWindow, entry: ReactionChainEntry) {
  if (entry.entryType === 'ACTIVATED_ABILITY' && entry.exitPreventionTargetId) {
    const result = resolveExitPreventionChainEntry(state, entry.exitPreventionTargetId, !entry.cancelled);
    return { state: result.state, logs: [entry.cancelled
      ? `${entry.triggerId}: prevention cancelled; field exit resumed`
      : `${entry.triggerId}: prevention resolved; field exit prevented`] };
  }
  if (entry.entryType === 'TRIGGER_ABILITY' || entry.entryType === 'ACTIVATED_ABILITY') {
    if (entry.cancelled) return { state, logs: [`${entry.triggerId}: trigger cancelled`] };
    const conditions = entry.entryType === 'TRIGGER_ABILITY' ? entry.conditions : undefined;
    const resolved = resolveEffectPlan(state, {
      actorId: entry.controllerId, ...(conditions?.length ? { conditions } : {}),
      ...(entry.entryType === 'TRIGGER_ABILITY' && entry.costs?.length ? { costs: entry.costs } : {}), effects: entry.effects
    });
    if (!resolved.ok) return { state, logs: [`${entry.triggerId}: trigger failed and was rolled back (${resolved.reason ?? 'invalid effect'})`] };
    return { state: resolved.state, logs: [`${entry.triggerId}: trigger resolved`] };
  }
  const parsed = parseCardAbility(entry.sourceCard.card);
  const requiresAvatarTarget = parsed.needsTargetAvatar || parsed.destroysTarget || parsed.bouncesTarget || parsed.resetsPower || parsed.powerMod !== 0;
  const targetOwnerId = entry.targetAvatarId
    ? state.playerOrder.find(id => state.players[id]?.avatarZone.some(avatar => avatar.instanceId === entry.targetAvatarId))
    : undefined;
  const targetIsLegal = !requiresAvatarTarget || (!!targetOwnerId &&
    (parsed.targetScope !== 'OWN_AVATAR' || targetOwnerId === entry.playerId) &&
    (parsed.targetScope !== 'OPPONENT_AVATAR' || targetOwnerId !== entry.playerId));
  if (!targetIsLegal) {
    return {
      state: sendResolvedMagicToHell(state, entry.playerId, entry.sourceCard),
      logs: [`${entry.sourceCard.card.name}: เป้าหมายไม่ถูกต้องหรือไม่อยู่บนสนาม ผลทั้งหมดจึงไม่ทำงาน`]
    };
  }

  const cancelsPlayedMagic = /ยกเลิกการใช้\s*Magic Card/.test(entry.sourceCard.card.mainEffect ?? '') || !!magicCancellationType(entry.sourceCard.card.mainEffect ?? '');
  const cancelsAbility = /ยกเลิก.*(?:ความสามารถ|Ability)/i.test(entry.sourceCard.card.mainEffect ?? '');
  let nextState = state;
  let chain = [...(window.chain ?? [])];
  let pendingAction = window.pendingAction;
  let canceledTarget: { instanceId: string; kind: CancellationTargetKind } | undefined;
  if (cancelsAbility) {
    const requestedTarget = entry.respondedTo.targetInstanceId;
    const index = chain.findIndex(item =>
      (item.entryType === 'TRIGGER_ABILITY' || item.entryType === 'ACTIVATED_ABILITY') &&
      (item.sourceCardId === requestedTarget || item.triggerId === requestedTarget)
    );
    const targetIndex = index >= 0 ? index : chain.findLastIndex(item =>
      item.entryType === 'TRIGGER_ABILITY' || item.entryType === 'ACTIVATED_ABILITY'
    );
    const target = chain[targetIndex];
    if (target && (target.entryType === 'TRIGGER_ABILITY' || target.entryType === 'ACTIVATED_ABILITY')) {
      chain[targetIndex] = { ...target, cancelled: true };
      canceledTarget = { instanceId: target.sourceCardId, kind: 'CHAIN_ENTRY' };
    }
  }
  if (cancelsPlayedMagic && entry.respondedTo.type === 'MAGIC_PLAYED' && entry.respondedTo.sourceInstanceId) {
    const targetId = entry.respondedTo.sourceInstanceId;
    const chainIndex = chain.findIndex(item => item.entryType === 'REACT_MAGIC' && item.sourceCard.instanceId === targetId &&
      canCancelMagicCard(entry.sourceCard.card.mainEffect ?? '', item.sourceCard.card));
    const canceledEntry = chain[chainIndex];
    if (canceledEntry?.entryType === 'REACT_MAGIC' && !isRuleTextProtected(canceledEntry.sourceCard.card)) {
      chain = chain.filter((_, index) => index !== chainIndex);
      nextState = sendResolvedMagicToHell(nextState, canceledEntry.playerId, canceledEntry.sourceCard);
      canceledTarget = { instanceId: targetId, kind: 'CHAIN_ENTRY' };
    } else if (pendingAction?.type === 'RESOLVE_MAGIC' && pendingAction.sourceCard.instanceId === targetId &&
      canCancelMagicCard(entry.sourceCard.card.mainEffect ?? '', pendingAction.sourceCard.card) && !isRuleTextProtected(pendingAction.sourceCard.card)) {
      nextState = sendResolvedMagicToHell(nextState, pendingAction.actorId, pendingAction.sourceCard);
      pendingAction = undefined;
      canceledTarget = { instanceId: targetId, kind: 'MAGIC_PLAY' };
    }
  }

  if (cancelsPlayedMagic || cancelsAbility) {
    if (canceledTarget) {
      const eventId = `${state.id}:${state.gameEvents?.length ?? 0}:cancel:${canceledTarget.kind}:${canceledTarget.instanceId}:${entry.playerId}`;
      nextState = appendGameEvents(nextState, [{
        type: 'ACTION_CANCELLED', actorId: entry.playerId, targetInstanceId: canceledTarget.instanceId,
        targetKind: canceledTarget.kind, eventId
      }]);
    }
    return {
      state: sendResolvedMagicToHell(nextState, entry.playerId, entry.sourceCard),
      logs: [`${entry.sourceCard.card.name}: ยกเลิกผลของ Magic ที่ระบุ`],
      chain,
      pendingAction
    };
  }

  const result = executeCardAbility(nextState, entry.playerId, entry.sourceCard, 'MAGIC_CAST', entry.targetAvatarId);
  return {
    state: sendResolvedMagicToHell(result.state, entry.playerId, entry.sourceCard),
    logs: result.logs,
    chain,
    pendingAction
  };
}

export function beginReactionCard(
  state: GameState,
  playerId: string,
  cardInstanceId: string
): { ok: false; state: GameState; reason: string } | { ok: true; state: GameState } {
  const window = state.reactionWindow;
  if (!window) return { ok: false, state, reason: 'No valid Reaction Window is open.' };
  if (window.priorityPlayerId !== playerId) {
    return { ok: false, state, reason: 'Priority belongs to another player.' };
  }
  if (window.pendingReaction) {
    return { ok: false, state, reason: 'A reaction card is already being resolved.' };
  }

  const player = state.players[playerId];
  const sourceCard = player?.hand.find(card => card.instanceId === cardInstanceId);
  if (!player || !sourceCard) return { ok: false, state, reason: 'The selected card is not in your hand.' };
  const eligibility = getReactionEligibility(state, playerId, sourceCard.card);
  if (!eligibility.eligible) return { ok: false, state, reason: eligibility.reason ?? 'This card is not eligible.' };

  const isOwnTurnUse = window.turnOwnerId === playerId;
  const reactMagicBudget = {
    ...player.reactMagicBudget,
    ownTurnRemaining: Math.max(0, player.reactMagicBudget.ownTurnRemaining - Number(isOwnTurnUse)),
    opponentTurnRemaining: Math.max(0, player.reactMagicBudget.opponentTurnRemaining - Number(!isOwnTurnUse))
  };
  const usedMagicTypesThisTurn = new Set(player.usedMagicTypesThisTurn);
  usedMagicTypesThisTurn.add('React');
  const updatedPlayer = {
    ...player,
    hand: player.hand.filter(card => card.instanceId !== cardInstanceId),
    magicZone: [...player.magicZone, { ...sourceCard, isFaceUp: true }],
    reactMagicBudget,
    usedMagicTypesThisTurn
  };
  return {
    ok: true,
    state: {
      ...state,
      players: { ...state.players, [playerId]: updatedPlayer },
      reactionWindow: {
        ...window,
        pendingReaction: { playerId, sourceCard, treatedAsReact: eligibility.treatedAsReact }
      }
    }
  };
}

export function resolveReactionCard(
  state: GameState,
  targetAvatarId?: string
): { ok: false; state: GameState; reason: string } | { ok: true; state: GameState; logs: string[]; pendingAction?: DeferredReactionAction } {
  const window = state.reactionWindow;
  const pendingReaction = window?.pendingReaction;
  if (!window || !pendingReaction) return { ok: false, state, reason: 'No reaction card is awaiting resolution.' };

  const parsed = parseCardAbility(pendingReaction.sourceCard.card);
  const targetId = targetAvatarId ?? window.trigger.targetInstanceId;
  if (parsed.needsTargetAvatar && !targetId) {
    return { ok: false, state, reason: 'This React Magic requires a legal target.' };
  }
  if (parsed.needsTargetAvatar && targetId) {
    const targetOwnerId = state.playerOrder.find(id =>
      state.players[id]?.avatarZone.some(avatar => avatar.instanceId === targetId)
    );
    if (!targetOwnerId) return { ok: false, state, reason: 'The selected Avatar is no longer on the field.' };
    if (parsed.targetScope === 'OWN_AVATAR' && targetOwnerId !== pendingReaction.playerId) {
      return { ok: false, state, reason: 'The selected Avatar must be controlled by the reacting player.' };
    }
    if (parsed.targetScope === 'OPPONENT_AVATAR' && targetOwnerId === pendingReaction.playerId) {
      return { ok: false, state, reason: 'The selected Avatar must be controlled by an opponent.' };
    }
  }

  const cancelledOriginalMagic = window.pendingAction?.type === 'RESOLVE_MAGIC' &&
    !isRuleTextProtected(window.pendingAction.sourceCard.card) &&
    canCancelMagicCard(pendingReaction.sourceCard.card.mainEffect ?? '', window.pendingAction.sourceCard.card);
  const result = cancelledOriginalMagic
    ? { state, logs: [`${pendingReaction.sourceCard.card.name}: ยกเลิกผลของ Magic ที่ระบุ`] }
    : executeCardAbility(state, pendingReaction.playerId, pendingReaction.sourceCard, 'MAGIC_CAST', targetId);
  let staged = result.state;
  if (cancelledOriginalMagic && window.pendingAction?.type === 'RESOLVE_MAGIC') {
    const canceled = window.pendingAction.sourceCard;
    staged = sendResolvedMagicToHell(staged, window.pendingAction.actorId, canceled);
    staged = appendGameEvents(staged, [{
      type: 'ACTION_CANCELLED', actorId: pendingReaction.playerId, targetInstanceId: canceled.instanceId,
      targetKind: 'MAGIC_PLAY', eventId: `${state.id}:${state.gameEvents?.length ?? 0}:cancel:MAGIC_PLAY:${canceled.instanceId}:${pendingReaction.playerId}`
    }]);
  }
  const resolvedState = sendResolvedMagicToHell(staged, pendingReaction.playerId, pendingReaction.sourceCard);
  const { reactionWindow: _reactionWindow, ...closedState } = resolvedState;
  return {
    ok: true,
    state: closedState,
    logs: result.logs,
    pendingAction: cancelledOriginalMagic ? undefined : window.pendingAction
  };
}

export function passReactionPriority(state: GameState, playerId: string): ReactionPassResult {
  const window = state.reactionWindow;
  if (!window) return { ok: false, state, reason: 'No valid Reaction Window is open.' };
  if (window.priorityPlayerId !== playerId) {
    return { ok: false, state, reason: 'Priority belongs to another player.' };
  }
  if (window.pendingReaction) {
    return { ok: false, state, reason: 'Resolve the selected reaction card before passing.' };
  }

  const passedPlayerIds = [...window.passedPlayerIds, playerId];
  const nextPlayerId = nextEligiblePriority(state, { ...window, passedPlayerIds });
  if (nextPlayerId) {
    return {
      ok: true,
      state: {
        ...state,
        reactionWindow: { ...window, priorityPlayerId: nextPlayerId, passedPlayerIds, revision: (window.revision ?? 0) + 1 }
      }
    };
  }

  const chain = [...(window.chain ?? [])];
  const top = chain.pop();
  if (!top) {
    const { reactionWindow: _reactionWindow, ...closedState } = state;
    return { ok: true, state: closedState, pendingAction: window.pendingAction };
  }

  const resolutionState = { ...state, reactionWindow: { ...window, chain } };
  const resolved = resolveQueuedReaction(resolutionState, { ...window, chain }, top);
  const returnedChain = resolved.state.reactionWindow?.chain ?? chain;
  const baseChain = 'chain' in resolved ? resolved.chain : chain;
  const additions = returnedChain.filter(candidate => !chain.some(item =>
    item.entryType === candidate.entryType && (item.entryType === 'REACT_MAGIC'
      ? candidate.entryType === 'REACT_MAGIC' && item.sourceCard.instanceId === candidate.sourceCard.instanceId
      : candidate.entryType !== 'REACT_MAGIC' && item.triggerId === candidate.triggerId)
  ));
  const remainingChain = [...baseChain, ...additions];
  const pendingAction = 'pendingAction' in resolved ? resolved.pendingAction : window.pendingAction;
  const logs = resolved.logs;
  if (remainingChain.length > 0) {
    const resolverId = top.entryType === 'REACT_MAGIC' ? top.playerId : top.controllerId;
    const priorityOrder = rotatePriorityOrder(state, resolverId);
    return {
      ok: true,
      ...(top.entryType === 'REACT_MAGIC' ? { resolvedCard: top.sourceCard.card.name } : {}),
      logs,
      state: {
        ...resolved.state,
        reactionWindow: {
          ...window,
          trigger: top.respondedTo,
          priorityOrder,
          priorityPlayerId: priorityOrder[0],
          passedPlayerIds: [],
          chain: remainingChain,
          revision: (window.revision ?? 0) + 1
        }
      }
    };
  }

  const { reactionWindow: _reactionWindow, ...closedState } = resolved.state;
  return {
    ok: true,
    ...(top.entryType === 'REACT_MAGIC' ? { resolvedCard: top.sourceCard.card.name } : {}),
    logs,
    state: closedState,
    pendingAction
  };
}

export function closeReactionWindowAfterResponse(state: GameState): GameState {
  if (!state.reactionWindow) return state;
  const { reactionWindow: _reactionWindow, ...closedState } = state;
  return closedState;
}

export function getEligibleReactionCards(state: GameState, playerId: string) {
  const player = state.players[playerId];
  if (!player || !state.reactionWindow) return [];
  return player.hand.filter(({ card }) => getReactionEligibility(state, playerId, card).eligible);
}
