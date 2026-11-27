import type { Card, CardInstance, GameState, ManualOverrideAction, ManualOverrideContext, RoomRuleMode } from './types';
import { validateGameState } from './gameRules';
import { isNormalMagicTreatedAsReact } from './reactionEngine';
import { deckViolatesAutoStrict } from './hybridMode';
import { parseCardText } from './cardTextAdapter';

const HIDDEN_PRIVATE_CARD: Card = {
  printId: 'hidden-private-card',
  name: 'Hidden card',
  type: 'Token',
  soi: 1,
  cost: 0,
  gem: 0,
  power: 0,
  color: 'ไร้สี',
  rarity: 'C',
  mainEffect: '',
  isOnlyOne: false,
  isBias: false,
  isCollab: false,
  imageUrl: 'https://cdn.bottcg.com/cards/card-back.png'
};

const FACE_DOWN_LIFE_CARD: Card = {
  printId: 'hidden-life-card',
  name: 'Face-down LIFE',
  type: 'Life',
  soi: 1,
  cost: 0,
  gem: 0,
  power: 0,
  color: 'ไร้สี',
  rarity: 'C',
  mainEffect: '',
  isOnlyOne: false,
  isBias: false,
  isCollab: false,
  imageUrl: 'https://cdn.bottcg.com/cards/card-back.png'
};

/** Strip card identity from face-down LIFE cards before sending a state to a peer. */
export function redactLifeCardsInSetup(setup: PlayerSetup): PlayerSetup {
  return { ...setup, lifeDeck: setup.lifeDeck.map(() => FACE_DOWN_LIFE_CARD) };
}

export function restoreOwnLifeCardsFromSetup(
  state: GameState,
  setup: PlayerSetup,
  playerId: string
): GameState {
  const player = state.players[playerId];
  if (!player) return state;
  let changed = false;
  const lifeDeck = player.lifeDeck.map((card, index) => {
    const knownCard = setup.lifeDeck[index];
    if (!knownCard || card.card.printId !== 'hidden-life-card') return card;
    changed = true;
    return { ...card, card: knownCard };
  });
  if (!changed) return state;
  return { ...state, players: { ...state.players, [playerId]: { ...player, lifeDeck } } };
}

export function redactLifeCardsForViewer(state: GameState, viewerId: string): GameState {
  const inspectedCardIds = new Set([
    ...(state.pendingDeckChoice?.authorizedViewerId === viewerId ? state.pendingDeckChoice.candidateInstanceIds : []),
    ...(state.pendingHellChoice?.authorizedViewerId === viewerId ? state.pendingHellChoice.candidateInstanceIds : []),
  ]);
  const gameEvents = state.gameEvents?.map(({ sequence, event }) => {
    if (event.type === 'CARD_DRAWN' && event.playerId !== viewerId) {
      const { instanceId: _privateInstanceId, ...publicEvent } = event;
      return { sequence, event: publicEvent };
    }
    if (event.type === 'DECK_SCOUTED' && event.viewerId !== viewerId) {
      return { sequence, event: { ...event, cardInstanceIds: [] } };
    }
    if (event.type === 'DECK_SEARCHED' && event.destination !== 'hell' && event.actorId !== viewerId) {
      const { instanceId: _privateInstanceId, found: privateFound, ...publicEvent } = event;
      return { sequence, event: event.found === false ? { ...publicEvent, found: false } : publicEvent };
    }
    return { sequence, event };
  });
  return {
    ...state,
    players: Object.fromEntries(
      Object.entries(state.players).map(([playerId, player]) => [
        playerId,
        playerId === viewerId
          ? player
          : {
              ...player,
              hand: player.hand.map(card => ({ ...card, card: HIDDEN_PRIVATE_CARD, isFaceUp: false })),
              deck: player.deck.map(card => inspectedCardIds.has(card.instanceId)
                ? card
                : { ...card, card: HIDDEN_PRIVATE_CARD, isFaceUp: false }),
              lifeDeck: player.lifeDeck.map(card =>
                card.isFaceUp ? card : { ...card, card: FACE_DOWN_LIFE_CARD }
              )
            }
      ])
    ),
    pendingDeckChoice: state.pendingDeckChoice && state.pendingDeckChoice.authorizedViewerId !== viewerId
      ? { ...state.pendingDeckChoice, candidateInstanceIds: [], minSelect: 0, maxSelect: 0 }
      : state.pendingDeckChoice,
    pendingHellChoice: state.pendingHellChoice && state.pendingHellChoice.authorizedViewerId !== viewerId
      ? { ...state.pendingHellChoice, candidateInstanceIds: [], minSelect: 0, maxSelect: 0 }
      : state.pendingHellChoice,
    ...(gameEvents ? { gameEvents } : {})
  };
}

