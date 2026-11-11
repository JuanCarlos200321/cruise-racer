import type { Vec2 } from './physics';
import { createRng } from './rng';

export type ObstacleKind = 'island' | 'mountain' | 'rocks' | 'city';
export type TrackTheme = 'tropical' | 'harbour' | 'fjord';
export type HazardKind = 'sharks' | 'kraken' | 'wave' | 'pirate';

/** Solid circular obstacle. */
export interface Obstacle {
  x: number;
  z: number;
  r: number;
  kind: ObstacleKind;
  seed: number;
}

/** Obstacles placed at random around the route, never on it. */
interface ScatterFeature {
  type: 'scatter';
  kind: ObstacleKind;
  count: number;
  minRadius: number;
  maxRadius: number;
  /** Minimum gap between the obstacle and the edge of the route. */
  margin: number;
  /** How far beyond the route bounds obstacles may be placed. */
  spread: number;
}

/** A line of obstacles along both edges of the route. */
interface WallFeature {
  type: 'wall';
  kind: ObstacleKind;
  minRadius: number;
  maxRadius: number;
  margin: number;
  /** Portion of the route covered, as fractions 0..1. */
  from: number;
  to: number;
}

/** One obstacle at a chosen spot, such as the port or the destination. */
interface PlaceFeature {
  type: 'place';
  kind: ObstacleKind;
  radius: number;
  /** Position along the route, as a fraction 0..1. */
  at: number;
  /** Distance from the centreline to the obstacle's centre. Positive is to starboard. */
  lateral: number;
  /** Distance further along the direction of travel. */
  ahead?: number;
}

export interface TrackDef {
  id: string;
  name: string;
  /** Port the voyage leaves from and the place it ends. */
  from: string;
  to: string;
  description: string;
  theme: TrackTheme;
  /** Half the width of the buoyed channel, metres. */
  halfWidth: number;
  /** Control points of the route, from before the start line to beyond the finish. */
  points: [number, number][];
  scale: number;
  seed: number;
  features: (ScatterFeature | WallFeature | PlaceFeature)[];
  /** Hazards met on the way, in order, spread evenly between start and finish. */
  hazards: HazardKind[];
}

const SAMPLE_SPACING = 20;
const CHECKPOINT_SPACING = 1500;
const DENSE_STEPS = 48;
/** Water behind the start line for the grid, metres. */
const START_LEAD = 1100;
/** Water beyond the finish line for ships to slow down in, metres. */
const RUN_OFF = 1400;

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

export interface TrackPosition {
  /** Index of the nearest centreline sample. */
  index: number;
  /** Distance from the centreline, metres. Positive is to starboard of the direction of travel. */
  lateral: number;
}

/** A point-to-point route across open water. */
export class Track {
  readonly def: TrackDef;
  readonly halfWidth: number;
  /** Evenly spaced points along the centreline, first to last. */
  readonly samples: Vec2[] = [];
  /** Unit direction of travel at each sample. */
  readonly tangents: Vec2[] = [];
  /** Curvature (1 / turn radius) at each sample. */
  readonly curvature: number[] = [];
  /** Curvature with a sign: positive where the route turns to starboard. */
  readonly signedCurvature: number[] = [];
  readonly spacing: number;
  /** Length of the whole centreline, metres. */
  readonly length: number;
  /** Samples of the start and finish lines. */
  readonly startIndex: number;
  readonly finishIndex: number;
  readonly obstacles: Obstacle[] = [];
  /** Sample indices of the checkpoints, from the start line to the finish line. */
  readonly checkpoints: number[] = [];

  constructor(def: TrackDef) {
    this.def = def;
    this.halfWidth = def.halfWidth;

    const pts = def.points.map(([x, z]) => ({ x: x * def.scale, z: z * def.scale }));
    const count = pts.length;
    // The curve is carried straight on past each end.
    const at = (i: number): Vec2 => {
      if (i < 0) return { x: 2 * pts[0].x - pts[1].x, z: 2 * pts[0].z - pts[1].z };
      if (i >= count) {
        return {
          x: 2 * pts[count - 1].x - pts[count - 2].x,
          z: 2 * pts[count - 1].z - pts[count - 2].z,
        };
      }
      return pts[i];
    };
    const dense: Vec2[] = [];
    for (let i = 0; i < count - 1; i++) {
      const p0 = at(i - 1);
      const p1 = at(i);
      const p2 = at(i + 1);
      const p3 = at(i + 2);
      for (let k = 0; k < DENSE_STEPS; k++) {
        const t = k / DENSE_STEPS;
        dense.push({
          x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
          z: catmullRom(p0.z, p1.z, p2.z, p3.z, t),
        });
      }
    }
    dense.push(pts[count - 1]);

    // Resample to even spacing along the curve.
    const cumulative = [0];
    for (let i = 0; i < dense.length - 1; i++) {
      const a = dense[i];
      const b = dense[i + 1];
      cumulative.push(cumulative[i] + Math.hypot(b.x - a.x, b.z - a.z));
    }
    this.length = cumulative[dense.length - 1];
    const steps = Math.round(this.length / SAMPLE_SPACING);
    const n = steps + 1;
    this.spacing = this.length / steps;
    let seg = 0;
    for (let i = 0; i < n; i++) {
      const target = Math.min(this.length, i * this.spacing);
      while (seg < dense.length - 2 && cumulative[seg + 1] < target) seg++;
      const a = dense[seg];
      const b = dense[seg + 1];
      const t = (target - cumulative[seg]) / (cumulative[seg + 1] - cumulative[seg]);
      this.samples.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }

    for (let i = 0; i < n; i++) {
      const prev = this.samples[Math.max(0, i - 1)];
      const next = this.samples[Math.min(n - 1, i + 1)];
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const len = Math.hypot(dx, dz);
      this.tangents.push({ x: dx / len, z: dz / len });
    }
    for (let i = 0; i < n; i++) {
      const a = this.tangents[Math.max(0, i - 1)];
      const b = this.tangents[Math.min(n - 1, i + 1)];
      const turn = Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z);
      this.signedCurvature.push(turn / (2 * this.spacing));
      this.curvature.push(Math.abs(turn) / (2 * this.spacing));
    }

