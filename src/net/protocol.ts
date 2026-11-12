import type { HazardEvent } from '../sim/hazards';
import type { Helm } from '../sim/physics';
import type { Race, RaceEntry, RacePhase } from '../sim/race';
import { SHIP_CLASSES } from '../sim/ships';

/** Most ships in a race, players and AI together. */
export const MAX_PLAYERS = 6;
export const HOST_ID = 'host';
const NAME_LENGTH = 16;

export interface LobbyPlayer {
  id: string;
  name: string;
  /** Index into SHIP_CLASSES. */
  ship: number;
}

export interface Lobby {
  players: LobbyPlayer[];
  /** Index into TRACKS. */
  track: number;
  /** True while the host has a race under way. */
  racing: boolean;
}

/** One ship on the grid, as the host tells everyone at the start. */
export interface EntrySpec {
  ship: number;
  name: string;
  pace: number;
  /** The player steering it, or null for an AI ship. */
  playerId: string | null;
}

/** The state of a race at one moment on the host. */
export interface Snapshot {
  /** Host clock, seconds. */
  at: number;
  phase: RacePhase;
  countdown: number;
  time: number;
  /** Per racer: see SHIP_FIELDS. */
  ships: number[][];
  /** Per hazard: x, z, heading, strength, index, lateral. */
  hazards: number[][];
  /** Hazard hits since the last snapshot. */
  events: HazardEvent[];
}

export type HostMessage =
  | { t: 'lobby'; lobby: Lobby; you: string }
  | { t: 'start'; track: number; entries: EntrySpec[] }
  | { t: 'snap'; snap: Snapshot }
  | { t: 'to-lobby' }
  | { t: 'full' };

export type ClientMessage =
  | { t: 'hello'; name: string; ship: number }
  | { t: 'ship'; ship: number }
  | { t: 'helm'; throttle: number; rudder: number }
  | { t: 'reset' };

/** A player's name made safe to show: trimmed, shortened, never empty. */
export function cleanName(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, NAME_LENGTH) : '';
  return text || 'Captain';
}

export function cleanShip(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < SHIP_CLASSES.length ? n : 0;
}

/** Helm orders from the network, with anything that is not a number in range taken as zero. */
export function cleanHelm(throttle: unknown, rudder: unknown): Helm {
  const part = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  return { throttle: part(throttle), rudder: part(rudder) };
}

/** Race entries for the grid the host sent, as seen by one player. */
export function entriesFor(specs: EntrySpec[], me: string): RaceEntry[] {
  return specs.map((spec) => ({
    cls: SHIP_CLASSES[cleanShip(spec.ship)],
    // Ship names of AI entries are longer than a player's name may be.
    name: spec.playerId === null ? String(spec.name).slice(0, 40) : cleanName(spec.name),
    isPlayer: spec.playerId === me,
    pace: spec.pace,
    human: spec.playerId !== null && spec.playerId !== me,
  }));
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

export function takeSnapshot(race: Race, at: number, events: HazardEvent[]): Snapshot {
  return {
    at: round(at),
    phase: race.phase,
    countdown: round(race.countdown),
    time: round(race.time),
    ships: race.racers.map((r) => {
      const s = r.state;
      return [
        round(s.x),
        round(s.z),
        round(s.heading),
        round(s.u),
        round(s.v),
        round(s.r),
        round(s.throttle),
        round(s.rudder),
        r.trackIndex,
        round(r.lateral),
        r.progress,
        r.finished ? 1 : 0,
        round(r.finishTime),
        r.offCourse ? 1 : 0,
        r.drafting ? 1 : 0,
        r.hazardHits,
      ];
    }),
    hazards: (race.hazards?.hazards ?? []).map((h) => [
      round(h.x),
      round(h.z),
      round(h.heading),
      round(h.strength),
      h.index,
      round(h.lateral),
    ]),
    events,
  };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpAngle = (a: number, b: number, t: number): number =>
  a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

/** Write the state between two snapshots into a race that mirrors the host's. */
function applyBetween(race: Race, a: Snapshot, b: Snapshot, t: number): void {
  race.phase = b.phase;
  race.countdown = lerp(a.countdown, b.countdown, t);
  race.time = lerp(a.time, b.time, t);
  race.racers.forEach((racer, i) => {
    const p = a.ships[i];
    const q = b.ships[i];
    if (!p || !q) return;
    const s = racer.state;
    s.x = lerp(p[0], q[0], t);
    s.z = lerp(p[1], q[1], t);
    s.heading = lerpAngle(p[2], q[2], t);
    s.u = lerp(p[3], q[3], t);
    s.v = lerp(p[4], q[4], t);
    s.r = lerp(p[5], q[5], t);
    s.throttle = lerp(p[6], q[6], t);
    s.rudder = lerp(p[7], q[7], t);
    racer.trackIndex = race.track.clampIndex(q[8]);
    racer.lateral = q[9];
    racer.progress = q[10];
    racer.finished = q[11] === 1;
    racer.finishTime = q[12];
    racer.offCourse = q[13] === 1;
    racer.drafting = q[14] === 1;
    racer.hazardHits = q[15];
  });
  (race.hazards?.hazards ?? []).forEach((hazard, i) => {
    const p = a.hazards[i];
    const q = b.hazards[i];
    if (!p || !q) return;
    // A wave jumps back to the far end when it comes round again: do not slide it there.
    const jump = Math.hypot(q[0] - p[0], q[1] - p[1]) > 200;
    const k = jump ? 1 : t;
    hazard.x = lerp(p[0], q[0], k);
    hazard.z = lerp(p[1], q[1], k);
    hazard.heading = lerpAngle(p[2], q[2], k);
    hazard.strength = lerp(p[3], q[3], k);
    hazard.index = race.track.clampIndex(q[4]);
    hazard.lateral = q[5];
  });
}

/**
 * Snapshots from the host, played back a moment late so there are always two
 * to draw between and ships move smoothly however unevenly they arrive.
 */
export class SnapshotBuffer {
  /** How far behind the newest snapshot the race is shown, seconds. */
  static readonly DELAY = 0.1;
  /** A longer delay smooths out a connection that delivers unevenly, such as the relay. */
  constructor(private readonly delay = SnapshotBuffer.DELAY) {}

  private snapshots: Snapshot[] = [];
  private events: HazardEvent[] = [];
  /** Smallest gap seen between this clock and the host's: the best guess at the true one. */
  private offset = Infinity;

  /** Add a snapshot that arrived at a time on this player's clock. */
  push(snapshot: Snapshot, now: number): void {
    const last = this.snapshots[this.snapshots.length - 1];
    if (last && snapshot.at <= last.at) return;
    this.offset = Math.min(this.offset, now - snapshot.at);
    this.snapshots.push(snapshot);
    this.events.push(...snapshot.events);
  }

  /** Bring the race up to date. Returns hazard hits not yet reported. */
  apply(race: Race, now: number): HazardEvent[] {
    const list = this.snapshots;
    if (list.length === 0) return [];
    const at = now - this.offset - this.delay;
    while (list.length > 2 && list[1].at <= at) list.shift();
    const a = list[0];
    const b = list[1] ?? a;
    const t = b.at > a.at ? Math.max(0, Math.min(1, (at - a.at) / (b.at - a.at))) : 1;
    applyBetween(race, a, b, t);
    return this.events.splice(0);
  }
}
