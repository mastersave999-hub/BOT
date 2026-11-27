import type { CardInstance } from './types';

export interface GemPaymentOptions {
  /** InstanceIds whose Gem is treated as ไร้สี (colorless) by an active continuous aura (e.g. "สภาแบงค์" BT06-061). */
  colorlessGemInstanceIds?: ReadonlySet<string>;
}

export interface GemPaymentValidation {
  valid: boolean;
  total: number;
  exactGemPaid: boolean;
}

export function getGemPaymentCardUnavailableReason(
  paymentCard: CardInstance,
  targetCard: CardInstance,
  options: GemPaymentOptions = {}
): string | null {
  if (targetCard.card.type !== 'Avatar' && targetCard.card.type !== 'Construct') {
    return 'GEM ใช้ได้กับ Avatar หรือ Construct เท่านั้น';
  }

  const gem = paymentCard.card.gem ?? 0;
  if (!Number.isFinite(gem) || gem <= 0) return 'GEM 0 ไม่สามารถใช้จ่าย Cost ได้';

  const gemColor = options.colorlessGemInstanceIds?.has(paymentCard.instanceId)
    ? 'ไร้สี'
    : (paymentCard.card.gemColor ?? paymentCard.card.color);
  if (gemColor !== 'ไร้สี' && gemColor !== targetCard.card.color) {
    return `GEM สี${gemColor} ใช้ได้กับการ์ดสี${gemColor}เท่านั้น`;
  }

  return null;
}

export function getSelectedGemTotal(hand: CardInstance[], selectedIds: string[]): number {
  const selectedIdSet = new Set(selectedIds);
  return hand.reduce(
    (total, card) =>
      selectedIdSet.has(card.instanceId) ? total + Math.max(0, card.card.gem ?? 0) : total,
    0
  );
}

export function validateGemPayment(
  hand: CardInstance[],
  targetCard: CardInstance,
  selectedIds: string[],
  requiredCost: number,
  options: GemPaymentOptions = {}
): GemPaymentValidation {
  const invalid: GemPaymentValidation = { valid: false, total: 0, exactGemPaid: false };
  if (
    !Number.isSafeInteger(requiredCost) || requiredCost < 0 ||
    !hand.some(card => card.instanceId === targetCard.instanceId) ||
    (targetCard.card.type !== 'Avatar' && targetCard.card.type !== 'Construct') ||
    new Set(selectedIds).size !== selectedIds.length
  ) return { ...invalid, total: getSelectedGemTotal(hand, selectedIds) };

  if (requiredCost === 0) return { valid: selectedIds.length === 0, total: 0, exactGemPaid: false };

  const paymentCards = selectedIds.map(instanceId => hand.find(card => card.instanceId === instanceId));
  if (paymentCards.some(card => !card || card.instanceId === targetCard.instanceId ||
    getGemPaymentCardUnavailableReason(card, targetCard, options) !== null)) {
    return { ...invalid, total: getSelectedGemTotal(hand, selectedIds) };
  }

  const total = paymentCards.reduce((sum, card) => sum + (card?.card.gem ?? 0), 0);
  const valid = total >= requiredCost && paymentCards.every(card => total - (card?.card.gem ?? 0) < requiredCost);
  return { valid, total, exactGemPaid: valid && total === requiredCost };
}

/**
 * True when the player holds a legal Gem payment for `requiredCost` right now.
 * Mirrors validateGemPayment's validity rule (the total covers the cost and every
 * selected card is necessary) over the affordable candidates in hand.
 */
export function canPayCost(
  hand: readonly CardInstance[],
  targetCard: CardInstance,
  requiredCost: number,
  options: GemPaymentOptions = {}
): boolean {
  if (!Number.isSafeInteger(requiredCost) || requiredCost < 0) return false;
  if (requiredCost === 0) return true;
  if (targetCard.card.type !== 'Avatar' && targetCard.card.type !== 'Construct') return false;

  const candidates = hand
    .filter(card => card.instanceId !== targetCard.instanceId && (card.card.gem ?? 0) > 0 &&
      getGemPaymentCardUnavailableReason(card, targetCard, options) === null)
    .sort((left, right) => (right.card.gem ?? 0) - (left.card.gem ?? 0))
    .slice(0, 16);

  const count = candidates.length;
  for (let mask = 1; mask < (1 << count); mask += 1) {
    let total = 0;
    let smallestGem = Number.POSITIVE_INFINITY;
    for (let index = 0; index < count; index += 1) {
      if ((mask & (1 << index)) === 0) continue;
      const gem = candidates[index].card.gem ?? 0;
      total += gem;
      if (gem < smallestGem) smallestGem = gem;
    }
    if (total >= requiredCost && total - smallestGem < requiredCost) return true;
  }
  return false;
}
