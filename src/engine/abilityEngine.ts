import { GameState, CardInstance, PlayerState, Card } from './types';
import { resolveEffectPlan, type EffectDefinition } from './effectResolver';

type LayerMod = CardInstance['layerModifiers'][number];

const UNSUPPORTED_EFFECT_PATTERNS: Array<[string, RegExp]> = [
  ['conditional requirements', /(?:หาก|ถ้า)\s/],
  ['mixed continuous and triggered text', /ต่อเนื่อง/],
  ['search or selection from a private zone', /(?:นำ|เลือก|ค้นหา|หยิบ).{0,80}(?:Deck|เด็ค|นรก)|(?:Deck|เด็ค).{0,80}(?:นำ|เลือก|ค้นหา|หยิบ)/i],
  ['discard, sacrifice, or activation costs', /ทิ้ง|เซ่นไหว้|สังเวย|เทิร์นละครั้ง|สั่งใช้/],
  ['mill or scouting', /ธรณีสูบ|สอดแนม/],
  ['prevention, cancellation, or control changes', /ยกเลิก(?!การใช้\s*Magic Card)|ป้องกัน|เปลี่ยนการควบคุม|เนรเทศ|มิติมืด/],
  ['state changes not represented by the game model', /เปลี่ยนชื่อ|เปลี่ยน Symbol|เปลี่ยนสี|เปลี่ยนค่า Cost|ได้รับความสามารถ/],
  ['Hell selection or recovery destination', /นรก.{0,80}(?:อัญเชิญ|กลับเข้า Deck|นำขึ้นมือ)|(?:อัญเชิญ|กลับเข้า Deck|นำขึ้นมือ).{0,80}นรก/]
];

