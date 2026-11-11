import * as THREE from 'three';
import type { ShipClass } from '../sim/ships';

/**
 * Procedural ship models. Ship space: bow towards +Z, up +Y, starboard -X,
 * origin at the waterline amidships.
 */

const DECK_HEIGHT = 3;
const OUTLINE_STEPS = 22;

type Outline = [number, number][];

interface OutlineOptions {
  /** Fraction of the length over which the bow narrows. */
  bow: number;
  /** Fraction of the length over which the stern narrows. */
  stern: number;
  /** Width left at the very front, as a fraction of full width. 0 is a point. */
  tip: number;
  /** Width left at the very back, as a fraction of full width. */
  transom: number;
}

function outline(z0: number, z1: number, halfWidth: number, o: OutlineOptions): Outline {
  const side: Outline = [];
  for (let i = 0; i <= OUTLINE_STEPS; i++) {
    // Cluster points towards the ends, where the outline curves.
    const t = 0.5 - 0.5 * Math.cos((i / OUTLINE_STEPS) * Math.PI);
    let w = 1;
    if (o.stern > 0 && t < o.stern) {
      const s = t / o.stern;
      w = o.transom + (1 - o.transom) * Math.sin((s * Math.PI) / 2);
    } else if (o.bow > 0 && t > 1 - o.bow) {
      const b = (t - (1 - o.bow)) / o.bow;
      w = o.tip + (1 - o.tip) * (1 - Math.pow(b, 1.9));
    }
    side.push([halfWidth * w, z0 + (z1 - z0) * t]);
  }
  const points: Outline = [...side];
  for (let i = side.length - 1; i >= 0; i--) {
    if (side[i][0] > 1e-3) points.push([-side[i][0], side[i][1]]);
  }
  return points;
}

/** A flat-topped solid with the given plan outline, from y0 up to y1. */
function slabGeometry(points: Outline, y0: number, y1: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  points.forEach(([x, z], i) => {
    if (i === 0) shape.moveTo(x, -z);
    else shape.lineTo(x, -z);
  });
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, y0, 0);
  return geometry;
}

function facadeTexture(draw: (ctx: CanvasRenderingContext2D, size: number) => void, widthMetres: number): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // Extruded side walls get UVs in metres; one tile is one cabin wide and one deck high.
  texture.repeat.set(1 / widthMetres, 1 / DECK_HEIGHT);
  texture.anisotropy = 8;
  return texture;
}

interface Materials {
  hullWhite: THREE.Material;
  hullBlue: THREE.Material;
  bootTop: THREE.Material;
  balconies: THREE.Material;
  glassDecks: THREE.Material;
  recess: THREE.Material;
  white: THREE.Material;
  deck: THREE.Material;
  glass: THREE.Material;
  darkGlass: THREE.Material;
  funnel: THREE.Material;
  funnelTop: THREE.Material;
  pool: THREE.Material;
  lifeboat: THREE.Material;
  turf: THREE.Material;
  mast: THREE.Material;
  slides: THREE.Material[];
}

let cached: Materials | null = null;

