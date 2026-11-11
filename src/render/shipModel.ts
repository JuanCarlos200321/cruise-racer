import * as THREE from 'three';
import type { ShipClass, ShipClassId } from '../sim/ships';
import { cap, MeshBuffer, offsetPolygon, ringWall, segmentsOf, type P2 } from './shipGeometry';
import { Hull } from './shipHull';
import { CABIN_WIDTH, DECK_HEIGHT, materialsFor, NO_SHADOW, type MaterialKey } from './shipMaterials';

/**
 * Procedural ship models. Ship space: bow towards +Z, up +Y, port +X, origin
 * at the waterline amidships.
 */

/** How far the balconies stand out from the cabin wall, metres. */
const BALCONY_DEPTH = 1.6;
/** Half the thickness of a deck slab, metres. */
const SLAB = 0.18;
const RAIL_HEIGHT = 1.1;

type BlockStyle = 'balcony' | 'windows' | 'white' | 'recess';

interface BlockOptions {
  /** Number of decks. */
  decks: number;
  /** Extent along the ship, as fractions of its length: -0.5 is the stern, 0.5 the bow. */
  from: number;
  to: number;
  style: BlockStyle;
  /** Distance in from the side of the hull, metres. */
  inset?: number;
  /** Length over which the forward end narrows, metres, and the width left at the end. */
  front?: number;
  tip?: number;
  /** The same for the after end. */
  back?: number;
  tail?: number;
  /** Build two towers either side of an open space this far from the centreline, metres. */
  inner?: number;
  /** Height of the base. Defaults to the top of the ship so far, which is then raised. */
  y?: number;
  roof?: MaterialKey | 'none';
  /** Glass wind screen round the roof. */
  screen?: boolean;
}

/** Where the bridge is in ship space, for the bridge camera. */
export interface BridgePosition {
  /** Height of the bridge roof above the waterline. */
  y: number;
  /** Distance ahead of midships. */
  z: number;
}

class ShipBuilder {
  readonly L: number;
  readonly B: number;
  readonly hull: Hull;
  /** Height of the topmost deck so far. */
  top: number;
  bridgePosition: BridgePosition | null = null;
  private readonly buffers = new Map<MaterialKey, MeshBuffer>();

  constructor(
    readonly cls: ShipClass,
    bowLength: number,
  ) {
    this.L = cls.length;
    this.B = cls.beam;
    this.hull = new Hull(cls.length, cls.beam, Math.round(cls.height * 0.25), bowLength);
    this.top = this.hull.top;
    this.addHull();
  }

