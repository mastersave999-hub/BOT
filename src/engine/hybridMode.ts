import type {
  Card,
  CardInstance,
  GameState,
  ManualOverrideAction,
  ManualOverrideContext,
  PendingManualOverride,
} from './types';
import { parseCardText } from './cardTextAdapter';
import {
  moveCardBetweenZones,
  validateGameState,
  type PlayerZone,
} from './gameRules';
import { appendGameEvents, type GameEvent } from './gameEvents';

export type CardVerificationStatus = 'VERIFIED_WORKING' | 'UNSUPPORTED' | 'AMBIGUOUS';

export interface CardClassification {
  status: CardVerificationStatus;
  reason?: string;
}

/**
 * Phase 5 classification. A card is VERIFIED_WORKING only when the Rule Book 3.2 adapter parses it
 * completely and every clause is fully executable without timing/event or keyword interpretation,
 * matching the Phase 4 verification blockers. Everything else falls back to manual resolution.
 */
export function classifyCard(card: Card): CardClassification {
  const text = card.mainEffect ?? '';
  if (!text.trim()) return { status: 'VERIFIED_WORKING', reason: 'Vanilla card without rule text' };
  const parsed = parseCardText(card);
  if (parsed.status !== 'PARSED_READY') return { status: parsed.status, reason: parsed.reason };
  const blockers: string[] = [];
  if (parsed.clauses.some(clause => clause.effects.length === 0 && !clause.equipRestriction && !clause.attachedEndPhaseReady &&
    !(parsed.continuousEffects.length > 0 && parsed.clauses.length === 1))) {
    blockers.push('no executable effect in one or more clauses');
  }
  if (parsed.clauses.some(clause => clause.unresolved.length > 0)) blockers.push('unresolved AST clause');
  if (parsed.clauses.some(clause => clause.timing.mode || clause.timing.event || clause.timing.frequency)) {
    blockers.push('timing/event context not verified');
  }
  if (parsed.clauses.some(clause => clause.keywordSpecs.length > 0)) blockers.push('keyword behavior not verified');
  if (parsed.clauses.some(clause => /เมื่อ|จุติ|คำสั่งเสีย|อัตโนมัติ|ต่อเนื่อง|เทิร์นละครั้ง|สั่งใช้/.test(clause.source))) {
    blockers.push('timing/event context not verified');
  }
  if (blockers.length === 0) return { status: 'VERIFIED_WORKING' };
  return { status: 'UNSUPPORTED', reason: blockers.join('; ') };
}

export function isCardFullyVerified(card: Card): boolean {
  return classifyCard(card).status === 'VERIFIED_WORKING';
}

/**
 * Log markers the ability engine emits when it refuses to resolve a printed effect
 * (see `executeCardAbility` in abilityEngine.ts). They are the engine's own signal
 * that the hybrid pipeline could not carry the card further.
 */
const ENGINE_UNRESOLVED_MARKERS: readonly string[] = [
  'ยังไม่รองรับ',
  'ยังไม่มีตัวจัดการผลของความสามารถนี้'
];

/** True only when the engine itself reported that it could not resolve an effect. */
export function engineRequiresManualResolution(logs: readonly string[]): boolean {
  return logs.some(log => ENGINE_UNRESOLVED_MARKERS.some(marker => log.includes(marker)));
}

/**
 * Phase 6: manual resolution is granular. A MANUAL/UNSUPPORTED classification badge
 * alone never forces the fallback procedure — the manual confirmation flow is offered
 * only when the engine actually ran the card's resolution pipeline and reported that
 * it could not resolve the printed effect.
 */
export function shouldOfferManualResolution(
  classification: CardClassification,
  logs: readonly string[]
): boolean {
  if (classification.status === 'VERIFIED_WORKING') return false;
  return engineRequiresManualResolution(logs);
}

/** Auto-Strict rooms reject any deck containing a card the engine cannot resolve automatically. */
export function deckViolatesAutoStrict(cards: readonly Card[]): Card | null {
  return cards.find(card => !isCardFullyVerified(card)) ?? null;
}

export interface ManualOverrideResult {
  ok: boolean;
  state: GameState;
  reason?: string;
  applied?: boolean;
}

const FIELD_ZONES: readonly PlayerZone[] = ['avatarZone', 'constructZone', 'magicZone'];