function materials(): Materials {
  if (cached) return cached;

  const balconyMap = facadeTexture((ctx, s) => {
    ctx.fillStyle = '#f4f6f8';
    ctx.fillRect(0, 0, s, s);
    // Each deck reads as a strip of shadowed glass doors above a pale glass rail.
    ctx.fillStyle = '#22313f';
    ctx.fillRect(3, 4, s - 6, s * 0.42);
    ctx.fillStyle = '#c3d6e3';
    ctx.fillRect(0, s * 0.5, s, s * 0.22);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, s * 0.72, s, s * 0.28);
  }, 3.4);

  const glassDeckMap = facadeTexture((ctx, s) => {
    ctx.fillStyle = '#eef2f5';
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#2f5d7c';
    ctx.fillRect(2, 5, s - 4, s * 0.7);
    ctx.fillStyle = '#5d94b5';
    ctx.fillRect(2, 5, s - 4, s * 0.22);
  }, 5);

  const portholeMap = facadeTexture((ctx, s) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#22303d';
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s * 0.13, 0, Math.PI * 2);
    ctx.fill();
  }, 5);

  const hullBlueMap = portholeMap.clone();
  hullBlueMap.needsUpdate = true;

  const paint = { roughness: 0.45, metalness: 0.0 };
  cached = {
    hullWhite: new THREE.MeshStandardMaterial({ map: portholeMap, ...paint }),
    hullBlue: new THREE.MeshStandardMaterial({ map: hullBlueMap, color: '#a9dcf2', ...paint }),
    bootTop: new THREE.MeshStandardMaterial({ color: '#13294b', roughness: 0.6 }),
    balconies: new THREE.MeshStandardMaterial({ map: balconyMap, roughness: 0.4, metalness: 0.1 }),
    glassDecks: new THREE.MeshStandardMaterial({ map: glassDeckMap, roughness: 0.25, metalness: 0.3 }),
    recess: new THREE.MeshStandardMaterial({ color: '#27313b', roughness: 0.8 }),
    white: new THREE.MeshStandardMaterial({ color: '#f5f7f9', ...paint }),
    deck: new THREE.MeshStandardMaterial({ color: '#b9a583', roughness: 0.85 }),
    glass: new THREE.MeshStandardMaterial({ color: '#7fc3e6', roughness: 0.08, metalness: 0.85 }),
    darkGlass: new THREE.MeshStandardMaterial({ color: '#1c2f42', roughness: 0.1, metalness: 0.8 }),
    funnel: new THREE.MeshStandardMaterial({ color: '#eef1f4', ...paint }),
    funnelTop: new THREE.MeshStandardMaterial({ color: '#1b2026', roughness: 0.7 }),
    pool: new THREE.MeshStandardMaterial({ color: '#27c3e0', roughness: 0.1, metalness: 0.2 }),
    lifeboat: new THREE.MeshStandardMaterial({ color: '#f28a1e', roughness: 0.5 }),
    turf: new THREE.MeshStandardMaterial({ color: '#4d9a4a', roughness: 0.9 }),
    mast: new THREE.MeshStandardMaterial({ color: '#dfe4e8', roughness: 0.4, metalness: 0.4 }),
    slides: ['#ff5a36', '#ffc928', '#35c26b', '#e84ba0', '#3fa7ff'].map(
      (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.35 }),
    ),
  };
  return cached;
}

class ShipBuilder {
  readonly group = new THREE.Group();
  readonly m = materials();
  readonly L: number;
  readonly B: number;
  /** Height of the hull above the waterline. */
  readonly hullTop: number;
  /** Height of the current topmost deck. */
  top: number;

  constructor(readonly cls: ShipClass) {
    this.L = cls.length;
    this.B = cls.beam;
    this.hullTop = Math.round(cls.height * 0.27);
    this.top = this.hullTop;
  }

