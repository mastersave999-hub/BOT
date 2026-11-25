'use client';

import React, { useEffect, useRef, useState } from 'react';
import { GameState, CardInstance, MagicSubtype } from '../../engine/types';
import { redactLifeCardsForViewer, type RoomLink } from '../../engine/multiplayer';
import { CardView } from './CardView';
import { CardDetailModal } from './CardDetailModal';
import { OpeningDiceRoll } from './OpeningDiceRoll';
import { executeDrawPhase, eliminatePlayer } from '../../engine/turnEngine';
import { resolveAvatarCombat, attackLifeZone } from '../../engine/combatEngine';
import {
  parseCardAbility,
  avatarHasKeyword,
  recomputeContinuousAuras,
  executeCardAbility,
  clearEndOfTurnModifiers
} from '../../engine/abilityEngine';
import { calculateNetPower } from '../../engine/layers';
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

export const Playmat: React.FC<PlaymatProps> = ({ initialState, currentUserId, link }) => {
  const [gameState, setGameState] = useState<GameState>(() => recomputeContinuousAuras(initialState));
  const [selectedAttackerId, setSelectedAttackerId] = useState<string | null>(null);
  const [inspectedCard, setInspectedCard] = useState<CardInstance | null>(null);
  const [notification, setNotification] = useState<string | null>(null);
  const [pendingAbility, setPendingAbility] = useState<PendingAbilityAction | null>(null);
  const [pendingCost, setPendingCost] = useState<PendingCostPayment | null>(null);
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

  useEffect(() => {
    if (!link) return;
    const offMessage = link.onMessage(msg => {
      if (msg.type !== 'SYNC') return;
      baselineStateRef.current = msg.state;
      setGameState(current => preserveOwnLifeCardIdentities(msg.state, current, meId));
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
  }, [link, meId]);

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

  // Phase 1: Draw Phase Action
  const handleDrawPhase = () => {
    if (!isMyTurn || gameState.currentPhase !== 'DRAW' || winnerName) return;
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

  // Advance Phases & AI Opponent Turn
  const handleNextPhase = () => {
    if (!isMyTurn || winnerName) return;

    if (gameState.currentPhase === 'MAIN') {
      setGameState(prev => appendLogs({ ...prev, currentPhase: 'BATTLE' }, [`${me.name} เข้าสู่ Battle Phase`], 'PHASE_CHANGE'));
      showNotification('เข้าสู่ Battle Phase!');
    } else if (gameState.currentPhase === 'BATTLE') {
      setSelectedAttackerId(null);
      setGameState(prev => appendLogs({ ...prev, currentPhase: 'END' }, [`${me.name} เข้าสู่ End Phase`], 'PHASE_CHANGE'));
      showNotification('เข้าสู่ End Phase!');
    } else if (gameState.currentPhase === 'END') {
      // Clear End of Turn temporary modifiers
      let nextState = clearEndOfTurnModifiers(gameState);
      const nextIndex = (nextState.currentTurnPlayerIndex + 1) % nextState.playerOrder.length;
      const nextTurnNum = nextState.turnNumber + 1;
      nextState = {
        ...nextState,
        currentTurnPlayerIndex: nextIndex,
        currentPhase: 'DRAW',
        turnNumber: nextTurnNum
      };
      const nextPlayerName = nextState.players[nextState.playerOrder[nextIndex]].name;
      nextState = appendLogs(nextState, [`จบเทิร์นของ ${me.name} — เริ่มเทิร์นของ ${nextPlayerName}`], 'TURN_CHANGE');
      setGameState(nextState);
      showNotification(`ส่งเทิร์นให้ ${nextPlayerName}`);

      if (!isOnline) {
        // Execute simple AI Opponent turn automatically after short delay
        setTimeout(() => runAiOpponentTurn(nextState), 900);
      }
    }
  };

  // Automated AI Opponent Turn for smooth single-player testing
  const runAiOpponentTurn = (startState: GameState) => {
    let state = executeDrawPhase(startState);
    const ai = { ...state.players[opponentId] };
    const player = { ...state.players[meId] };
    const logs: string[] = [`🤖 ${ai.name} จั่วการ์ดและเข้าสู่ Main Phase`];

    // AI summons up to 1 Avatar from hand if space < 4
    const avatarIdx = ai.hand.findIndex(c => c.card.type === 'Avatar');
    if (avatarIdx !== -1 && ai.avatarZone.length < 4) {
      const summoned = { ...ai.hand[avatarIdx], isFaceUp: true, isRested: false };
      ai.hand = ai.hand.filter((_, i) => i !== avatarIdx);
      ai.avatarZone = [...ai.avatarZone, summoned];
      logs.push(`🤖 ${ai.name} อัญเชิญ "${summoned.card.name}" (PWR ${summoned.card.power})`);
    }

    state = recomputeContinuousAuras({
      ...state,
      players: { ...state.players, [opponentId]: ai, [meId]: player }
    });

    // AI Battle: Attack player's LIFE if player has no Avatars, or attack weaker Avatar
    const readyAiAvatar = state.players[opponentId].avatarZone.find(a => !a.isRested && calculateNetPower(a) > 0);
    if (readyAiAvatar) {
      const targetPlayerAvatars = state.players[meId].avatarZone;
      if (targetPlayerAvatars.length === 0) {
        const lifeRes = attackLifeZone(readyAiAvatar, state.players[meId]);
        logs.push(`🤖 ${lifeRes.event}`);
        if (lifeRes.isGameOver) {
          setWinnerName(ai.name);
        }
        state.players[opponentId].avatarZone = state.players[opponentId].avatarZone.map(a =>
          a.instanceId === readyAiAvatar.instanceId ? { ...a, isRested: true } : a
        );
      } else {
        // Check if AI has stronger Avatar
        const aiPwr = calculateNetPower(readyAiAvatar);
        const weakestTarget = targetPlayerAvatars[0];
        if (aiPwr >= calculateNetPower(weakestTarget)) {
          const combatRes = resolveAvatarCombat(readyAiAvatar, weakestTarget);
          logs.push(...combatRes.events.map(e => `🤖 ${e}`));
          state.players[opponentId].avatarZone = state.players[opponentId].avatarZone
            .map(a => (a.instanceId === readyAiAvatar.instanceId ? { ...a, isRested: true } : a))
            .filter(a => !(combatRes.attackerDestroyed && a.instanceId === readyAiAvatar.instanceId));
          state.players[meId].avatarZone = state.players[meId].avatarZone.filter(
            a => !(combatRes.defenderDestroyed && a.instanceId === weakestTarget.instanceId)
          );
          if (combatRes.attackerDestroyed) state.players[opponentId].hell.push(readyAiAvatar);
          if (combatRes.defenderDestroyed) state.players[meId].hell.push(weakestTarget);
        }
      }
    }

    // End AI Turn -> Return to Player 1 Draw Phase
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
    if (!isMyTurn || winnerName) {
      setInspectedCard(handCard);
      return;
    }

    const isReactMagic = handCard.card.type === 'Magic' && handCard.card.subtype === 'React';
    if (gameState.currentPhase !== 'MAIN' && !(gameState.currentPhase === 'BATTLE' && isReactMagic)) {
      showNotification('สามารถอัญเชิญหรือใช้การ์ดได้ใน Main Phase (หรือใช้ React Magic ใน Battle Phase)');
      return;
    }

    if (handCard.card.type === 'Avatar' && me.avatarZone.length >= 4) {
      showNotification('Avatar Zone เต็มแล้ว (สูงสุด 4 ใบตามกฎทางการ)');
      return;
    }

    if (handCard.card.type === 'Construct' && me.constructZone.length >= 4) {
      showNotification('Construct Zone เต็มแล้ว (สูงสุด 4 ใบ)');
      return;
    }

    if (handCard.card.type === 'Magic') {
      const subtype = (handCard.card.subtype || 'Normal') as MagicSubtype;
      if (me.usedMagicTypesThisTurn.has(subtype) && subtype !== 'Modification') {
        showNotification(`สามารถเล่น Magic ประเภท "${subtype}" ได้ประเภทละ 1 ครั้งต่อเทิร์น`);
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
      finalizePlayCard(handCard, [], cost === 0);
    }
  };

  // Finalize playing a card only after its Cost Step has been successfully completed.
  const finalizePlayCard = (handCard: CardInstance, discardIds: string[], paidCost: boolean) => {
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
      const placed: CardInstance = { ...handCard, isFaceUp: true };
      updatedMe.constructZone = [...updatedMe.constructZone, placed];
      nextState.players = { ...nextState.players, [meId]: updatedMe };
      nextState = recomputeContinuousAuras(nextState);
      nextState = appendLogs(nextState, [`${me.name} วาง Construct "${handCard.card.name}" ลงใน Construct Zone`], 'CONSTRUCT');
      setGameState(nextState);
      showNotification(`วาง Construct "${handCard.card.name}" สำเร็จ!`);
      return;
    }

    if (handCard.card.type === 'Magic') {
      const subtype = (handCard.card.subtype || 'Normal') as MagicSubtype;
      const newUsedTypes = new Set(updatedMe.usedMagicTypesThisTurn);
      newUsedTypes.add(subtype);
      updatedMe.usedMagicTypesThisTurn = newUsedTypes;

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

      // Normal or React Magic: Put in Magic Zone (or Hell) and execute effect
      updatedMe.magicZone = [...updatedMe.magicZone, { ...handCard, isFaceUp: true }];
      nextState.players = { ...nextState.players, [meId]: updatedMe };

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

    // 2. Non-Battle Phase -> Inspect Card
    if (gameState.currentPhase !== 'BATTLE' || !isMyTurn || winnerName) {
      setInspectedCard(avatar);
      return;
    }

    // 3. Battle Phase: Click own Avatar
    if (isMyAvatar) {
      // Check if we already have an attacker selected and this ally has สามัคคี (Unite)!
      if (selectedAttackerId && selectedAttackerId !== avatar.instanceId && !avatar.isRested && avatarHasKeyword(avatar, 'สามัคคี')) {
        const unitePower = calculateNetPower(avatar);
        let nextState = { ...gameState };
        const updatedMyAvatars = me.avatarZone.map(a => {
          if (a.instanceId === avatar.instanceId) {
            return { ...a, isRested: true };
          }
          if (a.instanceId === selectedAttackerId) {
            return {
              ...a,
              layerModifiers: [
                ...a.layerModifiers,
                {
                  layer: 4 as const,
                  powerMod: unitePower,
                  sourceCardId: `unite-${avatar.instanceId}-${Date.now()}`,
                  expiresAt: 'END_OF_BATTLE' as const
                }
              ]
            };
          }
          return a;
        });
        nextState.players = { ...nextState.players, [meId]: { ...me, avatarZone: updatedMyAvatars } };
        nextState = appendLogs(nextState, [`🤝 "${avatar.card.name}" ใช้ สามัคคี! นอนตัวและเพิ่ม +${unitePower} POWER`], 'ABILITY');
        setGameState(nextState);
        showNotification(`สามัคคี! +${unitePower} POWER ให้ตัวโจมตี`);
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

      // Trigger "เมื่อโจมตี" (ON_ATTACK) when selected as attacker
      let nextState = { ...gameState };
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

    const combatRes = resolveAvatarCombat(attacker, avatar);

    const updatedMyAvatarZone = me.avatarZone
      .map(c => (c.instanceId === attacker.instanceId ? { ...c, isRested: true } : c))
      .filter(c => !(combatRes.attackerDestroyed && c.instanceId === attacker.instanceId));

    const updatedOpponentAvatarZone = opponent.avatarZone.filter(
      c => !(combatRes.defenderDestroyed && c.instanceId === avatar.instanceId)
    );

    const myHellAdditions = combatRes.attackerDestroyed ? [attacker, ...(attacker.attachedInstances || [])] : [];
    const oppHellAdditions = combatRes.defenderDestroyed ? [avatar, ...(avatar.attachedInstances || [])] : [];

    let nextState: GameState = {
      ...gameState,
      players: {
        ...gameState.players,
        [meId]: {
          ...me,
          avatarZone: updatedMyAvatarZone,
          hell: [...me.hell, ...myHellAdditions]
        },
        [opponentId]: {
          ...opponent,
          avatarZone: updatedOpponentAvatarZone,
          hell: [...opponent.hell, ...oppHellAdditions]
        }
      }
    };

    nextState = appendLogs(nextState, combatRes.events, 'COMBAT');

    // Trigger คำสั่งเสีย (Last Words) if destroyed
    if (combatRes.attackerDestroyed && parseCardAbility(attacker.card).hasLastWords) {
      const lwRes = executeCardAbility(nextState, meId, attacker, 'LAST_WORDS');
      nextState = appendLogs(lwRes.state, lwRes.logs, 'LAST_WORDS');
    }
    if (combatRes.defenderDestroyed && parseCardAbility(avatar.card).hasLastWords) {
      const lwRes = executeCardAbility(nextState, opponentId, avatar, 'LAST_WORDS');
      nextState = appendLogs(lwRes.state, lwRes.logs, 'LAST_WORDS', opponentId);
    }

    nextState = recomputeContinuousAuras(nextState);
    setGameState(nextState);
    setSelectedAttackerId(null);
    showNotification(combatRes.events[combatRes.events.length - 1]);
  };

  // Attack Opponent LIFE Zone Directly
  const handleAttackLifeZone = () => {
    if (gameState.currentPhase !== 'BATTLE' || !isMyTurn || winnerName) return;
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

    const oppClone: typeof opponent = {
      ...opponent,
      lifeDeck: opponent.lifeDeck.map(l => ({ ...l }))
    };
    const lifeRes = attackLifeZone(attacker, oppClone);
    const newlyFlippedCard = lifeRes.revealedCardId
      ? oppClone.lifeDeck.find(card => card.instanceId === lifeRes.revealedCardId)
      : undefined;

    const updatedMyAvatarZone = me.avatarZone.map(c =>
      c.instanceId === attacker.instanceId ? { ...c, isRested: true } : c
    );

    let nextState: GameState = {
      ...gameState,
      players: {
        ...gameState.players,
        [meId]: { ...me, avatarZone: updatedMyAvatarZone },
        [opponentId]: newlyFlippedCard
          ? { ...oppClone, pendingLifeEffects: [...(oppClone.pendingLifeEffects ?? []), newlyFlippedCard.instanceId] }
          : oppClone
      }
    };
    nextState = appendLogs(nextState, [lifeRes.event], 'ATTACK_LIFE');

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
    showNotification(lifeRes.event);
  };

  // Toggle Construct Activation
  const handleConstructClick = (cons: CardInstance) => {
    if (!isMyTurn || gameState.currentPhase !== 'MAIN') {
      setInspectedCard(cons);
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
                  {gameState.currentPhase === 'MAIN' && 'เข้า Battle Phase'}
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

      {/* Pending Ability Target Banner */}
      {pendingAbility && (
        <div className="bg-amber-500 text-slate-950 font-bold text-xs px-4 py-1.5 flex items-center justify-between z-30 shadow-lg">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 animate-pulse" />
            <span>{pendingAbility.prompt}</span>
          </div>
          <button
            onClick={() => setPendingAbility(null)}
            className="px-2 py-0.5 rounded bg-slate-950/20 hover:bg-slate-950/30 text-[11px]"
          >
            ข้าม/ยกเลิก
          </button>
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
                <span className="text-slate-400 text-[9px]">มี Construct บนสนามได้สูงสุด 4 ใบ ({me.constructZone.length}/4)</span>
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
              <span className="font-bold text-amber-400">การ์ดบนมือของคุณ ({me.hand.length} ใบ) — คลิกเพื่อเล่นลงสนาม</span>
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
