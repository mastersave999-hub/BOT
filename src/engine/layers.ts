import { CardInstance } from './types';

export function calculateSnapshotPower(avatar: CardInstance): number {
  const modifiers = avatar.layerModifiers
    .filter(modifier => modifier.layer === 1 || modifier.layer === 2)
    .sort((left, right) => left.layer - right.layer || left.sourceCardId.localeCompare(right.sourceCardId));
  return Math.max(0, modifiers.reduce((power, modifier) => modifier.powerSet ?? power + modifier.powerMod, avatar.card.power));
}

export function calculateEffectiveSymbol(avatar: CardInstance): string | null {
  const modifiers = [...avatar.layerModifiers]
    .filter(modifier => modifier.symbolMod !== undefined)
    .sort((left, right) => left.layer - right.layer || left.sourceCardId.localeCompare(right.sourceCardId));
  return modifiers.reduce((symbol, modifier) => modifier.symbolMod ?? symbol, avatar.card.symbol ?? null);
}

export function calculateNetPower(avatar: CardInstance): number {
  // Layer 0: Base printed Power
  let currentPower = avatar.card.power;

  // Layer 1: Direct stat modifications (self buffs, Modification Magic equip)
  const orderedModifiers = [...avatar.layerModifiers].sort((left, right) => left.layer - right.layer || left.sourceCardId.localeCompare(right.sourceCardId));
  const layer1Mods = orderedModifiers.filter(m => m.layer === 1);
  for (const mod of layer1Mods) {
    currentPower = mod.powerSet ?? currentPower + mod.powerMod;
  }

  // Layer 2: Indirect aura buffs (Land Magic, continuous allies)
  const layer2Mods = orderedModifiers.filter(m => m.layer === 2);
  for (const mod of layer2Mods) {
    currentPower = mod.powerSet ?? currentPower + mod.powerMod;
  }

  // Layer 3: Snapshot Power established upon attack declaration
  const layer3Mods = orderedModifiers.filter(m => m.layer === 3);
  for (const mod of layer3Mods) {
    currentPower = mod.powerSet ?? currentPower + mod.powerMod;
  }

  // Layer 4: Combat modifiers & React Magic active during combat
  const layer4Mods = orderedModifiers.filter(m => m.layer === 4);
  for (const mod of layer4Mods) {
    currentPower = mod.powerSet ?? currentPower + mod.powerMod;
  }

  // Net power cannot drop below 0 in combat resolution
  return Math.max(0, currentPower);
}
