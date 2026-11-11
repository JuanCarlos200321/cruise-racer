import { describe, expect, it } from 'vitest';
import { Track, TRACKS } from './track';

describe.each(TRACKS)('track $id', (def) => {
  const track = new Track(def);

  it('is a closed loop of evenly spaced samples', () => {
    const n = track.sampleCount;
    expect(n).toBeGreaterThan(100);
    for (let i = 0; i < n; i++) {
      const a = track.samples[i];
      const b = track.samples[(i + 1) % n];
      const gap = Math.hypot(b.x - a.x, b.z - a.z);
      expect(gap).toBeGreaterThan(track.spacing * 0.9);
      expect(gap).toBeLessThan(track.spacing * 1.1);
    }
  });

  it('starts at the first control point', () => {
    expect(track.samples[0].x).toBeCloseTo(def.points[0][0] * def.scale, 3);
    expect(track.samples[0].z).toBeCloseTo(def.points[0][1] * def.scale, 3);
  });

  it('has no bend tighter than a ship can take', () => {
    const tightest = Math.max(...track.curvature);
    expect(1 / tightest).toBeGreaterThan(130);
  });

  it('does not run close alongside itself', () => {
    const n = track.sampleCount;
    const apart = Math.round(1200 / track.spacing);
    for (let i = 0; i < n; i += 3) {
      for (let j = i + apart; j < n - apart + i; j += 3) {
        const a = track.samples[i];
        const b = track.samples[j % n];
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(track.halfWidth * 2 + 60);
      }
    }
  });

  it('keeps every obstacle clear of the marked course', () => {
    expect(track.obstacles.length).toBeGreaterThan(5);
    for (const o of track.obstacles) {
      expect(track.distanceToCentreline(o.x, o.z)).toBeGreaterThanOrEqual(track.halfWidth + o.r);
    }
  });

  it('reports position relative to the centreline', () => {
    const p = track.pointAt(40, 75);
    const pos = track.nearest(p.x, p.z);
    expect(pos.index).toBe(40);
    expect(pos.lateral).toBeCloseTo(75, 0);
    const q = track.pointAt(40, -120);
    expect(track.nearest(q.x, q.z, 38).lateral).toBeCloseTo(-120, 0);
  });

  it('puts starboard on the right-hand side of the direction of travel', () => {
    const t = track.tangents[10];
    const p = track.pointAt(10, 100);
    const c = track.samples[10];
    // forward x up = starboard, with y up: (fx,0,fz) x (0,1,0) = (-fz, 0, fx)
    expect((p.x - c.x) / 100).toBeCloseTo(-t.z, 6);
    expect((p.z - c.z) / 100).toBeCloseTo(t.x, 6);
  });

  it('is tighter on the inside of a bend than the outside', () => {
    let i = 0;
    while (track.curvature[i] < 1 / 800) i++;
    const inside = Math.sign(track.signedCurvature[i]) * 100;
    expect(track.curvatureAt(i, inside)).toBeGreaterThan(track.curvature[i]);
    expect(track.curvatureAt(i, -inside)).toBeLessThan(track.curvature[i]);
    // A point on the inside lane really is closer to the centre of the bend.
    const radius = 1 / track.curvature[i];
    const centre = track.pointAt(i, Math.sign(track.signedCurvature[i]) * radius);
    const p = track.pointAt(i, inside);
    expect(Math.hypot(p.x - centre.x, p.z - centre.z)).toBeCloseTo(radius - 100, 0);
  });

  it('spreads checkpoints round the lap, starting at the line', () => {
    expect(track.checkpoints[0]).toBe(0);
    expect(track.checkpoints.length).toBeGreaterThanOrEqual(4);
    expect([...track.checkpoints].sort((a, b) => a - b)).toEqual(track.checkpoints);
  });
});
