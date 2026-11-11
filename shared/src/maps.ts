/**
 * Map definitions. Maps are pure data: axis-aligned solid boxes plus spawn
 * points. The same data drives server collision, hit-scan occlusion and client
 * rendering, so what you see is exactly what blocks movement and bullets.
 */

export type MatId = 'wall' | 'concrete' | 'crate' | 'metal' | 'roof' | 'accentRed' | 'accentBlue';

export interface Box {
  min: [number, number, number];
  max: [number, number, number];
  mat: MatId;
}

export interface SpawnPoint {
  x: number;
  z: number;
  yaw: number;
}

export interface MapDef {
  id: string;
  name: string;
  description: string;
  /** Half extents of the playable floor. */
  halfX: number;
  halfZ: number;
  boxes: Box[];
  spawns: { red: SpawnPoint[]; blue: SpawnPoint[] };
}

function b(x1: number, z1: number, x2: number, z2: number, h: number, mat: MatId, y0 = 0): Box {
  return {
    min: [Math.min(x1, x2), y0, Math.min(z1, z2)],
    max: [Math.max(x1, x2), y0 + h, Math.max(z1, z2)],
    mat,
  };
}

function mirrorX(box: Box): Box {
  const mat: MatId = box.mat === 'accentRed' ? 'accentBlue' : box.mat === 'accentBlue' ? 'accentRed' : box.mat;
  return { min: [-box.max[0], box.min[1], box.min[2]], max: [-box.min[0], box.max[1], box.max[2]], mat };
}

/** Builds a map that is mirror-symmetric across x = 0 so both teams get identical ground. */
function symmetric(west: Box[], centre: Box[]): Box[] {
  return [...west, ...west.map(mirrorX), ...centre];
}

function spawnsFor(points: Array<[number, number]>): { red: SpawnPoint[]; blue: SpawnPoint[] } {
  return {
    red: points.map(([x, z]) => ({ x, z, yaw: -Math.PI / 2 })),
    blue: points.map(([x, z]) => ({ x: -x, z, yaw: Math.PI / 2 })),
  };
}

function outerWalls(hx: number, hz: number, h: number): Box[] {
  return [
    b(-hx - 0.5, -hz - 0.5, hx + 0.5, -hz, h, 'wall'),
    b(-hx - 0.5, hz, hx + 0.5, hz + 0.5, h, 'wall'),
    b(-hx - 0.5, -hz - 0.5, -hx, hz + 0.5, h, 'wall'),
    b(hx, -hz - 0.5, hx + 0.5, hz + 0.5, h, 'wall'),
  ];
}

/**
 * FOUNDRY - three lanes between two spawn yards:
 *   north: an enclosed warehouse (indoor, close range)
 *   mid:   an open container yard (long sightlines broken by cover)
 *   south: a half-covered service alley (medium range)
 */
