import { GameState, PlayerState, CardInstance, MagicSubtype } from './types';

export function executeDrawPhase(state: GameState): GameState {
  const currentTurnPlayerId = state.playerOrder[state.currentTurnPlayerIndex];
  const player = state.players[currentTurnPlayerId];

  if (!player) throw new Error('Player not found');

  // RuleBook p.21: Simultaneously awaken rested Avatars and draw cards
  const updatedAvatarZone = player.avatarZone.map(avatar => ({
    ...avatar,
    isRested: false
  }));

  // Reset per-turn magic restrictions
  const updatedMagicTypes = new Set<MagicSubtype>();
  const updatedBudget = {
    ownTurnRemaining: 1,
    opponentTurnRemaining: 1
  };

  // RuleBook p.21 Draw calculation:
  // - First turn player on Turn 1 draws 2 cards
  // - Otherwise: If hand < 3, draw to 3. If hand >= 3, draw 1 card.
  let drawCount = 1;
  if (state.turnNumber === 1 && state.currentTurnPlayerIndex === 0) {
    drawCount = 2;
  } else if (player.hand.length < 3) {
    drawCount = 3 - player.hand.length;
  } else {
    drawCount = 1;
  }

  // Draw cards from top of deck and set isFaceUp to true for hand
  const cardsDrawn = player.deck.slice(0, drawCount).map(c => ({
    ...c,
    isFaceUp: true
  }));
  const remainingDeck = player.deck.slice(drawCount);

  // Win/Loss Condition: Deck reaches 0 immediately [RuleBook p.21]
  if (player.deck.length < drawCount) {
    state.eventLog.push({
      timestamp: Date.now(),
      type: 'PLAYER_DECK_OUT',
      description: `${player.name} ran out of cards in deck and lost the game.`,
      actorId: player.id
    });
  }

  const updatedHand = [...player.hand, ...cardsDrawn];

  const updatedPlayer: PlayerState = {
    ...player,
    avatarZone: updatedAvatarZone,
    deck: remainingDeck,
    hand: updatedHand,
    usedMagicTypesThisTurn: updatedMagicTypes,
    reactMagicBudget: updatedBudget
  };

  return {
    ...state,
    currentPhase: 'MAIN',
    players: {
      ...state.players,
      [currentTurnPlayerId]: updatedPlayer
    },
    eventLog: [
      ...state.eventLog,
      {
        timestamp: Date.now(),
        type: 'DRAW_PHASE_COMPLETE',
        description: `${player.name} drew ${drawCount} card(s) and awakened avatars. Transitioned to Main Phase.`,
        actorId: player.id
      }
    ]
  };
}
