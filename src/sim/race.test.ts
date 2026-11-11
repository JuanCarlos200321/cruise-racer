import { describe, expect, it } from 'vitest';
import { COUNTDOWN_SECONDS, Race, type RaceEntry } from './race';
import { createRng } from './rng';
import { SHIP_CLASSES } from './ships';
import { Track, TRACKS } from './track';

const DT = 1 / 60;
const IDLE = { throttle: 0, rudder: 0 };

function field(): RaceEntry[] {
  const paces = [0.97, 0.95, 0.93, 0.96, 0.94, 0.92];
  return paces.map((pace, i) => {
    const cls = SHIP_CLASSES[i % SHIP_CLASSES.length];
    return { cls, name: cls.shipNames[0], isPlayer: false, pace };
  });
}

function runUntil(race: Race, done: () => boolean, maxSeconds: number): void {
  for (let i = 0; i < maxSeconds * 60 && !done(); i++) race.step(DT, IDLE);
}

describe('Race', () => {
  const track = new Track(TRACKS[0]);

  it('holds the grid behind the line until the countdown ends', () => {
    const race = new Race(track, field());
    const start = race.racers.map((r) => ({ x: r.state.x, z: r.state.z }));
    for (let i = 0; i < (COUNTDOWN_SECONDS - 0.5) * 60; i++) race.step(DT, IDLE);
    expect(race.phase).toBe('countdown');
    race.racers.forEach((r, i) => {
      expect(r.state.x).toBe(start[i].x);
      expect(r.state.z).toBe(start[i].z);
      expect(r.progress).toBeLessThan(0);
    });
    for (let i = 0; i < 60; i++) race.step(DT, IDLE);
    expect(race.phase).toBe('racing');
  });

  it('places the grid without overlapping ships', () => {
    const race = new Race(track, field());
    for (const a of race.racers) {
      for (const b of race.racers) {
        if (a === b) continue;
        const d = Math.hypot(a.state.x - b.state.x, a.state.z - b.state.z);
        expect(d).toBeGreaterThan(100);
      }
    }
  });

  it('leaves the player ship to the player', () => {
    const entries = field();
    entries[4].isPlayer = true;
    const race = new Race(track, entries);
    runUntil(race, () => race.time > 10, 20);
    expect(race.player.state.u).toBe(0);
    expect(race.racers[0].state.u).toBeGreaterThan(10);
    expect(race.positionOf(race.player)).toBe(6);
  });

  it('does not let a ship jump ahead by leaving the route', () => {
    const race = new Race(track, field().slice(0, 1));
    runUntil(race, () => race.time > 5, 20);
    const racer = race.racers[0];
    const before = racer.progress;
    const far = track.samples[Math.floor(track.sampleCount * 0.6)];
    racer.state.x = far.x;
    racer.state.z = far.z;
    race.step(DT, IDLE);
    expect(racer.progress - before).toBeLessThan(20);
    expect(racer.finished).toBe(false);
  });

  it('puts a ship back on the centreline at a checkpoint behind it', () => {
    const race = new Race(track, field().slice(0, 1));
    runUntil(race, () => race.time > 60, 80);
    const racer = race.racers[0];
    const before = racer.progress;
    race.resetToCheckpoint(racer);
    expect(track.checkpoints).toContain(racer.trackIndex);
    expect(racer.progress).toBeLessThanOrEqual(before);
    expect(before - racer.progress).toBeLessThan(1700 / track.spacing);
    expect(racer.state.u).toBe(0);
    expect(track.nearest(racer.state.x, racer.state.z).index).toBe(racer.trackIndex);
  });

  it('finishes a ship when it crosses the finish line, and brings it to a stop', () => {
    const race = new Race(track, field().slice(0, 1), { hazards: false });
    const racer = race.racers[0];
    runUntil(race, () => racer.finished, 600);
    expect(racer.finished).toBe(true);
    expect(racer.trackIndex).toBeGreaterThanOrEqual(track.finishIndex);
    expect(race.distanceToGo(racer)).toBe(0);
    const finishTime = racer.finishTime;
    runUntil(race, () => false, 40);
    expect(racer.finishTime).toBe(finishTime);
    expect(Math.abs(racer.state.u)).toBeLessThan(3);
    expect(racer.trackIndex).toBeLessThan(track.sampleCount - 1);
  });

  it('keeps a menu cruise going by sending the ship back to the start', () => {
    const race = new Race(track, field().slice(0, 1), { hazards: false, loop: true });
    const racer = race.racers[0];
    race.cruiseFrom(racer, 0.97, 0.9);
    runUntil(race, () => racer.trackIndex < track.finishIndex - 100, 60);
    expect(racer.trackIndex).toBeLessThan(track.startIndex + 100);
    expect(racer.finished).toBe(false);
    expect(racer.state.u).toBeGreaterThan(20);
  });
});

