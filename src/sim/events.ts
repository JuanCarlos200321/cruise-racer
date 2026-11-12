import type { HazardKind } from './track';

/**
 * Things that happen in a race that the player should see or hear about:
 * a hazard catching a ship, a crash, a ship going down, a power-up picked up
 * or landing on someone, a shield taking a hit, or a whale's tail coming down.
 */
export type EventKind = HazardKind | 'blocked' | 'splash' | 'crash' | 'sunk' | 'pickup' | 'cork' | 'coconut';

export interface RaceEvent {
  kind: EventKind;
  /** The ship it happened to, or -1 when it happened to nobody. */
  shipId: number;
  /** Where it happened. */
  x: number;
  z: number;
  /** Where it came from. */
  fromX: number;
  fromZ: number;
  /** True for the worse of two outcomes: a wave taken badly, a hard crash, a whale hit head-on. */
  heavy: boolean;
}

/** Use up a ship's shield, if it has one. True if the shield took the hit. */
export function absorb(ship: { shield: number }): boolean {
  if (ship.shield <= 0) return false;
  ship.shield = 0;
  return true;
}

/** Take away some of a ship's hull, which runs from 1 (sound) to 0 (sinking). */
export function hurt(ship: { hull: number }, amount: number): void {
  ship.hull = Math.max(0, ship.hull - amount);
}
