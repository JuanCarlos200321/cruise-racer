import { AiDriver } from './ai';
import { resolveObstacles, resolveShips } from './collision';
import { HazardField, type HazardEvent } from './hazards';
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

/** A race from the start line of a route to its finish line. */
export class Race {
  readonly track: Track;
  readonly racers: Racer[] = [];
  readonly hazards: HazardField | null;
  /** Hazard hits since the list was last emptied. The caller empties it. */
  readonly events: HazardEvent[] = [];
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
      let helm: Helm;
      const human = racer.autopilot || racer.finished ? null : racer.isPlayer ? playerHelm : racer.helm;
      if (human) {
        helm = human;
      } else {
        helm = racer.ai.helm(racer, this.track, others, dt, hazards);
        // Past the line, ships come to a stop in the water off the destination.
        if (racer.finished) helm = { throttle: racer.state.u > 2 ? -1 : 0, rudder: helm.rudder };
      }
      racer.drafting = this.isDrafting(racer, others);
      let drag = 1;
      if (racer.offCourse) drag = OFF_COURSE_DRAG;
      else if (racer.drafting) drag = DRAFT_DRAG;
      stepShip(racer.state, helm, racer.cls, dt, drag);
    }

    if (this.hazards) {
      for (const event of this.hazards.step(dt, this.racers)) {
        this.racers[event.shipId].hazardHits++;
        this.events.push(event);
      }
    }
    const solids = this.hazards?.solids() ?? [];

    for (const racer of this.racers) {
      racer.impact = resolveObstacles(racer.state, racer.cls, this.track.obstacles);
      if (solids.length) {
        racer.impact = Math.max(racer.impact, resolveObstacles(racer.state, racer.cls, solids));
      }
    }
    for (let i = 0; i < this.racers.length; i++) {
      for (let j = i + 1; j < this.racers.length; j++) {
        const a = this.racers[i];
        const b = this.racers[j];
        const impact = resolveShips(a.state, a.cls, b.state, b.cls);
        a.impact = Math.max(a.impact, impact);
        b.impact = Math.max(b.impact, impact);
      }
    }

    for (const racer of this.racers) {
      this.updateProgress(racer);
      if (racer.finished) continue;
      const held = this.hazards?.isHeld(racer.id) ?? false;
      if (held) racer.ai.held();
      racer.stalledFor = Math.abs(racer.state.u) < 5 && !held ? racer.stalledFor + dt : 0;
      if (racer.autopilot && racer.stalledFor > AI_RESCUE_AFTER) {
        this.resetToCheckpoint(racer);
        racer.stalledFor = 0;
      }
    }
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
