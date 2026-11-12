import * as THREE from 'three';
import { CANNON_RANGE, WHALE_SLAP_AT, type Hazard } from '../sim/hazards';

const SHARKS_IN_SHOAL = 6;
const SHARK_LENGTH = 72;
const TENTACLES = 8;
const TENTACLE_SEGMENTS = 9;
const TENTACLE_SEGMENT_LENGTH = 15;
const WAVE_HEIGHT = 40;
/** Long enough to put the flukes where the simulation has the tail come down. */
const WHALE_LENGTH = 150;

/** A flat disc of churned water marking where a hazard is. */
function waterDisc(radius: number, color: string, opacity: number): THREE.Mesh {
  const disc = new THREE.Mesh(
    new THREE.RingGeometry(radius - 9, radius, 96),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    }),
  );
  disc.rotation.x = -Math.PI / 2;
  // Clear of the tops of the waves.
  disc.position.y = 2.5;
  return disc;
}

/** One giant shark, nose along +Z, swimming with its back out of the water. */
function createShark(skin: THREE.Material): THREE.Group {
  const shark = new THREE.Group();
  const L = SHARK_LENGTH;
  const profile = [
    [0, -0.5],
    [0.04, -0.46],
    [0.085, -0.3],
    [0.1, -0.1],
    [0.09, 0.15],
    [0.05, 0.36],
    [0.02, 0.46],
    [0, 0.5],
  ].map(([r, y]) => new THREE.Vector2(r * L, -y * L));
  const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 14), skin);
  body.rotation.x = Math.PI / 2;
  body.scale.set(1, 1, 0.85);
  shark.add(body);

  const fin = (points: [number, number][], thickness: number): THREE.Mesh => {
    const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
    geometry.translate(0, 0, -thickness / 2);
    const mesh = new THREE.Mesh(geometry, skin);
    // The shape is drawn in (z, y); stand it up along the shark's length.
    mesh.rotation.y = -Math.PI / 2;
    return mesh;
  };
  const dorsal = fin(
    [
      [0.1 * L, 0.07 * L],
      [-0.06 * L, 0.34 * L],
      [-0.1 * L, 0.33 * L],
      [-0.07 * L, 0.07 * L],
    ],
    1.1,
  );
  const tail = fin(
    [
      [-0.4 * L, 0],
      [-0.56 * L, 0.26 * L],
      [-0.6 * L, 0.25 * L],
      [-0.5 * L, -0.02 * L],
      [-0.56 * L, -0.12 * L],
      [-0.52 * L, -0.12 * L],
    ],
    0.9,
  );
  shark.add(dorsal, tail);
  shark.traverse((object) => {
    object.castShadow = true;
  });
  return shark;
}

