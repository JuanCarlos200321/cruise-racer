import * as THREE from 'three';
import type { ItemField } from '../sim/items';

const BOX_SIZE = 30;
const BOX_HEIGHT = 26;
const MAX_SHOTS = 8;
const MAX_DROPS = 30;

/** Royal blue wrapping with a gold ribbon and a question mark. */
function boxTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#12357a';
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = '#ffd23f';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, 118, 118);
  ctx.fillStyle = '#ffd23f';
  ctx.font = '900 96px "Avenir Next", "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('?', 64, 70);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Draws the power-up boxes on a route, and the corks and coconuts in play. */
export class ItemViews {
  readonly group = new THREE.Group();
  private readonly boxes: THREE.InstancedMesh;
  private readonly shots: THREE.Group[] = [];
  private readonly drops: THREE.InstancedMesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(field: ItemField) {
    const map = boxTexture();
    this.boxes = new THREE.InstancedMesh(
      new THREE.BoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE),
      new THREE.MeshStandardMaterial({ map, emissive: '#ffffff', emissiveMap: map, emissiveIntensity: 0.55, roughness: 0.4 }),
      field.boxes.length,
    );
    this.boxes.castShadow = true;
    this.boxes.frustumCulled = false;
    this.group.add(this.boxes);

    const corkMaterial = new THREE.MeshStandardMaterial({ color: '#c9a36b', roughness: 0.8 });
    const foilMaterial = new THREE.MeshStandardMaterial({ color: '#ffd23f', roughness: 0.3, metalness: 0.6 });
    const trailMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, depthWrite: false });
    for (let i = 0; i < MAX_SHOTS; i++) {
      const shot = new THREE.Group();
      const cork = new THREE.Mesh(new THREE.CylinderGeometry(6, 4.5, 15, 14), corkMaterial);
      cork.rotation.x = Math.PI / 2;
      cork.castShadow = true;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(7.5, 14, 10), foilMaterial);
      cap.position.z = 8;
      cap.scale.z = 0.7;
      const trail = new THREE.Mesh(new THREE.ConeGeometry(4, 60, 10, 1, true), trailMaterial);
      trail.rotation.x = Math.PI / 2;
      trail.position.z = -38;
      shot.add(cork, cap, trail);
      shot.visible = false;
      this.shots.push(shot);
      this.group.add(shot);
    }

    this.drops = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 14, 10),
      new THREE.MeshStandardMaterial({ roughness: 0.85 }),
      MAX_DROPS,
    );
    this.drops.castShadow = true;
    this.drops.frustumCulled = false;
    const color = new THREE.Color();
    // Two coconuts to every lime.
    for (let i = 0; i < MAX_DROPS; i++) this.drops.setColorAt(i, color.set(i % 3 === 1 ? '#8fd13a' : '#5a3a1f'));
    this.group.add(this.drops);
  }

  update(field: ItemField, now: number): void {
    field.boxes.forEach((box, i) => {
      const size = box.ready ? 1 : 0;
      this.position.set(box.x, BOX_HEIGHT + Math.sin(now * 1.6 + i) * 3, box.z);
      this.quaternion.setFromAxisAngle(this.up, now * 0.9 + i);
      this.matrix.compose(this.position, this.quaternion, this.scale.set(size, size, size));
      this.boxes.setMatrixAt(i, this.matrix);
    });
    this.boxes.instanceMatrix.needsUpdate = true;

    this.shots.forEach((view, i) => {
      const shot = field.shots[i];
      view.visible = shot !== undefined;
      if (!shot) return;
      view.position.set(shot.x, 16, shot.z);
      view.rotation.y = shot.heading;
    });

    for (let i = 0; i < MAX_DROPS; i++) {
      const drop = field.drops[i];
      const size = drop ? (i % 3 === 1 ? 7 : 10) : 0;
      this.position.set(drop?.x ?? 0, 2 + Math.sin(now * 1.3 + i * 1.7) * 1.2, drop?.z ?? 0);
      this.matrix.compose(this.position, this.quaternion.identity(), this.scale.set(size, size, size));
      this.drops.setMatrixAt(i, this.matrix);
    }
    this.drops.instanceMatrix.needsUpdate = true;
  }
}
