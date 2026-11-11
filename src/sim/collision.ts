import { forward, starboard, type ShipState } from './physics';
import type { ShipClass } from './ships';
import type { Obstacle } from './track';

const HULL_CIRCLE_COUNT = 5;
const OBSTACLE_RESTITUTION = 0.15;
const SHIP_RESTITUTION = 0.3;
/** Sliding friction: speed along the surface lost per unit of speed lost into it. */
const FRICTION = 0.35;

interface HullCircle {
  x: number;
  z: number;
  r: number;
  /** Distance ahead of midships, metres. */
  offset: number;
}

/** The hull is approximated by a row of circles along its length. */
export function hullCircles(s: ShipState, cls: ShipClass): HullCircle[] {
  const r = cls.beam * 0.55;
  const f = forward(s.heading);
  const half = cls.length / 2 - r;
  const circles: HullCircle[] = [];
  for (let i = 0; i < HULL_CIRCLE_COUNT; i++) {
    const offset = -half + (2 * half * i) / (HULL_CIRCLE_COUNT - 1);
    circles.push({ x: s.x + f.x * offset, z: s.z + f.z * offset, r, offset });
  }
  return circles;
}

function worldVelocity(s: ShipState): { vx: number; vz: number } {
  const f = forward(s.heading);
  const sb = starboard(s.heading);
  return { vx: f.x * s.u + sb.x * s.v, vz: f.z * s.u + sb.z * s.v };
}

function setWorldVelocity(s: ShipState, vx: number, vz: number): void {
  const f = forward(s.heading);
  const sb = starboard(s.heading);
  s.u = vx * f.x + vz * f.z;
  s.v = vx * sb.x + vz * sb.z;
}

/**
 * Velocity after an impulse along the contact normal (nx, nz), with friction
 * taking some of the sliding speed. A hard hit costs a lot of speed; leaning
 * on something costs little.
 */
function applyImpulse(
  vx: number,
  vz: number,
  nx: number,
  nz: number,
  impulse: number,
): { vx: number; vz: number } {
  const normal = vx * nx + vz * nz;
  const tx = vx - normal * nx;
  const tz = vz - normal * nz;
  const sliding = Math.hypot(tx, tz);
  const kept = sliding > 1e-6 ? Math.max(0, sliding - FRICTION * impulse) / sliding : 0;
  return {
    vx: (normal + impulse) * nx + tx * kept,
    vz: (normal + impulse) * nz + tz * kept,
  };
}

/** Swing the hull away when it is pushed off-centre, so ships glance off rather than stick. */
function nudgeHeading(s: ShipState, cls: ShipClass, pushX: number, pushZ: number, offset: number): void {
  const sb = starboard(s.heading);
  const lateralPush = pushX * sb.x + pushZ * sb.z;
  s.heading -= (lateralPush * offset * 2) / (cls.length * cls.length);
}

/**
 * Push a ship out of any obstacle it overlaps and take away the speed it had
 * into the obstacle. Returns the impact speed (0 if there was no contact).
 */
export function resolveObstacles(s: ShipState, cls: ShipClass, obstacles: Obstacle[]): number {
  let impact = 0;
  const reach = cls.length / 2;
  for (const o of obstacles) {
    const centreDist = Math.hypot(s.x - o.x, s.z - o.z);
    if (centreDist > reach + o.r) continue;
    for (const c of hullCircles(s, cls)) {
      const dx = c.x - o.x;
      const dz = c.z - o.z;
      const d = Math.hypot(dx, dz);
      const overlap = c.r + o.r - d;
      if (overlap <= 0 || d === 0) continue;
      const nx = dx / d;
      const nz = dz / d;
      s.x += nx * overlap;
      s.z += nz * overlap;
      nudgeHeading(s, cls, nx * overlap, nz * overlap, c.offset);
      const { vx, vz } = worldVelocity(s);
      const into = vx * nx + vz * nz;
      if (into < 0) {
        impact = Math.max(impact, -into);
        const after = applyImpulse(vx, vz, nx, nz, -(1 + OBSTACLE_RESTITUTION) * into);
        setWorldVelocity(s, after.vx, after.vz);
      }
    }
  }
  return impact;
}

/**
 * Separate two overlapping ships, the lighter one moving more, and exchange
 * momentum. Returns the closing speed (0 if there was no contact).
 */
export function resolveShips(
  a: ShipState,
  clsA: ShipClass,
  b: ShipState,
  clsB: ShipClass,
): number {
  if (Math.hypot(a.x - b.x, a.z - b.z) > (clsA.length + clsB.length) / 2) return 0;

  let deepest = 0;
  let hit: { nx: number; nz: number; offsetA: number; offsetB: number } | null = null;
  for (const ca of hullCircles(a, clsA)) {
    for (const cb of hullCircles(b, clsB)) {
      const dx = ca.x - cb.x;
      const dz = ca.z - cb.z;
      const d = Math.hypot(dx, dz);
      const overlap = ca.r + cb.r - d;
      if (overlap > deepest && d > 0) {
        deepest = overlap;
        hit = { nx: dx / d, nz: dz / d, offsetA: ca.offset, offsetB: cb.offset };
      }
    }
  }
  if (!hit) return 0;

  const total = clsA.mass + clsB.mass;
  const shareA = clsB.mass / total;
  const shareB = clsA.mass / total;
  const { nx, nz } = hit;

  a.x += nx * deepest * shareA;
  a.z += nz * deepest * shareA;
  b.x -= nx * deepest * shareB;
  b.z -= nz * deepest * shareB;
  nudgeHeading(a, clsA, nx * deepest * shareA, nz * deepest * shareA, hit.offsetA);
  nudgeHeading(b, clsB, -nx * deepest * shareB, -nz * deepest * shareB, hit.offsetB);

  const va = worldVelocity(a);
  const vb = worldVelocity(b);
  const closing = (va.vx - vb.vx) * nx + (va.vz - vb.vz) * nz;
  if (closing >= 0) return 0;

  const impulse = -(1 + SHIP_RESTITUTION) * closing;
  // Hulls slide past each other freely; only the speed into the contact changes.
  setWorldVelocity(a, va.vx + nx * impulse * shareA, va.vz + nz * impulse * shareA);
  setWorldVelocity(b, vb.vx - nx * impulse * shareB, vb.vz - nz * impulse * shareB);
  return -closing;
}