/** Crossed bones and a skull for the pirate's sail and flag. */
function skullTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#15151a';
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = '#e9e4d6';
  ctx.fillStyle = '#e9e4d6';
  ctx.lineWidth = 16;
  ctx.lineCap = 'round';
  for (const [x0, y0, x1, y1] of [
    [58, 150, 198, 226],
    [198, 150, 58, 226],
  ]) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(128, 100, 56, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(100, 136, 56, 36);
  ctx.fillStyle = '#15151a';
  for (const x of [104, 152]) {
    ctx.beginPath();
    ctx.arc(x, 100, 15, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.moveTo(128, 116);
  ctx.lineTo(119, 134);
  ctx.lineTo(137, 134);
  ctx.fill();
  for (const x of [112, 128, 144]) ctx.fillRect(x - 2, 150, 4, 22);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A galleon, bow along +Z, scaled up so it stands out among cruise ships. */
function createPirateShip(): THREE.Group {
  const ship = new THREE.Group();
  const L = 120;
  const B = 15;
  const wood = new THREE.MeshStandardMaterial({ color: '#4b3020', roughness: 0.9, side: THREE.DoubleSide });
  const trim = new THREE.MeshStandardMaterial({ color: '#b58a2e', roughness: 0.6 });
  const deckMaterial = new THREE.MeshStandardMaterial({ color: '#86623c', roughness: 0.95 });
  const spar = new THREE.MeshStandardMaterial({ color: '#2e2018', roughness: 0.9 });
  const sailMaterial = new THREE.MeshStandardMaterial({ color: '#1d1d24', roughness: 1, side: THREE.DoubleSide });
  const skull = skullTexture();
  const skullSail = new THREE.MeshStandardMaterial({ map: skull, roughness: 1, side: THREE.DoubleSide });

  // Hull: stations from stern to bow, each a keel, bilge and rail point per side.
  const stations = 20;
  const positions: number[] = [];
  const indices: number[] = [];
  const deckPositions: number[] = [];
  const deckIndices: number[] = [];
  const deckY = (t: number): number => {
    // High castle aft, a low waist and a raised forecastle.
    if (t < 0.28) return 21;
    if (t < 0.34) return 21 - ((t - 0.28) / 0.06) * 9;
    if (t > 0.78) return 16;
    if (t > 0.74) return 12 + ((t - 0.74) / 0.04) * 4;
    return 12;
  };
  for (let i = 0; i <= stations; i++) {
    const t = i / stations;
    const z = (t - 0.5) * L;
    const fullness = t < 0.15 ? 0.75 + (t / 0.15) * 0.25 : Math.pow(Math.max(0, 1 - Math.pow((t - 0.15) / 0.85, 2.6)), 0.7);
    const b = Math.max(0.4, B * fullness);
    const top = deckY(t) + 3;
    const ring = [
      [-b, top],
      [-b * 1.04, top * 0.55],
      [-b * 0.7, 0],
      [0, -5],
      [b * 0.7, 0],
      [b * 1.04, top * 0.55],
      [b, top],
    ];
    for (const [x, y] of ring) positions.push(x, y, z);
    deckPositions.push(-b, deckY(t), z, b, deckY(t), z);
    if (i === 0) continue;
    const a = (i - 1) * ring.length;
    const c = i * ring.length;
    for (let k = 0; k < ring.length - 1; k++) {
      indices.push(a + k, c + k, a + k + 1, a + k + 1, c + k, c + k + 1);
    }
    const d = (i - 1) * 2;
    deckIndices.push(d, d + 1, d + 2, d + 1, d + 3, d + 2);
  }
  // Close the flat stern.
  for (let k = 1; k < 6; k++) indices.push(0, k, k + 1);
  const hullGeometry = new THREE.BufferGeometry();
  hullGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  hullGeometry.setIndex(indices);
  hullGeometry.computeVertexNormals();
  ship.add(new THREE.Mesh(hullGeometry, wood));
  const deckGeometry = new THREE.BufferGeometry();
  deckGeometry.setAttribute('position', new THREE.Float32BufferAttribute(deckPositions, 3));
  deckGeometry.setIndex(deckIndices);
  deckGeometry.computeVertexNormals();
  ship.add(new THREE.Mesh(deckGeometry, deckMaterial));

  // Gilded stern gallery and a gun stripe down each side.
  const gallery = new THREE.Mesh(new THREE.BoxGeometry(B * 1.7, 7, 1.2), trim);
  gallery.position.set(0, 17, -L / 2 - 0.4);
  ship.add(gallery);
  for (const side of [-1, 1]) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.6, L * 0.62), trim);
    stripe.position.set(side * (B * 1.03 + 0.3), 8.5, -L * 0.03);
    ship.add(stripe);
  }

  const bowsprit = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, 36, 8), spar);
  bowsprit.rotation.x = Math.PI / 2 - 0.35;
  bowsprit.position.set(0, 23, L / 2 + 6);
  ship.add(bowsprit);

  const sail = (width: number, height: number, material: THREE.Material): THREE.Mesh => {
    const geometry = new THREE.PlaneGeometry(width, height, 8, 4);
    const p = geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const across = Math.cos((p.getX(i) / width) * Math.PI);
      const down = Math.cos((p.getY(i) / height) * Math.PI);
      p.setZ(i, across * down * width * 0.16);
    }
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, material);
  };
  const masts: [number, number, number][] = [
    [L * 0.27, 78, 0.85],
    [-L * 0.02, 96, 1],
    [-L * 0.3, 70, 0.75],
  ];
  masts.forEach(([z, height, size], m) => {
    const base = deckY(z / L + 0.5);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.2, height, 8), spar);
    mast.position.set(0, base + height / 2, z);
    ship.add(mast);
    let y = base + 12;
    [1, 0.82, 0.62].forEach((share, k) => {
      const width = 48 * size * share;
      const tall = 24 * size * (k === 0 ? 1 : 0.85);
      const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, width + 4, 6), spar);
      yard.rotation.z = Math.PI / 2;
      yard.position.set(0, y + tall, z);
      ship.add(yard);
      const cloth = sail(width, tall, m === 1 && k === 0 ? skullSail : sailMaterial);
      cloth.position.set(0, y + tall / 2, z + 0.5);
      ship.add(cloth);
      y += tall + 2.5;
    });
    if (m === 1) {
      const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(16, 11),
        new THREE.MeshStandardMaterial({ map: skull, roughness: 1, side: THREE.DoubleSide }),
      );
      flag.position.set(0, base + height - 4, z - 8.5);
      flag.rotation.y = Math.PI / 2;
      ship.add(flag);
    }
  });

  ship.traverse((object) => {
    object.castShadow = true;
  });
  return ship;
}

