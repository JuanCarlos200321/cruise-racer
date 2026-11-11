import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createRng } from '../sim/rng';
import type { Obstacle, ObstacleKind } from '../sim/track';

const RINGS = 12;
/** Land reaches this fraction of the obstacle's collision radius at the waterline. */
const SHORE_FRACTION = 0.97;

interface Terrain {
  /** Peak height for an obstacle of radius r. */
  peak: (r: number) => number;
  /** Height profile from the centre (0) to the shore (1), 1 at the centre and 0 at the shore. */
  profile: (rho: number) => number;
  /** How strongly the outline and heights are roughened. */
  roughness: number;
  color: (height: number, peak: number, noise: number) => THREE.Color;
}

const C = (hex: string): THREE.Color => new THREE.Color(hex);
const SAND = C('#e6d6a3');
const JUNGLE = C('#3b8a3a');
const JUNGLE_DARK = C('#24602c');
const ROCK = C('#6f7478');
const ROCK_DARK = C('#474c4d');
const FOREST = C('#2c4a37');
const SNOW = C('#f3f6fa');
const QUAY = C('#8f948f');
const PAVING = C('#a9aaa3');

const TERRAIN: Record<ObstacleKind, Terrain> = {
  island: {
    peak: (r) => 18 + r * 0.28,
    profile: (rho) => Math.pow(1 - rho, 1.35),
    roughness: 0.3,
    color: (h, _peak, n) => (h < 3.5 ? SAND.clone() : JUNGLE.clone().lerp(JUNGLE_DARK, n)),
  },
  mountain: {
    peak: (r) => r * 1.25,
    profile: (rho) => Math.pow(1 - rho, 0.95),
    roughness: 0.42,
    color: (h, peak, n) => {
      const t = h / peak;
      if (t > 0.58 + n * 0.14) return SNOW.clone();
      if (t > 0.3 + n * 0.1) return ROCK.clone().lerp(ROCK_DARK, n);
      if (h > 6) return FOREST.clone().lerp(ROCK_DARK, n * 0.5);
      return ROCK_DARK.clone();
    },
  },
  rocks: {
    peak: (r) => 7 + r * 0.22,
    profile: (rho) => Math.sqrt(Math.max(0, 1 - rho * rho)),
    roughness: 0.35,
    color: (_h, _peak, n) => ROCK.clone().lerp(ROCK_DARK, n),
  },
  city: {
    peak: () => 5,
    profile: (rho) => 1 - THREE.MathUtils.smoothstep(rho, 0.9, 1),
    roughness: 0.05,
    color: (h, _peak, n) => (h < 4 ? QUAY.clone() : PAVING.clone().lerp(QUAY, n * 0.6)),
  },
};

/** Smooth pseudo-random variation round an obstacle, the same every run. */
function makeNoise(seed: number): (angle: number, rho: number) => number {
  const rng = createRng(Math.floor(seed));
  const terms = [1, 2, 3, 5, 8].map((frequency) => ({
    frequency,
    phase: rng() * Math.PI * 2,
    drift: (rng() - 0.5) * 6,
    amplitude: 1 / Math.sqrt(frequency),
  }));
  const total = terms.reduce((sum, t) => sum + t.amplitude, 0);
  return (angle, rho) => {
    let value = 0;
    for (const t of terms) value += t.amplitude * Math.sin(angle * t.frequency + t.phase + rho * t.drift);
    return value / total;
  };
}

interface Surface {
  /** Ground height at a point given in polar coordinates round the obstacle. */
  heightAt: (angle: number, rho: number) => number;
  peak: number;
  radius: number;
}

function surfaceOf(o: Obstacle): Surface {
  const terrain = TERRAIN[o.kind];
  const noise = makeNoise(o.seed);
  const peak = terrain.peak(o.r);
  return {
    peak,
    radius: o.r * SHORE_FRACTION,
    heightAt: (angle, rho) => {
      const bump = 1 + terrain.roughness * noise(angle, rho) * Math.min(1, rho * 3 + 0.3);
      return peak * terrain.profile(rho) * bump;
    },
  };
}

