import * as THREE from 'three';
import type { ShipClass } from '../sim/ships';
import { NOISE_GLSL } from './sky';

const MAX_POINTS = 150;
const POINT_SPACING = 14; // metres travelled between trail points
const LIFETIME = 32; // seconds
const SPREAD_SPEED = 2.4; // metres per second each side

interface TrailPoint {
  x: number;
  z: number;
  /** Unit vector across the wake. */
  nx: number;
  nz: number;
  born: number;
  strength: number;
}

let sharedMaterial: THREE.ShaderMaterial | null = null;

function wakeMaterial(time: THREE.IUniform<number>): THREE.ShaderMaterial {
  if (sharedMaterial) {
    sharedMaterial.uniforms.uTime = time;
    return sharedMaterial;
  }
  sharedMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    uniforms: { uTime: time },
    vertexShader: /* glsl */ `
      attribute vec3 trail; // across (0..1), age (0..1), strength
      varying vec3 vTrail;
      varying vec2 vWorld;
      void main() {
        vTrail = trail;
        vWorld = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vTrail;
      varying vec2 vWorld;
      uniform float uTime;
      ${NOISE_GLSL}
      void main() {
        float across = abs(vTrail.x * 2.0 - 1.0);
        float age = vTrail.y;
        float fresh = 1.0 - age;
        float churn = fbm(vWorld * 0.05 + vec2(0.0, uTime * 0.12));
        float fine = fbm(vWorld * 0.24 - vec2(uTime * 0.2, 0.0));

        // Bow wave arms along the edges of the wake.
        float arms = smoothstep(0.70, 0.86, across) * (1.0 - smoothstep(0.9, 1.0, across));
        arms *= fresh * smoothstep(0.2, 0.55, churn * 0.5 + fine * 0.5 + fresh * 0.3);

        // Churned white water from the propellers down the middle, breaking
        // up into streaks as it ages.
        float core = 1.0 - smoothstep(0.08, 0.5, across);
        float threshold = 1.1 - fresh * 1.15;
        float breakup = smoothstep(threshold, threshold + 0.3, churn * 0.55 + fine * 0.6);
        float wash = core * breakup * smoothstep(0.0, 0.2, fresh);

        // Smoothed, aerated water between the arms.
        float slick = (1.0 - smoothstep(0.4, 0.95, across)) * fresh * fresh * 0.22;

        float foam = clamp(arms * 0.8 + wash, 0.0, 1.0);
        float alpha = clamp(foam + slick, 0.0, 1.0) * vTrail.z;
        gl_FragColor = vec4(mix(vec3(0.45, 0.80, 0.86), vec3(0.96, 0.99, 1.0), foam), alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  return sharedMaterial;
}

/** Foam trail behind one ship. */
export class Wake {
  readonly mesh: THREE.Mesh;
  private readonly points: TrailPoint[] = [];
  private readonly positions: Float32Array;
  private readonly trail: Float32Array;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly halfBeam: number;
  private readonly lead: number;

  constructor(cls: ShipClass, time: THREE.IUniform<number>) {
    this.halfBeam = cls.beam * 0.5;
    this.lead = cls.length * 0.36;
    const vertices = (MAX_POINTS + 1) * 2;
    this.positions = new Float32Array(vertices * 3);
    this.trail = new Float32Array(vertices * 3);
    const indices: number[] = [];
    for (let i = 0; i < MAX_POINTS; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('trail', new THREE.BufferAttribute(this.trail, 3));
    this.geometry.setIndex(indices);
    this.mesh = new THREE.Mesh(this.geometry, wakeMaterial(time));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -4;
  }

  /** Call every frame with the ship's position, heading, speed and the clock. */
  update(x: number, z: number, heading: number, speed: number, now: number): void {
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    // The wake starts at the bow shoulder, where the bow wave peels off.
    const head: TrailPoint = {
      x: x + fx * this.lead,
      z: z + fz * this.lead,
      nx: fz,
      nz: -fx,
      born: now,
      strength: THREE.MathUtils.clamp(Math.abs(speed) / 22, 0, 1),
    };

    const newest = this.points[0];
    if (!newest || Math.hypot(head.x - newest.x, head.z - newest.z) > POINT_SPACING) {
      this.points.unshift(head);
      if (this.points.length > MAX_POINTS) this.points.pop();
    }
    while (this.points.length > 0 && now - this.points[this.points.length - 1].born > LIFETIME) {
      this.points.pop();
    }

    let v = 0;
    const write = (p: TrailPoint): void => {
      const age = now - p.born;
      const half = this.halfBeam * 1.05 + age * SPREAD_SPEED;
      const t = Math.min(1, age / LIFETIME);
      for (const side of [0, 1]) {
        const sign = side ? 1 : -1;
        this.positions[v * 3] = p.x + p.nx * half * sign;
        this.positions[v * 3 + 1] = 0.35;
        this.positions[v * 3 + 2] = p.z + p.nz * half * sign;
        this.trail[v * 3] = side;
        this.trail[v * 3 + 1] = t;
        this.trail[v * 3 + 2] = p.strength;
        v++;
      }
    };
    write(head);
    for (const p of this.points) write(p);

    this.geometry.setDrawRange(0, Math.max(0, this.points.length) * 6);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.trail.needsUpdate = true;
  }

  reset(): void {
    this.points.length = 0;
    this.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.geometry.dispose();
  }
}
