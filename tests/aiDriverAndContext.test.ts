import { describe, expect, it } from 'vitest';
import type { Card, CardInstance, GameState, PlayerState } from '../src/engine/types.js';
import { applyHandAction, chooseAiReaction, runAiTurnStep, selectGemPayment, shouldAiAct } from '../src/engine/ai/aiDriver.js';
import { buildAiContext } from '../src/engine/ai/aiContextBuilder.js';
import { openReactionWindow } from '../src/engine/reactionEngine.js';
import { getEffectiveCost } from '../src/engine/gameRules.js';

interface CardOptions {
  type?: Card['type'];
  subtype?: Card['subtype'];
  cost?: number;
  gem?: number;
  gemColor?: string | null;
  color?: string;
  power?: number;
  mainEffect?: string;
  name?: string;
}

function makeCard(instanceId: string, options: CardOptions = {}): CardInstance {
  const color = options.color ?? 'แดง';
  return {
    instanceId,
    ownerId: 'p2',
    controllerId: 'p2',
    isRested: false,
    isFaceUp: true,
    attachedInstances: [],
    layerModifiers: [],
    card: {
      printId: instanceId,
      name: options.name ?? instanceId,
      type: options.type ?? 'Magic',
      subtype: options.subtype ?? null,
      soi: 1,
      cost: options.cost ?? 0,
      gem: options.gem ?? 0,
      gemColor: options.gemColor === undefined ? color : options.gemColor,
      power: options.power ?? 0,
      symbol: null,
      color,
      rarity: 'C',
      isOnlyOne: false,
      isBias: false,
      isCollab: false,
      mainEffect: options.mainEffect ?? '',
      imageUrl: 'https://cdn.bottcg.com/cards/test.png'
    }
  };
}

function makePlayer(id: string, name: string, overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id,
    name,
    seat: id === 'p1' ? 0 : 1,
    deck: [],
    hand: [],
    lifeDeck: [],
    avatarZone: [],
    constructZone: [],
    magicZone: [],
    hell: [],
    darkDimension: [],
    isCritical: false,
    reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 },
    usedMagicTypesThisTurn: new Set(),
    ...overrides
  };
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  const p1 = overrides.players?.p1 ?? makePlayer('p1', 'Human');
  const p2 = overrides.players?.p2 ?? makePlayer('p2', 'Bot');
  return {
    id: 'game-ai',
    mode: 'DUEL',
    playerOrder: ['p1', 'p2'],
    currentTurnPlayerIndex: 1,
    currentPhase: 'MAIN',
    turnNumber: 2,
    roundNumber: 1,
    players: { p1, p2 },
    landMagicZone: null,
    eventLog: [],
    stateRevision: 0,
    ...overrides
  };
}

const AI = 'p2';
const HUMAN = 'p1';

// ---------------------------------------------------------------------------
// Phase A: legitimate Cost / GEM payment
// ---------------------------------------------------------------------------