interface Tentacle {
  joints: THREE.Object3D[];
  phase: number;
  curl: number;
}

function createKraken(radius: number): { group: THREE.Group; tentacles: Tentacle[]; head: THREE.Object3D } {
  const group = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: '#8a2c3a', roughness: 0.45, metalness: 0.05 });
  const pale = new THREE.MeshStandardMaterial({ color: '#d9a0a0', roughness: 0.6 });

  const head = new THREE.Group();
  const mantle = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), skin);
  mantle.scale.set(radius * 0.3, radius * 0.42, radius * 0.34);
  mantle.position.y = radius * 0.1;
  head.add(mantle);
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 0.06, 16, 12),
      new THREE.MeshStandardMaterial({ color: '#ffd23f', emissive: '#ffb300', emissiveIntensity: 0.7, roughness: 0.3 }),
    );
    eye.position.set(side * radius * 0.17, radius * 0.16, radius * 0.27);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.03, 12, 8), new THREE.MeshBasicMaterial({ color: '#000' }));
    pupil.scale.set(0.5, 1.5, 0.5);
    pupil.position.set(side * radius * 0.01, 0, radius * 0.048);
    eye.add(pupil);
    head.add(eye);
  }
  group.add(head);

  const tentacles: Tentacle[] = [];
  for (let i = 0; i < TENTACLES; i++) {
    const angle = (i / TENTACLES) * Math.PI * 2 + 0.3;
    const root = new THREE.Group();
    root.position.set(Math.sin(angle) * radius * 0.62, -6, Math.cos(angle) * radius * 0.62);
    // Face outwards, so curling forwards arches the arm over the water around it.
    root.rotation.y = angle;
    group.add(root);
    const joints: THREE.Object3D[] = [];
    let parent: THREE.Object3D = root;
    for (let k = 0; k < TENTACLE_SEGMENTS; k++) {
      const r0 = 8.5 * (1 - k / TENTACLE_SEGMENTS) + 1.4;
      const r1 = 8.5 * (1 - (k + 1) / TENTACLE_SEGMENTS) + 1.4;
      const joint = new THREE.Group();
      joint.position.y = k === 0 ? 0 : TENTACLE_SEGMENT_LENGTH;
      const segment = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, TENTACLE_SEGMENT_LENGTH * 1.08, 10), skin);
      segment.position.y = TENTACLE_SEGMENT_LENGTH / 2;
      segment.castShadow = true;
      const knuckle = new THREE.Mesh(new THREE.SphereGeometry(r0, 10, 8), skin);
      knuckle.castShadow = true;
      const sucker = new THREE.Mesh(new THREE.SphereGeometry(r1 * 0.5, 8, 6), pale);
      sucker.position.set(0, TENTACLE_SEGMENT_LENGTH / 2, -r1 * 0.75);
      joint.add(segment, knuckle, sucker);
      parent.add(joint);
      parent = joint;
      joints.push(joint);
    }
    tentacles.push({ joints, phase: i * 1.7, curl: i % 2 ? 1 : -1 });
  }
  group.add(waterDisc(radius, '#ff5a4f', 0.55));
  return { group, tentacles, head };
}

