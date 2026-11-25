import { describe, it, expect } from 'vitest';
import { resolveAvatarCombat, attackLifeZone } from '../src/engine/combatEngine.js';
import { CardInstance, PlayerState } from '../src/engine/types.js';

function createMockAvatar(id: string, name: string, power: number, effect = ''): CardInstance {
  return {
    instanceId: id,
    ownerId: 'p1',
    controllerId: 'p1',
    isRested: false,
    isFaceUp: true,
    attachedInstances: [],
    layerModifiers: [],
    card: {
      printId: id,
      name,
      type: 'Avatar',
      power,
      cost: 2,
      gem: 1,
      color: 'แดง',
      rarity: 'C',
      isOnlyOne: false,
      isBias: false,
      isCollab: false,
      mainEffect: effect,
      imageUrl: 'https://cdn.bottcg.com/cards/test.png'
    }
  };
}

describe('Combat Engine (Rule Book 3.2 pp. 22-25)', () => {
  it('destroys the weaker Avatar', () => {
    const attacker = createMockAvatar('A1', 'Attacker', 4);
    const defender = createMockAvatar('D1', 'Defender', 2);

    const result = resolveAvatarCombat(attacker, defender);
    expect(result.winner).toBe('ATTACKER');
    expect(result.attackerDestroyed).toBe(false);
    expect(result.defenderDestroyed).toBe(true);
  });

  it('destroys both Avatars on equal POWER', () => {
    const attacker = createMockAvatar('A1', 'Attacker', 3);
    const defender = createMockAvatar('D1', 'Defender', 3);

    const result = resolveAvatarCombat(attacker, defender);
    expect(result.winner).toBe('TIE');
    expect(result.attackerDestroyed).toBe(true);
    expect(result.defenderDestroyed).toBe(true);
  });

  it('handles Grit (ลูกฮึด) break-tie mechanic correctly', () => {
    const attackerWithGrit = createMockAvatar('A1', 'Grit Attacker', 3, 'ลูกฮึด');
    const normalDefender = createMockAvatar('D1', 'Normal Defender', 3);

    const result = resolveAvatarCombat(attackerWithGrit, normalDefender);
    expect(result.winner).toBe('ATTACKER');
    expect(result.attackerDestroyed).toBe(false);
    expect(result.defenderDestroyed).toBe(true);
  });

  it('0 POWER vs 0 POWER does nothing', () => {
    const a = createMockAvatar('A1', 'Zero A', 0);
    const b = createMockAvatar('B1', 'Zero B', 0);

    const result = resolveAvatarCombat(a, b);
    expect(result.winner).toBe('NO_OP');
    expect(result.attackerDestroyed).toBe(false);
    expect(result.defenderDestroyed).toBe(false);
  });

  it('0 POWER attacker deals NO damage to LIFE Zone', () => {
    const attacker = createMockAvatar('A1', 'Weakling', 0);
    const defender: PlayerState = {
      id: 'p2',
      name: 'Player 2',
      seat: 1,
      deck: [],
      hand: [],
      lifeDeck: [createMockAvatar('L1', 'Life 1', 0), createMockAvatar('L2', 'Life 2', 0)],
      avatarZone: [],
      constructZone: [],
      magicZone: [],
      hell: [],
      darkDimension: [],
      isCritical: false,
      reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 },
      usedMagicTypesThisTurn: new Set()
    };
    defender.lifeDeck.forEach(c => c.isFaceUp = false);

    const res = attackLifeZone(attacker, defender);
    expect(res.damageDealt).toBe(false);
    expect(defender.lifeDeck[0].isFaceUp).toBe(false); // Undamaged
  });

  it('deals damage and transitions player to Critical State (สถานะสาหัส) on final LIFE reveal', () => {
    const attacker = createMockAvatar('A1', 'Strong', 5);
    const defender: PlayerState = {
      id: 'p2',
      name: 'Player 2',
      seat: 1,
      deck: [],
      hand: [],
      lifeDeck: [
        { ...createMockAvatar('L1', 'Life 1', 0), isFaceUp: true },
        { ...createMockAvatar('L2', 'Life 2', 0), isFaceUp: true },
        { ...createMockAvatar('L3', 'Life 3', 0), isFaceUp: true },
        { ...createMockAvatar('L4', 'Life 4', 0), isFaceUp: true },
        { ...createMockAvatar('L5', 'Life 5', 0), isFaceUp: false } // Only last 1 left!
      ],
      avatarZone: [],
      constructZone: [],
      magicZone: [],
      hell: [],
      darkDimension: [],
      isCritical: false,
      reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 },
      usedMagicTypesThisTurn: new Set()
    };

    const res = attackLifeZone(attacker, defender);
    expect(res.damageDealt).toBe(true);
    expect(res.isGameOver).toBe(false);
    expect(defender.lifeDeck[4].isFaceUp).toBe(true);
    expect(defender.isCritical).toBe(true); // Now Critical State!

    // Next attack while in Critical State should end the game
    const lethalRes = attackLifeZone(attacker, defender);
    expect(lethalRes.isGameOver).toBe(true);
  });
});
