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
  favorText: z.string().optional(),
  creator: z.string().optional(),
  isOnlyOne: z.boolean().default(false),
  isBias: z.boolean().default(false),
  isCollab: z.boolean().default(false),
  imageUrl: z.string().url()
});

export type Card = z.infer<typeof CardSchema>;

export interface CardInstance {
  instanceId: string;
  card: Card;
  ownerId: string;
  controllerId: string;
  isRested: boolean;
  isFaceUp: boolean;
  duoWithInstanceId?: string;
  attachedInstances: CardInstance[];
  layerModifiers: {
    layer: 1 | 2 | 3 | 4;
    powerMod: number;
    sourceCardId: string;
    expiresAt?: 'END_OF_BATTLE' | 'END_OF_TURN' | 'DRAW_PHASE';
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

export interface ReactionChainEntry extends PendingReactionCard {
  targetAvatarId?: string;
  respondedTo: ReactionTrigger;
}

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
}
