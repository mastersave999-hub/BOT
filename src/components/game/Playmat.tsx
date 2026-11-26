'use client';

import React, { useEffect, useRef, useState } from 'react';
import { GameState, CardInstance, MagicSubtype, DeferredReactionAction } from '../../engine/types';
import {
  isReactionCommandCurrent,
  isEndPhaseDiscardCommandCurrent,
  isExitPreventionCommandCurrent,
  isGameStateValidForSync,
  isLegalGameStateSync,
  redactLifeCardsForViewer,
  restoreHiddenZonesFromCanonical,
  type RoomLink
} from '../../engine/multiplayer';
import {
  canUseNormalMagicAsReactOnOwnBattle,
  queueReactionCard,
  getEligibleReactionCards,
  getReactionEligibility,
  isReactionWindowStructurallyValid,
  isNormalMagicTreatedAsReact,
  openReactionWindow,
  passReactionPriority
} from '../../engine/reactionEngine';
import { CardView } from './CardView';
import { CardDetailModal } from './CardDetailModal';
import { OpeningDiceRoll } from './OpeningDiceRoll';
import { executeDrawPhase, eliminatePlayer, finishEndPhaseTurn, nextPhaseAfterMain, transitionGamePhase } from '../../engine/turnEngine';
import { declareCombatAttack, payCombatKeyword, resolveDeclaredBattle } from '../../engine/combatKeywords';
import { resolveAvatarCombat } from '../../engine/combatEngine';
import {
  parseCardAbility,
  avatarHasKeyword,
  recomputeContinuousAuras,
  executeCardAbility,
  clearEndOfTurnModifiers,
  expireModifiersAt
} from '../../engine/abilityEngine';
import { calculateNetPower } from '../../engine/layers';
import { beginEndPhaseDiscard, declineExitPrevention, discardToHandLimit, moveCardBetweenZones, useExitPrevention, validateAvatarZone, validateMagicPlay } from '../../engine/gameRules';
import {
  getGemPaymentCardUnavailableReason,
  getSelectedGemTotal,
  validateGemPayment
} from '../../engine/gemPayment';
import {
  Swords, Shield, Flame, Play, RefreshCw,
  CheckCircle2, BookOpen, X, Sparkles, Skull, Layers, Info, List
} from 'lucide-react';

interface PlaymatProps {
  initialState: GameState;
  currentUserId: string;
  isHost?: boolean;
  /** When provided the match is played against a remote player instead of the built-in AI. */
  link?: RoomLink;
}

function preserveOwnLifeCardIdentities(
  incomingState: GameState,
  currentState: GameState,
  viewerId: string
): GameState {
  const incomingPlayer = incomingState.players[viewerId];
  const currentPlayer = currentState.players[viewerId];
  if (!incomingPlayer || !currentPlayer) return incomingState;

  const knownCards = new Map(currentPlayer.lifeDeck.map(card => [card.instanceId, card]));
  let changed = false;
  const lifeDeck = incomingPlayer.lifeDeck.map(card => {
    const knownCard = knownCards.get(card.instanceId);
    if (!knownCard || card.card.printId !== 'hidden-life-card') return card;
    changed = true;
    return { ...card, card: knownCard.card };
  });
  if (!changed) return incomingState;

  return {
    ...incomingState,
    players: {
      ...incomingState.players,
      [viewerId]: { ...incomingPlayer, lifeDeck }
    }
  };
}

interface PendingAbilityAction {
  sourceCard: CardInstance;
  triggerType: 'SUMMON_JUTI' | 'MAGIC_CAST' | 'EQUIP_MODIFICATION';
  targetScope: 'ANY_AVATAR' | 'OWN_AVATAR' | 'OPPONENT_AVATAR';
  prompt: string;
  reaction?: boolean;
}

interface PendingCostPayment {
  handCard: CardInstance;
  requiredCost: number;
  selectedDiscardIds: string[];
}

const PHASE_STEPS = [
  { phase: 'DRAW', label: 'DRAW', description: 'จั่ว' },
  { phase: 'MAIN', label: 'MAIN', description: 'หลัก' },
  { phase: 'BATTLE', label: 'BATTLE', description: 'ต่อสู้' },
  { phase: 'END', label: 'END', description: 'จบ' }
] as const;

interface PhaseTrackerProps {
  currentPhase: GameState['currentPhase'];
  turnNumber: number;
  activePlayerName: string;
  isMyTurn: boolean;
}

