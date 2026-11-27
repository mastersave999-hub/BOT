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
  changeAvatarControl,
  validateAvatarZone,
  validateGameState,
  getRegisteredLandMagicHook,
  type PlayerZone,
} from './gameRules';
import { getRuntimeExecutionBlockers, parseCardAbility } from './abilityEngine';
import { appendGameEvents, type GameEvent } from './gameEvents';
import { millCards, scoutCards, searchDeck, shuffleDeck } from './deckOperations';
import { beginHellChoice } from './hellChoice';

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
  // A registered continuous Land Magic hook is executed live by the engine
  // (gameRules legality/payment recomputation), so it is fully verified.
  const landHook = getRegisteredLandMagicHook(card);
  if (landHook) {
    return { status: 'VERIFIED_WORKING', reason: `Registered continuous Land Magic hook (${landHook.printId}): ${landHook.description}` };
  }
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
  if (blockers.length === 0) {
    // A card is AUTO only when its actual runtime execution mutates the game state
    // as written; anything the runtime would refuse falls back to MANUAL so the
    // player is never cheated out of an effect.
    const runtimeBlockers = getRuntimeExecutionBlockers(card);
    if (runtimeBlockers.length > 0) {
      return { status: 'UNSUPPORTED', reason: `runtime execution not verified: ${runtimeBlockers.join('; ')}` };
    }
    return { status: 'VERIFIED_WORKING' };
  }
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

/** How playing a Land Magic card must be resolved by the engine and the UI. */
export type LandMagicActivationPlan = 'CONTINUOUS_HOOK' | 'EXECUTE' | 'MANUAL_FALLBACK';

export function getLandMagicActivationPlan(card: Card): LandMagicActivationPlan {
  if (card.type !== 'Magic' || card.subtype !== 'Land') return 'MANUAL_FALLBACK';
  if (getRegisteredLandMagicHook(card)) return 'CONTINUOUS_HOOK';
  if (classifyCard(card).status !== 'VERIFIED_WORKING') return 'MANUAL_FALLBACK';
  // Verified continuous POWER auras are applied by recomputeContinuousAuras.
  return parseCardAbility(card).powerMod !== 0 ? 'CONTINUOUS_HOOK' : 'EXECUTE';
}

export interface ManualOverrideResult {
  ok: boolean;
  state: GameState;
  reason?: string;
  applied?: boolean;
}

const FIELD_ZONES: readonly PlayerZone[] = ['avatarZone', 'constructZone', 'magicZone'];

/** Upper bound for manual Deck/Hell numeric parameters, keeping single effects bounded. */
const MAX_MANUAL_DECK_COUNT = 10;

