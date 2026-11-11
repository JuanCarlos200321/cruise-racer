import * as THREE from 'three';
import type { ShipClass } from '../sim/ships';
import type { Track } from '../sim/track';
import { Course } from './course';
import { createLand } from './land';
import { createOcean, createShoreMap } from './ocean';
import { bridgeOf, createShipModel, type BridgePosition } from './shipModel';
import { atmosphereFor, createSkyDome, type Atmosphere } from './sky';
import { Wake } from './wake';

const SHADOW_RANGE = 420;

/** A ship as drawn: model, wake, and the small motions that make it feel afloat. */
export class ShipView {
  readonly root = new THREE.Group();
  readonly wake: Wake;
  readonly bridge: BridgePosition;
  private readonly model: THREE.Group;
  private roll = 0;
  private pitch = 0;
  private readonly phase = Math.random() * 10;

  constructor(readonly cls: ShipClass, time: THREE.IUniform<number>) {
    this.model = createShipModel(cls);
    this.root.add(this.model);
    this.bridge = bridgeOf(this.model);
    this.wake = new Wake(cls, time);
  }

  /**
   * Place the ship. yawRate and acceleration drive the heel in turns and the
   * squat under power.
   */
  update(
    x: number,
    z: number,
    heading: number,
    speed: number,
    yawRate: number,
    throttle: number,
    now: number,
    dt: number,
  ): void {
    this.root.position.set(x, 0, z);
    this.root.rotation.y = heading;

    // Ships heel outwards in a turn. Starboard is -X, so a starboard turn
    // (positive yaw rate) rolls the port side down.
    const heel = THREE.MathUtils.clamp(-yawRate * speed * 0.011, -0.09, 0.09);
    const swell = Math.sin(now * 0.5 + this.phase) * 0.006;
    const blend = 1 - Math.exp(-dt * 1.5);
    this.roll += (heel + swell - this.roll) * blend;
    const squat = -throttle * 0.006 + Math.sin(now * 0.37 + this.phase * 2) * 0.003;
    this.pitch += (squat - this.pitch) * blend;
    this.model.rotation.set(this.pitch, 0, this.roll);
    this.model.position.y = Math.sin(now * 0.43 + this.phase) * 0.35;

    this.wake.update(x, z, heading, speed, now);
  }
}

/** Everything drawn for one track: sky, sea, land, course markers and ships. */
export class World {
  readonly scene = new THREE.Scene();
  readonly atmosphere: Atmosphere;
  readonly course: Course;
  readonly time: THREE.IUniform<number> = { value: 0 };
  readonly ships: ShipView[] = [];
  private readonly sun: THREE.DirectionalLight;
  private readonly sky: THREE.Mesh;
  private readonly ocean: THREE.Mesh;
  private environment: THREE.WebGLRenderTarget | null = null;

  constructor(track: Track, renderer: THREE.WebGLRenderer) {
    this.atmosphere = atmosphereFor(track.def.theme);
    const a = this.atmosphere;

    this.scene.fog = new THREE.FogExp2(a.horizon.clone().lerp(a.zenith, 0.08), a.fogDensity);

    this.sky = createSkyDome(a, this.time);
    this.scene.add(this.sky);
    this.ocean = createOcean(a, createShoreMap(track.obstacles), this.time);
    this.scene.add(this.ocean);

    // Light the scene from the sky itself so glass and paint pick up its colour.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const skyOnly = new THREE.Scene();
    skyOnly.add(createSkyDome(a, { value: 0 }));
    this.environment = pmrem.fromScene(skyOnly, 0, 10, 40000);
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 0.75;
    pmrem.dispose();

    this.sun = new THREE.DirectionalLight(a.sunColor, a.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const shadowCamera = this.sun.shadow.camera;
    shadowCamera.left = -SHADOW_RANGE;
    shadowCamera.right = SHADOW_RANGE;
    shadowCamera.top = SHADOW_RANGE;
    shadowCamera.bottom = -SHADOW_RANGE;
    shadowCamera.near = 100;
    shadowCamera.far = 3000;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(new THREE.HemisphereLight(a.zenith, a.waterDeep, 0.5));

    this.scene.add(createLand(track.obstacles));
    this.course = new Course(track);
    this.scene.add(this.course.group);
  }

  addShip(cls: ShipClass): ShipView {
    const ship = new ShipView(cls, this.time);
    this.ships.push(ship);
    this.scene.add(ship.root, ship.wake.mesh);
    return ship;
  }

  clearShips(): void {
    for (const ship of this.ships) {
      this.scene.remove(ship.root, ship.wake.mesh);
      // Ship geometry and materials are shared by every ship of a class, so they are kept.
      ship.wake.dispose();
    }
    this.ships.length = 0;
  }

  /** Keep the sky, sea and shadows centred on what the camera is looking at. */
  update(now: number, camera: THREE.Camera, focus: THREE.Vector3): void {
    this.time.value = now;
    this.sky.position.copy(camera.position);
    this.ocean.position.set(camera.position.x, 0, camera.position.z);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.atmosphere.sunDir, 1500);
  }

  dispose(): void {
    this.clearShips();
    disposeTree(this.scene);
    this.environment?.dispose();
  }
}

/** Free the GPU resources of everything under an object. */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      const map = (material as THREE.MeshStandardMaterial).map;
      if (map) map.dispose();
      material.dispose();
    }
  });
}
