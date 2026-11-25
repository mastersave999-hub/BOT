import type { CardInstance } from './types';

export interface GemPaymentValidation {
  valid: boolean;
  total: number;
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
  const total = getSelectedGemTotal(hand, selectedIds);
  const invalid = { valid: false, total };

  if (
    !Number.isFinite(requiredCost) ||
    requiredCost <= 0 ||
    !hand.some(card => card.instanceId === targetCard.instanceId) ||
    (targetCard.card.type !== 'Avatar' && targetCard.card.type !== 'Construct')
  ) {
    return invalid;
  }

  if (new Set(selectedIds).size !== selectedIds.length) return invalid;

  let paid = 0;
  for (const instanceId of selectedIds) {
    const paymentCard = hand.find(card => card.instanceId === instanceId);
    if (
      !paymentCard ||
      paymentCard.instanceId === targetCard.instanceId ||
      getGemPaymentCardUnavailableReason(paymentCard, targetCard) !== null ||
      paid >= requiredCost
    ) {
      return invalid;
    }

    paid += paymentCard.card.gem ?? 0;
  }

  return { valid: paid >= requiredCost, total: paid };
}
