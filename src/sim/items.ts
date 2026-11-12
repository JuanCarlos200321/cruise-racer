import { hullCircles } from './collision';
import { absorb, type RaceEvent } from './events';
import { forward, starboard, type ShipState } from './physics';
import { createRng } from './rng';
import type { ShipClass } from './ships';
import type { Track } from './track';

export type ItemKind = 'boost' | 'shield' | 'cork' | 'coconut' | 'repair';

export const ITEM_KINDS: ItemKind[] = ['boost', 'shield', 'cork', 'coconut', 'repair'];

export const ITEM_NAMES: Record<ItemKind, string> = {
  boost: 'FlowRider Boost',
  shield: 'Crown & Anchor Shield',
  cork: 'Champagne Cork',
  coconut: 'Lime & Coconut',
  repair: 'Dry Dock Repair',
};

export const ITEM_HINTS: Record<ItemKind, string> = {
  boost: 'A burst of speed',
  shield: 'Takes the next hit for you',
  cork: 'Fires at the ship ahead',
  coconut: 'Drops trouble behind you',
  repair: 'Mends your hull',
};

/** A floating gift box. Sailing through one gives a ship a power-up. */
export interface ItemBox {
  x: number;
  z: number;
  /** False for a few seconds after a ship has taken it. */
  ready: boolean;
}

/** A champagne cork in flight. */
export interface Shot {
  x: number;
  z: number;
  heading: number;
  owner: number;
  life: number;
}

/** A coconut or lime left floating in the water. */
export interface Drop {
  x: number;
  z: number;
  owner: number;
  age: number;
}

/** A ship that can pick up and use power-ups. */
export interface ItemUser {
  id: number;
  state: ShipState;
  cls: ShipClass;
  hull: number;
  shield: number;
  boost: number;
  /** Seconds left going down. A sinking ship cannot pick up or use anything. */
  sinking: number;
  item: ItemKind | null;
  /** Seconds the ship has had its item. */
  itemHeld: number;
  /** Samples travelled since the start line. */
  progress: number;
  finished: boolean;
}

/** Where the rows of boxes are along the route, as shares of its length. */
const ROWS = [0.25, 0.5, 0.75];
/** Where the boxes of a row sit across the channel, as shares of the half-width. */
const ROW_LATERALS = [-0.62, -0.31, 0, 0.31, 0.62];
export const BOX_RADIUS = 20;
const BOX_RESPAWN = 6;
export const BOOST_SECONDS = 3.5;
export const SHIELD_SECONDS = 12;
/** Well over the speed of the quickest ship, or it would never catch one. */
const CORK_SPEED = 260;
const CORK_TURN_RATE = 2.4;
const CORK_LIFE = 7;
const CORK_RANGE = 2200;
const CORK_RADIUS = 14;
const CORK_SPEED_KEPT = 0.45;
const COCONUT_OFFSETS = [-48, 0, 48];
const COCONUT_LIFE = 45;
/** Seconds before a ship's own coconuts can catch it. */
const COCONUT_ARM = 3;
const COCONUT_RADIUS = 12;
const COCONUT_SPEED_KEPT = 0.6;
const MAX_DROPS = 30;

/** The power-ups on a route: boxes to collect, and corks and coconuts in play. */
export class ItemField {
  readonly boxes: ItemBox[] = [];
  shots: Shot[] = [];
  drops: Drop[] = [];
  private readonly respawn: number[] = [];
  private readonly rng: () => number;
  private readonly track: Track;

  constructor(track: Track) {
    this.track = track;
    this.rng = createRng(track.def.seed * 13 + 5);
    for (const row of ROWS) {
      const index = track.startIndex + Math.round((track.finishIndex - track.startIndex) * row);
      for (const share of ROW_LATERALS) {
        const p = track.pointAt(index, share * track.halfWidth);
        this.boxes.push({ x: p.x, z: p.z, ready: true });
        this.respawn.push(0);
      }
    }
  }

  /** Move corks, age coconuts, and hand out boxes to ships sailing through them. */
  step(dt: number, ships: ItemUser[]): RaceEvent[] {
    const events: RaceEvent[] = [];
    this.boxes.forEach((box, i) => {
      if (!box.ready) {
        this.respawn[i] -= dt;
        box.ready = this.respawn[i] <= 0;
        return;
      }
      for (const ship of ships) {
        if (ship.item || ship.sinking > 0 || ship.finished || !touches(ship, box.x, box.z, BOX_RADIUS)) continue;
        ship.item = this.pick(ship, ships);
        ship.itemHeld = 0;
        box.ready = false;
        this.respawn[i] = BOX_RESPAWN;
        events.push(eventAt('pickup', ship, box.x, box.z));
        break;
      }
    });

    this.shots = this.shots.filter((shot) => {
      shot.life -= dt;
      const target = this.aimFor(shot, ships);
      if (target) {
        const bearing = Math.atan2(target.state.x - shot.x, target.state.z - shot.z);
        const turn = Math.atan2(Math.sin(bearing - shot.heading), Math.cos(bearing - shot.heading));
        shot.heading += Math.max(-CORK_TURN_RATE * dt, Math.min(CORK_TURN_RATE * dt, turn));
      }
      shot.x += Math.sin(shot.heading) * CORK_SPEED * dt;
      shot.z += Math.cos(shot.heading) * CORK_SPEED * dt;
      for (const ship of ships) {
        if (ship.id === shot.owner || !touches(ship, shot.x, shot.z, CORK_RADIUS)) continue;
        if (absorb(ship)) {
          events.push(eventAt('blocked', ship, shot.x, shot.z));
        } else {
          ship.state.u *= CORK_SPEED_KEPT;
          ship.state.r += this.rng() < 0.5 ? -0.12 : 0.12;
          events.push(eventAt('cork', ship, shot.x, shot.z));
        }
        return false;
      }
      return shot.life > 0;
    });

    this.drops = this.drops.filter((drop) => {
      drop.age += dt;
      for (const ship of ships) {
        if (ship.id === drop.owner && drop.age < COCONUT_ARM) continue;
        if (!touches(ship, drop.x, drop.z, COCONUT_RADIUS)) continue;
        if (absorb(ship)) {
          events.push(eventAt('blocked', ship, drop.x, drop.z));
        } else {
          ship.state.u *= COCONUT_SPEED_KEPT;
          ship.state.r += this.rng() < 0.5 ? -0.18 : 0.18;
          events.push(eventAt('coconut', ship, drop.x, drop.z));
        }
        return false;
      }
      return drop.age < COCONUT_LIFE;
    });
    return events;
  }

