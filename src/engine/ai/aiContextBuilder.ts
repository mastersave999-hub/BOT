import type { Card, CardInstance, GameState } from '../types';
import { redactLifeCardsForViewer } from '../multiplayer';
import { parseCardAbility } from '../abilityEngine';
import { calculateNetPower } from '../layers';
import { classifyCard } from '../hybridMode';
import { deriveLegalAvatarActions, deriveLegalHandActions } from '../legalActions';
import { getEligibleReactionCards } from '../reactionEngine';

/**
 * Phase C of the Hybrid AI Opponent plan: builds the exact, redacted context and
 * enumerated legal actions a Gemini decision route (PR 2) will consume.
 *
 * Anti-cheat guarantee: every zone summary is derived from
 * `redactLifeCardsForViewer(state, aiPlayerId)`, so opponent hidden hand cards,
 * face-down opponent LIFE cards and opponent deck order can never leak into the
 * payload — the redaction layer replaces those identities before summarizing.
 */

export type AiActionKind =
  | 'SUMMON'
  | 'CAST'
  | 'SET'
  | 'CAST_REACT'
  | 'DECLARE_ATTACK'
  | 'DECK_CHOICE'
  | 'HELL_CHOICE'
  | 'DISCARD'
  | 'PASS';

export interface AiCardFlags {
  hasJuti: boolean;
  hasOnAttack: boolean;
  hasHumanShield: boolean;
  hasGrit: boolean;
  hasEggKick: boolean;
  hasBackstab: boolean;
  needsTargetAvatar: boolean;
  targetScope: string;
  drawCount: number;
  powerMod: number;
  destroysTarget: boolean;
  bouncesTarget: boolean;
  summonsFromHell: boolean;
  recoversFromHell: number;
}

export interface AiCardSummary {
  instanceId: string;
  name: string;
  type: Card['type'];
  subtype?: string;
  cost: number;
  gem: number;
  gemColor?: string | null;
  color: string;
  power: number;
  symbol?: string | null;
  isRested?: boolean;
  netPower?: number;
  classification: string;
  mainEffect: string;
  flags: AiCardFlags;
}

export interface AiActionOption {
  actionId: string;
  kind: AiActionKind;
  cardInstanceId?: string;
  cardName?: string;
  targetHint?: string;
  summary: string;
}

export interface AiContext {
  aiPlayerId: string;
  activePlayerId: string;
  turnNumber: number;
  roundNumber: number;
  phase: GameState['currentPhase'];
  mode: GameState['mode'];
  ruleMode: string;
  ai: {
    name: string;
    isCritical: boolean;
    hand: AiCardSummary[];
    avatarZone: AiCardSummary[];
    constructZone: AiCardSummary[];
    magicZone: AiCardSummary[];
    hellCount: number;
    deckCount: number;
    lifeDeck: { faceUp: AiCardSummary[]; faceDownCount: number };
    reactBudget: { ownTurnRemaining: number; opponentTurnRemaining: number };
  };
  opponent: {
    name: string;
    isCritical: boolean;
    handCount: number; // count only — hidden hand identities are never included
    avatarZone: AiCardSummary[];
    constructZone: AiCardSummary[];
    magicZone: AiCardSummary[];
    hellFaceUp: AiCardSummary[];
    deckCount: number; // count only — deck order is never included
    lifeDeck: { faceUp: AiCardSummary[]; faceDownCount: number };
  };
  landMagicZone: AiCardSummary | null;
  pending: {
    deckChoice?: { kind: string; candidates: AiCardSummary[]; minSelect: number; maxSelect: number; destination: string };
    hellChoice?: { candidates: AiCardSummary[]; minSelect: number; maxSelect: number; destination: string };
    endPhaseDiscard?: { requiredDiscards: number };
    manualOverrideAwaitingApproval?: boolean;
  };
  reactionWindow?: {
    triggerType: string;
    priorityIsAi: boolean;
    eligibleReactionCardIds: string[];
  };
  lastGameEvents: string[];
  legalActions: AiActionOption[];
}

function summarizeCard(instance: CardInstance): AiCardSummary {
  const parsed = parseCardAbility(instance.card);
  return {
    instanceId: instance.instanceId,
    name: instance.card.name,
    type: instance.card.type,
    ...(instance.card.subtype ? { subtype: instance.card.subtype } : {}),
    cost: instance.card.cost,
    gem: instance.card.gem,
    gemColor: instance.card.gemColor ?? null,
    color: instance.card.color,
    power: instance.card.power,
    symbol: instance.card.symbol ?? null,
    ...(instance.card.type === 'Avatar' ? { isRested: instance.isRested, netPower: calculateNetPower(instance) } : {}),
    classification: classifyCard(instance.card).status,
    mainEffect: instance.card.mainEffect ?? '',
    flags: {
      hasJuti: parsed.hasJuti,
      hasOnAttack: parsed.hasOnAttack,
      hasHumanShield: parsed.hasHumanShield,
      hasGrit: parsed.hasGrit,
      hasEggKick: parsed.hasEggKick,
      hasBackstab: parsed.hasBackstab,
      needsTargetAvatar: parsed.needsTargetAvatar,
      targetScope: parsed.targetScope,
      drawCount: parsed.drawCount,
      powerMod: parsed.powerMod,
      destroysTarget: parsed.destroysTarget,
      bouncesTarget: parsed.bouncesTarget,
      summonsFromHell: parsed.summonsFromHell,
      recoversFromHell: parsed.recoversFromHell
    }
  };
}

