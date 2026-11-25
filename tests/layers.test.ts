import { describe, it, expect } from 'vitest';
import { calculateNetPower } from '../src/engine/layers.js';
import { CardInstance } from '../src/engine/types.js';

function createDummyInstance(id: string, basePower: number): CardInstance {
  return {
    instanceId: id,
    ownerId: 'player-1',
    controllerId: 'player-1',
    isRested: false,
    isFaceUp: true,
    attachedInstances: [],
    layerModifiers: [],
    card: {
      printId: id,
      name: 'Test Avatar',
      type: 'Avatar',
      power: basePower,
      cost: 4,
      gem: 2,
      color: 'แดง',
      rarity: 'R',
      isOnlyOne: false,
      isBias: false,
      isCollab: false,
      mainEffect: '',
      imageUrl: 'https://cdn.bottcg.com/cards/test.png'
    }
  };
}

describe('Effect Layers 0-4 (Official Rule Book 3.2 pp. 15-16)', () => {
  it('calculates Layer 0 (base power)', () => {
    const avatar = createDummyInstance('AV-1', 4);
    expect(calculateNetPower(avatar)).toBe(4);
  });

  it('correctly calculates Layer 1 direct equip and self buffs', () => {
    const avatar = createDummyInstance('AV-1', 2);
    // e.g. ความกล้าหาญ (+4)
    avatar.layerModifiers.push({ layer: 1, powerMod: 4, sourceCardId: 'MAGIC-COURAGE' });
    expect(calculateNetPower(avatar)).toBe(6);
  });

  it('correctly stacks Layer 1 and Layer 2 (Land Magic Khao Kailas +1)', () => {
    const narayana = createDummyInstance('AV-NARAYANA', 4);
    narayana.layerModifiers.push({ layer: 1, powerMod: 4, sourceCardId: 'MAGIC-COURAGE' }); // Layer 1: +4
    narayana.layerModifiers.push({ layer: 2, powerMod: 1, sourceCardId: 'LAND-KAILAS' }); // Layer 2: +1
    expect(calculateNetPower(narayana)).toBe(9);
  });

  it('correctly includes Layer 4 combat React modifiers and floors at 0', () => {
    const avatar = createDummyInstance('AV-PUED', 0);
    avatar.layerModifiers.push({ layer: 1, powerMod: 4, sourceCardId: 'SELF-LIFE-BUFF' }); // Layer 1: +4
    avatar.layerModifiers.push({ layer: 4, powerMod: -8, sourceCardId: 'REACT-MONTY' }); // Layer 4: -8
    expect(calculateNetPower(avatar)).toBe(0); // 0 + 4 - 8 = -4 -> floored at 0
  });
});
