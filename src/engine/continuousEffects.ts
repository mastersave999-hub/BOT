import type { CardInstance, ContinuousPowerEffect, GameState, PlayerState, PreventionShield } from './types';
import { calculateEffectiveSymbol } from './layers';
import { parseCardText } from './cardTextAdapter';
import { appendGameEvents, type GameEvent } from './gameEvents';
import { checkModificationEquip } from './equipLegality';

function flattenFieldCard(card: CardInstance): CardInstance[] {
  return [card, ...card.attachedInstances.flatMap(flattenFieldCard)];
}

function activeFieldCards(state: GameState): CardInstance[] {
  return [
    ...state.playerOrder.flatMap(playerId => {
      const player = state.players[playerId];
      return player ? [
        ...player.avatarZone.flatMap(flattenFieldCard),
        ...player.constructZone.flatMap(flattenFieldCard),
        ...player.magicZone.flatMap(flattenFieldCard)
      ] : [];
    }),
    ...(state.landMagicZone ? flattenFieldCard(state.landMagicZone) : [])
  ];
}

function isEffectTarget(source: CardInstance, effect: ContinuousPowerEffect, target: CardInstance): boolean {
  if (effect.targetCardType && target.card.type !== effect.targetCardType) return false;
  if (effect.targetSelf && target.instanceId !== source.instanceId) return false;
  const relation = effect.targetController ?? 'SOURCE_CONTROLLER';
  if (relation === 'SOURCE_CONTROLLER' && target.controllerId !== source.controllerId) return false;
  if (relation === 'OPPONENT' && target.controllerId === source.controllerId) return false;
  const targetSymbols = effect.targetSymbols ?? (effect.targetSymbol ? [effect.targetSymbol] : []);
  if (targetSymbols.length > 0 && !targetSymbols.some(symbol => calculateEffectiveSymbol(target)?.includes(symbol))) return false;
  if (effect.targetNameIncludes && !target.card.name.includes(effect.targetNameIncludes)) return false;
  return true;
}

function cardPowerMod(card: CardInstance): number {
  const match = card.card.mainEffect.match(/POWER\s*([+-]\d+)/i);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function legacyAuras(state: GameState, sources: CardInstance[], target: CardInstance): Array<{ layer: 1 | 2; powerMod: number; symbolMod?: string; sourceCardId: string }> {
  if (target.card.type !== 'Avatar') return [];
  const result: Array<{ layer: 1 | 2; powerMod: number; sourceCardId: string }> = [];
  for (const attached of target.attachedInstances) {
    const text = attached.card.mainEffect ?? '';
    let powerMod = cardPowerMod(attached);
    const conditionalPower = text.match(/ถ้า\s+Avatar\s+ที่สวมใส่การ์ดใบนี้คือ\s*["“]([^"”]+)["”][\s\S]{0,60}?POWER\s*([+-])\s*(\d+)\s*แทน/u);
    if (conditionalPower && target.card.name.includes(conditionalPower[1])) {
      powerMod = Number(conditionalPower[3]) * (conditionalPower[2] === '-' ? -1 : 1);
    }
    const symbolMod = text.match(/(?:ถูกเปลี่ยน|เปลี่ยน)\s*Symbol\s*(?:เป็น)?\s*\{?([^}\n.]+)\}?/i)?.[1]?.trim();
    if (attached.card.type === 'Magic' && attached.card.subtype === 'Modification' && (powerMod !== 0 || symbolMod)) {
      result.push({ layer: 1, powerMod, ...(symbolMod ? { symbolMod } : {}), sourceCardId: `aura-mod-${attached.instanceId}` });
    }
  }
  for (const source of sources) {
    const text = source.card.mainEffect ?? '';
    if (source.cardTextContinuousEffects?.length || (text.includes('ต่อเนื่อง') && !source.registeredContinuousAbilities?.length)) continue;
    const powerMod = cardPowerMod(source);
    if (powerMod === 0 || source.instanceId === state.landMagicZone?.instanceId) continue;
    if (source.card.type === 'Avatar' && !text.includes('ต่อเนื่อง')) continue;
    if (source.card.type !== 'Avatar' && source.card.type !== 'Construct') continue;
    const isSelf = source.instanceId === target.instanceId;
    const appliesToAll = !text.includes('ชื่อ') && !text.includes('{symbol');
    const matchesSymbol = /\{symbol\s+([^}]+)\}/.exec(text)?.[1];
    const matchesTribe = !!matchesSymbol && (calculateEffectiveSymbol(target)?.includes(matchesSymbol) ?? false);
    if (isSelf || appliesToAll || matchesTribe) {
      result.push({ layer: 2, powerMod, sourceCardId: `aura-cont-${source.instanceId}` });
    }
  }
  const land = state.landMagicZone;
  if (land) {
    const text = land.card.mainEffect ?? '';
    if (land.cardTextContinuousEffects?.length || (text.includes('ต่อเนื่อง') && !land.registeredContinuousAbilities?.length)) return result;
    const powerMod = cardPowerMod(land);
    const appliesToAll = !text.includes('ชื่อ') && !text.includes('{symbol');
    const matchesSymbol = /\{symbol\s+([^}]+)\}/.exec(text)?.[1];
    const matchesTribe = !!matchesSymbol && (calculateEffectiveSymbol(target)?.includes(matchesSymbol) ?? false);
    const matchesNames = ['กุ่ย', 'ฮอล', 'นาย'].some(name => text.includes(name) && target.card.name.includes(name));
    if (powerMod !== 0 && (appliesToAll || matchesTribe || matchesNames)) {
      result.push({ layer: 2, powerMod, sourceCardId: `aura-land-${land.instanceId}` });
    }
  }
  return result;
}