/** A breaking wave: its crest runs along X and it travels along +Z. */
function createWave(halfLength: number): THREE.Mesh {
  // Cross-section from the back of the wave to the foot of its face: [z, height].
  const profile: [number, number][] = [
    [-120, 0],
    [-85, 0.16],
    [-55, 0.48],
    [-30, 0.8],
    [-10, 0.97],
    [2, 1],
    [11, 0.93],
    [16, 0.76],
    [14, 0.55],
    [13, 0.34],
    [16, 0.16],
    [26, 0.04],
    [40, 0],
  ];
  const columns = 48;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const deep = new THREE.Color('#0a5a78');
  const light = new THREE.Color('#3fc3c9');
  const foam = new THREE.Color('#ffffff');
  const color = new THREE.Color();
  for (let i = 0; i <= columns; i++) {
    const u = (i / columns) * 2 - 1;
    // Full height along most of the crest, falling away at the ends.
    const taper = Math.pow(Math.cos((Math.pow(Math.abs(u), 2.2) * Math.PI) / 2), 0.7);
    const ripple = 1 + 0.07 * Math.sin(u * 23) + 0.05 * Math.sin(u * 61 + 1);
    profile.forEach(([z, h], k) => {
      const y = h * WAVE_HEIGHT * taper * ripple;
      positions.push(u * halfLength, y - 0.3, z * (0.6 + 0.4 * taper) + Math.sin(u * 9) * 6);
      color.copy(deep).lerp(light, Math.min(1, h * 1.1));
      const crest = THREE.MathUtils.smoothstep(h, 0.72, 0.98);
      const foot = k >= 9 ? 0.75 : 0;
      color.lerp(foam, Math.max(crest, foot) * (0.8 + 0.2 * Math.sin(u * 140 + k)));
      colors.push(color.r, color.g, color.b);
    });
    if (i === 0) continue;
    const a = (i - 1) * profile.length;
    const b = i * profile.length;
    for (let k = 0; k < profile.length - 1; k++) {
      indices.push(a + k, a + k + 1, b + k, a + k + 1, b + k + 1, b + k);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const wave = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.18,
      metalness: 0.05,
      side: THREE.DoubleSide,
    }),
  );
  wave.castShadow = true;
  return wave;
}

/**
 * A humpback, nose along +Z, scaled up like everything else out here. pose()
 * takes it through its routine: it blows, lifts its tail and brings it down.
 */
