import { z } from 'zod';

export const CardTypeSchema = z.enum(['Avatar', 'Magic', 'Construct', 'Life', 'Token']);
export type CardType = z.infer<typeof CardTypeSchema>;

export const MagicSubtypeSchema = z.enum(['Normal', 'Modification', 'React', 'Land']);
export type MagicSubtype = z.infer<typeof MagicSubtypeSchema>;

export const CardColorSchema = z.enum(['แดง', 'ฟ้า', 'เขียว', 'ม่วง', 'ไร้สี']);
export type CardColor = z.infer<typeof CardColorSchema>;

export const CardSchema = z.object({
  printId: z.string(),
  name: z.string(),
  type: CardTypeSchema,
  subtype: MagicSubtypeSchema.nullable().optional(),
  soi: z.number().default(1),
  cost: z.number().default(0),
  gem: z.number().default(0),
  gemColor: z.string().nullable().optional(),
  power: z.number().default(0),
  symbol: z.string().nullable().optional(),
  color: z.string().default('ไร้สี'),
  rarity: z.string().default('C'),
  dropRate: z.string().optional(),
  mainEffect: z.string().default(''),
  /** Explicit metadata for Rule Book 3.2 Rule Text (#), which cannot be cancelled. */
  ruleTextProtected: z.boolean().optional(),
  favorText: z.string().optional(),
  creator: z.string().optional(),
  isOnlyOne: z.boolean().default(false),
  isBias: z.boolean().default(false),
  isCollab: z.boolean().default(false),
  imageUrl: z.string().url()
});

export type Card = z.infer<typeof CardSchema>;

export type EffectDuration = 'END_OF_BATTLE' | 'END_OF_TURN' | 'DRAW_PHASE';

export interface ContinuousPowerEffect {
  layer: 1 | 2;
  powerMod: number;
  symbolMod?: string;
  targetCardType?: 'Avatar' | 'Construct' | 'Life';
  targetController?: 'SOURCE_CONTROLLER' | 'OPPONENT' | 'ANY';
  targetSymbol?: string;
  targetSymbols?: string[];
  targetNameIncludes?: string;
  targetSelf?: boolean;
}

export interface PreventionShield {
  id: string;
  kind: 'DAMAGE' | 'DESTRUCTION' | 'TARGETING';
  /** Destruction protections resolve automatically first, or as a chosen React/activated response. */
  mode?: 'AUTOMATIC' | 'ACTIVATED';
  sourceInstanceId?: string;
  sourceControllerId?: string;
  /** DAMAGE shields prevent this many points per use; omission prevents all damage. */
  amount?: number;
  usesRemaining?: number;
  expiresAt?: EffectDuration;
  /** Player-directed movement bypasses destruction protection unless explicitly allowed. */
  includePlayerActions?: boolean;
}

export interface CardInstance {
  instanceId: string;
  card: Card;
  ownerId: string;
  /** Immutable card holder; defaults to ownerId for older saved states. */
  originalOwnerId?: string;
  controllerId: string;
  /** Duo Avatars and card effects may explicitly forbid control changes. */
  controlChangeImmune?: boolean;
  isRested: boolean;
  isFaceUp: boolean;
  duoWithInstanceId?: string;
  attachedInstances: CardInstance[];
  continuousEffects?: ContinuousPowerEffect[];
  preventionShields?: PreventionShield[];
  /** Explicit typed event abilities; never inferred from printed card text. */
  triggerAbilities?: import('./triggerEngine').TriggerAbility[];
  /** Card-text activated and continuous abilities are registered only while this instance is on an active field. */
  registeredActivatedAbilities?: import('./cardTextAdapter').ParsedCardTextClause[];
  registeredContinuousAbilities?: import('./cardTextAdapter').ParsedCardTextClause[];
  cardTextContinuousEffects?: ContinuousPowerEffect[];
  destroyAtEndPhase?: { playerId: string; turnNumber: number };
  layerModifiers: {
    layer: 1 | 2 | 3 | 4;
    powerMod: number;
    powerSet?: number;
    symbolMod?: string;
    sourceCardId: string;
    /** Layer 4 combat status moves to this layer when the attack/combat ends (Rule Book 3.2 p.16). */
    transferToLayer?: 1 | 2;
    expiresAt?: EffectDuration;
  }[];
}

