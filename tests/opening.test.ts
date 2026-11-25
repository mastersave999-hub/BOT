import { describe, it, expect } from 'vitest';
import { rollOpeningOrder } from '../src/engine/opening.js';

describe('rollOpeningOrder', () => {
  it('gives every player a distinct d6 roll and orders by highest roll', () => {
    const ids = ['player-1', 'player-2', 'player-3', 'player-4'];
    const { order, rolls } = rollOpeningOrder(ids);

    expect(new Set(Object.values(rolls)).size).toBe(ids.length);
    Object.values(rolls).forEach(roll => {
      expect(roll).toBeGreaterThanOrEqual(1);
      expect(roll).toBeLessThanOrEqual(6);
    });
    expect([...order].sort()).toEqual([...ids].sort());
    for (let i = 1; i < order.length; i++) {
      expect(rolls[order[i - 1]]).toBeGreaterThan(rolls[order[i]]);
    }
  });

  it('lets either player win a duel over many rolls', () => {
    const winners = new Set<string>();
    for (let i = 0; i < 200; i++) winners.add(rollOpeningOrder(['a', 'b']).order[0]);
    expect(winners).toEqual(new Set(['a', 'b']));
  });

  it('is deterministic for a fixed random source', () => {
    const fixed = () => 0;
    expect(rollOpeningOrder(['a', 'b'], fixed)).toEqual(rollOpeningOrder(['a', 'b'], fixed));
  });
});
