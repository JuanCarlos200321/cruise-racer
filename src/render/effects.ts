import * as THREE from 'three';
import type { EventKind, RaceEvent } from '../sim/events';

const SPLASHES = 14;
const SPLASH_SECONDS = 1.6;
/** How big a column of water each kind of event throws up, metres, and its colour. */
const SPLASH: Record<EventKind, [number, string]> = {
  sharks: [30, '#ffffff'],
  kraken: [60, '#ffffff'],
  wave: [70, '#ffffff'],
  pirate: [45, '#ffffff'],
  whale: [70, '#ffffff'],
  splash: [170, '#ffffff'],
  bump: [32, '#ffffff'],
  drydock: [60, '#ffd23f'],
  cork: [45, '#fff0b8'],
  coconut: [30, '#ffffff'],
  pickup: [26, '#ffd23f'],
  blocked: [50, '#59d8ff'],
};

interface Splash {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  age: number;
  size: number;
}

/** Splashes of water for whatever happens to ships in a race. */
export class Effects {
  readonly group = new THREE.Group();
  private readonly splashes: Splash[] = [];
  private nextSplash = 0;

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
  }

  /** Show an event where it happened. */
  burst(event: RaceEvent): void {
    const [size, color] = SPLASH[event.kind];
    const scale = event.kind === 'bump' && event.heavy ? 1.7 : 1;
    const at = { x: event.x, z: event.z };
    const splash = this.splashes[this.nextSplash];
    this.nextSplash = (this.nextSplash + 1) % this.splashes.length;
    splash.age = 0;
    splash.size = size * scale;
    splash.material.color.set(color);
    splash.mesh.position.set(at.x, 0, at.z);
    splash.mesh.visible = true;
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
  }
}