export type Phase = 'DRAW' | 'MAIN' | 'BATTLE' | 'END';

export type ReactionTriggerType =
  | 'AVATAR_SUMMONED'
  | 'MAGIC_PLAYED'
  | 'ABILITY_USED'
  | 'ATTACK_DECLARED'
  | 'AVATAR_TARGETED'
  | 'AVATAR_WOULD_BE_DESTROYED'
  | 'AVATAR_DESTROYED'
  | 'BEFORE_PHASE_CHANGE';

export interface ReactionTrigger {
  type: ReactionTriggerType;
  actorId: string;
  targetInstanceId?: string;
  targetCardName?: string;
  sourceCardName?: string;
  sourceInstanceId?: string;
}

export type DeferredReactionAction =
  | {
      type: 'SUMMON_JUTI' | 'RESOLVE_MAGIC';
      actorId: string;
      sourceCard: CardInstance;
      paidCost?: boolean;
      targetAvatarId?: string;
    }
  | {
      type: 'AI_TURN_CONTINUATION';
      actorId: string;
      sourceCard: CardInstance;
      logs: string[];
    }
  | {
      type: 'ADVANCE_PHASE';
      actorId: string;
      nextPhase: Phase;
    }
  | {
      type: 'START_ATTACK';
      actorId: string;
      sourceCard: CardInstance;
    }
  | {
      type: 'RESOLVE_COMBAT';
      actorId: string;
      sourceCard: CardInstance;
      targetPlayerId: string;
      targetAvatarId: string;
      checkedAvatarIds?: string[];
    }
  | {
      type: 'RESOLVE_ABILITY';
      actorId: string;
      sourceCard: CardInstance;
      abilityTrigger: 'CONSTRUCT_ACTIVATE';
    };

export interface PendingReactionCard {
  playerId: string;
  sourceCard: CardInstance;
  treatedAsReact: boolean;
}

export type ReactionChainEntry =
  | (PendingReactionCard & {
      entryType: 'REACT_MAGIC';
      targetAvatarId?: string;
      respondedTo: ReactionTrigger;
    })
  | {
      entryType: 'TRIGGER_ABILITY';
      sourceCardId: string;
      controllerId: string;
  triggerId: string;
  effects: import('./effectResolver').EffectDefinition[];
  costs?: import('./effectResolver').EffectCost[];
  conditions?: import('./effectResolver').EffectCondition[];
  cancelled: boolean;
  eventId: string;
  respondedTo: ReactionTrigger;
  }
  | {
  entryType: 'ACTIVATED_ABILITY';
      sourceCardId: string;
      controllerId: string;
      triggerId: string;
      effects: import('./effectResolver').EffectDefinition[];
      cancelled: boolean;
      eventId: string;
      respondedTo: ReactionTrigger;
      exitPreventionTargetId?: string;
    };

export interface ReactionWindow {
  id: string;
  trigger: ReactionTrigger;
  turnOwnerId: string;
  priorityPlayerId: string;
  passedPlayerIds: string[];
  /** The rulebook's turn-player-first pass order, rotated after each response. */
  priorityOrder?: string[];
  /** Reactions are stored in play order and resolve from the end of this array. */
  chain?: ReactionChainEntry[];
  /** Monotonic window version used to reject stale/duplicate network commands. */
  revision?: number;
  pendingAction?: DeferredReactionAction;
  pendingReaction?: PendingReactionCard;
}

export interface PlayerState {
  id: string;
  name: string;
  seat: number;
  deck: CardInstance[];
  hand: CardInstance[];
  lifeDeck: CardInstance[];
  /** LIFE card abilities revealed by a successful attack, resolved at this player's next Main Phase. */
  pendingLifeEffects?: string[];
  avatarZone: CardInstance[]; // Max 4 Avatar, max 6 total including Tokens
  constructZone: CardInstance[]; // Max 3 unique names
  magicZone: CardInstance[]; // Unlimited (active/attached magic or relocated avatars)
  hell: CardInstance[]; // Graveyard
  darkDimension: CardInstance[]; // Banishment
  isCritical: boolean; // สถานะสาหัส
  reactMagicBudget: {
    ownTurnRemaining: number; // 1 per own turn
    opponentTurnRemaining: number; // 1 across opponent turns
  };
  usedMagicTypesThisTurn: Set<MagicSubtype>; // Max 1 per Magic Type per turn
  preventionShields?: PreventionShield[];
}