export function restoreHiddenZonesFromCanonical(
  incoming: GameState,
  canonical: GameState,
  senderPlayerId: string
): GameState {
  const players = { ...incoming.players };
  for (const [playerId, incomingPlayer] of Object.entries(incoming.players)) {
    if (playerId === senderPlayerId) continue;
    const knownPlayer = canonical.players[playerId];
    if (!knownPlayer) continue;
    const knownInstances = new Map<string, (typeof knownPlayer.hand)[number]>();
    const collect = (cards: typeof knownPlayer.hand) => cards.forEach(card => knownInstances.set(card.instanceId, card));
    collect(knownPlayer.hand);
    collect(knownPlayer.deck);
    collect(knownPlayer.lifeDeck);
    collect(knownPlayer.avatarZone);
    collect(knownPlayer.constructZone);
    collect(knownPlayer.magicZone);
    collect(knownPlayer.hell);
    collect(knownPlayer.darkDimension);
    const restoreZone = (cards: typeof incomingPlayer.hand) => cards.map(card => {
      const known = knownInstances.get(card.instanceId);
      return known ? { ...known, isFaceUp: card.isFaceUp } : { ...card, card: HIDDEN_PRIVATE_CARD };
    });
    players[playerId] = {
      ...incomingPlayer,
      hand: restoreZone(incomingPlayer.hand),
      deck: restoreZone(incomingPlayer.deck),
      lifeDeck: incomingPlayer.lifeDeck.map(card => {
        const known = knownPlayer.lifeDeck.find(item => item.instanceId === card.instanceId);
        return known ? { ...known, isFaceUp: card.isFaceUp } : { ...card, card: FACE_DOWN_LIFE_CARD };
      })
    };
  }
  return { ...incoming, players };
}

export function isGameStateValidForSync(state: GameState): boolean {
  return validateGameState(state) === null;
}

function collectPlayerCardInstances(player: GameState['players'][string]): CardInstance[] {
  const result: CardInstance[] = [];
  const pending = [
    ...player.deck, ...player.hand, ...player.lifeDeck, ...player.avatarZone,
    ...player.constructZone, ...player.magicZone, ...player.hell, ...player.darkDimension
  ];
  while (pending.length > 0) {
    const card = pending.pop()!;
    result.push(card);
    pending.push(...card.attachedInstances);
  }
  return result;
}

export function isLegalGameStateSync(previous: GameState, incoming: GameState, senderPlayerId: string): boolean {
  if (!isGameStateValidForSync(incoming) || incoming.id !== previous.id || incoming.mode !== previous.mode || incoming.ruleMode !== previous.ruleMode ||
    JSON.stringify(incoming.playerOrder) !== JSON.stringify(previous.playerOrder) ||
    Object.keys(incoming.players).sort().join('|') !== Object.keys(previous.players).sort().join('|') ||
    Object.entries(previous.players).some(([id, player]) => incoming.players[id]?.seat !== player.seat)) return false;
  const activePlayerId = previous.playerOrder[previous.currentTurnPlayerIndex];
  if (!activePlayerId || senderPlayerId !== activePlayerId || previous.pendingEndPhaseDiscardPlayerId || previous.pendingDeckChoice || previous.pendingHellChoice || previous.pendingDeckSearchVerification || previous.pendingExitPrevention) return false;
  const outgoingPlayer = previous.players[activePlayerId];
  const incomingOutgoingPlayer = incoming.players[activePlayerId];
  const completedDrawPhase = previous.currentPhase === 'DRAW' && incoming.currentPhase === 'MAIN' &&
    incoming.currentTurnPlayerIndex === previous.currentTurnPlayerIndex && incoming.turnNumber === previous.turnNumber;
  if (completedDrawPhase) {
    if (Object.values(incoming.players).some(player => player.usedMagicTypesThisTurn.size !== 0)) return false;
  } else {
    for (const [playerId, player] of Object.entries(previous.players)) {
      const nextUsedTypes = incoming.players[playerId].usedMagicTypesThisTurn;
      if ([...player.usedMagicTypesThisTurn].some(type => !nextUsedTypes.has(type))) return false;
      if (playerId !== activePlayerId && [...nextUsedTypes].some(type => !player.usedMagicTypesThisTurn.has(type))) return false;
    }
  }
  const hasAttached = (card: CardInstance, instanceId: string): boolean =>
    card.attachedInstances.some(attached => attached.instanceId === instanceId || hasAttached(attached, instanceId));
  const attachedToField = (instanceId: string) => incomingOutgoingPlayer.avatarZone.some(avatar => hasAttached(avatar, instanceId));
  const activeInstances = collectPlayerCardInstances(incomingOutgoingPlayer);
  const playedMagicCards: CardInstance[] = [];
  for (const card of outgoingPlayer.hand) {
    if (incomingOutgoingPlayer.hand.some(item => item.instanceId === card.instanceId) || card.card.type !== 'Magic') continue;
    const enteredMagicZone = incomingOutgoingPlayer.magicZone.some(item => item.instanceId === card.instanceId);
    const enteredLandZone = incoming.landMagicZone?.instanceId === card.instanceId;
    const becameAttached = attachedToField(card.instanceId);
    if (!enteredMagicZone && !enteredLandZone && !becameAttached) continue;
    playedMagicCards.push(card);
    const printedType = card.card.subtype ?? 'Normal';
    const treatedAsReact = printedType === 'Normal' && previous.currentPhase === 'BATTLE' && isNormalMagicTreatedAsReact(card.card);
    const effectiveType = treatedAsReact ? 'React' : printedType;
    if (previous.players[activePlayerId].usedMagicTypesThisTurn.has(effectiveType) ||
      !incomingOutgoingPlayer.usedMagicTypesThisTurn.has(effectiveType)) return false;
    if (printedType === 'Land' && !enteredLandZone) return false;
    if (printedType === 'Modification' && !becameAttached) return false;
    if (printedType !== 'Land' && printedType !== 'Modification' && !enteredMagicZone) return false;
    if (enteredLandZone && card.card.subtype !== 'Land') return false;
    if (!activeInstances.some(item => item.instanceId === card.instanceId)) return false;
  }
  // Hidden-information guard: a guest may only introduce a private Deck/Hell choice it authored,
  // and a choice over another player's zone must be backed by a Magic card played in this same sync.
  const deckChoicePending = incoming.pendingDeckChoice;
  const hellChoicePending = incoming.pendingHellChoice;
  if (deckChoicePending && (deckChoicePending.actorId !== senderPlayerId || deckChoicePending.authorizedViewerId !== senderPlayerId)) return false;
  if (hellChoicePending && (hellChoicePending.actorId !== senderPlayerId || hellChoicePending.authorizedViewerId !== senderPlayerId)) return false;
  const needsPlayedSource = (deckChoicePending && deckChoicePending.deckOwnerId !== senderPlayerId) ||
    (hellChoicePending && hellChoicePending.playerId !== senderPlayerId);
  if (needsPlayedSource) {
    const sourceMatches = playedMagicCards.some(card => parseCardText(card.card).clauses.some(clause => clause.effects.some(effect =>
      deckChoicePending
        ? effect.kind === 'search_deck_to_hand' || effect.kind === 'scout_cards'
        : effect.kind === 'recover_from_hell' || effect.kind === 'summon_from_hell'
    )));
    if (!sourceMatches) return false;
  }
  if (incoming.pendingEndPhaseDiscardPlayerId) {
    const withoutDiscardMetadata = (state: GameState) => Object.fromEntries(Object.entries(state).filter(([key]) =>
      !['pendingEndPhaseDiscardPlayerId', 'pendingEndPhaseDiscardRevision', 'stateRevision'].includes(key)
    ));
    const expectedRevision = (previous.stateRevision ?? 0) + 1;
    if (incoming.pendingEndPhaseDiscardPlayerId !== activePlayerId || previous.currentPhase !== 'END' || incoming.currentPhase !== 'END' ||
      incoming.stateRevision !== expectedRevision || incoming.pendingEndPhaseDiscardRevision !== expectedRevision ||
      JSON.stringify(withoutDiscardMetadata(previous)) !== JSON.stringify(withoutDiscardMetadata(incoming))) return false;
  }
  const endedTurn = incoming.currentTurnPlayerIndex !== previous.currentTurnPlayerIndex || incoming.turnNumber !== previous.turnNumber;
  if (previous.currentPhase === 'END' && endedTurn && outgoingPlayer.hand.length > 7) {
    const removedCards = outgoingPlayer.hand.filter(card => !incomingOutgoingPlayer?.hand.some(next => next.instanceId === card.instanceId));
    const removedIds = removedCards.map(card => card.instanceId);
    const cardsInHell = Object.values(incoming.players).flatMap(player => player.hell);
    if (incomingOutgoingPlayer?.hand.length !== 7 || removedIds.length !== outgoingPlayer.hand.length - 7 || removedCards.some(card =>
      !cardsInHell.some(moved => moved.instanceId === card.instanceId && moved.ownerId === card.ownerId && moved.controllerId === card.controllerId)
    )) return false;
  }
  const firstPlayerFirstTurn = previous.turnNumber === 1 && activePlayerId === previous.playerOrder[0];
  if (previous.currentPhase === 'MAIN' && firstPlayerFirstTurn && incoming.currentPhase === 'BATTLE') return false;
  return true;
}

