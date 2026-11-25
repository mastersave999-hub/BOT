import { describe, it, expect } from 'vitest';
import { executeDrawPhase } from '../src/engine/turnEngine.js';
import { GameState, PlayerState, CardInstance } from '../src/engine/types.js';

function createMockCard(id: string): CardInstance {
  return {
    instanceId: id,
    ownerId: 'player-1',
    controllerId: 'player-1',
    isRested: true,
    isFaceUp: true,
    attachedInstances: [],
    layerModifiers: [],
    card: {
      printId: id,
      name: `Card ${id}`,
      type: 'Avatar',
      power: 2,
      cost: 1,
      gem: 1,
      color: 'แดง',
      rarity: 'C',
      isOnlyOne: false,
      isBias: false,
      isCollab: false,
      mainEffect: '',
      imageUrl: 'https://cdn.bottcg.com/cards/test.png'
    }
  };
}

describe('Turn Engine: Draw Phase Rules (Rule Book 3.2 p.21)', () => {
  it('P1 Turn 1 should draw exactly 2 cards and awaken rested avatars', () => {
    const player: PlayerState = {
      id: 'p1',
      name: 'Player 1',
      seat: 0,
      deck: [createMockCard('D1'), createMockCard('D2'), createMockCard('D3')],
      hand: [createMockCard('H1')],
      lifeDeck: [],
      avatarZone: [createMockCard('AV1')], // Rested avatar
      constructZone: [],
      magicZone: [],
      hell: [],
      darkDimension: [],
      isCritical: false,
      reactMagicBudget: { ownTurnRemaining: 0, opponentTurnRemaining: 0 },
      usedMagicTypesThisTurn: new Set()
    };

    const state: GameState = {
      id: 'game-1',
      mode: 'DUEL',
      playerOrder: ['p1', 'p2'],
      currentTurnPlayerIndex: 0,
      currentPhase: 'DRAW',
      turnNumber: 1,
      roundNumber: 1,
      players: { p1: player },
      landMagicZone: null,
      eventLog: []
    };

    const nextState = executeDrawPhase(state);
    const updatedP1 = nextState.players['p1'];

    expect(updatedP1.hand).toHaveLength(3); // 1 + 2 = 3
    expect(updatedP1.deck).toHaveLength(1);
    expect(updatedP1.avatarZone[0].isRested).toBe(false); // Awakened!
    expect(nextState.currentPhase).toBe('MAIN');
  });

  it('Hand with fewer than 3 cards draws up to 3 cards', () => {
    const player: PlayerState = {
      id: 'p1',
      name: 'Player 1',
      seat: 0,
      deck: [createMockCard('D1'), createMockCard('D2'), createMockCard('D3'), createMockCard('D4')],
      hand: [createMockCard('H1')], // Only 1 card in hand!
      lifeDeck: [],
      avatarZone: [],
      constructZone: [],
      magicZone: [],
      hell: [],
      darkDimension: [],
      isCritical: false,
      reactMagicBudget: { ownTurnRemaining: 0, opponentTurnRemaining: 0 },
      usedMagicTypesThisTurn: new Set()
    };

    const state: GameState = {
      id: 'game-1',
      mode: 'DUEL',
      playerOrder: ['p1', 'p2'],
      currentTurnPlayerIndex: 0,
      currentPhase: 'DRAW',
      turnNumber: 2, // Turn 2
      roundNumber: 1,
      players: { p1: player },
      landMagicZone: null,
      eventLog: []
    };

    const nextState = executeDrawPhase(state);
    const updatedP1 = nextState.players['p1'];

    expect(updatedP1.hand).toHaveLength(3); // Drew 2 cards to reach 3!
    expect(updatedP1.deck).toHaveLength(2);
  });

  it('Hand with 3 or more cards draws exactly 1 card', () => {
    const player: PlayerState = {
      id: 'p1',
      name: 'Player 1',
      seat: 0,
      deck: [createMockCard('D1'), createMockCard('D2')],
      hand: [createMockCard('H1'), createMockCard('H2'), createMockCard('H3'), createMockCard('H4')], // 4 cards in hand
      lifeDeck: [],
      avatarZone: [],
      constructZone: [],
      magicZone: [],
      hell: [],
      darkDimension: [],
      isCritical: false,
      reactMagicBudget: { ownTurnRemaining: 0, opponentTurnRemaining: 0 },
      usedMagicTypesThisTurn: new Set()
    };

    const state: GameState = {
      id: 'game-1',
      mode: 'DUEL',
      playerOrder: ['p1', 'p2'],
      currentTurnPlayerIndex: 0,
      currentPhase: 'DRAW',
      turnNumber: 2,
      roundNumber: 1,
      players: { p1: player },
      landMagicZone: null,
      eventLog: []
    };

    const nextState = executeDrawPhase(state);
    const updatedP1 = nextState.players['p1'];

    expect(updatedP1.hand).toHaveLength(5); // 4 + 1 = 5
    expect(updatedP1.deck).toHaveLength(1);
  });
});
