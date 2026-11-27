import { Card, CardInstance, GameState, PlayerState } from './types';

/**
 * Local (offline) match initialization shared by Quick Match and the AI opponent.
 *
 * Rule Book 3.2 "Game Set up" (p.19): shuffle the Main Deck, deal 5 cards as the
 * opening hand, and shuffle the 5 LIFE Cards face-down into the LIFE Card Zone.
 * Both players therefore start with empty field zones — no Avatar is ever
 * pre-spawned — and the card distribution must conserve every instance exactly once.
 */

export function createCardInstance(card: Card, ownerId: string, instanceId: string, isFaceUp = true): CardInstance {
  return {
    instanceId,
    card,
    ownerId,
    originalOwnerId: ownerId,
    controllerId: ownerId,
    isRested: false,
    isFaceUp,
    attachedInstances: [],
    layerModifiers: []
  };
}

export function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export interface LocalMatchSide {
  name: string;
  mainDeck: Card[];
  lifeDeck: Card[];
  /** Opponent hands are dealt face-down so the local player cannot read them. */
  hideHand?: boolean;
}

function createLocalPlayer(
  playerId: string,
  seat: number,
  side: LocalMatchSide,
  prefix: string
): PlayerState {
  const main = shuffled(side.mainDeck);
  const life = shuffled(side.lifeDeck);
  return {
    id: playerId,
    name: side.name,
    seat,
    deck: main.slice(5).map((card, index) => createCardInstance(card, playerId, `${prefix}-deck-${index}`, false)),
    hand: main.slice(0, 5).map((card, index) => createCardInstance(card, playerId, `${prefix}-hand-${index}`, !side.hideHand)),
    lifeDeck: life.map((card, index) => createCardInstance(card, playerId, `${prefix}-life-${index}`, false)),
    avatarZone: [],
    constructZone: [],
    magicZone: [],
    hell: [],
    darkDimension: [],
    isCritical: false,
    reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 },
    usedMagicTypesThisTurn: new Set()
  };
}

export function createLocalMatchState(
  mode: 'DUEL' | 'AD_MUA',
  sides: [LocalMatchSide, LocalMatchSide],
  welcomeDescription = `ยินดีต้อนรับสู่ Battle of Talingchan Online (${mode} Mode)! เริ่มเกมรอบแรก`
): GameState {
  // Local Quick Match keeps the pre-existing fixed seating: player-1 always opens.
  // (Online rooms resolve first player through rollOpeningOrder instead.)
  const playerIds = ['player-1', 'player-2'];
  return {
    id: `match-${Date.now()}`,
    mode,
    playerOrder: ['player-1', 'player-2'],
    currentTurnPlayerIndex: 0,
    currentPhase: 'DRAW',
    turnNumber: 1,
    roundNumber: 1,
    landMagicZone: null,
    players: {
      [playerIds[0]]: createLocalPlayer(playerIds[0], 0, sides[0], 'p1'),
      [playerIds[1]]: createLocalPlayer(playerIds[1], 1, sides[1], 'p2')
    },
    eventLog: [
      {
        timestamp: Date.now(),
        type: 'GAME_STARTED',
        description: welcomeDescription,
        actorId: 'system'
      }
    ]
  };
}
