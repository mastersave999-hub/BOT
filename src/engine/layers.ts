import { CardInstance } from './types';

export function calculateNetPower(avatar: CardInstance): number {
  // Layer 0: Base printed Power
  let currentPower = avatar.card.power;

  // Layer 1: Direct stat modifications (self buffs, Modification Magic equip)
  const layer1Mods = avatar.layerModifiers.filter(m => m.layer === 1);
  for (const mod of layer1Mods) {
    currentPower += mod.powerMod;
  }

  // Layer 2: Indirect aura buffs (Land Magic, continuous allies)
  const layer2Mods = avatar.layerModifiers.filter(m => m.layer === 2);
  for (const mod of layer2Mods) {
    currentPower += mod.powerMod;
  }

  // Layer 3: Snapshot Power established upon attack declaration
  const layer3Mods = avatar.layerModifiers.filter(m => m.layer === 3);
  for (const mod of layer3Mods) {
    currentPower += mod.powerMod;
  }

  // Layer 4: Combat modifiers & React Magic active during combat
  const layer4Mods = avatar.layerModifiers.filter(m => m.layer === 4);
  for (const mod of layer4Mods) {
    currentPower += mod.powerMod;
  }

  // Net power cannot drop below 0 in combat resolution
  return Math.max(0, currentPower);
}
