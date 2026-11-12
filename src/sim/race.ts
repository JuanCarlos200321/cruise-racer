import { AiDriver } from './ai';
import { resolveObstacles, resolveShips } from './collision';
import { absorb, hurt, type RaceEvent } from './events';
import { HazardField } from './hazards';
import { ItemField, type ItemKind } from './items';
import { createShipState, forward, starboard, stepShip, type Helm, type ShipState } from './physics';
import type { ShipClass } from './ships';
import type { Track } from './track';

export interface RaceEntry {
  cls: ShipClass;
  name: string;
  isPlayer: boolean;
  /** AI pace, 0..1. */
  pace: number;
  /** Let the AI steer the player's ship, for demos. */
  autopilot?: boolean;
  /** Steered by another player over the network, through the racer's helm. */
  human?: boolean;
}

export interface RaceOptions {
  /** Put the route's hazards in the water. On by default. */
  hazards?: boolean;
  /** Put power-up boxes on the route. On wherever the hazards are, unless set. */
  items?: boolean;
  /** Send ships back to the start when they reach the end, for the cruise behind the menus. */
  loop?: boolean;
}

export interface Racer {
  id: number;
  name: string;
  cls: ShipClass;
  isPlayer: boolean;
  /** True when the AI is at the helm. */
  autopilot: boolean;
  /** Helm orders from a player elsewhere. Null for the local player and AI ships. */
  helm: Helm | null;
  state: ShipState;
  ai: AiDriver;
  /** Nearest centreline sample. */
  trackIndex: number;
  /** Distance from the centreline, metres. Positive is to starboard. */
  lateral: number;
  /** Samples travelled since the start line. Negative on the grid. */
  progress: number;
  finished: boolean;
  finishTime: number;
  offCourse: boolean;
  drafting: boolean;
  /** Speed of the hardest collision this step, m/s. */
  impact: number;
  /** Seconds this ship has been all but stopped during the race. */
  stalledFor: number;
  /** Times a hazard has caught this ship. */
  hazardHits: number;
  /** State of the hull, from 1 (sound) to 0 (going down). A damaged ship is slower. */
  hull: number;
  /** Seconds left going down, or 0 when afloat. The ship comes back at the last checkpoint. */
  sinking: number;
  /** The power-up the ship is holding, and for how many seconds it has had it. */
  item: ItemKind | null;
  itemHeld: number;
  /** Seconds of boost and of shield left. */
  boost: number;
  shield: number;
  /** Seconds until another collision can damage the ship: one crash is one blow, however long the hulls grind. */
  crashProof: number;
}

export type RacePhase = 'countdown' | 'racing';

export const COUNTDOWN_SECONDS = 4;
const OFF_COURSE_DRAG = 4;
const DRAFT_DRAG = 0.8;
const DRAFT_LENGTH = 450;
const GRID_FRONT_ROW = 260;
const GRID_ROW_GAP = 440;
const GRID_LANES = [-0.5, 0, 0.5];
/** An AI ship stopped for this long is put back on the route. */
const AI_RESCUE_AFTER = 10;
/** Closing speed below which a bump does no damage, m/s. */
const CRASH_THRESHOLD = 14;
/** Hull lost per m/s of closing speed above that. */
const CRASH_DAMAGE = 0.006;
/** The most one collision can take off the hull. */
const CRASH_LIMIT = 0.6;
const CRASH_COOLDOWN = 1.2;
/** Extra drag on a ship with no hull left, as a share of normal drag. */
const DAMAGE_DRAG = 0.6;
export const SINK_SECONDS = 4.5;
const SINKING_DRAG = 10;
/** Shield a ship gets when it comes back after sinking, seconds. */
const RESPAWN_SHIELD = 4;
const BOOST_DRAG = 0.55;
/** Extra push while boosting, as a share of the ship's acceleration. */
const BOOST_THRUST = 1.2;
const HAZARD_KINDS = new Set(['sharks', 'kraken', 'wave', 'pirate', 'whale']);