export type RoomMode = 'DUEL' | 'AD_MUA';

export interface PlayerSetup {
  name: string;
  mainDeck: Card[];
  lifeDeck: Card[];
}

export interface ReactionCommand {
  kind: 'PASS' | 'PLAY';
  playerId: string;
  windowId: string;
  expectedRevision?: number;
  commandId?: string;
  cardInstanceId?: string;
  targetInstanceId?: string;
}

export interface EndPhaseDiscardCommand {
  playerId: string;
  commandId: string;
  expectedRevision: number;
  selectedInstanceIds: string[];
}

export interface ExitPreventionCommand {
  kind: 'USE_EXIT_PREVENTION' | 'DECLINE_EXIT_PREVENTION';
  playerId: string;
  commandId: string;
  expectedRevision: number;
  sourceCardId?: string;
}

export interface DeckChoiceCommand {
  playerId: string;
  commandId: string;
  expectedRevision: number;
  selectedInstanceIds: string[];
  topOrderIds?: string[];
}

export interface HellChoiceCommand {
  playerId: string;
  commandId: string;
  expectedRevision: number;
  selectedInstanceIds: string[];
}

export interface ManualOverrideCommand {
  kind: 'SUBMIT_MANUAL_OVERRIDE' | 'APPROVE_MANUAL_OVERRIDE' | 'REJECT_MANUAL_OVERRIDE';
  playerId: string;
  commandId: string;
  expectedRevision: number;
  action?: ManualOverrideAction;
  context?: ManualOverrideContext;
}

export function isExitPreventionCommandCurrent(
  state: GameState,
  command: ExitPreventionCommand,
  authenticatedPlayerId: string
): boolean {
  const pending = state.pendingExitPrevention;
  return !!pending && command.playerId === authenticatedPlayerId && command.playerId === pending.preventionPlayerId &&
    command.commandId.length > 0 && command.commandId.length <= 128 && Number.isSafeInteger(command.expectedRevision) &&
    command.expectedRevision === state.stateRevision && command.expectedRevision === pending.expectedRevision &&
    !(state.processedCommandIds ?? []).includes(command.commandId) &&
    (command.kind === 'DECLINE_EXIT_PREVENTION'
      ? !pending.usedActivatedPrevention && command.sourceCardId === undefined
      : command.kind === 'USE_EXIT_PREVENTION' && !pending.usedActivatedPrevention && typeof command.sourceCardId === 'string' && command.sourceCardId.length > 0);
}