function findInstance(
  state: GameState,
  instanceId: string
): { playerId: string; zone: PlayerZone; card: CardInstance } | undefined {
  for (const playerId of state.playerOrder) {
    const player = state.players[playerId];
    if (!player) continue;
    for (const zone of FIELD_ZONES) {
      const card = player[zone].find(item => item.instanceId === instanceId);
      if (card) return { playerId, zone, card };
    }
  }
  return undefined;
}

function validCommandId(commandId: string): boolean {
  return typeof commandId === 'string' && commandId.length > 0 && commandId.length <= 128;
}

/** Thai description used by the public Match Action Log and the approval banner. */
export function describeManualOverrideAction(state: GameState, action: ManualOverrideAction): string {
  const nameOf = (playerId: string) => state.players[playerId]?.name ?? playerId;
  const cardName = (instanceId: string) => {
    for (const player of Object.values(state.players)) {
      for (const zone of ['deck', 'hand', 'lifeDeck', 'avatarZone', 'constructZone', 'magicZone', 'hell', 'darkDimension'] as const) {
        const found = player[zone].find(item => item.instanceId === instanceId);
        if (found) return found.card.name;
      }
    }
    return instanceId;
  };
  switch (action.kind) {
    case 'ADJUST_POWER':
      return `ปรับ POWER ${action.delta > 0 ? '+' : ''}${action.delta} ให้ "${cardName(action.instanceId)}"`;
    case 'SET_WAKE_STATE':
      return `${action.isRested ? 'เปลี่ยนเป็นสภาพนอน' : 'เปลี่ยนเป็นสภาพตื่น'} "${cardName(action.instanceId)}"`;
    case 'MOVE_CARD':
      return `ย้าย "${cardName(action.instanceId)}" ไปยัง ${action.destination}${action.destinationPlayerId ? ` ของ ${nameOf(action.destinationPlayerId)}` : ''}`;
    case 'DRAW_CARD':
      return `${nameOf(action.playerId)} จั่วการ์ด 1 ใบ`;
    case 'DISCARD_CARD':
      return `ทิ้ง "${cardName(action.instanceId)}" ลงนรก`;
    case 'ADJUST_LIFE':
      return `${action.face === 'up' ? 'เซ็น LIFE (หงาย 1 ใบ)' : 'ฮีล LIFE (คว่ำ 1 ใบ)'} ของ ${nameOf(action.playerId)}`;
  }
}

function validateManualOverrideAction(state: GameState, actorId: string, action: ManualOverrideAction): string | null {
  if (!action || typeof action !== 'object') return 'Invalid manual override action';
  switch (action.kind) {
    case 'ADJUST_POWER': {
      if (!Number.isSafeInteger(action.delta) || action.delta === 0) return 'POWER adjustment must be a non-zero integer';
      if (!findInstance(state, action.instanceId)) return 'POWER target is not on a field zone';
      return null;
    }
    case 'SET_WAKE_STATE': {
      if (typeof action.isRested !== 'boolean') return 'Wake state must be a boolean';
      const found = findInstance(state, action.instanceId);
      if (!found || found.zone !== 'avatarZone') return 'Wake state target must be an Avatar on an Avatar Zone';
      return null;
    }
    case 'MOVE_CARD': {
      if (!['deck', 'hand', 'avatarZone', 'constructZone', 'magicZone', 'hell', 'darkDimension'].includes(action.destination)) {
        return 'Invalid manual move destination';
      }
      if (action.deckPosition !== undefined && !['top', 'bottom'].includes(action.deckPosition)) return 'Invalid Deck position';
      if (action.destinationPlayerId !== undefined && !state.players[action.destinationPlayerId]) return 'Destination player does not exist';
      const found = findInstance(state, action.instanceId);
      if (!found) return 'Manual move target is not on a field zone';
      return null;
    }
    case 'DRAW_CARD': {
      if (action.playerId !== actorId) return 'Only the active player may draw with a manual override';
      const player = state.players[action.playerId];
      if (!player) return 'Draw player does not exist';
      if (player.deck.length === 0) return 'Deck is empty';
      return null;
    }
    case 'DISCARD_CARD': {
      const player = state.players[actorId];
      if (!player?.hand.some(card => card.instanceId === action.instanceId)) return 'Discard target is not in your hand';
      return null;
    }
    case 'ADJUST_LIFE': {
      if (!['up', 'down'].includes(action.face)) return 'Invalid LIFE face';
      const player = state.players[action.playerId];
      if (!player) return 'LIFE player does not exist';
      if (action.face === 'up' && !player.lifeDeck.some(card => !card.isFaceUp)) return 'No face-down LIFE card to deal';
      if (action.face === 'down' && !player.lifeDeck.some(card => card.isFaceUp)) return 'No face-up LIFE card to heal';
      return null;
    }
    default:
      return 'Unknown manual override action';
  }
}

