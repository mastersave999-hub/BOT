import { describe, it, expect } from 'vitest';
import { executeDrawPhase, mainPhaseAdvanceLabel, nextPhaseAfterMain } from '../src/engine/turnEngine.js';
import { validateDeck } from '../src/engine/deckValidator.js';
import { validateAvatarZone } from '../src/engine/gameRules.js';
import { deriveLegalHandActions } from '../src/engine/legalActions.js';
import { createLocalMatchState, type LocalMatchSide } from '../src/engine/localMatch.js';
import { GameState, PlayerState, CardInstance, Card } from '../src/engine/types.js';
import starterDeckData from '../src/engine/starterDeck.json';

const starterMain = starterDeckData.mainDeck as Card[];
const starterLife = starterDeckData.lifeDeck as Card[];

function side(name: string, hideHand = false): LocalMatchSide {
  return { name, mainDeck: starterMain, lifeDeck: starterLife, hideHand };
}

function buildMatch(): GameState {
  return createLocalMatchState('DUEL', [side('You'), side('AI', true)]);
}

function zoneInstances(player: PlayerState): CardInstance[] {
  return [
    ...player.deck,
    ...player.hand,
    ...player.lifeDeck,
    ...player.avatarZone,
    ...player.constructZone,
    ...player.magicZone,
    ...player.hell,
    ...player.darkDimension
  ];
}

function expectConservedZones(player: PlayerState): void {
  const instances = zoneInstances(player);
  const ids = instances.map(card => card.instanceId);
  expect(new Set(ids).size).toBe(ids.length);
  // Rule Book 3.2: Main Deck 50 + LIFE Deck 5 = 55 instances per player, each in exactly one zone.
  expect(instances.length).toBe(55);
}

describe('Match initialization (Rule Book 3.2 Game Set up)', () => {
  it('ships a legal official starter deck: 50 non-Life main cards and 5 unique LIFE cards', () => {
    const result = validateDeck(starterMain, starterLife);
    expect(result.errors).toEqual([]);
    expect(result.isValid).toBe(true);
  });

  it('starts both human and AI players with empty field zones and 5/5/45 distribution', () => {
    const state = buildMatch();
    for (const playerId of ['player-1', 'player-2']) {
      const player = state.players[playerId];
      expect(player.avatarZone).toEqual([]);
      expect(player.magicZone).toEqual([]);
      expect(player.constructZone).toEqual([]);
      expect(state.landMagicZone).toBeNull();
      expect(player.hell).toEqual([]);
      expect(player.darkDimension).toEqual([]);
      expect(player.lifeDeck).toHaveLength(5);
      expect(player.lifeDeck.every(card => !card.isFaceUp)).toBe(true);
      expect(player.lifeDeck.every(card => card.card.type === 'Life')).toBe(true);
      expect(player.hand).toHaveLength(5);
      expect(player.deck).toHaveLength(45);
      expect(player.deck.every(card => card.card.type !== 'Life')).toBe(true);
      expectConservedZones(player);
    }
  });

  it('never pre-spawns an Avatar on either field', () => {
    const state = buildMatch();
    for (const player of Object.values(state.players)) {
      expect(player.avatarZone.some(card => card.card.type === 'Avatar')).toBe(false);
      expect(player.avatarZone.some(card => card.card.type === 'Token')).toBe(false);
    }
  });
});

describe('Draw behavior (Rule Book 3.2 Draw Phase p.22)', () => {
  it('Turn 1 draw moves only deck cards to hand, never touches LIFE, and transitions to MAIN', () => {
    const state = buildMatch();
    const before = state.players['player-1'];
    const beforeIds = new Set(zoneInstances(before).map(card => card.instanceId));

    const after = executeDrawPhase(state).players['player-1'];

    // First player's very first turn draws 2 (Rule Book 3.2 p.22 rule 2).
    expect(after.hand).toHaveLength(7);
    expect(after.deck).toHaveLength(43);
    expect(after.lifeDeck).toHaveLength(5);
    expect(after.lifeDeck.every(card => card.card.type === 'Life')).toBe(true);
    // No duplicate movement: every instance still exists exactly once.
    const afterIds = zoneInstances(after).map(card => card.instanceId);
    expect(new Set(afterIds).size).toBe(afterIds.length);
    expect(new Set(afterIds)).toEqual(beforeIds);
    expect(after.hand.every(card => card.card.type !== 'Life')).toBe(true);
  });

  it('a regular turn draw moves exactly one card from deck to hand', () => {
    const state = buildMatch();
    const turnTwo: GameState = {
      ...state,
      turnNumber: 2,
      currentTurnPlayerIndex: 1,
      currentPhase: 'DRAW'
    };
    const after = executeDrawPhase(turnTwo).players['player-2'];
    expect(after.hand).toHaveLength(6);
    expect(after.deck).toHaveLength(44);
    expect(after.lifeDeck).toHaveLength(5);
  });

  it('keeps LIFE at exactly 5 cards through the Draw Phase and reaches MAIN', () => {
    const state = buildMatch();
    const next = executeDrawPhase(state);
    expect(next.players['player-1'].lifeDeck).toHaveLength(5);
    expect(next.players['player-2'].lifeDeck).toHaveLength(5);
    expect(next.currentPhase).toBe('MAIN');
  });
});