export function isEndPhaseDiscardCommandCurrent(
  state: GameState,
  command: EndPhaseDiscardCommand,
  authenticatedPlayerId: string
): boolean {
  const player = state.players[authenticatedPlayerId];
  return !!player && command.playerId === authenticatedPlayerId && command.commandId.length > 0 && command.commandId.length <= 128 &&
    Number.isSafeInteger(command.expectedRevision) && command.expectedRevision === state.stateRevision &&
    state.pendingEndPhaseDiscardRevision === command.expectedRevision &&
    state.pendingEndPhaseDiscardPlayerId === authenticatedPlayerId && state.currentPhase === 'END' &&
    state.playerOrder[state.currentTurnPlayerIndex] === authenticatedPlayerId &&
    !(state.processedCommandIds ?? []).includes(command.commandId) &&
    Array.isArray(command.selectedInstanceIds) && new Set(command.selectedInstanceIds).size === command.selectedInstanceIds.length &&
    command.selectedInstanceIds.every(id => typeof id === 'string' && player.hand.some(card => card.instanceId === id));
}

export function isReactionCommandCurrent(
  state: GameState,
  command: ReactionCommand,
  authenticatedPlayerId: string
): boolean {
  const window = state.reactionWindow;
  return !!window &&
    Number.isInteger(window.revision) &&
    command.playerId === authenticatedPlayerId &&
    command.windowId === window.id &&
    command.expectedRevision === window.revision &&
    window.priorityPlayerId === authenticatedPlayerId;
}

function validCommandMetadata(command: { playerId: string; commandId: string; expectedRevision: number }, authenticatedPlayerId: string, state: GameState): boolean {
  return command.playerId === authenticatedPlayerId &&
    typeof command.commandId === 'string' && command.commandId.length > 0 && command.commandId.length <= 128 &&
    Number.isSafeInteger(command.expectedRevision) && command.expectedRevision === state.stateRevision &&
    !(state.processedCommandIds ?? []).includes(command.commandId);
}

function validSelection(selectedInstanceIds: unknown, candidates: string[], minSelect: number, maxSelect: number): boolean {
  return Array.isArray(selectedInstanceIds) &&
    (selectedInstanceIds as unknown[]).every(id => typeof id === 'string' && candidates.includes(id)) &&
    selectedInstanceIds.length >= minSelect && selectedInstanceIds.length <= maxSelect &&
    new Set(selectedInstanceIds).size === selectedInstanceIds.length;
}

/** Authenticates a Deck choice (Scout / Deck search) command against the pending choice revision. */
export function isDeckChoiceCommandCurrent(
  state: GameState,
  command: DeckChoiceCommand,
  authenticatedPlayerId: string
): boolean {
  const pending = state.pendingDeckChoice;
  return !!pending &&
    validCommandMetadata(command, authenticatedPlayerId, state) &&
    command.expectedRevision === pending.expectedRevision &&
    command.playerId === pending.authorizedViewerId &&
    validSelection(command.selectedInstanceIds, pending.candidateInstanceIds, pending.minSelect, pending.maxSelect) &&
    (command.topOrderIds === undefined || (pending.topOrderAllowed === true &&
      Array.isArray(command.topOrderIds) && command.topOrderIds.length === command.selectedInstanceIds.length &&
      new Set(command.topOrderIds).size === command.topOrderIds.length &&
      command.topOrderIds.every(id => command.selectedInstanceIds.includes(id))));
}

/** Authenticates a Hell recovery / summon choice command against the pending choice revision. */
export function isHellChoiceCommandCurrent(
  state: GameState,
  command: HellChoiceCommand,
  authenticatedPlayerId: string
): boolean {
  const pending = state.pendingHellChoice;
  return !!pending &&
    validCommandMetadata(command, authenticatedPlayerId, state) &&
    command.expectedRevision === pending.expectedRevision &&
    command.playerId === pending.authorizedViewerId &&
    validSelection(command.selectedInstanceIds, pending.candidateInstanceIds, pending.minSelect, pending.maxSelect);
}

/** Authenticates a Hybrid manual override submit/approve/reject command. */
export function isManualOverrideCommandCurrent(
  state: GameState,
  command: ManualOverrideCommand,
  authenticatedPlayerId: string
): boolean {
  if (command.playerId !== authenticatedPlayerId ||
    typeof command.commandId !== 'string' || command.commandId.length === 0 || command.commandId.length > 128 ||
    !Number.isSafeInteger(command.expectedRevision) ||
    (state.processedCommandIds ?? []).includes(command.commandId)) return false;
  if (command.kind === 'SUBMIT_MANUAL_OVERRIDE') {
    return !state.pendingManualOverride && !state.pendingDeckChoice && !state.pendingHellChoice &&
      !state.pendingDeckSearchVerification && !state.pendingEndPhaseDiscardPlayerId && !state.pendingExitPrevention &&
      !state.reactionWindow &&
      command.expectedRevision === state.stateRevision &&
      state.playerOrder[state.currentTurnPlayerIndex] === command.playerId &&
      !!command.action && typeof command.action === 'object';
  }
  const pending = state.pendingManualOverride;
  return (command.kind === 'APPROVE_MANUAL_OVERRIDE' || command.kind === 'REJECT_MANUAL_OVERRIDE') &&
    !!pending &&
    command.expectedRevision === state.stateRevision && command.expectedRevision === pending.expectedRevision &&
    command.playerId !== pending.actorId &&
    !pending.approvals.includes(command.playerId) && !pending.rejections.includes(command.playerId) &&
    command.action === undefined;
}

