import * as THREE from 'three';
import { createRng } from '../sim/rng';
import type { ShipClass } from '../sim/ships';
import type { Hull } from './shipHull';

/** Height of one deck, metres. */
export const DECK_HEIGHT = 3;
/** Width of one cabin, and so one balcony, metres. */
export const CABIN_WIDTH = 3.4;

const NAVY = '#14294d';
const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

function texture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d')!);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 16;
  return map;
}

/** The wall at the back of the balconies: glass doors, some with curtains drawn or lights on. */
function cabinTexture(): THREE.Texture {
  const columns = 8;
  const rows = 4;
  const cell = 64;
  const rng = createRng(7);
  const map = texture(columns * cell, rows * cell, (ctx) => {
    ctx.fillStyle = '#dde3e8';
    ctx.fillRect(0, 0, columns * cell, rows * cell);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x = column * cell;
        const y = row * cell;
        const glass = ctx.createLinearGradient(0, y + 6, 0, y + 58);
        glass.addColorStop(0, '#34495c');
        glass.addColorStop(1, '#16212c');
        ctx.fillStyle = glass;
        ctx.fillRect(x + 5, y + 6, cell - 10, 52);
        if (rng() < 0.5) {
          const drawn = (cell - 10) * (0.25 + rng() * 0.5);
          ctx.fillStyle = 'rgba(214, 205, 188, 0.6)';
          ctx.fillRect(rng() < 0.5 ? x + 5 : x + cell - 5 - drawn, y + 6, drawn, 52);
        }
        if (rng() < 0.1) {
          ctx.fillStyle = 'rgba(255, 214, 150, 0.45)';
          ctx.fillRect(x + 5, y + 6, cell - 10, 52);
        }
        ctx.fillStyle = '#c9d1d8';
        ctx.fillRect(x + cell / 2 - 1, y + 6, 2, 52);
      }
    }
  });
  map.repeat.set(1 / (columns * CABIN_WIDTH), 1 / (rows * DECK_HEIGHT));
  return map;
}

/** Large windows of the public decks. */
function windowTexture(frame: string, top: string, bottom: string): THREE.Texture {
  const columns = 4;
  const cell = 64;
  const map = texture(columns * cell, cell, (ctx) => {
    ctx.fillStyle = frame;
    ctx.fillRect(0, 0, columns * cell, cell);
    for (let column = 0; column < columns; column++) {
      const x = column * cell;
      const glass = ctx.createLinearGradient(0, 10, 0, 52);
      glass.addColorStop(0, top);
      glass.addColorStop(1, bottom);
      ctx.fillStyle = glass;
      ctx.fillRect(x + 3, 10, cell - 6, 42);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
      ctx.beginPath();
      ctx.moveTo(x + 3, 52);
      ctx.lineTo(x + 30, 10);
      ctx.lineTo(x + 44, 10);
      ctx.lineTo(x + 17, 52);
      ctx.fill();
    }
  });
  map.repeat.set(1 / (columns * 4), 1 / DECK_HEIGHT);
  return map;
}

