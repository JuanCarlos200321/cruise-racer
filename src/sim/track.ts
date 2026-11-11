import type { Vec2 } from './physics';
import { createRng } from './rng';

export type ObstacleKind = 'island' | 'mountain' | 'rocks' | 'city';
export type TrackTheme = 'tropical' | 'harbour' | 'fjord';

/** Solid circular obstacle. */
export interface Obstacle {
  x: number;
  z: number;
  r: number;
  kind: ObstacleKind;
  seed: number;
}

/** Obstacles placed at random around the course, never on it. */
interface ScatterFeature {
  type: 'scatter';
  kind: ObstacleKind;
  count: number;
  minRadius: number;
  maxRadius: number;
  /** Minimum gap between the obstacle and the edge of the course. */
  margin: number;
  /** How far beyond the course bounds obstacles may be placed. */
  spread: number;
}

/** A line of obstacles along one or both edges of the course. */
interface WallFeature {
  type: 'wall';
  kind: ObstacleKind;
  minRadius: number;
  maxRadius: number;
  margin: number;
  /** Portion of the lap covered, as fractions 0..1. */
  from: number;
  to: number;
}

export interface TrackDef {
  id: string;
  name: string;
  description: string;
  theme: TrackTheme;
  /** Half the width of the marked course, metres. */
  halfWidth: number;
  /** Control points of the closed centreline. The start line is at the first. */
  points: [number, number][];
  scale: number;
  seed: number;
  features: (ScatterFeature | WallFeature)[];
}

const SAMPLE_SPACING = 20;
const CHECKPOINT_SPACING = 600;
const DENSE_STEPS = 48;

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

export class Track {
  readonly def: TrackDef;
  readonly halfWidth: number;
  /** Evenly spaced points along the closed centreline. */
  readonly samples: Vec2[] = [];
  /** Unit direction of travel at each sample. */
  readonly tangents: Vec2[] = [];
  /** Curvature (1 / turn radius) at each sample. */
  readonly curvature: number[] = [];
  readonly spacing: number;
  readonly length: number;
  readonly obstacles: Obstacle[] = [];
  /** Sample indices of the checkpoints. The first is the start line. */
  readonly checkpoints: number[] = [];

  constructor(def: TrackDef) {
    this.def = def;
    this.halfWidth = def.halfWidth;

    const pts = def.points.map(([x, z]) => ({ x: x * def.scale, z: z * def.scale }));
    const dense: Vec2[] = [];
    const count = pts.length;
    for (let i = 0; i < count; i++) {
      const p0 = pts[(i - 1 + count) % count];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % count];
      const p3 = pts[(i + 2) % count];
      for (let k = 0; k < DENSE_STEPS; k++) {
        const t = k / DENSE_STEPS;
        dense.push({
          x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
          z: catmullRom(p0.z, p1.z, p2.z, p3.z, t),
        });
      }
    }

    // Resample to even spacing along the curve.
    const cumulative = [0];
    for (let i = 0; i < dense.length; i++) {
      const a = dense[i];
      const b = dense[(i + 1) % dense.length];
      cumulative.push(cumulative[i] + Math.hypot(b.x - a.x, b.z - a.z));
    }
    this.length = cumulative[dense.length];
    const n = Math.round(this.length / SAMPLE_SPACING);
    this.spacing = this.length / n;
    let seg = 0;
    for (let i = 0; i < n; i++) {
      const target = i * this.spacing;
      while (cumulative[seg + 1] < target) seg++;
      const a = dense[seg];
      const b = dense[(seg + 1) % dense.length];
      const t = (target - cumulative[seg]) / (cumulative[seg + 1] - cumulative[seg]);
      this.samples.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }

