import type { ShipClass } from './ships';

export interface Vec2 {
  x: number;
  z: number;
}

/**
 * Ship motion on the water plane.
 * Heading h: forward is (sin h, cos h); starboard is (-cos h, sin h).
 * A turn to starboard decreases h.
 */
export interface ShipState {
  x: number;
  z: number;
  heading: number;
  /** Speed along the heading, m/s. Negative when going astern. */
  u: number;
  /** Sideways slide, m/s. Positive to starboard. */
  v: number;
  /** Yaw rate, rad/s. Positive turns to starboard. */
  r: number;
  /** Actual engine setting, -1..1. Lags the commanded value. */
  throttle: number;
  /** Actual rudder angle, -1..1. Positive is starboard. */
  rudder: number;
}

/** What the helm is asking for. */
export interface Helm {
  /** -1 full astern .. 1 full ahead. */
  throttle: number;
  /** -1 hard to port .. 1 hard to starboard. */
  rudder: number;
}

const THROTTLE_RATE = 0.9; // full range change per second
const RUDDER_RATE = 1.8;
const ASTERN_POWER = 0.5;
/** Extra hull drag at full rudder, as a fraction of normal drag. */
const RUDDER_DRAG = 0.9;
/** Fraction of top speed at which the rudder reaches full authority. */
const FULL_AUTHORITY_SPEED = 0.25;
/** Loss of rudder authority at top speed. */
const HIGH_SPEED_AUTHORITY_LOSS = 0.3;
/** Steering available from the pods alone when barely moving. */
const POD_AUTHORITY = 0.2;

export function forward(heading: number): Vec2 {
  return { x: Math.sin(heading), z: Math.cos(heading) };
}

export function starboard(heading: number): Vec2 {
  return { x: -Math.cos(heading), z: Math.sin(heading) };
}

export function createShipState(x = 0, z = 0, heading = 0): ShipState {
  return { x, z, heading, u: 0, v: 0, r: 0, throttle: 0, rudder: 0 };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function approach(current: number, target: number, maxStep: number): number {
  return current + clamp(target - current, -maxStep, maxStep);
}

/**
 * Advance one ship by dt seconds.
 * dragScale multiplies hull drag: above 1 off course, below 1 in a slipstream.
 */
export function stepShip(
  s: ShipState,
  helm: Helm,
  cls: ShipClass,
  dt: number,
  dragScale = 1,
): void {
  s.throttle = approach(s.throttle, clamp(helm.throttle, -1, 1), THROTTLE_RATE * dt);
  s.rudder = approach(s.rudder, clamp(helm.rudder, -1, 1), RUDDER_RATE * dt);

  // Rudder authority depends on water flow over the hull. The pods give a
  // little steering at a standstill when they are pushing.
  const speedFraction = Math.abs(s.u) / cls.topSpeed;
  const flowAuthority =
    Math.min(1, speedFraction / FULL_AUTHORITY_SPEED) *
    (1 - HIGH_SPEED_AUTHORITY_LOSS * Math.min(1, speedFraction));
  const podAuthority = POD_AUTHORITY * Math.abs(s.throttle);
  const direction = Math.abs(s.u) > 1 ? Math.sign(s.u) : Math.sign(s.throttle);
  const authority = Math.max(flowAuthority, podAuthority) * direction;

  const targetYawRate = s.rudder * cls.turnRate * authority;
  s.r += (targetYawRate - s.r) * (1 - Math.exp(-cls.yawResponse * dt));

  // Momentum carries on in the old direction when the hull rotates, so
  // forward speed turns into sideways slide.
  const f0 = forward(s.heading);
  const s0 = starboard(s.heading);
  const vx = f0.x * s.u + s0.x * s.v;
  const vz = f0.z * s.u + s0.z * s.v;
  s.heading -= s.r * dt;
  const f1 = forward(s.heading);
  const s1 = starboard(s.heading);
  s.u = vx * f1.x + vz * f1.z;
  s.v = vx * s1.x + vz * s1.z;

  const dragCoefficient = cls.accel / (cls.topSpeed * cls.topSpeed);
  const thrust = s.throttle >= 0 ? s.throttle * cls.accel : s.throttle * cls.accel * ASTERN_POWER;
  const drag =
    dragCoefficient * dragScale * s.u * Math.abs(s.u) * (1 + RUDDER_DRAG * Math.abs(s.rudder));
  s.u += (thrust - drag) * dt;
  s.v *= Math.exp(-cls.grip * dt);

  s.x += (f1.x * s.u + s1.x * s.v) * dt;
  s.z += (f1.z * s.u + s1.z * s.v) * dt;
}
