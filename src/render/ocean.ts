import * as THREE from 'three';
import type { Obstacle } from '../sim/track';
import { NOISE_GLSL, SKY_GLSL, skyUniforms, type Atmosphere } from './sky';

const OCEAN_SIZE = 60000;
const SHORE_TEXTURE_SIZE = 2048;
/** How far the shallows reach out from the shore, metres. */
const SHALLOWS = 120;
/** Width of the band of breaking surf at the waterline, metres. */
const SURF = 16;

export interface ShoreMap {
  texture: THREE.Texture;
  /** minX, minZ, 1 / width, 1 / depth of the area the texture covers. */
  rect: THREE.Vector4;
}

/** Bakes how close each patch of water is to land, for shallows and surf. */
export function createShoreMap(obstacles: Obstacle[]): ShoreMap {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const o of obstacles) {
    minX = Math.min(minX, o.x - o.r - SHALLOWS);
    maxX = Math.max(maxX, o.x + o.r + SHALLOWS);
    minZ = Math.min(minZ, o.z - o.r - SHALLOWS);
    maxZ = Math.max(maxZ, o.z + o.r + SHALLOWS);
  }
  const pad = 50;
  minX -= pad;
  minZ -= pad;
  const width = maxX - minX + pad;
  const depth = maxZ - minZ + pad;

  const canvas = document.createElement('canvas');
  canvas.width = SHORE_TEXTURE_SIZE;
  canvas.height = SHORE_TEXTURE_SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'lighten';
  const sx = canvas.width / width;
  const sz = canvas.height / depth;
  // Red holds the shallows and green the surf line. "Lighten" keeps the
  // strongest value per channel where obstacles overlap.
  const ring = (o: Obstacle, inner: number, outer: number, color: string): void => {
    ctx.save();
    ctx.translate((o.x - minX) * sx, (o.z - minZ) * sz);
    ctx.scale(sx, sz);
    const gradient = ctx.createRadialGradient(0, 0, inner, 0, 0, outer);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, '#000');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, outer, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };
  for (const o of obstacles) {
    ring(o, o.r * 0.9, o.r + SHALLOWS, '#f00');
    ring(o, o.r * 0.9, o.r * 0.9 + SURF, '#0f0');
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return { texture, rect: new THREE.Vector4(minX, minZ, 1 / width, 1 / depth) };
}