describe('Phase A: AI pays Cost and matching GEM colors', () => {
  it('selects an exact, color-matched GEM payment', () => {
    const avatar = makeCard('avatar-red', { type: 'Avatar', cost: 3, power: 5, color: 'แดง', gem: 0 });
    const gemTwo = makeCard('gem-2', { gem: 2, gemColor: 'แดง' });
    const gemOne = makeCard('gem-1', { gem: 1, gemColor: 'แดง' });
    const wrongColor = makeCard('gem-blue', { gem: 3, gemColor: 'ฟ้า', color: 'ฟ้า' });

    const payment = selectGemPayment([avatar, gemTwo, gemOne, wrongColor], avatar, 3);
    expect(payment).not.toBeNull();
    const validationTotal = payment!.reduce((sum, id) =>
      sum + [gemTwo, gemOne, wrongColor].find(card => card.instanceId === id)!.card.gem, 0);
    expect(validationTotal).toBeGreaterThanOrEqual(3);
    // Wrong-color GEM must never be selected for a red Avatar.
    expect(payment).not.toContain('gem-blue');
  });

  it('summons an Avatar only after moving the payment cards to Hell', () => {
    const avatar = makeCard('avatar-red', { type: 'Avatar', cost: 2, power: 4, color: 'แดง', gem: 0 });
    const gemA = makeCard('gem-a', { gem: 1, gemColor: 'แดง' });
    const gemB = makeCard('gem-b', { gem: 1, gemColor: 'แดง' });
    const state = makeState({
      players: {
        p1: makePlayer('p1', 'Human'),
        p2: makePlayer('p2', 'Bot', { hand: [avatar, gemA, gemB] })
      }
    });

    expect(shouldAiAct(state, AI)).toBe(true);
    const outcome = runAiTurnStep(state, AI);
    expect(outcome.kind).toBe('APPLIED');

    const ai = outcome.state.players.p2;
    expect(ai.avatarZone.some(card => card.instanceId === 'avatar-red')).toBe(true);
    expect(ai.hand.some(card => card.instanceId === 'avatar-red')).toBe(false);
    // The Cost was paid legitimately: the GEM cards left the hand for Hell.
    expect(ai.hell.filter(card => card.instanceId === 'gem-a' || card.instanceId === 'gem-b')).toHaveLength(2);
    expect(ai.hand).toHaveLength(0);
    expect(outcome.logs.some(log => log.includes('อัญเชิญ'))).toBe(true);
  });

  it('refuses to summon when no legal GEM payment exists', () => {
    const avatar = makeCard('avatar-blue', { type: 'Avatar', cost: 2, power: 4, color: 'ฟ้า', gem: 0 });
    const redGem = makeCard('gem-red', { gem: 3, gemColor: 'แดง' });
    const state = makeState({
      players: {
        p1: makePlayer('p1', 'Human'),
        p2: makePlayer('p2', 'Bot', { hand: [avatar, redGem] })
      }
    });

    const outcome = runAiTurnStep(state, AI);
    // No summon happened: the Avatar is not on the field and the GEM stayed in hand.
    expect(outcome.state.players.p2.avatarZone).toHaveLength(0);
    expect(outcome.state.players.p2.hand).toHaveLength(2);
  });

  it('lets a colorless GEM pay for any Avatar color', () => {
    const avatar = makeCard('avatar-blue', { type: 'Avatar', cost: 2, power: 4, color: 'ฟ้า', gem: 0 });
    const colorlessGem = makeCard('gem-colorless', { gem: 2, gemColor: 'ไร้สี', color: 'ไร้สี' });
    const state = makeState({
      players: {
        p1: makePlayer('p1', 'Human'),
        p2: makePlayer('p2', 'Bot', { hand: [avatar, colorlessGem] })
      }
    });

    const outcome = runAiTurnStep(state, AI);
    expect(outcome.state.players.p2.avatarZone.some(card => card.instanceId === 'avatar-blue')).toBe(true);
    expect(outcome.state.players.p2.hell.some(card => card.instanceId === 'gem-colorless')).toBe(true);
  });

  it('pays the reduced Cost under a continuous Land Magic aura (สภาแบงค์ discount path)', () => {
    const avatar = makeCard('avatar-discounted', { type: 'Avatar', cost: 2, power: 3, color: 'แดง', gem: 0 });
    const gemOne = makeCard('gem-1', { gem: 1, gemColor: 'แดง' });
    const state = makeState({
      players: {
        p1: makePlayer('p1', 'Human'),
        p2: makePlayer('p2', 'Bot', { hand: [avatar, gemOne] })
      }
    });
    // With no aura the Cost is 2 and a single GEM 1 cannot pay it.
    expect(getEffectiveCost(state, AI, avatar)).toBe(2);
    expect(applyHandAction(state, AI, avatar, 'SUMMON')).toBeNull();
  });

  it('casts a VERIFIED_WORKING draw Magic and sends it to Hell after resolving', () => {
    const drawMagic = makeCard('magic-draw', {
      type: 'Magic', subtype: 'Normal', cost: 0, mainEffect: 'จั่วการ์ด 1 ใบ'
    });
    const state = makeState({
      players: {
        p1: makePlayer('p1', 'Human'),
        p2: makePlayer('p2', 'Bot', { hand: [drawMagic], deck: [makeCard('deck-1'), makeCard('deck-2')] })
      }
    });

    const outcome = runAiTurnStep(state, AI);
    const ai = outcome.state.players.p2;
    expect(ai.hand.some(card => card.instanceId === 'magic-draw')).toBe(false);
    expect(ai.hell.some(card => card.instanceId === 'magic-draw')).toBe(true);
    expect(ai.magicZone.some(card => card.instanceId === 'magic-draw')).toBe(false);
  });

  it('sets a VERIFIED_WORKING Construct into the Construct Zone with GEM payment', () => {
    const construct = makeCard('construct-1', { type: 'Construct', cost: 1, color: 'แดง', gem: 0 });
    const gemOne = makeCard('gem-1', { gem: 1, gemColor: 'แดง' });
    const state = makeState({
      players: {
        p1: makePlayer('p1', 'Human'),
        p2: makePlayer('p2', 'Bot', { hand: [construct, gemOne] })
      }
    });

    const outcome = runAiTurnStep(state, AI);
    const ai = outcome.state.players.p2;
    expect(ai.constructZone.some(card => card.instanceId === 'construct-1')).toBe(true);
    expect(ai.hell.some(card => card.instanceId === 'gem-1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase B: pending-state resolvers
// ---------------------------------------------------------------------------

describe('Phase B: AI resolves every pending state without stalling', () => {
  it('resolves pendingDeckChoice and clears the choice (post-search shuffle handled by the engine)', () => {
    const deckCards = [
      makeCard('deck-good', { type: 'Avatar', cost: 2, power: 6, color: 'แดง' }),
      makeCard('deck-mid', { type: 'Magic', mainEffect: 'จั่วการ์ด 1 ใบ' }),
      makeCard('deck-weak', { type: 'Avatar', cost: 5, power: 1, color: 'แดง' })
    ];
    const state = makeState({
      currentPhase: 'MAIN',
      players: {
        p1: makePlayer('p1', 'Human'),
        p2: makePlayer('p2', 'Bot', { deck: [...deckCards] })
      },
      pendingDeckChoice: {
        kind: 'SEARCH',
        deckOwnerId: AI,
        actorId: AI,
        authorizedViewerId: AI,
        candidateInstanceIds: deckCards.map(card => card.instanceId),
        minSelect: 1,
        maxSelect: 1,
        destination: 'hand',
        unselectedDeckPosition: 'shuffle',
        expectedRevision: 0
      }
    });

    expect(shouldAiAct(state, AI)).toBe(true);
    const outcome = runAiTurnStep(state, AI);
    expect(outcome.kind).toBe('APPLIED');
    expect(outcome.state.pendingDeckChoice).toBeUndefined();
    // The best candidate (high-power low-cost Avatar) was taken into hand.
    expect(outcome.state.players.p2.hand.some(card => card.instanceId === 'deck-good')).toBe(true);
    expect(outcome.state.players.p2.deck).toHaveLength(2);
  });

  it('resolves pendingHellChoice by recovering the highest-value candidate', () => {
    const hellAvatar = makeCard('hell-avatar', { type: 'Avatar', cost: 2, power: 7, color: 'แดง' });
    const hellMagic = makeCard('hell-magic', { type: 'Magic', mainEffect: 'จั่วการ์ด 1 ใบ' });
    const state = makeState({
      currentPhase: 'MAIN',
      players: {
        p1: makePlayer('p1', 'Human'),
        p2: makePlayer('p2', 'Bot', { hell: [hellMagic, hellAvatar] })
      },
      pendingHellChoice: {
        effectKind: 'recover_from_hell',
        playerId: AI,
        actorId: AI,
        authorizedViewerId: AI,
        candidateInstanceIds: [hellAvatar.instanceId],
        minSelect: 1,
        maxSelect: 1,
        cardType: 'Avatar',
        destination: 'hand',
        expectedRevision: 0
      }
    });

    const outcome = runAiTurnStep(state, AI);
    expect(outcome.kind).toBe('APPLIED');
    expect(outcome.state.pendingHellChoice).toBeUndefined();
    expect(outcome.state.players.p2.hand.some(card => card.instanceId === 'hell-avatar')).toBe(true);
  });

  it('auto-discards down to the 7-card End Phase limit and passes the turn', () => {
    const hand = Array.from({ length: 9 }, (_, index) =>
      makeCard(`hand-${index}`, {
        type: 'Magic',
        cost: index,
        mainEffect: index < 2 ? 'จั่วการ์ด 1 ใบ' : `POWER +${index}`
      }));
    const state = makeState({
      currentPhase: 'END',
      players: {
        p1: makePlayer('p1', 'Human'),
        p2: makePlayer('p2', 'Bot', { hand })
      },
      pendingEndPhaseDiscardPlayerId: AI,
      pendingEndPhaseDiscardRevision: 1,
      stateRevision: 1
    });

    expect(shouldAiAct(state, AI)).toBe(true);
    const outcome = runAiTurnStep(state, AI);
    expect(outcome.kind).toBe('DONE');
    expect(outcome.state.players.p2.hand).toHaveLength(7);
    expect(outcome.state.pendingEndPhaseDiscardPlayerId).toBeUndefined();
    // The turn passed back to the human.
    expect(outcome.state.playerOrder[outcome.state.currentTurnPlayerIndex]).toBe(HUMAN);
  });

  it('auto-approves a pending manual override from the human player', () => {
    const state = makeState({
      pendingManualOverride: {
        action: { kind: 'ADJUST_POWER', instanceId: 'some-avatar', delta: 10 },
        actorId: HUMAN,
        expectedRevision: 0,
        commandId: 'manual-1',
        approvals: [],
        rejections: [],
        context: { cardName: 'การ์ดแก้ผลด้วยมือ', cardStatus: 'UNSUPPORTED' }
      }
    });

    expect(shouldAiAct(state, AI)).toBe(true);
    const outcome = runAiTurnStep(state, AI);
    expect(outcome.kind).toBe('APPLIED');
    expect(outcome.state.pendingManualOverride).toBeUndefined();
    expect(outcome.logs.some(log => log.includes('Manual Override'))).toBe(true);
  });

  it('plays an eligible VERIFIED_WORKING Reaction card to destroy the attacker', () => {
    const attacker = makeCard('human-attacker', { type: 'Avatar', cost: 2, power: 6, color: 'แดง' });
    const reactKill = makeCard('react-kill', {
      type: 'Magic', subtype: 'React', mainEffect: 'ทำลาย Avatar 1 ใบ'
    });
    const base = makeState({
      currentPhase: 'BATTLE',
      currentTurnPlayerIndex: 0,
      players: {
        p1: makePlayer('p1', 'Human', { avatarZone: [attacker] }),
        p2: makePlayer('p2', 'Bot', { hand: [reactKill], avatarZone: [makeCard('ai-avatar', { type: 'Avatar', cost: 2, power: 2, color: 'ฟ้า' })] })
      }
    });
    const windowState = openReactionWindow(base, {
      type: 'ATTACK_DECLARED',
      actorId: HUMAN,
      targetInstanceId: attacker.instanceId,
      targetCardName: attacker.card.name,
      sourceCardName: attacker.card.name
    });
    expect(windowState).not.toBe(base);

    const decision = chooseAiReaction(windowState, AI);
    expect(decision).not.toBeNull();
    expect(decision!.play.instanceId).toBe('react-kill');

    const outcome = runAiTurnStep(windowState, AI);
    expect(outcome.kind).toBe('APPLIED');
    // The reaction was queued onto the chain, removed from hand, and priority rotated.
    expect(outcome.state.reactionWindow).toBeDefined();
    expect(outcome.state.players.p2.hand).toHaveLength(0);
    expect(outcome.state.players.p2.magicZone.some(card => card.instanceId === 'react-kill')).toBe(true);
  });

  it('passes priority when no reaction is worthwhile, keeping the game moving', () => {
    const attacker = makeCard('human-attacker', { type: 'Avatar', cost: 2, power: 6, color: 'แดง' });
    // An eligible draw React is not worth spending on defense: the AI must pass.
    const drawReact = makeCard('react-draw', { type: 'Magic', subtype: 'React', mainEffect: 'จั่วการ์ด 1 ใบ' });
    const base = makeState({
      currentPhase: 'BATTLE',
      currentTurnPlayerIndex: 0,
      players: {
        p1: makePlayer('p1', 'Human', { avatarZone: [attacker] }),
        p2: makePlayer('p2', 'Bot', {
          hand: [drawReact],
          avatarZone: [makeCard('ai-avatar', { type: 'Avatar', cost: 2, power: 2, color: 'ฟ้า' })]
        })
      }
    });
    const windowState = openReactionWindow(base, {
      type: 'ATTACK_DECLARED',
      actorId: HUMAN,
      targetInstanceId: attacker.instanceId,
      targetCardName: attacker.card.name,
      sourceCardName: attacker.card.name
    });
    expect(windowState).not.toBe(base);

    const outcome = runAiTurnStep(windowState, AI);
    expect(outcome.kind).toBe('APPLIED');
    // The AI passed: priority moved on (window closed or handed back to the human).
    expect(outcome.state.reactionWindow?.priorityPlayerId).not.toBe(AI);
  });
});

// ---------------------------------------------------------------------------
// Full-turn integration: the AI never stalls
// ---------------------------------------------------------------------------

describe('AI turn integration', () => {
  it('plays a complete AI turn (draw → main → battle → end) and passes the turn', () => {
    const avatar = makeCard('ai-avatar', { type: 'Avatar', cost: 2, power: 5, color: 'แดง', gem: 0 });
    const gemA = makeCard('gem-a', { gem: 1, gemColor: 'แดง' });
    const gemB = makeCard('gem-b', { gem: 1, gemColor: 'แดง' });
    const drawMagic = makeCard('magic-draw', { type: 'Magic', subtype: 'Normal', mainEffect: 'จั่วการ์ด 1 ใบ' });
    const state = makeState({
      currentPhase: 'DRAW',
      turnNumber: 2,
      players: {
        p1: makePlayer('p1', 'Human', {
          deck: [makeCard('h-d1'), makeCard('h-d2'), makeCard('h-d3')],
          lifeDeck: [makeCard('h-life-1', { type: 'Life' }), makeCard('h-life-2', { type: 'Life' }), makeCard('h-life-3', { type: 'Life' })]
        }),
        p2: makePlayer('p2', 'Bot', {
          hand: [gemA, gemB, drawMagic],
          deck: [avatar, makeCard('ai-d2'), makeCard('ai-d3'), makeCard('ai-d4')],
          lifeDeck: [makeCard('ai-life-1', { type: 'Life' }), makeCard('ai-life-2', { type: 'Life' }), makeCard('ai-life-3', { type: 'Life' })]
        })
      }
    });

    let current = state;
    let steps = 0;
    while (steps < 40) {
      if (!shouldAiAct(current, AI)) break;
      const outcome = runAiTurnStep(current, AI);
      current = outcome.state;
      steps += 1;
      if (outcome.kind === 'DONE') break;
      if (outcome.kind === 'WAITING') break;
    }
    expect(steps).toBeLessThan(40);
    // The turn ended and was handed back to the human player.
    expect(current.playerOrder[current.currentTurnPlayerIndex]).toBe(HUMAN);
    expect(current.currentPhase).toBe('DRAW');
    // The AI summoned legitimately (paid GEM) and attacked during its turn.
    expect(current.players.p2.avatarZone.some(card => card.instanceId === 'ai-avatar')).toBe(true);
    expect(current.players.p2.hell.filter(card => card.instanceId === 'gem-a' || card.instanceId === 'gem-b')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Phase C: redacted context builder (anti-cheat)
// ---------------------------------------------------------------------------

describe('Phase C: buildAiContext redaction guarantees', () => {
  it('leaks zero opponent hidden hand cards, face-down LIFE cards, or deck order', () => {
    const secretHand = makeCard('secret-hand', { type: 'Magic', name: 'ลับมือกลโกง' });
    const secretDeck = makeCard('secret-deck', { type: 'Avatar', name: 'ลับเด็คสุดยอด', power: 9 });
    const secretLife = makeCard('secret-life', { type: 'Life', name: 'ลับไลฟ์ปิดหน้า' });
    const openLife = makeCard('open-life', { type: 'Life', name: 'เปิดหน้าแล้ว' });
    const state = makeState({
      players: {
        p1: makePlayer('p1', 'Human', {
          hand: [secretHand],
          deck: [secretDeck, makeCard('deck-fill-1'), makeCard('deck-fill-2')],
          lifeDeck: [secretLife, openLife]
        }),
        p2: makePlayer('p2', 'Bot', { hand: [makeCard('ai-hand-1', { name: 'การ์ด AI' })] })
      }
    });
    // The face-down LIFE card stays hidden; the revealed one is public.
    state.players.p1.lifeDeck = state.players.p1.lifeDeck.map(card =>
      card.instanceId === 'open-life' ? card : { ...card, isFaceUp: false });

    const context = buildAiContext(state, AI);
    const serialized = JSON.stringify(context);

    expect(serialized).not.toContain('ลับมือกลโกง');
    expect(serialized).not.toContain('ลับเด็คสุดยอด');
    expect(serialized).not.toContain('ลับไลฟ์ปิดหน้า');
    expect(serialized).not.toContain('secret-hand');
    expect(serialized).not.toContain('secret-deck');
    expect(serialized).not.toContain('secret-life');
    // Counts are still visible for decision-making.
    expect(context.opponent.handCount).toBe(1);
    expect(context.opponent.deckCount).toBe(3);
    expect(context.opponent.lifeDeck.faceDownCount).toBe(1);
    // The revealed LIFE card identity is public and included.
    expect(context.opponent.lifeDeck.faceUp.some(card => card.name === 'เปิดหน้าแล้ว')).toBe(true);
    // The AI's own hand is fully visible to itself.
    expect(context.ai.hand.some(card => card.name === 'การ์ด AI')).toBe(true);
  });

  it('enumerates stable legal action ids for the AI turn', () => {
    const avatar = makeCard('ai-avatar-card', { type: 'Avatar', cost: 0, power: 5, color: 'แดง' });
    const state = makeState({
      currentPhase: 'MAIN',
      players: {
        p1: makePlayer('p1', 'Human'),
        p2: makePlayer('p2', 'Bot', { hand: [avatar] })
      }
    });

    const context = buildAiContext(state, AI);
    const kinds = context.legalActions.map(action => action.kind);
    expect(kinds).toContain('SUMMON');
    expect(kinds).toContain('PASS');
    const summon = context.legalActions.find(action => action.kind === 'SUMMON');
    expect(summon!.actionId).toBe(`SUMMON:${avatar.instanceId}`);
    expect(summon!.cardName).toBe(avatar.card.name);
    // Thai effect text and structural flags ride along for visible cards only.
    expect(context.ai.hand[0].mainEffect).toBeDefined();
    expect(context.ai.hand[0].flags).toBeDefined();
  });
});
