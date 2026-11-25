import { GameState, CardInstance, PlayerState, Card } from './types';
import { calculateNetPower } from './layers';

type LayerMod = CardInstance['layerModifiers'][number];

export interface AbilityParseResult {
  hasJuti: boolean;           // จุติ (On summon with cost)
  hasLastWords: boolean;      // คำสั่งเสีย (On destroy)
  hasContinuous: boolean;     // ต่อเนื่อง (Aura while on field)
  hasOnAttack: boolean;       // เมื่อโจมตี
  hasUnite: boolean;          // สามัคคี
  hasHumanShield: boolean;    // โล่มนุษย์
  hasGrit: boolean;           // ลูกฮึด
  hasEggKick: boolean;        // เตะไข่
  hasBackstab: boolean;       // แทงหลัง
  hasSacrifice: boolean;      // เซ่นไหว้
  needsTargetAvatar: boolean; // ต้องเลือกเป้าหมาย Avatar
  targetScope: 'ANY_AVATAR' | 'OWN_AVATAR' | 'OPPONENT_AVATAR' | 'NONE';
  drawCount: number;
  powerMod: number;
  resetsPower: boolean;
  destroysTarget: boolean;
  destroysAllOpponentAvatars: boolean;
  bouncesTarget: boolean;
  grantsKeyword?: string;
  summonsFromHell: boolean;
  recoversFromHell: number;
  discardsCostCount: number;
}

/**
 * Parses a card's Thai mainEffect text into structured executable ability flags & values.
 */
export function parseCardAbility(card: Card): AbilityParseResult {
  const eff = card.mainEffect || '';

  const hasJuti = eff.includes('จุติ');
  const hasLastWords = eff.includes('คำสั่งเสีย');
  const hasContinuous = eff.includes('ต่อเนื่อง');
  const hasOnAttack = eff.includes('เมื่อ Avatar ใบนี้โจมตี') || eff.includes('เมื่อโจมตี');
  const hasUnite = eff.includes('สามัคคี');
  const hasHumanShield = eff.includes('โล่มนุษย์');
  const hasGrit = eff.includes('ลูกฮึด');
  const hasEggKick = eff.includes('เตะไข่');
  const hasBackstab = eff.includes('แทงหลัง');
  const hasSacrifice = eff.includes('เซ่นไหว้');

  // Parse draw count: "จั่วการ์ด X ใบ" or "จั่ว X ใบ"
  let drawCount = 0;
  const drawMatch = eff.match(/จั่ว(?:การ์ด)?\s*(\d+)\s*ใบ/);
  if (drawMatch) {
    drawCount = parseInt(drawMatch[1], 10);
  }

  // Parse POWER modification: "POWER +X" or "POWER -X"
  let powerMod = 0;
  const powerMatch = eff.match(/POWER\s*([+-]\d+)/i);
  if (powerMatch) {
    powerMod = parseInt(powerMatch[1], 10);
  }
  const resetsPower = /ปรับ\s*POWER.*กลับเป็น\s*POWER ตั้งต้น/.test(eff);

  // Parse destroy effects
  const destroysAllOpponentAvatars =
    eff.includes('ทำลาย Avatar ทุกใบบนสนามฝ่ายตรงข้าม') ||
    eff.includes('ทำลาย Avatar ฝ่ายตรงข้ามทุกใบ');

  const destroysTarget =
    !destroysAllOpponentAvatars &&
    (eff.includes('ทำลาย Avatar') || eff.includes('ทำลายตัวนั้น'));

  // Parse bounce to hand
  const bouncesTarget = eff.includes('กลับขึ้นมือ') || eff.includes('นำขึ้นมือ');

  // Parse granted keyword (e.g. Modification Magic granting เตะไข่ or ลูกฮึด)
  let grantsKeyword: string | undefined;
  if (eff.includes('ได้รับความสามารถ')) {
    if (eff.includes('เตะไข่')) grantsKeyword = 'เตะไข่';
    else if (eff.includes('ลูกฮึด')) grantsKeyword = 'ลูกฮึด';
    else if (eff.includes('โล่มนุษย์')) grantsKeyword = 'โล่มนุษย์';
    else if (eff.includes('แทงหลัง')) grantsKeyword = 'แทงหลัง';
  }

  // Hell interactions
  const summonsFromHell = eff.includes('นรก') && eff.includes('อัญเชิญ');
  let recoversFromHell = 0;
  if (eff.includes('นรก') && (eff.includes('กลับเข้า Deck') || eff.includes('นำขึ้นมือ'))) {
    const recMatch = eff.match(/(\d+)\s*ใบ\s*จากนรก/);
    recoversFromHell = recMatch ? parseInt(recMatch[1], 10) : 1;
  }

  // Discard cost requirement inside effect (e.g., "ทิ้ง Avatar ... 1 ใบ")
  let discardsCostCount = 0;
  const discMatch = eff.match(/ทิ้ง\s*.*?\s*(\d+)\s*ใบ/);
  if (discMatch && !eff.includes('สุ่มทิ้ง')) {
    discardsCostCount = parseInt(discMatch[1], 10);
  }

  // Target selection detection
  let targetScope: 'ANY_AVATAR' | 'OWN_AVATAR' | 'OPPONENT_AVATAR' | 'NONE' = 'NONE';
  if (card.type === 'Magic' && card.subtype === 'Modification') {
    targetScope = 'OWN_AVATAR';
  } else if (eff.includes('เลือก Avatar') || eff.includes('นำ Avatar 1 ใบ') || (destroysTarget && !eff.includes('ตัวนั้น'))) {
    if (eff.includes('ฝ่ายตรงข้าม')) {
      targetScope = 'OPPONENT_AVATAR';
    } else if (eff.includes('ฝ่ายเรา')) {
      targetScope = 'OWN_AVATAR';
    } else {
      targetScope = 'ANY_AVATAR';
    }
  }

  const needsTargetAvatar = targetScope !== 'NONE';

  return {
    hasJuti,
    hasLastWords,
    hasContinuous,
    hasOnAttack,
    hasUnite,
    hasHumanShield,
    hasGrit,
    hasEggKick,
    hasBackstab,
    hasSacrifice,
    needsTargetAvatar,
    targetScope,
    drawCount,
    powerMod,
    resetsPower,
    destroysTarget,
    destroysAllOpponentAvatars,
    bouncesTarget,
    grantsKeyword,
    summonsFromHell,
    recoversFromHell,
    discardsCostCount
  };
}

