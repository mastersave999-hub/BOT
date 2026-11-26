import { describe, expect, it } from 'vitest';
import {
  decodeNetMessage,
  encodeNetMessage,
  isReactionCommandCurrent,
  isExitPreventionCommandCurrent,
  isGameStateValidForSync,
  isLegalGameStateSync,
  redactLifeCardsForViewer,
  redactLifeCardsInSetup,
  restoreHiddenZonesFromCanonical,
  restoreOwnLifeCardsFromSetup,
  type PlayerSetup
} from '../src/engine/multiplayer.js';
import type { Card, CardInstance, GameState, PlayerState } from '../src/engine/types.js';
import { passReactionPriority } from '../src/engine/reactionEngine.js';

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
    originalOwnerId: ownerId,
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
  it('requires the outgoing player to discard exactly to seven before ending their turn', () => {
    const previous = makeState();
    previous.currentPhase = 'END';
    previous.players['player-1'].hand = Array.from({ length: 9 }, (_, index) => ({
      ...makeLifeInstance('player-1', index), instanceId: `hand-${index}`, card: { ...makeCard(`Hand ${index}`, `hand-${index}`), type: 'Magic' }
    }));
    const incoming = structuredClone(previous);
    incoming.players['player-1'].hand = incoming.players['player-1'].hand.slice(0, 7);
    incoming.players['player-1'].hell = [previous.players['player-1'].hand[7], previous.players['player-1'].hand[8]];
    incoming.currentTurnPlayerIndex = 1;
    incoming.currentPhase = 'DRAW';
    incoming.turnNumber = 2;
    expect(isLegalGameStateSync(previous, incoming, 'player-1')).toBe(true);
    expect(isLegalGameStateSync(previous, incoming, 'player-2')).toBe(false);
    const invalid = structuredClone(incoming);
    invalid.players['player-1'].hell = [];
    expect(isLegalGameStateSync(previous, invalid, 'player-1')).toBe(false);
    const firstTurn = makeState();
    firstTurn.currentPhase = 'MAIN';
    firstTurn.turnNumber = 1;
    const battle = structuredClone(firstTurn);
    battle.currentPhase = 'BATTLE';
    expect(isLegalGameStateSync(firstTurn, battle, 'player-1')).toBe(false);
  });
  it('rejects incoming state with invalid Construct capacity and duplicate names', () => {
    const valid = makeState();
    expect(isGameStateValidForSync(valid)).toBe(true);
    const invalid = makeState();
    invalid.players['player-1'].constructZone = Array.from({ length: 4 }, (_, index) => ({
      ...makeLifeInstance('player-1', index),
      instanceId: `construct-${index}`,
      card: { ...makeCard(`Construct ${index}`, `construct-${index}`), type: 'Construct' }
    }));
    expect(isGameStateValidForSync(invalid)).toBe(false);
    invalid.players['player-1'].constructZone = [
      { ...invalid.players['player-1'].constructZone[0], instanceId: 'c1', card: { ...invalid.players['player-1'].constructZone[0].card, name: 'Duplicate' } },
      { ...invalid.players['player-1'].constructZone[1], instanceId: 'c2', card: { ...invalid.players['player-1'].constructZone[1].card, name: 'Duplicate' } }
    ];
    expect(isGameStateValidForSync(invalid)).toBe(false);
  });
  it('round-trips a controlled borrowed Avatar without changing its original owner', () => {
    const state = makeState();
    const borrowed = {
      ...makeLifeInstance('player-1', 4),
      instanceId: 'borrowed-avatar',
      originalOwnerId: 'player-1',
      controllerId: 'player-2',
      card: { ...makeCard('Borrowed Avatar', 'borrowed-avatar'), type: 'Avatar' as const }
    };
    state.players['player-2'].avatarZone = [borrowed];

    expect(isGameStateValidForSync(state)).toBe(true);
    const received = decodeNetMessage(encodeNetMessage({ type: 'SYNC', state, winner: null }));
    expect(received?.type).toBe('SYNC');
    if (received?.type !== 'SYNC') return;
    expect(received.state.players['player-2'].avatarZone[0]).toMatchObject({
      ownerId: 'player-1', originalOwnerId: 'player-1', controllerId: 'player-2'
    });
  });

  it('redacts face-down LIFE identity for opponents but preserves revealed cards', () => {
    const state = makeState();
    state.players['player-2'].hand = [makeLifeInstance('player-2', 2, true)];
    state.players['player-2'].deck = [makeLifeInstance('player-2', 3)];
    const view = redactLifeCardsForViewer(state, 'player-1');
    const opponentLife = view.players['player-2'].lifeDeck;

    expect(view.players['player-1'].lifeDeck[0].card.name).toBe('LIFE player-1 0');
    expect(view.players['player-2'].hand[0].card.name).toBe('Hidden card');
    expect(view.players['player-2'].deck[0].card.name).toBe('Hidden card');
    expect(opponentLife[0].card.name).toBe('Face-down LIFE');
    expect(opponentLife[0].instanceId).toBe('player-2-life-instance-0');
    expect(opponentLife[1].card.name).toBe('LIFE player-2 1');
    expect(JSON.stringify(view)).not.toContain('LIFE player-2 0');
  });

  it('sends identical Reaction Window priority and pending action state to both clients', () => {
    const state = makeState();
    const sourceCard = makeLifeInstance('player-1', 0);
    state.reactionWindow = {
      id: 'game:2:5:AVATAR_SUMMONED',
      trigger: {
        type: 'AVATAR_SUMMONED',
        actorId: 'player-1',
        targetInstanceId: 'avatar-1',
        targetCardName: 'Ghui'
      },
      turnOwnerId: 'player-1',
      priorityPlayerId: 'player-2',
      passedPlayerIds: [],
      pendingAction: { type: 'SUMMON_JUTI', actorId: 'player-1', sourceCard, paidCost: true }
    };
    state.players['player-2'].usedMagicTypesThisTurn.add('React');

    const receivedByPeer = decodeNetMessage(encodeNetMessage({ type: 'SYNC', state, winner: null }));
    expect(receivedByPeer?.type).toBe('SYNC');
    if (receivedByPeer?.type !== 'SYNC') return;
    expect(receivedByPeer.state.reactionWindow).toEqual(state.reactionWindow);
    expect(receivedByPeer.state.players['player-2'].usedMagicTypesThisTurn).toBeInstanceOf(Set);
  });

  it('restores canonical hidden identities after accepting a guest state projection', () => {
    const canonical = makeState();
    canonical.players['player-2'].hand = [makeLifeInstance('player-2', 2, true)];
    canonical.players['player-2'].deck = [makeLifeInstance('player-2', 3)];
    const guestProjection = redactLifeCardsForViewer(canonical, 'player-1');
    const restored = restoreHiddenZonesFromCanonical(guestProjection, canonical, 'player-1');

    expect(restored.players['player-2'].hand[0].card.name).toBe('LIFE player-2 2');
    expect(restored.players['player-2'].deck[0].card.name).toBe('LIFE player-2 3');
    expect(restored.players['player-2'].lifeDeck[0].card.name).toBe('LIFE player-2 0');
  });

  it('authenticates reaction commands against the peer identity and exact window revision', () => {
    const state = makeState();
    state.reactionWindow = {
      id: 'window-1',
      trigger: { type: 'ATTACK_DECLARED', actorId: 'player-1' },
      turnOwnerId: 'player-1',
      priorityPlayerId: 'player-2',
      passedPlayerIds: [],
      revision: 4,
      chain: []
    };
    const command = { kind: 'PASS' as const, playerId: 'player-2', windowId: 'window-1', expectedRevision: 4 };

    expect(isReactionCommandCurrent(state, command, 'player-2')).toBe(true);
    expect(isReactionCommandCurrent(state, command, 'player-1')).toBe(false);
    expect(isReactionCommandCurrent(state, { ...command, expectedRevision: 3 }, 'player-2')).toBe(false);
    expect(isReactionCommandCurrent(state, { ...command, windowId: 'stale-window' }, 'player-2')).toBe(false);
    expect(isReactionCommandCurrent(state, { ...command, playerId: 'player-1' }, 'player-2')).toBe(false);
    expect(decodeNetMessage(JSON.stringify({ type: 'REACTION_COMMAND', command }))?.type).toBe('REACTION_COMMAND');
    expect(decodeNetMessage(JSON.stringify({ type: 'REACTION_COMMAND', command: { ...command, expectedRevision: undefined } }))).toBeNull();
    expect(decodeNetMessage(JSON.stringify({ type: 'REACTION_COMMAND', command: { ...command, kind: 'EXECUTE' } }))).toBeNull();
    expect(decodeNetMessage(JSON.stringify({ type: 'UNKNOWN' }))).toBeNull();
  });

  it('rejects a duplicate serialized pass after the window revision advances', () => {
    const state = makeState();
    state.reactionWindow = {
      id: 'window-duplicate',
      trigger: { type: 'ATTACK_DECLARED', actorId: 'player-1' },
      turnOwnerId: 'player-1',
      priorityPlayerId: 'player-2',
      passedPlayerIds: [],
      revision: 4,
      chain: []
    };
    const serialized = encodeNetMessage({
      type: 'REACTION_COMMAND',
      command: { kind: 'PASS', playerId: 'player-2', windowId: 'window-duplicate', expectedRevision: 4 }
    });
    const received = decodeNetMessage(serialized);
    expect(received?.type).toBe('REACTION_COMMAND');
    if (received?.type !== 'REACTION_COMMAND') return;
    expect(isReactionCommandCurrent(state, received.command, 'player-2')).toBe(true);

    const accepted = passReactionPriority(state, 'player-2');
    expect(accepted.ok).toBe(true);
    if (!accepted.ok || !accepted.state.reactionWindow) return;
    expect(accepted.state.reactionWindow.revision).toBe(5);
    expect(isReactionCommandCurrent(accepted.state, received.command, 'player-2')).toBe(false);
  });

  it('syncs exit-prevention commands only for the authorized player at the exact pending revision', () => {
    const state = makeState();
    state.stateRevision = 7;
    const target = {
      ...makeLifeInstance('player-1', 4),
      instanceId: 'exit-avatar',
      card: { ...makeCard('Exit Avatar', 'exit-avatar'), type: 'Avatar' as const },
      preventionShields: [{ id: 'activated-shield', kind: 'DESTRUCTION' as const, mode: 'ACTIVATED' as const }]
    };
    state.players['player-1'].avatarZone = [target];
    state.pendingExitPrevention = {
      targetCardId: target.instanceId,
      destination: 'hell',
      actorId: 'player-2',
      preventionPlayerId: 'player-1',
      cause: 'EFFECT',
      expectedRevision: 7,
      usedActivatedPrevention: false
    };
    const useCommand = {
      kind: 'USE_EXIT_PREVENTION' as const,
      playerId: 'player-1',
      commandId: 'use-exit-1',
      expectedRevision: 7,
      sourceCardId: 'activated-shield'
    };
    const declineCommand = {
      kind: 'DECLINE_EXIT_PREVENTION' as const,
      playerId: 'player-1',
      commandId: 'decline-exit-1',
      expectedRevision: 7
    };
    for (const command of [useCommand, declineCommand]) {
      const decoded = decodeNetMessage(encodeNetMessage({ type: 'EXIT_PREVENTION_COMMAND', command }));
      expect(decoded?.type).toBe('EXIT_PREVENTION_COMMAND');
      expect(isExitPreventionCommandCurrent(state, command, 'player-1')).toBe(true);
      expect(isExitPreventionCommandCurrent(state, command, 'player-2')).toBe(false);
      expect(isExitPreventionCommandCurrent(state, { ...command, expectedRevision: 6 }, 'player-1')).toBe(false);
      expect(isExitPreventionCommandCurrent({ ...state, stateRevision: 8 }, command, 'player-1')).toBe(false);
    }
    expect(decodeNetMessage(JSON.stringify({
      type: 'EXIT_PREVENTION_COMMAND',
      command: { ...useCommand, expectedRevision: undefined }
    }))).toBeNull();
    state.processedCommandIds = ['use-exit-1'];
    expect(isExitPreventionCommandCurrent(state, useCommand, 'player-1')).toBe(false);
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
