import * as THREE from 'three';
import type { ShipClass } from '../sim/ships';
import type { BridgePosition } from './shipModel';

export type CameraMode = 'chase' | 'bridge';

interface ShipPose {
  x: number;
  z: number;
  heading: number;
  speed: number;
}

const BASE_FOV = 52;

/** Chase and bridge cameras for racing, and a slow orbit for the menus. */
export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 4, 80000);
  /** Point the camera is looking at, used to centre the shadows. */
  readonly focus = new THREE.Vector3();
  mode: CameraMode = 'chase';
  private readonly position = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3();
  private heading = 0;
  private settled = false;
  private width = 1;
  private height = 1;
  private frameX = 0;
  private frameY = 0;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.applyFraming();
  }

  toggleMode(): void {
    this.mode = this.mode === 'chase' ? 'bridge' : 'chase';
    this.settled = false;
  }

  /** Jump straight to the target on the next update instead of easing. */
  snap(): void {
    this.settled = false;
  }

  follow(pose: ShipPose, cls: ShipClass, bridge: BridgePosition, dt: number): void {
    const speedFraction = THREE.MathUtils.clamp(pose.speed / cls.topSpeed, 0, 1.1);

    if (this.mode === 'bridge') {
      const fx = Math.sin(pose.heading);
      const fz = Math.cos(pose.heading);
      // Stand on the bridge roof, looking out over the bow.
      const eye = bridge.y + 4;
      const z = bridge.z + 9;
      this.camera.position.set(pose.x + fx * z, eye, pose.z + fz * z);
      this.lookAt.set(pose.x + fx * (z + 500), eye - 45, pose.z + fz * (z + 500));
      this.camera.lookAt(this.lookAt);
      this.focus.set(pose.x, 0, pose.z);
      this.setFov(62 + speedFraction * 8);
      return;
    }

    // The camera swings round behind the ship with a lag, so turns are felt.
    if (!this.settled) this.heading = pose.heading;
    let delta = pose.heading - this.heading;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    this.heading += delta * (1 - Math.exp(-dt * 2.2));

    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const back = cls.length * (0.95 + 0.2 * speedFraction);
    const height = cls.length * 0.3;
    this.position.set(pose.x - fx * back, height, pose.z - fz * back);
    const lead = cls.length * 0.45;
    this.lookAt.set(
      pose.x + Math.sin(pose.heading) * lead,
      cls.height * 0.4,
      pose.z + Math.cos(pose.heading) * lead,
    );

    if (!this.settled) {
      this.camera.position.copy(this.position);
      this.settled = true;
    } else {
      this.camera.position.lerp(this.position, 1 - Math.exp(-dt * 6));
    }
    this.camera.lookAt(this.lookAt);
    this.focus.set(pose.x, 0, pose.z);
    this.setFov(BASE_FOV + speedFraction * speedFraction * 14);
  }

  /**
   * Shift the picture within the window, as fractions of its size, to leave
   * room for menu panels. Positive x moves the subject right; positive y, up.
   */
  setFraming(x: number, y: number): void {
    if (x === this.frameX && y === this.frameY) return;
    this.frameX = x;
    this.frameY = y;
    this.applyFraming();
  }

  private applyFraming(): void {
    if (this.frameX === 0 && this.frameY === 0) this.camera.clearViewOffset();
    else {
      this.camera.setViewOffset(
        this.width,
        this.height,
        -this.frameX * this.width,
        this.frameY * this.height,
        this.width,
        this.height,
      );
    }
  }

  /** Circle a point, for the menus. */
  orbit(centre: THREE.Vector3, radius: number, height: number, angle: number): void {
    this.camera.position.set(
      centre.x + Math.sin(angle) * radius,
      height,
      centre.z + Math.cos(angle) * radius,
    );
    this.lookAt.copy(centre);
    this.camera.lookAt(this.lookAt);
    this.focus.copy(centre);
    this.setFov(40);
    this.settled = false;
  }

  private setFov(fov: number): void {
    if (Math.abs(this.camera.fov - fov) < 0.01) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }
}