/** Queue steps that hand control to an authorized pending-choice UI before completing. */
const CHOICE_OPENING_KINDS: readonly string[] = ['MANUAL_SEARCH_DECK', 'MANUAL_SCOUT_DECK', 'MANUAL_HELL_CHOICE'];

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
    case 'MANUAL_SEARCH_DECK': {
      const filters: string[] = [];
      if (action.criteria.types?.length) filters.push(`ประเภท ${action.criteria.types.join('/')}`);
      if (action.criteria.colors?.length) filters.push(`สี ${action.criteria.colors.join('/')}`);
      if (action.criteria.minCost !== undefined || action.criteria.maxCost !== undefined) {
        filters.push(`Cost ${action.criteria.minCost ?? 0}-${action.criteria.maxCost ?? '∞'}`);
      }
      if (action.criteria.nameIncludes) filters.push(`ชื่อมีคำว่า "${action.criteria.nameIncludes}"`);
      if (action.criteria.symbols?.length) filters.push(`Symbol ${action.criteria.symbols.join('/')}`);
      const destinationLabel = action.destination === 'hand' ? 'ขึ้นมือ' : action.destination === 'hell' ? 'ลงนรก' : 'กลับสู่ Deck';
      return `ค้นหาใน Deck ของ ${nameOf(action.deckOwnerId)} ${filters.length ? `(${filters.join(', ')}) ` : ''}เลือก ${action.selectCount} ใบ${destinationLabel} — สับ Deck หลังค้นหาตามกติกา`;
    }
    case 'MANUAL_SCOUT_DECK':
      return `สอดแนมการ์ด ${action.count} ใบด้านบนสุดของ Deck ของ ${nameOf(action.deckOwnerId)}`;
    case 'MANUAL_MILL_DECK':
      return `ส่งการ์ด ${action.count} ใบด้านบนสุดของ Deck ของ ${nameOf(action.deckOwnerId)} ลงนรก`;
    case 'MANUAL_SHUFFLE_DECK':
      return `สับ Deck ของ ${nameOf(action.deckOwnerId)} ใหม่`;
    case 'MANUAL_HELL_CHOICE': {
      const destinationLabel = action.destination === 'hand' ? 'ขึ้นมือ'
        : action.destination === 'avatarZone' ? 'ลง Avatar Zone'
          : action.destination === 'banish' ? 'เนรเทศสู่มิติมืด'
            : action.destination === 'deck_top' ? 'วางด้านบนสุดของ Deck' : 'วางด้านล่างสุดของ Deck';
      return `เลือกการ์ด ${action.cardType} ${action.count} ใบจากนรกของ ${nameOf(action.playerId)} ${destinationLabel}`;
    }
    case 'MANUAL_SPAWN_TOKEN':
      return `สร้าง Token${action.name ? ` "${action.name}"` : ''}${action.power !== undefined ? ` POWER ${action.power}` : ''} ใน Avatar Zone ของ ${nameOf(action.playerId)}`;
    case 'MANUAL_CHANGE_CONTROL':
      return `เปลี่ยนผู้ควบคุม "${cardName(action.instanceId)}" ให้ ${nameOf(action.newControllerId)}`;
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
    case 'MANUAL_SEARCH_DECK': {
      if (!state.players[action.deckOwnerId]) return 'Deck owner does not exist';
      if (!Number.isSafeInteger(action.selectCount) || action.selectCount < 1 || action.selectCount > MAX_MANUAL_DECK_COUNT) {
        return `Search count must be an integer between 1 and ${MAX_MANUAL_DECK_COUNT}`;
      }
      if (!['hand', 'hell', 'deck'].includes(action.destination)) return 'Invalid Deck Search destination';
      const criteria = action.criteria ?? {};
      if (criteria.types !== undefined && (!Array.isArray(criteria.types) || criteria.types.some(type => !['Avatar', 'Magic', 'Construct', 'Life', 'Token'].includes(type)))) return 'Invalid Deck Search type filter';
      if (criteria.colors !== undefined && (!Array.isArray(criteria.colors) || criteria.colors.some(color => typeof color !== 'string'))) return 'Invalid Deck Search color filter';
      if (criteria.symbols !== undefined && (!Array.isArray(criteria.symbols) || criteria.symbols.some(symbol => typeof symbol !== 'string'))) return 'Invalid Deck Search symbol filter';
      if (criteria.nameIncludes !== undefined && (typeof criteria.nameIncludes !== 'string' || criteria.nameIncludes.length > 64)) return 'Invalid Deck Search name filter';
      if ((criteria.minCost !== undefined && (!Number.isFinite(criteria.minCost) || criteria.minCost < 0)) ||
        (criteria.maxCost !== undefined && (!Number.isFinite(criteria.maxCost) || criteria.maxCost < 0)) ||
        (criteria.minCost !== undefined && criteria.maxCost !== undefined && criteria.minCost > criteria.maxCost)) {
        return 'Invalid Deck Search cost filter';
      }
      return null;
    }
    case 'MANUAL_SCOUT_DECK': {
      if (!state.players[action.deckOwnerId]) return 'Deck owner does not exist';
      if (!Number.isSafeInteger(action.count) || action.count < 1 || action.count > MAX_MANUAL_DECK_COUNT) {
        return `Scout count must be an integer between 1 and ${MAX_MANUAL_DECK_COUNT}`;
      }
      if (!['hand', 'hell', 'deck'].includes(action.destination)) return 'Invalid Scout destination';
      if (action.selectedDeckPosition !== undefined && !['top', 'bottom'].includes(action.selectedDeckPosition)) return 'Invalid Scout Deck position';
      if (action.selectedDeckPosition !== undefined && action.destination !== 'deck') return 'Scout Deck position requires a Deck destination';
      if (action.unselectedDeckPosition !== undefined && !['top', 'bottom', 'shuffle'].includes(action.unselectedDeckPosition)) return 'Invalid Scout unselected position';
      return null;
    }
    case 'MANUAL_MILL_DECK': {
      if (!state.players[action.deckOwnerId]) return 'Deck owner does not exist';
      if (!Number.isSafeInteger(action.count) || action.count < 1 || action.count > MAX_MANUAL_DECK_COUNT) {
        return `Mill count must be an integer between 1 and ${MAX_MANUAL_DECK_COUNT}`;
      }
      return null;
    }
    case 'MANUAL_SHUFFLE_DECK': {
      if (!state.players[action.deckOwnerId]) return 'Deck owner does not exist';
      return null;
    }
    case 'MANUAL_HELL_CHOICE': {
      if (!state.players[action.playerId]) return 'Hell choice player does not exist';
      if (!['Avatar', 'Construct', 'Magic'].includes(action.cardType)) return 'Invalid Hell choice card type';
      if (!Number.isSafeInteger(action.count) || action.count < 1 || action.count > MAX_MANUAL_DECK_COUNT) {
        return `Hell choice count must be an integer between 1 and ${MAX_MANUAL_DECK_COUNT}`;
      }
      if (!['hand', 'deck_top', 'deck_bottom', 'avatarZone', 'banish'].includes(action.destination)) return 'Invalid Hell choice destination';
      return null;
    }
    case 'MANUAL_SPAWN_TOKEN': {
      const player = state.players[action.playerId];
      if (!player) return 'Token player does not exist';
      // Rule Book 3.2: max 4 normal Avatars, max 6 total including Tokens.
      if (player.avatarZone.length >= 6) return 'Avatar Zone is at the 6-card total limit; no Token may enter';
      if (action.name !== undefined && (typeof action.name !== 'string' || action.name.length === 0 || action.name.length > 64)) return 'Invalid Token name';
      if (action.power !== undefined && !Number.isSafeInteger(action.power)) return 'Token POWER must be an integer';
      if (action.color !== undefined && typeof action.color !== 'string') return 'Invalid Token color';
      return null;
    }
    case 'MANUAL_CHANGE_CONTROL': {
      if (!state.players[action.newControllerId]) return 'New controller does not exist';
      const found = findInstance(state, action.instanceId);
      if (!found || found.zone !== 'avatarZone') return 'Control change target must be an Avatar on an Avatar Zone';
      if (found.card.controlChangeImmune) return 'Target Avatar cannot change control';
      if (found.card.duoWithInstanceId || state.players[found.playerId].avatarZone.some(item => item.duoWithInstanceId === action.instanceId)) {
        return 'Duo Avatars cannot change control';
      }
      if (found.card.controllerId === action.newControllerId) return 'Avatar is already controlled by that player';
      const destinationZone = [...state.players[action.newControllerId].avatarZone, found.card];
      const capacityError = validateAvatarZone({ avatarZone: destinationZone });
      if (capacityError) return capacityError;
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
 * Stages a manual override queue for the active player. Every step is validated against Rule Book
 * limits (zone capacity is enforced again at application time) and the whole queue waits for
 * opponent approval, then applies all-or-nothing.
 */
export function beginManualOverrideQueue(
  state: GameState,
  actorId: string,
  actions: ManualOverrideAction[],
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
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > 8) {
    return { ok: false, state, reason: 'Manual override queue must contain between 1 and 8 steps' };
  }
  for (const action of actions) {
    const actionError = validateManualOverrideAction(state, actorId, action);
    if (actionError) return { ok: false, state, reason: actionError };
  }
  // A choice-opening step hands control to an authorized pending-choice UI, so it must be last.
  const firstChoiceIndex = actions.findIndex(action => CHOICE_OPENING_KINDS.includes(action.kind));
  if (firstChoiceIndex !== -1 && firstChoiceIndex !== actions.length - 1) {
    return { ok: false, state, reason: 'A Deck/Hell choice step must be the final step of the queue' };
  }
  const revision = (state.stateRevision ?? 0) + 1;
  const pending: PendingManualOverride = {
    action: actions[0],
    actions,
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
  const described = actions.map(action => describeManualOverrideAction(state, action)).join(' → ');
  const cardLabel = context?.cardName ? ` (การ์ด: ${context.cardName} — ${context.cardStatus ?? 'Manual Effect Resolution'})` : '';
  return {
    ok: true,
    state: appendEventLog(candidate, [`🔧 ${state.players[actorId].name} เสนอ Manual Override${actions.length > 1 ? ` (${actions.length} ขั้นตอน)` : ''}: ${described}${cardLabel} — รอคู่แข่งยืนยัน`], actorId)
  };
}

/**
 * Stages a single-step manual override for the active player.
 * The action is validated against Rule Book limits and waits for opponent approval.
 */
export function beginManualOverride(
  state: GameState,
  actorId: string,
  action: ManualOverrideAction,
  context: ManualOverrideContext | undefined,
  commandId: string
): ManualOverrideResult {
  return beginManualOverrideQueue(state, actorId, [action], context, commandId);
}

/** Applies one queued manual override step; deck/hell operations may open an authorized pending choice. */
function applyOverrideStep(
  state: GameState,
  pending: PendingManualOverride,
  action: ManualOverrideAction,
  events: GameEvent[]
): { ok: boolean; state: GameState; reason?: string } {
  let next: GameState = state;
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
  } else if (action.kind === 'MANUAL_SEARCH_DECK') {
    // Rule Book 3.2: a Deck Search always ends with a mandatory shuffle, which the
    // SEARCH pending choice applies to the unselected cards when it resolves.
    const searched = searchDeck(next, action.deckOwnerId, action.criteria, {
      actorId: pending.actorId,
      authorizedViewerId: pending.actorId,
      selectCount: action.selectCount,
      destination: action.destination
    });
    if (!searched.ok) return { ok: false, state, reason: searched.reason ?? 'Manual Deck Search failed' };
    next = searched.state;
  } else if (action.kind === 'MANUAL_SCOUT_DECK') {
    const scouted = scoutCards(next, action.deckOwnerId, action.count, {
      viewerId: pending.actorId,
      destination: action.destination,
      ...(action.destination === 'deck' && action.selectedDeckPosition ? { selectedDeckPosition: action.selectedDeckPosition } : {}),
      ...(action.unselectedDeckPosition ? { unselectedDeckPosition: action.unselectedDeckPosition } : {})
    });
    if (!scouted.ok) return { ok: false, state, reason: scouted.reason ?? 'Manual Scout failed' };
    next = scouted.state;
  } else if (action.kind === 'MANUAL_MILL_DECK') {
    const milled = millCards(next, action.deckOwnerId, action.count);
    if (!milled.ok) return { ok: false, state, reason: milled.reason ?? 'Manual Mill failed' };
    next = milled.state;
  } else if (action.kind === 'MANUAL_SHUFFLE_DECK') {
    const shuffled = shuffleDeck(next, action.deckOwnerId);
    if (!shuffled.ok) return { ok: false, state, reason: shuffled.reason ?? 'Manual Shuffle failed' };
    next = shuffled.state;
  } else if (action.kind === 'MANUAL_HELL_CHOICE') {
    const hellChoice = beginHellChoice(next, {
      effectKind: action.destination === 'avatarZone' ? 'summon_from_hell' : 'recover_from_hell',
      playerId: action.playerId,
      actorId: pending.actorId,
      authorizedViewerId: pending.actorId,
      cardType: action.cardType,
      count: action.count,
      destination: action.destination
    });
    if (!hellChoice.ok) {
      return { ok: false, state, reason: 'reason' in hellChoice ? hellChoice.reason : 'Manual Hell choice failed' };
    }
    next = hellChoice.state;
  } else if (action.kind === 'MANUAL_SPAWN_TOKEN') {
    const player = next.players[action.playerId];
    // Rule Book 3.2: max 4 normal Avatars, max 6 total including Tokens.
    if (player.avatarZone.length >= 6) return { ok: false, state, reason: 'Avatar Zone is at the 6-card total limit' };
    const tokenCard: Card = {
      printId: `token:${pending.commandId}`,
      name: action.name ?? 'Token',
      type: 'Token',
      soi: 1,
      cost: 0,
      gem: 0,
      power: action.power ?? 0,
      color: action.color ?? 'ไร้สี',
      rarity: 'C',
      mainEffect: '',
      isOnlyOne: false,
      isBias: false,
      isCollab: false,
      imageUrl: 'https://cdn.bottcg.com/cards/card-back.png'
    };
    const tokenInstance: CardInstance = {
      instanceId: `token-${pending.commandId}`,
      card: tokenCard,
      ownerId: action.playerId,
      controllerId: action.playerId,
      isRested: false,
      isFaceUp: true,
      attachedInstances: [],
      layerModifiers: []
    };
    next = {
      ...next,
      players: {
        ...next.players,
        [action.playerId]: { ...player, avatarZone: [...player.avatarZone, tokenInstance] }
      }
    };
  } else if (action.kind === 'MANUAL_CHANGE_CONTROL') {
    const changed = changeAvatarControl(next, pending.actorId, action.instanceId, action.newControllerId);
    if (!changed.ok) return { ok: false, state, reason: changed.reason ?? 'Manual control change failed' };
    next = changed.state;
  }
  return { ok: true, state: next };
}