function recalculatePlayer(state: GameState, player: PlayerState, sources: CardInstance[]): PlayerState {
  const recalculate = (target: CardInstance): CardInstance => {
    const retained = target.layerModifiers.filter(modifier =>
      !modifier.sourceCardId.startsWith('continuous:') && !modifier.sourceCardId.startsWith('card-text-continuous:') && !modifier.sourceCardId.startsWith('aura-')
    );
    const typed = sources.flatMap(source => [
      ...(source.continuousEffects ?? []).flatMap((effect, index) => isEffectTarget(source, effect, target) ? [{
        layer: effect.layer, powerMod: effect.powerMod, ...(effect.symbolMod ? { symbolMod: effect.symbolMod } : {}),
        sourceCardId: `continuous:${source.instanceId}:${index}`
      }] : []),
      ...(source.cardTextContinuousEffects ?? []).flatMap((effect, index) => isEffectTarget(source, effect, target) ? [{
        layer: effect.layer, powerMod: effect.powerMod, ...(effect.symbolMod ? { symbolMod: effect.symbolMod } : {}),
        sourceCardId: `card-text-continuous:${source.instanceId}:${index}`
      }] : [])
    ]);
    const derived = [...legacyAuras(state, sources, target), ...typed]
      .sort((left, right) => left.layer - right.layer || left.sourceCardId.localeCompare(right.sourceCardId));
    return {
      ...target,
      layerModifiers: [...retained, ...derived],
      attachedInstances: target.attachedInstances.map(recalculate)
    };
  };
  return {
    ...player,
    avatarZone: player.avatarZone.map(recalculate),
    constructZone: player.constructZone.map(recalculate),
    magicZone: player.magicZone.map(recalculate)
  };
}

function enforceModificationEquipLegality(state: GameState): GameState {
  const players = { ...state.players };
  const events: GameEvent[] = [];
  for (const playerId of state.playerOrder) {
    const player = players[playerId];
    if (!player) continue;
    const avatarZone = player.avatarZone.map(avatar => {
      const kept: CardInstance[] = [];
      for (const attached of avatar.attachedInstances) {
        if (attached.card.type !== 'Magic' || attached.card.subtype !== 'Modification') {
          kept.push(attached);
          continue;
        }
        const legality = checkModificationEquip(attached.card, avatar.card);
        if (legality.legal) {
          kept.push(attached);
          continue;
        }
        const ownerId = attached.originalOwnerId ?? attached.ownerId;
        const owner = players[ownerId];
        if (!owner) {
          kept.push(attached);
          continue;
        }
        players[ownerId] = { ...owner, hell: [...owner.hell, { ...attached, attachedInstances: [] }] };
        events.push({
          type: 'CARD_MOVED', instanceId: attached.instanceId, ownerId, controllerId: attached.controllerId,
          from: `${playerId}:attached:${avatar.instanceId}`, to: `${ownerId}:hell`, actorId: avatar.controllerId,
          eventId: `${state.id}:${state.gameEvents?.length ?? 0}:equip-illegal:${attached.instanceId}:${avatar.instanceId}`
        });
        events.push({
          type: 'CARD_LEFT_FIELD', instanceId: attached.instanceId, ownerId, controllerId: attached.controllerId,
          actorId: avatar.controllerId,
          eventId: `${state.id}:${state.gameEvents?.length ?? 0}:equip-illegal-left:${attached.instanceId}:${avatar.instanceId}`
        });
      }
      return kept.length === avatar.attachedInstances.length ? avatar : { ...avatar, attachedInstances: kept };
    });
    players[playerId] = { ...players[playerId], avatarZone };
  }
  const next = { ...state, players };
  return events.length ? appendGameEvents(next, events) : next;
}

