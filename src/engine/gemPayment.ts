import type { CardInstance } from './types';

export interface GemPaymentValidation {
  valid: boolean;
  total: number;
  exactGemPaid: boolean;
}

export function getGemPaymentCardUnavailableReason(
  paymentCard: CardInstance,
  targetCard: CardInstance
): string | null {
  if (targetCard.card.type !== 'Avatar' && targetCard.card.type !== 'Construct') {
    return 'GEM ใช้ได้กับ Avatar หรือ Construct เท่านั้น';
  }

  const gem = paymentCard.card.gem ?? 0;
  if (!Number.isFinite(gem) || gem <= 0) return 'GEM 0 ไม่สามารถใช้จ่าย Cost ได้';

  const gemColor = paymentCard.card.gemColor ?? paymentCard.card.color;
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
  requiredCost: number
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
    getGemPaymentCardUnavailableReason(card, targetCard) !== null)) {
    return { ...invalid, total: getSelectedGemTotal(hand, selectedIds) };
  }

  const total = paymentCards.reduce((sum, card) => sum + (card?.card.gem ?? 0), 0);
  const valid = total >= requiredCost && paymentCards.every(card => total - (card?.card.gem ?? 0) < requiredCost);
  return { valid, total, exactGemPaid: valid && total === requiredCost };
}
