import * as THREE from 'three';
import type { TrackTheme } from '../sim/track';

export interface Atmosphere {
  zenith: THREE.Color;
  horizon: THREE.Color;
  sunColor: THREE.Color;
  /** Unit vector pointing at the sun. */
  sunDir: THREE.Vector3;
  sunIntensity: number;
  waterDeep: THREE.Color;
  waterShallow: THREE.Color;
  fogDensity: number;
  cloudCover: number;
}

function sunDirection(elevationDeg: number, azimuthDeg: number): THREE.Vector3 {
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
}

export function atmosphereFor(theme: TrackTheme): Atmosphere {
  switch (theme) {
    case 'tropical':
      return {
        zenith: new THREE.Color('#1f5fc0'),
        horizon: new THREE.Color('#9fd4f7'),
        sunColor: new THREE.Color('#fff4dc'),
        sunDir: sunDirection(48, 140),
        sunIntensity: 3.2,
        waterDeep: new THREE.Color('#052f52'),
        waterShallow: new THREE.Color('#1fb8b4'),
        fogDensity: 0.00007,
        cloudCover: 0.42,
      };
    case 'harbour':
      return {
        zenith: new THREE.Color('#4474b4'),
        horizon: new THREE.Color('#f2dcc6'),
        sunColor: new THREE.Color('#ffe7cc'),
        sunDir: sunDirection(25, 250),
        sunIntensity: 2.8,
        waterDeep: new THREE.Color('#0c2e45'),
        waterShallow: new THREE.Color('#2a6f78'),
        fogDensity: 0.00009,
        cloudCover: 0.5,
      };
    case 'fjord':
      return {
        zenith: new THREE.Color('#3f76ad'),
        horizon: new THREE.Color('#cbd9e2'),
        sunColor: new THREE.Color('#fff1e0'),
        sunDir: sunDirection(30, 20),
        sunIntensity: 2.6,
        waterDeep: new THREE.Color('#06282f'),
        waterShallow: new THREE.Color('#1c5b5e'),
        fogDensity: 0.00008,
        cloudCover: 0.55,
      };
  }
}

/** Sky colour for a view direction. Shared by the sky dome and the ocean reflections. */
export const SKY_GLSL = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;

vec3 skyColor(vec3 d) {
  float h = clamp(d.y, 0.0, 1.0);
  vec3 c = mix(uHorizon, uZenith, 1.0 - exp(-h * 4.5));
  float s = max(dot(d, uSunDir), 0.0);
  c += uSunColor * (pow(s, 6.0) * 0.10 + pow(s, 48.0) * 0.30);
  return c;
}
`;

export const NOISE_GLSL = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
    f.y);
}
float fbm(vec2 p) {
  float a = 0.5;
  float v = 0.0;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return v;
}
`;

export function skyUniforms(atmosphere: Atmosphere): Record<string, THREE.IUniform> {
  return {
    uZenith: { value: atmosphere.zenith },
    uHorizon: { value: atmosphere.horizon },
    uSunColor: { value: atmosphere.sunColor },
    uSunDir: { value: atmosphere.sunDir },
  };
}

const SKY_RADIUS = 30000;

export function createSkyDome(atmosphere: Atmosphere, time: THREE.IUniform<number>): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      ...skyUniforms(atmosphere),
      uTime: time,
      uCloudCover: { value: atmosphere.cloudCover },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform float uTime;
      uniform float uCloudCover;
      ${SKY_GLSL}
      ${NOISE_GLSL}
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = skyColor(d);
        float s = max(dot(d, uSunDir), 0.0);
        c += uSunColor * smoothstep(0.99955, 0.9998, s) * 8.0;

        // Flat cloud layer, thinning out towards the horizon.
        if (d.y > 0.0) {
          vec2 uv = d.xz / (d.y + 0.12) * 1.3 + vec2(uTime * 0.004, uTime * 0.0015);
          float n = fbm(uv) * 0.7 + fbm(uv * 2.7 + 4.0) * 0.3;
          float cloud = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.28, n);
          float lit = 0.75 + 0.25 * fbm(uv * 3.0 + uSunDir.xz * 0.6);
          vec3 cloudColor = mix(uHorizon, vec3(1.0), 0.6) * lit + uSunColor * 0.12 * pow(s, 4.0);
          c = mix(c, cloudColor, cloud * smoothstep(0.02, 0.22, d.y) * 0.9);
        }
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 48, 24), material);
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  return dome;
}
