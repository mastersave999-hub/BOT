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
  /** Public confirmation required by Rule Book 3.2 p.3 when a Deck Search finds no target. */
  pendingDeckSearchVerification?: PendingDeckSearchVerification;
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