describe.each(TRACKS)('AI race on $id', (def) => {
  const track = new Track(def);

  it.each([1, 2, 3])('a full field reaches the destination through the hazards (grid %i)', (seed) => {
    const rng = createRng(seed);
    const entries = field().sort(() => rng() - 0.5);
    const race = new Race(track, entries);
    const stalled = race.racers.map(() => 0);
    let offCourseSteps = 0;
    let steps = 0;
    for (let i = 0; i < 900 * 60 && !race.racers.every((r) => r.finished); i++) {
      race.step(DT, IDLE);
      steps++;
      race.racers.forEach((r, k) => {
        if (r.finished) return;
        if (r.offCourse) offCourseSteps++;
        if (race.time > 10 && Math.abs(r.state.u) < 5) stalled[k] += DT;
      });
    }
    const standings = race.standings();
    for (const r of race.racers) {
      expect(r.finished).toBe(true);
      expect(stalled[r.id]).toBeLessThan(40);
    }
    for (let i = 1; i < standings.length; i++) {
      expect(standings[i].finishTime).toBeGreaterThanOrEqual(standings[i - 1].finishTime);
    }
    expect(standings[0].finishTime).toBeLessThan(420);
    expect(standings[0].finishTime).toBeGreaterThan(150);
    expect(offCourseSteps / (steps * race.racers.length)).toBeLessThan(0.03);
    // The AI steers round most hazards, but not all of them.
    const hits = race.racers.reduce((sum, r) => sum + r.hazardHits, 0);
    expect(hits / race.racers.length).toBeLessThan(def.hazards.length * 0.6);
  });

  it.each(SHIP_CLASSES)('$id sails the clear route alone without leaving the channel', (cls) => {
    const race = new Race(track, [{ cls, name: cls.shipNames[0], isPlayer: false, pace: 1 }], { hazards: false });
    let offCourse = 0;
    let impacts = 0;
    for (let i = 0; i < 600 * 60 && !race.racers[0].finished; i++) {
      race.step(DT, IDLE);
      if (race.racers[0].offCourse) offCourse++;
      if (race.racers[0].impact > 0) impacts++;
    }
    expect(race.racers[0].finished).toBe(true);
    expect(offCourse).toBe(0);
    expect(impacts).toBe(0);
  });
});

describe('fleet balance', () => {
  it('has no class that is far quicker than the rest over a clear route', () => {
    for (const def of TRACKS) {
      const track = new Track(def);
      const times = SHIP_CLASSES.map((cls) => {
        const race = new Race(track, [{ cls, name: cls.name, isPlayer: false, pace: 1 }], { hazards: false });
        for (let i = 0; i < 600 * 60 && !race.racers[0].finished; i++) race.step(DT, IDLE);
        return race.racers[0].finishTime;
      });
      expect(Math.max(...times) / Math.min(...times)).toBeLessThan(1.25);
    }
  });
});
