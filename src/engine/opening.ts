export interface OpeningRoll {
  /** Player ids from first to last turn. */
  order: string[];
  /** The d6 result each player rolled. Every roll is distinct so there are never ties. */
  rolls: Record<string, number>;
}

const DIE_FACES = [1, 2, 3, 4, 5, 6];

/**
 * Every player rolls a d6 and the highest roll goes first. A tie would be re-rolled,
 * so we draw distinct faces directly, which gives each player the same chance.
 */
export function rollOpeningOrder(playerIds: string[], random: () => number = Math.random): OpeningRoll {
  if (playerIds.length > DIE_FACES.length) {
    throw new Error('Opening roll supports at most 6 players');
  }

  const faces = [...DIE_FACES];
  for (let i = faces.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [faces[i], faces[j]] = [faces[j], faces[i]];
  }

  const rolls: Record<string, number> = {};
  playerIds.forEach((id, index) => {
    rolls[id] = faces[index];
  });

  const order = [...playerIds].sort((a, b) => rolls[b] - rolls[a]);
  return { order, rolls };
}