function applyStagedOverride(state: GameState, pending: PendingManualOverride): ManualOverrideResult {
  const queue = pending.actions && pending.actions.length > 0 ? pending.actions : [pending.action];
  // The staged pending is cleared first so zone moves see a clean rules state.
  const cleared: GameState = { ...state, pendingManualOverride: undefined };
  const events: GameEvent[] = [];
  let next: GameState = cleared;
  // All-or-nothing (Rule Book 3.2 p.12): one failed step cancels the whole queue.
  for (const action of queue) {
    const step = applyOverrideStep(next, pending, action, events);
    if (!step.ok) return { ok: false, state, reason: step.reason };
    next = step.state;
  }
  next = {
    ...next,
    stateRevision: (state.stateRevision ?? 0) + 1
  };
  // A Deck/Hell choice opened by this queue must stay resolvable: re-sync its
  // authorized expected revision with the final post-queue state revision.
  if (next.pendingDeckChoice) {
    next = { ...next, pendingDeckChoice: { ...next.pendingDeckChoice, expectedRevision: next.stateRevision } };
  }
  if (next.pendingHellChoice) {
    next = { ...next, pendingHellChoice: { ...next.pendingHellChoice, expectedRevision: next.stateRevision } };
  }
  const error = validateGameState(next);
  if (error) return { ok: false, state, reason: error };
  const described = queue.map(action => describeManualOverrideAction(state, action)).join(' → ');
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