export type NetMessage =
  | { type: 'HELLO'; setup: PlayerSetup }
  | { type: 'ROOM'; mode: RoomMode; capacity: number; names: string[]; ruleMode?: RoomRuleMode }
  | { type: 'REJECT'; reason: string }
  | { type: 'START'; state: GameState; myPlayerId: string }
  | { type: 'SYNC'; state: GameState; winner: string | null }
  | { type: 'REACTION_COMMAND'; command: ReactionCommand }
  | { type: 'END_PHASE_DISCARD'; command: EndPhaseDiscardCommand }
  | { type: 'EXIT_PREVENTION_COMMAND'; command: ExitPreventionCommand }
  | { type: 'DECK_CHOICE_COMMAND'; command: DeckChoiceCommand }
  | { type: 'HELL_CHOICE_COMMAND'; command: HellChoiceCommand }
  | { type: 'MANUAL_OVERRIDE_COMMAND'; command: ManualOverrideCommand }
  | { type: 'PING' }
  | { type: 'LEAVE' };

export interface RoomLink {
  send: (msg: NetMessage) => void;
  /** Messages received before the first subscriber attaches are buffered and replayed. */
  onMessage: (cb: (msg: NetMessage, senderPlayerId?: string) => void) => () => void;
  /** Fires once nobody is connected any more (for a guest: the host is gone). */
  onClose: (cb: () => void) => () => void;
  /** Host only: fires with the player id whenever one guest drops out. */
  onPeerLeft?: (cb: (playerId: string) => void) => () => void;
  close: () => void;
}

export interface MatchSession {
  link: RoomLink;
  role: 'host' | 'guest';
  myPlayerId: string;
  code: string;
  initialState: GameState;
}

export interface RoomHandlers {
  onStatus: (status: string) => void;
  onError: (message: string) => void;
  onReady: (session: MatchSession) => void;
  /** Called with the names of everybody in the room (host first) whenever it changes. */
  onPlayers?: (names: string[], capacity: number) => void;
  /** Host only: called once the room code is registered with the signalling server. */
  onCode?: (code: string) => void;
}

export interface HostController {
  cancel: () => void;
  /** Starts the match with whoever has joined so far. No-op when too few players joined. */
  start: () => void;
}

export interface RoomController {
  cancel: () => void;
}

export const ROOM_LIMITS: Record<RoomMode, { min: number; max: number }> = {
  DUEL: { min: 2, max: 2 },
  AD_MUA: { min: 3, max: 4 }
};

const PEER_PREFIX = 'bot-tcg-talingchan-';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CONNECT_TIMEOUT_MS = 20000;
const HEARTBEAT_INTERVAL_MS = 5000;
// Generous so that browsers throttling timers in background tabs are not mistaken for a disconnect.
const HEARTBEAT_TIMEOUT_MS = 45000;

export const HOST_PLAYER_ID = 'player-1';
export const playerIdForSeat = (seat: number) => `player-${seat + 1}`;

// JSON cannot represent Set, but PlayerState.usedMagicTypesThisTurn is one.
export function encodeNetMessage(msg: NetMessage): string {
  return JSON.stringify(msg, (_key, value) =>
    value instanceof Set ? { __set: Array.from(value) } : value
  );
}