const PhaseTracker: React.FC<PhaseTrackerProps> = ({ currentPhase, turnNumber, activePlayerName, isMyTurn }) => {
  const currentIndex = PHASE_STEPS.findIndex(step => step.phase === currentPhase);

  return (
    <section
      aria-label="ลำดับ Phase ของเกม"
      className="sticky top-0 z-20 mx-auto w-full max-w-3xl self-center rounded-xl border border-amber-500/30 bg-slate-950/95 px-2 py-1.5 shadow-lg backdrop-blur sm:px-4"
    >
      <div aria-live="polite" className="mb-1 flex items-center justify-center gap-2 text-[9px] sm:text-[10px]">
        <span className={`rounded-full px-2 py-0.5 font-bold ${isMyTurn ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800 text-slate-300'}`}>
          {isMyTurn ? 'YOUR TURN' : 'OPPONENT TURN'}
        </span>
        <span className="truncate font-semibold text-slate-200">{activePlayerName || 'ผู้เล่น'} · TURN {turnNumber}</span>
      </div>
      <ol className="grid grid-cols-4 gap-1" aria-label="DRAW, MAIN, BATTLE, END">
        {PHASE_STEPS.map((step, index) => {
          const isCurrent = index === currentIndex;
          const isCompleted = index < currentIndex;
          return (
            <li
              key={step.phase}
              aria-current={isCurrent ? 'step' : undefined}
              className={`flex min-w-0 items-center justify-center gap-1 rounded-md border px-1 py-1 text-center transition-colors sm:gap-1.5 ${
                isCurrent
                  ? 'border-amber-300 bg-amber-400 text-slate-950 shadow-[0_0_14px_rgba(251,191,36,0.25)]'
                  : isCompleted
                    ? 'border-emerald-700/60 bg-emerald-950/50 text-emerald-300'
                    : 'border-slate-800 bg-slate-900/60 text-slate-500'
              }`}
            >
              {isCompleted ? (
                <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <span className={`h-2 w-2 shrink-0 rounded-full ${isCurrent ? 'bg-slate-950' : 'bg-slate-700'}`} aria-hidden="true" />
              )}
              <span className="min-w-0 leading-tight">
                <span className="block truncate text-[9px] font-extrabold tracking-wide sm:text-[10px]">{step.label}</span>
                <span className={`block truncate text-[8px] ${isCurrent ? 'text-slate-800' : 'opacity-75'}`}>{step.description}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
};

interface LifeCardTileProps {
  card: CardInstance;
  index: number;
  compact?: boolean;
  onInspect: () => void;
}

const LifeCardTile: React.FC<LifeCardTileProps> = ({ card, index, compact = false, onInspect }) => (
  <button
    type="button"
    disabled={!card.isFaceUp}
    aria-label={card.isFaceUp ? `Revealed LIFE card: ${card.card.name}. Inspect card` : `Face-down LIFE card ${index + 1}`}
    onClick={onInspect}
    className={`relative shrink-0 [perspective:700px] transition-all duration-500 ${compact ? 'h-8 w-6' : card.isFaceUp ? 'h-16 w-12 border-emerald-400 shadow-lg shadow-emerald-900/40 sm:h-20 sm:w-14' : 'h-8 w-12 sm:h-9 sm:w-14'} rounded border border-slate-700 text-[8px] font-bold disabled:cursor-default`}
  >
    <span className={`absolute inset-0 overflow-hidden rounded ${card.isFaceUp ? 'life-card-flip' : ''}`}>
      <span
        aria-hidden="true"
        className={`absolute inset-0 flex items-center justify-center rounded bg-slate-900 text-emerald-400 transition-opacity duration-150 ${card.isFaceUp ? 'opacity-0' : 'opacity-100'}`}
      >
        LIFE #{index + 1}
      </span>
      <span className={`absolute inset-0 overflow-hidden rounded transition-opacity duration-300 ${card.isFaceUp ? 'opacity-100' : 'opacity-0'}`}>
        <img
          src={card.card.imageUrl}
          alt=""
          crossOrigin="anonymous"
          referrerPolicy="no-referrer"
          loading="lazy"
          className="h-full w-full rounded object-cover"
          onError={event => { event.currentTarget.style.visibility = 'hidden'; }}
        />
        <span className="absolute inset-x-0 bottom-0 truncate bg-slate-950/90 px-0.5 py-0.5 text-center text-[7px] text-white">{card.card.name}</span>
      </span>
    </span>
  </button>
);

const KEYWORD_LEGEND = [
  { kw: 'จุติ', color: 'bg-blue-600', desc: 'เมื่อ Avatar ตัวนี้ถูกอัญเชิญลงสนามแบบจ่าย Cost จะเกิดผลตามที่กำหนด' },
  { kw: 'คำสั่งเสีย', color: 'bg-indigo-700', desc: 'เมื่อ Avatar ตัวนี้ถูกทำลายลงนรก จะเกิดผลตามที่กำหนด' },
  { kw: 'เซ่นไหว้', color: 'bg-sky-600', desc: 'นำ Avatar บนสนามฝ่ายเราลงนรกตามจำนวนที่กำหนด' },
  { kw: 'ต่อเนื่อง', color: 'bg-emerald-600', desc: 'ความสามารถทำงานตลอดเวลาตราบเท่าที่การ์ดอยู่ในโซนที่กำหนด' },
  { kw: 'สามัคคี', color: 'bg-red-600', desc: 'นอน Avatar นี้ในสภาพตื่นเพื่อบวก POWER ให้ Avatar ที่โจมตี' },
  { kw: 'โล่มนุษย์', color: 'bg-orange-600', desc: 'บังคับ/เบี่ยงเบนการโจมตีของฝ่ายตรงข้ามมาที่ Avatar นี้' },
  { kw: 'ลูกฮึด', color: 'bg-rose-600', desc: 'เมื่อต่อสู้กับ Avatar ที่มี POWER เท่ากัน ตัวที่มีลูกฮึดจะเป็นฝ่ายชนะ' },
  { kw: 'เตะไข่', color: 'bg-pink-600', desc: 'สามารถโจมตีไปที่ LIFE Card ได้โดยตรง แม้ฝ่ายตรงข้ามจะมี Avatar อยู่' },
  { kw: 'แทงหลัง', color: 'bg-purple-600', desc: 'สามารถเลือกโจมตี Avatar ที่อยู่ในสภาพนอนได้โดยตรง' },
];

export const Playmat: React.FC<PlaymatProps> = ({ initialState, currentUserId, isHost = true, link }) => {
  const [gameState, setGameState] = useState<GameState>(() => recomputeContinuousAuras(initialState));
  const [selectedAttackerId, setSelectedAttackerId] = useState<string | null>(null);
  const [inspectedCard, setInspectedCard] = useState<CardInstance | null>(null);
  const [notification, setNotification] = useState<string | null>(null);
  const [pendingAbility, setPendingAbility] = useState<PendingAbilityAction | null>(null);
  const [pendingCost, setPendingCost] = useState<PendingCostPayment | null>(null);
  const [pendingEndPhaseDiscards, setPendingEndPhaseDiscards] = useState<string[] | null>(null);
  const [submittedDiscardRevision, setSubmittedDiscardRevision] = useState<number | null>(null);
  const [showKeywordsModal, setShowKeywordsModal] = useState<boolean>(false);
  const [showEventLog, setShowEventLog] = useState<boolean>(false);
  const [showHellModal, setShowHellModal] = useState<'ME' | 'OPPONENT' | null>(null);
  const [winnerName, setWinnerName] = useState<string | null>(null);
  const [opponentLeft, setOpponentLeft] = useState<boolean>(false);
  const [showOpeningRoll, setShowOpeningRoll] = useState<boolean>(() => !!initialState.openingRolls);
  const isOnline = !!link;
  // Last state that did not originate from a local action; it must not be echoed back to the peer.
  const baselineStateRef = useRef<GameState | null>(null);
  const initialGameStateRef = useRef<GameState>(gameState);

  const meId = currentUserId;
  const [focusedOpponentId, setFocusedOpponentId] = useState<string | null>(null);
  const opponentIds = gameState.playerOrder.filter(id => id !== meId);
  const opponentId =
    focusedOpponentId && opponentIds.includes(focusedOpponentId)
      ? focusedOpponentId
      : opponentIds[0] ?? Object.keys(gameState.players).find(id => id !== meId)!;
  const isEliminated = !gameState.playerOrder.includes(meId);
  const activePlayerId = gameState.playerOrder[gameState.currentTurnPlayerIndex];
  const isAttackLockedInFirstRound =
    gameState.mode === 'AD_MUA' && gameState.turnNumber < Object.keys(gameState.players).length;
  const leftPlayerIdsRef = useRef<Set<string>>(new Set());
  const [leftTick, setLeftTick] = useState<number>(0);

  useEffect(() => {
    if (window.matchMedia('(min-width: 1024px)').matches) setShowEventLog(true);
  }, []);

  const me = gameState.players[meId];
  const opponent = gameState.players[opponentId];
  const isMyTurn = gameState.playerOrder[gameState.currentTurnPlayerIndex] === meId;
  const isSubmittingEndPhaseDiscard = submittedDiscardRevision !== null && submittedDiscardRevision === gameState.pendingEndPhaseDiscardRevision;

  useEffect(() => {
    if (gameState.pendingEndPhaseDiscardPlayerId === meId && isMyTurn && !gameState.reactionWindow) {
      setPendingEndPhaseDiscards(current => current ?? []);
      if (submittedDiscardRevision !== null && submittedDiscardRevision !== gameState.pendingEndPhaseDiscardRevision) {
        setSubmittedDiscardRevision(null);
      }
    } else if (!gameState.pendingEndPhaseDiscardPlayerId) {
      setPendingEndPhaseDiscards(null);
      setSubmittedDiscardRevision(null);
    }
  }, [gameState.pendingEndPhaseDiscardPlayerId, gameState.pendingEndPhaseDiscardRevision, gameState.reactionWindow, isMyTurn, meId, submittedDiscardRevision]);

  useEffect(() => {
    if (!link) return;
    const offMessage = link.onMessage((msg, senderPlayerId) => {
      if (msg.type === 'END_PHASE_DISCARD') {
        if (!isHost || !senderPlayerId || msg.command.playerId !== senderPlayerId ||
          !isEndPhaseDiscardCommandCurrent(gameState, msg.command, senderPlayerId)) return;
        const discarded = discardToHandLimit(
          gameState,
          senderPlayerId,
          msg.command.selectedInstanceIds,
          msg.command.expectedRevision,
          msg.command.commandId
        );
        if (!discarded.ok) return;
        setGameState(finishEndPhaseTurn(discarded.state));
        return;
      }
      if (msg.type === 'EXIT_PREVENTION_COMMAND') {
        if (!isHost || !senderPlayerId || msg.command.playerId !== senderPlayerId ||
          !isExitPreventionCommandCurrent(gameState, msg.command, senderPlayerId)) return;
        const result = msg.command.kind === 'USE_EXIT_PREVENTION'
          ? useExitPrevention(gameState, senderPlayerId, msg.command.sourceCardId!)
          : declineExitPrevention(gameState, senderPlayerId, msg.command.expectedRevision);
        if (!result.ok) return;
        setGameState({ ...result.state, processedCommandIds: [...(gameState.processedCommandIds ?? []), msg.command.commandId].slice(-128) });
        return;
      }
      if (msg.type === 'REACTION_COMMAND') {
        if (!isHost || !senderPlayerId || msg.command.playerId !== senderPlayerId || msg.command.playerId === meId) return;
        const currentWindow = gameState.reactionWindow;
        if (!senderPlayerId || !isReactionCommandCurrent(gameState, msg.command, senderPlayerId)) return;
        if (!currentWindow) return;

        if (msg.command.kind === 'PASS') {
          const result = passReactionPriority(gameState, msg.command.playerId);
          if (!result.ok) return;
          const loggedState = result.logs?.length
            ? appendLogs(result.state, result.logs, 'REACTION', msg.command.playerId)
            : result.state;
          if (result.pendingAction) finishDeferredReactionAction(loggedState, result.pendingAction);
          else setGameState(loggedState);
          return;
        }

        const cardInstanceId = msg.command.cardInstanceId;
        if (!cardInstanceId) return;
        const queued = queueReactionCard(gameState, msg.command.playerId, cardInstanceId, msg.command.targetInstanceId);
        if (!queued.ok) return;
        const reactionCard = gameState.players[msg.command.playerId]?.hand.find(card => card.instanceId === cardInstanceId);
        const loggedState = reactionCard
          ? appendLogs(queued.state, [`${reactionCard.card.name} ถูกวางบน Chain (${currentWindow.trigger.type})`], 'REACTION', msg.command.playerId)
          : queued.state;
        setGameState(loggedState);
        return;
      }

      if (msg.type !== 'SYNC') return;
      if (isHost && gameState.reactionWindow) return;
      if (!isGameStateValidForSync(msg.state) || (isHost && (!senderPlayerId || !isLegalGameStateSync(gameState, msg.state, senderPlayerId)))) return;
      if (isHost && msg.state.reactionWindow) {
        const incomingWindow = msg.state.reactionWindow;
        const activePlayerBeforeSync = gameState.playerOrder[gameState.currentTurnPlayerIndex];
        if (
          !senderPlayerId ||
          incomingWindow.passedPlayerIds.length !== 0 ||
          !!incomingWindow.pendingReaction ||
          (incomingWindow.chain?.length ?? 0) !== 0 ||
          incomingWindow.revision !== 0 ||
          !isReactionWindowStructurallyValid(msg.state) ||
          incomingWindow.trigger.actorId !== activePlayerBeforeSync ||
          senderPlayerId !== activePlayerBeforeSync ||
          incomingWindow.turnOwnerId !== activePlayerBeforeSync ||
          JSON.stringify(incomingWindow.priorityOrder) !== JSON.stringify([
            ...gameState.playerOrder.slice(gameState.currentTurnPlayerIndex + 1),
            ...gameState.playerOrder.slice(0, gameState.currentTurnPlayerIndex),
            activePlayerBeforeSync
          ]) ||
          msg.state.id !== gameState.id ||
          msg.state.reactionSequence !== (gameState.reactionSequence ?? 0) + 1 ||
          incomingWindow.id !== `${msg.state.id}:${msg.state.reactionSequence}:${incomingWindow.trigger.type}` ||
          msg.state.currentTurnPlayerIndex !== gameState.currentTurnPlayerIndex ||
          msg.state.currentPhase !== gameState.currentPhase ||
          msg.state.turnNumber !== gameState.turnNumber ||
          JSON.stringify(msg.state.playerOrder) !== JSON.stringify(gameState.playerOrder)
        ) return;
      }
      baselineStateRef.current = isHost ? null : msg.state;
      setGameState(current => {
        const authoritativeView = isHost && senderPlayerId
          ? restoreHiddenZonesFromCanonical(msg.state, current, senderPlayerId)
          : msg.state;
        return preserveOwnLifeCardIdentities(authoritativeView, current, meId);
      });
      setWinnerName(msg.winner);
      setSelectedAttackerId(null);
      setPendingAbility(null);
      setPendingCost(null);
    });
    const offClose = link.onClose(() => setOpponentLeft(true));
    const offPeerLeft = link.onPeerLeft?.(playerId => {
      leftPlayerIdsRef.current.add(playerId);
      setLeftTick(tick => tick + 1);
    });
    return () => {
      offMessage();
      offClose();
      offPeerLeft?.();
    };
  }, [gameState, isHost, link, meId]);

  // Host only: a guest who dropped out of an Ad-Mua match is eliminated, even if a stale sync re-adds them.
  useEffect(() => {
    if (gameState.mode !== 'AD_MUA' || leftPlayerIdsRef.current.size === 0) return;
    let next = gameState;
    leftPlayerIdsRef.current.forEach(id => {
      if (next.playerOrder.includes(id)) next = eliminatePlayer(next, id, 'หลุดการเชื่อมต่อและถูกกำจัดออกจากเกม').state;
    });
    if (next === gameState) return;
    setGameState(next);
    if (next.playerOrder.length === 1 && !winnerName) {
      setWinnerName(next.players[next.playerOrder[0]].name);
    }
  }, [gameState, leftTick, winnerName]);

  // Follow whoever is taking their turn so their moves are visible without manual switching.
  useEffect(() => {
    if (activePlayerId && activePlayerId !== meId) setFocusedOpponentId(activePlayerId);
  }, [activePlayerId, meId]);

  useEffect(() => {
    if (!link) return;
    if (gameState === initialGameStateRef.current || gameState === baselineStateRef.current) return;
    link.send({ type: 'SYNC', state: gameState, winner: winnerName });
  }, [gameState, winnerName, link]);

  const leaveMatch = () => {
    link?.close();
    window.location.reload();
  };

  const showNotification = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3200);
  };

  // Helper to append logs
  const appendLogs = (state: GameState, descriptions: string[], type = 'ABILITY', actorId = meId): GameState => {
    if (descriptions.length === 0) return state;
    return {
      ...state,
      eventLog: [
        ...state.eventLog,
        ...descriptions.map(description => ({
          timestamp: Date.now(),
          type,
          description,
          actorId
        }))
      ]
    };
  };

  const resolveCombatAction = (
    state: GameState,
    attackerPlayerId: string,
    targetPlayerId: string,
    attackerInstanceId: string,
    targetAvatarId: string,
    checkedAvatarIds: string[] = []
  ): { state: GameState; events: string[] } => {
    const attacker = state.players[attackerPlayerId]?.avatarZone.find(card => card.instanceId === attackerInstanceId);
    const target = state.players[targetPlayerId]?.avatarZone.find(card => card.instanceId === targetAvatarId);
    if (!attacker || !target) return { state, events: [`${attacker?.card.name ?? 'Avatar'} — เป้าหมายไม่อยู่บนสนาม การโจมตีสิ้นสุดลง`] };
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
        shield.kind === 'DESTRUCTION' && (shield.mode ?? 'AUTOMATIC') === 'AUTOMATIC' && shield.usesRemaining !== 0
      );
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
    const nextState = appendLogs(result.state, result.events, 'COMBAT', attackerPlayerId);
    return { state: nextState, events: result.events };
  };

  const finishDeferredReactionAction = (state: GameState, action?: DeferredReactionAction) => {
    let nextState = state;
    if (action?.type === 'SUMMON_JUTI' && action.paidCost && parseCardAbility(action.sourceCard.card).hasJuti) {
      const parsed = parseCardAbility(action.sourceCard.card);
      if (parsed.needsTargetAvatar) {
        setGameState(nextState);
        setPendingAbility({
          sourceCard: action.sourceCard,
          triggerType: 'SUMMON_JUTI',
          targetScope: parsed.targetScope === 'NONE' ? 'ANY_AVATAR' : parsed.targetScope,
          prompt: `ความสามารถ จุติ ของ "${action.sourceCard.card.name}": คลิกเลือก Avatar เป้าหมายบนสนาม`
        });
        return;
      }
      const ability = executeCardAbility(nextState, action.actorId, action.sourceCard, 'SUMMON_JUTI');
      nextState = appendLogs(ability.state, ability.logs, 'ABILITY', action.actorId);
    } else if (action?.type === 'RESOLVE_MAGIC') {
      const ability = executeCardAbility(nextState, action.actorId, action.sourceCard, 'MAGIC_CAST', action.targetAvatarId);
      nextState = appendLogs(ability.state, ability.logs, 'MAGIC', action.actorId);
    } else if (action?.type === 'RESOLVE_ABILITY') {
      const ability = executeCardAbility(nextState, action.actorId, action.sourceCard, action.abilityTrigger);
      nextState = appendLogs(ability.state, ability.logs, 'ABILITY', action.actorId);
    } else if (action?.type === 'RESOLVE_COMBAT') {
      const result = resolveCombatAction(
        nextState,
        action.actorId,
        action.targetPlayerId,
        action.sourceCard.instanceId,
        action.targetAvatarId,
        action.checkedAvatarIds ?? []
      );
      setGameState(result.state);
      setSelectedAttackerId(null);
      showNotification(result.events[result.events.length - 1] ?? 'การต่อสู้สิ้นสุดลง');
      return;
    } else if (action?.type === 'START_ATTACK') {
      const attacker = nextState.players[action.actorId]?.avatarZone.find(card => card.instanceId === action.sourceCard.instanceId);
      if (attacker) {
        const parsed = parseCardAbility(attacker.card);
        if (parsed.hasOnAttack) {
          const ability = executeCardAbility(nextState, action.actorId, attacker, 'ON_ATTACK');
          nextState = appendLogs(ability.state, ability.logs, 'ABILITY', action.actorId);
        }
        setSelectedAttackerId(attacker.instanceId);
        setGameState(nextState);
        showNotification(`เลือก "${attacker.card.name}" โจมตี! คลิกเป้าหมายฝ่ายตรงข้ามหรือ LIFE`);
      } else {
        setSelectedAttackerId(null);
        setGameState(nextState);
      }
      return;
    } else if (action?.type === 'AI_TURN_CONTINUATION') {
      runAiOpponentTurn(nextState, true, action.logs);
      return;
    } else if (action?.type === 'ADVANCE_PHASE') {
      const actorName = nextState.players[action.actorId]?.name ?? 'ผู้เล่น';
      if (action.nextPhase === 'BATTLE' || action.nextPhase === 'END') {
        nextState = appendLogs(
          transitionGamePhase(nextState, action.actorId, action.nextPhase),
          [`${actorName} เข้าสู่ ${action.nextPhase === 'BATTLE' ? 'Battle' : 'End'} Phase`],
          'PHASE_CHANGE',
          action.actorId
        );
        if (action.nextPhase === 'END') setSelectedAttackerId(null);
      } else if (action.nextPhase === 'DRAW') {
        const activePlayer = nextState.players[action.actorId];
        if (nextState.currentPhase === 'END' && (activePlayer?.hand.length ?? 0) > 7) {
          const discardState = beginEndPhaseDiscard(nextState, action.actorId);
          if (!discardState.ok) return;
          setGameState(discardState.state);
          if (action.actorId === meId) setPendingEndPhaseDiscards(current => current ?? []);
          showNotification(`ผู้เล่นที่กำลังจบเทิร์นต้องเลือก ${(activePlayer?.hand.length ?? 0) - 7} ใบเพื่อทิ้ง`);
          return;
        }
        nextState = finishEndPhaseTurn(nextState);
        const nextPlayerId = nextState.playerOrder[nextState.currentTurnPlayerIndex];
        const nextPlayerName = nextState.players[nextPlayerId]?.name ?? nextPlayerId;
        nextState = appendLogs(nextState, [`จบเทิร์นของ ${actorName} — เริ่มเทิร์นของ ${nextPlayerName}`], 'TURN_CHANGE', action.actorId);
        setGameState(nextState);
        if (!isOnline) setTimeout(() => runAiOpponentTurn(nextState), 900);
        showNotification(`ส่งเทิร์นให้ ${nextPlayerName}`);
        return;
      }
    }
    setGameState(nextState);
  };

  const handleReactionPass = () => {
    if (gameState.pendingEndPhaseDiscardPlayerId || (gameState.pendingExitPrevention && !gameState.pendingExitPrevention.usedActivatedPrevention)) return;
    const window = gameState.reactionWindow;
    if (!window || window.priorityPlayerId !== meId) return;
    if (link && !isHost) {
      link.send({
        type: 'REACTION_COMMAND',
        command: { kind: 'PASS', playerId: meId, windowId: window.id, expectedRevision: window.revision }
      });
      return;
    }
    const result = passReactionPriority(gameState, meId);
    if ('reason' in result) {
      showNotification(result.reason);
      return;
    }
    const loggedState = result.logs?.length
      ? appendLogs(result.state, result.logs, 'REACTION', meId)
      : result.state;
    if (result.pendingAction) {
      finishDeferredReactionAction(loggedState, result.pendingAction);
      showNotification('Chain resolved — ดำเนินการเดิมต่อ');
      return;
    }
    setGameState(loggedState);
  };

  const handleReactionCard = (handCard: CardInstance) => {
    if (gameState.pendingEndPhaseDiscardPlayerId || (gameState.pendingExitPrevention && !gameState.pendingExitPrevention.usedActivatedPrevention)) return;
    const eligibility = getReactionEligibility(gameState, meId, handCard.card);
    if (!eligibility.eligible) {
      showNotification(eligibility.reason ?? 'การ์ดนี้ไม่สามารถตอบโต้การกระทำดังกล่าวได้');
      return;
    }
    const window = gameState.reactionWindow;
    if (!window) return;

    const parsed = parseCardAbility(handCard.card);
    const triggerTargetId = window.trigger.targetInstanceId;
    if (!isHost && link) {
      if (parsed.needsTargetAvatar) {
        setPendingAbility({
          sourceCard: handCard,
          triggerType: 'MAGIC_CAST',
          targetScope: parsed.targetScope === 'NONE' ? 'ANY_AVATAR' : parsed.targetScope,
          prompt: `ตอบโต้ด้วย "${handCard.card.name}": คลิกเลือก Avatar เป้าหมาย`,
          reaction: true
        });
        return;
      }
      link.send({
        type: 'REACTION_COMMAND',
        command: {
          kind: 'PLAY',
          playerId: meId,
          windowId: window.id,
          expectedRevision: window.revision,
          cardInstanceId: handCard.instanceId,
          targetInstanceId: triggerTargetId
        }
      });
      return;
    }

    if (parsed.needsTargetAvatar) {
      setPendingAbility({
        sourceCard: handCard,
        triggerType: 'MAGIC_CAST',
        targetScope: parsed.targetScope === 'NONE' ? 'ANY_AVATAR' : parsed.targetScope,
        prompt: `ตอบโต้ด้วย "${handCard.card.name}": คลิกเลือก Avatar เป้าหมาย`,
        reaction: true
      });
      return;
    }
    const queued = queueReactionCard(gameState, meId, handCard.instanceId, triggerTargetId);
    if ('reason' in queued) {
      showNotification(queued.reason);
      return;
    }
    setGameState(appendLogs(
      queued.state,
      [`${handCard.card.name} วางลงบน Chain — รอการตอบโต้หรือผ่านสิทธิ์`],
      'REACTION',
      meId
    ));
  };

  // Phase 1: Draw Phase Action
  const handleDrawPhase = () => {
    if (gameState.pendingEndPhaseDiscardPlayerId || (gameState.pendingExitPrevention && !gameState.pendingExitPrevention.usedActivatedPrevention) || gameState.reactionWindow || !isMyTurn || gameState.currentPhase !== 'DRAW' || winnerName) return;
    let nextState = recomputeContinuousAuras(executeDrawPhase(gameState));
    if (nextState.players[meId].deck.length === 0 && gameState.players[meId].deck.length === 0) {
      if (gameState.mode === 'AD_MUA') {
        const elimination = eliminatePlayer(nextState, meId, 'การ์ดในเด็คหมดและถูกกำจัดออกจากเกม');
        nextState = elimination.state;
        if (elimination.winnerId) setWinnerName(nextState.players[elimination.winnerId].name);
      } else {
        setWinnerName(opponent.name);
      }
    }
    setGameState(nextState);
    showNotification('จั่วการ์ดและตื่น Avatar ทั้งหมดแล้ว — เข้าสู่ Main Phase');
  };

  const confirmEndPhaseDiscards = () => {
    if (pendingEndPhaseDiscards === null || gameState.pendingEndPhaseDiscardPlayerId !== meId || isSubmittingEndPhaseDiscard) return;
    const expectedRevision = gameState.pendingEndPhaseDiscardRevision;
    if (expectedRevision === undefined) return;
    const commandId = globalThis.crypto.randomUUID();
    if (link && !isHost) {
      setSubmittedDiscardRevision(expectedRevision);
      link.send({
        type: 'END_PHASE_DISCARD',
        command: { playerId: meId, commandId, expectedRevision, selectedInstanceIds: pendingEndPhaseDiscards }
      });
      return;
    }
    const result = discardToHandLimit(gameState, meId, pendingEndPhaseDiscards, expectedRevision, commandId);
    if (!result.ok) {
      showNotification(result.reason ?? 'เลือกการ์ดที่ต้องทิ้งให้ถูกต้อง');
      return;
    }
    setPendingEndPhaseDiscards(null);
    const nextState = finishEndPhaseTurn(result.state);
    const nextPlayerId = nextState.playerOrder[nextState.currentTurnPlayerIndex];
    const nextPlayerName = nextState.players[nextPlayerId]?.name ?? nextPlayerId;
    setGameState(appendLogs(nextState, [`จบเทิร์นของ ${me.name} — เริ่มเทิร์นของ ${nextPlayerName}`], 'TURN_CHANGE', meId));
    showNotification(`ส่งเทิร์นให้ ${nextPlayerName}`);
    if (!isOnline) setTimeout(() => runAiOpponentTurn(nextState), 900);
  };

  const resolveExitChoice = (sourceCardId?: string) => {
    const pending = gameState.pendingExitPrevention;
    if (!pending || pending.preventionPlayerId !== meId || pending.usedActivatedPrevention) return;
    if (link && !isHost) {
      link.send({
        type: 'EXIT_PREVENTION_COMMAND',
        command: {
          kind: sourceCardId ? 'USE_EXIT_PREVENTION' : 'DECLINE_EXIT_PREVENTION',
          playerId: meId,
          commandId: globalThis.crypto.randomUUID(),
          expectedRevision: pending.expectedRevision,
          ...(sourceCardId ? { sourceCardId } : {})
        }
      });
      return;
    }
    const result = sourceCardId
      ? useExitPrevention(gameState, meId, sourceCardId)
      : declineExitPrevention(gameState, meId, pending.expectedRevision);
    if (!result.ok) {
      showNotification(result.reason ?? 'ไม่สามารถดำเนินการป้องกันได้');
      return;
    }
    setGameState(result.state);
  };

  // Advance Phases & AI Opponent Turn
  const handleNextPhase = () => {
    if (gameState.pendingEndPhaseDiscardPlayerId || (gameState.pendingExitPrevention && !gameState.pendingExitPrevention.usedActivatedPrevention) || gameState.reactionWindow || !isMyTurn || winnerName) return;
    const nextPhase = gameState.currentPhase === 'MAIN'
      ? nextPhaseAfterMain(gameState, meId)
      : gameState.currentPhase === 'BATTLE'
        ? 'END'
        : gameState.currentPhase === 'END'
          ? 'DRAW'
          : null;
    if (nextPhase) {
      const reactionState = openReactionWindow(
        gameState,
        { type: 'BEFORE_PHASE_CHANGE', actorId: meId },
        { type: 'ADVANCE_PHASE', actorId: meId, nextPhase }
      );
      if (reactionState !== gameState) {
        setGameState(reactionState);
        showNotification('ก่อนเปลี่ยน Phase — เปิด Reaction Window ตามลำดับสิทธิ์');
        return;
      }
    }

    if (gameState.currentPhase === 'END' && me.hand.length > 7) {
      const discardState = beginEndPhaseDiscard(gameState, meId);
      if (!discardState.ok) {
        showNotification(discardState.reason ?? 'เริ่มการเลือกการ์ดทิ้งไม่สำเร็จ');
        return;
      }
      setGameState(discardState.state);
      setPendingEndPhaseDiscards([]);
      showNotification(`เลือกการ์ด ${me.hand.length - 7} ใบเพื่อทิ้งก่อนจบเทิร์น`);
      return;
    }

    if (gameState.currentPhase === 'MAIN') {
      const firstPlayerSkipsBattle = gameState.turnNumber === 1 && gameState.currentTurnPlayerIndex === 0;
      const phase = firstPlayerSkipsBattle ? 'END' : 'BATTLE';
      setGameState(prev => appendLogs(
        transitionGamePhase(prev, meId, phase),
        [firstPlayerSkipsBattle ? `${me.name} ข้าม Battle Phase ในเทิร์นแรก` : `${me.name} เข้าสู่ Battle Phase`],
        'PHASE_CHANGE'
      ));
      showNotification(firstPlayerSkipsBattle ? 'เทิร์นแรกของผู้เล่นคนแรก — ข้าม Battle Phase เข้าสู่ End Phase' : 'เข้าสู่ Battle Phase!');
    } else if (gameState.currentPhase === 'BATTLE') {
      setSelectedAttackerId(null);
      setGameState(prev => appendLogs(transitionGamePhase(prev, meId, 'END'), [`${me.name} เข้าสู่ End Phase`], 'PHASE_CHANGE'));
      showNotification('เข้าสู่ End Phase!');
    } else if (gameState.currentPhase === 'END') {
      const nextState = finishEndPhaseTurn(gameState);
      const nextPlayerId = nextState.playerOrder[nextState.currentTurnPlayerIndex];
      const nextPlayerName = nextState.players[nextPlayerId]?.name ?? nextPlayerId;
      const loggedState = appendLogs(nextState, [`จบเทิร์นของ ${me.name} — เริ่มเทิร์นของ ${nextPlayerName}`], 'TURN_CHANGE');
      setGameState(loggedState);
      showNotification(`ส่งเทิร์นให้ ${nextPlayerName}`);

      if (!isOnline) setTimeout(() => runAiOpponentTurn(loggedState), 900);
    }
  };

  // Automated AI Opponent Turn for smooth single-player testing
  const runAiOpponentTurn = (startState: GameState, resumeAfterReaction = false, savedLogs: string[] = []) => {
    let state = resumeAfterReaction ? startState : executeDrawPhase(startState);
    const logs = resumeAfterReaction
      ? [...savedLogs]
      : [`🤖 ${state.players[opponentId].name} จั่วการ์ดและเข้าสู่ Main Phase`];

    if (!resumeAfterReaction) {
      const aiForMain = { ...state.players[opponentId] };
      const playerForMain = { ...state.players[meId] };
      const avatarIdx = aiForMain.hand.findIndex(c => c.card.type === 'Avatar');
      let summoned: CardInstance | undefined;
      if (avatarIdx !== -1 && aiForMain.avatarZone.length < 4) {
        summoned = { ...aiForMain.hand[avatarIdx], isFaceUp: true, isRested: false };
        aiForMain.hand = aiForMain.hand.filter((_, i) => i !== avatarIdx);
        aiForMain.avatarZone = [...aiForMain.avatarZone, summoned];
        logs.push(`🤖 ${aiForMain.name} อัญเชิญ "${summoned.card.name}" (PWR ${summoned.card.power})`);
      }

      state = recomputeContinuousAuras({
        ...state,
        players: { ...state.players, [opponentId]: aiForMain, [meId]: playerForMain }
      });

      if (summoned) {
        const reactionState = openReactionWindow(
          state,
          {
            type: 'AVATAR_SUMMONED',
            actorId: opponentId,
            targetInstanceId: summoned.instanceId,
            targetCardName: summoned.card.name,
            sourceCardName: summoned.card.name
          },
          { type: 'AI_TURN_CONTINUATION', actorId: opponentId, sourceCard: summoned, logs }
        );
        if (reactionState !== state) {
          setGameState(reactionState);
          return;
        }
      }
    }

    const ai = state.players[opponentId];

    const readyAiAvatar = state.players[opponentId].avatarZone.find(a => !a.isRested && calculateNetPower(a) > 0);
    if (readyAiAvatar) {
      const targetPlayerAvatars = state.players[meId].avatarZone;
      const target = targetPlayerAvatars.length === 0
        ? { type: 'LIFE' as const, playerId: meId }
        : targetPlayerAvatars[0] && calculateNetPower(readyAiAvatar) >= calculateNetPower(targetPlayerAvatars[0])
          ? { type: 'AVATAR' as const, playerId: meId, instanceId: targetPlayerAvatars[0].instanceId }
          : null;
      if (target) {
        const declared = declareCombatAttack(state, readyAiAvatar.instanceId, target);
        const battle = declared ? resolveDeclaredBattle(declared) : null;
        if (battle?.ok) {
          state = battle.state;
          logs.push(...battle.events.map(event => `🤖 ${event}`));
          if (battle.events.some(event => event.includes('lost the game'))) setWinnerName(ai.name);
        }
      }
    }

    // End AI Turn -> Return to Player 1 Draw Phase
    state = expireModifiersAt(state, 'END_OF_BATTLE', opponentId);
    state = clearEndOfTurnModifiers(state);
    state = {
      ...state,
      currentTurnPlayerIndex: 0,
      currentPhase: 'DRAW',
      turnNumber: state.turnNumber + 1
    };
    state = appendLogs(state, [...logs, `จบเทิร์นของ ${ai.name} — ตาของคุณ (กดเริ่มจั่วการ์ด)`], 'AI_TURN', opponentId);
    setGameState(state);
  };

  // Start playing a card from Hand (checks Cost first)
  const handleInitiatePlayCard = (handCard: CardInstance) => {
    if (gameState.pendingEndPhaseDiscardPlayerId) {
      if (isSubmittingEndPhaseDiscard || gameState.pendingEndPhaseDiscardPlayerId !== meId || !me.hand.some(card => card.instanceId === handCard.instanceId)) return;
      const selectedIds = pendingEndPhaseDiscards ?? [];
      if (selectedIds.includes(handCard.instanceId)) {
        setPendingEndPhaseDiscards(selectedIds.filter(id => id !== handCard.instanceId));
      } else {
        const requiredCount = Math.max(0, me.hand.length - 7);
        if (selectedIds.length >= requiredCount) {
          showNotification(`เลือกการ์ดได้ไม่เกิน ${requiredCount} ใบ`);
          return;
        }
        setPendingEndPhaseDiscards([...selectedIds, handCard.instanceId]);
      }
      return;
    }
    if (pendingEndPhaseDiscards !== null) return;
    if (gameState.reactionWindow) {
      if (gameState.reactionWindow.priorityPlayerId === meId) {
        handleReactionCard(handCard);
      } else {
        setInspectedCard(handCard);
      }
      return;
    }
    if (!isMyTurn || winnerName) {
      setInspectedCard(handCard);
      return;
    }

    const normalTreatedAsReact = canUseNormalMagicAsReactOnOwnBattle(gameState, meId, handCard.card);
    if (gameState.currentPhase !== 'MAIN' && !normalTreatedAsReact) {
      showNotification('สามารถอัญเชิญหรือใช้การ์ดได้ใน Main Phase (React Magic หรือ Normal ที่ระบุว่าเป็น React ใช้ได้ตามเงื่อนไข)');
      return;
    }

    if (handCard.card.type === 'Avatar' && validateAvatarZone({ avatarZone: [...me.avatarZone, handCard] })) {
      showNotification('Avatar Zone เต็มหรือมีชนิดการ์ดไม่ถูกต้องตามกฎ');
      return;
    }

    if (handCard.card.type === 'Construct') {
      const constructError = me.constructZone.length >= 3
        ? 'Construct Zone เต็มแล้ว (สูงสุด 3 ใบ)'
        : me.constructZone.some(card => card.card.name === handCard.card.name)
          ? 'ห้ามมี Construct ชื่อซ้ำกันใน Zone ของผู้เล่นคนเดียวกัน'
          : null;
      if (constructError) {
        showNotification(constructError);
        return;
      }
    }

    if (handCard.card.type === 'Magic') {
      const subtype = normalTreatedAsReact ? 'React' : ((handCard.card.subtype || 'Normal') as MagicSubtype);
      const restriction = validateMagicPlay(gameState, meId, subtype, normalTreatedAsReact);
      if (restriction) {
        showNotification(restriction);
        return;
      }
    }

    const cost = handCard.card.cost ?? 0;
    const requiresGemPayment =
      (handCard.card.type === 'Avatar' || handCard.card.type === 'Construct') && cost > 0;

    if (requiresGemPayment) {
      setPendingCost({
        handCard,
        requiredCost: cost,
        selectedDiscardIds: []
      });
    } else {
      finalizePlayCard(handCard, [], cost === 0, normalTreatedAsReact);
    }
  };

  // Finalize playing a card only after its Cost Step has been successfully completed.
  const finalizePlayCard = (handCard: CardInstance, discardIds: string[], paidCost: boolean, playAsReact = false) => {
    if (gameState.pendingEndPhaseDiscardPlayerId || (gameState.pendingExitPrevention && !gameState.pendingExitPrevention.usedActivatedPrevention) || gameState.reactionWindow || !isMyTurn || winnerName) return;
    const isReactPlay = handCard.card.type === 'Magic' && (playAsReact || handCard.card.subtype === 'React');
    if (gameState.currentPhase !== 'MAIN' && !isReactPlay) {
      showNotification('การ์ดนี้เล่นได้เฉพาะใน Main Phase');
      return;
    }
    const requiredCost = handCard.card.cost ?? 0;
    const requiresGemPayment =
      (handCard.card.type === 'Avatar' || handCard.card.type === 'Construct') && requiredCost > 0;

    if (
      (requiresGemPayment &&
        (!paidCost || !validateGemPayment(me.hand, handCard, discardIds, requiredCost).valid)) ||
      (!requiresGemPayment && discardIds.length > 0)
    ) {
      showNotification('เลือก GEM ที่ถูกต้องและเพียงพอก่อนยืนยัน Cost');
      return;
    }

    if (handCard.card.type === 'Construct') {
      if (me.constructZone.length >= 3 || me.constructZone.some(card => card.card.name === handCard.card.name)) {
        showNotification(me.constructZone.length >= 3
          ? 'Construct Zone เต็มแล้ว (สูงสุด 3 ใบ)'
          : 'ห้ามมี Construct ชื่อซ้ำกันใน Zone ของผู้เล่นคนเดียวกัน');
        return;
      }
    }

    setPendingCost(null);
    const discardedCards = me.hand.filter(c => discardIds.includes(c.instanceId));
    const remainingHand = me.hand.filter(
      c => c.instanceId !== handCard.instanceId && !discardIds.includes(c.instanceId)
    );

    const parsed = parseCardAbility(handCard.card);
    let nextState: GameState = { ...gameState };
    const updatedMe = { ...me, hand: remainingHand, hell: [...me.hell, ...discardedCards] };

    if (handCard.card.type === 'Avatar') {
      const summoned: CardInstance = { ...handCard, isFaceUp: true, isRested: false };
      updatedMe.avatarZone = [...updatedMe.avatarZone, summoned];
      nextState.players = { ...nextState.players, [meId]: updatedMe };
      nextState = recomputeContinuousAuras(nextState);
      nextState = appendLogs(
        nextState,
        [`${me.name} อัญเชิญ Avatar "${handCard.card.name}"${discardedCards.length > 0 ? ` (จ่าย Cost ${discardedCards.length} ใบ)` : ''}`],
        'CARD_SUMMONED'
      );

      const summonWindow = openReactionWindow(
        nextState,
        {
          type: 'AVATAR_SUMMONED',
          actorId: meId,
          targetInstanceId: summoned.instanceId,
          targetCardName: summoned.card.name,
          sourceCardName: summoned.card.name
        },
        paidCost && parsed.hasJuti
          ? { type: 'SUMMON_JUTI', actorId: meId, sourceCard: summoned, paidCost }
          : undefined
      );
      if (summonWindow !== nextState) {
        setGameState(summonWindow);
        showNotification(`อัญเชิญ "${summoned.card.name}" — เปิด Reaction Window ให้ผู้เล่นตามลำดับสิทธิ์`);
        return;
      }

      // Trigger จุติ if paid Cost and card has จุติ
      if (paidCost && parsed.hasJuti) {
        if (parsed.needsTargetAvatar) {
          setGameState(nextState);
          setPendingAbility({
            sourceCard: summoned,
            triggerType: 'SUMMON_JUTI',
            targetScope: parsed.targetScope === 'NONE' ? 'ANY_AVATAR' : parsed.targetScope,
            prompt: `ความสามารถ จุติ ของ "${summoned.card.name}": คลิกเลือก Avatar เป้าหมายบนสนาม`
          });
          showNotification(`เลือก Avatar เป้าหมายสำหรับ จุติ ของ "${summoned.card.name}"`);
          return;
        } else {
          const res = executeCardAbility(nextState, meId, summoned, 'SUMMON_JUTI');
          nextState = appendLogs(res.state, res.logs, 'ABILITY');
        }
      }

      setGameState(nextState);
      showNotification(`อัญเชิญ "${handCard.card.name}" สำเร็จ!`);
      return;
    }

    if (handCard.card.type === 'Construct') {
      const movement = moveCardBetweenZones(gameState, {
        instanceId: handCard.instanceId,
        actorId: meId,
        destination: 'constructZone',
        destinationPlayerId: meId
      });
      if (!movement.ok) {
        showNotification(movement.reason ?? 'วาง Construct ไม่สำเร็จ');
        return;
      }
      const movedPlayer = movement.state.players[meId];
      nextState = {
        ...movement.state,
        players: {
          ...movement.state.players,
          [meId]: { ...movedPlayer, hand: remainingHand, hell: [...me.hell, ...discardedCards] }
        }
      };
      nextState = recomputeContinuousAuras(nextState);
      nextState = appendLogs(nextState, [`${me.name} วาง Construct "${handCard.card.name}" ลงใน Construct Zone`], 'CONSTRUCT');
      setGameState(nextState);
      showNotification(`วาง Construct "${handCard.card.name}" สำเร็จ!`);
      return;
    }

    if (handCard.card.type === 'Magic') {
      const subtype = playAsReact ? 'React' : ((handCard.card.subtype || 'Normal') as MagicSubtype);
      const restriction = validateMagicPlay(gameState, meId, subtype, playAsReact);
      if (restriction) {
        showNotification(restriction);
        return;
      }
      const newUsedTypes = new Set(updatedMe.usedMagicTypesThisTurn);
      newUsedTypes.add(subtype);
      updatedMe.usedMagicTypesThisTurn = newUsedTypes;
      if (subtype === 'React') {
        updatedMe.reactMagicBudget = {
          ...updatedMe.reactMagicBudget,
          ownTurnRemaining: Math.max(0, updatedMe.reactMagicBudget.ownTurnRemaining - 1)
        };
      }

      if (subtype === 'Land') {
        // Replace previous Land Magic
        if (nextState.landMagicZone) {
          const prevOwner = nextState.players[nextState.landMagicZone.ownerId];
          if (prevOwner) {
            nextState.players = {
              ...nextState.players,
              [prevOwner.id]: { ...prevOwner, hell: [...prevOwner.hell, nextState.landMagicZone] }
            };
          }
        }
        nextState.landMagicZone = { ...handCard, isFaceUp: true };
        nextState.players = { ...nextState.players, [meId]: updatedMe };
        nextState = recomputeContinuousAuras(nextState);
        nextState = appendLogs(nextState, [`🏔️ ${me.name} ร่าย Land Magic "${handCard.card.name}" ลงใน Land Magic Zone`], 'MAGIC_LAND');
        setGameState(nextState);
        showNotification(`เปิดใช้งาน Land Magic "${handCard.card.name}"!`);
        return;
      }

      if (subtype === 'Modification') {
        if (updatedMe.avatarZone.length === 0) {
          showNotification('ต้องมี Avatar บนสนามก่อนจึงจะสวมใส่ Modification Magic ได้');
          return;
        }
        nextState.players = { ...nextState.players, [meId]: updatedMe };
        setGameState(nextState);
        setPendingAbility({
          sourceCard: handCard,
          triggerType: 'EQUIP_MODIFICATION',
          targetScope: 'OWN_AVATAR',
          prompt: `เลือก Avatar ฝ่ายเราเพื่อสวมใส่ "${handCard.card.name}"`
        });
        showNotification(`คลิกเลือก Avatar ของคุณเพื่อสวมใส่ "${handCard.card.name}"`);
        return;
      }

      // Normal or React Magic: Put in Magic Zone (or Hell) before resolving its effect.
      updatedMe.magicZone = [...updatedMe.magicZone, { ...handCard, isFaceUp: true }];
      nextState.players = { ...nextState.players, [meId]: updatedMe };

      if (subtype !== 'React' && !parsed.needsTargetAvatar) {
        const magicWindow = openReactionWindow(
          nextState,
          { type: 'MAGIC_PLAYED', actorId: meId, sourceCardName: handCard.card.name },
          { type: 'RESOLVE_MAGIC', actorId: meId, sourceCard: handCard }
        );
        if (magicWindow !== nextState) {
          setGameState(magicWindow);
          showNotification(`ร่าย "${handCard.card.name}" — เปิด Reaction Window ก่อนออกผล`);
          return;
        }
      }

      if (parsed.needsTargetAvatar) {
        setGameState(nextState);
        setPendingAbility({
          sourceCard: handCard,
          triggerType: 'MAGIC_CAST',
          targetScope: parsed.targetScope === 'NONE' ? 'ANY_AVATAR' : parsed.targetScope,
          prompt: `ร่าย "${handCard.card.name}": คลิกเลือก Avatar เป้าหมายบนสนาม`
        });
        showNotification(`เลือก Avatar เป้าหมายสำหรับ "${handCard.card.name}"`);
        return;
      } else {
        const res = executeCardAbility(nextState, meId, handCard, 'MAGIC_CAST');
        nextState = appendLogs(res.state, [`✨ ร่าย Magic "${handCard.card.name}"`, ...res.logs], 'MAGIC');
        setGameState(nextState);
        showNotification(res.logs[0] || `ร่าย "${handCard.card.name}" สำเร็จ!`);
        return;
      }
    }
  };

  // Handle clicking an Avatar on the field (for Ability Target OR Combat)
  const handleAvatarClick = (avatar: CardInstance, isMyAvatar: boolean) => {
    if (gameState.pendingEndPhaseDiscardPlayerId || (gameState.pendingExitPrevention && !gameState.pendingExitPrevention.usedActivatedPrevention)) return;
    // 1. Resolve Pending Ability / Modification Equip Target
    if (pendingAbility) {
      if (pendingAbility.targetScope === 'OWN_AVATAR' && !isMyAvatar) {
        showNotification('กรุณาเลือก Avatar ฝ่ายเราเท่านั้น');
        return;
      }
      if (pendingAbility.targetScope === 'OPPONENT_AVATAR' && isMyAvatar) {
        showNotification('กรุณาเลือก Avatar ฝ่ายตรงข้ามเท่านั้น');
        return;
      }
      if (pendingAbility.reaction) {
        const window = gameState.reactionWindow;
        if (!window) return;
        if (link && !isHost) {
          link.send({
            type: 'REACTION_COMMAND',
            command: {
              kind: 'PLAY',
              playerId: meId,
              windowId: window.id,
              expectedRevision: window.revision,
              cardInstanceId: pendingAbility.sourceCard.instanceId,
              targetInstanceId: avatar.instanceId
            }
          });
          setPendingAbility(null);
          return;
        }
        const queued = queueReactionCard(
          gameState,
          meId,
          pendingAbility.sourceCard.instanceId,
          avatar.instanceId
        );
        if ('reason' in queued) {
          showNotification(queued.reason);
          return;
        }
        const nextState = appendLogs(
          queued.state,
          [`${pendingAbility.sourceCard.card.name} วางลงบน Chain — รอการตอบโต้หรือผ่านสิทธิ์`],
          'REACTION',
          meId
        );
        setPendingAbility(null);
        setGameState(nextState);
        return;
      }

      if (pendingAbility.triggerType === 'EQUIP_MODIFICATION') {
        let nextState = { ...gameState };
        const updatedAvatars = me.avatarZone.map(a =>
          a.instanceId === avatar.instanceId
            ? { ...a, attachedInstances: [...(a.attachedInstances || []), pendingAbility.sourceCard] }
            : a
        );
        nextState.players = { ...nextState.players, [meId]: { ...me, avatarZone: updatedAvatars } };
        nextState = recomputeContinuousAuras(nextState);
        nextState = appendLogs(
          nextState,
          [`🛡️ สวมใส่ "${pendingAbility.sourceCard.card.name}" ให้กับ "${avatar.card.name}"`],
          'EQUIP'
        );
        setGameState(nextState);
        setPendingAbility(null);
        showNotification(`สวมใส่ "${pendingAbility.sourceCard.card.name}" สำเร็จ!`);
        return;
      }

      if (
        pendingAbility.triggerType === 'MAGIC_CAST' &&
        !isNormalMagicTreatedAsReact(pendingAbility.sourceCard.card) &&
        pendingAbility.sourceCard.card.subtype !== 'React'
      ) {
        const magicWindow = openReactionWindow(
          gameState,
          {
            type: 'MAGIC_PLAYED',
            actorId: meId,
            targetInstanceId: avatar.instanceId,
            targetCardName: avatar.card.name,
            sourceCardName: pendingAbility.sourceCard.card.name,
            sourceInstanceId: pendingAbility.sourceCard.instanceId
          },
          {
            type: 'RESOLVE_MAGIC',
            actorId: meId,
            sourceCard: pendingAbility.sourceCard,
            targetAvatarId: avatar.instanceId
          }
        );
        if (magicWindow !== gameState) {
          setGameState(magicWindow);
          setPendingAbility(null);
          showNotification(`ร่าย "${pendingAbility.sourceCard.card.name}" — เปิด Reaction Window ก่อนออกผล`);
          return;
        }
      }

      const res = executeCardAbility(
        gameState,
        meId,
        pendingAbility.sourceCard,
        pendingAbility.triggerType,
        avatar.instanceId
      );
      const nextState = appendLogs(res.state, res.logs, 'ABILITY');
      setGameState(nextState);
      setPendingAbility(null);
      showNotification(res.logs[0] || 'เปิดใช้งานความสามารถสำเร็จ!');
      return;
    }

    if (gameState.reactionWindow) {
      setInspectedCard(avatar);
      return;
    }

    // 2. Non-Battle Phase -> Inspect Card
    if (gameState.currentPhase !== 'BATTLE' || !isMyTurn || winnerName) {
      setInspectedCard(avatar);
      return;
    }

    // 3. Battle Phase: Click own Avatar
    if (isMyAvatar) {
      if (selectedAttackerId && selectedAttackerId !== avatar.instanceId && !avatar.isRested &&
        (avatarHasKeyword(avatar, 'สามัคคี') || avatarHasKeyword(avatar, 'แทงหลัง'))) {
        const keyword = avatarHasKeyword(avatar, 'สามัคคี') ? 'สามัคคี' : 'แทงหลัง';
        const nextState = payCombatKeyword(gameState, selectedAttackerId, avatar.instanceId, keyword);
        if (!nextState) {
          showNotification('ไม่สามารถใช้ความสามารถสนับสนุนการโจมตีนี้ได้');
          return;
        }
        const bonus = nextState.players[meId].avatarZone.find(card => card.instanceId === selectedAttackerId)
          ?.layerModifiers.at(-1)?.powerMod ?? 0;
        setGameState(appendLogs(nextState, [`"${avatar.card.name}" ใช้ ${keyword} และเพิ่ม POWER ${bonus >= 0 ? '+' : ''}${bonus}`], 'ABILITY'));
        showNotification(`${keyword}: POWER ${bonus >= 0 ? '+' : ''}${bonus} ให้ตัวโจมตี`);
        return;
      }

      if (isAttackLockedInFirstRound) {
        showNotification('โหมดอัดมั่ว: ห้ามโจมตีจนกว่าผู้เล่นคนสุดท้ายของรอบแรกจะได้เล่นเทิร์น');
        return;
      }

      if (avatar.isRested) {
        showNotification('Avatar ใบนี้อยู่ในสภาพนอน (โจมตีไปแล้ว)');
        return;
      }

      const attackWindow = openReactionWindow(
        gameState,
        {
          type: 'ATTACK_DECLARED',
          actorId: meId,
          targetInstanceId: avatar.instanceId,
          targetCardName: avatar.card.name,
          sourceCardName: avatar.card.name
        },
        { type: 'START_ATTACK', actorId: meId, sourceCard: avatar }
      );
      if (attackWindow !== gameState) {
        setGameState(attackWindow);
        showNotification(`ประกาศโจมตีด้วย "${avatar.card.name}" — เปิด Reaction Window`);
        return;
      }

      // Trigger "เมื่อโจมตี" (ON_ATTACK) when selected as attacker
      let nextState: GameState = { ...gameState };
      const parsed = parseCardAbility(avatar.card);
      if (parsed.hasOnAttack) {
        const res = executeCardAbility(nextState, meId, avatar, 'ON_ATTACK');
        nextState = appendLogs(res.state, res.logs, 'ABILITY');
        setGameState(nextState);
      }

      setSelectedAttackerId(avatar.instanceId);
      showNotification(`เลือก "${avatar.card.name}" โจมตี! คลิกเป้าหมายฝ่ายตรงข้ามหรือ LIFE`);
      return;
    }

    // 4. Battle Phase: Click Opponent Avatar as target
    if (!selectedAttackerId) {
      setInspectedCard(avatar);
      return;
    }

    const attacker = me.avatarZone.find(c => c.instanceId === selectedAttackerId);
    if (!attacker) return;

    // Enforce โล่มนุษย์ (Human Shield)
    const shieldAvatars = opponent.avatarZone.filter(a => avatarHasKeyword(a, 'โล่มนุษย์'));
    const canBypassShield = avatarHasKeyword(attacker, 'แทงหลัง') || avatarHasKeyword(attacker, 'เตะไข่');
    if (shieldAvatars.length > 0 && !avatarHasKeyword(avatar, 'โล่มนุษย์') && !canBypassShield) {
      showNotification(`⚠️ ฝ่ายตรงข้ามมี "${shieldAvatars[0].card.name}" (โล่มนุษย์) ต้องโจมตีตัวโล่มนุษย์ก่อน!`);
      return;
    }

    const targetWindow = openReactionWindow(
      gameState,
      {
        type: 'AVATAR_TARGETED',
        actorId: meId,
        targetInstanceId: avatar.instanceId,
        targetCardName: avatar.card.name,
        sourceCardName: attacker.card.name
      },
      {
        type: 'RESOLVE_COMBAT',
        actorId: meId,
        sourceCard: attacker,
        targetPlayerId: opponentId,
        targetAvatarId: avatar.instanceId
      }
    );
    if (targetWindow !== gameState) {
      setGameState(targetWindow);
      showNotification(`"${avatar.card.name}" เป็นเป้าหมายโจมตี — เปิด Reaction Window`);
      return;
    }

    const combatResult = resolveCombatAction(gameState, meId, opponentId, attacker.instanceId, avatar.instanceId);
    setGameState(combatResult.state);
    setSelectedAttackerId(null);
    showNotification(combatResult.events[combatResult.events.length - 1] ?? 'การต่อสู้สิ้นสุดลง');
  };

  // Attack Opponent LIFE Zone Directly
  const handleAttackLifeZone = () => {
    if (gameState.pendingEndPhaseDiscardPlayerId || (gameState.pendingExitPrevention && !gameState.pendingExitPrevention.usedActivatedPrevention) || gameState.reactionWindow || gameState.currentPhase !== 'BATTLE' || !isMyTurn || winnerName) return;
    if (!selectedAttackerId) {
      showNotification('กรุณาเลือก Avatar ของคุณที่จะโจมตีก่อน');
      return;
    }

    const attacker = me.avatarZone.find(c => c.instanceId === selectedAttackerId);
    if (!attacker) return;

    const hasOpponentAvatars = opponent.avatarZone.length > 0;
    const canEggKick = avatarHasKeyword(attacker, 'เตะไข่');

    if (hasOpponentAvatars && !canEggKick) {
      showNotification('ไม่สามารถโจมตี LIFE ได้โดยตรงหากฝ่ายตรงข้ามยังมี Avatar (เว้นแต่มี "เตะไข่")');
      return;
    }

    const declared = declareCombatAttack(gameState, attacker.instanceId, { type: 'LIFE', playerId: opponentId });
    if (!declared) {
      showNotification('การโจมตี LIFE ไม่ถูกต้อง');
      return;
    }
    const battle = resolveDeclaredBattle(declared);
    if (!battle.ok) {
      showNotification(battle.reason ?? 'การโจมตี LIFE ไม่สำเร็จ');
      return;
    }
    let nextState = appendLogs(battle.state, battle.events, 'ATTACK_LIFE');
    const lifeRes = { isGameOver: battle.events.some(event => event.includes('lost the game')) };

    if (lifeRes.isGameOver) {
      if (gameState.mode === 'AD_MUA') {
        const elimination = eliminatePlayer(nextState, opponentId, 'LIFE หมดและถูกกำจัดออกจากเกม (การ์ดทั้งหมดถูกนำออกจากเกม)');
        nextState = elimination.state;
        if (elimination.winnerId) setWinnerName(nextState.players[elimination.winnerId].name);
      } else {
        setWinnerName(me.name);
      }
    }

    setGameState(nextState);
    setSelectedAttackerId(null);
    showNotification(battle.events.join(' '));
  };

  // Toggle Construct Activation
  const handleConstructClick = (cons: CardInstance) => {
    if (gameState.pendingEndPhaseDiscardPlayerId || (gameState.pendingExitPrevention && !gameState.pendingExitPrevention.usedActivatedPrevention)) return;
    if (gameState.reactionWindow || !isMyTurn || gameState.currentPhase !== 'MAIN') {
      setInspectedCard(cons);
      return;
    }
    const abilityWindow = openReactionWindow(
      gameState,
      { type: 'ABILITY_USED', actorId: meId, sourceCardName: cons.card.name },
      { type: 'RESOLVE_ABILITY', actorId: meId, sourceCard: cons, abilityTrigger: 'CONSTRUCT_ACTIVATE' }
    );
    if (abilityWindow !== gameState) {
      setGameState(abilityWindow);
      showNotification(`ใช้ความสามารถ "${cons.card.name}" — เปิด Reaction Window`);
      return;
    }
    const res = executeCardAbility(gameState, meId, cons, 'CONSTRUCT_ACTIVATE');
    if (res.logs.length > 0) {
      setGameState(appendLogs(res.state, res.logs, 'CONSTRUCT'));
      showNotification(res.logs[0]);
    } else {
      setInspectedCard(cons);
    }
  };

  return (
    <div className="flex flex-col h-[100dvh] w-screen bg-slate-950 select-none overflow-hidden text-slate-200 font-kanit">
      {/* Top Header Bar */}
      <header className="shrink-0 min-h-11 bg-slate-900 border-b border-slate-800 px-2 sm:px-3 py-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 z-30 sm:flex-nowrap">
        <div className="flex items-center space-x-2">
          <span className="font-extrabold text-amber-500 tracking-wider flex items-center gap-1 text-xs sm:text-sm">
            <Flame className="w-4 h-4 text-red-500 fill-red-500" />
            ศึกตลิ่งชัน ONLINE
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 font-mono">
            TURN {gameState.turnNumber}
          </span>
        </div>

        {/* Controls */}
        <div className="flex items-center space-x-1.5">
          <button
            type="button"
            onClick={() => setShowEventLog(open => !open)}
            aria-label={showEventLog ? 'Close event log' : 'Open event log'}
            aria-controls={showEventLog ? 'event-log' : undefined}
            aria-expanded={showEventLog}
            className={`px-2 py-1 rounded-lg text-[11px] font-medium flex items-center gap-1 border transition ${showEventLog ? 'bg-amber-500/15 border-amber-500/40 text-amber-200' : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300'}`}
          >
            <List className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Logs</span>
          </button>
          <button
            onClick={() => setShowKeywordsModal(true)}
            className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-medium flex items-center gap-1 border border-slate-700"
          >
            <BookOpen className="w-3.5 h-3.5 text-amber-400" />
            <span className="hidden sm:inline">Keyword</span>
          </button>

          {isMyTurn ? (
            gameState.currentPhase === 'DRAW' ? (
              <button
                onClick={handleDrawPhase}
                className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center gap-1 shadow transition"
              >
                <Play className="w-3.5 h-3.5" />
                <span>จั่วการ์ด (Draw)</span>
              </button>
            ) : (
              <button
                onClick={handleNextPhase}
                className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex items-center gap-1 shadow transition"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>
                  {gameState.currentPhase === 'MAIN' && gameState.turnNumber === 1 && gameState.currentTurnPlayerIndex === 0 && 'ข้าม Battle → End Phase'}
                  {gameState.currentPhase === 'MAIN' && !(gameState.turnNumber === 1 && gameState.currentTurnPlayerIndex === 0) && 'เข้า Battle Phase'}
                  {gameState.currentPhase === 'BATTLE' && 'เข้า End Phase'}
                  {gameState.currentPhase === 'END' && 'จบเทิร์น'}
                </span>
              </button>
            )
          ) : (
            <span className="text-xs text-amber-400 font-medium animate-pulse flex items-center gap-1 px-2">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              {isEliminated ? 'คุณถูกกำจัดแล้ว' : `เทิร์นของ ${gameState.players[activePlayerId]?.name ?? 'คู่แข่ง'}...`}
            </span>
          )}
        </div>
      </header>

      {gameState.pendingExitPrevention?.preventionPlayerId === meId && !gameState.pendingExitPrevention.usedActivatedPrevention && (() => {
        const pending = gameState.pendingExitPrevention;
        const target = Object.values(gameState.players).flatMap(player => [...player.avatarZone, ...player.constructZone])
          .find(card => card.instanceId === pending.targetCardId);
        const abilities = target?.preventionShields?.filter(shield => shield.kind === 'DESTRUCTION' && shield.mode === 'ACTIVATED') ?? [];
        return <section aria-label="Exit prevention choice" aria-live="polite" className="z-30 flex flex-wrap items-center gap-2 border-b border-sky-400/40 bg-sky-950/95 px-3 py-2 text-xs text-sky-100">
          <p className="mr-auto">{target?.card.name ?? 'การ์ด'} กำลังจะออกจากสนาม — ใช้การป้องกันแบบสั่งใช้ได้หนึ่งครั้ง</p>
          {abilities.map(ability => <button key={ability.id} type="button" onClick={() => resolveExitChoice(ability.id)} className="rounded bg-sky-300 px-3 py-1.5 font-bold text-slate-950">ใช้การป้องกัน</button>)}
          <button type="button" onClick={() => resolveExitChoice()} className="rounded border border-sky-200 px-3 py-1.5">ไม่ใช้ / ดำเนินการต่อ</button>
        </section>;
      })()}

      {gameState.pendingEndPhaseDiscardPlayerId === meId && pendingEndPhaseDiscards !== null && (
        <section aria-label="End Phase hand discard" aria-live="polite" className="z-30 flex flex-wrap items-center gap-2 border-b border-amber-400/40 bg-amber-950/95 px-3 py-2 text-xs text-amber-100">
          <p className="mr-auto">เลือก {Math.max(0, me.hand.length - 7)} ใบเพื่อทิ้งลงนรก ({pendingEndPhaseDiscards.length} เลือกแล้ว){isSubmittingEndPhaseDiscard ? ' — กำลังรอการยืนยันจากเจ้าของห้อง' : ''}</p>
          <button type="button" disabled={isSubmittingEndPhaseDiscard} onClick={() => setPendingEndPhaseDiscards([])} className="rounded border border-slate-500 px-3 py-1.5 disabled:opacity-50">ล้างที่เลือก</button>
          <button type="button" disabled={isSubmittingEndPhaseDiscard || pendingEndPhaseDiscards.length !== Math.max(0, me.hand.length - 7)} onClick={confirmEndPhaseDiscards} className="rounded bg-amber-400 px-3 py-1.5 font-bold text-slate-950 disabled:opacity-50">{isSubmittingEndPhaseDiscard ? 'กำลังส่ง…' : 'ยืนยันการทิ้ง'}</button>
        </section>
      )}

      {gameState.reactionWindow && (
        <section aria-label="Reaction Chain" aria-live="polite" className="z-30 flex flex-col gap-2 border-b border-amber-500/40 bg-amber-950/95 px-3 py-2 text-xs text-amber-100 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <strong>Reaction Window · {gameState.reactionWindow.trigger.type}</strong>
              <span>สิทธิ์: {gameState.players[gameState.reactionWindow.priorityPlayerId]?.name ?? 'ผู้เล่น'}</span>
              <span>{gameState.reactionWindow.priorityPlayerId === meId ? `${getEligibleReactionCards(gameState, meId).length} ใบที่ใช้ได้` : 'รอคู่แข่ง'}</span>
            </div>
            <ol aria-label="ลำดับ Chain จากใบแรกไปใบล่าสุด" className="flex max-w-full items-center gap-1 overflow-x-auto">
              <li className="shrink-0 rounded border border-slate-500/60 bg-slate-900 px-2 py-1 text-[10px] text-slate-200">
                0 · การกระทำเดิม
              </li>
              {(gameState.reactionWindow.chain ?? []).map((entry, index) => {
                const isReact = entry.entryType === 'REACT_MAGIC';
                const label = isReact ? entry.sourceCard.card.name : `${entry.entryType === 'TRIGGER_ABILITY' ? 'Trigger' : 'Ability'} · ${entry.triggerId}`;
                const entryId = isReact ? entry.sourceCard.instanceId : entry.triggerId;
                return (
                  <li key={`${entryId}-${index}`} className="shrink-0 rounded border border-amber-300/50 bg-amber-900/70 px-2 py-1 text-[10px] font-semibold">
                    {index + 1} · {label}{!isReact && entry.cancelled ? ' · ยกเลิกแล้ว' : ''}
                  </li>
                );
              })}
            </ol>
          </div>
          {gameState.reactionWindow.priorityPlayerId === meId && !gameState.reactionWindow.pendingReaction && (
            <button
              type="button"
              onClick={handleReactionPass}
              className="min-h-9 shrink-0 rounded-md border border-amber-300/60 bg-amber-400 px-3 py-1 font-bold text-slate-950 hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              ผ่านสิทธิ์ตอบโต้
            </button>
          )}
        </section>
      )}

      {/* Pending Ability Target Banner */}
      {pendingAbility && (
        <div className="bg-amber-500 text-slate-950 font-bold text-xs px-4 py-1.5 flex items-center justify-between z-30 shadow-lg">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 animate-pulse" />
            <span>{pendingAbility.prompt}</span>
          </div>
          {(!pendingAbility.reaction || (link && !isHost)) && (
            <button
              onClick={() => setPendingAbility(null)}
              className="px-2 py-0.5 rounded bg-slate-950/20 hover:bg-slate-950/30 text-[11px]"
            >
              ข้าม/ยกเลิก
            </button>
          )}
        </div>
      )}

      {isEliminated && !winnerName && (
        <div role="status" className="bg-red-950 text-red-200 text-xs font-semibold px-4 py-1.5 z-30 border-b border-red-800">
          คุณถูกกำจัดออกจากเกมแล้ว — กำลังรับชมจนจบเกม
        </div>
      )}

      {isAttackLockedInFirstRound && !isEliminated && (
        <div role="status" className="bg-purple-950 text-purple-200 text-[11px] px-4 py-1 z-30 border-b border-purple-800">
          โหมดอัดมั่ว: รอบแรกห้ามโจมตี จนกว่าผู้เล่นคนสุดท้ายของรอบจะได้เล่นเทิร์น (เทิร์น {gameState.turnNumber}/{Object.keys(gameState.players).length})
        </div>
      )}

      {/* Main Playmat + Side Event Log */}
      <main className="flex-1 flex overflow-hidden relative">
        {/* Official Playmat Arena */}
        <div className="flex-1 flex flex-col justify-between p-1.5 sm:p-3 overflow-y-auto bg-gradient-to-b from-slate-900 via-slate-950 to-slate-900">
          {/* ==================== OPPONENT PLAYMAT HALF (MIRRORED) ==================== */}
          <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-1.5 sm:p-2 space-y-1.5">
            {opponentIds.length > 1 && (
              <div role="tablist" aria-label="เลือกคู่แข่ง" className="flex gap-1.5 overflow-x-auto pb-0.5">
                {opponentIds.map(id => {
                  const rival = gameState.players[id];
                  const isFocused = id === opponentId;
                  return (
                    <button
                      key={id}
                      role="tab"
                      aria-selected={isFocused}
                      onClick={() => setFocusedOpponentId(id)}
                      className={`shrink-0 px-2.5 py-1 rounded-lg border text-[10px] sm:text-[11px] text-left transition ${
                        isFocused
                          ? 'bg-red-950/70 border-red-500 text-red-100'
                          : 'bg-slate-950/70 border-slate-800 text-slate-400 hover:border-slate-600'
                      }`}
                    >
                      <span className="font-bold flex items-center gap-1">
                        {id === activePlayerId && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" aria-label="กำลังเล่นเทิร์น" />}
                        {rival.name}
                      </span>
                      <span className="block text-[9px] opacity-80">
                        LIFE {rival.lifeDeck.filter(c => !c.isFaceUp).length}/5 • Avatar {rival.avatarZone.length} • มือ {rival.hand.length}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex items-center justify-between text-[10px] sm:text-xs px-1 text-slate-400">
              <div className="flex items-center gap-2">
                <span className="font-bold text-red-400">{opponent.name}</span>
                {opponent.isCritical && (
                  <span className="bg-red-600 text-white px-1.5 py-0.5 rounded text-[9px] font-bold animate-pulse">
                    สถานะสาหัส!
                  </span>
                )}
              </div>
              <span>มือ: {opponent.hand.length} ใบ | เด็ค: {opponent.deck.length}</span>
            </div>

            {/* Opponent 3-Column Body (Mirrored: Deck/Hell Left | Avatar+Magic Center | Life Right) */}
            <div className="grid grid-cols-12 gap-1.5 sm:gap-2 items-stretch">
              {/* Left Col: Deck & Hell (2 cols) */}
              <div className="col-span-2 flex flex-col gap-1.5">
                <div className="flex-1 bg-slate-950/80 border border-slate-800 rounded-lg p-1 flex flex-col items-center justify-center text-center">
                  <span className="text-[9px] text-slate-400 font-bold">Deck กองจั่ว</span>
                  <span className="text-sm font-black text-slate-200">{opponent.deck.length}</span>
                </div>
                <div
                  onClick={() => setShowHellModal('OPPONENT')}
                  className="flex-1 bg-slate-950/80 border border-slate-800 hover:border-red-500/50 rounded-lg p-1 flex flex-col items-center justify-center text-center cursor-pointer"
                >
                  <span className="text-[9px] text-slate-400 font-bold">Hell นรก</span>
                  <span className="text-sm font-black text-red-400">{opponent.hell.length}</span>
                </div>
              </div>

              {/* Center Col: Magic Zone (top) + Avatar Zone (bottom, facing center) (8 cols) */}
              <div className="col-span-8 flex flex-col gap-1.5">
                {/* Opponent Magic Zone */}
                <div className="min-h-[42px] bg-slate-950/50 border border-slate-800/80 rounded-lg px-2 py-1 flex items-center justify-between text-[10px] text-slate-500">
                  <span className="font-semibold">Magic Zone (คู่แข่ง)</span>
                  <span>{opponent.magicZone.length} ใบที่ใช้แล้ว</span>
                </div>

                {/* Opponent Avatar Zone (Max 4) */}
                <div className="min-h-[115px] sm:min-h-[135px] bg-slate-950/60 border-2 border-slate-800 rounded-xl p-1.5 flex items-center justify-center gap-2 relative">
                  {opponent.avatarZone.length === 0 ? (
                    <span className="text-[11px] text-slate-600">Avatar Zone คู่แข่ง (สูงสุด 4 ใบ)</span>
                  ) : (
                    opponent.avatarZone.map(avatar => (
                      <div key={avatar.instanceId} className="relative">
                        <CardView
                          cardInstance={avatar}
                          size="sm"
                          isRested={avatar.isRested}
                          isOpponent
                          onClick={() => handleAvatarClick(avatar, false)}
                          onInspect={() => setInspectedCard(avatar)}
                        />
                        {(selectedAttackerId || pendingAbility) && (
                          <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 bg-red-600 text-white text-[8px] px-1.5 py-0.5 rounded shadow pointer-events-none">
                            เป้าหมาย
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Right Col: Opponent Life Zone (2 cols) */}
              <div
                onClick={handleAttackLifeZone}
                className={`col-span-2 bg-slate-950/90 border-2 rounded-xl p-1.5 flex flex-col items-center justify-center cursor-pointer transition ${
                  selectedAttackerId
                    ? 'border-red-500 bg-red-950/30 ring-2 ring-red-500/40 animate-pulse'
                    : 'border-slate-800 hover:border-red-500/50'
                }`}
                title="คลิกเพื่อโจมตี LIFE คู่แข่ง"
              >
                <span className="text-[10px] font-bold text-red-400 mb-1 flex items-center gap-0.5">
                  <Shield className="w-3 h-3" /> Life ({opponent.lifeDeck.filter(c => !c.isFaceUp).length}/5)
                </span>
                <div className="flex flex-wrap justify-center gap-1">
                  {opponent.lifeDeck.map((lifeCard, idx) => (
                    <div
                      key={lifeCard.instanceId || idx}
                      onClick={event => {
                        if (lifeCard.isFaceUp) event.stopPropagation();
                      }}
                    >
                      <LifeCardTile
                        card={lifeCard}
                        index={idx}
                        compact
                        onInspect={() => setInspectedCard(lifeCard)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <PhaseTracker
            currentPhase={gameState.currentPhase}
            turnNumber={gameState.turnNumber}
            activePlayerName={gameState.players[activePlayerId]?.name ?? ''}
            isMyTurn={isMyTurn}
          />

          {/* ==================== SHARED CENTER & MY TOP ROW (Matches Playmat Top Row!) ==================== */}
          {/* Construct Zone (Left 37%) | Land Magic Zone (Center 26%) | Dark Dimension (Right 37%) */}
          <div className="grid grid-cols-12 gap-2 my-1.5 items-stretch">
            {/* Construct Zone (Left ~37% -> 4.5 cols, use col-span-5) */}
            <div className="col-span-5 bg-slate-900/90 border-2 border-slate-700 rounded-xl p-1.5 sm:p-2 flex flex-col justify-between min-h-[70px]">
              <div className="flex items-center justify-between text-[10px]">
                <span className="font-bold text-slate-200">Construct Zone</span>
                <span className="text-slate-400 text-[9px]">มี Construct บนสนามได้สูงสุด 3 ใบ ({me.constructZone.length}/3)</span>
              </div>
              <div className="flex items-center gap-1.5 mt-1 overflow-x-auto">
                {me.constructZone.length === 0 ? (
                  <span className="text-[10px] text-slate-600 italic">วาง Construct ที่นี่</span>
                ) : (
                  me.constructZone.map(cons => (
                    <div
                      key={cons.instanceId}
                      onClick={() => handleConstructClick(cons)}
                      className="px-2 py-1 rounded bg-slate-800 border border-amber-500/40 text-[10px] font-semibold text-amber-300 cursor-pointer hover:bg-slate-700 shrink-0"
                    >
                      {cons.card.name}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Land Magic Zone (Center ~20% -> col-span-2) */}
            <div
              onClick={() => gameState.landMagicZone && setInspectedCard(gameState.landMagicZone)}
              className="col-span-2 bg-slate-900/90 border-2 border-amber-500/50 rounded-xl p-1.5 flex flex-col items-center justify-center text-center cursor-pointer hover:border-amber-400 transition"
            >
              <span className="text-[10px] font-bold text-amber-400 leading-tight">Land Magic Zone</span>
              {gameState.landMagicZone ? (
                <span className="text-[10px] text-white font-semibold mt-1 truncate max-w-full">
                  {gameState.landMagicZone.card.name}
                </span>
              ) : (
                <span className="text-[9px] text-slate-500 mt-0.5">ว่าง</span>
              )}
            </div>

            {/* Right Zone (Opponent Construct / Dark Dimension) (col-span-5) */}
            <div className="col-span-5 bg-slate-900/60 border-2 border-slate-800 rounded-xl p-1.5 sm:p-2 flex flex-col justify-between min-h-[70px]">
              <div className="flex items-center justify-between text-[10px]">
                <span className="font-bold text-slate-400">มิติมืด (Dark Dimension) & Construct คู่แข่ง</span>
                <span className="text-slate-500 text-[9px]">{me.darkDimension.length} ใบ</span>
              </div>
              <div className="text-[10px] text-slate-600 italic">
                พื้นที่แยกส่วน / การ์ดที่ถูกส่งออกนอกเกม
              </div>
            </div>
          </div>

          {/* ==================== MY PLAYMAT HALF (EXACT OFFICIAL PROPORTIONS) ==================== */}
          <div className="bg-slate-900/80 border-2 border-slate-700 rounded-2xl p-2 shadow-2xl">
            <div className="grid grid-cols-12 gap-2 items-stretch">
              {/* LEFT COLUMN: LIFE ZONE (Full Height spanning Avatar + Magic rows) */}
              <div className="col-span-2 bg-slate-950/90 border-2 border-slate-700 rounded-xl p-1.5 flex flex-col items-center justify-between">
                <div className="text-center">
                  <span className="text-xs sm:text-sm font-extrabold text-emerald-400 block">Life</span>
                  <span className="text-[9px] text-slate-400">ที่วาง Life ({me.lifeDeck.filter(c => !c.isFaceUp).length}/5)</span>
                </div>

                <div className="flex flex-col gap-1 items-center my-auto py-1">
                  {me.lifeDeck.map((lifeCard, idx) => (
                    <LifeCardTile
                      key={lifeCard.instanceId || idx}
                      card={lifeCard}
                      index={idx}
                      onInspect={() => setInspectedCard(lifeCard)}
                    />
                  ))}
                </div>

                {me.isCritical && (
                  <span className="bg-red-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded animate-pulse">
                    สาหัส!
                  </span>
                )}
              </div>

              {/* CENTER COLUMN: AVATAR ZONE (TOP) + MAGIC ZONE (BOTTOM) */}
              <div className="col-span-8 flex flex-col gap-2">
                {/* AVATAR ZONE */}
                <div className="min-h-[135px] sm:min-h-[155px] bg-slate-950/80 border-2 border-slate-700 rounded-xl p-2 flex flex-col justify-between relative">
                  <div className="flex items-center justify-between text-[10px] text-slate-400">
                    <span className="font-bold text-slate-200 text-xs">Avatar Zone</span>
                    <span>มี Avatar บนสนามได้สูงสุด 4 ใบ ({me.avatarZone.length}/4)</span>
                  </div>

                  <div className="flex-1 flex items-center justify-center gap-2 sm:gap-3 py-1">
                    {me.avatarZone.length === 0 ? (
                      <span className="text-xs text-slate-500">คลิกการ์ด Avatar บนมือด้านล่างเพื่ออัญเชิญลงสนาม</span>
                    ) : (
                      me.avatarZone.map(avatar => (
                        <div key={avatar.instanceId} className="relative">
                          <CardView
                            cardInstance={avatar}
                            size="sm"
                            isRested={avatar.isRested}
                            onClick={() => handleAvatarClick(avatar, true)}
                            onInspect={() => setInspectedCard(avatar)}
                            className={
                              selectedAttackerId === avatar.instanceId
                                ? 'ring-2 ring-amber-400 scale-105 shadow-lg shadow-amber-500/40'
                                : ''
                            }
                          />
                          {selectedAttackerId === avatar.instanceId && (
                            <div className="absolute -top-2 left-1/2 -translate-x-1/2 bg-amber-500 text-slate-950 font-black text-[8px] px-1.5 py-0.5 rounded shadow">
                              โจมตี!
                            </div>
                          )}
                          {selectedAttackerId && selectedAttackerId !== avatar.instanceId && !avatar.isRested && avatarHasKeyword(avatar, 'สามัคคี') && (
                            <div className="absolute -top-2 left-1/2 -translate-x-1/2 bg-red-600 text-white font-bold text-[8px] px-1.5 py-0.5 rounded shadow animate-bounce">
                              คลิกใช้สามัคคี
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* MAGIC ZONE */}
                <div className="min-h-[85px] sm:min-h-[100px] bg-slate-950/80 border-2 border-slate-700 rounded-xl p-2 flex flex-col justify-between">
                  <div className="flex items-center justify-between text-[10px] text-slate-400">
                    <span className="font-bold text-slate-200 text-xs">Magic Zone</span>
                    <span>สามารถเล่น Magic ได้ประเภทละครั้ง ({me.magicZone.length} ใบในเทิร์น)</span>
                  </div>

                  <div className="flex items-center gap-2 overflow-x-auto py-1">
                    {me.magicZone.length === 0 ? (
                      <span className="text-[11px] text-slate-600 mx-auto">คลิกการ์ด Magic บนมือเพื่อร่ายเวทย์</span>
                    ) : (
                      me.magicZone.map(m => (
                        <div
                          key={m.instanceId}
                          onClick={() => setInspectedCard(m)}
                          className="px-2.5 py-1 rounded-lg bg-indigo-950/80 border border-indigo-500/40 text-indigo-200 text-[10px] font-semibold cursor-pointer shrink-0"
                        >
                          {m.card.name} ({m.card.subtype})
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {/* RIGHT COLUMN: HELL (TOP) + DECK (BOTTOM) */}
              <div className="col-span-2 flex flex-col gap-2">
                {/* HELL ZONE */}
                <div
                  onClick={() => setShowHellModal('ME')}
                  className="flex-1 bg-slate-950/90 border-2 border-slate-700 hover:border-red-500/60 rounded-xl p-1.5 flex flex-col items-center justify-center text-center cursor-pointer transition"
                  title="คลิกเพื่อดูการ์ดในนรก"
                >
                  <Skull className="w-4 h-4 text-red-400 mb-0.5" />
                  <span className="text-xs sm:text-sm font-extrabold text-slate-200">Hell</span>
                  <span className="text-[9px] text-slate-400">นรก ({me.hell.length})</span>
                </div>

                {/* DECK ZONE */}
                <div className="flex-1 bg-slate-950/90 border-2 border-slate-700 rounded-xl p-1.5 flex flex-col items-center justify-center text-center">
                  <Layers className="w-4 h-4 text-amber-400 mb-0.5" />
                  <span className="text-xs sm:text-sm font-extrabold text-slate-200">Deck</span>
                  <span className="text-[9px] text-slate-400">กองจั่ว ({me.deck.length})</span>
                </div>
              </div>
            </div>
          </div>

          {/* ==================== PLAYER HAND TRAY ==================== */}
          <div className="mt-1.5 bg-slate-900/95 border border-slate-700 rounded-xl p-2 flex flex-col shrink-0">
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1.5 px-1">
              <span className="font-bold text-amber-400">{gameState.pendingEndPhaseDiscardPlayerId === meId ? `เลือกการ์ดทิ้ง (${pendingEndPhaseDiscards?.length ?? 0}/${Math.max(0, me.hand.length - 7)})` : gameState.pendingEndPhaseDiscardPlayerId ? `กำลังรอ ${gameState.players[gameState.pendingEndPhaseDiscardPlayerId]?.name ?? 'ผู้เล่น'} เลือกการ์ดทิ้ง` : `การ์ดบนมือของคุณ (${me.hand.length} ใบ) — คลิกเพื่อเล่นลงสนาม`}</span>
              <span className="text-[10px]">กดปุ่ม <b className="text-amber-300">i</b> บนการ์ดเพื่อดูความสามารถก่อนลง</span>
            </div>
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {me.hand.map(handCard => (
                <CardView
                  key={handCard.instanceId}
                  cardInstance={handCard}
                  size="sm"
                  onClick={() => handleInitiatePlayCard(handCard)}
                  onInspect={() => setInspectedCard(handCard)}
                  className="shrink-0 hover:-translate-y-1.5"
                />
              ))}
            </div>
          </div>
        </div>

        {showEventLog && (
          <>
            <button
              type="button"
              aria-label="ปิดบันทึกเหตุการณ์"
              onClick={() => setShowEventLog(false)}
              className="absolute inset-0 z-30 bg-slate-950/55 lg:hidden"
            />
            <aside
              id="event-log"
              aria-label="บันทึกเหตุการณ์"
              className="absolute inset-y-0 right-0 z-40 flex w-[min(22rem,92vw)] shrink-0 flex-col border-l border-slate-800 bg-slate-900 shadow-2xl lg:relative lg:inset-auto lg:z-auto lg:w-64 lg:shadow-none"
            >
              <div className="h-9 shrink-0 px-3 border-b border-slate-800 flex items-center justify-between text-xs font-bold text-slate-300">
                <span>บันทึกเหตุการณ์ (Event Log)</span>
                <button
                  type="button"
                  aria-label="ซ่อนบันทึกเหตุการณ์"
                  onClick={() => setShowEventLog(false)}
                  className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2.5 text-[11px]">
                {gameState.eventLog.slice().reverse().map((ev, i) => (
                  <div key={`${ev.timestamp}-${i}`} className="rounded-lg border border-slate-800/80 bg-slate-950/90 p-2 leading-relaxed text-slate-300">
                    {ev.description}
                  </div>
                ))}
              </div>
            </aside>
          </>
        )}
      </main>

      {/* Notification Banner */}
      {notification && (
        <div className="fixed top-14 left-1/2 -translate-x-1/2 z-50 bg-amber-500 text-slate-950 font-bold px-4 py-1.5 rounded-full shadow-2xl text-xs flex items-center gap-1.5">
          <Swords className="w-3.5 h-3.5" />
          <span>{notification}</span>
        </div>
      )}

      {/* Gem Cost Payment Modal */}
      {pendingCost && (() => {
        const selectedCards = me.hand.filter(c => pendingCost.selectedDiscardIds.includes(c.instanceId));
        const selectedTotal = getSelectedGemTotal(me.hand, pendingCost.selectedDiscardIds);
        const paymentValidation = validateGemPayment(
          me.hand,
          pendingCost.handCard,
          pendingCost.selectedDiscardIds,
          pendingCost.requiredCost
        );
        const actionLabel = pendingCost.handCard.card.type === 'Avatar' ? 'อัญเชิญ' : 'ก่อสร้าง';

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="gem-payment-title"
              className="max-h-[92vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-2xl border border-amber-500/50 bg-slate-900 p-4 shadow-2xl"
            >
              <div className="flex items-center justify-between gap-3">
                <h3 id="gem-payment-title" className="text-sm font-bold text-amber-400">
                  เลือก GEM เพื่อ{actionLabel} "{pendingCost.handCard.card.name}" (Cost {pendingCost.requiredCost})
                </h3>
                <button
                  type="button"
                  aria-label="ปิดหน้าต่างชำระ Cost"
                  onClick={() => setPendingCost(null)}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-1 rounded-lg border border-slate-800 bg-slate-950 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-slate-300">ความสามารถของการ์ดที่จะลง</span>
                  <button
                    type="button"
                    onClick={() => setInspectedCard(pendingCost.handCard)}
                    className="shrink-0 text-[11px] text-amber-400 underline hover:text-amber-300"
                  >
                    ดูการ์ดเต็ม
                  </button>
                </div>
                <p className="max-h-24 overflow-y-auto whitespace-pre-line text-[11px] leading-relaxed text-slate-400">
                  {pendingCost.handCard.card.mainEffect || 'ไม่มีความสามารถพิเศษ (Normal Avatar)'}
                </p>
              </div>
              <p className="text-xs text-slate-400">
                เลือกการ์ดที่ต้องการใช้จ่ายด้วยตนเอง: GEM 0 ใช้ไม่ได้ และ GEM สีต้องตรงกับสีของการ์ดเป้าหมาย
              </p>
              <div className="flex gap-2 overflow-x-auto py-2" aria-label="เลือกการ์ด GEM จากมือ">
                {me.hand
                  .filter(c => c.instanceId !== pendingCost.handCard.instanceId)
                  .map(c => {
                    const isSelected = pendingCost.selectedDiscardIds.includes(c.instanceId);
                    const unavailableReason = getGemPaymentCardUnavailableReason(c, pendingCost.handCard);
                    const canToggle = isSelected || (!unavailableReason && selectedTotal < pendingCost.requiredCost);

                    return (
                      <div
                        key={c.instanceId}
                        className={`w-36 shrink-0 rounded-lg border-2 p-1.5 transition ${
                          isSelected ? 'border-amber-400 bg-amber-950/40' : 'border-slate-800 bg-slate-950'
                        }`}
                      >
                        <button
                          type="button"
                          disabled={!canToggle}
                          aria-pressed={isSelected}
                          onClick={() => {
                            if (!isSelected && (unavailableReason || selectedTotal >= pendingCost.requiredCost)) return;
                            setPendingCost(prev =>
                              prev
                                ? {
                                    ...prev,
                                    selectedDiscardIds: isSelected
                                      ? prev.selectedDiscardIds.filter(id => id !== c.instanceId)
                                      : [...prev.selectedDiscardIds, c.instanceId]
                                  }
                                : null
                            );
                          }}
                          className="w-full text-left disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <span className="block truncate text-[11px] font-bold text-slate-200">{c.card.name}</span>
                          <span className="block text-[10px] text-emerald-400">GEM: {c.card.gem ?? 0}</span>
                          <span className="mt-1 block min-h-[3.1em] line-clamp-3 text-[10px] leading-snug text-slate-400">
                            {c.card.mainEffect || 'ไม่มีความสามารถพิเศษ'}
                          </span>
                          {unavailableReason && (
                            <span className="mt-1 block text-[9px] leading-snug text-rose-300">{unavailableReason}</span>
                          )}
                          {!isSelected && !unavailableReason && selectedTotal >= pendingCost.requiredCost && (
                            <span className="mt-1 block text-[9px] text-slate-500">GEM เพียงพอแล้ว</span>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => setInspectedCard(c)}
                          className="mt-1 flex w-full items-center justify-center gap-1 rounded border border-amber-400/60 py-1 text-[10px] font-semibold text-amber-300 transition hover:bg-amber-500 hover:text-slate-950"
                        >
                          <Info className="h-3 w-3" aria-hidden="true" />
                          ดูความสามารถ
                          <span className="sr-only"> {c.card.name}</span>
                        </button>
                      </div>
                    );
                  })}
              </div>
              <div className="space-y-2 border-t border-slate-800 pt-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                  <span className="text-slate-300">
                    การ์ดที่เลือก: {selectedCards.length ? selectedCards.map(c => c.card.name).join(' / ') : 'ยังไม่ได้เลือก'}
                  </span>
                  <span className="text-slate-300">
                    GEM รวม <b className="text-amber-400">{selectedTotal}</b> / {pendingCost.requiredCost}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={!paymentValidation.valid}
                  onClick={() => finalizePlayCard(pendingCost.handCard, pendingCost.selectedDiscardIds, true)}
                  className="w-full rounded-lg bg-amber-500 px-3 py-2 text-xs font-bold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                >
                  ยืนยันจ่าย Cost และ{actionLabel}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Keyword Reference Modal (From Playmat Bottom-Left Legend) */}
      {showKeywordsModal && (
        <div onClick={() => setShowKeywordsModal(false)} className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div onClick={e => e.stopPropagation()} className="bg-slate-900 border border-slate-700 rounded-2xl max-w-2xl w-full p-5 space-y-3 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <h3 className="font-bold text-base text-amber-400">คำอธิบาย Keyword (อ้างอิงจาก Playmat ทางการ)</h3>
              <button onClick={() => setShowKeywordsModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
              {KEYWORD_LEGEND.map(item => (
                <div key={item.kw} className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex items-start gap-2.5">
                  <span className={`${item.color} text-white font-bold px-2 py-0.5 rounded text-[10px] shrink-0`}>
                    {item.kw}
                  </span>
                  <p className="text-slate-300 leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Hell Inspection Modal */}
      {showHellModal && (
        <div onClick={() => setShowHellModal(null)} className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div onClick={e => e.stopPropagation()} className="bg-slate-900 border border-slate-700 rounded-2xl max-w-lg w-full p-4 space-y-3 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <h3 className="font-bold text-sm text-red-400">
                นรก (Hell) — {showHellModal === 'ME' ? me.name : opponent.name}
              </h3>
              <button onClick={() => setShowHellModal(null)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(showHellModal === 'ME' ? me.hell : opponent.hell).map((c, idx) => (
                <div key={idx} onClick={() => setInspectedCard(c)} className="p-2 rounded bg-slate-950 border border-slate-800 text-[11px] cursor-pointer hover:border-amber-500">
                  <div className="font-bold text-slate-200 truncate">{c.card.name}</div>
                  <div className="text-[9px] text-slate-400">{c.card.type} • {c.card.printId}</div>
                </div>
              ))}
              {(showHellModal === 'ME' ? me.hell : opponent.hell).length === 0 && (
                <div className="col-span-3 text-center py-6 text-slate-500 text-xs">ยังไม่มีการ์ดในนรก</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Game Over Victory Modal */}
      {winnerName && (
        <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border-2 border-amber-500 rounded-2xl max-w-sm w-full p-6 text-center space-y-4 shadow-2xl">
            <Flame className="w-12 h-12 text-amber-400 mx-auto" />
            <h2 className="text-2xl font-black text-amber-400">จบการประลอง!</h2>
            <p className="text-sm text-slate-200">ผู้ชนะคือ: <b className="text-emerald-400">{winnerName}</b></p>
            <button
              onClick={leaveMatch}
              className="w-full py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm"
            >
              กลับสู่หน้าหลัก
            </button>
          </div>
        </div>
      )}

      {/* Opponent Disconnected */}
      {opponentLeft && !winnerName && (
        <div role="alertdialog" aria-label="คู่แข่งหลุดการเชื่อมต่อ" className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border-2 border-red-500 rounded-2xl max-w-sm w-full p-6 text-center space-y-4 shadow-2xl">
            <h2 className="text-xl font-black text-red-400">คู่แข่งหลุดการเชื่อมต่อ</h2>
            <p className="text-sm text-slate-300">เพื่อนของคุณออกจากห้องหรือเครือข่ายขัดข้อง เกมนี้จึงไม่สามารถเล่นต่อได้</p>
            <button
              onClick={leaveMatch}
              className="w-full py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm"
            >
              กลับสู่หน้าหลัก
            </button>
          </div>
        </div>
      )}

      {/* Card Detail Inspection Modal */}
      <CardDetailModal cardInstance={inspectedCard} onClose={() => setInspectedCard(null)} />

      {showOpeningRoll && initialState.openingRolls && (
        <OpeningDiceRoll
          playerOrder={initialState.playerOrder}
          rolls={initialState.openingRolls}
          names={Object.fromEntries(
            Object.values(initialState.players)
              .sort((a, b) => a.seat - b.seat)
              .map(player => [player.id, player.name])
          )}
          meId={meId}
          onClose={() => setShowOpeningRoll(false)}
        />
      )}
    </div>
  );
};
