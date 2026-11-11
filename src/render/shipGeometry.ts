import * as THREE from 'three';

/** A point on the deck plan: x (port is positive) and z (bow is positive). */
export type P2 = [number, number];
export type P3 = [number, number, number];

/** Collects triangles for one material so a whole ship needs only a few meshes. */
export class MeshBuffer {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];
  private readonly indices: number[] = [];

  get isEmpty(): boolean {
    return this.indices.length === 0;
  }

  vertex(p: P3, n: P3, u = 0, v = 0): number {
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    this.uvs.push(u, v);
    return this.positions.length / 3 - 1;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** A flat quad with corners in order round its edge, facing roughly `toward`. */
  quad(a: P3, b: P3, c: P3, d: P3, toward: P3, uv?: [P2, P2, P2, P2]): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    const flip = nx * toward[0] + ny * toward[1] + nz * toward[2] < 0;
    const n: P3 = flip ? [-nx, -ny, -nz] : [nx, ny, nz];
    const i = [a, b, c, d].map((p, k) => this.vertex(p, n, uv?.[k][0] ?? 0, uv?.[k][1] ?? 0));
    if (flip) this.indices.push(i[0], i[2], i[1], i[0], i[3], i[2]);
    else this.indices.push(i[0], i[1], i[2], i[0], i[2], i[3]);
  }

  /** Append a geometry, optionally moved into place. The geometry is not kept. */
  add(geometry: THREE.BufferGeometry, matrix?: THREE.Matrix4): void {
    const g = matrix ? geometry.clone().applyMatrix4(matrix) : geometry;
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    const uv = g.attributes.uv;
    const base = this.positions.length / 3;
    for (let i = 0; i < pos.count; i++) {
      this.positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      this.normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      this.uvs.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
    }
    if (g.index) {
      for (let k = 0; k < g.index.count; k++) this.indices.push(base + g.index.getX(k));
    } else {
      for (let k = 0; k < pos.count; k++) this.indices.push(base + k);
    }
    if (matrix) g.dispose();
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.setIndex(this.indices);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

export interface Segment {
  a: P2;
  b: P2;
  length: number;
  /** Unit normal pointing out of the polygon. */
  nx: number;
  nz: number;
}

/** Edges of a closed polygon with their outward normals. */
export function segmentsOf(points: P2[]): Segment[] {
  let cx = 0;
  let cz = 0;
  for (const [x, z] of points) {
    cx += x / points.length;
    cz += z / points.length;
  }
  const segments: Segment[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length = Math.hypot(dx, dz);
    if (length < 1e-4) continue;
    let nx = dz / length;
    let nz = -dx / length;
    if (nx * ((a[0] + b[0]) / 2 - cx) + nz * ((a[1] + b[1]) / 2 - cz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    segments.push({ a, b, length, nx, nz });
  }
  return segments;
}

/** Move every edge of a closed polygon inwards by a distance. */
export function offsetPolygon(points: P2[], distance: number): P2[] {
  const segments = segmentsOf(points);
  return segments.map((segment, i) => {
    const before = segments[(i - 1 + segments.length) % segments.length];
    let nx = segment.nx + before.nx;
    let nz = segment.nz + before.nz;
    const length = Math.hypot(nx, nz) || 1;
    nx /= length;
    nz /= length;
    // Keep the edges the stated distance apart at corners, within reason.
    const spread = Math.min(1.6, 1 / Math.max(0.3, nx * segment.nx + nz * segment.nz));
    return [segment.a[0] - nx * distance * spread, segment.a[1] - nz * distance * spread] as P2;
  });
}

/** Edges that meet at less than this (as a cosine) are shaded as one curved surface. */
const SMOOTH = 0.72;

/**
 * A vertical wall round a closed polygon. Texture u is the distance round the
 * wall in metres and v the height above `vBase`.
 */
export function ringWall(buffer: MeshBuffer, points: P2[], y0: number, y1: number, vBase = y0): void {
  const segments = segmentsOf(points);
  let u = 0;
  segments.forEach((segment, i) => {
    const before = segments[(i - 1 + segments.length) % segments.length];
    const after = segments[(i + 1) % segments.length];
    const blend = (other: Segment): P3 => {
      if (other.nx * segment.nx + other.nz * segment.nz < SMOOTH) return [segment.nx, 0, segment.nz];
      const nx = other.nx + segment.nx;
      const nz = other.nz + segment.nz;
      const length = Math.hypot(nx, nz);
      return [nx / length, 0, nz / length];
    };
    const n0 = blend(before);
    const n1 = blend(after);
    const { a, b } = segment;
    const u1 = u + segment.length;
    const i0 = buffer.vertex([a[0], y0, a[1]], n0, u, y0 - vBase);
    const i1 = buffer.vertex([b[0], y0, b[1]], n1, u1, y0 - vBase);
    const i2 = buffer.vertex([b[0], y1, b[1]], n1, u1, y1 - vBase);
    const i3 = buffer.vertex([a[0], y1, a[1]], n0, u, y1 - vBase);
    // (b - a) x (up) points along (-dz, dx); wind the quad to face outwards.
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    if (-dz * segment.nx + dx * segment.nz > 0) {
      buffer.triangle(i0, i1, i2);
      buffer.triangle(i0, i2, i3);
    } else {
      buffer.triangle(i0, i2, i1);
      buffer.triangle(i0, i3, i2);
    }
    u = u1;
  });
}

/** A flat, upward-facing surface filling a closed polygon. */
export function cap(buffer: MeshBuffer, points: P2[], y: number): void {
  const shape = new THREE.Shape();
  points.forEach(([x, z], i) => {
    if (i === 0) shape.moveTo(x, -z);
    else shape.lineTo(x, -z);
  });
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, y, 0);
  buffer.add(geometry);
  geometry.dispose();
}
