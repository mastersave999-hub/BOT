import { describe, expect, it } from 'vitest';
import {
  redactLifeCardsForViewer,
  redactLifeCardsInSetup,
  restoreOwnLifeCardsFromSetup,
  type PlayerSetup
} from '../src/engine/multiplayer.js';
import type { Card, CardInstance, GameState, PlayerState } from '../src/engine/types.js';

function makeCard(name: string, printId: string): Card {
  return {
    printId,
    name,
    type: 'Life',
    cost: 0,
    gem: 0,
    power: 0,
    color: 'ไร้สี',
    rarity: 'C',
    mainEffect: '',
    isOnlyOne: false,
    isBias: false,
    isCollab: false,
    imageUrl: `https://example.test/${printId}.png`
  };
}

function makeLifeInstance(ownerId: string, index: number, faceUp = false): CardInstance {
  const card = makeCard(`LIFE ${ownerId} ${index}`, `${ownerId}-life-${index}`);
  return {
    instanceId: `${ownerId}-life-instance-${index}`,
    ownerId,
    controllerId: ownerId,
    isRested: false,
    isFaceUp: faceUp,
    attachedInstances: [],
    layerModifiers: [],
    card
  };
}

function makePlayer(id: string, lifeDeck: CardInstance[]): PlayerState {
  return {
    id,
    name: id,
    seat: id === 'player-1' ? 0 : 1,
    deck: [],
    hand: [],
    lifeDeck,
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

function makeState(): GameState {
  return {
    id: 'game',
    mode: 'DUEL',
    playerOrder: ['player-1', 'player-2'],
    currentTurnPlayerIndex: 0,
    currentPhase: 'DRAW',
    turnNumber: 1,
    roundNumber: 1,
    players: {
      'player-1': makePlayer('player-1', [makeLifeInstance('player-1', 0)]),
      'player-2': makePlayer('player-2', [
        makeLifeInstance('player-2', 0),
        makeLifeInstance('player-2', 1, true)
      ])
    },
    landMagicZone: null,
    eventLog: []
  };
}

describe('multiplayer LIFE card privacy', () => {
  it('redacts face-down LIFE identity for opponents but preserves revealed cards', () => {
    const state = makeState();
    const view = redactLifeCardsForViewer(state, 'player-1');
    const opponentLife = view.players['player-2'].lifeDeck;

    expect(view.players['player-1'].lifeDeck[0].card.name).toBe('LIFE player-1 0');
    expect(opponentLife[0].card.name).toBe('Face-down LIFE');
    expect(opponentLife[0].instanceId).toBe('player-2-life-instance-0');
    expect(opponentLife[1].card.name).toBe('LIFE player-2 1');
    expect(JSON.stringify(view)).not.toContain('LIFE player-2 0');
  });

  it('redacts setup LIFE cards before peer transmission and restores the owner copy', () => {
    const lifeDeck = Array.from({ length: 5 }, (_, index) => makeCard(`LIFE ${index}`, `print-${index}`));
    const setup: PlayerSetup = { name: 'Guest', mainDeck: [], lifeDeck };
    const transmittedSetup = redactLifeCardsInSetup(setup);

    expect(transmittedSetup.lifeDeck).toHaveLength(5);
    expect(transmittedSetup.lifeDeck.every(card => card.name === 'Face-down LIFE')).toBe(true);

    const state = makeState();
    state.players['player-2'].lifeDeck = lifeDeck.map((card, index) => ({
      ...makeLifeInstance('player-2', index),
      card: transmittedSetup.lifeDeck[index]
    }));
    const restored = restoreOwnLifeCardsFromSetup(state, setup, 'player-2');

    expect(restored.players['player-2'].lifeDeck.map(card => card.card.printId)).toEqual(
      lifeDeck.map(card => card.printId)
    );
  });
});