  add(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[]): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material): THREE.Mesh {
    const mesh = this.add(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y + h / 2, z);
    return mesh;
  }

  /** z along the ship as a fraction of length: -0.5 at the stern, 0.5 at the bow. */
  z(fraction: number): number {
    return fraction * this.L;
  }

  hull(sideMaterial: THREE.Material, bowLength: number): void {
    const rake = this.L * 0.03;
    const opts: OutlineOptions = { bow: bowLength, stern: 0.07, tip: 0, transom: 0.72 };
    const points = outline(-this.L / 2, this.L / 2 - rake, this.B / 2, opts);
    const bowStart = this.L / 2 - rake - this.L * bowLength;
    const shapeHull = (geometry: THREE.BufferGeometry): void => {
      const pos = geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const y = Math.max(0, pos.getY(i)) / this.hullTop;
        const z = pos.getZ(i);
        const bowness = THREE.MathUtils.smoothstep(z, bowStart, this.L / 2 - rake);
        // The bow rakes forward and flares out as it rises.
        pos.setZ(i, z + rake * y * bowness);
        pos.setX(i, pos.getX(i) * (1 - 0.3 * bowness * (1 - y)));
        // The stern tucks in towards the waterline.
        const sternness = 1 - THREE.MathUtils.smoothstep(z, -this.L / 2, -this.L / 2 + this.L * 0.08);
        pos.setZ(i, pos.getZ(i) + this.L * 0.012 * sternness * (1 - y));
      }
      geometry.computeVertexNormals();
    };

    const upper = slabGeometry(points, 1.4, this.hullTop);
    shapeHull(upper);
    this.add(upper, [this.m.deck, sideMaterial]);
    const lower = slabGeometry(points, -5, 1.4);
    shapeHull(lower);
    this.add(lower, this.m.bootTop);

    // Open foredeck with a helipad.
    const pad = this.add(new THREE.CylinderGeometry(this.B * 0.2, this.B * 0.2, 0.4, 24), this.m.turf);
    pad.position.set(0, this.hullTop + 0.2, this.z(0.5 - bowLength * 0.55));
    pad.castShadow = false;
  }

  /** Recessed promenade with lifeboats, the band between the hull and the cabins. */
  promenade(zStern: number, zBow: number): void {
    const inset = 3.6;
    const height = 2 * DECK_HEIGHT;
    const points = outline(this.z(zStern), this.z(zBow), this.B / 2 - inset, {
      bow: 0.12,
      stern: 0.05,
      tip: 0.5,
      transom: 0.8,
    });
    this.add(slabGeometry(points, this.top, this.top + height), [this.m.deck, this.m.recess]);

    const boatLength = 13;
    const from = this.z(zStern + 0.1);
    const to = this.z(zBow - 0.2);
    const count = Math.floor((to - from) / (boatLength + 4));
    const geometry = new THREE.CapsuleGeometry(1.9, boatLength - 3.8, 3, 8);
    geometry.rotateX(Math.PI / 2);
    const boats = new THREE.InstancedMesh(geometry, this.m.lifeboat, count * 2);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const z = from + (i + 0.5) * ((to - from) / count);
      for (const side of [0, 1]) {
        matrix.makeTranslation((side ? 1 : -1) * (this.B / 2 - 1.9), this.top + 3.2, z);
        boats.setMatrixAt(i * 2 + side, matrix);
      }
    }
    boats.castShadow = true;
    this.group.add(boats);
    this.top += height;
  }

  /** A block of decks. Width is a fraction of the beam; x offsets it from the centreline. */
  decks(
    count: number,
    zStern: number,
    zBow: number,
    width: number,
    opts: Partial<OutlineOptions> & { x?: number; side?: THREE.Material; from?: number } = {},
  ): void {
    const y0 = opts.from ?? this.top;
    const y1 = y0 + count * DECK_HEIGHT;
    const points = outline(this.z(zStern), this.z(zBow), (this.B / 2) * width, {
      bow: opts.bow ?? 0.18,
      stern: opts.stern ?? 0.04,
      tip: opts.tip ?? 0.42,
      transom: opts.transom ?? 0.85,
    });
    const mesh = this.add(slabGeometry(points, y0, y1), [this.m.deck, opts.side ?? this.m.balconies]);
    mesh.position.x = opts.x ?? 0;
    if (opts.from === undefined) this.top = y1;
  }

  /** Dark band of bridge windows with wings reaching past the sides. */
  bridge(zFraction: number, width: number): void {
    const y = this.top - DECK_HEIGHT;
    this.group.userData.bridge = { y: this.top, z: this.z(zFraction) };
    this.box(this.B * width + 7, DECK_HEIGHT, 7, 0, y, this.z(zFraction), this.m.darkGlass);
    this.box(this.B * width + 8, 0.5, 8, 0, y + DECK_HEIGHT, this.z(zFraction), this.m.white);
  }

  funnel(zFraction: number, x: number, width: number, depth: number, height: number): void {
    const body = this.add(new THREE.CylinderGeometry(0.42, 0.5, 1, 20), this.m.funnel);
    body.scale.set(width, height, depth);
    body.position.set(x, this.top + height / 2, this.z(zFraction));
    body.rotation.x = -0.1;
    const cap = this.add(new THREE.CylinderGeometry(0.43, 0.42, 1, 20), this.m.funnelTop);
    cap.scale.set(width, height * 0.14, depth);
    cap.position.set(x, this.top + height * 1.05, this.z(zFraction) - height * 0.1);
    cap.rotation.x = -0.1;
  }

  mast(zFraction: number, height: number): void {
    const z = this.z(zFraction);
    const pole = this.add(new THREE.CylinderGeometry(0.5, 1.3, height, 8), this.m.mast);
    pole.position.set(0, this.top + height / 2, z);
    this.box(12, 0.6, 1.2, 0, this.top + height * 0.62, z, this.m.mast);
    this.box(7, 0.6, 1.2, 0, this.top + height * 0.82, z, this.m.mast);
    const radome = this.add(new THREE.SphereGeometry(1.8, 12, 8), this.m.white);
    radome.position.set(0, this.top + height + 1, z);
  }

  pool(zFraction: number, x: number, w: number, d: number): void {
    const mesh = this.box(w, 0.5, d, x, this.top, this.z(zFraction), this.m.pool);
    mesh.castShadow = false;
  }

  dome(zFraction: number, y: number, radius: number, squash: number, material: THREE.Material): void {
    const mesh = this.add(
      new THREE.SphereGeometry(radius, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2),
      material,
    );
    mesh.scale.y = squash;
    mesh.position.set(0, y, this.z(zFraction));
  }

  /** Lounge wrapped round the funnel, a Royal Caribbean signature. */
  crownLounge(zFraction: number, radius: number): void {
    const glass = this.add(new THREE.CylinderGeometry(radius, radius * 0.9, 3.4, 28), this.m.darkGlass);
    glass.position.set(0, this.top + 7, this.z(zFraction));
    const roof = this.add(new THREE.CylinderGeometry(radius * 1.04, radius * 1.04, 0.7, 28), this.m.white);
    roof.position.set(0, this.top + 9, this.z(zFraction));
    const stem = this.add(new THREE.CylinderGeometry(radius * 0.55, radius * 0.6, 5.4, 20), this.m.white);
    stem.position.set(0, this.top + 2.7, this.z(zFraction));
  }

  waterSlides(zFraction: number, scale: number): void {
    const z = this.z(zFraction);
    this.m.slides.forEach((material, i) => {
      const radius = scale * (0.55 + 0.12 * i);
      const slide = this.add(new THREE.TorusGeometry(radius, 1.1, 8, 28, Math.PI * 1.5), material);
      slide.position.set((i - 2) * scale * 0.42, this.top + 3 + i * 1.6, z + (i % 2 ? 6 : -6));
      slide.rotation.set(Math.PI / 2 + (i % 2 ? 0.28 : -0.28), 0, i * 1.3);
    });
    const tower = this.add(new THREE.CylinderGeometry(2, 2.6, 14, 10), this.m.white);
    tower.position.set(0, this.top + 7, z);
  }
}