/** Rebuilds only derived source-based modifiers; printed card.power is never mutated. */
export function recomputeContinuousEffects(state: GameState): GameState {
  const legallyEquippedState = enforceModificationEquipLegality(state);
  const activeCards = activeFieldCards(legallyEquippedState);
  const sources = activeCards.filter(card => card.card.type === 'Avatar' || card.card.type === 'Construct' || card.card.subtype === 'Land');
  const activeSourceIds = new Set(activeCards.map(card => card.instanceId));
  const cleanShields = (card: CardInstance): CardInstance => {
    const { registeredActivatedAbilities: _oldActivated, registeredContinuousAbilities: _oldContinuous,
      cardTextContinuousEffects: _oldTextEffects, ...base } = card;
    const active = activeSourceIds.has(card.instanceId) &&
      (card.card.type === 'Avatar' || card.card.type === 'Construct' || card.card.subtype === 'Land');
    const parsed = active ? parseCardText(card.card) : undefined;
    return {
      ...base,
      preventionShields: card.preventionShields?.filter(shield => !shield.sourceInstanceId || activeSourceIds.has(shield.sourceInstanceId)),
      ...(parsed?.status === 'PARSED_READY' ? {
        registeredActivatedAbilities: parsed.clauses.filter(clause => clause.timing.mode === 'ACTIVATED'),
        registeredContinuousAbilities: parsed.clauses.filter(clause => clause.timing.mode === 'CONTINUOUS'),
        cardTextContinuousEffects: parsed.continuousEffects
      } : {}),
      attachedInstances: card.attachedInstances.map(cleanShields)
    };
  };
  const cleanPlayer = (player: PlayerState): PlayerState => ({
    ...player,
    preventionShields: player.preventionShields?.filter(shield => !shield.sourceInstanceId || activeSourceIds.has(shield.sourceInstanceId)),
    deck: player.deck.map(cleanShields),
    hand: player.hand.map(cleanShields),
    lifeDeck: player.lifeDeck.map(cleanShields),
    avatarZone: player.avatarZone.map(cleanShields),
    constructZone: player.constructZone.map(cleanShields),
    magicZone: player.magicZone.map(cleanShields),
    hell: player.hell.map(cleanShields),
    darkDimension: player.darkDimension.map(cleanShields)
  });
  const cleanedPlayers = Object.fromEntries(Object.entries(legallyEquippedState.players).map(([id, player]) => [id, cleanPlayer(player)]));
  const cleanedLand = legallyEquippedState.landMagicZone ? cleanShields(legallyEquippedState.landMagicZone) : null;
  const cleanedState = { ...legallyEquippedState, players: cleanedPlayers, landMagicZone: cleanedLand };
  const cleanedSources = activeFieldCards(cleanedState).filter(card => card.card.type === 'Avatar' || card.card.type === 'Construct' || card.card.subtype === 'Land');
  const players = Object.fromEntries(Object.entries(cleanedState.players).map(([id, player]) => [id, recalculatePlayer(cleanedState, player, cleanedSources)]));
  return { ...cleanedState, players };
}

export function expirePreventionShieldsAt(state: GameState, timing: PreventionShield['expiresAt'], playerId?: string): GameState {
  if (!timing) return state;
  const expire = (card: CardInstance): CardInstance => ({
    ...card,
    preventionShields: card.preventionShields?.filter(shield => shield.expiresAt !== timing),
    attachedInstances: card.attachedInstances.map(expire)
  });
  const players = Object.fromEntries(Object.entries(state.players).map(([id, player]) => {
    const mayExpire = playerId === undefined || id === playerId;
    if (!mayExpire) return [id, player];
    return [id, {
      ...player,
      preventionShields: player.preventionShields?.filter(shield => shield.expiresAt !== timing),
      deck: player.deck.map(expire), hand: player.hand.map(expire), lifeDeck: player.lifeDeck.map(expire),
      avatarZone: player.avatarZone.map(expire), constructZone: player.constructZone.map(expire),
      magicZone: player.magicZone.map(expire), hell: player.hell.map(expire), darkDimension: player.darkDimension.map(expire)
    }];
  }));
  const landMagicZone = state.landMagicZone && (playerId === undefined || state.landMagicZone.controllerId === playerId)
    ? expire(state.landMagicZone)
    : state.landMagicZone;
  return { ...state, players, landMagicZone };
}
