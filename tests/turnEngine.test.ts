import { describe, it, expect } from 'vitest';
import { executeDrawPhase, eliminatePlayer } from '../src/engine/turnEngine.js';
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

describe('eliminatePlayer', () => {
  const makePlayer = (id: string): PlayerState => ({
    id,
    name: id,
    seat: 0,
    deck: [createMockCard(`${id}-d`)],
    hand: [createMockCard(`${id}-h`)],
    lifeDeck: [createMockCard(`${id}-l`)],
    avatarZone: [createMockCard(`${id}-a`)],
    constructZone: [],
    magicZone: [],
    hell: [],
    darkDimension: [],
    isCritical: false,
    reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 },
    usedMagicTypesThisTurn: new Set()
  });

  const makeState = (currentTurnPlayerIndex: number): GameState => ({
    id: 'm',
    mode: 'AD_MUA',
    playerOrder: ['a', 'b', 'c'],
    currentTurnPlayerIndex,
    currentPhase: 'BATTLE',
    turnNumber: 4,
    roundNumber: 2,
    landMagicZone: null,
    players: { a: makePlayer('a'), b: makePlayer('b'), c: makePlayer('c') },
    eventLog: []
  });

  it('removes the player cards and closes the turn order', () => {
    const { state, winnerId } = eliminatePlayer(makeState(0), 'b');
    expect(state.playerOrder).toEqual(['a', 'c']);
    expect(state.players.b.hand).toHaveLength(0);
    expect(state.players.b.avatarZone).toHaveLength(0);
    expect(state.currentTurnPlayerIndex).toBe(0);
    expect(state.currentPhase).toBe('BATTLE');
    expect(winnerId).toBeNull();
  });

  it('keeps the same active player when an earlier seat is eliminated', () => {
    const { state } = eliminatePlayer(makeState(2), 'a');
    expect(state.playerOrder).toEqual(['b', 'c']);
    expect(state.playerOrder[state.currentTurnPlayerIndex]).toBe('c');
  });

  it('passes the turn to the next player when the active player is eliminated', () => {
    const { state } = eliminatePlayer(makeState(1), 'b');
    expect(state.playerOrder[state.currentTurnPlayerIndex]).toBe('c');
    expect(state.currentPhase).toBe('DRAW');
    expect(state.turnNumber).toBe(5);
  });

  it('wraps around when the last seat is eliminated on its own turn', () => {
    const { state } = eliminatePlayer(makeState(2), 'c');
    expect(state.playerOrder[state.currentTurnPlayerIndex]).toBe('a');
  });

  it('reports the last survivor as winner', () => {
    const first = eliminatePlayer(makeState(0), 'b').state;
    const { winnerId } = eliminatePlayer(first, 'c');
    expect(winnerId).toBe('a');
  });
});