  buffer(key: MaterialKey): MeshBuffer {
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = new MeshBuffer();
      this.buffers.set(key, buffer);
    }
    return buffer;
  }

  parts(): [MaterialKey, THREE.BufferGeometry][] {
    return [...this.buffers].filter(([, buffer]) => !buffer.isEmpty).map(([key, buffer]) => [key, buffer.build()]);
  }

  /** z along the ship from a fraction of its length: -0.5 at the stern, 0.5 at the bow. */
  z(fraction: number): number {
    return fraction * this.L;
  }

  /** Half the width of the ship at a position along it. */
  half(fraction: number): number {
    return this.hull.deckHalfBreadth(this.z(fraction));
  }

  /** Add a standard geometry, moved, turned and scaled into place. */
  place(
    key: MaterialKey,
    geometry: THREE.BufferGeometry,
    position: [number, number, number],
    rotation: [number, number, number] = [0, 0, 0],
    scale: [number, number, number] = [1, 1, 1],
  ): void {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
      new THREE.Vector3(...scale),
    );
    this.buffer(key).add(geometry, matrix);
    geometry.dispose();
  }

  /** A box standing on height y, centred on x and z. */
  box(key: MaterialKey, w: number, h: number, d: number, x: number, y: number, z: number, tilt = 0): void {
    this.place(key, new THREE.BoxGeometry(w, h, d), [x, y + h / 2, z], [tilt, 0, 0]);
  }

  private addHull(): void {
    const hull = this.hull;
    hull.build(this.buffer('hullPort'), this.buffer('hullStarboard'), this.buffer('transom'), this.buffer('teak'));

    // Solid bulwark round the foredeck, closed off by a breakwater.
    const start = this.L / 2 - this.L * hull.bow * 0.95;
    const side: P2[] = [];
    for (let i = 0; i <= 24; i++) {
      const z = start + (this.L / 2 - 0.3 - start) * (i / 24);
      side.push([hull.deckHalfBreadth(z), z]);
    }
    const mirrored = side
      .slice()
      .reverse()
      .map(([x, z]): P2 => [-x, z]);
    ringWall(this.buffer('panel'), [...side, ...mirrored], hull.top, hull.top + 1.3);

    const padZ = this.L / 2 - this.L * hull.bow * 0.42;
    const radius = hull.deckHalfBreadth(padZ) * 0.62;
    this.place('helipad', new THREE.CircleGeometry(radius, 32), [0, hull.top + 0.06, padZ], [-Math.PI / 2, 0, 0]);
  }

  /** Deck plan outlines for a block: one, or a mirrored pair of towers. */
  private outlines(o: BlockOptions): P2[][] {
    const zStern = this.z(o.from);
    const zBow = this.z(o.to);
    const steps = 36;
    const outer: P2[] = [];
    for (let i = 0; i <= steps; i++) {
      const z = zStern + (zBow - zStern) * (0.5 - 0.5 * Math.cos((Math.PI * i) / steps));
      let width = Math.max(0.5, this.hull.deckHalfBreadth(z) - (o.inset ?? 0));
      if (o.front && z > zBow - o.front) {
        const tip = o.tip ?? 0.5;
        width *= tip + (1 - tip) * (1 - Math.pow((z - (zBow - o.front)) / o.front, 2.2));
      }
      if (o.back && z < zStern + o.back) {
        const tail = o.tail ?? 0.8;
        width *= tail + (1 - tail) * (1 - Math.pow(1 - (z - zStern) / o.back, 2.2));
      }
      outer.push([width, z]);
    }
    if (o.inner === undefined) {
      const mirrored = outer
        .slice()
        .reverse()
        .map(([x, z]): P2 => [-x, z]);
      return [[...outer, ...mirrored]];
    }
    const inner = o.inner;
    const port: P2[] = [...outer.map(([x, z]): P2 => [Math.max(x, inner + 4), z]), [inner, zBow], [inner, zStern]];
    return [port, port.map(([x, z]): P2 => [-x, z])];
  }

  /**
   * A stack of decks. Balcony decks get a slab, a glass rail and dividers on
   * every deck, with the cabin wall set back behind them.
   */
  block(o: BlockOptions): number {
    const y0 = o.y ?? this.top;
    const y1 = y0 + o.decks * DECK_HEIGHT;
    const roof = o.roof ?? 'teak';

    for (const outline of this.outlines(o)) {
      if (o.style === 'balcony') {
        ringWall(this.buffer('cabin'), offsetPolygon(outline, BALCONY_DEPTH), y0, y1);
        const segments = segmentsOf(outline);
        for (let k = 0; k <= o.decks; k++) {
          const y = y0 + k * DECK_HEIGHT;
          const isRoof = k === o.decks;
          ringWall(this.buffer('white'), outline, y - SLAB, y + SLAB);
          if (!isRoof || roof !== 'none') cap(this.buffer(isRoof ? (roof as MaterialKey) : 'white'), outline, y + SLAB);
          if (isRoof) break;
          ringWall(this.buffer('rail'), outline, y + SLAB, y + SLAB + RAIL_HEIGHT);

          // A divider between each pair of balconies.
          const panels = this.buffer('panel');
          let next = CABIN_WIDTH / 2;
          for (const s of segments) {
            const dx = (s.b[0] - s.a[0]) / s.length;
            const dz = (s.b[1] - s.a[1]) / s.length;
            for (; next < s.length; next += CABIN_WIDTH) {
              const x = s.a[0] + dx * next;
              const z = s.a[1] + dz * next;
              const ix = x - s.nx * BALCONY_DEPTH;
              const iz = z - s.nz * BALCONY_DEPTH;
              panels.quad(
                [x, y + SLAB, z],
                [ix, y + SLAB, iz],
                [ix, y + DECK_HEIGHT - SLAB, iz],
                [x, y + DECK_HEIGHT - SLAB, z],
                [dx, 0, dz],
              );
            }
            next -= s.length;
          }
        }
      } else {
        const key: MaterialKey = o.style === 'white' ? 'white' : o.style;
        ringWall(this.buffer(key), outline, y0, y1);
        if (roof !== 'none') cap(this.buffer(roof), outline, y1);
      }
      if (o.screen) ringWall(this.buffer('rail'), offsetPolygon(outline, 0.5), y1, y1 + 2);
    }

    if (o.y === undefined) this.top = y1;
    return y1;
  }

  /** Recessed promenade under the cabins, with the lifeboats hung along it. */
  promenade(from: number, to: number): void {
    const y = this.top;
    this.block({ decks: 2, from, to, style: 'recess', inset: 3.8, front: 24, roof: 'none' });

    const start = this.z(from + 0.09);
    const end = this.z(to - 0.16);
    const count = Math.floor((end - start) / 16);
    for (let i = 0; i < count; i++) {
      const z = start + (i + 0.5) * ((end - start) / count);
      for (const side of [1, -1]) {
        const x = side * (this.hull.deckHalfBreadth(z) - 2.1);
        // Orange canopy over a white hull.
        this.place('boatTop', new THREE.CapsuleGeometry(1.9, 9, 3, 10), [x, y + 3.5, z], [Math.PI / 2, 0, 0]);
        this.place(
          'white',
          new THREE.CapsuleGeometry(1.9, 9, 3, 10),
          [x, y + 2.75, z],
          [Math.PI / 2, 0, 0],
          [1.03, 1.02, 0.72],
        );
        for (const davit of [-5, 5]) {
          this.box('grey', 2.6, 0.35, 0.35, x - side * 1.3, y + 5.5, z + davit);
        }
      }
    }
  }

  /** Dark band of bridge windows across the front, with wings reaching past the sides. */
  bridge(zFraction: number): void {
    const y = this.top - DECK_HEIGHT;
    const z = this.z(zFraction);
    const width = this.hull.deckHalfBreadth(z) * 2;
    this.box('darkGlass', width + 7, DECK_HEIGHT - 0.5, 7, 0, y + 0.3, z);
    this.box('white', width + 8, 0.45, 8, 0, y + DECK_HEIGHT - 0.2, z);
    this.box('white', width + 8, 0.45, 8, 0, y - 0.15, z);
    this.bridgePosition = { y: this.top, z };
  }

  funnel(zFraction: number, x: number, width: number, depth: number, height: number): void {
    const z = this.z(zFraction);
    const y = this.top;
    const rake = -0.12;
    this.place(
      'white',
      new THREE.CylinderGeometry(0.4, 0.5, 1, 32),
      [x, y + height / 2, z],
      [rake, 0, 0],
      [width, height, depth],
    );
    const lean = height * Math.sin(-rake);
    this.place(
      'black',
      new THREE.CylinderGeometry(0.41, 0.4, 1, 32),
      [x, y + height * 1.03, z - lean * 0.55],
      [rake, 0, 0],
      [width, height * 0.1, depth],
    );
    for (const offset of [-0.2, 0, 0.2]) {
      this.place('black', new THREE.CylinderGeometry(0.55, 0.55, 2.4, 10), [
        x,
        y + height * 1.08 + 1.2,
        z - lean * 0.55 + offset * depth,
      ]);
    }
    const size = Math.min(depth * 0.42, height * 0.55);
    for (const side of [1, -1]) {
      this.place(
        'emblem',
        new THREE.PlaneGeometry(size, size),
        [x + side * width * 0.455, y + height * 0.56, z - lean * 0.05],
        [0, (side * Math.PI) / 2, 0],
      );
    }
  }

  mast(zFraction: number, height: number): void {
    const z = this.z(zFraction);
    const y = this.top;
    this.place('grey', new THREE.CylinderGeometry(0.5, 1.4, height, 8), [0, y + height / 2, z]);
    this.box('grey', 13, 0.5, 1.1, 0, y + height * 0.6, z);
    this.box('grey', 7, 0.5, 1.1, 0, y + height * 0.82, z);
    this.box('white', 4.5, 0.5, 0.6, 0, y + height * 0.66, z + 1.2);
    for (const x of [-5.5, 5.5]) {
      this.place('white', new THREE.SphereGeometry(1.1, 12, 8), [x, y + height * 0.6 + 1.5, z]);
    }
    this.place('white', new THREE.SphereGeometry(1.8, 14, 10), [0, y + height + 1, z]);
  }

  pool(zFraction: number, x: number, w: number, d: number): void {
    const z = this.z(zFraction);
    this.box('white', w + 2, 0.5, d + 2, x, this.top + SLAB, z);
    this.box('pool', w, 0.2, d, x, this.top + SLAB + 0.4, z);
  }

  /** A row of sun loungers running along the ship. */
  loungers(zFraction: number, x: number, length: number): void {
    const z = this.z(zFraction);
    const count = Math.floor(length / 1.3);
    for (let i = 0; i < count; i++) {
      this.box('white', 1.9, 0.35, 0.7, x, this.top + SLAB, z - length / 2 + (i + 0.5) * 1.3);
    }
  }

  dome(zFraction: number, y: number, radius: number, squash: number, stretch = 1): void {
    this.place(
      'glass',
      new THREE.SphereGeometry(radius, 36, 16, 0, Math.PI * 2, 0, Math.PI / 2),
      [0, y, this.z(zFraction)],
      [0, 0, 0],
      [1, squash, stretch],
    );
  }

  /** Lounge wrapped round the funnel, a Royal Caribbean signature. */
  crownLounge(zFraction: number, radius: number): void {
    const z = this.z(zFraction);
    this.place('white', new THREE.CylinderGeometry(radius * 0.55, radius * 0.62, 5.4, 24), [0, this.top + 2.7, z]);
    this.place('darkGlass', new THREE.CylinderGeometry(radius, radius * 0.9, 3.4, 36), [0, this.top + 7, z]);
    this.place('white', new THREE.CylinderGeometry(radius * 1.05, radius * 1.05, 0.7, 36), [0, this.top + 9, z]);
  }

  waterSlides(zFraction: number, scale: number): void {
    const z = this.z(zFraction);
    for (let i = 0; i < 5; i++) {
      const radius = scale * (0.55 + 0.12 * i);
      this.place(
        `slide${i}` as MaterialKey,
        new THREE.TorusGeometry(radius, 1.1, 10, 40, Math.PI * 1.6),
        [(i - 2) * scale * 0.42, this.top + 3.5 + i * 1.7, z + (i % 2 ? 6 : -6)],
        [Math.PI / 2 + (i % 2 ? 0.28 : -0.28), 0, i * 1.3],
      );
    }
    this.place('white', new THREE.CylinderGeometry(2, 2.6, 15, 12), [0, this.top + 7.5, z]);
  }

  /** A satellite dome on a short pedestal. */
  radome(zFraction: number, x: number, radius: number): void {
    const z = this.z(zFraction);
    this.box('white', radius, radius * 0.6, radius, x, this.top, z);
    this.place('white', new THREE.SphereGeometry(radius, 20, 14), [x, this.top + radius * 1.4, z]);
  }
}

