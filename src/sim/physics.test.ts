import { describe, expect, it } from 'vitest';
import { createShipState, stepShip, type Helm } from './physics';
import { SHIP_CLASSES, shipClassById } from './ships';

const DT = 1 / 60;

function run(cls = shipClassById('quantum'), helm: Helm, seconds: number, state = createShipState()) {
  for (let i = 0; i < seconds * 60; i++) stepShip(state, helm, cls, DT);
  return state;
}

describe('stepShip', () => {
  it('settles at the class top speed at full ahead', () => {
    for (const cls of SHIP_CLASSES) {
      const s = run(cls, { throttle: 1, rudder: 0 }, 120);
      expect(s.u).toBeGreaterThan(cls.topSpeed * 0.98);
      expect(s.u).toBeLessThanOrEqual(cls.topSpeed * 1.001);
    }
  });

  it('sails straight along the heading with the rudder centred', () => {
    const s = run(undefined, { throttle: 1, rudder: 0 }, 20, createShipState(0, 0, Math.PI / 2));
    expect(s.x).toBeGreaterThan(500);
    expect(Math.abs(s.z)).toBeLessThan(1e-6);
    expect(s.v).toBeCloseTo(0, 6);
  });

  it('turns to starboard on positive rudder, which decreases heading', () => {
    const s = run(undefined, { throttle: 1, rudder: 0 }, 30);
    run(undefined, { throttle: 1, rudder: 1 }, 5, s);
    expect(s.heading).toBeLessThan(-0.3);
    expect(s.r).toBeGreaterThan(0);
  });

  it('loses speed and slides sideways in a hard turn', () => {
    const cls = shipClassById('icon');
    const s = run(cls, { throttle: 1, rudder: 0 }, 120);
    const straightSpeed = s.u;
    run(cls, { throttle: 1, rudder: 1 }, 15, s);
    expect(s.u).toBeLessThan(straightSpeed * 0.85);
    expect(Math.abs(s.v)).toBeGreaterThan(1);
  });

  it('cannot steer when stopped with engines at rest', () => {
    const s = run(undefined, { throttle: 0, rudder: 1 }, 10);
    expect(s.heading).toBe(0);
  });

  it('keeps turning briefly after the helm is centred', () => {
    const cls = shipClassById('icon');
    const s = run(cls, { throttle: 1, rudder: 0 }, 60);
    run(cls, { throttle: 1, rudder: 1 }, 6, s);
    const headingAtRelease = s.heading;
    run(cls, { throttle: 1, rudder: 0 }, 3, s);
    expect(s.heading).toBeLessThan(headingAtRelease - 0.03);
  });

  it('goes astern more slowly than ahead', () => {
    const cls = shipClassById('quantum');
    const s = run(cls, { throttle: -1, rudder: 0 }, 120);
    expect(s.u).toBeLessThan(0);
    expect(-s.u).toBeLessThan(cls.topSpeed * 0.8);
  });

  it('is slowed by extra drag off course', () => {
    const cls = shipClassById('quantum');
    const s = createShipState();
    for (let i = 0; i < 120 * 60; i++) stepShip(s, { throttle: 1, rudder: 0 }, cls, DT, 5);
    expect(s.u).toBeLessThan(cls.topSpeed * 0.5);
  });

  it('gives each class the character in the design', () => {
    const turnCircle = (id: Parameters<typeof shipClassById>[0]) => {
      const cls = shipClassById(id);
      const s = run(cls, { throttle: 1, rudder: 0 }, 60);
      run(cls, { throttle: 1, rudder: 1 }, 20, s);
      return s.u / s.r;
    };
    const timeTo50 = (id: Parameters<typeof shipClassById>[0]) => {
      const cls = shipClassById(id);
      const s = createShipState();
      let t = 0;
      while (s.u < 50 && t < 120) {
        stepShip(s, { throttle: 1, rudder: 0 }, cls, DT);
        t += DT;
      }
      return t;
    };
    expect(turnCircle('radiance')).toBeLessThan(turnCircle('quantum'));
    expect(turnCircle('quantum')).toBeLessThan(turnCircle('icon'));
    expect(timeTo50('freedom')).toBeLessThan(timeTo50('icon'));
    expect(shipClassById('icon').topSpeed).toBeGreaterThan(shipClassById('radiance').topSpeed);
  });
});
