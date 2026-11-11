import { hullCircles } from './collision';
import { forward, starboard, type ShipState } from './physics';
import { createRng } from './rng';
import type { ShipClass } from './ships';
import type { HazardKind, Obstacle, Track } from './track';

/** Something in the water to steer round. */
export interface Hazard {
  id: number;
  kind: HazardKind;
  x: number;
  z: number;
  /** Direction it faces or travels. */
  heading: number;
  /** Radius of the water to keep clear of, metres. */
  r: number;
  /** Position on the route: centreline sample and distance to starboard of it. */
  index: number;
  lateral: number;
  /** 0..1. Waves build up and die away; everything else is always 1. */
  strength: number;
}

/** A ship the hazards can act on. */
export interface HazardTarget {
  id: number;
  state: ShipState;
  cls: ShipClass;
}

export interface HazardEvent {
  kind: HazardKind;
  shipId: number;
  /** Where it happened. */
  x: number;
  z: number;
  /** Where it came from. */
  fromX: number;
  fromZ: number;
  /** True for the worst outcome: a wave taken at speed or on the beam. */
  heavy: boolean;
}

export const HAZARD_NAMES: Record<HazardKind, string> = {
  sharks: 'Sharks',
  kraken: 'Kraken',
  wave: 'Rogue wave',
  pirate: 'Pirate ship',
};

/** Share of the route, from the start line, before the first hazard and after the last. */
const FIRST_AT = 0.1;
const LAST_AT = 0.93;

/** Sharks hold a ship to this share of its top speed. */
const SHARK_SPEED_CAP = 0.4;
const SHARK_PATROL_RATE = 0.1; // rad/s
const KRAKEN_HOLD = 3.5;
const KRAKEN_RELEASE = 20;
const WAVE_SPEED = 24;
/** A wave runs this far either side of where it is centred, metres. */
const WAVE_RUN = 900;
const WAVE_RAMP = 300;
const WAVE_THICKNESS = 34;
const WAVE_COOLDOWN = 6;
/** Above this share of top speed a wave slams the ship even bow-on. */
const WAVE_SAFE_SPEED = 0.6;
const WAVE_SHOVE = 16;
const PIRATE_SPEED = 13;
export const PIRATE_HULL_RADIUS = 46;
export const CANNON_RANGE = 260;
const CANNON_RELOAD = 2;
/** A ship that has been hit is not fired on again until it has had time to get past. */
const CANNON_COOLDOWN = 25;
/** Radius of the circle the galleon sails round, as a share of the channel half-width. */
const PIRATE_CIRCLE = 0.25;
const CANNON_SPEED_KEPT = 0.72;

interface Live extends Hazard {
  home: number;
  homeLateral: number;
  phase: number;
  /** Per-ship timers, by ship id. */
  cooldown: Map<number, number>;
  held: Map<number, number>;
  inside: Set<number>;
  /** Wave: metres along the route, the side it is on, and its half-length. Pirate: reload timer. */
  along: number;
  side: number;
  reload: number;
}

/** All the hazards on a route: moves them and applies them to ships. */
export class HazardField {
  readonly hazards: Hazard[];
  private readonly live: Live[] = [];
  private readonly track: Track;
  private time = 0;

  constructor(track: Track) {
    this.track = track;
    const rng = createRng(track.def.seed * 7 + 3);
    const kinds = track.def.hazards;
    const span = track.finishIndex - track.startIndex;
    const hw = track.halfWidth;
    kinds.forEach((kind, i) => {
      const share = kinds.length === 1 ? 0.5 : i / (kinds.length - 1);
      const home = track.startIndex + Math.round(span * (FIRST_AT + (LAST_AT - FIRST_AT) * share));
      const side = rng() < 0.5 ? -1 : 1;
      let homeLateral = 0;
      let r = 0;
      if (kind === 'sharks') {
        homeLateral = side * rng() * 0.3 * hw;
        r = 0.27 * hw;
      } else if (kind === 'kraken') {
        homeLateral = side * (0.1 + rng() * 0.35) * hw;
        r = 0.3 * hw;
      } else if (kind === 'wave') {
        homeLateral = 0.42 * hw;
        r = 0.55 * hw;
      } else {
        // Off to one side, so the far side of the channel is out of range of its guns.
        homeLateral = side * (0.3 + rng() * 0.2) * hw;
        r = CANNON_RANGE;
      }
      const p = track.pointAt(home, homeLateral);
      this.live.push({
        id: i,
        kind,
        x: p.x,
        z: p.z,
        heading: track.headingAt(home) + Math.PI,
        r,
        index: home,
        lateral: homeLateral,
        strength: 1,
        home,
        homeLateral,
        phase: rng() * Math.PI * 2,
        cooldown: new Map(),
        held: new Map(),
        inside: new Set(),
        along: home * track.spacing + (rng() - 0.5) * WAVE_RUN,
        side,
        reload: 0,
      });
    });
    this.hazards = this.live;
    this.step(0, []);
  }