export function decodeNetMessage(raw: unknown): NetMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const decoded: unknown = JSON.parse(raw, (_key, value) =>
      value && typeof value === 'object' && Array.isArray(value.__set) ? new Set(value.__set) : value
    );
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    const message = decoded as Record<string, unknown>;
    if (typeof message.type !== 'string') return null;
    if (message.type === 'REACTION_COMMAND') {
      if (!message.command || typeof message.command !== 'object' || Array.isArray(message.command)) return null;
      const command = message.command as Record<string, unknown>;
      if (
        (command.kind !== 'PASS' && command.kind !== 'PLAY') ||
        typeof command.playerId !== 'string' ||
        typeof command.windowId !== 'string' ||
        !Number.isSafeInteger(command.expectedRevision) ||
        (command.expectedRevision as number) < 0 ||
        (command.commandId !== undefined && typeof command.commandId !== 'string') ||
        (command.cardInstanceId !== undefined && typeof command.cardInstanceId !== 'string') ||
        (command.targetInstanceId !== undefined && typeof command.targetInstanceId !== 'string') ||
        (command.kind === 'PLAY' && typeof command.cardInstanceId !== 'string')
      ) return null;
      return decoded as NetMessage;
    }
    if (message.type === 'END_PHASE_DISCARD') {
      if (!message.command || typeof message.command !== 'object' || Array.isArray(message.command)) return null;
      const command = message.command as Record<string, unknown>;
      if (typeof command.playerId !== 'string' || typeof command.commandId !== 'string' || command.commandId.length === 0 || command.commandId.length > 128 ||
        !Number.isSafeInteger(command.expectedRevision) || (command.expectedRevision as number) < 0 || !Array.isArray(command.selectedInstanceIds) ||
        !command.selectedInstanceIds.every(id => typeof id === 'string') || new Set(command.selectedInstanceIds).size !== command.selectedInstanceIds.length) return null;
      return decoded as NetMessage;
    }
    if (message.type === 'EXIT_PREVENTION_COMMAND') {
      if (!message.command || typeof message.command !== 'object' || Array.isArray(message.command)) return null;
      const command = message.command as Record<string, unknown>;
      if ((command.kind !== 'USE_EXIT_PREVENTION' && command.kind !== 'DECLINE_EXIT_PREVENTION') ||
        typeof command.playerId !== 'string' || typeof command.commandId !== 'string' || command.commandId.length === 0 || command.commandId.length > 128 ||
        !Number.isSafeInteger(command.expectedRevision) || (command.expectedRevision as number) < 0 ||
        (command.sourceCardId !== undefined && typeof command.sourceCardId !== 'string') ||
        (command.kind === 'USE_EXIT_PREVENTION' && (typeof command.sourceCardId !== 'string' || command.sourceCardId.length === 0)) ||
        (command.kind === 'DECLINE_EXIT_PREVENTION' && command.sourceCardId !== undefined)) return null;
      return decoded as NetMessage;
    }
    if (message.type === 'DECK_CHOICE_COMMAND' || message.type === 'HELL_CHOICE_COMMAND') {
      if (!message.command || typeof message.command !== 'object' || Array.isArray(message.command)) return null;
      const command = message.command as Record<string, unknown>;
      if (typeof command.playerId !== 'string' || typeof command.commandId !== 'string' || command.commandId.length === 0 || command.commandId.length > 128 ||
        !Number.isSafeInteger(command.expectedRevision) || (command.expectedRevision as number) < 0 ||
        !Array.isArray(command.selectedInstanceIds) || !command.selectedInstanceIds.every(id => typeof id === 'string') ||
        new Set(command.selectedInstanceIds).size !== command.selectedInstanceIds.length ||
        (command.topOrderIds !== undefined && (!Array.isArray(command.topOrderIds) || !command.topOrderIds.every(id => typeof id === 'string')))) return null;
      return decoded as NetMessage;
    }
    if (message.type === 'MANUAL_OVERRIDE_COMMAND') {
      if (!message.command || typeof message.command !== 'object' || Array.isArray(message.command)) return null;
      const command = message.command as Record<string, unknown>;
      if ((command.kind !== 'SUBMIT_MANUAL_OVERRIDE' && command.kind !== 'APPROVE_MANUAL_OVERRIDE' && command.kind !== 'REJECT_MANUAL_OVERRIDE') ||
        typeof command.playerId !== 'string' || typeof command.commandId !== 'string' || command.commandId.length === 0 || command.commandId.length > 128 ||
        !Number.isSafeInteger(command.expectedRevision) || (command.expectedRevision as number) < 0 ||
        (command.action !== undefined && (typeof command.action !== 'object' || command.action === null || Array.isArray(command.action))) ||
        (command.context !== undefined && (typeof command.context !== 'object' || command.context === null || Array.isArray(command.context))) ||
        (command.kind !== 'SUBMIT_MANUAL_OVERRIDE' && command.action !== undefined)) return null;
      return decoded as NetMessage;
    }
    const knownTypes = ['HELLO', 'ROOM', 'REJECT', 'START', 'SYNC', 'PING', 'LEAVE'];
    if (!knownTypes.includes(message.type)) return null;
    return decoded as NetMessage;
  } catch {
    return null;
  }
}

export function generateRoomCode(): string {
  let suffix = '';
  for (let i = 0; i < 5; i++) {
    suffix += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return `BOT-${suffix}`;
}

export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase();
}

function peerIdFor(code: string): string {
  return `${PEER_PREFIX}${normalizeRoomCode(code).toLowerCase()}`;
}

interface DataConnectionLike {
  open: boolean;
  send: (data: unknown) => void;
  close: () => void;
  on: (event: string, cb: (...args: any[]) => void) => void;
}

/**
 * 'pass'     - not a handshake message, deliver it to subscribers.
 * 'consumed' - handshake message handled, keep the handshake handler installed.
 * 'done'     - handshake message handled, remove the handshake handler.
 */
type HandshakeResult = 'pass' | 'consumed' | 'done';

function createLink(
  conn: DataConnectionLike,
  handshake?: (msg: NetMessage) => HandshakeResult,
  transformOutgoing?: (msg: NetMessage) => NetMessage
): RoomLink {
  const messageListeners = new Set<(msg: NetMessage, senderPlayerId?: string) => void>();
  const closeListeners = new Set<() => void>();
  const buffer: NetMessage[] = [];
  let closed = false;
  let lastSeen = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const dispatch = (msg: NetMessage) => {
    if (messageListeners.size === 0) {
      buffer.push(msg);
      return;
    }
    messageListeners.forEach(cb => cb(msg));
  };

  const notifyClosed = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    closeListeners.forEach(cb => cb());
  };

  const startHeartbeat = () => {
    if (heartbeat) return;
    lastSeen = Date.now();
    heartbeat = setInterval(() => {
      if (Date.now() - lastSeen > HEARTBEAT_TIMEOUT_MS) {
        notifyClosed();
        return;
      }
      if (conn.open) conn.send(encodeNetMessage({ type: 'PING' }));
    }, HEARTBEAT_INTERVAL_MS);
  };

  conn.on('data', (raw: unknown) => {
    lastSeen = Date.now();
    const msg = decodeNetMessage(raw);
    if (!msg || msg.type === 'PING') return;
    if (msg.type === 'LEAVE') {
      notifyClosed();
      return;
    }
    if (handshake) {
      const result = handshake(msg);
      if (result !== 'pass') {
        startHeartbeat();
        if (result === 'done') handshake = undefined;
        return;
      }
    }
    dispatch(msg);
  });

  conn.on('close', notifyClosed);
  conn.on('error', notifyClosed);

  if (!handshake) startHeartbeat();

  return {
    send: msg => {
      if (closed || !conn.open) return;
      conn.send(encodeNetMessage(transformOutgoing ? transformOutgoing(msg) : msg));
    },
    onMessage: cb => {
      messageListeners.add(cb);
      if (buffer.length > 0) {
        const pending = buffer.splice(0, buffer.length);
        pending.forEach(message => cb(message));
      }
      return () => messageListeners.delete(cb);
    },
    onClose: cb => {
      closeListeners.add(cb);
      if (closed) cb();
      return () => closeListeners.delete(cb);
    },
    close: () => {
      if (!closed && conn.open) {
        try {
          conn.send(encodeNetMessage({ type: 'LEAVE' }));
        } catch {}
      }
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      try {
        conn.close();
      } catch {}
    }
  };
}

