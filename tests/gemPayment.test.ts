import { describe, expect, it } from 'vitest';
import type { CardInstance, CardType } from '../src/engine/types.js';
import { validateGemPayment } from '../src/engine/gemPayment.js';

function makeCard(
  instanceId: string,
  options: { type?: CardType; gem?: number; gemColor?: string | null; color?: string } = {}
): CardInstance {
  const color = options.color ?? 'แดง';
  return {
    instanceId,
    ownerId: 'player-1',
    controllerId: 'player-1',
    isRested: false,
    isFaceUp: true,
    attachedInstances: [],
    layerModifiers: [],
    card: {
      printId: instanceId,
      name: instanceId,
      type: options.type ?? 'Magic',
      cost: 0,
      gem: options.gem ?? 1,
      gemColor: options.gemColor === undefined ? 'แดง' : options.gemColor,
      power: 0,
      color,
      rarity: 'C',
      isOnlyOne: false,
      isBias: false,
      isCollab: false,
      mainEffect: '',
      imageUrl: 'https://cdn.bottcg.com/cards/test.png'
    }
  };
}

const avatar = makeCard('avatar', { type: 'Avatar', gem: 0, color: 'แดง' });
const construct = makeCard('construct', { type: 'Construct', gem: 0, color: 'ฟ้า' });

describe('GEM payment rules (Rule Book 3.2 pp. 6, 17)', () => {
  it('does not allow GEM 0 cards to pay Avatar or Construct Cost', () => {
    const zeroGem = makeCard('zero', { gem: 0, gemColor: 'แดง' });

    expect(validateGemPayment([avatar, zeroGem], avatar, ['zero'], 1).valid).toBe(false);
    expect(validateGemPayment([construct, zeroGem], construct, ['zero'], 1).valid).toBe(false);
  });

  it('requires colored GEM to match the Avatar or Construct color', () => {
    const redGem = makeCard('red-gem', { gem: 2, gemColor: 'แดง' });

    expect(validateGemPayment([avatar, redGem], avatar, ['red-gem'], 2).valid).toBe(true);
    expect(validateGemPayment([construct, redGem], construct, ['red-gem'], 1).valid).toBe(false);
  });

  it('allows colorless GEM to pay for any Avatar or Construct color', () => {
    const colorlessGem = makeCard('colorless-gem', { gem: 2, gemColor: 'ไร้สี', color: 'ไร้สี' });

    expect(validateGemPayment([avatar, colorlessGem], avatar, ['colorless-gem'], 2).valid).toBe(true);
    expect(validateGemPayment([construct, colorlessGem], construct, ['colorless-gem'], 2).valid).toBe(true);
  });

  it('allows overpayment but rejects selecting more cards after the Cost is sufficient', () => {
    const gemThree = makeCard('gem-three', { gem: 3 });
    const gemTwo = makeCard('gem-two', { gem: 2 });
    const gemFour = makeCard('gem-four', { gem: 4 });
    const gemOne = makeCard('gem-one', { gem: 1 });

    expect(validateGemPayment([avatar, gemThree, gemTwo], avatar, ['gem-three', 'gem-two'], 4)).toEqual({
      valid: true,
      total: 5,
      exactGemPaid: false
    });
    expect(validateGemPayment([avatar, gemOne, gemFour], avatar, ['gem-one', 'gem-four'], 4).valid).toBe(false);
    expect(validateGemPayment([avatar, gemFour], avatar, ['gem-four'], 4)).toEqual({ valid: true, total: 4, exactGemPaid: true });
  });

  it('allows Cost 0 without paying any GEM and does not mark it as exact payment', () => {
    expect(validateGemPayment([avatar], avatar, [], 0)).toEqual({ valid: true, total: 0, exactGemPaid: false });
    const gemOne = makeCard('gem-one', { gem: 1 });
    expect(validateGemPayment([avatar, gemOne], avatar, ['gem-one'], 0).valid).toBe(false);
  });

  it('requires one selected payment set to cover one target card Cost', () => {
    const gemTwo = makeCard('gem-two', { gem: 2 });
    const otherAvatar = makeCard('other-avatar', { type: 'Avatar', gem: 0 });

    expect(validateGemPayment([avatar, gemTwo], avatar, ['gem-two'], 3)).toEqual({ valid: false, total: 2, exactGemPaid: false });
    expect(validateGemPayment([avatar, otherAvatar, gemTwo], avatar, ['other-avatar', 'gem-two'], 2).valid).toBe(false);
  });
});