function buildIcon(b: ShipBuilder): void {
  b.promenade(-0.46, 0.33);
  b.block({ decks: 4, from: -0.47, to: 0.34, style: 'balcony', front: 34 });
  b.block({ decks: 3, from: -0.45, to: 0.345, style: 'balcony', front: 34 });
  b.block({ decks: 1, from: -0.43, to: 0.35, style: 'windows', front: 32 });
  b.bridge(0.325);

  // Twin cabin towers with an open park between them, closed off forward.
  const base = b.top;
  const gap = b.B * 0.19;
  b.block({ decks: 3, from: -0.44, to: 0.2, style: 'balcony', inner: gap, y: base, screen: true });
  const front = b.block({ decks: 2, from: 0.2, to: 0.335, style: 'windows', y: base, front: 38, tip: 0.35 });
  b.box('turf', gap * 2, 0.4, b.L * 0.42, 0, base + 0.1, b.z(-0.02));
  b.box('sportDeck', gap * 2, 0.4, b.L * 0.2, 0, base + 0.1, b.z(-0.33));
  // The glass dome over the bow.
  b.dome(0.265, front - 1, b.B * 0.4, 0.62, 1.25);
  b.bridgePosition = { y: front + b.B * 0.25, z: b.z(0.3) };

  b.top = base + 3 * DECK_HEIGHT;
  const x = (gap + b.B / 2) / 2;
  b.funnel(-0.06, x, 9, 17, 12);
  b.funnel(-0.06, -x, 9, 17, 12);
  for (const side of [1, -1]) {
    b.pool(0.1, side * x, 7, 26);
    b.pool(-0.22, side * x, 7, 18);
    b.loungers(0.02, side * (x + 4.6), 30);
    b.loungers(-0.3, side * (x + 4.6), 24);
  }
  b.top = base;
  b.waterSlides(-0.36, 14);
  b.top = base + 3 * DECK_HEIGHT;
  b.mast(0.17, 13);
}