function noPendingChoice(state: GameState): boolean {
  return !state.pendingDeckChoice && !state.pendingHellChoice && !state.pendingDeckSearchVerification &&
    !state.pendingEndPhaseDiscardPlayerId && !state.pendingExitPrevention && !state.pendingManualOverride;
}

function appendEventLog(state: GameState, descriptions: string[], actorId: string, type = 'MANUAL_OVERRIDE'): GameState {
  if (descriptions.length === 0) return state;
  return {
    ...state,
    eventLog: [
      ...state.eventLog,
      ...descriptions.map(description => ({ timestamp: Date.now(), type, description, actorId }))
    ]
  };
}

/**
 * Stages a manual override for the active player. The action is validated against Rule Book limits
 * (zone capacity is enforced again at application time) and waits for opponent approval.
 */
export function beginManualOverride(
  state: GameState,
  actorId: string,
  action: ManualOverrideAction,
  context: ManualOverrideContext | undefined,
  commandId: string
): ManualOverrideResult {
  if (state.ruleMode === 'AUTO_STRICT') return { ok: false, state, reason: 'โหมด Auto-Strict ปิดการใช้ Manual Override' };
  if (!state.players[actorId]) return { ok: false, state, reason: 'Manual override actor does not exist' };
  if (state.playerOrder[state.currentTurnPlayerIndex] !== actorId) return { ok: false, state, reason: 'Only the active player may submit a manual override' };
  if (!noPendingChoice(state)) return { ok: false, state, reason: 'Another game action is pending' };
  if (state.reactionWindow) return { ok: false, state, reason: 'A reaction window is open' };
  if (!validCommandId(commandId)) return { ok: false, state, reason: 'Invalid manual override command identifier' };
  if ((state.processedCommandIds ?? []).includes(commandId)) return { ok: false, state, reason: 'Duplicate manual override command' };
  const actionError = validateManualOverrideAction(state, actorId, action);
  if (actionError) return { ok: false, state, reason: actionError };
  const revision = (state.stateRevision ?? 0) + 1;
  const pending: PendingManualOverride = {
    action,
    actorId,
    expectedRevision: revision,
    commandId,
    approvals: [],
    rejections: [],
    ...(context ? { context } : {})
  };
  const candidate: GameState = {
    ...state,
    stateRevision: revision,
    pendingManualOverride: pending,
    processedCommandIds: [...(state.processedCommandIds ?? []), commandId].slice(-128)
  };
  const error = validateGameState(candidate);
  if (error) return { ok: false, state, reason: error };
  const described = describeManualOverrideAction(state, action);
  const cardLabel = context?.cardName ? ` (การ์ด: ${context.cardName} — ${context.cardStatus ?? 'Manual Effect Resolution'})` : '';
  return {
    ok: true,
    state: appendEventLog(candidate, [`🔧 ${state.players[actorId].name} เสนอ Manual Override: ${described}${cardLabel} — รอคู่แข่งยืนยัน`], actorId)
  };
}