export interface PendingExitPrevention {
  targetCardId: string;
  destination: 'deck' | 'hand' | 'lifeDeck' | 'avatarZone' | 'constructZone' | 'magicZone' | 'hell' | 'darkDimension' | 'landMagicZone' | 'removedFromGame';
  destinationPlayerId?: string;
  actorId: string;
  preventionPlayerId: string;
  effectMove?: boolean;
  deckPosition?: 'top' | 'bottom';
  cause: 'EFFECT' | 'COMBAT' | 'PLAYER_ACTION' | 'OTHER';
  expectedRevision: number;
  usedActivatedPrevention: boolean;
}

export interface PendingDeckSearchVerification {
  deckOwnerId: string;
  searcherId: string;
  verifierPlayerIds: string[];
  expectedRevision: number;
}

/** Phase 5 room rule mode: Hybrid keeps every card playable, Auto-Strict allows only fully modeled cards. */
export type RoomRuleMode = 'HYBRID' | 'AUTO_STRICT';

/** Filter inputs for a manual Deck Search; mirrors DeckSearchCriteria without the code predicate. */
export interface ManualDeckSearchCriteria {
  types?: Card['type'][];
  colors?: string[];
  minCost?: number;
  maxCost?: number;
  nameIncludes?: string;
  symbols?: string[];
}

/** Structured, rule-bounded manual resolution action for UNSUPPORTED/AMBIGUOUS cards. */
export type ManualOverrideAction =
  | { kind: 'ADJUST_POWER'; instanceId: string; delta: number }
  | { kind: 'SET_WAKE_STATE'; instanceId: string; isRested: boolean }
  | { kind: 'MOVE_CARD'; instanceId: string; destination: 'deck' | 'hand' | 'avatarZone' | 'constructZone' | 'magicZone' | 'hell' | 'darkDimension'; destinationPlayerId?: string; deckPosition?: 'top' | 'bottom' }
  | { kind: 'DRAW_CARD'; playerId: string }
  | { kind: 'DISCARD_CARD'; instanceId: string }
  | { kind: 'ADJUST_LIFE'; playerId: string; face: 'up' | 'down' }
  /** Phase 8: opens an authorized pendingDeckChoice; Rule Book 3.2 mandates the post-search shuffle. */
  | { kind: 'MANUAL_SEARCH_DECK'; deckOwnerId: string; criteria: ManualDeckSearchCriteria; selectCount: number; destination: 'hand' | 'hell' | 'deck' }
  | { kind: 'MANUAL_SCOUT_DECK'; deckOwnerId: string; count: number; destination: 'hand' | 'hell' | 'deck'; selectedDeckPosition?: 'top' | 'bottom'; unselectedDeckPosition?: 'top' | 'bottom' | 'shuffle' }
  | { kind: 'MANUAL_MILL_DECK'; deckOwnerId: string; count: number }
  | { kind: 'MANUAL_SHUFFLE_DECK'; deckOwnerId: string }
  /** Phase 8: opens an authorized pendingHellChoice over Hell / Dark Dimension recovery. */
  | { kind: 'MANUAL_HELL_CHOICE'; playerId: string; cardType: 'Avatar' | 'Construct' | 'Magic'; count: number; destination: 'hand' | 'deck_top' | 'deck_bottom' | 'avatarZone' | 'banish' }
  /** Phase 8: spawns a Token; the Avatar Zone keeps its 4 normal Avatar / 6 total cap. */
  | { kind: 'MANUAL_SPAWN_TOKEN'; playerId: string; name?: string; power?: number; color?: string }
  /** Phase 8: control change on a field Avatar; honours controlChangeImmune and Duo pairs. */
  | { kind: 'MANUAL_CHANGE_CONTROL'; instanceId: string; newControllerId: string };

export interface ManualOverrideContext {
  cardInstanceId?: string;
  cardName?: string;
  cardText?: string;
  cardStatus?: 'UNSUPPORTED' | 'AMBIGUOUS' | 'VERIFIED_WORKING';
}

/** A submitted manual override awaits Confirm/Reject approval from every other player. */
export interface PendingManualOverride {
  action: ManualOverrideAction;
  /** Phase 8: optional multi-step queue for one card's effect; applied all-or-nothing after approval. */
  actions?: ManualOverrideAction[];
  actorId: string;
  expectedRevision: number;
  commandId: string;
  approvals: string[];
  rejections: string[];
  context?: ManualOverrideContext;
}