    this.startIndex = Math.round(START_LEAD / this.spacing);
    this.finishIndex = n - 1 - Math.round(RUN_OFF / this.spacing);
    const legs = Math.max(2, Math.round(this.raceLength / CHECKPOINT_SPACING));
    for (let k = 0; k <= legs; k++) {
      this.checkpoints.push(
        this.startIndex + Math.round((k * (this.finishIndex - this.startIndex)) / legs),
      );
    }

    this.buildObstacles();
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /** Distance from the start line to the finish line, metres. */
  get raceLength(): number {
    return (this.finishIndex - this.startIndex) * this.spacing;
  }

  /** Nearest valid sample index. */
  clampIndex(index: number): number {
    return Math.max(0, Math.min(this.samples.length - 1, Math.round(index)));
  }

  /**
   * Curvature of the path that runs parallel to the centreline, offset
   * sideways. The inside of a bend is tighter than the outside.
   */
  curvatureAt(index: number, lateral: number): number {
    const k = this.signedCurvature[this.clampIndex(index)];
    return Math.abs(k) / Math.max(0.3, 1 - k * lateral);
  }

  /** Heading of the direction of travel at a sample. */
  headingAt(index: number): number {
    const t = this.tangents[this.clampIndex(index)];
    return Math.atan2(t.x, t.z);
  }

  /**
   * Point at a sample, offset sideways. Positive lateral is to starboard.
   * Indices past either end carry straight on in the direction of the route.
   */
  pointAt(index: number, lateral = 0): Vec2 {
    const i = this.clampIndex(index);
    const p = this.samples[i];
    const t = this.tangents[i];
    const beyond = (index - i) * this.spacing;
    return { x: p.x + t.x * beyond - t.z * lateral, z: p.z + t.z * beyond + t.x * lateral };
  }

