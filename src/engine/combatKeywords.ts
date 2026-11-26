import type { CardInstance, GameState } from './types';
import { avatarHasKeyword } from './abilityEngine';
import { calculateNetPower } from './layers';
import { moveCardBetweenZones } from './gameRules';
import { appendGameEvents } from './gameEvents';

export type AttackTarget = { type: 'AVATAR'; playerId: string; instanceId: string } | { type: 'CONSTRUCT'; playerId: string; instanceId: string } | { type: 'LIFE'; playerId: string };

function findAvatar(state: GameState, id: string): { playerId: string; avatar: CardInstance } | undefined {
  for (const playerId of state.playerOrder) {
    const avatar = state.players[playerId]?.avatarZone.find(card => card.instanceId === id);
    if (avatar) return { playerId, avatar };
  }
}

export function canDeclareAttack(state: GameState, attackerId: string, target: AttackTarget): boolean {
  const found = findAvatar(state, attackerId);
  if (!found || found.avatar.isRested || found.playerId !== state.playerOrder[state.currentTurnPlayerIndex] || !state.players[target.playerId]) return false;
  if (target.playerId === found.playerId) return false;
  if (target.type === 'AVATAR') return !!state.players[target.playerId]?.avatarZone.some(card => card.instanceId === target.instanceId);
  if (target.type === 'CONSTRUCT') return !!state.players[target.playerId]?.constructZone.some(card => card.instanceId === target.instanceId);
  const defenders = state.players[target.playerId]?.avatarZone ?? [];
  return defenders.length === 0 || avatarHasKeyword(found.avatar, 'เตะไข่');
}

/** Rest the attacker, snapshot its Layer 0–2 POWER, and emit the typed declaration event. */
export function declareCombatAttack(state: GameState, attackerId: string, target: AttackTarget): GameState | null {
  if (state.battleContext || !canDeclareAttack(state, attackerId, target)) return null;
  const found = findAvatar(state, attackerId)!;
  const player = state.players[found.playerId];
  const avatarZone = player.avatarZone.map(avatar => avatar.instanceId === attackerId ? { ...avatar, isRested: true } : avatar);
  const targetType = target.type;
  const targetId = target.type === 'LIFE' ? `${target.playerId}:LIFE` : target.instanceId;
  const next: GameState = {
    ...state,
    players: { ...state.players, [player.id]: { ...player, avatarZone } },
    battleContext: {
      attackerInstanceId: attackerId,
      targetType,
      targetPlayerId: target.playerId,
      ...(target.type !== 'LIFE' ? { targetInstanceId: target.instanceId } : {}),
      step: 1,
      snapshotPower: calculateNetPower(found.avatar),
      unityHelpers: [],
      isDirectEggKick: target.type === 'LIFE' && (state.players[target.playerId].avatarZone.length > 0)
    }
  };
  return appendGameEvents(next, [{ type: 'ATTACK_DECLARED', attackerId, targetId, playerId: found.playerId, eventId: `${state.id}:${state.gameEvents?.length ?? 0}:ATTACK_DECLARED:${attackerId}:${targetId}` }]);
}

/** Human Shield redirects a declared attack only when the shield Avatar is ready. */
export function applyHumanShieldRedirect(state: GameState, target: AttackTarget): { state: GameState; target: AttackTarget; redirected: boolean } {
  const player = state.players[target.playerId];
  const shield = player?.avatarZone.find(avatar => !avatar.isRested && (target.type !== 'AVATAR' || avatar.instanceId !== target.instanceId) && avatarHasKeyword(avatar, 'โล่มนุษย์'));
  if (!player || !shield) return { state, target, redirected: false };
  const avatarZone = player.avatarZone.map(avatar => avatar.instanceId === shield.instanceId ? { ...avatar, isRested: true } : avatar);
  return { state: { ...state, players: { ...state.players, [player.id]: { ...player, avatarZone } } }, target: { type: 'AVATAR', playerId: player.id, instanceId: shield.instanceId }, redirected: true };
}