  /** Use the power-up a ship is holding. Does nothing if it has none. */
  use(ship: ItemUser): void {
    const item = ship.item;
    if (!item || ship.sinking > 0 || ship.finished) return;
    ship.item = null;
    const s = ship.state;
    const f = forward(s.heading);
    if (item === 'boost') {
      ship.boost = BOOST_SECONDS;
    } else if (item === 'shield') {
      ship.shield = SHIELD_SECONDS;
    } else if (item === 'repair') {
      ship.hull = 1;
    } else if (item === 'cork') {
      const ahead = ship.cls.length / 2 + CORK_RADIUS + 10;
      this.shots.push({ x: s.x + f.x * ahead, z: s.z + f.z * ahead, heading: s.heading, owner: ship.id, life: CORK_LIFE });
    } else {
      const sb = starboard(s.heading);
      const behind = ship.cls.length / 2 + 40;
      for (const offset of COCONUT_OFFSETS) {
        this.drops.push({
          x: s.x - f.x * behind + sb.x * offset,
          z: s.z - f.z * behind + sb.z * offset,
          owner: ship.id,
          age: 0,
        });
      }
      if (this.drops.length > MAX_DROPS) this.drops.splice(0, this.drops.length - MAX_DROPS);
    }
  }

  /** Whether an AI ship should use its power-up now. */
  shouldUse(ship: ItemUser, ships: ItemUser[]): boolean {
    if (!ship.item || ship.itemHeld < 1.5 + (ship.id % 3)) return false;
    const spacing = this.track.spacing;
    const gapTo = (other: ItemUser): number => (other.progress - ship.progress) * spacing;
    const others = ships.filter((other) => other !== ship && other.sinking <= 0);
    switch (ship.item) {
      case 'boost':
      case 'shield':
        return true;
      case 'repair':
        return ship.hull < 0.75 || ship.itemHeld > 25;
      case 'cork':
        return ship.itemHeld > 14 || others.some((other) => gapTo(other) > 100 && gapTo(other) < 1500);
      case 'coconut':
        return ship.itemHeld > 14 || others.some((other) => gapTo(other) < -150 && gapTo(other) > -700);
    }
  }

  /** Choose a power-up for a ship. Ships further back get more help catching up. */
  private pick(ship: ItemUser, ships: ItemUser[]): ItemKind {
    const ahead = ships.filter((other) => other.progress > ship.progress).length;
    const back = ships.length > 1 ? ahead / (ships.length - 1) : 0.5;
    const weights: Record<ItemKind, number> = {
      boost: 2 + 3 * back,
      shield: 2,
      cork: ahead === 0 ? 0 : 1 + 3 * back,
      coconut: 3 - 2 * back,
      repair: ship.hull < 0.8 ? 3 : 0.5,
    };
    let roll = this.rng() * ITEM_KINDS.reduce((sum, kind) => sum + weights[kind], 0);
    for (const kind of ITEM_KINDS) {
      roll -= weights[kind];
      if (roll <= 0) return kind;
    }
    return 'boost';
  }

  /** The nearest ship in front of a cork, which it bends its flight towards. */
  private aimFor(shot: Shot, ships: ItemUser[]): ItemUser | null {
    let best: ItemUser | null = null;
    let nearest = CORK_RANGE;
    for (const ship of ships) {
      if (ship.id === shot.owner || ship.sinking > 0) continue;
      const dx = ship.state.x - shot.x;
      const dz = ship.state.z - shot.z;
      const d = Math.hypot(dx, dz);
      const inFront = dx * Math.sin(shot.heading) + dz * Math.cos(shot.heading) > 0;
      if (inFront && d < nearest) {
        nearest = d;
        best = ship;
      }
    }
    return best;
  }
}

function touches(ship: ItemUser, x: number, z: number, r: number): boolean {
  if (Math.hypot(ship.state.x - x, ship.state.z - z) > ship.cls.length / 2 + r) return false;
  return hullCircles(ship.state, ship.cls).some((c) => Math.hypot(c.x - x, c.z - z) < c.r + r);
}

function eventAt(kind: RaceEvent['kind'], ship: ItemUser, x: number, z: number): RaceEvent {
  return { kind, shipId: ship.id, x: ship.state.x, z: ship.state.z, fromX: x, fromZ: z, heavy: false };
}