function crashDamage(impact: number): number {
  return Math.min(CRASH_LIMIT, Math.max(0, impact - CRASH_THRESHOLD) * CRASH_DAMAGE);
}

/** A race from the start line of a route to its finish line. */
export class Race {
  readonly track: Track;
  readonly racers: Racer[] = [];
  readonly hazards: HazardField | null;
  readonly items: ItemField | null;
  /** What has happened since the list was last emptied. The caller empties it. */
  readonly events: RaceEvent[] = [];
  phase: RacePhase = 'countdown';
  /** Seconds until the start. */
  countdown = COUNTDOWN_SECONDS;
  /** Seconds since the start. */
  time = 0;
  private readonly loop: boolean;

  /** Entries are placed on the grid in order: front row first, port to starboard. */
  constructor(track: Track, entries: RaceEntry[], options: RaceOptions = {}) {
    this.track = track;
    this.loop = options.loop ?? false;
    this.hazards = (options.hazards ?? true) ? new HazardField(track) : null;
    this.items = (options.items ?? options.hazards ?? true) ? new ItemField(track) : null;
    entries.forEach((entry, slot) => {
      const row = Math.floor(slot / GRID_LANES.length);
      const lane = GRID_LANES[slot % GRID_LANES.length] * Math.min(track.halfWidth, 300);
      const back = Math.round((GRID_FRONT_ROW + row * GRID_ROW_GAP) / track.spacing);
      const index = track.clampIndex(track.startIndex - back);
      const p = track.pointAt(index, lane);
      this.racers.push({
        id: slot,
        name: entry.name,
        cls: entry.cls,
        isPlayer: entry.isPlayer,
        autopilot: entry.autopilot ?? !(entry.isPlayer || entry.human),
        helm: entry.human ? { throttle: 0, rudder: 0 } : null,
        state: createShipState(p.x, p.z, track.headingAt(index)),
        ai: new AiDriver(entry.pace, lane * 0.45),
        trackIndex: index,
        lateral: lane,
        progress: index - track.startIndex,
        finished: false,
        finishTime: 0,
        offCourse: false,
        drafting: false,
        impact: 0,
        stalledFor: 0,
        hazardHits: 0,
        hull: 1,
        sinking: 0,
        item: null,
        itemHeld: 0,
        boost: 0,
        shield: 0,
        crashProof: 0,
      });
    });
  }

  get player(): Racer {
    const player = this.racers.find((r) => r.isPlayer);
    if (!player) throw new Error('Race has no player');
    return player;
  }

  /** Metres a racer still has to go to the finish line. */
  distanceToGo(racer: Racer): number {
    return Math.max(0, this.track.finishIndex - racer.trackIndex) * this.track.spacing;
  }

