import { appendGameEvents } from './gameEvents';
import type { CardInstance, GameState, PreventionShield } from './types';

export interface PreventionResult {
  prevented: boolean;
  preventedAmount: number;
  remainingAmount: number;
  state: GameState;
}

type PreventionKind = PreventionShield['kind'];

function findNestedCard(card: CardInstance, instanceId: string): CardInstance | undefined {
  if (card.instanceId === instanceId) return card;
  for (const attached of card.attachedInstances) {
    const found = findNestedCard(attached, instanceId);
    if (found) return found;
  }
  return undefined;
}

function findTarget(state: GameState, instanceId: string): { playerId: string; card: CardInstance } | undefined {
  for (const playerId of state.playerOrder) {
    const player = state.players[playerId];
    for (const zone of ['avatarZone', 'constructZone', 'magicZone'] as const) {
      const card = player?.[zone].map(item => findNestedCard(item, instanceId)).find(Boolean);
      if (card) return { playerId, card };
    }
  }
  if (state.landMagicZone) {
    const card = findNestedCard(state.landMagicZone, instanceId);
    if (card) return { playerId: state.landMagicZone.controllerId, card };
  }
  return undefined;
}

function eventState(
  state: GameState,
  shield: PreventionShield,
  kind: PreventionKind,
  actorId: string,
  targetId: string,
  targetPlayerId: string,
  preventedAmount: number
): GameState {
  const eventId = `${state.id}:${state.gameEvents?.length ?? 0}:prevention:${shield.id}:${kind}:${targetId}:${actorId}`;
  return appendGameEvents(state, [{
    type: 'PREVENTION_APPLIED', shieldId: shield.id, kind, actorId, targetId, targetPlayerId, preventedAmount, eventId
  }]);
}

function updateCardShield(state: GameState, targetId: string, shieldId: string, actorId: string, kind: PreventionKind, targetPlayerId: string, preventedAmount: number): GameState {
  const found = findTarget(state, targetId);
  if (!found) return state;
  const shields = found.card.preventionShields ?? [];
  const shield = shields.find(item => item.id === shieldId);
  if (!shield) return state;
  const nextShields = shield.usesRemaining === undefined
    ? shields
    : shield.usesRemaining <= 1
      ? shields.filter(item => item.id !== shieldId)
      : shields.map(item => item.id === shieldId ? { ...item, usesRemaining: item.usesRemaining - 1 } : item);
  let next = state;
  if (state.landMagicZone?.instanceId === targetId) {
    next = { ...state, landMagicZone: { ...found.card, preventionShields: nextShields } };
  } else {
    const player = state.players[found.playerId];
    const zone = player.avatarZone.some(card => card.instanceId === targetId) ? 'avatarZone'
      : player.constructZone.some(card => card.instanceId === targetId) ? 'constructZone' : 'magicZone';
    next = { ...state, players: { ...state.players, [found.playerId]: {
      ...player,
      [zone]: player[zone].map(card => card.instanceId === targetId ? { ...card, preventionShields: nextShields } : card)
    } } };
  }
  return eventState(next, shield, kind, actorId, targetId, targetPlayerId, preventedAmount);
}

function shieldController(state: GameState, shield: PreventionShield, fallbackControllerId: string): string {
  if (shield.sourceControllerId) return shield.sourceControllerId;
  if (shield.sourceInstanceId) return findTarget(state, shield.sourceInstanceId)?.card.controllerId ?? fallbackControllerId;
  return fallbackControllerId;
}

function matchesCause(shield: PreventionShield, cause: 'EFFECT' | 'COMBAT' | 'PLAYER_ACTION'): boolean {
  return cause !== 'PLAYER_ACTION' || shield.includePlayerActions === true;
}

export function preventTargeting(state: GameState, actorId: string, targetId: string): PreventionResult {
  const found = findTarget(state, targetId);
  if (!found) return { prevented: false, preventedAmount: 0, remainingAmount: 0, state };
  const shield = [...(found.card.preventionShields ?? [])]
    .filter(item => item.kind === 'TARGETING' && item.usesRemaining !== 0 && shieldController(state, item, found.card.controllerId) !== actorId)
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (!shield) return { prevented: false, preventedAmount: 0, remainingAmount: 0, state };
  return {
    prevented: true, preventedAmount: 1, remainingAmount: 0,
    state: updateCardShield(state, targetId, shield.id, actorId, 'TARGETING', found.playerId, 1)
  };
}

