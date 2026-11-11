import { describe, expect, it } from 'vitest';
import { Track, TRACKS } from './track';

describe.each(TRACKS)('route $id', (def) => {
  const track = new Track(def);

  it('is an open path of evenly spaced samples', () => {
    const n = track.sampleCount;
    expect(n).toBeGreaterThan(400);
    for (let i = 0; i < n - 1; i++) {
      const a = track.samples[i];
      const b = track.samples[i + 1];
      const gap = Math.hypot(b.x - a.x, b.z - a.z);
      expect(gap).toBeGreaterThan(track.spacing * 0.9);
      expect(gap).toBeLessThan(track.spacing * 1.1);
    }
  });

  it('runs from the first control point to the last', () => {
    const last = def.points[def.points.length - 1];
    expect(track.samples[0].x).toBeCloseTo(def.points[0][0] * def.scale, 3);
    expect(track.samples[0].z).toBeCloseTo(def.points[0][1] * def.scale, 3);
    expect(track.samples[track.sampleCount - 1].x).toBeCloseTo(last[0] * def.scale, 3);
    expect(track.samples[track.sampleCount - 1].z).toBeCloseTo(last[1] * def.scale, 3);
  });

  it('is a voyage, not a circuit: it ends a long way from where it starts', () => {
    const a = track.samples[track.startIndex];
    const b = track.samples[track.finishIndex];
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeGreaterThan(track.raceLength * 0.8);
    expect(track.raceLength).toBeGreaterThan(10000);
  });

  it('leaves water behind the start line and beyond the finish line', () => {
    expect(track.startIndex * track.spacing).toBeGreaterThan(1000);
    expect((track.sampleCount - 1 - track.finishIndex) * track.spacing).toBeGreaterThan(1200);
  });

  it('has no bend tighter than a ship can take', () => {
    const tightest = Math.max(...track.curvature);
    expect(1 / tightest).toBeGreaterThan(600);
  });

  it('keeps every obstacle clear of the channel between start and finish', () => {
    expect(track.obstacles.length).toBeGreaterThan(5);
    for (const o of track.obstacles) {
      for (let i = 0; i <= track.finishIndex; i++) {
        const p = track.samples[i];
        expect(Math.hypot(p.x - o.x, p.z - o.z)).toBeGreaterThanOrEqual(track.halfWidth + o.r);
      }
    }
  });

  it('reports position relative to the centreline', () => {
    const p = track.pointAt(140, 75);
    const pos = track.nearest(p.x, p.z);
    expect(pos.index).toBe(140);
    expect(pos.lateral).toBeCloseTo(75, 0);
    const q = track.pointAt(140, -120);
    expect(track.nearest(q.x, q.z, 138).lateral).toBeCloseTo(-120, 0);
  });

  it('puts starboard on the right-hand side of the direction of travel', () => {
    const t = track.tangents[10];
    const p = track.pointAt(10, 100);
    const c = track.samples[10];
    // forward x up = starboard, with y up: (fx,0,fz) x (0,1,0) = (-fz, 0, fx)
    expect((p.x - c.x) / 100).toBeCloseTo(-t.z, 6);
    expect((p.z - c.z) / 100).toBeCloseTo(t.x, 6);
  });

  it('carries straight on past the last sample', () => {
    const n = track.sampleCount;
    const end = track.samples[n - 1];
    const t = track.tangents[n - 1];
    const p = track.pointAt(n - 1 + 10);
    expect(p.x).toBeCloseTo(end.x + t.x * 10 * track.spacing, 6);
    expect(p.z).toBeCloseTo(end.z + t.z * 10 * track.spacing, 6);
  });

  it('spreads checkpoints from the start line to the finish line', () => {
    expect(track.checkpoints[0]).toBe(track.startIndex);
    expect(track.checkpoints[track.checkpoints.length - 1]).toBe(track.finishIndex);
    expect([...track.checkpoints].sort((a, b) => a - b)).toEqual(track.checkpoints);
  });

  it('meets every kind of hazard on the way', () => {
    expect(new Set(def.hazards).size).toBe(4);
  });
});