  /** Racers in race order: finishers by time, then the rest by distance covered. */
  standings(): Racer[] {
    return [...this.racers].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return b.progress - a.progress;
    });
  }

  positionOf(racer: Racer): number {
    return this.standings().indexOf(racer) + 1;
  }

  /**
   * Advance the race. playerHelm steers the local player's ship; ships of
   * players elsewhere follow their own helm. Both are ignored once finished.
   */
  step(dt: number, playerHelm: Helm): void {
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown > 0) return;
      this.phase = 'racing';
    }
    this.time += dt;

    const hazards = this.hazards?.hazards ?? [];
    for (const racer of this.racers) {
      const others = this.racers.filter((r) => r !== racer);
      racer.boost = Math.max(0, racer.boost - dt);
      racer.shield = Math.max(0, racer.shield - dt);
      racer.crashProof = Math.max(0, racer.crashProof - dt);
      if (racer.item) racer.itemHeld += dt;

      let helm: Helm;
      const human = racer.autopilot || racer.finished ? null : racer.isPlayer ? playerHelm : racer.helm;
      if (racer.sinking > 0) {
        helm = { throttle: 0, rudder: 0 };
      } else if (human) {
        helm = human;
      } else {
        helm = racer.ai.helm(racer, this.track, others, dt, hazards);
        // Past the line, ships come to a stop in the water off the destination.
        if (racer.finished) helm = { throttle: racer.state.u > 2 ? -1 : 0, rudder: helm.rudder };
        else if (this.items?.shouldUse(racer, this.racers)) this.items.use(racer);
      }
      racer.drafting = this.isDrafting(racer, others);
      let drag = 1;
      if (racer.offCourse) drag = OFF_COURSE_DRAG;
      else if (racer.drafting) drag = DRAFT_DRAG;
      drag *= 1 + (1 - racer.hull) * DAMAGE_DRAG;
      if (racer.sinking > 0) drag *= SINKING_DRAG;
      else if (racer.boost > 0) drag *= BOOST_DRAG;
      stepShip(racer.state, helm, racer.cls, dt, drag);
      if (racer.boost > 0 && racer.sinking <= 0) racer.state.u += racer.cls.accel * BOOST_THRUST * dt;
    }

    if (this.hazards) {
      for (const event of this.hazards.step(dt, this.racers)) {
        if (event.shipId >= 0 && HAZARD_KINDS.has(event.kind)) this.racers[event.shipId].hazardHits++;
        this.events.push(event);
      }
    }
    if (this.items) this.events.push(...this.items.step(dt, this.racers));
    const solids = this.hazards?.solids() ?? [];

    for (const racer of this.racers) {
      racer.impact = resolveObstacles(racer.state, racer.cls, this.track.obstacles);
      if (solids.length) {
        racer.impact = Math.max(racer.impact, resolveObstacles(racer.state, racer.cls, solids));
      }
      this.crash(racer, crashDamage(racer.impact));
    }
    for (let i = 0; i < this.racers.length; i++) {
      for (let j = i + 1; j < this.racers.length; j++) {
        const a = this.racers[i];
        const b = this.racers[j];
        const impact = resolveShips(a.state, a.cls, b.state, b.cls);
        if (impact <= 0) continue;
        a.impact = Math.max(a.impact, impact);
        b.impact = Math.max(b.impact, impact);
        // The lighter ship comes off worse.
        const total = a.cls.mass + b.cls.mass;
        this.crash(a, (crashDamage(impact) * 2 * b.cls.mass) / total);
        this.crash(b, (crashDamage(impact) * 2 * a.cls.mass) / total);
      }
    }

    for (const racer of this.racers) {
      if (racer.sinking > 0) {
        racer.sinking -= dt;
        if (racer.sinking <= 0) {
          racer.sinking = 0;
          if (!racer.finished) this.resetToCheckpoint(racer);
          racer.hull = 1;
          racer.shield = RESPAWN_SHIELD;
        }
      } else if (racer.hull <= 0) {
        racer.sinking = SINK_SECONDS;
        racer.boost = 0;
        racer.item = null;
        racer.stalledFor = 0;
        this.events.push(this.eventFor('sunk', racer, true));
      }
      this.updateProgress(racer);
      if (racer.finished || racer.sinking > 0) continue;
      const held = this.hazards?.isHeld(racer.id) ?? false;
      if (held) racer.ai.held();
      racer.stalledFor = Math.abs(racer.state.u) < 5 && !held ? racer.stalledFor + dt : 0;
      if (racer.autopilot && racer.stalledFor > AI_RESCUE_AFTER) {
        this.resetToCheckpoint(racer);
        racer.stalledFor = 0;
      }
    }
  }

  /** Use the power-up a racer is holding, if the race is under way. */
  useItem(racer: Racer): void {
    if (this.phase === 'racing') this.items?.use(racer);
  }

  /** Take hull off a racer for a collision, unless its shield takes it. */
  private crash(racer: Racer, damage: number): void {
    if (damage < 0.01 || racer.sinking > 0 || racer.crashProof > 0) return;
    racer.crashProof = CRASH_COOLDOWN;
    if (absorb(racer)) {
      this.events.push(this.eventFor('blocked', racer, false));
      return;
    }
    hurt(racer, Math.min(CRASH_LIMIT, damage));
    this.events.push(this.eventFor('crash', racer, damage > 0.2));
  }

  private eventFor(kind: RaceEvent['kind'], racer: Racer, heavy: boolean): RaceEvent {
    const { x, z } = racer.state;
    return { kind, shipId: racer.id, x, z, fromX: x, fromZ: z, heavy };
  }

  /** Put a racer back on the centreline at the last checkpoint passed, stopped. */
  resetToCheckpoint(racer: Racer): void {
    let index = this.track.checkpoints[0];
    for (const checkpoint of this.track.checkpoints) {
      if (checkpoint <= racer.trackIndex) index = checkpoint;
    }
    this.placeAt(racer, index);
  }

  /** Put a racer on the centreline at a sample, stopped and facing along the route. */
  private placeAt(racer: Racer, index: number): void {
    const p = this.track.pointAt(index);
    racer.state = createShipState(p.x, p.z, this.track.headingAt(index));
    racer.trackIndex = index;
    racer.lateral = 0;
    racer.progress = index - this.track.startIndex;
    racer.offCourse = false;
  }

  /** Start a racer part of the way along the route, already under way. Used behind the menus. */
  cruiseFrom(racer: Racer, fraction: number, speedFraction: number): void {
    const { startIndex, finishIndex } = this.track;
    this.placeAt(racer, startIndex + Math.round(fraction * (finishIndex - startIndex)));
    racer.state.u = racer.cls.topSpeed * speedFraction;
    racer.state.throttle = speedFraction * speedFraction;
    this.countdown = 0;
  }

  /** Checkpoint the racer is heading for next, as an index into track.checkpoints. */
  nextCheckpoint(racer: Racer): number {
    const checkpoints = this.track.checkpoints;
    const next = checkpoints.findIndex((checkpoint) => checkpoint > racer.trackIndex);
    return next < 0 ? checkpoints.length - 1 : next;
  }

  /** True when the ship is pointing against the direction of the route. */
  isWrongWay(racer: Racer): boolean {
    const t = this.track.tangents[racer.trackIndex];
    const f = forward(racer.state.heading);
    return f.x * t.x + f.z * t.z < -0.3;
  }

  private isDrafting(racer: Racer, others: Racer[]): boolean {
    const f = forward(racer.state.heading);
    const sb = starboard(racer.state.heading);
    for (const other of others) {
      const dx = other.state.x - racer.state.x;
      const dz = other.state.z - racer.state.z;
      const ahead = dx * f.x + dz * f.z;
      const side = Math.abs(dx * sb.x + dz * sb.z);
      const gap = ahead - (racer.cls.length + other.cls.length) / 2;
      if (gap > 0 && gap < DRAFT_LENGTH && side < other.cls.beam && other.state.u > 20) return true;
    }
    return false;
  }

  private updateProgress(racer: Racer): void {
    const track = this.track;
    const pos = track.nearest(racer.state.x, racer.state.z, racer.trackIndex);
    racer.trackIndex = pos.index;
    racer.progress = pos.index - track.startIndex;
    racer.lateral = pos.lateral;
    racer.offCourse = Math.abs(pos.lateral) > track.halfWidth;

    if (pos.index < track.finishIndex) return;
    if (this.loop) {
      const speed = racer.state.u;
      const throttle = racer.state.throttle;
      this.placeAt(racer, track.startIndex);
      racer.state.u = speed;
      racer.state.throttle = throttle;
    } else if (!racer.finished) {
      racer.finished = true;
      racer.finishTime = this.time;
    }
  }
}