export interface PendingDeckChoice {
  kind: 'SCOUT' | 'SEARCH';
  deckOwnerId: string;
  actorId: string;
  authorizedViewerId: string;
  candidateInstanceIds: string[];
  minSelect: number;
  maxSelect: number;
  destination: 'hand' | 'hell' | 'deck';
  selectedDeckPosition?: 'top' | 'bottom';
  unselectedDeckPosition?: 'top' | 'bottom' | 'shuffle';
  topOrderAllowed?: boolean;
  expectedRevision: number;
  commandId?: string;
}

export interface PendingHellChoice {
  effectKind: 'recover_from_hell' | 'summon_from_hell';
  playerId: string;
  actorId: string;
  authorizedViewerId: string;
  candidateInstanceIds: string[];
  minSelect: number;
  maxSelect: number;
  cardType: 'Avatar' | 'Construct' | 'Magic';
  names?: Array<{ value: string; matching: 'DELIMITED_WORD_SEQUENCE' | 'EXACT_CARD_NAME' }>;
  symbol?: string;
  powerAtMost?: number;
  destination: 'deck_top' | 'deck_bottom' | 'hand' | 'banish' | 'avatarZone';
  rested?: boolean;
  expectedRevision: number;
  commandId?: string;
}

export interface GameState {
  id: string;
  mode: 'DUEL' | 'AD_MUA';
  playerOrder: string[]; // Player IDs in clockwise turn order
  currentTurnPlayerIndex: number;
  currentPhase: Phase;
  turnNumber: number;
  roundNumber: number;
  players: Record<string, PlayerState>;
  landMagicZone: CardInstance | null; // 1 shared global slot
  reactionWindow?: ReactionWindow;
  reactionSequence?: number;
  pendingEndPhaseDiscardPlayerId?: string;
  /** Revision captured when End Phase discard selection opens; commands must match it. */
  pendingEndPhaseDiscardRevision?: number;
  pendingExitPrevention?: PendingExitPrevention;
  /** Private Deck operation choice; card identities are projected only to authorized viewers. */
  pendingDeckChoice?: PendingDeckChoice;
  /** Private Hell recovery choice; card identities are projected only to authorized viewers. */
  pendingHellChoice?: PendingHellChoice;
  /** Public confirmation required by Rule Book 3.2 p.3 when a Deck Search finds no target. */
  pendingDeckSearchVerification?: PendingDeckSearchVerification;
  /** Phase 5 Hybrid mode: staged manual resolution awaiting opponent Confirm/Reject approval. */
  pendingManualOverride?: PendingManualOverride;
  /** Room rule mode chosen at room creation; defaults to HYBRID for older states. */
  ruleMode?: RoomRuleMode;
  /** Monotonic revision for command preconditions and duplicate-command rejection. */
  stateRevision?: number;
  /** Recent idempotency keys for accepted multiplayer commands. */
  processedCommandIds?: string[];
  /** Opening dice roll (d6) per player id; present only when turn order was decided by dice. */
  openingRolls?: Record<string, number>;
  battleContext?: {
    attackerInstanceId: string;
    targetType: 'AVATAR' | 'CONSTRUCT' | 'LIFE';
    targetPlayerId: string;
    targetInstanceId?: string;
    step: 1 | 2 | 3 | 4 | 5;
    snapshotPower: number;
    unityHelpers: string[];
    isDirectEggKick: boolean; // เตะไข่
  };
  eventLog: Array<{
    timestamp: number;
    type: string;
    description: string;
    actorId: string;
  }>;
  gameEvents?: Array<{ sequence: number; event: import('./gameEvents').GameEvent }>;
  /** Turn-scoped keys for structured once-per-turn triggered abilities. */
  triggerUsage?: string[];
  /** Per-turn execution caps prevent EACH_EVENT triggers from creating unbounded loops. */
  triggerLoopCounts?: Record<string, number>;
  /** Event ids already fully dispatched to triggers, preventing duplicate/reentrant loops. */
  processedTriggerEventIds?: string[];
  /** Activated protection attempts already used for a particular leaving-card event. */
  preventionAttempts?: string[];
}