/**
 * Checks if an Avatar has a specific keyword either printed or granted by attached Modification Magic.
 */
export function avatarHasKeyword(avatar: CardInstance, keyword: string): boolean {
  if ((avatar.card.mainEffect || '').includes(keyword)) return true;
  if (avatar.attachedInstances?.some(att => (att.card.mainEffect || '').includes(keyword))) {
    return true;
  }
  return false;
}

/**
 * Recomputes continuous Layer 1 (attached Modification Magic) and Layer 2 (Land Magic + Continuous Avatars + Constructs)
 * modifiers across all Avatars on the battlefield.
 */
export function recomputeContinuousAuras(state: GameState): GameState {
  const newPlayers: Record<string, PlayerState> = {};

  // Gather Land Magic aura
  const landCard = state.landMagicZone?.card;
  const landParsed = landCard ? parseCardAbility(landCard) : null;

  for (const pid of state.playerOrder) {
    const p = state.players[pid];
    if (!p) continue;

    // Gather this player's continuous Avatars and Constructs
    const continuousAvatars = p.avatarZone.filter(a => parseCardAbility(a.card).hasContinuous);
    const activeConstructs = p.constructZone;

    const updatedAvatars = p.avatarZone.map(avatar => {
      // Keep non-aura temporary modifiers (Layer 3, Layer 4, or one-turn Layer 1 buffs)
      const preservedMods = avatar.layerModifiers.filter(
        m => !m.sourceCardId.startsWith('aura-')
      );

      const auraMods: LayerMod[] = [];

      // Layer 1: Attached Modification Magic
      for (const att of avatar.attachedInstances || []) {
        const parsedAtt = parseCardAbility(att.card);
        if (parsedAtt.powerMod !== 0) {
          auraMods.push({
            layer: 1,
            powerMod: parsedAtt.powerMod,
            sourceCardId: `aura-mod-${att.instanceId}`
          });
        }
      }

      // Layer 2: Continuous Avatars on own field
      for (const contAvatar of continuousAvatars) {
        const parsedCont = parseCardAbility(contAvatar.card);
        if (parsedCont.powerMod !== 0) {
          // Check if it affects all allies or matching symbol/name
          const eff = contAvatar.card.mainEffect || '';
          const appliesToAll = !eff.includes('ชื่อ') && !eff.includes('{symbol');
          const matchesSymbol = eff.includes('{symbol เทพ}') && (avatar.card.symbol?.includes('เทพ') || avatar.card.name.includes('พระ') || avatar.card.name.includes('เทวดา') || avatar.card.name.includes('นนทก'));
          if (appliesToAll || matchesSymbol || contAvatar.instanceId === avatar.instanceId) {
            auraMods.push({
              layer: 2,
              powerMod: parsedCont.powerMod,
              sourceCardId: `aura-cont-${contAvatar.instanceId}`
            });
          }
        }
      }

      // Layer 2: Constructs on own field
      for (const cons of activeConstructs) {
        const parsedCons = parseCardAbility(cons.card);
        if (parsedCons.hasContinuous && parsedCons.powerMod !== 0) {
          auraMods.push({
            layer: 2,
            powerMod: parsedCons.powerMod,
            sourceCardId: `aura-cons-${cons.instanceId}`
          });
        }
      }

      // Layer 2: Shared Land Magic Zone
      if (landCard && landParsed && landParsed.powerMod !== 0) {
        const landEff = landCard.mainEffect || '';
        const appliesToAll = !landEff.includes('ชื่อ') && !landEff.includes('{symbol');
        const matchesTribe = landEff.includes('{symbol เทพ}') && (avatar.card.symbol?.includes('เทพ') || avatar.card.name.includes('พระ') || avatar.card.name.includes('เทวดา') || avatar.card.name.includes('นนทก'));
        const matchesNames = landEff.includes('กุ่ย') && (avatar.card.name.includes('กุ่ย') || avatar.card.name.includes('ฮอล') || avatar.card.name.includes('นาย'));

        if (appliesToAll || matchesTribe || matchesNames) {
          auraMods.push({
            layer: 2,
            powerMod: landParsed.powerMod,
            sourceCardId: `aura-land-${state.landMagicZone!.instanceId}`
          });
        }
      }

      return {
        ...avatar,
        layerModifiers: [...preservedMods, ...auraMods]
      };
    });

    newPlayers[pid] = {
      ...p,
      avatarZone: updatedAvatars
    };
  }

  return {
    ...state,
    players: newPlayers
  };
}