function summarizeZone(zone: CardInstance[]): AiCardSummary[] {
  return zone.filter(instance => instance.isFaceUp).map(summarizeCard);
}

function summarizeLifeDeck(zone: CardInstance[]): { faceUp: AiCardSummary[]; faceDownCount: number } {
  return {
    faceUp: zone.filter(instance => instance.isFaceUp).map(summarizeCard),
    faceDownCount: zone.filter(instance => !instance.isFaceUp).length
  };
}

function summarizeGameEvents(state: GameState, viewerId: string): string[] {
  return (state.gameEvents ?? []).slice(-6).map(({ sequence, event }) => {
    const parts = [`#${sequence}`, event.type, `actor=${('actorId' in event && event.actorId) || 'unknown'}`];
    if ('playerId' in event && event.playerId) parts.push(`player=${event.playerId}`);
    if ('instanceId' in event && event.instanceId) parts.push(`card=${event.instanceId}`);
    if ('phase' in event && event.phase) parts.push(`phase=${event.phase}`);
    // Draw/scout events are already redacted by redactLifeCardsForViewer for
    // non-viewers; keep only the public shape here.
    if (event.type === 'CARD_DRAWN' && event.playerId !== viewerId) parts.push('card=<hidden>');
    return parts.join(' ');
  });
}

function handActionOptions(state: GameState, aiPlayerId: string, hand: CardInstance[]): AiActionOption[] {
  const options: AiActionOption[] = [];
  for (const card of hand) {
    for (const action of deriveLegalHandActions(state, aiPlayerId, card)) {
      options.push({
        actionId: `${action.kind}:${card.instanceId}`,
        kind: action.kind,
        cardInstanceId: card.instanceId,
        cardName: card.card.name,
        summary: `${action.label}: "${card.card.name}" (${card.card.type}${card.card.subtype ? `/${card.card.subtype}` : ''}, Cost ${card.card.cost})`
      });
    }
  }
  return options;
}

/**
 * Builds the redacted AI decision context. All opponent hidden information is
 * redacted before summarization; the output is safe to send to any model route.
 */
