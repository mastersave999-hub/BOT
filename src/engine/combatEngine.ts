import { GameState, CardInstance, PlayerState } from './types';
import { calculateNetPower } from './layers';
import { avatarHasKeyword } from './abilityEngine';

export interface CombatResult {
  winner: 'ATTACKER' | 'DEFENDER' | 'TIE' | 'NO_OP';
  attackerDestroyed: boolean;
  defenderDestroyed: boolean;
  events: string[];
}

export function resolveAvatarCombat(
  attacker: CardInstance,
  defender: CardInstance
): CombatResult {
  const attackerPower = calculateNetPower(attacker);
  const defenderPower = calculateNetPower(defender);
  const events: string[] = [];

  events.push(`Combat started: ${attacker.card.name} (POWER ${attackerPower}) vs ${defender.card.name} (POWER ${defenderPower})`);

  // RuleBook p.23: Avatar with POWER 0 vs Avatar with POWER 0 -> Nothing happens
  if (attackerPower === 0 && defenderPower === 0) {
    events.push('Both Avatars have 0 POWER: Nothing happens.');
    return {
      winner: 'NO_OP',
      attackerDestroyed: false,
      defenderDestroyed: false,
      events
    };
  }

  // Check Grit (ลูกฮึด) [RuleBook p.8]:
  // If POWER is equal, the one with ลูกฮึด wins. If both have ลูกฮึด, both destroyed.
  const attackerHasGrit = avatarHasKeyword(attacker, 'ลูกฮึด');
  const defenderHasGrit = avatarHasKeyword(defender, 'ลูกฮึด');

  if (attackerPower === defenderPower) {
    if (attackerHasGrit && !defenderHasGrit) {
      events.push(`${attacker.card.name} wins via Grit (ลูกฮึด)!`);
      return {
        winner: 'ATTACKER',
        attackerDestroyed: false,
        defenderDestroyed: true,
        events
      };
    } else if (defenderHasGrit && !attackerHasGrit) {
      events.push(`${defender.card.name} wins via Grit (ลูกฮึด)!`);
      return {
        winner: 'DEFENDER',
        attackerDestroyed: true,
        defenderDestroyed: false,
        events
      };
    } else {
      // Both destroyed [RuleBook p.23]
      events.push('Equal POWER: Both Avatars are destroyed and sent to Hell.');
      return {
        winner: 'TIE',
        attackerDestroyed: true,
        defenderDestroyed: true,
        events
      };
    }
  }

  if (attackerPower > defenderPower) {
    events.push(`${attacker.card.name} wins the battle! ${defender.card.name} is destroyed.`);
    return {
      winner: 'ATTACKER',
      attackerDestroyed: false,
      defenderDestroyed: true,
      events
    };
  } else {
    events.push(`${defender.card.name} wins the battle! ${attacker.card.name} is destroyed.`);
    return {
      winner: 'DEFENDER',
      attackerDestroyed: true,
      defenderDestroyed: false,
      events
    };
  }
}

export function attackLifeZone(
  attacker: CardInstance,
  defendingPlayer: PlayerState
): { damageDealt: boolean; isGameOver: boolean; revealedCardId?: string; event: string } {
  const attackerPower = calculateNetPower(attacker);

  // RuleBook p.25: Avatar with 0 POWER cannot deal damage to LIFE Card Zone
  if (attackerPower === 0) {
    return {
      damageDealt: false,
      isGameOver: false,
      event: `${attacker.card.name} attacked LIFE Card Zone with 0 POWER: No damage dealt.`
    };
  }

  // RuleBook p.21, p.25: If in Critical State (สถานะสาหัส), any successful damage results in loss!
  if (defendingPlayer.isCritical || defendingPlayer.lifeDeck.every(c => c.isFaceUp)) {
    return {
      damageDealt: true,
      isGameOver: true,
      event: `${attacker.card.name} dealt damage to ${defendingPlayer.name} in Critical State (สถานะสาหัส)! ${defendingPlayer.name} has lost the game.`
    };
  }

  // Otherwise, reveal 1 face-down LIFE card from top to bottom
  const nextLifeCardIndex = defendingPlayer.lifeDeck.findIndex(c => !c.isFaceUp);
  if (nextLifeCardIndex !== -1) {
    defendingPlayer.lifeDeck[nextLifeCardIndex].isFaceUp = true;
    const allRevealed = defendingPlayer.lifeDeck.every(c => c.isFaceUp);
    if (allRevealed) {
      defendingPlayer.isCritical = true;
    }
    return {
      damageDealt: true,
      isGameOver: false,
      revealedCardId: defendingPlayer.lifeDeck[nextLifeCardIndex].instanceId,
      event: `${attacker.card.name} revealed LIFE Card #${nextLifeCardIndex + 1}.${allRevealed ? ' Defending player entered Critical State (สถานะสาหัส)!' : ''}`
    };
  }

  return {
    damageDealt: true,
    isGameOver: true,
    event: `${defendingPlayer.name} took lethal damage and has lost the game.`
  };
}