interface GuestEntry {
  playerId: string;
  conn: DataConnectionLike;
  link: RoomLink;
  setup: PlayerSetup | null;
}

/** Star topology: the host owns every connection and relays guest updates to the other guests. */
function createHostLink(guests: GuestEntry[]): RoomLink {
  const messageListeners = new Set<(msg: NetMessage, senderPlayerId?: string) => void>();
  const closeListeners = new Set<() => void>();
  const peerLeftListeners = new Set<(playerId: string) => void>();
  const buffer: Array<{ message: NetMessage; senderPlayerId: string }> = [];
  const openGuests = new Set(guests.map(guest => guest.playerId));
  let allClosed = false;

  guests.forEach(guest => {
    guest.link.onMessage(msg => {
      const hostView = msg;
      if (messageListeners.size === 0) {
        buffer.push({ message: hostView, senderPlayerId: guest.playerId });
        return;
      }
      messageListeners.forEach(callback => callback(hostView, guest.playerId));
    });

    guest.link.onClose(() => {
      openGuests.delete(guest.playerId);
      peerLeftListeners.forEach(callback => callback(guest.playerId));
      if (openGuests.size === 0 && !allClosed) {
        allClosed = true;
        closeListeners.forEach(callback => callback());
      }
    });
  });

  return {
    send: msg => guests.forEach(guest => {
      const viewerMessage = msg.type === 'SYNC'
        ? { ...msg, state: redactLifeCardsForViewer(msg.state, guest.playerId) }
        : msg;
      guest.link.send(viewerMessage);
    }),
    onMessage: callback => {
      messageListeners.add(callback);
      if (buffer.length > 0) {
        const pending = buffer.splice(0, buffer.length);
        pending.forEach(({ message, senderPlayerId }) => callback(message, senderPlayerId));
      }
      return () => messageListeners.delete(callback);
    },
    onClose: callback => {
      closeListeners.add(callback);
      if (allClosed) callback();
      return () => closeListeners.delete(callback);
    },
    onPeerLeft: callback => {
      peerLeftListeners.add(callback);
      return () => peerLeftListeners.delete(callback);
    },
    close: () => guests.forEach(guest => guest.link.close())
  };
}

export interface HostRoomOptions {
  /** Phase 5 room rule mode; defaults to HYBRID so all 1,833 cards stay playable. */
  ruleMode?: RoomRuleMode;
}

export function hostRoom(
  mode: RoomMode,
  local: PlayerSetup,
  buildState: (setups: PlayerSetup[]) => GameState,
  handlers: RoomHandlers,
  options: HostRoomOptions = {}
): HostController {
  const { min, max } = ROOM_LIMITS[mode];
  const ruleMode: RoomRuleMode = options.ruleMode ?? 'HYBRID';
  let cancelled = false;
  let started = false;
  let peer: any = null;
  let roomCode = '';
  const guests: GuestEntry[] = [];

  const joinedGuests = () => guests.filter(g => g.setup);
  const names = () => [local.name, ...joinedGuests().map(g => g.setup!.name)];

  const publishRoster = () => {
    const roster = names();
    handlers.onPlayers?.(roster, max);
    joinedGuests().forEach(g => g.link.send({ type: 'ROOM', mode, capacity: max, names: roster, ruleMode }));
    if (roster.length < min) {
      handlers.onStatus(`รอเพื่อนเข้าห้อง... (${roster.length}/${max})`);
    } else {
      handlers.onStatus(
        mode === 'DUEL' ? 'เพื่อนเข้าห้องแล้ว' : `ผู้เล่นครบขั้นต่ำแล้ว (${roster.length}/${max}) กดเริ่มเกมได้เลย`
      );
    }
  };

  const startMatch = () => {
    const ready = joinedGuests();
    if (started || cancelled || ready.length + 1 < min) return;
    started = true;

    const setups = [local, ...ready.map(g => g.setup!)];
    const initialState: GameState = { ...buildState(setups), ruleMode };
    ready.forEach((guest, index) => {
      guest.playerId = playerIdForSeat(index + 1);
    });
    ready.forEach(guest => {
      guest.link.send({
        type: 'START',
        state: redactLifeCardsForViewer(initialState, guest.playerId),
        myPlayerId: guest.playerId
      });
    });

    // Anybody who connected but never said hello is not part of the match.
    guests.filter(g => !g.setup).forEach(g => g.link.close());

    handlers.onReady({
      link: createHostLink(ready),
      role: 'host',
      myPlayerId: HOST_PLAYER_ID,
      code: roomCode,
      initialState
    });
  };

  const begin = async (attempt: number) => {
    const { Peer } = await import('peerjs');
    if (cancelled) return;

    const code = generateRoomCode();
    peer = new Peer(peerIdFor(code));

    peer.on('open', () => {
      if (cancelled) return;
      roomCode = code;
      handlers.onCode?.(code);
      publishRoster();
    });

    peer.on('connection', (conn: DataConnectionLike) => {
      const reject = (reason: string) => {
        conn.on('open', () => {
          conn.send(encodeNetMessage({ type: 'REJECT', reason }));
          setTimeout(() => conn.close(), 500);
        });
      };
      if (started) return reject('เกมในห้องนี้เริ่มไปแล้ว');
      if (guests.length >= max - 1) return reject('ห้องเต็มแล้ว');

      const entry: GuestEntry = {
        playerId: playerIdForSeat(guests.length + 1),
        conn,
        setup: null,
        link: createLink(conn, msg => {
          if (msg.type !== 'HELLO' || started) return 'pass';
          if (ruleMode === 'AUTO_STRICT') {
            const offender = deckViolatesAutoStrict(msg.setup.mainDeck);
            if (offender) {
              reject(`โหมด Auto-Strict รองรับเฉพาะการ์ดที่ระบบเล่นได้อัตโนมัติ — เด็คของคุณมี "${offender.name}" ที่ยังไม่รองรับ`);
              return 'consumed';
            }
          }
          entry.setup = msg.setup;
          publishRoster();
          if (mode === 'DUEL') startMatch();
          return 'consumed';
        })
      };
      guests.push(entry);
      handlers.onStatus('เพื่อนกำลังเชื่อมต่อ...');

      entry.link.onClose(() => {
        if (started) return;
        const index = guests.indexOf(entry);
        if (index !== -1) guests.splice(index, 1);
        if (!cancelled) publishRoster();
      });
    });

    peer.on('error', (err: { type?: string; message?: string }) => {
      if (cancelled || started) return;
      if (err.type === 'unavailable-id' && attempt < 5) {
        peer.destroy();
        begin(attempt + 1);
        return;
      }
      handlers.onError(
        err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error'
          ? 'เชื่อมต่อเซิร์ฟเวอร์จับคู่ไม่ได้ ลองใหม่อีกครั้ง'
          : `สร้างห้องไม่สำเร็จ (${err.type ?? 'unknown'})`
      );
    });
  };

  begin(0).catch(() => handlers.onError('โหลดระบบเชื่อมต่อไม่สำเร็จ'));

  return {
    start: startMatch,
    cancel: () => {
      cancelled = true;
      if (!started) {
        guests.forEach(g => g.link.close());
        try {
          peer?.destroy();
        } catch {}
      }
    }
  };
}

