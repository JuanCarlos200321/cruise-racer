import { describe, expect, it } from 'vitest';
import { COUNTDOWN_SECONDS, Race, type RaceEntry } from './race';
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
    const race = new Race(track, field(), 1);
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
    const race = new Race(track, field(), 1);
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
    const race = new Race(track, entries, 1);
    runUntil(race, () => race.time > 10, 20);
    expect(race.player.state.u).toBe(0);
    expect(race.racers[0].state.u).toBeGreaterThan(10);
    expect(race.positionOf(race.player)).toBe(6);
  });

  it('does not count a lap for a ship that cuts across the course', () => {
    const race = new Race(track, field().slice(0, 1), 3);
    runUntil(race, () => race.time > 5, 20);
    const racer = race.racers[0];
    const before = racer.progress;
    const far = track.samples[Math.floor(track.sampleCount * 0.6)];
    racer.state.x = far.x;
    racer.state.z = far.z;
    race.step(DT, IDLE);
    expect(racer.progress - before).toBeLessThan(20);
    expect(racer.lapsDone).toBe(0);
  });

  it('puts a ship back on the centreline at a checkpoint behind it', () => {
    const race = new Race(track, field().slice(0, 1), 3);
    runUntil(race, () => race.time > 40, 60);
    const racer = race.racers[0];
    const before = racer.progress;
    race.resetToCheckpoint(racer);
    expect(track.checkpoints).toContain(racer.trackIndex);
    expect(racer.progress).toBeLessThanOrEqual(before);
    expect(before - racer.progress).toBeLessThan(700 / track.spacing);
    expect(racer.state.u).toBe(0);
    expect(track.nearest(racer.state.x, racer.state.z).index).toBe(racer.trackIndex);
  });
});

describe.each(TRACKS)('AI race on $id', (def) => {
  const track = new Track(def);

  it('every ship finishes three laps cleanly', () => {
    const race = new Race(track, field(), 3);
    let offCourseSteps = 0;
    let steps = 0;
    for (let i = 0; i < 900 * 60 && !race.racers.every((r) => r.finished); i++) {
      race.step(DT, IDLE);
      steps++;
      for (const r of race.racers) if (r.offCourse) offCourseSteps++;
    }
    const standings = race.standings();
    console.log(
      `${def.id} (${Math.round(track.length)} m): ` +
        standings
          .map((r) => `${r.cls.id} ${r.finishTime.toFixed(0)}s best ${Math.min(...r.lapTimes).toFixed(1)}`)
          .join(', '),
    );
    for (const r of race.racers) {
      expect(r.finished).toBe(true);
      expect(r.lapTimes).toHaveLength(3);
      expect(r.lapTimes.reduce((a, b) => a + b, 0)).toBeCloseTo(r.finishTime, 6);
    }
    for (let i = 1; i < standings.length; i++) {
      expect(standings[i].finishTime).toBeGreaterThanOrEqual(standings[i - 1].finishTime);
    }
    expect(standings[0].finishTime).toBeLessThan(480);
    expect(offCourseSteps / (steps * race.racers.length)).toBeLessThan(0.03);
  });

  it.each(SHIP_CLASSES)('$id laps alone without leaving the course', (cls) => {
    const race = new Race(track, [{ cls, name: cls.shipNames[0], isPlayer: false, pace: 1 }], 2);
    let offCourse = 0;
    let impacts = 0;
    for (let i = 0; i < 600 * 60 && !race.racers[0].finished; i++) {
      race.step(DT, IDLE);
      if (race.racers[0].offCourse) offCourse++;
      if (race.racers[0].impact > 0) impacts++;
    }
    const racer = race.racers[0];
    console.log(`  ${def.id} ${cls.id}: flying lap ${racer.lapTimes[1]?.toFixed(1)}s`);
    expect(racer.finished).toBe(true);
    expect(offCourse).toBe(0);
    expect(impacts).toBe(0);
  });
});

describe('fleet balance', () => {
  it('has no class that is fastest everywhere by a wide margin', () => {
    const wins = new Map<string, number>();
    for (const def of TRACKS) {
      const track = new Track(def);
      const times = SHIP_CLASSES.map((cls) => {
        const race = new Race(track, [{ cls, name: cls.name, isPlayer: false, pace: 1 }], 2);
        for (let i = 0; i < 600 * 60 && !race.racers[0].finished; i++) race.step(DT, IDLE);
        return { id: cls.id, lap: race.racers[0].lapTimes[1] };
      });
      const best = Math.min(...times.map((t) => t.lap));
      const worst = Math.max(...times.map((t) => t.lap));
      // The harbour is meant to suit small ships, but not by a walkover.
      expect(worst / best).toBeLessThan(1.15);
      const winner = times.find((t) => t.lap === best)!;
      wins.set(winner.id, (wins.get(winner.id) ?? 0) + 1);
    }
    expect(wins.size).toBeGreaterThan(1);
  });
});