const foundry: MapDef = {
  id: 'foundry',
  name: 'Foundry',
  description: 'Three lanes: indoor warehouse, open container yard and a covered service alley.',
  halfX: 32,
  halfZ: 24,
  boxes: symmetric(
    [
      // Spawn yard divider with north / mid / south exits
      b(-22.3, -19, -21.7, -5, 4, 'wall'),
      b(-22.3, 5, -21.7, 19, 4, 'wall'),
      b(-22.4, -19, -21.6, -5, 0.3, 'accentRed', 4),
      b(-22.4, 5, -21.6, 19, 0.3, 'accentRed', 4),
      // Cover in front of the mid exit
      b(-18.5, -2, -17, 2, 2.4, 'metal'),
      // Warehouse west wall (door z -21..-18) and south wall (door x -8..-5)
      b(-13.3, -24, -13, -21, 4, 'wall'),
      b(-13.3, -18, -13, -10.7, 4, 'wall'),
      b(-13, -11, -8, -10.7, 4, 'wall'),
      // Warehouse interior cover
      b(-10, -17, -8.5, -15.5, 1.1, 'crate'),
      b(-6, -22, -4.5, -20.5, 0.8, 'crate'),
      // North approach
      b(-18, -15, -16.5, -13.5, 1.1, 'crate'),
      // Yard
      b(-11, -7, -9, -2, 2.6, 'metal'),
      b(-8, 2.5, -5, 3.3, 1.1, 'concrete'),
      b(-13, 5, -11.5, 6.5, 0.8, 'crate'),
      b(-6.5, -8.5, -5, -7, 1.1, 'crate'),
      // Alley wall (door x -9..-6)
      b(-21.7, 9, -9, 9.3, 4, 'wall'),
      // Alley cover and pillars
      b(-14, 15, -12.5, 16.5, 1.1, 'crate'),
      b(-9.5, 19, -8, 22, 2.4, 'metal'),
      b(-6.3, 13, -5.7, 13.6, 3.4, 'concrete'),
      b(-6.3, 19, -5.7, 19.6, 3.4, 'concrete'),
    ],
    [
      ...outerWalls(32, 24, 6),
      // Warehouse south wall centre, roof and centre shelf
      b(-5, -11, 5, -10.7, 4, 'wall'),
      b(-13.3, -24, 13.3, -10.7, 0.3, 'roof', 4),
      b(-1, -20, 1, -14.5, 2.6, 'metal'),
      // Yard centre container
      b(-2.5, -3.5, 2.5, 3.5, 2.8, 'metal'),
      // Alley wall centre, covered section and low wall
      b(-6, 9, 6, 9.3, 4, 'wall'),
      b(-6.3, 9, 6.3, 24, 0.3, 'roof', 3.4),
      b(-1.5, 15.5, 1.5, 16.3, 1.1, 'concrete'),
    ],
  ),
  spawns: spawnsFor([
    [-29, -18], [-29, -9], [-29, 0], [-29, 9], [-29, 18],
    [-26, -13.5], [-26, -4.5], [-26, 4.5], [-26, 13.5],
  ]),
};

/** CROSSROADS - a compact arena for small teams and fast duels. */
const crossroads: MapDef = {
  id: 'crossroads',
  name: 'Crossroads',
  description: 'Compact arena with a covered north passage and an open centre. Best for 1v1 to 3v3.',
  halfX: 22,
  halfZ: 18,
  boxes: symmetric(
    [
      b(-17, -3, -16.4, 3, 3, 'wall'),
      b(-17.1, -3, -16.3, 3, 0.3, 'accentRed', 3),
      b(-12, -12, -8, -11.4, 3.2, 'wall'),
      b(-12, 11.4, -8, 12, 3.2, 'wall'),
      b(-11, -6, -9.5, -4.5, 1.1, 'crate'),
      b(-11, 4.5, -9.5, 6, 1.1, 'crate'),
      b(-6, -1, -5.2, 1, 1.1, 'concrete'),
      // Covered passage south wall (door x -1.2..1.2)
      b(-4, -8.3, -1.2, -8, 3.4, 'wall'),
    ],
    [
      ...outerWalls(22, 18, 5),
      b(-4, -14, 4, -13.7, 3.4, 'wall'),
      b(-4.3, -14.3, 4.3, -7.7, 0.3, 'roof', 3.4),
      b(-1.5, -1.5, 1.5, 1.5, 2.8, 'metal'),
      b(-3, 8, 3, 8.6, 1.1, 'concrete'),
      b(-1, 13, 1, 15, 2.4, 'metal'),
    ],
  ),
  spawns: spawnsFor([
    [-20, -12], [-20, -6], [-20, 0], [-20, 6], [-20, 12],
    [-18.5, -9], [-18.5, 9],
  ]),
};

export const MAPS: Record<string, MapDef> = { foundry, crossroads };
export const MAP_LIST: MapDef[] = [foundry, crossroads];
export const DEFAULT_MAP = 'foundry';