  /**
   * Nearest centreline sample. With a hint, only samples just around it are
   * searched, so a ship cannot jump to another part of the route.
   */
  nearest(x: number, z: number, hint?: number): TrackPosition {
    const n = this.samples.length;
    let best = 0;
    let bestDist = Infinity;
    const from = hint === undefined ? 0 : Math.max(0, hint - 8);
    const to = hint === undefined ? n - 1 : Math.min(n - 1, hint + 16);
    for (let i = from; i <= to; i++) {
      const p = this.samples[i];
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    const p = this.samples[best];
    const t = this.tangents[best];
    const lateral = (x - p.x) * -t.z + (z - p.z) * t.x;
    return { index: best, lateral };
  }

  /** Distance from a point to the centreline, searching the whole route. */
  distanceToCentreline(x: number, z: number): number {
    let best = Infinity;
    for (const p of this.samples) {
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  private fits(x: number, z: number, r: number, margin: number): boolean {
    return this.distanceToCentreline(x, z) >= this.halfWidth + r + margin;
  }

  private buildObstacles(): void {
    const rng = createRng(this.def.seed);
    const n = this.samples.length;

    for (const feature of this.def.features) {
      if (feature.type === 'place') {
        const index = Math.round(feature.at * (n - 1));
        const p = this.pointAt(index, feature.lateral);
        const t = this.tangents[index];
        const ahead = feature.ahead ?? 0;
        this.obstacles.push({
          x: p.x + t.x * ahead,
          z: p.z + t.z * ahead,
          r: feature.radius,
          kind: feature.kind,
          seed: rng() * 1e6,
        });
      } else if (feature.type === 'wall') {
        for (const side of [-1, 1]) {
          let i = Math.round(feature.from * (n - 1));
          const end = Math.round(feature.to * (n - 1));
          while (i < end) {
            const r = feature.minRadius + rng() * (feature.maxRadius - feature.minRadius);
            const p = this.pointAt(i, side * (this.halfWidth + r + feature.margin));
            if (this.fits(p.x, p.z, r, feature.margin - 1)) {
              this.obstacles.push({ x: p.x, z: p.z, r, kind: feature.kind, seed: rng() * 1e6 });
            }
            i += Math.max(1, Math.round((r * 1.5) / this.spacing));
          }
        }
      } else {
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const p of this.samples) {
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minZ = Math.min(minZ, p.z);
          maxZ = Math.max(maxZ, p.z);
        }
        let placed = 0;
        for (let attempt = 0; attempt < feature.count * 60 && placed < feature.count; attempt++) {
          const r = feature.minRadius + rng() * (feature.maxRadius - feature.minRadius);
          const x = minX - feature.spread + rng() * (maxX - minX + 2 * feature.spread);
          const z = minZ - feature.spread + rng() * (maxZ - minZ + 2 * feature.spread);
          if (!this.fits(x, z, r, feature.margin)) continue;
          const overlaps = this.obstacles.some(
            (o) => Math.hypot(o.x - x, o.z - z) < o.r + r + 30,
          );
          if (overlaps) continue;
          this.obstacles.push({ x, z, r, kind: feature.kind, seed: rng() * 1e6 });
          placed++;
        }
      }
    }
  }
}

export const TRACKS: TrackDef[] = [
  {
    id: 'miami-cococay',
    name: 'Miami to CocoCay',
    from: 'Miami',
    to: 'Perfect Day at CocoCay',
    description:
      'Out through the Miami channel and east across the Gulf Stream to the Bahamas. Sharks, pirates and worse are waiting.',
    theme: 'tropical',
    halfWidth: 420,
    scale: 1,
    seed: 11,
    points: [
      [0, 0],
      [-1500, 150],
      [-3200, 900],
      [-5000, 700],
      [-6800, -300],
      [-8600, -500],
      [-10400, 300],
      [-12200, 1300],
      [-14000, 1500],
      [-15600, 1250],
    ],
    features: [
      { type: 'wall', kind: 'city', minRadius: 170, maxRadius: 260, margin: 40, from: 0, to: 0.085 },
      { type: 'place', kind: 'island', radius: 520, at: 1, lateral: 0, ahead: 760 },
      { type: 'place', kind: 'island', radius: 260, at: 0.97, lateral: -900 },
      { type: 'scatter', kind: 'island', count: 9, minRadius: 80, maxRadius: 240, margin: 320, spread: 1600 },
    ],
    hazards: ['sharks', 'pirate', 'wave', 'kraken', 'sharks', 'wave', 'pirate', 'kraken'],
  },
  {
    id: 'canaveral-nassau',
    name: 'Port Canaveral to Nassau',
    from: 'Port Canaveral',
    to: 'Nassau',
    description:
      'An evening run south-east down the Florida coast and over to Nassau. Pirate waters most of the way.',
    theme: 'harbour',
    halfWidth: 400,
    scale: 1,
    seed: 23,
    points: [
      [0, 0],
      [-1300, -700],
      [-2400, -2100],
      [-3000, -3800],
      [-4200, -5200],
      [-5900, -5900],
      [-7400, -6900],
      [-8200, -8500],
      [-9300, -9900],
      [-10800, -10600],
      [-12100, -10950],
    ],
    features: [
      { type: 'wall', kind: 'rocks', minRadius: 28, maxRadius: 40, margin: 25, from: 0, to: 0.06 },
      { type: 'place', kind: 'city', radius: 420, at: 0.02, lateral: 950 },
      { type: 'place', kind: 'city', radius: 480, at: 1, lateral: 150, ahead: 700 },
      { type: 'place', kind: 'island', radius: 300, at: 0.98, lateral: -950 },
      { type: 'scatter', kind: 'island', count: 6, minRadius: 80, maxRadius: 200, margin: 350, spread: 1500 },
      { type: 'scatter', kind: 'rocks', count: 8, minRadius: 30, maxRadius: 55, margin: 120, spread: 500 },
    ],
    hazards: ['pirate', 'sharks', 'pirate', 'wave', 'kraken', 'pirate', 'sharks', 'wave'],
  },
  {
    id: 'seattle-juneau',
    name: 'Seattle to Juneau',
    from: 'Seattle',
    to: 'Juneau',
    description:
      'North out of Puget Sound, across cold open water and up the Inside Passage. Rogue waves, and something old in the deep.',
    theme: 'fjord',
    halfWidth: 340,
    scale: 1,
    seed: 37,
    points: [
      [0, 0],
      [100, 1600],
      [-500, 3300],
      [-1300, 5000],
      [-900, 6800],
      [200, 8400],
      [600, 10200],
      [-100, 12000],
      [-900, 13600],
      [-1000, 15200],
      [-800, 16500],
    ],
    features: [
      { type: 'wall', kind: 'city', minRadius: 170, maxRadius: 240, margin: 40, from: 0, to: 0.07 },
      { type: 'wall', kind: 'mountain', minRadius: 150, maxRadius: 240, margin: 60, from: 0.6, to: 1 },
      { type: 'place', kind: 'mountain', radius: 520, at: 1, lateral: 0, ahead: 800 },
      { type: 'scatter', kind: 'mountain', count: 14, minRadius: 220, maxRadius: 420, margin: 500, spread: 1800 },
    ],
    hazards: ['wave', 'kraken', 'sharks', 'wave', 'pirate', 'kraken', 'wave', 'kraken'],
  },
];