function applyStagedOverride(state: GameState, pending: PendingManualOverride): ManualOverrideResult {
  // The staged pending is cleared first so zone moves see a clean rules state.
  const cleared: GameState = { ...state, pendingManualOverride: undefined };
  const events: GameEvent[] = [];
  let next: GameState = cleared;
  const action = pending.action;
  if (action.kind === 'ADJUST_POWER') {
    const found = findInstance(next, action.instanceId);
    if (!found) return { ok: false, state, reason: 'POWER target disappeared' };
    const player = next.players[found.playerId];
    next = {
      ...next,
      players: {
        ...next.players,
        [found.playerId]: {
          ...player,
          [found.zone]: player[found.zone].map(card => card.instanceId === action.instanceId
            ? {
                ...card,
                layerModifiers: [...card.layerModifiers, {
                  layer: 2 as const,
                  powerMod: action.delta,
                  sourceCardId: `manual-override:${pending.commandId}`
                }]
              }
            : card)
        }
      }
    };
  } else if (action.kind === 'SET_WAKE_STATE') {
    const found = findInstance(next, action.instanceId);
    if (!found || found.zone !== 'avatarZone') return { ok: false, state, reason: 'Wake state target disappeared' };
    const player = next.players[found.playerId];
    next = {
      ...next,
      players: {
        ...next.players,
        [found.playerId]: {
          ...player,
          avatarZone: player.avatarZone.map(card => card.instanceId === action.instanceId
            ? { ...card, isRested: action.isRested }
            : card)
        }
      }
    };
  } else if (action.kind === 'MOVE_CARD') {
    const moved = moveCardBetweenZones(next, {
      instanceId: action.instanceId,
      actorId: pending.actorId,
      destination: action.destination,
      ...(action.destinationPlayerId ? { destinationPlayerId: action.destinationPlayerId } : {}),
      effectMove: true,
      ...(action.deckPosition ? { deckPosition: action.deckPosition } : {}),
      cause: 'PLAYER_ACTION'
    });
    if (!moved.ok) return { ok: false, state, reason: moved.reason ?? 'Manual move failed' };
    next = moved.state;
  } else if (action.kind === 'DRAW_CARD') {
    const player = next.players[action.playerId];
    const top = player.deck[0];
    if (!top) return { ok: false, state, reason: 'Deck is empty' };
    const drawn = moveCardBetweenZones(next, {
      instanceId: top.instanceId,
      actorId: pending.actorId,
      destination: 'hand',
      destinationPlayerId: action.playerId,
      effectMove: true,
      cause: 'PLAYER_ACTION'
    });
    if (!drawn.ok) return { ok: false, state, reason: drawn.reason ?? 'Manual draw failed' };
    next = {
      ...drawn.state,
      players: {
        ...drawn.state.players,
        [action.playerId]: {
          ...drawn.state.players[action.playerId],
          hand: drawn.state.players[action.playerId].hand.map(card => card.instanceId === top.instanceId ? { ...card, isFaceUp: true } : card)
        }
      }
    };
    events.push({ type: 'CARD_DRAWN', playerId: action.playerId, actorId: pending.actorId, eventId: `${state.id}:${state.gameEvents?.length ?? 0}:manual-draw:${pending.commandId}` });
  } else if (action.kind === 'DISCARD_CARD') {
    const moved = moveCardBetweenZones(next, {
      instanceId: action.instanceId,
      actorId: pending.actorId,
      destination: 'hell',
      effectMove: true,
      cause: 'PLAYER_ACTION'
    });
    if (!moved.ok) return { ok: false, state, reason: moved.reason ?? 'Manual discard failed' };
    next = moved.state;
    events.push({ type: 'CARD_DISCARDED', instanceId: action.instanceId, playerId: pending.actorId, actorId: pending.actorId, eventId: `${state.id}:${state.gameEvents?.length ?? 0}:manual-discard:${pending.commandId}` });
  } else if (action.kind === 'ADJUST_LIFE') {
    const player = next.players[action.playerId];
    const index = player.lifeDeck.findIndex(card => action.face === 'up' ? !card.isFaceUp : card.isFaceUp);
    if (index === -1) return { ok: false, state, reason: 'No matching LIFE card' };
    next = {
      ...next,
      players: {
        ...next.players,
        [action.playerId]: {
          ...player,
          lifeDeck: player.lifeDeck.map((card, cardIndex) => cardIndex === index ? { ...card, isFaceUp: action.face === 'up' } : card)
        }
      }
    };
    const flipped = next.players[action.playerId].lifeDeck[index];
    events.push({
      type: 'LIFE_REVEALED', instanceId: flipped.instanceId, playerId: action.playerId, actorId: pending.actorId,
      eventId: `${state.id}:${state.gameEvents?.length ?? 0}:manual-life:${pending.commandId}`
    });
  }
  next = {
    ...next,
    stateRevision: (state.stateRevision ?? 0) + 1
  };
  const error = validateGameState(next);
  if (error) return { ok: false, state, reason: error };
  const described = describeManualOverrideAction(state, action);
  return {
    ok: true,
    applied: true,
    state: appendGameEvents(appendEventLog(next, [`✅ Manual Override ได้รับการยืนยันและถูกนำไปใช้: ${described}`], pending.actorId), events)
  };
}

