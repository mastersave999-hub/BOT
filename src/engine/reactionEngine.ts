import { executeCardAbility, parseCardAbility } from './abilityEngine';
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

const REACT_MAGIC_TIMING_TEXT = /โดยถือว่าเป็นการใช้\s*React Magic|ถือว่าเป็นการใช้\s*React Magic/;
const OPPONENT_TURN_TEXT = /เทิร์นฝ่ายตรงข้าม|เทิร์นอีกฝ่าย/;
const OWN_BATTLE_TEXT = /Battle Phase เรา|Battle Phase ของเรา/;

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
  const cancelsMagic = /ยกเลิกการใช้\s*Magic Card/.test(effect);
  const hasSupportedEffect = cancelsMagic || parsed.drawCount > 0 || parsed.powerMod !== 0 ||
    parsed.resetsPower || parsed.destroysTarget || parsed.destroysAllOpponentAvatars ||
    parsed.bouncesTarget || parsed.summonsFromHell || parsed.recoversFromHell > 0;
  if (!hasSupportedEffect) return false;
  if (/ยกเลิก(?!การใช้\s*Magic Card)|ป้องกัน|สอดแนม|ค้นหา|สุ่ม|เปลี่ยนสภาพ|สับ Deck|เตะไข่/.test(effect)) return false;
  if (/ทิ้ง\s*Avatar|ส่ง Avatar.*ลงนรก|เซ่นไหว้|นอน Avatar/.test(effect)) return false;
  if (/(?:หาก|ถ้า)/.test(effect) && !/(?:หาก|ถ้า)บน Avatar Zone ฝ่ายเรามี\s*["“][^"”]+["”]/.test(effect)) return false;
  return true;
}

export function isNormalMagicTreatedAsReact(card: Card): boolean {
  return card.type === 'Magic' && card.subtype === 'Normal' && REACT_MAGIC_TIMING_TEXT.test(card.mainEffect ?? '');
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
  return state.playerOrder.some(playerId => {
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
  const remainingReactUses = ownTurnUse
    ? player?.reactMagicBudget.ownTurnRemaining
    : player?.reactMagicBudget.opponentTurnRemaining;
  if (
    window.pendingReaction ||
    !player ||
    (remainingReactUses ?? 0) < 1 ||
    (ownTurnUse && player.usedMagicTypesThisTurn.has('React'))
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
  if (state.playerOrder.length > 2 || state.reactionWindow || !state.playerOrder.includes(trigger.actorId)) return state;
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
  if (ownTurnUse) updatedPlayer.usedMagicTypesThisTurn.add('React');
  const chainEntry: ReactionChainEntry = {
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

function resolveQueuedReaction(state: GameState, window: ReactionWindow, entry: ReactionChainEntry) {
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

  const cancelsPlayedMagic = /ยกเลิกการใช้\s*Magic Card/.test(entry.sourceCard.card.mainEffect ?? '');
  let nextState = state;
  let chain = [...(window.chain ?? [])];
  let pendingAction = window.pendingAction;
  if (cancelsPlayedMagic && entry.respondedTo.type === 'MAGIC_PLAYED' && entry.respondedTo.sourceInstanceId) {
    const chainIndex = chain.findIndex(item => item.sourceCard.instanceId === entry.respondedTo.sourceInstanceId);
    const canceledEntry = chain[chainIndex];
    if (chainIndex !== -1 && canceledEntry) {
      chain = chain.filter((_, index) => index !== chainIndex);
      nextState = sendResolvedMagicToHell(nextState, canceledEntry.playerId, canceledEntry.sourceCard);
    } else if (pendingAction?.type === 'RESOLVE_MAGIC' && pendingAction.sourceCard.instanceId === entry.respondedTo.sourceInstanceId) {
      nextState = sendResolvedMagicToHell(nextState, pendingAction.actorId, pendingAction.sourceCard);
      pendingAction = undefined;
    }
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
  if (isOwnTurnUse) usedMagicTypesThisTurn.add('React');
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

  const result = executeCardAbility(state, pendingReaction.playerId, pendingReaction.sourceCard, 'MAGIC_CAST', targetId);
  const cancelledOriginalMagic =
    window.pendingAction?.type === 'RESOLVE_MAGIC' &&
    /ยกเลิกการใช้\s*Magic Card/.test(pendingReaction.sourceCard.card.mainEffect ?? '');
  const { reactionWindow: _reactionWindow, ...closedState } = result.state;
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

  const resolved = resolveQueuedReaction(state, { ...window, chain }, top);
  const remainingChain = 'chain' in resolved ? resolved.chain : chain;
  const pendingAction = 'pendingAction' in resolved ? resolved.pendingAction : window.pendingAction;
  const logs = resolved.logs;
  if (remainingChain.length > 0) {
    const priorityOrder = rotatePriorityOrder(state, top.playerId);
    return {
      ok: true,
      resolvedCard: top.sourceCard.card.name,
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

  const shouldCancelOriginal = window.pendingAction?.type === 'RESOLVE_MAGIC' &&
    top.respondedTo.type === 'MAGIC_PLAYED' &&
    top.respondedTo.sourceInstanceId === window.pendingAction.sourceCard.instanceId &&
    /ยกเลิกการใช้\s*Magic Card/.test(top.sourceCard.card.mainEffect ?? '');
  const { reactionWindow: _reactionWindow, ...closedState } = resolved.state;
  return {
    ok: true,
    resolvedCard: top.sourceCard.card.name,
    logs,
    state: closedState,
    pendingAction: shouldCancelOriginal ? undefined : pendingAction
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
