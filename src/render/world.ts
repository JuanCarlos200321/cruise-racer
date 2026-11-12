import * as THREE from 'three';
import type { ShipClass } from '../sim/ships';
import type { Track } from '../sim/track';
import type { RaceEvent } from '../sim/events';
import type { Hazard } from '../sim/hazards';
import type { ItemField } from '../sim/items';
import { SINK_SECONDS } from '../sim/race';
import { Course } from './course';
import { Effects } from './effects';
import { HazardViews } from './hazards';
import { ItemViews } from './items';
import { createLand } from './land';
import { createOcean, createShoreMap } from './ocean';
import { bridgeOf, createShipModel, type BridgePosition } from './shipModel';
import { atmosphereFor, createSkyDome, type Atmosphere } from './sky';
import { Wake } from './wake';

const SHADOW_RANGE = 420;
const SMOKE_PUFFS = 7;
const PUFF_GEOMETRY = new THREE.IcosahedronGeometry(1, 1);
const BUBBLE_GEOMETRY = new THREE.SphereGeometry(1, 32, 20);
const SPRAY_GEOMETRY = new THREE.ConeGeometry(1, 1, 12, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.5);

/** The state of a ship that shows: damage, going down, boosting, shielded. */
export interface ShipCondition {
  hull: number;
  sinking: number;
  boost: number;
  shield: number;
}

const SOUND: ShipCondition = { hull: 1, sinking: 0, boost: 0, shield: 0 };

/** A ship as drawn: model, wake, and the small motions that make it feel afloat. */
export class ShipView {
  readonly root = new THREE.Group();
  readonly wake: Wake;
  readonly bridge: BridgePosition;
  private readonly model: THREE.Group;
  private roll = 0;
  private pitch = 0;
  private readonly phase = Math.random() * 10;
  private readonly smoke: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly fire: THREE.Mesh;
  private readonly bubble: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly spray: THREE.Mesh;

  constructor(readonly cls: ShipClass, time: THREE.IUniform<number>) {
    this.model = createShipModel(cls);
    this.root.add(this.model);
    this.bridge = bridgeOf(this.model);
    this.wake = new Wake(cls, time);

    for (let i = 0; i < SMOKE_PUFFS; i++) {
      const puff = new THREE.Mesh(
        PUFF_GEOMETRY,
        new THREE.MeshBasicMaterial({ color: '#26262a', transparent: true, opacity: 0, depthWrite: false }),
      );
      puff.visible = false;
      this.smoke.push(puff);
      this.root.add(puff);
    }
    this.fire = new THREE.Mesh(PUFF_GEOMETRY, new THREE.MeshBasicMaterial({ color: '#ff7a1a' }));
    this.fire.visible = false;
    this.bubble = new THREE.Mesh(
      BUBBLE_GEOMETRY,
      new THREE.MeshBasicMaterial({
        color: '#35c8ff',
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.bubble.scale.set(cls.beam * 1.5, cls.height * 1.5, cls.length * 0.62);
    this.bubble.position.y = cls.height * 0.3;
    this.bubble.visible = false;
    this.spray = new THREE.Mesh(
      SPRAY_GEOMETRY,
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.spray.position.set(0, 2, -cls.length * 0.47);
    this.spray.visible = false;
    this.root.add(this.fire, this.bubble, this.spray);
  }

  dispose(): void {
    this.wake.dispose();
    for (const mesh of [...this.smoke, this.fire, this.bubble, this.spray]) (mesh.material as THREE.Material).dispose();
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
    condition: ShipCondition = SOUND,
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
    // Going down: bow first, rolling over.
    const down = condition.sinking > 0 ? 1 - condition.sinking / SINK_SECONDS : 0;
    this.model.rotation.set(this.pitch + down * 0.42, 0, this.roll + down * 0.35);
    this.model.position.y = Math.sin(now * 0.43 + this.phase) * 0.35 - down * this.cls.height * 0.85;

    // Smoke thickens as the hull goes, and fire shows when it is nearly gone.
    const cls = this.cls;
    const damage = THREE.MathUtils.clamp((0.75 - condition.hull) / 0.6, 0, 1);
    this.smoke.forEach((puff, i) => {
      puff.visible = damage > 0;
      if (damage <= 0) return;
      const t = (now * 0.3 + i / SMOKE_PUFFS + this.phase) % 1;
      puff.position.set(Math.sin(i * 2.1) * 7, cls.height * 0.9 + t * 120, -cls.length * 0.12 - t * THREE.MathUtils.clamp(speed, 0, 110) * 1.4);
      puff.scale.setScalar((7 + t * 24) * (0.6 + 0.4 * damage));
      puff.material.opacity = (1 - t) * 0.7 * damage;
    });
    this.fire.visible = condition.hull < 0.35 && down < 0.7;
    this.fire.position.set(0, cls.height * 0.95, -cls.length * 0.12);
    this.fire.scale.set(9 + Math.sin(now * 17) * 2, 13 + Math.sin(now * 23 + 1) * 4, 9 + Math.sin(now * 19) * 2);

    // The shield flickers as it runs out.
    this.bubble.visible = condition.shield > 0 && (condition.shield > 2 || Math.sin(now * 18) > 0);
    this.bubble.material.opacity = 0.3 + Math.sin(now * 4) * 0.08;
    this.spray.visible = condition.boost > 0;
    this.spray.scale.set(cls.beam * 0.45, cls.beam * (0.4 + Math.sin(now * 31) * 0.08), cls.length * (0.3 + Math.sin(now * 23) * 0.05));

    this.wake.update(x, z, heading, speed, now);
  }
}

/** Everything drawn for one route: sky, sea, land, channel markers, hazards and ships. */
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
  private hazards: HazardViews | null = null;
  private items: ItemViews | null = null;
  private readonly effects = new Effects();

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
    this.scene.add(this.course.group, this.effects.group);
  }

  addShip(cls: ShipClass): ShipView {
    const ship = new ShipView(cls, this.time);
    this.ships.push(ship);
    this.scene.add(ship.root, ship.wake.mesh);
    return ship;
  }

  /** Put a race's hazards in the water, or take them all out. */
  setHazards(hazards: Hazard[] | null): void {
    if (this.hazards) {
      this.scene.remove(this.hazards.group);
      disposeTree(this.hazards.group);
      this.hazards = null;
    }
    if (hazards && hazards.length) {
      this.hazards = new HazardViews(hazards);
      this.scene.add(this.hazards.group);
    }
  }

  /** Put a race's power-ups in the water, or take them all out. */
  setItems(field: ItemField | null): void {
    if (this.items) {
      this.scene.remove(this.items.group);
      disposeTree(this.items.group);
      this.items = null;
    }
    if (field) {
      this.items = new ItemViews(field);
      this.scene.add(this.items.group);
    }
  }

  /** Move hazards and power-ups to where the simulation has them, and run the effects on. */
  updateRace(hazards: Hazard[], items: ItemField | null, now: number, dt: number): void {
    this.hazards?.update(hazards, now);
    if (items) this.items?.update(items, now);
    this.effects.update(dt);
  }

  /** Show something happening to a ship. */
  showHit(event: RaceEvent): void {
    this.effects.burst(event);
  }

  clearShips(): void {
    for (const ship of this.ships) {
      this.scene.remove(ship.root, ship.wake.mesh);
      // Ship geometry and materials are shared by every ship of a class, so they are kept.
      ship.dispose();
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
