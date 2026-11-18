import { AiDriver } from './ai';
import { resolveObstacles, resolveShips } from './collision';
import { absorb, wear, type RaceEvent } from './events';
import { HazardField, PIRATE_HULL_RADIUS } from './hazards';
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
  /** State of the hull, from 1 (shipshape) to 0 (due in dry dock). Each bump takes a third. A worn ship is slower. */
  hull: number;
  /** Seconds left in dry dock, or 0 when under way. The ship is held where it was when the dock came up. */
  docked: number;
  /** The power-up the ship is holding, and for how many seconds it has had it. */
  item: ItemKind | null;
  itemHeld: number;
  /** Seconds of boost and of shield left. */
  boost: number;
  shield: number;
  /** Seconds until another bump counts: one meeting of hulls is one bump, however long they rub. */
  bumpProof: number;
  /** Where the ship was and how it was heading when the dry dock came up under it. */
  dockX: number;
  dockZ: number;
  dockHeading: number;
}

export type RacePhase = 'countdown' | 'racing';

export const COUNTDOWN_SECONDS = 4;
const OFF_COURSE_DRAG = 4;
const DRAFT_DRAG = 0.8;
const DRAFT_LENGTH = 450;
/** How far behind the start line the ships line up, metres. */
const GRID_BACK = 260;
/** How much of the channel the line of ships takes up, as a share of its half-width either side. */
const GRID_SPREAD = 0.7;
/** Share of its place on the grid that an AI ship keeps as its lane, so the line does not close up into a scrum. */
const AI_LANE_SHARE = 0.8;
/** An AI ship stopped for this long is put back on the route. */
const AI_RESCUE_AFTER = 10;
/** Closing speed below which a touch does not count as a bump, m/s. */
const BUMP_THRESHOLD = 14;
/** Closing speed above which a bump is shown as a big one, m/s. */
const HEAVY_BUMP = 45;
/** This many bumps send a ship into dry dock. */
export const BUMPS_TO_DOCK = 3;
const BUMP_COOLDOWN = 1.2;
/** Extra drag on a ship with no hull left, as a share of normal drag. */
const WEAR_DRAG = 0.6;
/** How long a ship spends in dry dock before it sets off again. */
export const DOCK_SECONDS = 5;
/** The part of the stay, as shares of it, in which the dock lines its ship up with the route. */
const DOCK_TURN_FROM = 0.25;
const DOCK_TURN_TO = 0.75;
/** Shield a ship gets when it leaves dry dock, seconds. */
const RESPAWN_SHIELD = 4;
const BOOST_DRAG = 0.55;
/** Extra push while boosting, as a share of the ship's acceleration. */
const BOOST_THRUST = 1.2;
const HAZARD_KINDS = new Set(['sharks', 'kraken', 'wave', 'pirate', 'whale']);



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

  /** Entries line up side by side behind the start, in order from port to starboard. */
  constructor(track: Track, entries: RaceEntry[], options: RaceOptions = {}) {
    this.track = track;
    this.loop = options.loop ?? false;
    this.hazards = (options.hazards ?? true) ? new HazardField(track) : null;
    this.items = (options.items ?? options.hazards ?? true) ? new ItemField(track) : null;
    entries.forEach((entry, slot) => {
      const across = entries.length > 1 ? (slot / (entries.length - 1)) * 2 - 1 : 0;
      const lane = across * GRID_SPREAD * track.halfWidth;
      const back = Math.round(GRID_BACK / track.spacing);
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
        ai: new AiDriver(entry.pace, lane * AI_LANE_SHARE),
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
        docked: 0,
        item: null,
        itemHeld: 0,
        boost: 0,
        shield: 0,
        bumpProof: 0,
        dockX: 0,
        dockZ: 0,
        dockHeading: 0,
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

    // The AI gives a pirate ship room but does not try to stay out of range of
    // its guns: that would squeeze a whole field into a sliver of the channel.
    const hazards = (this.hazards?.hazards ?? []).map((h) =>
      h.kind === 'pirate' ? { index: h.index, lateral: h.lateral, strength: h.strength, r: PIRATE_HULL_RADIUS * 2 } : h,
    );
    for (const racer of this.racers) {
      const others = this.racers.filter((r) => r !== racer);
      racer.boost = Math.max(0, racer.boost - dt);
      racer.shield = Math.max(0, racer.shield - dt);
      racer.bumpProof = Math.max(0, racer.bumpProof - dt);
      if (racer.item) racer.itemHeld += dt;

      let helm: Helm;
      const human = racer.autopilot || racer.finished ? null : racer.isPlayer ? playerHelm : racer.helm;
      if (racer.docked > 0) {
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
      drag *= 1 + (1 - racer.hull) * WEAR_DRAG;
      if (racer.boost > 0 && racer.docked <= 0) drag *= BOOST_DRAG;
      stepShip(racer.state, helm, racer.cls, dt, drag);
      if (racer.boost > 0 && racer.docked <= 0) racer.state.u += racer.cls.accel * BOOST_THRUST * dt;
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
      this.bump(racer, racer.impact);
    }
    for (let i = 0; i < this.racers.length; i++) {
      for (let j = i + 1; j < this.racers.length; j++) {
        const a = this.racers[i];
        const b = this.racers[j];
        const impact = resolveShips(a.state, a.cls, b.state, b.cls);
        if (impact <= 0) continue;
        a.impact = Math.max(a.impact, impact);
        b.impact = Math.max(b.impact, impact);
        this.bump(a, impact);
        this.bump(b, impact);
      }
    }

    for (const racer of this.racers) {
      if (racer.docked > 0) {
        racer.docked -= dt;
        if (racer.docked <= 0) {
          racer.docked = 0;
          racer.hull = 1;
          racer.shield = RESPAWN_SHIELD;
        }
      } else if (racer.hull <= 0) {
        racer.docked = DOCK_SECONDS;
        racer.dockX = racer.state.x;
        racer.dockZ = racer.state.z;
        racer.dockHeading = racer.state.heading;
        racer.boost = 0;
        racer.item = null;
        racer.stalledFor = 0;
        this.events.push(this.eventFor('drydock', racer, true));
      }
      if (racer.docked > 0) this.holdInDock(racer);
      this.updateProgress(racer);
      if (racer.finished || racer.docked > 0) continue;
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

  /**
   * The dock holds its ship, whatever runs into it, and while the ship is up
   * out of the water carries it to the middle of the channel and turns it to
   * face along the route, ready to set off for the finish.
   */
  private holdInDock(racer: Racer): void {
    const track = this.track;
    const index = track.clampIndex(racer.trackIndex);
    const centre = track.pointAt(index);
    const through = 1 - racer.docked / DOCK_SECONDS;
    const c = Math.min(1, Math.max(0, (through - DOCK_TURN_FROM) / (DOCK_TURN_TO - DOCK_TURN_FROM)));
    const t = c * c * (3 - 2 * c);
    const turn = track.headingAt(index) - racer.dockHeading;
    Object.assign(racer.state, {
      x: racer.dockX + (centre.x - racer.dockX) * t,
      z: racer.dockZ + (centre.z - racer.dockZ) * t,
      heading: racer.dockHeading + Math.atan2(Math.sin(turn), Math.cos(turn)) * t,
      u: 0,
      v: 0,
      r: 0,
    });
  }

  /** Count a bump against a racer's hull, unless its shield takes it. */
  private bump(racer: Racer, impact: number): void {
    if (impact < BUMP_THRESHOLD || racer.docked > 0 || racer.bumpProof > 0) return;
    racer.bumpProof = BUMP_COOLDOWN;
    if (absorb(racer)) {
      this.events.push(this.eventFor('blocked', racer, false));
      return;
    }
    wear(racer, 1 / BUMPS_TO_DOCK);
    // Thirds do not add up exactly.
    if (racer.hull < 0.01) racer.hull = 0;
    this.events.push(this.eventFor('bump', racer, impact > HEAVY_BUMP));
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