  /** Solid things ships bump into: the pirate ships' hulls. */
  solids(): Obstacle[] {
    return this.live
      .filter((h) => h.kind === 'pirate')
      .map((h) => ({ x: h.x, z: h.z, r: PIRATE_HULL_RADIUS, kind: 'rocks' as const, seed: 0 }));
  }

  /** True while a kraken has hold of a ship. */
  isHeld(shipId: number): boolean {
    return this.live.some((h) => (h.held.get(shipId) ?? 0) > 0);
  }

  /** Move every hazard on by dt and apply them to the ships. Returns what happened. */
  step(dt: number, ships: HazardTarget[]): HazardEvent[] {
    this.time += dt;
    const events: HazardEvent[] = [];
    for (const h of this.live) {
      for (const [id, left] of h.cooldown) h.cooldown.set(id, left - dt);
      if (h.kind === 'sharks') this.stepSharks(h, dt, ships, events);
      else if (h.kind === 'kraken') this.stepKraken(h, dt, ships, events);
      else if (h.kind === 'wave') this.stepWave(h, dt, ships, events);
      else this.stepPirate(h, dt, ships, events);
    }
    return events;
  }

  private stepSharks(h: Live, dt: number, ships: HazardTarget[], events: HazardEvent[]): void {
    const track = this.track;
    h.lateral = h.homeLateral + Math.sin(this.time * SHARK_PATROL_RATE + h.phase) * 0.3 * track.halfWidth;
    const p = track.pointAt(h.home, h.lateral);
    h.x = p.x;
    h.z = p.z;
    for (const ship of ships) {
      if (!touches(ship, h.x, h.z, h.r * 0.85)) {
        h.inside.delete(ship.id);
        continue;
      }
      const s = ship.state;
      const cap = ship.cls.topSpeed * SHARK_SPEED_CAP;
      if (s.u > cap) s.u -= (s.u - cap) * Math.min(1, 2.5 * dt);
      if (!h.inside.has(ship.id)) {
        h.inside.add(ship.id);
        events.push(event(h, ship, false));
      }
    }
  }

  private stepKraken(h: Live, dt: number, ships: HazardTarget[], events: HazardEvent[]): void {
    for (const ship of ships) {
      const s = ship.state;
      const held = h.held.get(ship.id) ?? 0;
      if (held > 0) {
        const keep = Math.exp(-3 * dt);
        s.u *= keep;
        s.v *= keep;
        s.r *= keep;
        h.held.set(ship.id, held - dt);
        if (held - dt <= 0) h.cooldown.set(ship.id, KRAKEN_RELEASE);
      } else if ((h.cooldown.get(ship.id) ?? 0) <= 0 && touches(ship, h.x, h.z, h.r * 0.75)) {
        h.held.set(ship.id, KRAKEN_HOLD);
        events.push(event(h, ship, true));
      }
    }
  }