export function getUnsupportedEffectReason(card: Card): string | undefined {
  return UNSUPPORTED_EFFECT_PATTERNS.find(([, pattern]) => pattern.test(card.mainEffect || ''))?.[0];
}

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
  const existingActor = state.players[actorId];
  if (!existingActor) return { state, logs };
  const actor = { ...existingActor };

  const parsed = parseCardAbility(sourceCard.card);

  // Effects are dispatched only from the timing printed on the card. Previously,
  // every parsed operation ran for every trigger (e.g. a Last Words draw ran on
  // summon), which could apply effects before their legal timing.
  const triggerIsValid = (() => {
    switch (triggerType) {
      case 'SUMMON_JUTI': return sourceCard.card.type === 'Avatar' && parsed.hasJuti;
      case 'MAGIC_CAST': return sourceCard.card.type === 'Magic' &&
        (sourceCard.card.subtype === 'Normal' || sourceCard.card.subtype === 'React');
      case 'ON_ATTACK': return sourceCard.card.type === 'Avatar' && parsed.hasOnAttack;
      case 'LAST_WORDS': return parsed.hasLastWords;
      case 'LIFE_FLIP': return sourceCard.card.type === 'Life';
      case 'CONSTRUCT_ACTIVATE': return sourceCard.card.type === 'Construct';
      default: return false;
    }
  })();
  if (!triggerIsValid) return { state, logs };

  // Rule Book 3.2 pp.12–13 requires an effect to resolve as a whole and costs
  // to be paid only when the complete effect is possible. Until the engine has
  // explicit choices/payment state for these mechanics, refuse the whole effect
  // instead of applying only the regex-recognized fragment.
  const unsupportedReason = getUnsupportedEffectReason(sourceCard.card);
  if (unsupportedReason) {
    logs.push(`${sourceCard.card.name}: ยังไม่รองรับ${unsupportedReason} จึงไม่ทำผลใด ๆ`);
    return { state, logs };
  }

  const hasResolvedOperation = parsed.drawCount > 0 || parsed.powerMod !== 0 || parsed.resetsPower ||
    parsed.destroysTarget || parsed.destroysAllOpponentAvatars || parsed.bouncesTarget ||
    parsed.summonsFromHell || parsed.recoversFromHell > 0 ||
    (triggerType === 'MAGIC_CAST' && /ยกเลิกการใช้\s*Magic Card/.test(sourceCard.card.mainEffect || ''));
  if (!hasResolvedOperation) {
    logs.push(`${sourceCard.card.name}: ยังไม่มีตัวจัดการผลของความสามารถนี้ จึงไม่ทำผลใด ๆ`);
    return { state, logs };
  }

  // Validate target legality before applying any portion of a multi-part effect.
  const targetOwnerId = targetAvatarId
    ? state.playerOrder.find(playerId => state.players[playerId]?.avatarZone.some(avatar => avatar.instanceId === targetAvatarId))
    : undefined;
  const targetRequired = parsed.needsTargetAvatar || parsed.destroysTarget || parsed.bouncesTarget ||
    parsed.resetsPower || (parsed.powerMod !== 0 && triggerType !== 'ON_ATTACK');
  const targetIsLegal = !targetRequired || (!!targetOwnerId &&
    (parsed.targetScope !== 'OWN_AVATAR' || targetOwnerId === actorId) &&
    (parsed.targetScope !== 'OPPONENT_AVATAR' || targetOwnerId !== actorId));
  if (!targetIsLegal) {
    logs.push(`${sourceCard.card.name}: เป้าหมายไม่ถูกต้องหรือไม่ได้เลือกเป้าหมาย ผลของการ์ดไม่ทำงาน`);
    return { state, logs };
  }

  const effectText = sourceCard.card.mainEffect || '';
  const effectDefinitions: Array<{ position: number; effect: EffectDefinition }> = [];
  const addEffect = (needle: string, effect: EffectDefinition) => {
    const position = effectText.indexOf(needle);
    if (position >= 0) effectDefinitions.push({ position, effect });
  };
  if (parsed.drawCount > 0) addEffect('จั่ว', { kind: 'draw', playerId: actorId, count: parsed.drawCount });
  if (parsed.destroysAllOpponentAvatars) addEffect('ทำลาย Avatar', { kind: 'destroy_opponent_avatars', actorId });
  if (triggerType === 'ON_ATTACK' && parsed.powerMod !== 0) {
    effectDefinitions.push({ position: effectText.indexOf('POWER'), effect: { kind: 'modify_power', targetId: sourceCard.instanceId, amount: parsed.powerMod, layer: 4, expiresAt: 'END_OF_TURN' } });
  } else if (targetAvatarId && parsed.destroysTarget) addEffect('ทำลาย', { kind: 'destroy_avatar', targetId: targetAvatarId });
  else if (targetAvatarId && parsed.bouncesTarget) addEffect('กลับขึ้นมือ', { kind: 'bounce_avatar', targetId: targetAvatarId });
  else if (targetAvatarId && parsed.resetsPower) addEffect('ปรับ', { kind: 'reset_power', targetId: targetAvatarId });
  else if (targetAvatarId && parsed.powerMod !== 0) addEffect('POWER', { kind: 'modify_power', targetId: targetAvatarId, amount: parsed.powerMod });
  if (parsed.recoversFromHell > 0) {
    const destination = /นรก.{0,80}นำขึ้นมือ|นำขึ้นมือ.{0,80}นรก/.test(effectText) ? 'hand' : 'deck';
    addEffect('นรก', { kind: 'recover_from_hell', playerId: actorId, count: parsed.recoversFromHell, destination });
  }
  if (parsed.summonsFromHell) {
    const candidates = actor.hell.filter(card => card.card.type === 'Avatar');
    if (candidates.length !== 1) {
      logs.push(`${sourceCard.card.name}: ต้องระบุ Avatar จากนรกอย่างชัดเจน จึงไม่ทำผลใด ๆ`);
      return { state, logs };
    }
    addEffect('นรก', { kind: 'summon_from_hell', playerId: actorId, instanceId: candidates[0].instanceId });
  }
  effectDefinitions.sort((left, right) => left.position - right.position);
  const resolved = resolveEffectPlan(state, { actorId, effects: effectDefinitions.map(item => item.effect) });
  if (!resolved.ok) {
    logs.push(`${sourceCard.card.name}: Effect Resolver ปฏิเสธผลทั้งหมด (${resolved.reason})`);
    return { state, logs };
  }
  const resolvedState = recomputeContinuousAuras(resolved.state);
  return { state: resolvedState, logs: effectDefinitions.map(({ effect }) => {
    switch (effect.kind) {
      case 'draw': return `${sourceCard.card.name}: จั่วการ์ด ${effect.count} ใบ`;
      case 'modify_power': return `${sourceCard.card.name}: ปรับ POWER ${effect.amount >= 0 ? '+' : ''}${effect.amount}`;
      case 'destroy_avatar': return `${sourceCard.card.name}: ทำลาย Avatar เป้าหมายลงนรก`;
      case 'bounce_avatar': return `${sourceCard.card.name}: นำ Avatar เป้าหมายกลับขึ้นมือ`;
      case 'destroy_opponent_avatars': return `${sourceCard.card.name}: ทำลาย Avatar ฝ่ายตรงข้ามทั้งหมด`;
      case 'recover_from_hell': return `${sourceCard.card.name}: นำการ์ดจากนรกกลับ${effect.destination === 'hand' ? 'ขึ้นมือ' : 'เข้า Deck'}`;
      case 'summon_from_hell': return `${sourceCard.card.name}: อัญเชิญ Avatar จากนรก`;
    }
  }) };

}

/** Expires only matching durations at the requested player's boundary across every card zone. */
export function expireModifiersAt(
  state: GameState,
  timing: 'END_OF_BATTLE' | 'END_OF_TURN' | 'DRAW_PHASE',
  playerId?: string
): GameState {
  const expireCard = (card: CardInstance): CardInstance => ({
    ...card,
    layerModifiers: card.layerModifiers.filter(modifier => modifier.expiresAt !== timing),
    attachedInstances: card.attachedInstances.map(expireCard)
  });
  const newPlayers: Record<string, PlayerState> = {};
  for (const [pid, player] of Object.entries(state.players)) {
    const mayExpire = playerId === undefined || pid === playerId;
    newPlayers[pid] = mayExpire ? {
      ...player,
      deck: player.deck.map(expireCard),
      hand: player.hand.map(expireCard),
      lifeDeck: player.lifeDeck.map(expireCard),
      avatarZone: player.avatarZone.map(expireCard),
      constructZone: player.constructZone.map(expireCard),
      magicZone: player.magicZone.map(expireCard),
      hell: player.hell.map(expireCard),
      darkDimension: player.darkDimension.map(expireCard)
    } : player;
  }
  const landMagicZone = state.landMagicZone && (playerId === undefined || state.landMagicZone.controllerId === playerId)
    ? expireCard(state.landMagicZone)
    : state.landMagicZone;
  return recomputeContinuousAuras({ ...state, players: newPlayers, landMagicZone });
}

export function clearEndOfTurnModifiers(state: GameState): GameState {
  return expireModifiersAt(state, 'END_OF_TURN');
}