/** Unity and Backstab pay by resting their helper and add its POWER (Backstab +1) through the attack. */
export function payCombatKeyword(state: GameState, attackerId: string, helperId: string, keyword: 'สามัคคี' | 'แทงหลัง'): GameState | null {
  const attacker = findAvatar(state, attackerId);
  const helper = findAvatar(state, helperId);
  if (!attacker || !helper || attacker.playerId !== helper.playerId || attackerId === helperId || helper.avatar.isRested) return null;
  if (!avatarHasKeyword(helper.avatar, keyword)) return null;
  const amount = calculateNetPower(helper.avatar) + (keyword === 'แทงหลัง' ? 1 : 0);
  const players = { ...state.players };
  players[helper.playerId] = { ...players[helper.playerId], avatarZone: players[helper.playerId].avatarZone.map(avatar => avatar.instanceId === helperId ? { ...avatar, isRested: true } : avatar) };
  players[attacker.playerId] = { ...players[attacker.playerId], avatarZone: players[attacker.playerId].avatarZone.map(avatar => avatar.instanceId === attackerId ? {
    ...avatar, layerModifiers: [...avatar.layerModifiers, { layer: 4, powerMod: amount, sourceCardId: `${keyword}:${helperId}`, expiresAt: 'END_OF_BATTLE' }]
  } : avatar) };
  return { ...state, players };
}

/** Rule Book p.20: a player may pair a compatible, not-yet-paired Duo Avatar once each turn. */
export function declareDuo(state: GameState, firstId: string, secondId: string): GameState | null {
  const first = findAvatar(state, firstId);
  const second = findAvatar(state, secondId);
  if (!first || !second || first.playerId !== second.playerId || firstId === secondId) return null;
  if (first.avatar.duoWithInstanceId || second.avatar.duoWithInstanceId) return null;
  if (!avatarHasKeyword(first.avatar, 'คู่หู') && !avatarHasKeyword(second.avatar, 'คู่หู')) return null;
  const playerId = first.playerId;
  const key = `${state.turnNumber}:${playerId}:DUO`;
  if (state.triggerUsage?.includes(key)) return null;
  // Pair eligibility is a typed caller decision because the Rule Book delegates the named partner to each card's text.
  const players = { ...state.players, [playerId]: { ...state.players[playerId], avatarZone: state.players[playerId].avatarZone.map(avatar => avatar.instanceId === firstId
    ? { ...avatar, duoWithInstanceId: secondId, controlChangeImmune: true }
    : avatar.instanceId === secondId ? { ...avatar, duoWithInstanceId: firstId, controlChangeImmune: true } : avatar) } };
  return { ...state, players, triggerUsage: [...(state.triggerUsage ?? []), key] };
}

/** Clears both members when a member leaves its controller's Avatar Zone. */
export function breakDuoPair(state: GameState, leavingId: string): GameState {
  const leaving = [...Object.values(state.players).flatMap(player => [...player.avatarZone, ...player.hand, ...player.hell, ...player.magicZone, ...player.constructZone]), state.landMagicZone].find(card => card?.instanceId === leavingId);
  const partnerId = leaving?.duoWithInstanceId;
  if (!partnerId) return state;
  const players = Object.fromEntries(Object.entries(state.players).map(([id, player]) => [id, {
    ...player,
    avatarZone: player.avatarZone.map(avatar => avatar.instanceId === partnerId ? { ...avatar, duoWithInstanceId: undefined, controlChangeImmune: false } : avatar)
  }]));
  return { ...state, players };
}

export interface ConstructAttackResult {
  ok: boolean;
  state: GameState;
  constructDestroyed: boolean;
  reason?: string;
}

/** Rule Book p.23: Construct attack is not combat and only strictly greater POWER destroys it. */
export function resolveConstructAttack(state: GameState, attackerId: string, constructId: string): ConstructAttackResult {
  const foundAttacker = findAvatar(state, attackerId);
  const target = state.playerOrder.flatMap(playerId => (state.players[playerId]?.constructZone ?? []).map(construct => ({ playerId, construct })))
    .find(({ construct }) => construct.instanceId === constructId);
  if (!foundAttacker || !target || foundAttacker.playerId === target.playerId || foundAttacker.avatar.isRested) {
    return { ok: false, state, constructDestroyed: false, reason: 'Illegal Construct attack' };
  }
  if (calculateNetPower(foundAttacker.avatar) <= calculateNetPower(target.construct)) {
    return { ok: true, state, constructDestroyed: false };
  }
  const moved = moveCardBetweenZones(state, { instanceId: constructId, actorId: foundAttacker.playerId, destination: 'hell', destinationPlayerId: target.construct.originalOwnerId ?? target.construct.ownerId, effectMove: true, cause: 'COMBAT' });
  return moved.ok
    ? { ok: true, state: moved.state, constructDestroyed: !moved.reason }
    : { ok: false, state, constructDestroyed: false, reason: moved.reason };
}

/** Backstab's delayed penalty: after the attack, destroy the attacker if its color differs. */
export function backstabPenalty(attacker: CardInstance, helper: CardInstance): boolean {
  return attacker.card.color !== helper.card.color;
}