function buildOasis(b: ShipBuilder): void {
  b.promenade(-0.46, 0.33);
  b.block({ decks: 2, from: -0.47, to: 0.34, style: 'balcony', front: 34 });

  // The split superstructure: two long towers either side of an open park.
  const base = b.top;
  const gap = b.B * 0.2;
  b.block({ decks: 7, from: -0.48, to: 0.2, style: 'balcony', inner: gap, y: base, screen: true });
  b.block({ decks: 5, from: 0.2, to: 0.345, style: 'balcony', y: base, front: 34 });
  b.top = base + 5 * DECK_HEIGHT;
  b.block({ decks: 1, from: 0.2, to: 0.35, style: 'windows', front: 32 });
  b.bridge(0.325);
  const front = b.block({ decks: 1, from: 0.2, to: 0.33, style: 'windows', inset: 2, front: 30, tip: 0.4 });
  b.dome(0.26, front, b.B * 0.34, 0.45, 1.2);
  b.bridgePosition = { y: front + b.B * 0.16, z: b.z(0.3) };

  b.box('turf', gap * 2, 0.4, b.L * 0.3, 0, base + 0.1, b.z(0.04));
  b.box('teak', gap * 2, 0.4, b.L * 0.3, 0, base + 0.1, b.z(-0.3));
  b.box('pool', gap * 1.5, 0.3, 12, 0, base - 5.6, b.z(-0.475));
  // The funnels stand on a structure that bridges the park.
  b.block({ decks: 2, from: -0.2, to: -0.08, style: 'white', inset: 1, y: base + 5 * DECK_HEIGHT, roof: 'white' });

  b.top = base + 7 * DECK_HEIGHT;
  b.funnel(-0.115, 0, 11, 15, 12);
  b.funnel(-0.165, 0, 11, 15, 12);
  const x = (gap + b.B / 2) / 2;
  for (const side of [1, -1]) {
    b.pool(0.06, side * x, 7, 30);
    b.pool(-0.3, side * x, 7, 20);
    b.loungers(0.06, side * (x + 4.6), 38);
    b.loungers(-0.3, side * (x + 4.6), 26);
    b.box('sportDeck', 9, 0.3, 30, side * x, b.top + 0.2, b.z(-0.41));
  }
  b.mast(0.15, 12);
}