function buildIcon(b: ShipBuilder): void {
  b.hull(b.m.hullBlue, 0.2);
  b.promenade(-0.47, 0.34);
  b.decks(7, -0.47, 0.36, 0.98);
  b.decks(3, -0.3, 0.37, 0.98, { tip: 0.6 });
  b.bridge(0.335, 1);
  const base = b.top;
  // Two cabin towers with an open neighbourhood between them.
  b.decks(3, -0.42, 0.2, 0.32, { x: b.B * 0.33, from: base, tip: 0.8 });
  b.decks(3, -0.42, 0.2, 0.32, { x: -b.B * 0.33, from: base, tip: 0.8 });
  b.box(b.B * 0.3, 0.4, b.L * 0.5, 0, base, b.z(-0.14), b.m.turf).castShadow = false;
  b.dome(0.27, base, b.B * 0.44, 0.62, b.m.glass);
  b.top = base + 3 * DECK_HEIGHT;
  b.funnel(-0.05, b.B * 0.33, 11, 20, 13);
  b.funnel(-0.05, -b.B * 0.33, 11, 20, 13);
  b.waterSlides(-0.2, 15);
  b.pool(0.08, b.B * 0.33, 9, 26);
  b.pool(0.08, -b.B * 0.33, 9, 26);
  b.mast(0.18, 14);
}

function buildOasis(b: ShipBuilder): void {
  b.hull(b.m.hullWhite, 0.2);
  b.promenade(-0.46, 0.34);
  b.decks(6, -0.46, 0.36, 0.98);
  b.decks(2, 0.16, 0.37, 0.98, { tip: 0.6 });
  b.bridge(0.335, 1);
  const base = b.top - 2 * DECK_HEIGHT;
  // The split superstructure: two long towers either side of an open park.
  b.decks(6, -0.48, 0.2, 0.34, { x: b.B * 0.32, from: base, tip: 0.85, transom: 0.9 });
  b.decks(6, -0.48, 0.2, 0.34, { x: -b.B * 0.32, from: base, tip: 0.85, transom: 0.9 });
  b.box(b.B * 0.28, 0.4, b.L * 0.6, 0, base, b.z(-0.16), b.m.turf).castShadow = false;
  b.top = base + 6 * DECK_HEIGHT;
  b.dome(0.22, b.top - 4, b.B * 0.3, 0.5, b.m.glass);
  b.funnel(-0.12, b.B * 0.32, 9, 17, 11);
  b.funnel(-0.12, -b.B * 0.32, 9, 17, 11);
  b.pool(0.02, b.B * 0.32, 9, 30);
  b.pool(0.02, -b.B * 0.32, 9, 30);
  b.pool(-0.3, b.B * 0.32, 8, 18);
  b.mast(0.15, 13);
}

