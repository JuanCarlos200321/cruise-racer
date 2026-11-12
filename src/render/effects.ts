import * as THREE from 'three';
import type { EventKind, RaceEvent } from '../sim/events';

const SPLASHES = 14;
const SPLASH_SECONDS = 1.6;
const CHUNKS = 120;
const GRAVITY = 70;

/** How big a column of water each kind of event throws up, metres, and its colour. */
const SPLASH: Record<EventKind, [number, string]> = {
  sharks: [30, '#ffffff'],
  kraken: [60, '#ffffff'],
  wave: [70, '#ffffff'],
  pirate: [45, '#ffffff'],
  whale: [70, '#ffffff'],
  splash: [170, '#ffffff'],
  crash: [32, '#ffffff'],
  sunk: [120, '#ffffff'],
  cork: [45, '#fff0b8'],
  coconut: [30, '#ffffff'],
  pickup: [26, '#ffd23f'],
  blocked: [50, '#59d8ff'],
};

/** Colours of the bits that fly off a ship. */
const WRECKAGE = ['#f4f6f8', '#f4f6f8', '#9fb4c4', '#f28c1e', '#1e3a66', '#3a3a3a'];

interface Splash {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  age: number;
  size: number;
}

interface Chunk {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  rotation: THREE.Euler;
  size: number;
  life: number;
}

/** Splashes and flying wreckage for whatever happens to ships in a race. */
export class Effects {
  readonly group = new THREE.Group();
  private readonly splashes: Splash[] = [];
  private readonly chunks: Chunk[] = [];
  private readonly chunkMesh: THREE.InstancedMesh;
  private nextSplash = 0;
  private nextChunk = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();

  constructor() {
    const geometry = new THREE.ConeGeometry(1, 2.2, 14, 1, true);
    // Point in the water, opening upwards.
    geometry.rotateX(Math.PI);
    geometry.translate(0, 1.1, 0);
    for (let i = 0; i < SPLASHES; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: '#ffffff',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      this.group.add(mesh);
      this.splashes.push({ mesh, material, age: SPLASH_SECONDS, size: 1 });
    }

    this.chunkMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.7 }),
      CHUNKS,
    );
    this.chunkMesh.castShadow = true;
    this.chunkMesh.frustumCulled = false;
    const color = new THREE.Color();
    this.matrix.makeScale(0, 0, 0);
    for (let i = 0; i < CHUNKS; i++) {
      this.chunks.push({
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        rotation: new THREE.Euler(),
        size: 1,
        life: 0,
      });
      this.chunkMesh.setMatrixAt(i, this.matrix);
      this.chunkMesh.setColorAt(i, color.set(WRECKAGE[i % WRECKAGE.length]));
    }
    this.group.add(this.chunkMesh);
  }

  /** Show an event where it happened. */
  burst(event: RaceEvent): void {
    const [size, color] = SPLASH[event.kind];
    const scale = event.kind === 'crash' && event.heavy ? 1.7 : 1;
    const at = { x: event.x, z: event.z };
    const splash = this.splashes[this.nextSplash];
    this.nextSplash = (this.nextSplash + 1) % this.splashes.length;
    splash.age = 0;
    splash.size = size * scale;
    splash.material.color.set(color);
    splash.mesh.position.set(at.x, 0, at.z);
    splash.mesh.visible = true;

    let pieces = 0;
    if (event.kind === 'crash') pieces = event.heavy ? 30 : 12;
    else if (event.kind === 'sunk') pieces = 50;
    else if (event.kind === 'cork' || event.kind === 'pirate') pieces = 10;
    else if (event.kind === 'whale' && event.heavy) pieces = 8;
    const force = event.kind === 'sunk' ? 1.5 : event.heavy ? 1.2 : 0.8;
    for (let i = 0; i < pieces; i++) {
      const chunk = this.chunks[this.nextChunk];
      this.nextChunk = (this.nextChunk + 1) % CHUNKS;
      const angle = Math.random() * Math.PI * 2;
      const out = (12 + Math.random() * 38) * force;
      chunk.position.set(at.x + Math.cos(angle) * 12, 18 + Math.random() * 25, at.z + Math.sin(angle) * 12);
      chunk.velocity.set(Math.cos(angle) * out, (30 + Math.random() * 45) * force, Math.sin(angle) * out);
      chunk.spin.set(Math.random() * 6 - 3, Math.random() * 6 - 3, Math.random() * 6 - 3);
      chunk.size = 2.5 + Math.random() * 6;
      chunk.life = 5;
    }
  }

  update(dt: number): void {
    for (const splash of this.splashes) {
      if (splash.age >= SPLASH_SECONDS) continue;
      splash.age += dt;
      const t = Math.min(1, splash.age / SPLASH_SECONDS);
      const rise = Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5);
      const width = splash.size * (0.35 + t * 0.5);
      splash.mesh.scale.set(width, splash.size * rise * 0.9, width);
      splash.material.opacity = 0.85 * (1 - t) ** 1.5;
      splash.mesh.visible = t < 1;
    }

    let moved = false;
    this.chunks.forEach((chunk, i) => {
      if (chunk.life <= 0) return;
      moved = true;
      chunk.life -= dt;
      chunk.velocity.y -= GRAVITY * dt;
      chunk.position.addScaledVector(chunk.velocity, dt);
      chunk.rotation.x += chunk.spin.x * dt;
      chunk.rotation.y += chunk.spin.y * dt;
      chunk.rotation.z += chunk.spin.z * dt;
      if (chunk.position.y < -4) chunk.life = 0;
      const size = chunk.life > 0 ? chunk.size : 0;
      this.matrix.compose(chunk.position, this.quaternion.setFromEuler(chunk.rotation), this.scale.set(size, size * 0.5, size * 1.4));
      this.chunkMesh.setMatrixAt(i, this.matrix);
    });
    if (moved) this.chunkMesh.instanceMatrix.needsUpdate = true;
  }
}
