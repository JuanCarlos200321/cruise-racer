import { describe, expect, it } from 'vitest';
import { hullCircles, resolveObstacles, resolveShips } from './collision';
import { createShipState } from './physics';
import { shipClassById } from './ships';
import type { Obstacle } from './track';

const icon = shipClassById('icon');
const radiance = shipClassById('radiance');

describe('hullCircles', () => {
  it('covers the hull from stern to bow', () => {
    const s = createShipState(0, 0, 0);
    const circles = hullCircles(s, icon);
    const bow = Math.max(...circles.map((c) => c.z + c.r));
    const stern = Math.min(...circles.map((c) => c.z - c.r));
    expect(bow).toBeCloseTo(icon.length / 2, 6);
    expect(stern).toBeCloseTo(-icon.length / 2, 6);
  });
});

describe('resolveObstacles', () => {
  const island: Obstacle = { x: 0, z: 400, r: 150, kind: 'island', seed: 1 };

  it('leaves a ship in open water alone', () => {
    const s = createShipState(0, 0, 0);
    s.u = 40;
    expect(resolveObstacles(s, icon, [island])).toBe(0);
    expect(s.u).toBe(40);
    expect(s.z).toBe(0);
  });

  it('stops a ship that rams an island head on and pushes it clear', () => {
    const s = createShipState(0, 100, 0);
    s.u = 40;
    const impact = resolveObstacles(s, icon, [island]);
    expect(impact).toBeCloseTo(40, 0);
    expect(s.u).toBeLessThanOrEqual(0);
    for (const c of hullCircles(s, icon)) {
      expect(Math.hypot(c.x - island.x, c.z - island.z)).toBeGreaterThanOrEqual(c.r + island.r - 1e-6);
    }
  });

  it('lets a ship keep most of its speed in a glancing blow', () => {
    const s = createShipState(160, 400, 0);
    s.u = 40;
    resolveObstacles(s, icon, [island]);
    expect(s.u).toBeGreaterThan(35);
  });
});

describe('resolveShips', () => {
  it('ignores ships that are apart', () => {
    const a = createShipState(0, 0, 0);
    const b = createShipState(200, 0, 0);
    expect(resolveShips(a, icon, b, radiance)).toBe(0);
  });

  it('separates overlapping ships, moving the lighter one further', () => {
    const a = createShipState(0, 0, 0);
    const b = createShipState(30, 0, 0);
    resolveShips(a, icon, b, radiance);
    expect(Math.abs(b.x - 30)).toBeGreaterThan(Math.abs(a.x) * 2);
    expect(b.x - a.x).toBeGreaterThan(30);
  });

  it('slows the ship behind and pushes the ship ahead in a rear-end hit', () => {
    const behind = createShipState(0, 0, 0);
    behind.u = 50;
    const ahead = createShipState(0, icon.length / 2 + radiance.length / 2 - 5, 0);
    ahead.u = 20;
    const closing = resolveShips(behind, icon, ahead, radiance);
    expect(closing).toBeCloseTo(30, 0);
    expect(behind.u).toBeLessThan(50);
    expect(ahead.u).toBeGreaterThan(20);
  });
});