function buildQuantum(b: ShipBuilder): void {
  b.hull(b.m.hullWhite, 0.21);
  b.promenade(-0.47, 0.33);
  b.decks(7, -0.47, 0.35, 0.98);
  b.decks(2, -0.44, 0.36, 0.96, { tip: 0.6 });
  b.bridge(0.325, 1);
  b.decks(1, -0.4, 0.28, 0.9, { side: b.m.glassDecks, tip: 0.7 });
  // Glass-walled lounge across the stern.
  b.box(b.B * 0.8, 9, 5, 0, b.hullTop + 8, b.z(-0.468), b.m.glass);
  // Indoor sports hall aft.
  b.decks(3, -0.42, -0.24, 0.8, { side: b.m.white, tip: 0.9, transom: 0.95, from: b.top });
  b.funnel(-0.1, 0, 15, 24, 13);
  b.pool(0.12, 0, 16, 34);
  b.dome(0.24, b.top, b.B * 0.3, 0.35, b.m.glass);
  // Observation capsule on a long arm.
  const arm = b.add(new THREE.CylinderGeometry(0.9, 1.2, 34, 8), b.m.white);
  arm.position.set(4, b.top + 14, b.z(0.03));
  arm.rotation.z = -0.5;
  const capsule = b.add(new THREE.SphereGeometry(3.4, 16, 12), b.m.glass);
  capsule.position.set(12.5, b.top + 29, b.z(0.03));
  b.mast(0.2, 13);
}

function buildFreedom(b: ShipBuilder): void {
  b.hull(b.m.hullWhite, 0.21);
  b.promenade(-0.46, 0.32);
  b.decks(6, -0.46, 0.34, 0.98);
  b.decks(2, -0.38, 0.35, 0.96, { tip: 0.6 });
  b.bridge(0.315, 1);
  b.decks(1, -0.3, 0.25, 0.88, { side: b.m.glassDecks, tip: 0.7 });
  b.pool(0.08, 0, 14, 30);
  b.pool(-0.04, 0, 12, 14);
  b.crownLounge(-0.16, b.B * 0.36);
  b.funnel(-0.2, 0, 13, 21, 15);
  // Surf simulator on the aft sports deck.
  const surf = b.box(12, 3, 14, 0, b.top, b.z(-0.28), b.m.pool);
  surf.rotation.x = 0.2;
  b.mast(0.19, 12);
}

function buildRadiance(b: ShipBuilder): void {
  b.hull(b.m.hullWhite, 0.25);
  b.promenade(-0.45, 0.3);
  // More glass than cabins: the class is known for its window walls.
  b.decks(2, -0.45, 0.32, 0.98, { side: b.m.glassDecks });
  b.decks(3, -0.42, 0.33, 0.98);
  b.decks(2, -0.34, 0.34, 0.96, { tip: 0.6 });
  b.bridge(0.305, 1);
  b.decks(1, -0.26, 0.24, 0.86, { side: b.m.glassDecks, tip: 0.7 });
  b.pool(0.06, 0, 11, 22);
  b.dome(-0.02, b.top, b.B * 0.34, 0.4, b.m.glass);
  b.crownLounge(-0.15, b.B * 0.38);
  b.funnel(-0.19, 0, 11, 18, 13);
  // Satellite dome forward, the "golf ball".
  const radome = b.add(new THREE.SphereGeometry(4.2, 18, 12), b.m.white);
  radome.position.set(0, b.top + 5.5, b.z(0.15));
  b.box(3, 2, 3, 0, b.top, b.z(0.15), b.m.white);
  b.mast(0.21, 11);
}

const BUILDERS: Record<ShipClass['id'], (b: ShipBuilder) => void> = {
  icon: buildIcon,
  oasis: buildOasis,
  quantum: buildQuantum,
  freedom: buildFreedom,
  radiance: buildRadiance,
};

/** Build the model for a ship class. Add it to a parent that carries position and heading. */
export function createShipModel(cls: ShipClass): THREE.Group {
  const builder = new ShipBuilder(cls);
  BUILDERS[cls.id](builder);
  if (!builder.group.userData.bridge) throw new Error(`${cls.name} model has no bridge`);
  return builder.group;
}

/** Where the bridge is in ship space, for the bridge camera. */
export interface BridgePosition {
  /** Height of the bridge roof above the waterline. */
  y: number;
  /** Distance ahead of midships. */
  z: number;
}

export function bridgeOf(model: THREE.Group): BridgePosition {
  return model.userData.bridge as BridgePosition;
}
