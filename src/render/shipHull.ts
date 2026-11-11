import * as THREE from 'three';
import type { MeshBuffer, P3 } from './shipGeometry';

const STATIONS = 72;
const ROWS = 14;
/** Fraction of the length over which the stern narrows to the transom. */
const STERN_LENGTH = 0.07;

const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;

/**
 * The shape of a cruise ship hull: a raked, flared bow that is finer at the
 * waterline than at the deck, parallel sides amidships and a wide transom
 * stern that tucks in towards the water.
 *
 * Ship space: bow towards +Z, up +Y, port +X, origin at the waterline amidships.
 */
export class Hull {
  /** Depth of hull modelled below the waterline, metres. */
  readonly draft = 5.5;
  private readonly rake: number;
  private readonly overhang: number;

  /**
   * @param top height of the hull's upper deck above the waterline
   * @param bow fraction of the length over which the bow narrows, at deck level
   */
  constructor(
    readonly length: number,
    readonly beam: number,
    readonly top: number,
    readonly bow: number,
  ) {
    this.rake = top * 0.55;
    this.overhang = top * 0.35;
  }

  /** Position of the stem (the front edge) at a height. */
  zStem(y: number): number {
    return this.length / 2 - this.rake * (1 - clamp(y / this.top, 0, 1));
  }

  /** Position of the transom (the back edge) at a height. */
  zStern(y: number): number {
    const h = clamp(y / this.top, 0, 1);
    const depth = clamp(-y / this.draft, 0, 1);
    return -this.length / 2 + this.overhang * Math.pow(1 - h, 1.5) + depth * 14;
  }

  /** Half the hull's width at a height and a position along the ship. */
  halfBreadth(z: number, y: number): number {
    const h = clamp(y / this.top, 0, 1);
    const depth = clamp(-y / this.draft, 0, 1);
    const stern = this.zStern(y);
    const s = clamp((z - stern) / (this.zStem(y) - stern), 0, 1);

    let width = 1;
    if (s < STERN_LENGTH) {
      const transom = lerp(0.68, 0.93, h);
      width = transom + (1 - transom) * Math.sin(((s / STERN_LENGTH) * Math.PI) / 2);
    }
    // The bow is longer and sharper at the waterline, so the sides flare out above it.
    const entrance = this.bow * lerp(1.45, 1, h);
    if (s > 1 - entrance) {
      const b = (s - (1 - entrance)) / entrance;
      width = 1 - Math.pow(b, lerp(1.35, 2.2, h));
    }
    width *= lerp(1, 0.6, depth * depth);
    return (this.beam / 2) * width;
  }

  /** Half the width of the hull's upper deck at a position along the ship. */
  deckHalfBreadth(z: number): number {
    return this.halfBreadth(z, this.top);
  }

  /** Texture v for a height, shared by the sides and the transom. */
  private v(y: number): number {
    return (y + this.draft) / (this.top + this.draft);
  }

  /**
   * Add the hull to four buffers. Side textures are projected from abeam: u
   * runs stern to bow on the starboard side and bow to stern on the port side,
   * so lettering reads correctly on both.
   */
  build(port: MeshBuffer, starboard: MeshBuffer, transom: MeshBuffer, deck: MeshBuffer): void {
    const rows: number[] = [];
    for (let j = 0; j <= ROWS; j++) rows.push(-this.draft + ((this.top + this.draft) * j) / ROWS);
    const stations: number[] = [];
    for (let i = 0; i <= STATIONS; i++) stations.push(0.5 - 0.5 * Math.cos((Math.PI * i) / STATIONS));

    const point = (i: number, j: number, side: number): P3 => {
      const y = rows[j];
      const stern = this.zStern(y);
      const z = stern + (this.zStem(y) - stern) * stations[i];
      return [side * this.halfBreadth(z, y), y, z];
    };

    for (const side of [1, -1]) {
      const positions: number[] = [];
      const uvs: number[] = [];
      for (let j = 0; j <= ROWS; j++) {
        for (let i = 0; i <= STATIONS; i++) {
          const p = point(i, j, side);
          positions.push(p[0], p[1], p[2]);
          const along = (p[2] + this.length / 2) / this.length;
          uvs.push(side > 0 ? 1 - along : along, this.v(p[1]));
        }
      }
      const indices: number[] = [];
      const width = STATIONS + 1;
      for (let j = 0; j < ROWS; j++) {
        for (let i = 0; i < STATIONS; i++) {
          const a = j * width + i;
          const b = a + 1;
          const c = a + width;
          const d = c + 1;
          // Wind the triangles so the surface faces away from the centreline.
          if (side > 0) indices.push(a, c, b, b, c, d);
          else indices.push(a, b, c, b, d, c);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      (side > 0 ? port : starboard).add(geometry);
      geometry.dispose();
    }

    for (let j = 0; j < ROWS; j++) {
      const a = point(0, j, 1);
      const b = point(0, j, -1);
      const c = point(0, j + 1, -1);
      const d = point(0, j + 1, 1);
      // Seen from astern, port (+X) is on the left.
      const u = (p: P3): number => 0.5 - p[0] / this.beam;
      transom.quad(a, b, c, d, [0, 0, -1], [
        [u(a), this.v(a[1])],
        [u(b), this.v(b[1])],
        [u(c), this.v(c[1])],
        [u(d), this.v(d[1])],
      ]);
    }

    for (let i = 0; i < STATIONS; i++) {
      deck.quad(point(i, ROWS, 1), point(i, ROWS, -1), point(i + 1, ROWS, -1), point(i + 1, ROWS, 1), [0, 1, 0]);
    }
  }
}