export function buildAiContext(state: GameState, aiPlayerId: string): AiContext {
  // Anti-cheat foundation: hidden zones are replaced with placeholders first.
  const view = redactLifeCardsForViewer(state, aiPlayerId);
  const ai = view.players[aiPlayerId];
  const opponentId = view.playerOrder.find(id => id !== aiPlayerId);
  const opponent = opponentId ? view.players[opponentId] : undefined;
  const activePlayerId = view.playerOrder[view.currentTurnPlayerIndex];
  const isAiTurn = activePlayerId === aiPlayerId;

  const legalActions: AiActionOption[] = [];

  if (view.pendingDeckChoice && view.pendingDeckChoice.authorizedViewerId === aiPlayerId) {
    const pending = view.pendingDeckChoice;
    legalActions.push({
      actionId: `DECK_CHOICE:${pending.expectedRevision}`,
      kind: 'DECK_CHOICE',
      summary: `เลือกการ์ดจาก ${pending.kind === 'SCOUT' ? 'Scout' : 'Deck Search'} (${pending.minSelect}-${pending.maxSelect} ใบ → ${pending.destination})`
    });
  }
  if (view.pendingHellChoice && view.pendingHellChoice.authorizedViewerId === aiPlayerId) {
    const pending = view.pendingHellChoice;
    legalActions.push({
      actionId: `HELL_CHOICE:${pending.expectedRevision}`,
      kind: 'HELL_CHOICE',
      summary: `เลือกการ์ดจาก Hell (${pending.minSelect}-${pending.maxSelect} ใบ → ${pending.destination})`
    });
  }
  if (view.pendingEndPhaseDiscardPlayerId === aiPlayerId) {
    legalActions.push({
      actionId: 'DISCARD:end-phase',
      kind: 'DISCARD',
      summary: `ทิ้งการ์ด ${Math.max(0, (ai?.hand.length ?? 0) - 7)} ใบเพื่อจบเทิร์น`
    });
  }
  if (view.reactionWindow && view.reactionWindow.priorityPlayerId === aiPlayerId) {
    for (const card of getEligibleReactionCards(view, aiPlayerId)) {
      legalActions.push({
        actionId: `CAST_REACT:${card.instanceId}`,
        kind: 'CAST_REACT',
        cardInstanceId: card.instanceId,
        cardName: card.card.name,
        summary: `ตอบโต้ด้วย "${card.card.name}"`
      });
    }
    legalActions.push({ actionId: 'PASS:reaction', kind: 'PASS', summary: 'ผ่านสิทธิ์ตอบโต้' });
  } else if (isAiTurn && ai) {
    if (view.currentPhase === 'MAIN') {
      legalActions.push(...handActionOptions(view, aiPlayerId, ai.hand));
    }
    if (view.currentPhase === 'BATTLE') {
      for (const avatar of ai.avatarZone) {
        if (!deriveLegalAvatarActions(view, aiPlayerId, avatar).some(action => action.kind === 'DECLARE_ATTACK')) continue;
        legalActions.push({
          actionId: `DECLARE_ATTACK:${avatar.instanceId}`,
          kind: 'DECLARE_ATTACK',
          cardInstanceId: avatar.instanceId,
          cardName: avatar.card.name,
          summary: `ประกาศโจมตีด้วย "${avatar.card.name}" (PWR ${calculateNetPower(avatar)})`
        });
      }
    }
    legalActions.push({
      actionId: `PASS:${view.currentPhase}`,
      kind: 'PASS',
      summary: view.currentPhase === 'MAIN' ? 'จบ Main Phase' : view.currentPhase === 'BATTLE' ? 'จบ Battle Phase' : 'จบเทิร์น'
    });
  }

  return {
    aiPlayerId,
    activePlayerId,
    turnNumber: view.turnNumber,
    roundNumber: view.roundNumber,
    phase: view.currentPhase,
    mode: view.mode,
    ruleMode: view.ruleMode ?? 'HYBRID',
    ai: {
      name: ai?.name ?? aiPlayerId,
      isCritical: ai?.isCritical ?? false,
      hand: (ai?.hand ?? []).map(summarizeCard),
      avatarZone: summarizeZone(ai?.avatarZone ?? []),
      constructZone: summarizeZone(ai?.constructZone ?? []),
      magicZone: summarizeZone(ai?.magicZone ?? []),
      hellCount: ai?.hell.length ?? 0,
      deckCount: ai?.deck.length ?? 0,
      lifeDeck: summarizeLifeDeck(ai?.lifeDeck ?? []),
      reactBudget: ai?.reactMagicBudget ?? { ownTurnRemaining: 0, opponentTurnRemaining: 0 }
    },
    opponent: {
      name: opponent?.name ?? 'opponent',
      isCritical: opponent?.isCritical ?? false,
      handCount: opponent?.hand.length ?? 0,
      avatarZone: summarizeZone(opponent?.avatarZone ?? []),
      constructZone: summarizeZone(opponent?.constructZone ?? []),
      magicZone: summarizeZone(opponent?.magicZone ?? []),
      hellFaceUp: (opponent?.hell ?? []).filter(instance => instance.isFaceUp).map(summarizeCard),
      deckCount: opponent?.deck.length ?? 0,
      lifeDeck: summarizeLifeDeck(opponent?.lifeDeck ?? [])
    },
    landMagicZone: view.landMagicZone ? summarizeCard(view.landMagicZone) : null,
    pending: {
      ...(view.pendingDeckChoice && view.pendingDeckChoice.authorizedViewerId === aiPlayerId
        ? {
            deckChoice: {
              kind: view.pendingDeckChoice.kind,
              candidates: view.pendingDeckChoice.candidateInstanceIds
                .map(instanceId => view.players[view.pendingDeckChoice!.deckOwnerId]?.deck.find(card => card.instanceId === instanceId))
                .filter((card): card is CardInstance => !!card)
                .map(summarizeCard),
              minSelect: view.pendingDeckChoice.minSelect,
              maxSelect: view.pendingDeckChoice.maxSelect,
              destination: view.pendingDeckChoice.destination
            }
          }
        : {}),
      ...(view.pendingHellChoice && view.pendingHellChoice.authorizedViewerId === aiPlayerId
        ? {
            hellChoice: {
              candidates: view.pendingHellChoice.candidateInstanceIds
                .map(instanceId =>
                  view.players[view.pendingHellChoice!.playerId]?.hell.find(card => card.instanceId === instanceId) ??
                  view.players[view.pendingHellChoice!.playerId]?.darkDimension.find(card => card.instanceId === instanceId))
                .filter((card): card is CardInstance => !!card)
                .map(summarizeCard),
              minSelect: view.pendingHellChoice.minSelect,
              maxSelect: view.pendingHellChoice.maxSelect,
              destination: view.pendingHellChoice.destination
            }
          }
        : {}),
      ...(view.pendingEndPhaseDiscardPlayerId === aiPlayerId
        ? { endPhaseDiscard: { requiredDiscards: Math.max(0, (ai?.hand.length ?? 0) - 7) } }
        : {}),
      ...(view.pendingManualOverride && view.pendingManualOverride.actorId !== aiPlayerId
        ? { manualOverrideAwaitingApproval: true }
        : {})
    },
    ...(view.reactionWindow
      ? {
          reactionWindow: {
            triggerType: view.reactionWindow.trigger.type,
            priorityIsAi: view.reactionWindow.priorityPlayerId === aiPlayerId,
            eligibleReactionCardIds: getEligibleReactionCards(view, aiPlayerId).map(card => card.instanceId)
          }
        }
      : {}),
    lastGameEvents: summarizeGameEvents(view, aiPlayerId),
    legalActions
  };
}
