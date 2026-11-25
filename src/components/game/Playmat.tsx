'use client';

import React, { useState } from 'react';
import { GameState, CardInstance, MagicSubtype } from '../../engine/types';
import { CardView } from './CardView';
import { CardDetailModal } from './CardDetailModal';
import { executeDrawPhase } from '../../engine/turnEngine';
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
  Swords, Shield, Flame, Play, RefreshCw,
  CheckCircle2, BookOpen, X, Sparkles, Skull, Layers
} from 'lucide-react';

interface PlaymatProps {
  initialState: GameState;
  currentUserId: string;
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

export const Playmat: React.FC<PlaymatProps> = ({ initialState, currentUserId }) => {
  const [gameState, setGameState] = useState<GameState>(() => recomputeContinuousAuras(initialState));
  const [selectedAttackerId, setSelectedAttackerId] = useState<string | null>(null);
  const [inspectedCard, setInspectedCard] = useState<CardInstance | null>(null);
  const [notification, setNotification] = useState<string | null>(null);
  const [pendingAbility, setPendingAbility] = useState<PendingAbilityAction | null>(null);
  const [pendingCost, setPendingCost] = useState<PendingCostPayment | null>(null);
  const [showKeywordsModal, setShowKeywordsModal] = useState<boolean>(false);
  const [showHellModal, setShowHellModal] = useState<'ME' | 'OPPONENT' | null>(null);
  const [winnerName, setWinnerName] = useState<string | null>(null);

  const meId = currentUserId;
  const opponentId = gameState.playerOrder.find(id => id !== meId) || gameState.playerOrder[1];

  const me = gameState.players[meId];
  const opponent = gameState.players[opponentId];
  const isMyTurn = gameState.playerOrder[gameState.currentTurnPlayerIndex] === meId;

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
    const nextState = recomputeContinuousAuras(executeDrawPhase(gameState));
    setGameState(nextState);
    if (nextState.players[meId].deck.length === 0 && gameState.players[meId].deck.length === 0) {
      setWinnerName(opponent.name);
    }
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
      nextState = appendLogs(nextState, [`จบเทิร์นของ ${me.name} — เริ่มเทิร์นของ ${opponent.name}`], 'TURN_CHANGE');
      setGameState(nextState);
      showNotification(`ส่งเทิร์นให้ ${opponent.name}`);

      // Execute simple AI Opponent turn automatically after short delay
      setTimeout(() => runAiOpponentTurn(nextState), 900);
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
    if (cost > 0 && me.hand.length > 1) {
      setPendingCost({
        handCard,
        requiredCost: cost,
        selectedDiscardIds: []
      });
    } else {
      finalizePlayCard(handCard, [], cost === 0);
    }
  };

