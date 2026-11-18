import * as THREE from 'three';
import { DOCK_SECONDS } from '../sim/race';
import type { ShipClass } from '../sim/ships';

/** How far a ship is lifted out of the water in dry dock, metres: its keel ends up on the blocks. */
export const DOCK_LIFT = 11;
/** Depth of a ship's hull below its waterline, metres. */
const DRAFT = 5.5;
/** Share of the stay spent coming up under the ship, and the same again going back down. */
const RAISE = 0.24;
const SPARKLES = 14;
const BOX = new THREE.BoxGeometry(1, 1, 1);
const STAR = new THREE.OctahedronGeometry(1);

const smooth = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

/**
 * A floating dry dock that comes up under a ship, lifts it clear of the water
 * while cranes swing over it and it is polished up, and goes back under.
 * Built around the origin of the ship it belongs to, bow along +Z.
 */
export class DryDock {
  readonly group = new THREE.Group();
  private readonly jibs: THREE.Group[] = [];
  private readonly sparkles: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly depth: number;

  constructor(cls: ShipClass) {
    const steel = this.material('#2f6fb7', 0.6);
    const deck = this.material('#8e9aa6', 0.9);
    const yellow = this.material('#ffd23f', 0.5);
    const white = this.material('#f4f6f8', 0.6);
    const L = cls.length * 1.08;
    const inner = cls.beam / 2 + 7;
    const wall = 9;
    const wallHeight = cls.height * 0.3 + DOCK_LIFT;
    this.depth = wallHeight + 50;

    const box = (
      material: THREE.Material,
      size: [number, number, number],
      at: [number, number, number],
      parent: THREE.Object3D = this.group,
    ): void => {
      const mesh = new THREE.Mesh(BOX, material);
      mesh.scale.set(...size);
      mesh.position.set(...at);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
    };

    // The pontoon the ship sits on, with a row of keel blocks down the middle.
    const floorTop = DOCK_LIFT - DRAFT - 2;
    box(deck, [(inner + wall) * 2, 8, L], [0, floorTop - 4, 0]);
    for (let i = -5; i <= 5; i++) box(yellow, [6, 2, 8], [0, floorTop + 1, (i / 5.5) * cls.length * 0.42]);

    for (const side of [-1, 1]) {
      const x = side * (inner + wall / 2);
      box(steel, [wall, wallHeight, L], [x, floorTop + wallHeight / 2, 0]);
      // A yellow rail along the top of each wing wall.
      box(yellow, [wall + 1, 1.5, L], [x, floorTop + wallHeight + 0.75, 0]);
      // Two cranes on each wall, with jibs that swing in over the ship.
      for (const along of [-0.28, 0.28]) {
        const top = floorTop + wallHeight + 1.5;
        const reach = inner + 14;
        box(white, [5, 34, 5], [x, top + 17, along * L]);
        const jib = new THREE.Group();
        jib.position.set(x, top + 34, along * L);
        box(yellow, [reach, 3, 3], [-side * reach * 0.38, 0, 0], jib);
        box(white, [1, 16, 1], [-side * reach * 0.8, -8, 0], jib);
        this.group.add(jib);
        this.jibs.push(jib);
      }
    }

    // Sparkles over the ship as it is polished up.
    for (let i = 0; i < SPARKLES; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: i % 3 === 0 ? '#ffffff' : '#ffe680',
        transparent: true,
        depthWrite: false,
      });
      this.materials.push(material);
      const sparkle = new THREE.Mesh(STAR, material);
      sparkle.position.set(
        (((i * 7) % 5) / 2 - 1) * cls.beam * 0.6,
        DOCK_LIFT + cls.height * (0.25 + ((i * 3) % 7) / 9),
        (i / (SPARKLES - 1) - 0.5) * cls.length * 0.9,
      );
      this.group.add(sparkle);
      this.sparkles.push(sparkle);
    }
    this.group.visible = false;
  }

  /**
   * Show the dock for a ship with this many seconds left in it (0 hides it).
   * Returns how far the ship is lifted, 0..1.
   */
  pose(secondsLeft: number, now: number): number {
    this.group.visible = secondsLeft > 0;
    if (secondsLeft <= 0) return 0;
    const t = 1 - Math.min(1, secondsLeft / DOCK_SECONDS);
    // Up under the ship, a spell of work, and down again.
    const up = Math.min(smooth(t / RAISE), smooth((1 - t) / RAISE));
    this.group.position.y = (up - 1) * this.depth;
    const working = Math.min(smooth((t - RAISE) / 0.1), smooth((1 - RAISE - t) / 0.1));
    this.jibs.forEach((jib, i) => {
      const side = jib.position.x > 0 ? 1 : -1;
      // Parked along the wall, swinging in over the ship while it is worked on.
      jib.rotation.y = side * (1 - working) * (Math.PI / 2) + Math.sin(now * 1.3 + i * 1.9) * 0.35 * working;
    });
    this.sparkles.forEach((sparkle, i) => {
      const twinkle = Math.max(0, Math.sin(now * 7 + i * 2.4));
      sparkle.scale.setScalar((1.5 + twinkle * 5) * working);
      sparkle.rotation.y = now * 2 + i;
      sparkle.material.opacity = twinkle * working;
    });
    return up;
  }

  dispose(): void {
    for (const material of this.materials) material.dispose();
  }

  private material(color: string, roughness: number): THREE.Material {
    const material = new THREE.MeshStandardMaterial({ color, roughness });
    this.materials.push(material);
    return material;
  }
}