export function preventDestruction(
  state: GameState,
  actorId: string,
  targetId: string,
  cause: 'EFFECT' | 'COMBAT' | 'PLAYER_ACTION' = 'EFFECT'
): PreventionResult {
  const found = findTarget(state, targetId);
  if (!found) return { prevented: false, preventedAmount: 0, remainingAmount: 0, state };
  const shields = [...(found.card.preventionShields ?? [])]
    .filter(item => item.kind === 'DESTRUCTION' && (item.mode ?? 'AUTOMATIC') === 'AUTOMATIC' && item.usesRemaining !== 0 && matchesCause(item, cause))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (shields.length === 0) return { prevented: false, preventedAmount: 0, remainingAmount: 0, state };
  let next = state;
  for (const shield of shields) {
    const current = findTarget(next, targetId);
    if (current?.card.preventionShields?.some(item => item.id === shield.id)) {
      next = updateCardShield(next, targetId, shield.id, actorId, 'DESTRUCTION', current.playerId, 1);
    }
  }
  return { prevented: true, preventedAmount: 1, remainingAmount: 0, state: next };
}

export function preventDestructionByReaction(
  state: GameState,
  actorId: string,
  targetId: string,
  exitEventId: string,
  shieldId: string,
  cause: 'EFFECT' | 'COMBAT' | 'PLAYER_ACTION' = 'EFFECT'
): PreventionResult {
  const found = findTarget(state, targetId);
  if (!found || !state.reactionWindow || !exitEventId) return { prevented: false, preventedAmount: 0, remainingAmount: 0, state };
  const attemptKey = `${exitEventId}:${targetId}`;
  if (state.preventionAttempts?.includes(attemptKey)) return { prevented: false, preventedAmount: 0, remainingAmount: 0, state };
  const automatic = preventDestruction(state, actorId, targetId, cause);
  if (automatic.prevented) return automatic;
  const shield = (found.card.preventionShields ?? []).find(item => item.id === shieldId && item.kind === 'DESTRUCTION' && item.mode === 'ACTIVATED' && item.usesRemaining !== 0 && matchesCause(item, cause));
  if (!shield || shieldController(state, shield, found.card.controllerId) !== actorId) return { prevented: false, preventedAmount: 0, remainingAmount: 0, state };
  const consumed = updateCardShield(state, targetId, shield.id, actorId, 'DESTRUCTION', found.playerId, 1);
  return {
    prevented: true,
    preventedAmount: 1,
    remainingAmount: 0,
    state: { ...consumed, preventionAttempts: [...(consumed.preventionAttempts ?? []), attemptKey] }
  };
}

export function preventDamage(state: GameState, targetPlayerId: string, amount: number, actorId = 'game'): PreventionResult {
  if (!Number.isFinite(amount) || amount <= 0 || !state.players[targetPlayerId]) {
    return { prevented: false, preventedAmount: 0, remainingAmount: amount, state };
  }
  let remainingAmount = amount;
  let next = state;
  const player = next.players[targetPlayerId];
  const shields = [...(player.preventionShields ?? [])]
    .filter(item => item.kind === 'DAMAGE' && item.usesRemaining !== 0)
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const shield of shields) {
    if (remainingAmount <= 0) break;
    const reduction = Math.min(remainingAmount, shield.amount ?? remainingAmount);
    if (reduction <= 0) continue;
    remainingAmount -= reduction;
    const nextShields = shield.usesRemaining === undefined
      ? next.players[targetPlayerId].preventionShields
      : shield.usesRemaining <= 1
        ? (next.players[targetPlayerId].preventionShields ?? []).filter(item => item.id !== shield.id)
        : (next.players[targetPlayerId].preventionShields ?? []).map(item => item.id === shield.id ? { ...item, usesRemaining: item.usesRemaining - 1 } : item);
    next = { ...next, players: { ...next.players, [targetPlayerId]: { ...next.players[targetPlayerId], preventionShields: nextShields } } };
    next = eventState(next, shield, 'DAMAGE', actorId, targetPlayerId, targetPlayerId, reduction);
  }
  return { prevented: remainingAmount < amount, preventedAmount: amount - remainingAmount, remainingAmount, state: next };
}
