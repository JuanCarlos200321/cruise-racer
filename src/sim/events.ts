import type { HazardKind } from './track';

/**
 * Things that happen in a race that the player should see or hear about:
 * a hazard catching a ship, a bump, a ship going into dry dock, a power-up picked up
 * or landing on someone, a shield taking a hit, or a whale's tail coming down.
 */
export type EventKind = HazardKind | 'blocked' | 'splash' | 'bump' | 'drydock' | 'pickup' | 'cork' | 'coconut';

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
  /** True for the worse of two outcomes: a wave taken badly, a hard bump, a whale met head-on. */
  heavy: boolean;
}

/** Use up a ship's shield, if it has one. True if the shield took the hit. */
export function absorb(ship: { shield: number }): boolean {
  if (ship.shield <= 0) return false;
  ship.shield = 0;
  return true;
}

/** Wear down a ship's hull, which runs from 1 (shipshape) to 0 (due in dry dock). */
export function wear(ship: { hull: number }, amount: number): void {
  ship.hull = Math.max(0, ship.hull - amount);
}