/**
 * Executes a card's triggered ability (e.g. จุติ, Magic Normal/React, คำสั่งเสีย, Life flip)
 * against the game state and an optional target Avatar instanceId.
 */
export function executeCardAbility(
  state: GameState,
  actorId: string,
  sourceCard: CardInstance,
  triggerType: 'SUMMON_JUTI' | 'MAGIC_CAST' | 'ON_ATTACK' | 'LAST_WORDS' | 'LIFE_FLIP' | 'CONSTRUCT_ACTIVATE',
  targetAvatarId?: string
): { state: GameState; logs: string[] } {
  const logs: string[] = [];
  let nextState = { ...state, players: { ...state.players } };
  const actor = { ...nextState.players[actorId] };
  if (!actor) return { state, logs };

  const parsed = parseCardAbility(sourceCard.card);

  // Skip if summon didn't have จุติ
  if (triggerType === 'SUMMON_JUTI' && !parsed.hasJuti) {
    return { state, logs };
  }

  // 1. Handle Draw Effect ("จั่วการ์ด X ใบ")
  if (parsed.drawCount > 0) {
    const mainDeck = actor.deck.filter(card => card.card.type !== 'Life');
    if (mainDeck.length > 0) {
      const drawn = mainDeck.slice(0, parsed.drawCount).map(c => ({ ...c, isFaceUp: true }));
      actor.deck = mainDeck.slice(drawn.length);
      actor.hand = [...actor.hand, ...drawn];
      logs.push(`✨ ความสามารถ "${sourceCard.card.name}": จั่วการ์ด ${drawn.length} ใบ`);
    }
  }

  // 2. Handle Destroy All Opponent Avatars
  if (parsed.destroysAllOpponentAvatars) {
    for (const pid of nextState.playerOrder) {
      if (pid === actorId) continue;
      const opp = { ...nextState.players[pid] };
      if (opp.avatarZone.length > 0) {
        const destroyedNames = opp.avatarZone.map(a => a.card.name).join(', ');
        opp.hell = [...opp.hell, ...opp.avatarZone];
        opp.avatarZone = [];
        nextState.players[pid] = opp;
        logs.push(`💥 "${sourceCard.card.name}" ทำลาย Avatar ฝ่ายตรงข้ามทั้งหมด (${destroyedNames})!`);
      }
    }
  }

  // 3. Handle On-Attack Self Buff ("เมื่อโจมตี : POWER +X")
  if (triggerType === 'ON_ATTACK' && parsed.hasOnAttack && parsed.powerMod !== 0) {
    actor.avatarZone = actor.avatarZone.map(a => {
      if (a.instanceId === sourceCard.instanceId) {
        return {
          ...a,
          layerModifiers: [
            ...a.layerModifiers,
            {
              layer: 4,
              powerMod: parsed.powerMod,
              sourceCardId: `attack-${sourceCard.instanceId}-${Date.now()}`,
              expiresAt: 'END_OF_TURN'
            }
          ]
        };
      }
      return a;
    });
    logs.push(`⚔️ "${sourceCard.card.name}" เปิดใช้งานความสามารถเมื่อโจมตี: POWER ${parsed.powerMod >= 0 ? '+' : ''}${parsed.powerMod} จนจบเทิร์น!`);
  }

  // 4. Handle Targeted Effects (Power Mod, Destroy Target, Bounce Target)
  if (targetAvatarId && triggerType !== 'ON_ATTACK') {
    for (const pid of nextState.playerOrder) {
      const p = { ...nextState.players[pid] };
      const targetIdx = p.avatarZone.findIndex(a => a.instanceId === targetAvatarId);
      if (targetIdx !== -1) {
        const targetAvatar = p.avatarZone[targetIdx];

        if (parsed.destroysTarget) {
          p.avatarZone = p.avatarZone.filter(a => a.instanceId !== targetAvatarId);
          p.hell = [...p.hell, targetAvatar, ...(targetAvatar.attachedInstances || [])];
          logs.push(`💥 "${sourceCard.card.name}" ทำลาย Avatar "${targetAvatar.card.name}" ลงนรก!`);
        } else if (parsed.bouncesTarget) {
          p.avatarZone = p.avatarZone.filter(a => a.instanceId !== targetAvatarId);
          p.hand = [...p.hand, { ...targetAvatar, isRested: false, layerModifiers: [], attachedInstances: [] }];
          logs.push(`🌪️ "${sourceCard.card.name}" นำ "${targetAvatar.card.name}" กลับขึ้นมือ!`);
        } else if (parsed.resetsPower) {
          const updatedTarget: CardInstance = {
            ...targetAvatar,
            layerModifiers: targetAvatar.layerModifiers.filter(modifier => modifier.sourceCardId.startsWith('aura-'))
          };
          p.avatarZone = p.avatarZone.map(a => (a.instanceId === targetAvatarId ? updatedTarget : a));
          logs.push(`⚡ "${sourceCard.card.name}" คืน POWER ของ "${targetAvatar.card.name}" เป็นค่าเริ่มต้น`);
        } else if (parsed.powerMod !== 0) {
          const updatedTarget: CardInstance = {
            ...targetAvatar,
            layerModifiers: [
              ...targetAvatar.layerModifiers,
              {
                layer: 1,
                powerMod: parsed.powerMod,
                sourceCardId: `eff-${sourceCard.instanceId}-${Date.now()}`,
                expiresAt: 'END_OF_TURN'
              }
            ]
          };
          p.avatarZone = p.avatarZone.map(a => (a.instanceId === targetAvatarId ? updatedTarget : a));
          const newPwr = calculateNetPower(updatedTarget);
          logs.push(
            `⚡ "${sourceCard.card.name}" ปรับ POWER ของ "${targetAvatar.card.name}" ${parsed.powerMod >= 0 ? '+' : ''}${parsed.powerMod} (ปัจจุบัน PWR ${newPwr})`
          );
        }

        nextState.players[pid] = p;
        break;
      }
    }
  }

  // 5. Handle Summon / Recover from Hell
  if (parsed.summonsFromHell && actor.hell.length > 0 && actor.avatarZone.length < 4) {
    const hellAvatarIdx = actor.hell.findIndex(c => c.card.type === 'Avatar');
    if (hellAvatarIdx !== -1) {
      const revived = { ...actor.hell[hellAvatarIdx], isFaceUp: true, isRested: false, layerModifiers: [] };
      actor.hell = actor.hell.filter((_, i) => i !== hellAvatarIdx);
      actor.avatarZone = [...actor.avatarZone, revived];
      logs.push(`🔥 "${sourceCard.card.name}" อัญเชิญ "${revived.card.name}" จากนรกกลับลงสนาม!`);
    }
  } else if (parsed.recoversFromHell > 0 && actor.hell.length > 0) {
    const toRecover = actor.hell
      .filter(card => card.card.type !== 'Life')
      .slice(0, parsed.recoversFromHell);
    const recoveredIds = new Set(toRecover.map(card => card.instanceId));
    actor.hell = actor.hell.filter(card => !recoveredIds.has(card.instanceId));
    actor.deck = [...actor.deck, ...toRecover.map(c => ({ ...c, isFaceUp: false }))];
    logs.push(`♻️ "${sourceCard.card.name}" นำการ์ด ${toRecover.length} ใบจากนรกกลับเข้า Deck!`);
  }

  nextState.players[actorId] = actor;
  nextState = recomputeContinuousAuras(nextState);

  return { state: nextState, logs };
}

/**
 * Clears all end-of-turn temporary modifiers (Layer 1/4 one-turn buffs) at the start of End Phase / Turn change.
 */
export function clearEndOfTurnModifiers(state: GameState): GameState {
  const newPlayers: Record<string, PlayerState> = {};
  for (const pid of state.playerOrder) {
    const p = state.players[pid];
    if (!p) continue;
    newPlayers[pid] = {
      ...p,
      avatarZone: p.avatarZone.map(a => ({
        ...a,
        layerModifiers: a.layerModifiers.filter(m => m.sourceCardId.startsWith('aura-'))
      }))
    };
  }
  return recomputeContinuousAuras({ ...state, players: newPlayers });
}
