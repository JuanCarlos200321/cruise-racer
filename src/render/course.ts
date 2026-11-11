import * as THREE from 'three';
import type { Track } from '../sim/track';

const BUOY_EVERY = 5; // centreline samples
const PYLON_HEIGHT = 95;
const BEACON_HEIGHT = 420;
const START_GATE_HEIGHT = 190;

function checkerTexture(columns: number, rows: number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = columns * 8;
  canvas.height = rows * 8;
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
      ctx.fillRect(x * 8, y * 8, 8, 8);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  return texture;
}

/** Buoys, checkpoint gates and the start line for a track. */
export class Course {
  readonly group = new THREE.Group();
  private readonly beacons: THREE.Mesh[] = [];
  private pylons: THREE.InstancedMesh | null = null;
  private readonly track: Track;

  constructor(track: Track) {
    this.track = track;
    this.addBuoys();
    this.addGates();
    this.addStartLine();
    this.addBeacons();
  }

  /** Light up the gate the player is heading for. */
  setNextCheckpoint(checkpoint: number): void {
    const index = this.track.checkpoints[checkpoint];
    [-1, 1].forEach((side, i) => {
      const p = this.track.pointAt(index, side * this.track.halfWidth);
      this.beacons[i].position.set(p.x, BEACON_HEIGHT / 2, p.z);
    });
  }

  /** Show or hide the checkpoint gates. They are hidden behind the menus. */
  setGatesVisible(visible: boolean): void {
    for (const beacon of this.beacons) beacon.visible = visible;
    if (this.pylons) this.pylons.visible = visible;
  }

  private addBuoys(): void {
    const profile = [
      [0, 0],
      [4.2, 0],
      [4.2, 2.2],
      [1.6, 3.4],
      [1.3, 9],
      [2.4, 9.4],
      [0, 13],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const geometry = new THREE.LatheGeometry(profile, 10);
    const count = Math.floor(this.track.sampleCount / BUOY_EVERY);
    // Red marks the starboard edge of the course and green the port edge.
    for (const [side, color] of [
      [1, '#e3262c'],
      [-1, '#18a558'],
    ] as const) {
      const buoys = new THREE.InstancedMesh(
        geometry,
        new THREE.MeshStandardMaterial({ color, roughness: 0.4, emissive: color, emissiveIntensity: 0.25 }),
        count,
      );
      const matrix = new THREE.Matrix4();
      for (let i = 0; i < count; i++) {
        const p = this.track.pointAt(i * BUOY_EVERY, side * this.track.halfWidth);
        matrix.makeTranslation(p.x, -0.5, p.z);
        buoys.setMatrixAt(i, matrix);
      }
      buoys.castShadow = true;
      this.group.add(buoys);
    }
  }

  private addGates(): void {
    const geometry = new THREE.CylinderGeometry(3.5, 5, PYLON_HEIGHT, 12);
    const material = new THREE.MeshStandardMaterial({ color: '#f6c21c', roughness: 0.5 });
    const pylons = new THREE.InstancedMesh(geometry, material, this.track.checkpoints.length * 2);
    const matrix = new THREE.Matrix4();
    this.track.checkpoints.forEach((index, k) => {
      [-1, 1].forEach((side, i) => {
        const p = this.track.pointAt(index, side * this.track.halfWidth);
        matrix.makeTranslation(p.x, PYLON_HEIGHT / 2 - 2, p.z);
        pylons.setMatrixAt(k * 2 + i, matrix);
      });
    });
    pylons.castShadow = true;
    this.pylons = pylons;
    this.group.add(pylons);
  }

  private addStartLine(): void {
    const width = this.track.halfWidth * 2;
    const centre = this.track.samples[0];
    const heading = this.track.headingAt(0);

    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(width, 24),
      new THREE.MeshBasicMaterial({
        map: checkerTexture(Math.round(width / 8), 3),
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
    );
    line.rotation.set(-Math.PI / 2, heading, 0, 'YXZ');
    line.position.set(centre.x, 0.4, centre.z);
    this.group.add(line);

    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(width, 20),
      new THREE.MeshStandardMaterial({
        map: checkerTexture(Math.round(width / 8), 2),
        side: THREE.DoubleSide,
        roughness: 0.7,
      }),
    );
    banner.rotation.y = heading;
    banner.position.set(centre.x, START_GATE_HEIGHT - 10, centre.z);
    this.group.add(banner);

    // Towers tall enough to carry the banner clear of the chase camera.
    const material = new THREE.MeshStandardMaterial({ color: '#f6c21c', roughness: 0.5 });
    for (const side of [-1, 1]) {
      const p = this.track.pointAt(0, side * this.track.halfWidth);
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(5, 8, START_GATE_HEIGHT, 12), material);
      tower.position.set(p.x, START_GATE_HEIGHT / 2 - 2, p.z);
      tower.castShadow = true;
      this.group.add(tower);
    }
  }

  private addBeacons(): void {
    const geometry = new THREE.CylinderGeometry(7, 7, BEACON_HEIGHT, 16, 1, true);
    const material = new THREE.MeshBasicMaterial({
      color: '#59d8ff',
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    for (let i = 0; i < 2; i++) {
      const beacon = new THREE.Mesh(geometry, material);
      this.beacons.push(beacon);
      this.group.add(beacon);
    }
    this.setNextCheckpoint(0);
  }
}
