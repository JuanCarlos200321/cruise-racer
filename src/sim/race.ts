import { AiDriver } from './ai';
import { resolveObstacles, resolveShips } from './collision';
import { createShipState, forward, starboard, stepShip, type Helm, type ShipState } from './physics';
import type { ShipClass } from './ships';
import type { Track } from './track';

export interface RaceEntry {
  cls: ShipClass;
  name: string;
  isPlayer: boolean;
  /** AI pace, 0..1. */
  pace: number;
}

export interface Racer {
  id: number;
  name: string;
  cls: ShipClass;
  isPlayer: boolean;
  state: ShipState;
  ai: AiDriver;
  /** Nearest centreline sample. */
  trackIndex: number;
  /** Distance from the centreline, metres. Positive is to starboard. */
  lateral: number;
  /** Samples travelled since the start line. Negative on the grid. */
  progress: number;
  lapsDone: number;
  lapTimes: number[];
  lapStart: number;
  finished: boolean;
  finishTime: number;
  offCourse: boolean;
  drafting: boolean;
  /** Speed of the hardest collision this step, m/s. */
  impact: number;
  /** Seconds this ship has been all but stopped during the race. */
  stalledFor: number;
}

export type RacePhase = 'countdown' | 'racing';

export const COUNTDOWN_SECONDS = 4;
const OFF_COURSE_DRAG = 4;
const DRAFT_DRAG = 0.8;
const DRAFT_LENGTH = 450;
const GRID_FRONT_ROW = 260;
const GRID_ROW_GAP = 440;
const GRID_LANES = [-0.5, 0, 0.5];
/** An AI ship stopped for this long is put back on the course. */
const AI_RESCUE_AFTER = 10;

export class Race {
  readonly track: Track;
  readonly totalLaps: number;
  readonly racers: Racer[] = [];
  phase: RacePhase = 'countdown';
  /** Seconds until the start. */
  countdown = COUNTDOWN_SECONDS;
  /** Seconds since the start. */
  time = 0;

  /** Entries are placed on the grid in order: front row first, port to starboard. */
  constructor(track: Track, entries: RaceEntry[], totalLaps: number) {
    this.track = track;
    this.totalLaps = totalLaps;
    entries.forEach((entry, slot) => {
      const row = Math.floor(slot / GRID_LANES.length);
      const lane = GRID_LANES[slot % GRID_LANES.length] * track.halfWidth;
      const back = Math.round((GRID_FRONT_ROW + row * GRID_ROW_GAP) / track.spacing);
      const index = track.wrap(-back);
      const p = track.pointAt(index, lane);
      this.racers.push({
        id: slot,
        name: entry.name,
        cls: entry.cls,
        isPlayer: entry.isPlayer,
        state: createShipState(p.x, p.z, track.headingAt(index)),
        ai: new AiDriver(entry.pace, lane * 0.8),
        trackIndex: index,
        lateral: lane,
        progress: -back,
        lapsDone: 0,
        lapTimes: [],
        lapStart: 0,
        finished: false,
        finishTime: 0,
        offCourse: false,
        drafting: false,
        impact: 0,
        stalledFor: 0,
      });
    });
  }

  get player(): Racer {
    const player = this.racers.find((r) => r.isPlayer);
    if (!player) throw new Error('Race has no player');
    return player;
  }

  /** Lap a racer is on, 1-based, capped at the race length. */
  lapOf(racer: Racer): number {
    return Math.min(this.totalLaps, racer.lapsDone + 1);
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

  /** Advance the race. playerHelm is ignored once the player has finished. */
  step(dt: number, playerHelm: Helm): void {
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown > 0) return;
      this.phase = 'racing';
    }
    this.time += dt;

    for (const racer of this.racers) {
      const others = this.racers.filter((r) => r !== racer);
      const helm =
        racer.isPlayer && !racer.finished
          ? playerHelm
          : racer.ai.helm(racer.state, racer.cls, this.track, racer.trackIndex, others, dt);
      racer.drafting = this.isDrafting(racer, others);
      let drag = 1;
      if (racer.offCourse) drag = OFF_COURSE_DRAG;
      else if (racer.drafting) drag = DRAFT_DRAG;
      stepShip(racer.state, helm, racer.cls, dt, drag);
    }

    for (const racer of this.racers) {
      racer.impact = resolveObstacles(racer.state, racer.cls, this.track.obstacles);
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
      const aiHelmed = !racer.isPlayer || racer.finished;
      racer.stalledFor = Math.abs(racer.state.u) < 5 ? racer.stalledFor + dt : 0;
      if (aiHelmed && racer.stalledFor > AI_RESCUE_AFTER) {
        this.resetToCheckpoint(racer);
        racer.stalledFor = 0;
      }
    }
  }

  /** Put a racer back on the centreline at the last checkpoint, stopped. */
  resetToCheckpoint(racer: Racer): void {
    const n = this.track.sampleCount;
    let back = Infinity;
    for (const checkpoint of this.track.checkpoints) {
      const behind = this.track.wrap(racer.trackIndex - checkpoint);
      if (behind < back) back = behind;
    }
    if (back > n / 2) back = 0;
    const index = this.track.wrap(racer.trackIndex - back);
    const p = this.track.pointAt(index);
    racer.state = createShipState(p.x, p.z, this.track.headingAt(index));
    racer.trackIndex = index;
    racer.progress -= back;
    racer.lateral = 0;
    racer.offCourse = false;
  }

  /** Checkpoint the racer is heading for next, as an index into track.checkpoints. */
  nextCheckpoint(racer: Racer): number {
    const checkpoints = this.track.checkpoints;
    let best = 0;
    let bestAhead = Infinity;
    checkpoints.forEach((checkpoint, k) => {
      const ahead = this.track.wrap(checkpoint - racer.trackIndex - 1);
      if (ahead < bestAhead) {
        bestAhead = ahead;
        best = k;
      }
    });
    return best;
  }

  /** True when the ship is pointing against the direction of the course. */
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
    const n = this.track.sampleCount;
    const pos = this.track.nearest(racer.state.x, racer.state.z, racer.trackIndex);
    let delta = pos.index - racer.trackIndex;
    if (delta > n / 2) delta -= n;
    if (delta < -n / 2) delta += n;
    racer.progress += delta;
    racer.trackIndex = pos.index;
    racer.lateral = pos.lateral;
    racer.offCourse = Math.abs(pos.lateral) > this.track.halfWidth;

    if (racer.finished) return;
    const lapsDone = Math.floor(racer.progress / n);
    if (lapsDone > racer.lapsDone) {
      racer.lapsDone = lapsDone;
      racer.lapTimes.push(this.time - racer.lapStart);
      racer.lapStart = this.time;
      if (racer.lapsDone >= this.totalLaps) {
        racer.finished = true;
        racer.finishTime = this.time;
      }
    }
  }
}