function buildQuantum(b: ShipBuilder): void {
  b.promenade(-0.47, 0.32);
  b.block({ decks: 6, from: -0.47, to: 0.335, style: 'balcony', front: 32 });
  b.block({ decks: 2, from: -0.44, to: 0.34, style: 'balcony', front: 32 });
  b.block({ decks: 1, from: -0.42, to: 0.345, style: 'windows', front: 30 });
  b.bridge(0.32);
  b.block({ decks: 1, from: -0.4, to: 0.27, style: 'windows', inset: 2, front: 24, screen: true });

  // Glass-walled lounge across the stern.
  b.box('glass', b.half(-0.46) * 1.7, 9, 5, 0, b.hull.top + 7, b.z(-0.468));
  // Indoor sports hall aft.
  b.block({ decks: 3, from: -0.4, to: -0.24, style: 'white', inset: 4, y: b.top, roof: 'white', back: 10 });
  b.funnel(-0.12, 0, 14, 22, 13);
  b.pool(0.1, 0, 14, 32);
  b.loungers(0.1, 11, 34);
  b.loungers(0.1, -11, 34);
  b.dome(0.22, b.top, b.B * 0.32, 0.4, 1.3);
  // Observation capsule on a long arm.
  b.place('white', new THREE.CylinderGeometry(0.9, 1.3, 36, 10), [5, b.top + 15, b.z(0.0)], [0, 0, -0.5]);
  b.place('glass', new THREE.SphereGeometry(3.4, 20, 14), [14, b.top + 31, b.z(0.0)]);
  b.mast(0.2, 13);
}