    for (let i = 0; i < n; i++) {
      const prev = this.samples[(i - 1 + n) % n];
      const next = this.samples[(i + 1) % n];
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const len = Math.hypot(dx, dz);
      this.tangents.push({ x: dx / len, z: dz / len });
    }
    for (let i = 0; i < n; i++) {
      const a = this.tangents[(i - 1 + n) % n];
      const b = this.tangents[(i + 1) % n];
      const turn = Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z);
      this.curvature.push(Math.abs(turn) / (2 * this.spacing));
    }

    const checkpointCount = Math.max(4, Math.round(this.length / CHECKPOINT_SPACING));
    for (let k = 0; k < checkpointCount; k++) {
      this.checkpoints.push(Math.round((k * n) / checkpointCount) % n);
    }

    this.buildObstacles();
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  wrap(index: number): number {
    const n = this.samples.length;
    return ((index % n) + n) % n;
  }

  /** Heading of the direction of travel at a sample. */
  headingAt(index: number): number {
    const t = this.tangents[this.wrap(index)];
    return Math.atan2(t.x, t.z);
  }

  /** Point at a sample, offset sideways. Positive lateral is to starboard. */
  pointAt(index: number, lateral = 0): Vec2 {
    const i = this.wrap(index);
    const p = this.samples[i];
    const t = this.tangents[i];
    return { x: p.x - t.z * lateral, z: p.z + t.x * lateral };
  }

  /**
   * Nearest centreline sample. With a hint, only samples just around it are
   * searched, so a ship cannot jump to another part of the course by cutting.
   */
  nearest(x: number, z: number, hint?: number): TrackPosition {
    const n = this.samples.length;
    let best = 0;
    let bestDist = Infinity;
    const from = hint === undefined ? 0 : hint - 8;
    const to = hint === undefined ? n - 1 : hint + 16;
    for (let j = from; j <= to; j++) {
      const i = this.wrap(j);
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

  /** Distance from a point to the centreline, searching the whole course. */
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
      if (feature.type === 'wall') {
        for (const side of [-1, 1]) {
          let i = Math.round(feature.from * n);
          const end = Math.round(feature.to * n);
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
    id: 'island-loop',
    name: 'Island Loop',
    description: 'A wide, flowing circuit around a chain of Caribbean islands. The place to learn your ship.',
    theme: 'tropical',
    halfWidth: 250,
    scale: 0.85,
    seed: 11,
    points: [
      [0, 0],
      [0, 650],
      [350, 1200],
      [1000, 1350],
      [1550, 950],
      [1500, 300],
      [1650, -350],
      [1250, -900],
      [550, -950],
      [100, -550],
    ],
    features: [
      { type: 'scatter', kind: 'island', count: 16, minRadius: 70, maxRadius: 300, margin: 50, spread: 1100 },
    ],
  },
  {
    id: 'harbour-sprint',
    name: 'Harbour Sprint',
    description: 'A tight port course between breakwaters and the city front. Slow in, fast out.',
    theme: 'harbour',
    halfWidth: 180,
    scale: 0.85,
    seed: 23,
    points: [
      [0, 0],
      [0, 550],
      [350, 1000],
      [950, 950],
      [1250, 450],
      [1800, 300],
      [2100, -200],
      [1750, -700],
      [1150, -550],
      [600, -850],
      [100, -550],
    ],
    features: [
      { type: 'wall', kind: 'rocks', minRadius: 28, maxRadius: 40, margin: 25, from: 0.3, to: 0.72 },
      { type: 'scatter', kind: 'city', count: 12, minRadius: 150, maxRadius: 280, margin: 60, spread: 700 },
      { type: 'scatter', kind: 'rocks', count: 10, minRadius: 30, maxRadius: 60, margin: 40, spread: 300 },
    ],
  },
  {
    id: 'fjord-run',
    name: 'Fjord Run',
    description: 'A long, fast channel between sheer mountain walls. There is nowhere to run wide.',
    theme: 'fjord',
    halfWidth: 230,
    scale: 0.9,
    seed: 37,
    points: [
      [0, 0],
      [0, 800],
      [-300, 1500],
      [-150, 2200],
      [500, 2550],
      [1150, 2250],
      [1200, 1500],
      [1500, 800],
      [1350, 0],
      [700, -550],
    ],
    features: [
      { type: 'wall', kind: 'mountain', minRadius: 130, maxRadius: 210, margin: 30, from: 0, to: 1 },
      { type: 'scatter', kind: 'mountain', count: 30, minRadius: 220, maxRadius: 420, margin: 200, spread: 1500 },
    ],
  },
];