  // Finalize playing card after Cost payment (or Free/Effect)
  const finalizePlayCard = (handCard: CardInstance, discardIds: string[], paidCost: boolean) => {
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
    const prevFlipped = oppClone.lifeDeck.filter(l => l.isFaceUp).length;
    const lifeRes = attackLifeZone(attacker, oppClone);
    const newlyFlippedCard = oppClone.lifeDeck.filter(l => l.isFaceUp)[prevFlipped];

    const updatedMyAvatarZone = me.avatarZone.map(c =>
      c.instanceId === attacker.instanceId ? { ...c, isRested: true } : c
    );

    let nextState: GameState = {
      ...gameState,
      players: {
        ...gameState.players,
        [meId]: { ...me, avatarZone: updatedMyAvatarZone },
        [opponentId]: oppClone
      }
    };
    nextState = appendLogs(nextState, [lifeRes.event], 'ATTACK_LIFE');

    // Trigger flipped LIFE card ability for opponent
    if (newlyFlippedCard) {
      const lifeEffRes = executeCardAbility(nextState, opponentId, newlyFlippedCard, 'LIFE_FLIP');
      nextState = appendLogs(lifeEffRes.state, lifeEffRes.logs, 'LIFE_FLIP', opponentId);
    }

    if (lifeRes.isGameOver) {
      setWinnerName(me.name);
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
      <header className="shrink-0 h-11 bg-slate-900 border-b border-slate-800 px-3 flex items-center justify-between z-30">
        <div className="flex items-center space-x-2">
          <span className="font-extrabold text-amber-500 tracking-wider flex items-center gap-1 text-xs sm:text-sm">
            <Flame className="w-4 h-4 text-red-500 fill-red-500" />
            ศึกตลิ่งชัน ONLINE
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 font-mono">
            TURN {gameState.turnNumber}
          </span>
        </div>

        {/* Turn Order Indicator (Matches Playmat Bottom-Right Turn Order) */}
        <div className="hidden md:flex items-center space-x-1 bg-slate-950 px-2 py-1 rounded-lg border border-slate-800 text-[10px] font-bold">
          {(['DRAW', 'MAIN', 'BATTLE', 'END'] as const).map((ph, idx) => (
            <React.Fragment key={ph}>
              <span
                className={`px-2 py-0.5 rounded transition ${
                  gameState.currentPhase === ph ? 'bg-amber-500 text-slate-950 shadow-sm' : 'text-slate-500'
                }`}
              >
                {ph} PHASE
              </span>
              {idx < 3 && <span className="text-slate-700">→</span>}
            </React.Fragment>
          ))}
        </div>

        {/* Controls */}
        <div className="flex items-center space-x-1.5">
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
              เทิร์นคู่แข่ง...
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

      {/* Main Playmat + Side Event Log */}
      <main className="flex-1 flex overflow-hidden relative">
        {/* Official Playmat Arena */}
        <div className="flex-1 flex flex-col justify-between p-1.5 sm:p-3 overflow-y-auto bg-gradient-to-b from-slate-900 via-slate-950 to-slate-900">
          {/* ==================== OPPONENT PLAYMAT HALF (MIRRORED) ==================== */}
          <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-1.5 sm:p-2 space-y-1.5">
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
                      onClick={(e) => {
                        if (lifeCard.isFaceUp) {
                          e.stopPropagation();
                          setInspectedCard(lifeCard);
                        }
                      }}
                      className={`w-6 h-8 rounded border text-[8px] flex items-center justify-center font-bold ${
                        lifeCard.isFaceUp
                          ? 'bg-red-950/70 border-red-500 text-red-200'
                          : 'bg-slate-900 border-slate-700 text-amber-500'
                      }`}
                    >
                      {lifeCard.isFaceUp ? 'หงาย' : idx + 1}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

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
                    <div
                      key={lifeCard.instanceId || idx}
                      onClick={() => lifeCard.isFaceUp && setInspectedCard(lifeCard)}
                      className={`w-12 sm:w-14 h-7 sm:h-8 rounded border flex items-center justify-center text-[9px] font-bold cursor-pointer transition ${
                        lifeCard.isFaceUp
                          ? 'bg-red-950/70 border-red-500 text-red-200'
                          : 'bg-slate-900 border-emerald-700/60 text-emerald-400'
                      }`}
                    >
                      {lifeCard.isFaceUp ? lifeCard.card.name.slice(0, 6) : `LIFE #${idx + 1}`}
                    </div>
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
              <span className="hidden sm:inline text-[10px]">คลิกขวาเพื่อดูรายละเอียดการ์ด</span>
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

        {/* Right Side Panel: Event Log */}
        <aside className="w-64 bg-slate-900 border-l border-slate-800 hidden lg:flex flex-col shrink-0">
          <div className="h-9 px-3 border-b border-slate-800 flex items-center text-xs font-bold text-slate-300">
            บันทึกเหตุการณ์ (Event Log)
          </div>
          <div className="flex-1 p-2.5 overflow-y-auto space-y-1.5 text-[11px]">
            {gameState.eventLog.slice().reverse().map((ev, i) => (
              <div key={i} className="p-2 rounded-lg bg-slate-950/90 border border-slate-800/80 text-slate-300 leading-relaxed">
                {ev.description}
              </div>
            ))}
          </div>
        </aside>
      </main>

      {/* Notification Banner */}
      {notification && (
        <div className="fixed top-14 left-1/2 -translate-x-1/2 z-50 bg-amber-500 text-slate-950 font-bold px-4 py-1.5 rounded-full shadow-2xl text-xs flex items-center gap-1.5">
          <Swords className="w-3.5 h-3.5" />
          <span>{notification}</span>
        </div>
      )}

      {/* Gem Cost Payment Modal */}
      {pendingCost && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-amber-500/50 rounded-2xl max-w-lg w-full p-4 space-y-3 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-sm text-amber-400">
                จ่าย Cost เพื่อเล่น "{pendingCost.handCard.card.name}" (ต้องการ Cost: {pendingCost.requiredCost})
              </h3>
              <button onClick={() => setPendingCost(null)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-400">
              เลือกการ์ดจากบนมือเพื่อส่งลงนรกเป็นค่า Cost (หรือเลือก "จ่ายอัตโนมัติ" / "ใช้ฟรีด้วยเอฟเฟกต์"):
            </p>
            <div className="flex gap-2 overflow-x-auto py-2">
              {me.hand
                .filter(c => c.instanceId !== pendingCost.handCard.instanceId)
                .map(c => {
                  const isSel = pendingCost.selectedDiscardIds.includes(c.instanceId);
                  return (
                    <div
                      key={c.instanceId}
                      onClick={() => {
                        setPendingCost(prev =>
                          prev
                            ? {
                                ...prev,
                                selectedDiscardIds: isSel
                                  ? prev.selectedDiscardIds.filter(id => id !== c.instanceId)
                                  : [...prev.selectedDiscardIds, c.instanceId]
                              }
                            : null
                        );
                      }}
                      className={`p-1 rounded-lg border-2 cursor-pointer shrink-0 transition ${
                        isSel ? 'border-amber-400 bg-amber-950/40' : 'border-slate-800 bg-slate-950'
                      }`}
                    >
                      <div className="text-[10px] font-bold text-slate-200 w-20 truncate">{c.card.name}</div>
                      <div className="text-[9px] text-emerald-400">GEM: {c.card.gem ?? 0}</div>
                    </div>
                  );
                })}
            </div>
            {(() => {
              const totalGems = me.hand
                .filter(c => pendingCost.selectedDiscardIds.includes(c.instanceId))
                .reduce((acc, c) => acc + Math.max(1, c.card.gem ?? 1), 0);
              return (
                <div className="flex items-center justify-between pt-2 border-t border-slate-800 gap-2">
                  <span className="text-xs text-slate-300">
                    จ่ายแล้ว: <b className="text-amber-400">{totalGems}</b> / {pendingCost.requiredCost}
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => finalizePlayCard(pendingCost.handCard, [], false)}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs"
                    >
                      เล่นฟรี (ไม่ติดจุติ)
                    </button>
                    <button
                      onClick={() => {
                        const autoIds = me.hand
                          .filter(c => c.instanceId !== pendingCost.handCard.instanceId)
                          .slice(0, Math.min(2, pendingCost.requiredCost))
                          .map(c => c.instanceId);
                        finalizePlayCard(pendingCost.handCard, autoIds, true);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs"
                    >
                      จ่าย Cost และอัญเชิญ!
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

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
              onClick={() => window.location.reload()}
              className="w-full py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm"
            >
              กลับสู่หน้าหลัก
            </button>
          </div>
        </div>
      )}

      {/* Card Detail Inspection Modal */}
      <CardDetailModal cardInstance={inspectedCard} onClose={() => setInspectedCard(null)} />
    </div>
  );
};
