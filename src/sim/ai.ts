import { hullCircles } from './collision';
import { clamp, forward, starboard, type Helm, type ShipState } from './physics';
import type { ShipClass } from './ships';
import type { Track } from './track';

const STEER_GAIN = 2.5;
/** Share of the ship's maximum yaw rate the AI plans its corner speed around. */
const CORNER_CONFIDENCE = 0.8;
/** Deceleration the AI counts on when slowing for a bend, as a share of the ship's acceleration. */
const BRAKING = 0.7;
/** Speed astern when backing away from a ship it is touching, m/s. */
const BACK_OFF_SPEED = 6;
const STUCK_SPEED = 4;
const STUCK_AFTER = 3;
const REVERSE_FOR = 4;
const LANE_CHANGE_RATE = 60; // metres per second

/** What the AI needs to know about a ship, its own or another. */
export interface AiShip {
  state: ShipState;
  cls: ShipClass;
  /** Nearest centreline sample. */
  trackIndex: number;
  /** Samples travelled since the start line. */
  progress: number;
}

/** Hulls closer than this are treated as touching, metres. */
const CONTACT_GAP = 12;

/** Clear water between two hulls, metres. Negative when they overlap. */
function hullGap(a: AiShip, b: AiShip): number {
  const reach = (a.cls.length + b.cls.length) / 2 + CONTACT_GAP;
  if (Math.hypot(a.state.x - b.state.x, a.state.z - b.state.z) > reach) return Infinity;
  let gap = Infinity;
  for (const ca of hullCircles(a.state, a.cls)) {
    for (const cb of hullCircles(b.state, b.cls)) {
      gap = Math.min(gap, Math.hypot(ca.x - cb.x, ca.z - cb.z) - ca.r - cb.r);
    }
  }
  return gap;
}

/** Steers a ship round the course: follows a lane, slows for corners, avoids ships ahead. */
export class AiDriver {
  /** 0..1. Scales both straight-line and corner speed. */
  readonly pace: number;
  /** Preferred distance from the centreline, metres. Positive is to starboard. */
  readonly lane: number;
  private laneNow: number;
  private stuckFor = 0;
  private reversingFor = 0;

  constructor(pace: number, lane: number) {
    this.pace = pace;
    this.lane = lane;
    this.laneNow = lane;
  }

  helm(self: AiShip, track: Track, others: AiShip[], dt: number): Helm {
    const s = self.state;
    const cls = self.cls;
    const trackIndex = self.trackIndex;
    const f = forward(s.heading);
    const sb = starboard(s.heading);

    // Move over for a ship close ahead.
    let wantedLane = this.lane;
    for (const other of others) {
      const dx = other.state.x - s.x;
      const dz = other.state.z - s.z;
      const ahead = dx * f.x + dz * f.z;
      const side = dx * sb.x + dz * sb.z;
      const reach = (cls.length + other.cls.length) / 2 + 250;
      if (ahead > 0 && ahead < reach && Math.abs(side) < (cls.beam + other.cls.beam) * 1.2) {
        wantedLane = this.laneNow + (side >= 0 ? -1 : 1) * (cls.beam + other.cls.beam);
      }
    }
    const laneLimit = Math.max(0, track.halfWidth - cls.beam * 1.5);
    wantedLane = clamp(wantedLane, -laneLimit, laneLimit);
    this.laneNow += clamp(wantedLane - this.laneNow, -LANE_CHANGE_RATE * dt, LANE_CHANGE_RATE * dt);

    // Steer at a point further ahead the faster the ship is going.
    const lookAhead = 180 + Math.abs(s.u) * 3;
    const targetIndex = trackIndex + Math.round(lookAhead / track.spacing);
    const target = track.pointAt(targetIndex, this.laneNow);
    const tx = target.x - s.x;
    const tz = target.z - s.z;
    const bearing = Math.atan2(tx * sb.x + tz * sb.z, tx * f.x + tz * f.z);
    let rudder = clamp(bearing * STEER_GAIN, -1, 1);

    // Fastest speed now that still lets the ship slow down in time for every
    // bend coming up.
    const yawBudget = cls.turnRate * CORNER_CONFIDENCE;
    const scan = Math.round((200 + Math.abs(s.u) * 8) / track.spacing);
    let targetSpeed = cls.topSpeed;
    for (let i = 0; i <= scan; i++) {
      const bend = track.curvatureAt(trackIndex + i, this.laneNow);
      if (bend < 1e-6) continue;
      // Rudder authority falls off with speed, so solve for the speed at
      // which the yaw rate the ship can manage just makes the bend.
      const cornerSpeed = yawBudget / bend / (1 + (0.3 * yawBudget) / (bend * cls.topSpeed));
      const distance = i * track.spacing;
      const reachable = Math.sqrt(cornerSpeed * cornerSpeed + 2 * BRAKING * cls.accel * distance);
      targetSpeed = Math.min(targetSpeed, reachable);
    }
    targetSpeed *= this.pace;

    let backOff = false;
    for (const other of others) {
      const dx = other.state.x - s.x;
      const dz = other.state.z - s.z;
      const ahead = dx * f.x + dz * f.z;
      const side = dx * sb.x + dz * sb.z;
      const gap = ahead - (cls.length + other.cls.length) / 2;
      const closing = Math.max(0, s.u - other.state.u);
      const beams = (cls.beam + other.cls.beam) / 2;

      // Sit behind a ship that is in the way rather than ram it.
      if (gap > -20 && gap < 60 + closing * 8 && Math.abs(side) < beams * 1.4) {
        targetSpeed = Math.min(targetSpeed, Math.max(10, other.state.u - 2));
      }
      // When hulls touch, whichever ship is behind in the race backs away
      // and steers clear, so ships never stay locked together.
      if (other.progress > self.progress && ahead > 0 && hullGap(self, other) < CONTACT_GAP) {
        backOff = true;
        this.laneNow += (side >= 0 ? -1 : 1) * LANE_CHANGE_RATE * dt;
      }
    }

    let throttle: number;
    if (backOff) throttle = s.u > -BACK_OFF_SPEED ? -1 : 0;
    else if (s.u < targetSpeed - 2) throttle = this.pace * this.pace;
    else if (s.u > targetSpeed + 5) throttle = -0.7;
    else throttle = Math.min(1, (targetSpeed / cls.topSpeed) ** 2);

    // Back off whatever the ship has run into.
    if (this.reversingFor > 0) {
      this.reversingFor -= dt;
      throttle = -1;
      rudder = -rudder;
    } else if (Math.abs(s.u) < STUCK_SPEED && s.throttle > 0.5) {
      this.stuckFor += dt;
      if (this.stuckFor > STUCK_AFTER) {
        this.stuckFor = 0;
        this.reversingFor = REVERSE_FOR;
      }
    } else {
      this.stuckFor = 0;
    }

    return { throttle, rudder };
  }
}
