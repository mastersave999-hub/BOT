import type { CardInstance, ContinuousPowerEffect, GameState, PlayerState, PreventionShield } from './types';
import { calculateEffectiveSymbol } from './layers';

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
  const relation = effect.targetController ?? 'SOURCE_CONTROLLER';
  if (relation === 'SOURCE_CONTROLLER' && target.controllerId !== source.controllerId) return false;
  if (relation === 'OPPONENT' && target.controllerId === source.controllerId) return false;
  if (effect.targetSymbol && !calculateEffectiveSymbol(target)?.includes(effect.targetSymbol)) return false;
  if (effect.targetNameIncludes && !target.card.name.includes(effect.targetNameIncludes)) return false;
  return true;
}

function cardPowerMod(card: CardInstance): number {
  const match = card.card.mainEffect.match(/POWER\s*([+-]\d+)/i);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function legacyAuras(state: GameState, sources: CardInstance[], target: CardInstance): Array<{ layer: 1 | 2; powerMod: number; sourceCardId: string }> {
  if (target.card.type !== 'Avatar') return [];
  const result: Array<{ layer: 1 | 2; powerMod: number; sourceCardId: string }> = [];
  for (const attached of target.attachedInstances) {
    const powerMod = cardPowerMod(attached);
    if (attached.card.type === 'Magic' && attached.card.subtype === 'Modification' && powerMod !== 0) {
      result.push({ layer: 1, powerMod, sourceCardId: `aura-mod-${attached.instanceId}` });
    }
  }
  for (const source of sources) {
    const text = source.card.mainEffect ?? '';
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
    const powerMod = cardPowerMod(land);
    const text = land.card.mainEffect ?? '';
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
      !modifier.sourceCardId.startsWith('continuous:') && !modifier.sourceCardId.startsWith('aura-')
    );
    const typed = sources.flatMap(source => (source.continuousEffects ?? []).flatMap((effect, index) =>
      isEffectTarget(source, effect, target) ? [{
        layer: effect.layer,
        powerMod: effect.powerMod,
        sourceCardId: `continuous:${source.instanceId}:${index}`
      }] : []
    ));
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

/** Rebuilds only derived source-based modifiers; printed card.power is never mutated. */
export function recomputeContinuousEffects(state: GameState): GameState {
  const activeCards = activeFieldCards(state);
  const sources = activeCards.filter(card => card.card.type === 'Avatar' || card.card.type === 'Construct' || card.card.subtype === 'Land');
  const activeSourceIds = new Set(activeCards.map(card => card.instanceId));
  const cleanShields = (card: CardInstance): CardInstance => ({
    ...card,
    preventionShields: card.preventionShields?.filter(shield => !shield.sourceInstanceId || activeSourceIds.has(shield.sourceInstanceId)),
    attachedInstances: card.attachedInstances.map(cleanShields)
  });
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
  const cleanedPlayers = Object.fromEntries(Object.entries(state.players).map(([id, player]) => [id, cleanPlayer(player)]));
  const cleanedLand = state.landMagicZone ? cleanShields(state.landMagicZone) : null;
  const cleanedState = { ...state, players: cleanedPlayers, landMagicZone: cleanedLand };
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