export function joinRoom(
  rawCode: string,
  local: PlayerSetup,
  handlers: RoomHandlers
): RoomController {
  const code = normalizeRoomCode(rawCode);
  let cancelled = false;
  let peer: any = null;
  let link: RoomLink | null = null;
  let matched = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const fail = (message: string) => {
    if (cancelled || matched) return;
    if (timeout) clearTimeout(timeout);
    handlers.onError(message);
    link?.close();
    try {
      peer?.destroy();
    } catch {}
  };

  (async () => {
    const { Peer } = await import('peerjs');
    if (cancelled) return;
    handlers.onStatus('กำลังค้นหาห้อง...');
    peer = new Peer();

    timeout = setTimeout(() => fail('เชื่อมต่อห้องไม่สำเร็จ (หมดเวลา) ตรวจสอบรหัสห้องแล้วลองใหม่'), CONNECT_TIMEOUT_MS);

    peer.on('error', (err: { type?: string }) => {
      if (err.type === 'peer-unavailable') {
        fail(`ไม่พบห้อง ${code} — ตรวจสอบรหัส หรือให้โฮสต์สร้างห้องก่อน`);
      } else {
        fail(`เชื่อมต่อไม่สำเร็จ (${err.type ?? 'unknown'})`);
      }
    });

    peer.on('open', () => {
      if (cancelled) return;
      const conn: DataConnectionLike = peer.connect(peerIdFor(code), { reliable: true });

      link = createLink(conn, msg => {
        if (msg.type === 'REJECT') {
          fail(msg.reason);
          return 'consumed';
        }
        if (msg.type === 'ROOM') {
          // Connected: from here the host decides when the match begins, so stop the connect timeout.
          if (timeout) clearTimeout(timeout);
          handlers.onPlayers?.(msg.names, msg.capacity);
          handlers.onStatus(
            msg.mode === 'DUEL'
              ? 'เข้าห้องแล้ว กำลังเริ่มเกม...'
              : `เข้าห้องแล้ว รอโฮสต์กดเริ่มเกม (${msg.names.length}/${msg.capacity})`
          );
          return 'consumed';
        }
        if (msg.type === 'START') {
          matched = true;
          if (timeout) clearTimeout(timeout);
          handlers.onReady({
            link: link!,
            role: 'guest',
            myPlayerId: msg.myPlayerId,
            code,
            initialState: restoreOwnLifeCardsFromSetup(msg.state, local, msg.myPlayerId)
          });
          return 'done';
        }
        return 'pass';
      });

      link.onClose(() => fail('การเชื่อมต่อกับห้องถูกตัด'));

      conn.on('open', () => {
        handlers.onStatus('พบห้องแล้ว กำลังเข้าร่วม...');
        conn.send(encodeNetMessage({ type: 'HELLO', setup: redactLifeCardsInSetup(local) }));
      });
    });
  })().catch(() => fail('โหลดระบบเชื่อมต่อไม่สำเร็จ'));

  return {
    cancel: () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
      if (!matched) {
        link?.close();
        try {
          peer?.destroy();
        } catch {}
      }
    }
  };
}
