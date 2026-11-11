/**
 * Game mode registry. A mode is declarative rules data consumed by the server
 * match loop; adding a mode means adding an entry here (and, if it needs new
 * win conditions, a branch in server/src/Match.ts `checkEnd`).
 */
export interface ModeDef {
  id: string;
  name: string;
  description: string;
  /** Team modes score per team and disable friendly fire. */
  teamBased: boolean;
  /** Eliminations needed to win (team total, or individual total when not team based). */
  scoreLimit: number;
  durationSec: number;
  respawnMs: number;
  spawnProtectionMs: number;
}

export const MODES: Record<string, ModeDef> = {
  tdm: {
    id: 'tdm',
    name: 'Team Deathmatch',
    description: 'Red vs Blue. First team to 30 eliminations wins; 5 minute limit.',
    teamBased: true,
    scoreLimit: 30,
    durationSec: 300,
    respawnMs: 3000,
    spawnProtectionMs: 2000,
  },
  ffa: {
    id: 'ffa',
    name: 'Free-for-All',
    description: 'Everyone for themselves. First player to 20 eliminations wins; 5 minute limit.',
    teamBased: false,
    scoreLimit: 20,
    durationSec: 300,
    respawnMs: 2500,
    spawnProtectionMs: 2000,
  },
};
export const MODE_LIST: ModeDef[] = [MODES.tdm, MODES.ffa];
export const DEFAULT_MODE = 'tdm';