  private stepWave(h: Live, dt: number, ships: HazardTarget[], events: HazardEvent[]): void {
    const track = this.track;
    const centre = h.home * track.spacing;
    const top = Math.min(centre + WAVE_RUN, track.finishIndex * track.spacing);
    const bottom = Math.max(centre - WAVE_RUN, 0);
    h.along -= WAVE_SPEED * dt;
    if (h.along < bottom) {
      // Start again from the far end, on the other side of the channel.
      h.along = top;
      h.side = -h.side;
    }
    h.strength = Math.max(0, Math.min(1, (top - h.along) / WAVE_RAMP, (h.along - bottom) / WAVE_RAMP));
    h.index = track.clampIndex(h.along / track.spacing);
    h.lateral = h.side * h.homeLateral;
    const p = track.pointAt(h.index, h.lateral);
    const t = track.tangents[h.index];
    h.x = p.x;
    h.z = p.z;
    h.heading = Math.atan2(-t.x, -t.z);
    if (h.strength < 0.5) return;

    for (const ship of ships) {
      if ((h.cooldown.get(ship.id) ?? 0) > 0) continue;
      const s = ship.state;
      const dx = s.x - h.x;
      const dz = s.z - h.z;
      const along = dx * t.x + dz * t.z;
      const across = dx * -t.z + dz * t.x;
      const f = forward(s.heading);
      const bowOn = Math.abs(f.x * t.x + f.z * t.z);
      if (Math.abs(along) > WAVE_THICKNESS || Math.abs(across) > h.r) continue;

      h.cooldown.set(ship.id, WAVE_COOLDOWN);
      const fast = Math.abs(s.u) > ship.cls.topSpeed * WAVE_SAFE_SPEED;
      const heavy = fast || bowOn < 0.85;
      if (heavy) {
        const sb = starboard(s.heading);
        s.u *= bowOn < 0.85 ? 0.35 : 0.45;
        // The wave carries the ship back the way it came.
        s.u += -WAVE_SHOVE * (t.x * f.x + t.z * f.z);
        s.v += -WAVE_SHOVE * (t.x * sb.x + t.z * sb.z);
        s.r += (bowOn < 0.85 ? 0.12 : 0.04) * Math.sign(across || 1);
      } else {
        s.u *= 0.92;
      }
      events.push(event(h, ship, heavy));
    }
  }

  private stepPirate(h: Live, dt: number, ships: HazardTarget[], events: HazardEvent[]): void {
    const track = this.track;
    // The galleon sails round in a circle on its side of the channel.
    const radius = PIRATE_CIRCLE * track.halfWidth;
    const angle = h.phase + (this.time * PIRATE_SPEED * h.side) / radius;
    const centre = track.pointAt(h.home, h.homeLateral);
    const t = track.tangents[h.home];
    const a = Math.cos(angle) * radius;
    const b = Math.sin(angle) * radius;
    h.x = centre.x + t.x * a - t.z * b;
    h.z = centre.z + t.z * a + t.x * b;
    const va = -Math.sin(angle) * h.side;
    const vb = Math.cos(angle) * h.side;
    h.heading = Math.atan2(t.x * va - t.z * vb, t.z * va + t.x * vb);
    h.index = track.clampIndex(h.home + a / track.spacing);
    h.lateral = h.homeLateral + b;

    h.reload -= dt;
    if (h.reload > 0) return;
    let target: HazardTarget | null = null;
    let nearest = CANNON_RANGE;
    for (const ship of ships) {
      if ((h.cooldown.get(ship.id) ?? 0) > 0) continue;
      const d = Math.hypot(ship.state.x - h.x, ship.state.z - h.z);
      if (d < nearest) {
        nearest = d;
        target = ship;
      }
    }
    if (!target) return;
    target.state.u *= CANNON_SPEED_KEPT;
    h.cooldown.set(target.id, CANNON_COOLDOWN);
    h.reload = CANNON_RELOAD;
    events.push(event(h, target, false));
  }
}

function touches(ship: HazardTarget, x: number, z: number, r: number): boolean {
  if (Math.hypot(ship.state.x - x, ship.state.z - z) > ship.cls.length / 2 + r) return false;
  return hullCircles(ship.state, ship.cls).some((c) => Math.hypot(c.x - x, c.z - z) < c.r + r);
}

function event(h: Hazard, ship: HazardTarget, heavy: boolean): HazardEvent {
  return {
    kind: h.kind,
    shipId: ship.id,
    x: ship.state.x,
    z: ship.state.z,
    fromX: h.x,
    fromZ: h.z,
    heavy,
  };
}