function createWhale(): { group: THREE.Group; pose(cycle: number): void } {
  const group = new THREE.Group();
  const L = WHALE_LENGTH;
  const skin = new THREE.MeshStandardMaterial({ color: '#2b3a4a', roughness: 0.35, metalness: 0.05 });
  const pale = new THREE.MeshStandardMaterial({ color: '#c9d3da', roughness: 0.6 });

  // The body runs from the nose to where the tail stock begins.
  const profile = [
    [0, -0.5],
    [0.06, -0.47],
    [0.105, -0.36],
    [0.125, -0.2],
    [0.125, 0],
    [0.105, 0.14],
    [0.07, 0.24],
  ].map(([r, y]) => new THREE.Vector2(r * L, -y * L));
  const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 20), skin);
  body.rotation.x = Math.PI / 2;
  body.scale.set(1.1, 1, 0.9);
  body.position.y = -5;
  group.add(body);
  const hump = new THREE.Mesh(new THREE.SphereGeometry(4, 12, 8), skin);
  hump.scale.set(0.5, 1, 2.2);
  hump.position.set(0, 7.5, -0.12 * L);
  group.add(hump);
  for (const side of [-1, 1]) {
    const flipper = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), pale);
    flipper.scale.set(20, 1.6, 6);
    flipper.position.set(side * 24, -3, 0.16 * L);
    flipper.rotation.set(0, side * 0.5, side * -0.25);
    group.add(flipper);
  }

  // The tail hinges where the body ends.
  const tail = new THREE.Group();
  tail.position.set(0, -5, -0.24 * L);
  const stock = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 0.07 * L * 1.05, 0.3 * L, 14), skin);
  stock.rotation.x = -Math.PI / 2;
  stock.position.z = -0.15 * L;
  stock.scale.set(1.1, 1, 0.9);
  const fluke = new THREE.Shape();
  fluke.moveTo(0, 6);
  fluke.bezierCurveTo(10, 4, 24, -4, 30, -14);
  fluke.bezierCurveTo(20, -10, 8, -9, 0, -5);
  fluke.bezierCurveTo(-8, -9, -20, -10, -30, -14);
  fluke.bezierCurveTo(-24, -4, -10, 4, 0, 6);
  const flukeGeometry = new THREE.ExtrudeGeometry(fluke, { depth: 2.2, bevelEnabled: false });
  // Drawn in (x, y) with the tips towards -y: lay it flat with the tips trailing.
  flukeGeometry.rotateX(Math.PI / 2);
  const flukes = new THREE.Mesh(flukeGeometry, skin);
  flukes.position.set(0, 1.1, -0.3 * L);
  tail.add(stock, flukes);
  group.add(tail);

  // The blow: a column of spray with a cloud of mist on top.
  const blowMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const mistMaterial = blowMaterial.clone();
  const columnGeometry = new THREE.ConeGeometry(1, 1, 14, 1, true);
  columnGeometry.rotateX(Math.PI);
  columnGeometry.translate(0, 0.5, 0);
  const column = new THREE.Mesh(columnGeometry, blowMaterial);
  const mist = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), mistMaterial);
  const blowhole = new THREE.Group();
  blowhole.position.set(0, 8, 0.2 * L);
  blowhole.rotation.x = -0.2;
  blowhole.add(column, mist);
  group.add(blowhole);

  group.traverse((object) => {
    if (object !== column && object !== mist) object.castShadow = true;
  });

  const smooth = (t: number): number => t * t * (3 - 2 * t);
  return {
    group,
    pose(cycle) {
      // Blow early in the routine.
      const blow = Math.max(0, Math.min(1, (cycle - 0.05) / 0.3));
      const blowing = cycle > 0.05 && cycle < 0.35;
      column.visible = blowing;
      mist.visible = blowing;
      const height = 120 * Math.sin(Math.min(1, blow * 2.2) * Math.PI * 0.5);
      column.scale.set(7 + blow * 16, Math.max(0.01, height), 7 + blow * 16);
      blowMaterial.opacity = 0.75 * (1 - blow * blow);
      mist.position.y = height;
      mist.scale.setScalar(12 + blow * 34);
      mistMaterial.opacity = 0.6 * (1 - blow);

      // Then the tail comes up out of the water, hangs, and comes down hard.
      const rise = WHALE_SLAP_AT - 0.32;
      const hang = WHALE_SLAP_AT - 0.06;
      let lift = 0;
      if (cycle >= rise && cycle < hang) lift = smooth((cycle - rise) / (hang - rise));
      else if (cycle >= hang && cycle < WHALE_SLAP_AT) lift = 1 - ((cycle - hang) / (WHALE_SLAP_AT - hang)) ** 2;
      tail.rotation.x = -0.28 + lift * 1.3;
      // The body pitches forward as the tail lifts.
      body.rotation.x = Math.PI / 2 + lift * 0.1;
    },
  };
}

interface View {
  root: THREE.Object3D;
  update(hazard: Hazard, now: number): void;
}

/** Draws the hazards of a race. */
export class HazardViews {
  readonly group = new THREE.Group();
  private readonly views: View[] = [];

  constructor(hazards: Hazard[]) {
    const sharkSkin = new THREE.MeshStandardMaterial({ color: '#56636f', roughness: 0.5 });
    for (const hazard of hazards) {
      const view = this.build(hazard, sharkSkin);
      this.views.push(view);
      this.group.add(view.root);
      view.update(hazard, 0);
    }
  }