/** One side of the hull, drawn as seen from abeam. */
function hullSideTexture(cls: ShipClass, hull: Hull, bowLeft: boolean, paint: string): THREE.Texture {
  const width = 4096;
  const height = 256;
  const L = hull.length;
  const sx = width / L;
  const sy = height / (hull.top + hull.draft);
  /** Canvas x for a distance from the stern. */
  const X = (m: number): number => (bowLeft ? width - m * sx : m * sx);
  const Y = (y: number): number => height - (y + hull.draft) * sy;
  const rng = createRng(cls.length);

  return texture(width, height, (ctx) => {
    ctx.fillStyle = paint;
    ctx.fillRect(0, 0, width, height);

    // Faint seams between hull plates.
    ctx.fillStyle = 'rgba(40, 60, 80, 0.05)';
    for (let m = 6; m < L; m += 9 + rng() * 5) ctx.fillRect(X(m), 0, 1, height);
    for (let y = 2.8; y < hull.top; y += 2.9) ctx.fillRect(0, Y(y), width, 1);

    // Boot topping at the waterline.
    ctx.fillStyle = NAVY;
    ctx.fillRect(0, Y(1.3), width, height - Y(1.3));
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillRect(0, Y(1.5), width, 0.2 * sy);

    const glass = '#1d2b3a';
    for (const y of [4.2, 7.2]) {
      for (let m = L * 0.07; m < L * 0.86; m += 3.2) {
        ctx.fillStyle = glass;
        ctx.beginPath();
        ctx.ellipse(X(m), Y(y), 0.42 * sx, 0.42 * sy, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (let y = 10.2; y < hull.top - 1.6; y += DECK_HEIGHT) {
      for (let m = L * 0.1; m < L * 0.8; m += CABIN_WIDTH) {
        ctx.fillStyle = glass;
        ctx.fillRect(X(m) - 0.7 * sx, Y(y + 0.6), 1.4 * sx, 1.2 * sy);
        ctx.fillStyle = 'rgba(140, 190, 220, 0.35)';
        ctx.fillRect(X(m) - 0.7 * sx, Y(y + 0.6), 1.4 * sx, 0.3 * sy);
      }
    }

    // Shell doors for tenders and stores.
    ctx.strokeStyle = 'rgba(40, 60, 80, 0.35)';
    ctx.lineWidth = 1.5;
    for (const fraction of [0.24, 0.42, 0.6, 0.72]) {
      ctx.strokeRect(X(L * fraction) - 3 * sx, Y(5.4), 6 * sx, 3.4 * sy);
    }

    // Anchor pocket.
    ctx.fillStyle = '#2a333c';
    ctx.fillRect(X(L * 0.955) - 1.2 * sx, Y(hull.top - 4.5), 2.4 * sx, 2.6 * sy);
    ctx.fillStyle = '#7b848c';
    ctx.fillRect(X(L * 0.955) - 0.25 * sx, Y(hull.top - 4.7), 0.5 * sx, 2 * sy);
    ctx.fillRect(X(L * 0.955) - 0.9 * sx, Y(hull.top - 6.2), 1.8 * sx, 0.5 * sy);

    // The ship's name on the bow.
    const name = cls.shipNames[0].toUpperCase();
    ctx.fillStyle = NAVY;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.round(2.5 * sy)}px ${FONT}`;
    const fit = Math.min(1, (L * 0.095 * sx) / ctx.measureText(name).width);
    ctx.save();
    ctx.translate(X(L * 0.892), Y(hull.top - 3.2));
    ctx.scale(fit, 1);
    ctx.fillText(name, 0, 0);
    ctx.restore();
  });
}

/** The flat stern, with the name and port of registry. */
function transomTexture(cls: ShipClass, hull: Hull, paint: string): THREE.Texture {
  const width = 1024;
  const height = 256;
  const sy = height / (hull.top + hull.draft);
  const Y = (y: number): number => height - (y + hull.draft) * sy;
  return texture(width, height, (ctx) => {
    ctx.fillStyle = paint;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = NAVY;
    ctx.fillRect(0, Y(1.3), width, height - Y(1.3));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.round(1.9 * sy)}px ${FONT}`;
    ctx.fillText(cls.shipNames[0].toUpperCase(), width / 2, Y(hull.top - 3));
    ctx.font = `bold ${Math.round(1.2 * sy)}px ${FONT}`;
    ctx.fillText('NASSAU', width / 2, Y(hull.top - 5.4));
    ctx.fillStyle = '#1d2b3a';
    for (let i = -9; i <= 9; i++) {
      if (Math.abs(i) < 1) continue;
      ctx.fillRect(width / 2 + i * 44 - 12, Y(9.4), 24, 1.2 * sy);
    }
  });
}

/** A crown-and-anchor emblem for the funnel. */
function emblemTexture(): THREE.Texture {
  const size = 256;
  const map = texture(size, size, (ctx) => {
    ctx.strokeStyle = '#12306b';
    ctx.fillStyle = '#12306b';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 15;
    // Anchor: ring, shank, stock and arms.
    ctx.beginPath();
    ctx.arc(128, 104, 11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(128, 116);
    ctx.lineTo(128, 226);
    ctx.moveTo(96, 140);
    ctx.lineTo(160, 140);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(128, 166, 60, Math.PI * 0.1, Math.PI * 0.9);
    ctx.stroke();
    // Crown.
    ctx.beginPath();
    ctx.moveTo(76, 80);
    ctx.lineTo(66, 28);
    ctx.lineTo(100, 54);
    ctx.lineTo(128, 16);
    ctx.lineTo(156, 54);
    ctx.lineTo(190, 28);
    ctx.lineTo(180, 80);
    ctx.closePath();
    ctx.fill();
  });
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  return map;
}

function helipadTexture(): THREE.Texture {
  const size = 256;
  return texture(size, size, (ctx) => {
    ctx.fillStyle = '#3f7a5a';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#f2d23c';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(128, 128, 96, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold 120px ${FONT}`;
    ctx.fillText('H', 128, 134);
  });
}

const SHARED_KEYS = [
  'white',
  'panel',
  'cabin',
  'windows',
  'recess',
  'rail',
  'glass',
  'darkGlass',
  'teak',
  'sportDeck',
  'turf',
  'pool',
  'black',
  'grey',
  'boatTop',
  'emblem',
  'helipad',
  'slide0',
  'slide1',
  'slide2',
  'slide3',
  'slide4',
] as const;

export type MaterialKey = (typeof SHARED_KEYS)[number] | 'hullPort' | 'hullStarboard' | 'transom';

/** Materials that never cast a shadow: glass you can see through, and decals. */
export const NO_SHADOW: ReadonlySet<MaterialKey> = new Set<MaterialKey>(['rail', 'emblem', 'helipad']);

type Shared = Record<(typeof SHARED_KEYS)[number], THREE.Material>;
let shared: Shared | null = null;

function sharedMaterials(): Shared {
  if (shared) return shared;
  const std = (parameters: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial(parameters);
  const paint = { roughness: 0.42, metalness: 0 };
  const slide = (color: string): THREE.Material => std({ color, roughness: 0.3 });
  shared = {
    white: std({ color: '#f4f6f8', ...paint }),
    panel: std({ color: '#f4f6f8', ...paint, side: THREE.DoubleSide }),
    cabin: std({ map: cabinTexture(), roughness: 0.45, metalness: 0.1 }),
    windows: std({ map: windowTexture('#eef2f5', '#4a7da3', '#1b3247'), roughness: 0.15, metalness: 0.5 }),
    recess: std({ map: windowTexture('#b9c0c6', '#2a3d4e', '#121b24'), roughness: 0.5, metalness: 0.2 }),
    rail: std({
      color: '#a9d2e6',
      roughness: 0.05,
      metalness: 0.3,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    glass: std({ color: '#7fc3e6', roughness: 0.06, metalness: 0.9 }),
    darkGlass: std({ color: '#1c2f42', roughness: 0.08, metalness: 0.85 }),
    teak: std({ color: '#b59a72', roughness: 0.9 }),
    sportDeck: std({ color: '#3f7fae', roughness: 0.85 }),
    turf: std({ color: '#4d9a4a', roughness: 0.95 }),
    pool: std({ color: '#25c1e2', roughness: 0.05, metalness: 0.3 }),
    black: std({ color: '#1b2026', roughness: 0.7 }),
    grey: std({ color: '#c9d0d6', roughness: 0.45, metalness: 0.4 }),
    boatTop: std({ color: '#f08a1c', roughness: 0.5 }),
    emblem: std({
      map: emblemTexture(),
      transparent: true,
      alphaTest: 0.5,
      roughness: 0.5,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    helipad: std({
      map: helipadTexture(),
      roughness: 0.9,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    slide0: slide('#ff5a36'),
    slide1: slide('#ffc928'),
    slide2: slide('#35c26b'),
    slide3: slide('#e84ba0'),
    slide4: slide('#3fa7ff'),
  };
  return shared;
}

/** Every material for one ship class. Hull materials carry that ship's name. */
export function materialsFor(cls: ShipClass, hull: Hull, paint: string): Record<MaterialKey, THREE.Material> {
  const hullPaint = { roughness: 0.38, metalness: 0 };
  return {
    ...sharedMaterials(),
    hullPort: new THREE.MeshStandardMaterial({ map: hullSideTexture(cls, hull, true, paint), ...hullPaint }),
    hullStarboard: new THREE.MeshStandardMaterial({
      map: hullSideTexture(cls, hull, false, paint),
      ...hullPaint,
    }),
    transom: new THREE.MeshStandardMaterial({ map: transomTexture(cls, hull, paint), ...hullPaint }),
  };
}