/** Records one approval; the override applies once every non-actor player has approved. */
export function approveManualOverride(state: GameState, approverId: string, commandId?: string): ManualOverrideResult {
  const pending = state.pendingManualOverride;
  if (!pending) return { ok: false, state, reason: 'No manual override is pending' };
  if (!state.players[approverId]) return { ok: false, state, reason: 'Approver does not exist' };
  if (approverId === pending.actorId) return { ok: false, state, reason: 'The actor cannot approve their own override' };
  if (pending.rejections.includes(approverId) || pending.approvals.includes(approverId)) {
    return { ok: false, state, reason: 'This player already responded to the override' };
  }
  if (commandId !== undefined && (!validCommandId(commandId) || (state.processedCommandIds ?? []).includes(commandId))) {
    return { ok: false, state, reason: 'Invalid or duplicate approval command' };
  }
  const approvals = [...pending.approvals, approverId];
  const processedCommandIds = commandId ? [...(state.processedCommandIds ?? []), commandId].slice(-128) : state.processedCommandIds;
  const requiredApprovers = state.playerOrder.filter(id => id !== pending.actorId && state.players[id]).length;
  if (approvals.length < requiredApprovers) {
    const candidate: GameState = {
      ...state,
      pendingManualOverride: { ...pending, approvals },
      ...(processedCommandIds ? { processedCommandIds } : {})
    };
    const error = validateGameState(candidate);
    if (error) return { ok: false, state, reason: error };
    return {
      ok: true,
      state: appendEventLog(candidate, [`🖐️ ${state.players[approverId].name} ยืนยัน Manual Override (${approvals.length}/${requiredApprovers})`], approverId, 'MANUAL_OVERRIDE')
    };
  }
  const staged: GameState = {
    ...state,
    pendingManualOverride: { ...pending, approvals },
    ...(processedCommandIds ? { processedCommandIds } : {})
  };
  const applied = applyStagedOverride(staged, { ...pending, approvals });
  if (!applied.ok) {
    // A failed application rejects the override and keeps the game consistent.
    const rejected: GameState = {
      ...staged,
      pendingManualOverride: undefined,
      stateRevision: (staged.stateRevision ?? 0) + 1
    };
    return {
      ok: true,
      state: appendEventLog(rejected, [`⚠️ Manual Override นำไปใช้ไม่สำเร็จ (${applied.reason ?? 'unknown'}) — การกระทำถูกยกเลิก`], pending.actorId)
    };
  }
  return applied;
}

/** Any non-actor player may reject the staged override; the action is discarded and logged. */
export function rejectManualOverride(state: GameState, rejectorId: string, commandId?: string): ManualOverrideResult {
  const pending = state.pendingManualOverride;
  if (!pending) return { ok: false, state, reason: 'No manual override is pending' };
  if (!state.players[rejectorId]) return { ok: false, state, reason: 'Rejector does not exist' };
  if (rejectorId === pending.actorId) return { ok: false, state, reason: 'The actor cannot reject their own override' };
  if (pending.rejections.includes(rejectorId) || pending.approvals.includes(rejectorId)) {
    return { ok: false, state, reason: 'This player already responded to the override' };
  }
  if (commandId !== undefined && (!validCommandId(commandId) || (state.processedCommandIds ?? []).includes(commandId))) {
    return { ok: false, state, reason: 'Invalid or duplicate rejection command' };
  }
  const described = describeManualOverrideAction(state, pending.action);
  const next: GameState = {
    ...state,
    pendingManualOverride: undefined,
    stateRevision: (state.stateRevision ?? 0) + 1,
    processedCommandIds: commandId ? [...(state.processedCommandIds ?? []), commandId].slice(-128) : state.processedCommandIds
  };
  const error = validateGameState(next);
  if (error) return { ok: false, state, reason: error };
  return {
    ok: true,
    state: appendEventLog(next, [`❌ ${state.players[rejectorId].name} ปฏิเสธ Manual Override: ${described} — การกระทำถูกยกเลิก`], rejectorId)
  };
}

/** Applies the staged override immediately; used for offline matches where the AI consents. */
export function autoApproveManualOverride(state: GameState): ManualOverrideResult {
  const pending = state.pendingManualOverride;
  if (!pending) return { ok: false, state, reason: 'No manual override is pending' };
  const approver = state.playerOrder.find(id => id !== pending.actorId && state.players[id]);
  if (!approver) return { ok: false, state, reason: 'No other player can approve the override' };
  return approveManualOverride(state, approver);
}