function landGeometry(o: Obstacle): THREE.BufferGeometry {
  const terrain = TERRAIN[o.kind];
  const surface = surfaceOf(o);
  const noise = makeNoise(o.seed + 1);
  const segments = THREE.MathUtils.clamp(Math.round(o.r / 7), 16, 44);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (let j = 0; j <= RINGS; j++) {
    const rho = j / RINGS;
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const height = j === RINGS ? -4 : surface.heightAt(angle, rho);
      // Keep the coast inside the collision circle while roughening the outline.
      const reach = surface.radius * (1 - 0.1 * terrain.roughness * (1 + noise(angle, 0)));
      positions.push(o.x + Math.cos(angle) * reach * rho, height, o.z + Math.sin(angle) * reach * rho);
      const shade = 0.5 + 0.5 * noise(angle * 2, rho * 3);
      const color = terrain.color(Math.max(0, height), surface.peak, shade);
      colors.push(color.r, color.g, color.b);
    }
  }
  for (let j = 0; j < RINGS; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * segments + i;
      const b = j * segments + ((i + 1) % segments);
      const c = a + segments;
      const d = b + segments;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildingTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#c9ccd0';
  ctx.fillRect(0, 0, 64, 64);
  const rng = createRng(5);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 4; x++) {
      ctx.fillStyle = rng() < 0.25 ? '#ffe2a0' : '#33475c';
      ctx.fillRect(x * 16 + 3, y * 8 + 2, 10, 4);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** All the land for a track, plus the trees and buildings that stand on it. */
export function createLand(obstacles: Obstacle[]): THREE.Group {
  const group = new THREE.Group();
  if (obstacles.length === 0) return group;

  const land = new THREE.Mesh(
    mergeGeometries(obstacles.map(landGeometry)),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
  );
  land.receiveShadow = true;
  land.castShadow = true;
  group.add(land);

  const canopies: THREE.Matrix4[] = [];
  const conifers: THREE.Matrix4[] = [];
  const buildings: { matrix: THREE.Matrix4; color: THREE.Color }[] = [];
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);

  for (const o of obstacles) {
    const rng = createRng(Math.floor(o.seed) + 99);
    const surface = surfaceOf(o);
    const place = (rhoMin: number, rhoMax: number): { x: number; y: number; z: number } => {
      const angle = rng() * Math.PI * 2;
      const rho = rhoMin + rng() * (rhoMax - rhoMin);
      const reach = surface.radius * 0.88 * rho;
      return {
        x: o.x + Math.cos(angle) * reach,
        y: surface.heightAt(angle, rho),
        z: o.z + Math.sin(angle) * reach,
      };
    };

    if (o.kind === 'island') {
      const count = Math.min(90, Math.round((o.r * o.r) / 500));
      for (let i = 0; i < count; i++) {
        const p = place(0.05, 0.72);
        const size = 7 + rng() * 7;
        position.set(p.x, p.y + size * 0.35, p.z);
        scale.set(size, size * 0.6, size);
        canopies.push(new THREE.Matrix4().compose(position, rotation.identity(), scale));
      }
    } else if (o.kind === 'mountain') {
      const count = Math.min(70, Math.round(o.r / 4));
      for (let i = 0; i < count; i++) {
        const p = place(0.72, 0.95);
        const size = 0.8 + rng() * 0.7;
        position.set(p.x, p.y + 8 * size, p.z);
        scale.set(size, size, size);
        conifers.push(new THREE.Matrix4().compose(position, rotation.identity(), scale));
      }
    } else if (o.kind === 'city') {
      const count = Math.min(70, Math.round((o.r * o.r) / 900));
      for (let i = 0; i < count; i++) {
        const p = place(0.05, 0.85);
        const tower = rng() < 0.18;
        const height = tower ? 70 + rng() * 90 : 12 + rng() * 38;
        const footprint = tower ? 22 + rng() * 12 : 24 + rng() * 30;
        position.set(p.x, 4 + height / 2, p.z);
        scale.set(footprint, height, footprint * (0.7 + rng() * 0.6));
        rotation.setFromAxisAngle(up, rng() * Math.PI);
        const tint = 0.75 + rng() * 0.25;
        buildings.push({
          matrix: new THREE.Matrix4().compose(position, rotation, scale),
          color: new THREE.Color(tint, tint * (0.95 + rng() * 0.05), tint * (0.9 + rng() * 0.1)),
        });
      }
    }
  }

  const instanced = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    matrices: THREE.Matrix4[],
  ): THREE.InstancedMesh | null => {
    if (matrices.length === 0) return null;
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  instanced(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: '#2f7d34', roughness: 1, flatShading: true }),
    canopies,
  );
  instanced(
    new THREE.ConeGeometry(5, 16, 7),
    new THREE.MeshStandardMaterial({ color: '#213d2c', roughness: 1, flatShading: true }),
    conifers,
  );
  const towers = instanced(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ map: buildingTexture(), roughness: 0.6, metalness: 0.1 }),
    buildings.map((b) => b.matrix),
  );
  if (towers) buildings.forEach((b, i) => towers.setColorAt(i, b.color));

  return group;
}
