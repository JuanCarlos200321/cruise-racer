/** How much faster than real life the ships sail. Displayed knots divide this back out. */
export const SPEED_SCALE = 6;
const METRES_PER_SECOND_PER_KNOT = 0.5144;

export function toKnots(worldSpeed: number): number {
  return worldSpeed / (METRES_PER_SECOND_PER_KNOT * SPEED_SCALE);
}

export type ShipClassId = 'icon' | 'oasis' | 'quantum' | 'freedom' | 'radiance';

export interface ShipClass {
  id: ShipClassId;
  name: string;
  /** Ships of the class. The first is the lead ship, used for the player. */
  shipNames: string[];
  tagline: string;
  /** Overall length, metres. */
  length: number;
  /** Waterline beam, metres. */
  beam: number;
  /** Top of the superstructure above the waterline, metres. */
  height: number;
  /** Top speed at full ahead, world metres per second. */
  topSpeed: number;
  /** Acceleration from rest at full ahead, m/s^2. */
  accel: number;
  /** Maximum yaw rate at full rudder, rad/s. */
  turnRate: number;
  /** How quickly yaw rate follows the rudder, 1/s. Lower feels heavier. */
  yawResponse: number;
  /** How quickly sideways slide is bled off, 1/s. Lower slides more. */
  grip: number;
  /** Relative mass, used in collisions (thousand gross tons). */
  mass: number;
}

export const SHIP_CLASSES: ShipClass[] = [
  {
    id: 'icon',
    name: 'Icon Class',
    shipNames: ['Icon of the Seas', 'Star of the Seas'],
    tagline: 'The biggest ship on the water. Unbeatable on a straight, a handful in the turns.',
    length: 365,
    beam: 48,
    height: 62,
    topSpeed: 80,
    accel: 3.6,
    turnRate: 0.19,
    yawResponse: 0.9,
    grip: 1.5,
    mass: 250,
  },
  {
    id: 'oasis',
    name: 'Oasis Class',
    shipNames: ['Oasis of the Seas', 'Wonder of the Seas', 'Symphony of the Seas'],
    tagline: 'Heavy and stable with a strong top end. Rewards a smooth line.',
    length: 362,
    beam: 47,
    height: 60,
    topSpeed: 76,
    accel: 3.9,
    turnRate: 0.2,
    yawResponse: 1.0,
    grip: 1.7,
    mass: 226,
  },
  {
    id: 'quantum',
    name: 'Quantum Class',
    shipNames: ['Quantum of the Seas', 'Anthem of the Seas', 'Odyssey of the Seas'],
    tagline: 'The all-rounder. No weaknesses, no excuses.',
    length: 348,
    beam: 41,
    height: 54,
    topSpeed: 70.5,
    accel: 4.4,
    turnRate: 0.215,
    yawResponse: 1.2,
    grip: 2.0,
    mass: 169,
  },
  {
    id: 'freedom',
    name: 'Freedom Class',
    shipNames: ['Freedom of the Seas', 'Liberty of the Seas', 'Independence of the Seas'],
    tagline: 'Quick off the line and out of slow corners.',
    length: 339,
    beam: 38.6,
    height: 52,
    topSpeed: 67,
    accel: 5.0,
    turnRate: 0.23,
    yawResponse: 1.3,
    grip: 2.2,
    mass: 155,
  },
  {
    id: 'radiance',
    name: 'Radiance Class',
    shipNames: ['Radiance of the Seas', 'Jewel of the Seas', 'Serenade of the Seas'],
    tagline: 'Small, sleek and agile. Wins races in the tight stuff.',
    length: 293,
    beam: 32.2,
    height: 44,
    topSpeed: 63,
    accel: 4.6,
    turnRate: 0.255,
    yawResponse: 1.6,
    grip: 2.6,
    mass: 90,
  },
];

export function shipClassById(id: ShipClassId): ShipClass {
  const cls = SHIP_CLASSES.find((c) => c.id === id);
  if (!cls) throw new Error(`Unknown ship class: ${id}`);
  return cls;
}

/** Stats normalised to 0..1 across the fleet, for the ship select screen. */
export function statBars(cls: ShipClass): { label: string; value: number }[] {
  const norm = (pick: (c: ShipClass) => number): number => {
    const values = SHIP_CLASSES.map(pick);
    const min = Math.min(...values);
    const max = Math.max(...values);
    return 0.35 + (0.65 * (pick(cls) - min)) / (max - min);
  };
  return [
    { label: 'Top speed', value: norm((c) => c.topSpeed) },
    { label: 'Acceleration', value: norm((c) => c.accel) },
    { label: 'Handling', value: norm((c) => c.turnRate) },
    { label: 'Grip', value: norm((c) => c.grip) },
    { label: 'Weight', value: norm((c) => c.mass) },
  ];
}
