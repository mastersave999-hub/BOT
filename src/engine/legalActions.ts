import type { CardInstance, GameState } from './types';
import { validateAvatarZone, validateMagicPlay, getEffectiveCost, getColorlessGemInstanceIds } from './gameRules';
import { canPayCost } from './gemPayment';
import { canUseNormalMagicAsReactOnOwnBattle, effectiveMagicSubtype } from './reactionEngine';
import { classifyCard } from './hybridMode';

/**
 * Phase 6: the single source of truth for which actions the game engine currently
 * authorizes for a hand card or an Avatar. The UI must render only the actions
 * returned here and must never derive legality on its own, so an action button can
 * only ever appear when the engine itself would accept the corresponding command.
 */

export type HandActionKind = 'SUMMON' | 'CAST' | 'SET' | 'CAST_REACT';

export interface LegalHandAction {
  kind: HandActionKind;
  label: string;
}

export type AvatarActionKind = 'DECLARE_ATTACK';

export interface LegalAvatarAction {
  kind: AvatarActionKind;
  label: string;
}

const HAND_ACTION_LABELS: Record<HandActionKind, string> = {
  SUMMON: 'อัญเชิญ (Summon)',
  CAST: 'ร่ายเวทย์ (Cast)',
  SET: 'ก่อสร้าง (Set)',
  CAST_REACT: 'ร่ายตอบโต้ (React Cast)'
};

const AVATAR_ACTION_LABELS: Record<AvatarActionKind, string> = {
  DECLARE_ATTACK: 'ประกาศโจมตี (Attack)'
};

function blockedByPendingChoice(state: GameState): boolean {
  return !!(
    state.pendingEndPhaseDiscardPlayerId ||
    state.pendingExitPrevention ||
    state.pendingDeckChoice ||
    state.pendingDeckSearchVerification ||
    state.pendingHellChoice ||
    state.pendingManualOverride ||
    state.reactionWindow
  );
}

function isNotActivePlayer(state: GameState, playerId: string): boolean {
  return state.playerOrder[state.currentTurnPlayerIndex] !== playerId;
}

/**
 * Returns every hand-card action the engine authorizes right now, in priority order.
 * An empty result means the engine allows nothing for this card in the current state.
 */
export function deriveLegalHandActions(
  state: GameState,
  playerId: string,
  handCard: CardInstance
): LegalHandAction[] {
  const player = state.players[playerId];
  if (!player) return [];
  if (!player.hand.some(card => card.instanceId === handCard.instanceId)) return [];
  if (isNotActivePlayer(state, playerId)) return [];
  if (blockedByPendingChoice(state)) return [];
  // Auto-Strict rooms only allow cards the engine resolves 100% automatically.
  if (state.ruleMode === 'AUTO_STRICT' && classifyCard(handCard.card).status !== 'VERIFIED_WORKING') return [];

  const inMainPhase = state.currentPhase === 'MAIN';
  const normalTreatedAsReact = canUseNormalMagicAsReactOnOwnBattle(state, playerId, handCard.card);

  if (handCard.card.type === 'Avatar') {
    if (inMainPhase && !validateAvatarZone({ avatarZone: [...player.avatarZone, handCard] })) {
      // The engine authorizes SUMMON only when the Cost Step can actually succeed,
      // using the effective Cost after continuous Land Magic auras (e.g. "สภาแบงค์").
      const effectiveCost = getEffectiveCost(state, playerId, handCard);
      const colorlessGemInstanceIds = getColorlessGemInstanceIds(state, playerId, player.hand);
      if (canPayCost(player.hand, handCard, effectiveCost, { colorlessGemInstanceIds })) {
        return [{ kind: 'SUMMON', label: HAND_ACTION_LABELS.SUMMON }];
      }
      return [];
    }
    return [];
  }

  if (handCard.card.type === 'Construct') {
    if (inMainPhase && player.constructZone.length < 3 &&
      !player.constructZone.some(card => card.card.name === handCard.card.name)) {
      const effectiveCost = getEffectiveCost(state, playerId, handCard);
      const colorlessGemInstanceIds = getColorlessGemInstanceIds(state, playerId, player.hand);
      if (canPayCost(player.hand, handCard, effectiveCost, { colorlessGemInstanceIds })) {
        return [{ kind: 'SET', label: HAND_ACTION_LABELS.SET }];
      }
      return [];
    }
    return [];
  }

  if (handCard.card.type === 'Magic') {
    // A Normal Magic converted to React timing by its own text takes priority.
    if (normalTreatedAsReact && !validateMagicPlay(state, playerId, 'React', true)) {
      return [{ kind: 'CAST_REACT', label: HAND_ACTION_LABELS.CAST_REACT }];
    }
    if (inMainPhase) {
      const subtype = effectiveMagicSubtype(handCard.card);
      if (!validateMagicPlay(state, playerId, subtype, false)) {
        return [{ kind: 'CAST', label: HAND_ACTION_LABELS.CAST }];
      }
    }
    return [];
  }

  return [];
}

/**
 * Returns every action the engine authorizes for an Avatar already on the field,
 * such as declaring an attack during the Battle Phase.
 */
export function deriveLegalAvatarActions(
  state: GameState,
  playerId: string,
  avatar: CardInstance
): LegalAvatarAction[] {
  const player = state.players[playerId];
  if (!player) return [];
  if (!player.avatarZone.some(card => card.instanceId === avatar.instanceId)) return [];
  if (isNotActivePlayer(state, playerId)) return [];
  if (state.currentPhase !== 'BATTLE') return [];
  if (blockedByPendingChoice(state)) return [];
  // AD_MUA first round: no player may attack until the last player of the round has taken a turn.
  if (state.mode === 'AD_MUA' && state.turnNumber < state.playerOrder.length) return [];
  if (avatar.isRested) return [];
  return [{ kind: 'DECLARE_ATTACK', label: AVATAR_ACTION_LABELS.DECLARE_ATTACK }];
}