export function createOcean(
  atmosphere: Atmosphere,
  shore: ShoreMap,
  time: THREE.IUniform<number>,
): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      ...skyUniforms(atmosphere),
      uTime: time,
      uDeep: { value: atmosphere.waterDeep },
      uShallow: { value: atmosphere.waterShallow },
      uSunIntensity: { value: atmosphere.sunIntensity },
      uFogDensity: { value: atmosphere.fogDensity },
      uShore: { value: shore.texture },
      uShoreRect: { value: shore.rect },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      uniform float uTime;
      uniform vec3 uDeep;
      uniform vec3 uShallow;
      uniform float uSunIntensity;
      uniform float uFogDensity;
      uniform sampler2D uShore;
      uniform vec4 uShoreRect;
      ${SKY_GLSL}
      ${NOISE_GLSL}

      // Value noise with its gradient: x is the value, yz the slope.
      vec3 noised(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
        vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
        float a = hash21(i);
        float b = hash21(i + vec2(1.0, 0.0));
        float c = hash21(i + vec2(0.0, 1.0));
        float d = hash21(i + vec2(1.0, 1.0));
        return vec3(
          a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y,
          du * (vec2(b - a, c - a) + (a - b - c + d) * u.yx));
      }

      // Slope of a long travelling swell.
      vec2 swell(vec2 p, vec2 dir, float wavelength, float steepness) {
        float k = 6.28318 / wavelength;
        return dir * (steepness * cos(dot(dir, p) * k + uTime * sqrt(9.81 * k) * 1.6));
      }

      // Slope of the sea surface: two swells plus wind chop at many scales.
      // Small waves fade with distance so the far ocean does not shimmer.
      vec2 seaSlope(vec2 p, float dist, out float crest) {
        vec2 warp = 30.0 * vec2(vnoise(p * 0.004 + 3.0), vnoise(p * 0.004 + 11.0));
        vec2 g = swell(p + warp, vec2(0.83, 0.56), 260.0, 0.035);
        g += swell(p - warp, vec2(0.35, 0.94), 140.0, 0.03);

        const mat2 turn = mat2(0.80, 0.60, -0.60, 0.80);
        vec2 wind = vec2(0.8, 0.6);
        vec2 q = p;
        float wavelength = 95.0;
        float steepness = 0.13;
        crest = 0.0;
        for (int i = 0; i < 7; i++) {
          float fade = clamp(wavelength * 110.0 / dist, 0.0, 1.0);
          vec3 n = noised(q / wavelength + wind * uTime * (0.55 / sqrt(wavelength)) * 2.2);
          g += n.yz * steepness * fade;
          crest += (n.x - 0.5) * fade * steepness;
          q = turn * q + vec2(31.7, 17.3);
          wind = turn * wind;
          wavelength *= 0.52;
          steepness *= 0.84;
        }
        return g;
      }

      void main() {
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        float crest;
        vec2 g = seaSlope(vWorld.xz, dist, crest);
        vec3 N = normalize(vec3(-g.x, 1.0, -g.y));

        vec2 shoreUv = (vWorld.xz - uShoreRect.xy) * uShoreRect.zw;
        vec2 shoreSample = texture2D(uShore, shoreUv).rg;
        shoreSample *= step(0.0, shoreUv.x) * step(shoreUv.x, 1.0) * step(0.0, shoreUv.y) * step(shoreUv.y, 1.0);
        float shore = shoreSample.r;

        float shallow = smoothstep(0.15, 0.95, shore);
        vec3 body = mix(uDeep, uShallow, shallow);
        float sunUp = clamp(uSunDir.y * 2.0 + 0.3, 0.3, 1.0);
        float diffuse = clamp(dot(N, uSunDir), 0.0, 1.0);
        vec3 water = body * (0.35 + 0.65 * diffuse) * sunUp;
        // Light scattered back out of the wave crests.
        water += uShallow * 0.07 * smoothstep(0.0, 0.3, crest) * sunUp;

        vec3 R = reflect(-V, N);
        R.y = abs(R.y);
        float fresnel = 0.02 + 0.98 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
        vec3 color = mix(water, skyColor(R), fresnel);

        float glint = pow(max(dot(R, uSunDir), 0.0), 700.0);
        float glow = pow(max(dot(R, uSunDir), 0.0), 40.0);
        color += uSunColor * (glint * 1.6 + glow * 0.035) * uSunIntensity;

        // Surf where the water meets the land.
        float surfNoise = fbm(vWorld.xz * 0.06 + vec2(uTime * 0.25, 0.0));
        // A band of foam that washes in and out at the waterline. Water
        // enclosed by land stays calm.
        float wash = shoreSample.g + 0.18 * sin(uTime * 0.8 + surfNoise * 8.0);
        float surf = smoothstep(0.25, 0.6, wash) * (1.0 - smoothstep(0.9, 1.0, shoreSample.g));
        surf *= smoothstep(0.25, 0.6, surfNoise + 0.2);
        color = mix(color, vec3(0.93, 0.97, 1.0) * (0.5 + 0.5 * sunUp), surf * 0.85);

        vec3 flatView = normalize(vec3(-V.x, 0.02, -V.z));
        float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
        color = mix(color, skyColor(flatView), fog);

        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const geometry = new THREE.PlaneGeometry(OCEAN_SIZE, OCEAN_SIZE);
  geometry.rotateX(-Math.PI / 2);
  const ocean = new THREE.Mesh(geometry, material);
  ocean.frustumCulled = false;
  ocean.renderOrder = -5;
  return ocean;
}