describe('Avatar Zone limits (Rule Book 3.2 Board Area 1: Avatars max 4, total with Tokens max 6)', () => {
  function avatarInstance(id: string): CardInstance {
    return {
      instanceId: id,
      ownerId: 'p1',
      controllerId: 'p1',
      isRested: false,
      isFaceUp: true,
      attachedInstances: [],
      layerModifiers: [],
      card: { printId: id, name: `Avatar ${id}`, type: 'Avatar', power: 1, cost: 1, gem: 0, color: 'แดง', rarity: 'C', isOnlyOne: false, isBias: false, isCollab: false, mainEffect: '', imageUrl: '' }
    };
  }

  function tokenInstance(id: string): CardInstance {
    return {
      ...avatarInstance(id),
      card: { ...avatarInstance(id).card, type: 'Token', name: `Token ${id}` }
    };
  }

  it('accepts 4 Avatars plus 2 Tokens (6 total) and rejects a 5th Avatar', () => {
    const fourAvatarsTwoTokens = [
      avatarInstance('a1'), avatarInstance('a2'), avatarInstance('a3'), avatarInstance('a4'),
      tokenInstance('t1'), tokenInstance('t2')
    ];
    expect(validateAvatarZone({ avatarZone: fourAvatarsTwoTokens })).toBeNull();

    const fiveAvatars = [...fourAvatarsTwoTokens.slice(0, 4), avatarInstance('a5'), tokenInstance('t1')];
    expect(validateAvatarZone({ avatarZone: fiveAvatars })).toBe('Avatar Zone limit is 4 Avatars');
  });

  it('counts Tokens toward the 6-card total capacity', () => {
    const fourAvatarsThreeTokens = [
      avatarInstance('a1'), avatarInstance('a2'), avatarInstance('a3'), avatarInstance('a4'),
      tokenInstance('t1'), tokenInstance('t2'), tokenInstance('t3')
    ];
    expect(validateAvatarZone({ avatarZone: fourAvatarsThreeTokens })).toBe('Avatar Zone limit is 6 total Avatars and Tokens');

    const twoAvatarsFourTokens = [
      avatarInstance('a1'), avatarInstance('a2'),
      tokenInstance('t1'), tokenInstance('t2'), tokenInstance('t3'), tokenInstance('t4')
    ];
    expect(validateAvatarZone({ avatarZone: twoAvatarsFourTokens })).toBeNull();
  });

  it('the UI action layer offers SUMMON only when the engine would accept it', () => {
    const basePlayer: PlayerState = {
      id: 'p1', name: 'P1', seat: 0,
      deck: [], hand: [], lifeDeck: [], constructZone: [], magicZone: [], hell: [], darkDimension: [],
      isCritical: false,
      reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 },
      usedMagicTypesThisTurn: new Set()
    };
    const handAvatar = avatarInstance('hand-avatar');
    const stateAt = (avatarZone: CardInstance[]): GameState => ({
      id: 'limits', mode: 'DUEL', playerOrder: ['p1', 'p2'], currentTurnPlayerIndex: 0,
      currentPhase: 'MAIN', turnNumber: 1, roundNumber: 1, landMagicZone: null, eventLog: [],
      players: { p1: { ...basePlayer, hand: [handAvatar], avatarZone }, p2: { ...basePlayer, id: 'p2', seat: 1 } }
    });

    // 3 Avatars + 2 Tokens = 5 total: a legal summon within both limits.
    const legal = stateAt([avatarInstance('a1'), avatarInstance('a2'), avatarInstance('a3'), tokenInstance('t1'), tokenInstance('t2')]);
    expect(deriveLegalHandActions(legal, 'p1', handAvatar).map(action => action.kind)).toContain('SUMMON');

    // 4 Avatars + 2 Tokens = 6 total: a new Avatar would break the 4-Avatar limit.
    const avatarCapped = stateAt([avatarInstance('a1'), avatarInstance('a2'), avatarInstance('a3'), avatarInstance('a4'), tokenInstance('t1'), tokenInstance('t2')]);
    expect(deriveLegalHandActions(avatarCapped, 'p1', handAvatar)).toEqual([]);

    // 2 Avatars + 4 Tokens = 6 total: a new Avatar would break the 6-card total.
    const totalCapped = stateAt([avatarInstance('a1'), avatarInstance('a2'), tokenInstance('t1'), tokenInstance('t2'), tokenInstance('t3'), tokenInstance('t4')]);
    expect(deriveLegalHandActions(totalCapped, 'p1', handAvatar)).toEqual([]);
  });
});

describe('Turn 1 phase label', () => {
  it('matches the transition the engine performs for the first player on Turn 1', () => {
    const state = buildMatch();
    const mainState: GameState = { ...state, currentPhase: 'MAIN' };
    expect(nextPhaseAfterMain(mainState, 'player-1')).toBe('END');
    expect(mainPhaseAdvanceLabel(mainState, 'player-1')).toBe('จบ Main → End Phase');
    expect(nextPhaseAfterMain(mainState, 'player-2')).toBe('BATTLE');
    expect(mainPhaseAdvanceLabel(mainState, 'player-2')).toBe('เข้า Battle Phase');
    const laterTurn: GameState = { ...mainState, turnNumber: 2 };
    expect(mainPhaseAdvanceLabel(laterTurn, 'player-1')).toBe('เข้า Battle Phase');
  });
});