function buildFreedom(b: ShipBuilder): void {
  b.promenade(-0.46, 0.31);
  b.block({ decks: 5, from: -0.46, to: 0.325, style: 'balcony', front: 30 });
  b.block({ decks: 2, from: -0.4, to: 0.33, style: 'balcony', front: 30 });
  b.block({ decks: 1, from: -0.34, to: 0.335, style: 'windows', front: 28 });
  b.bridge(0.31);
  b.block({ decks: 1, from: -0.3, to: 0.25, style: 'windows', inset: 2.5, front: 22, screen: true });

  b.pool(0.1, 0, 13, 28);
  b.pool(-0.02, 0, 11, 14);
  b.loungers(0.06, 10.5, 50);
  b.loungers(0.06, -10.5, 50);
  b.crownLounge(-0.15, b.B * 0.36);
  b.funnel(-0.19, 0, 12, 20, 15);
  // Surf simulator on the aft sports deck.
  b.box('pool', 12, 2.5, 14, 0, b.top, b.z(-0.26), 0.18);
  b.box('white', 14, 3.5, 2, 0, b.top, b.z(-0.235));
  b.mast(0.19, 12);
}

function buildRadiance(b: ShipBuilder): void {
  b.promenade(-0.45, 0.29);
  // More glass than most: the class is known for its walls of windows.
  b.block({ decks: 2, from: -0.45, to: 0.31, style: 'windows', front: 26 });
  b.block({ decks: 3, from: -0.43, to: 0.315, style: 'balcony', front: 26 });
  b.block({ decks: 1, from: -0.36, to: 0.32, style: 'balcony', front: 26 });
  b.block({ decks: 1, from: -0.3, to: 0.325, style: 'windows', front: 24 });
  b.bridge(0.3);
  b.block({ decks: 1, from: -0.26, to: 0.24, style: 'windows', inset: 2.5, front: 20, screen: true });

  b.pool(0.07, 0, 10, 20);
  b.loungers(0.07, 8.5, 28);
  b.loungers(0.07, -8.5, 28);
  b.dome(-0.02, b.top, b.B * 0.36, 0.42, 1.3);
  b.crownLounge(-0.14, b.B * 0.38);
  b.funnel(-0.18, 0, 10, 17, 13);
  b.radome(0.16, 0, 3.6);
  b.radome(-0.24, 0, 3);
  b.mast(0.21, 11);
}

interface ClassDesign {
  /** Fraction of the length over which the bow narrows. */
  bow: number;
  /** Hull paint. */
  paint: string;
  build: (b: ShipBuilder) => void;
}

const DESIGNS: Record<ShipClassId, ClassDesign> = {
  icon: { bow: 0.2, paint: '#a9d9ee', build: buildIcon },
  oasis: { bow: 0.2, paint: '#f6f8fa', build: buildOasis },
  quantum: { bow: 0.21, paint: '#f6f8fa', build: buildQuantum },
  freedom: { bow: 0.21, paint: '#f6f8fa', build: buildFreedom },
  radiance: { bow: 0.25, paint: '#f6f8fa', build: buildRadiance },
};

interface Prototype {
  parts: { geometry: THREE.BufferGeometry; material: THREE.Material; castShadow: boolean }[];
  bridge: BridgePosition;
}

/** Each class is built once; every ship of the class shares its geometry. */
const prototypes = new Map<ShipClassId, Prototype>();

function prototypeFor(cls: ShipClass): Prototype {
  let prototype = prototypes.get(cls.id);
  if (prototype) return prototype;

  const design = DESIGNS[cls.id];
  const builder = new ShipBuilder(cls, design.bow);
  design.build(builder);
  if (!builder.bridgePosition) throw new Error(`${cls.name} model has no bridge`);
  const materials = materialsFor(cls, builder.hull, design.paint);
  prototype = {
    parts: builder.parts().map(([key, geometry]) => ({
      geometry,
      material: materials[key],
      castShadow: !NO_SHADOW.has(key),
    })),
    bridge: builder.bridgePosition,
  };
  prototypes.set(cls.id, prototype);
  return prototype;
}

/** Build the model for a ship class. Add it to a parent that carries position and heading. */
export function createShipModel(cls: ShipClass): THREE.Group {
  const prototype = prototypeFor(cls);
  const group = new THREE.Group();
  for (const part of prototype.parts) {
    const mesh = new THREE.Mesh(part.geometry, part.material);
    mesh.castShadow = part.castShadow;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.userData.bridge = prototype.bridge;
  return group;
}

export function bridgeOf(model: THREE.Group): BridgePosition {
  return model.userData.bridge as BridgePosition;
}
