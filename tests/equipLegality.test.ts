import { describe, expect, it } from 'vitest';
import { checkModificationEquip } from '../src/engine/equipLegality';
import { recomputeContinuousEffects } from '../src/engine/continuousEffects';
import type { Card, CardInstance, GameState } from '../src/engine/types';

function makeCard(name: string, type: Card['type'], mainEffect = '', subtype?: Card['subtype']): Card {
  return {
    printId: name,
    name,
    type,
    subtype,
    cost: 1,
    gem: 1,
    power: 2,
    symbol: 'มนุษย์',
    color: 'แดง',
    rarity: 'C',
    mainEffect,
    isOnlyOne: false,
    isBias: false,
    isCollab: false,
    imageUrl: 'https://example.test/card.png',
  };
}

function makeInstance(instanceId: string, ownerId: string, card: Card, attachedInstances: CardInstance[] = []): CardInstance {
  return { instanceId, card, ownerId, controllerId: ownerId, isRested: false, isFaceUp: true, attachedInstances, layerModifiers: [] };
}

function stateWithAvatar(avatar: CardInstance): GameState {
  const player = (id: string, seat: number) => ({
    id, name: id, seat, deck: [], hand: [], lifeDeck: [], avatarZone: id === 'p1' ? [avatar] : [],
    constructZone: [], magicZone: [], hell: [], darkDimension: [], isCritical: false,
    reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 }, usedMagicTypesThisTurn: new Set<never>(),
  });
  return {
    id: 'equip-legality', mode: 'DUEL', playerOrder: ['p1', 'p2'], currentTurnPlayerIndex: 0,
    currentPhase: 'MAIN', turnNumber: 1, roundNumber: 1, players: { p1: player('p1', 0), p2: player('p2', 1) },
    landMagicZone: null, eventLog: [],
  };
}

describe('Rule Book 3.2 Modification equip restrictions', () => {
  it('uses exact-name matching for unquoted names and delimited-word matching for quoted names', () => {
    const exactOnly = makeCard('Exact Weapon', 'Magic', 'สวมใส่ได้เฉพาะ อาเธอร์ ราชาแห่งอัศวินโต๊ะกลม', 'Modification');
    expect(checkModificationEquip(exactOnly, makeCard('อาเธอร์ ราชาแห่งอัศวินโต๊ะกลม', 'Avatar')).legal).toBe(true);
    expect(checkModificationEquip(exactOnly, makeCard('อาเธอร์ ราชาแห่งอัศวินโต๊ะกลม สำเนา', 'Avatar')).legal).toBe(false);

    const quotedWord = makeCard('Quoted Weapon', 'Magic', 'สวมใส่ได้เฉพาะ Avatar "นาย" เท่านั้น', 'Modification');
    expect(checkModificationEquip(quotedWord, makeCard('นาย ผู้เจริญนาย', 'Avatar')).legal).toBe(true);
    expect(checkModificationEquip(quotedWord, makeCard('นายนิรยบาล', 'Avatar')).legal).toBe(false);
    expect(checkModificationEquip(quotedWord, makeCard('ทนายเตะปาก', 'Avatar')).legal).toBe(false);
  });

  it('moves an attached Modification Magic to its owner Hell when the continuous restriction fails', () => {
    const modification = makeInstance('restricted-mod', 'p1', makeCard(
      'Exact Weapon', 'Magic', 'สวมใส่ได้เฉพาะ อาเธอร์ ราชาแห่งอัศวินโต๊ะกลม', 'Modification'
    ));
    const avatar = makeInstance('wrong-avatar', 'p1', makeCard('Different Avatar', 'Avatar'), [modification]);
    const initial = stateWithAvatar(avatar);

    const result = recomputeContinuousEffects(initial);

    expect(result.players.p1.avatarZone[0].attachedInstances).toEqual([]);
    expect(result.players.p1.hell.map(card => card.instanceId)).toEqual(['restricted-mod']);
    expect(result.gameEvents?.some(item => item.event.type === 'CARD_MOVED' && item.event.instanceId === 'restricted-mod' && item.event.to === 'p1:hell')).toBe(true);
    expect(initial.players.p1.avatarZone[0].attachedInstances).toHaveLength(1);
  });
});