  private build(hazard: Hazard, sharkSkin: THREE.Material): View {
    const root = new THREE.Group();
    const place = (h: Hazard): void => {
      root.position.set(h.x, 0, h.z);
      root.rotation.y = h.heading;
    };

    if (hazard.kind === 'sharks') {
      const sharks = Array.from({ length: SHARKS_IN_SHOAL }, (_, i) => {
        const shark = createShark(sharkSkin);
        root.add(shark);
        return { shark, orbit: hazard.r * (0.3 + 0.55 * ((i * 0.37) % 1)), offset: (i / SHARKS_IN_SHOAL) * Math.PI * 2, dir: i % 2 ? 1 : -1 };
      });
      root.add(waterDisc(hazard.r, '#ff5a4f', 0.55));
      return {
        root,
        update(h, now) {
          root.position.set(h.x, 0, h.z);
          for (const s of sharks) {
            const angle = s.offset + (now * 12 * s.dir) / s.orbit;
            s.shark.position.set(Math.sin(angle) * s.orbit, -1.5 + Math.sin(now * 0.9 + s.offset) * 0.8, Math.cos(angle) * s.orbit);
            s.shark.rotation.y = angle + (s.dir * Math.PI) / 2 + Math.sin(now * 2.2 + s.offset) * 0.12;
          }
        },
      };
    }

    if (hazard.kind === 'kraken') {
      const kraken = createKraken(hazard.r);
      root.add(kraken.group);
      return {
        root,
        update(h, now) {
          place(h);
          kraken.head.position.y = Math.sin(now * 0.6) * 4;
          for (const tentacle of kraken.tentacles) {
            tentacle.joints.forEach((joint, k) => {
              const sway = Math.sin(now * 0.9 + tentacle.phase + k * 0.55);
              // Upright at the root, curling over more and more towards the tip.
              joint.rotation.x = k === 0 ? -0.25 + sway * 0.1 : 0.05 + k * 0.035 + sway * 0.13;
              joint.rotation.z = k === 0 ? 0 : tentacle.curl * (0.06 + Math.cos(now * 0.7 + tentacle.phase + k * 0.4) * 0.09);
            });
          }
        },
      };
    }

    if (hazard.kind === 'wave') {
      const wave = createWave(hazard.r);
      root.add(wave);
      return {
        root,
        update(h, now) {
          place(h);
          root.visible = h.strength > 0.01;
          wave.scale.set(1, h.strength * (1 + Math.sin(now * 1.3) * 0.04), 1);
        },
      };
    }

    if (hazard.kind === 'whale') {
      const whale = createWhale();
      root.add(whale.group);
      const ring = waterDisc(hazard.r, '#ff5a4f', 0.55);
      root.add(ring);
      return {
        root,
        update(h, now) {
          place(h);
          // Under the surface while it turns round at the edge of the channel.
          root.visible = h.strength > 0.02;
          whale.group.position.y = -(1 - h.strength) * 34 + Math.sin(now * 0.8) * 1.2;
          ring.visible = h.strength > 0.5;
          whale.pose(h.cycle);
        },
      };
    }

    const ship = createPirateShip();
    root.add(ship);
    // The ring shows how far its guns reach. It stays level while the ship rolls.
    const range = waterDisc(CANNON_RANGE, '#ff5a4f', 0.55);
    const ringHolder = new THREE.Group();
    ringHolder.add(range);
    this.group.add(ringHolder);
    return {
      root,
      update(h, now) {
        place(h);
        ringHolder.position.set(h.x, 0, h.z);
        ship.rotation.z = Math.sin(now * 0.8) * 0.05 + 0.06;
        ship.rotation.x = Math.sin(now * 0.6) * 0.02;
        ship.position.y = Math.sin(now * 0.7) * 0.6;
      },
    };
  }

  update(hazards: Hazard[], now: number): void {
    hazards.forEach((hazard, i) => this.views[i].update(hazard, now));
  }
}
