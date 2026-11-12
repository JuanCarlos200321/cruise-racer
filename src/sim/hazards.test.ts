import { describe, expect, it } from 'vitest';
import { HazardField, WHALE_ROUTINE, WHALE_SLAP_AT, WHALE_TAIL, type Hazard, type HazardTarget } from './hazards';
import { createShipState } from './physics';
import { Race } from './race';
import { SHIP_CLASSES } from './ships';
import { Track, TRACKS, type HazardKind } from './track';

const DT = 1 / 60;
const cls = SHIP_CLASSES[2];

function trackWith(...hazards: HazardKind[]): Track {
  return new Track({ ...TRACKS[0], hazards });
}

/** A ship on the route at a sample, heading along it at a share of top speed. */
function shipAt(track: Track, index: number, lateral: number, speed: number): HazardTarget {
  const p = track.pointAt(index, lateral);
  const state = createShipState(p.x, p.z, track.headingAt(index));
  state.u = cls.topSpeed * speed;
  return { id: 0, state, cls, shield: 0 };
}

function only(field: HazardField): Hazard {
  expect(field.hazards).toHaveLength(1);
  return field.hazards[0];
}

describe('HazardField', () => {
  it('spreads the hazards of a route between the start and the finish, inside the channel', () => {
    for (const def of TRACKS) {
      const track = new Track(def);
      const field = new HazardField(track);
      expect(field.hazards.map((h) => h.kind)).toEqual(def.hazards);
      let last = track.startIndex + 1000 / track.spacing;
      for (const h of field.hazards) {
        if (h.kind !== 'wave') {
          expect(h.index).toBeGreaterThan(last);
          last = h.index + 800 / track.spacing;
        }
        expect(h.index).toBeLessThan(track.finishIndex);
        // There is always a way round.
        expect(track.halfWidth + Math.abs(h.lateral) - h.r).toBeGreaterThan(cls.beam * 4);
      }
    }
  });

  it('sharks hold a ship back while it is among them', () => {
    const track = trackWith('sharks');
    const field = new HazardField(track);
    const h = only(field);
    const ship = shipAt(track, h.index, h.lateral, 1);
    const events = field.step(DT, [ship]);
    expect(events.map((e) => e.kind)).toEqual(['sharks']);
    for (let i = 0; i < 120; i++) expect(field.step(DT, [ship])).toHaveLength(0);
    expect(ship.state.u).toBeLessThan(cls.topSpeed * 0.5);
    expect(ship.state.u).toBeGreaterThan(cls.topSpeed * 0.35);
  });

  it('sharks leave a ship alone that passes clear of them', () => {
    const track = trackWith('sharks');
    const field = new HazardField(track);
    const h = only(field);
    const ship = shipAt(track, h.index, h.lateral + h.r + cls.beam * 2, 1);
    expect(field.step(DT, [ship])).toHaveLength(0);
    expect(ship.state.u).toBe(cls.topSpeed);
  });

  it('a kraken stops a ship dead, then lets it go', () => {
    const track = trackWith('kraken');
    const field = new HazardField(track);
    const h = only(field);
    const ship = shipAt(track, h.index, h.lateral, 1);
    expect(field.step(DT, [ship])[0]).toMatchObject({ kind: 'kraken', shipId: 0 });
    expect(field.isHeld(0)).toBe(true);
    for (let i = 0; i < 3 * 60; i++) field.step(DT, [ship]);
    expect(ship.state.u).toBeLessThan(1);
    for (let i = 0; i < 60; i++) field.step(DT, [ship]);
    expect(field.isHeld(0)).toBe(false);
    // It does not grab the same ship again straight away.
    ship.state.u = 20;
    expect(field.step(DT, [ship])).toHaveLength(0);
    expect(ship.state.u).toBe(20);
  });

  it('a rogue wave runs down the route against the ships and comes round again', () => {
    const track = trackWith('wave');
    const field = new HazardField(track);
    const h = only(field);
    const before = h.index;
    const side = Math.sign(h.lateral);
    for (let i = 0; i < 10 * 60; i++) field.step(DT, []);
    expect(h.index).toBeLessThan(before);
    let flipped = false;
    for (let i = 0; i < 120 * 60 && !flipped; i++) {
      field.step(DT, []);
      flipped = Math.sign(h.lateral) === -side;
    }
    expect(flipped).toBe(true);
  });

  function meetWave(speed: number, turn = 0): { ship: HazardTarget; heavy: boolean } {
    const track = trackWith('wave');
    const field = new HazardField(track);
    const h = only(field);
    for (let i = 0; i < 20 * 60 && h.strength < 1; i++) field.step(DT, []);
    const ship = shipAt(track, h.index, h.lateral, speed);
    ship.state.heading += turn;
    const events = field.step(DT, [ship]);
    expect(events).toHaveLength(1);
    return { ship, heavy: events[0].heavy };
  }

  it('a wave taken bow-on at low speed costs little', () => {
    const { ship, heavy } = meetWave(0.5);
    expect(heavy).toBe(false);
    expect(ship.state.u).toBeGreaterThan(cls.topSpeed * 0.45);
  });

  it('a wave taken at full speed slams the ship', () => {
    const { ship, heavy } = meetWave(1);
    expect(heavy).toBe(true);
    expect(ship.state.u).toBeLessThan(cls.topSpeed * 0.3);
  });

  it('a wave taken on the beam knocks the ship sideways', () => {
    const { ship, heavy } = meetWave(0.5, Math.PI / 2);
    expect(heavy).toBe(true);
    expect(Math.abs(ship.state.v)).toBeGreaterThan(10);
  });

  it('a wave misses a ship that goes round the end of it', () => {
    const track = trackWith('wave');
    const field = new HazardField(track);
    const h = only(field);
    for (let i = 0; i < 20 * 60 && h.strength < 1; i++) field.step(DT, []);
    const ship = shipAt(track, h.index, h.lateral - Math.sign(h.lateral) * (h.r + 30), 1);
    expect(field.step(DT, [ship])).toHaveLength(0);
  });

  it('a pirate ship fires on a ship in range, then has to reload', () => {
    const track = trackWith('pirate');
    const field = new HazardField(track);
    const h = only(field);
    const ship = shipAt(track, h.index, h.lateral - Math.sign(h.lateral) * 200, 1);
    const far = { ...shipAt(track, h.index + 60, 0, 1), id: 1 };
    const events = field.step(DT, [ship, far]);
    expect(events.map((e) => e.shipId)).toEqual([0]);
    expect(ship.state.u).toBeLessThan(cls.topSpeed * 0.8);
    expect(far.state.u).toBe(cls.topSpeed);
    expect(field.step(DT, [ship, far])).toHaveLength(0);
    expect(field.solids()).toHaveLength(1);
  });

  it('a pirate ship keeps moving, inside the channel', () => {
    const track = trackWith('pirate');
    const field = new HazardField(track);
    const h = only(field);
    const start = { x: h.x, z: h.z };
    let moved = 0;
    for (let i = 0; i < 60 * 60; i++) {
      field.step(DT, []);
      moved = Math.max(moved, Math.hypot(h.x - start.x, h.z - start.z));
      expect(track.distanceToCentreline(h.x, h.z)).toBeLessThan(track.halfWidth * 0.8);
    }
    expect(moved).toBeGreaterThan(120);
  });
});

describe('whale crossing', () => {
  /** Step a whale until it is on the surface and about to bring its tail down. */
  function whaleAboutToSlap(): { track: Track; field: HazardField; h: Hazard } {
    const track = trackWith('whale');
    const field = new HazardField(track);
    const h = only(field);
    for (let i = 0; i < 300 * 60; i++) {
      if (h.strength === 1 && h.cycle < WHALE_SLAP_AT && h.cycle > WHALE_SLAP_AT - 0.01) return { track, field, h };
      field.step(DT, []);
    }
    throw new Error('The whale never slapped its tail on the surface');
  }

  it('swims from side to side across the channel, diving to turn at the edges', () => {
    const track = trackWith('whale');
    const field = new HazardField(track);
    const h = only(field);
    let min = Infinity;
    let max = -Infinity;
    let dived = false;
    let surfaced = false;
    for (let i = 0; i < 240 * 60; i++) {
      field.step(DT, []);
      min = Math.min(min, h.lateral);
      max = Math.max(max, h.lateral);
      dived ||= h.strength === 0;
      surfaced ||= h.strength === 1;
    }
    expect(min).toBeLessThan(-track.halfWidth * 0.6);
    expect(max).toBeGreaterThan(track.halfWidth * 0.6);
    expect(Math.max(-min, max)).toBeLessThan(track.halfWidth);
    expect(dived).toBe(true);
    expect(surfaced).toBe(true);
  });

  it('brings its tail down once in each routine, where anyone can see it', () => {
    const { field } = whaleAboutToSlap();
    const events = [];
    for (let i = 0; i < WHALE_ROUTINE * 60 - 30; i++) events.push(...field.step(DT, []));
    expect(events.map((e) => e.kind)).toEqual(['splash']);
    expect(events[0].shipId).toBe(-1);
  });

  it('soaks and slows a ship near the tail when it comes down', () => {
    const { track, field, h } = whaleAboutToSlap();
    const ship = shipAt(track, h.index, h.lateral, 1);
    // Put the ship beside the tail, clear of the body.
    const back = { x: -Math.sin(h.heading), z: -Math.cos(h.heading) };
    const side = { x: -back.z, z: back.x };
    ship.state.x = h.x + back.x * h.r * WHALE_TAIL + side.x * 80;
    ship.state.z = h.z + back.z * h.r * WHALE_TAIL + side.z * 80;
    ship.state.heading = h.heading;
    const events = [];
    for (let i = 0; i < 60 && events.length === 0; i++) events.push(...field.step(DT, [ship]));
    expect(events.map((e) => e.kind)).toEqual(['splash', 'whale']);
    expect(events[1].heavy).toBe(false);
    expect(ship.state.u).toBeLessThan(cls.topSpeed * 0.8);
  });

  it('stops a ship that runs into it, and does real damage', () => {
    const track = trackWith('whale');
    const field = new HazardField(track);
    const h = only(field);
    for (let i = 0; i < 300 * 60 && !(h.strength === 1 && h.cycle > 0.1 && h.cycle < 0.3); i++) field.step(DT, []);
    const ship = shipAt(track, h.index, h.lateral, 1);
    const events = field.step(DT, [ship]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'whale', heavy: true });
    expect(ship.state.u).toBeLessThan(cls.topSpeed * 0.5);
    expect(field.step(DT, [ship])).toHaveLength(0);
  });

  it('leaves a ship alone while it is under water', () => {
    const track = trackWith('whale');
    const field = new HazardField(track);
    const h = only(field);
    for (let i = 0; i < 300 * 60 && h.strength > 0.2; i++) field.step(DT, []);
    expect(h.strength).toBeLessThanOrEqual(0.2);
    const ship = shipAt(track, h.index, h.lateral, 1);
    expect(field.step(DT, [ship]).filter((e) => e.shipId === 0)).toHaveLength(0);
  });
});

describe('shields', () => {
  it('a shield takes one hit and is used up', () => {
    const track = trackWith('kraken');
    const field = new HazardField(track);
    const h = only(field);
    const ship = shipAt(track, h.index, h.lateral, 1);
    ship.shield = 5;
    const events = field.step(DT, [ship]);
    expect(events.map((e) => e.kind)).toEqual(['blocked']);
    expect(ship.shield).toBe(0);
    expect(ship.state.u).toBe(cls.topSpeed);
  });
});

describe('AI and hazards', () => {
  it.each(['sharks', 'kraken', 'wave'] as const)('a lone AI ship steers round %s', (kind) => {
    const track = trackWith(kind);
    const race = new Race(track, [{ cls, name: 'Test', isPlayer: false, pace: 0.95 }]);
    for (let i = 0; i < 600 * 60 && !race.racers[0].finished; i++) race.step(DT, { throttle: 0, rudder: 0 });
    expect(race.racers[0].finished).toBe(true);
    expect(race.racers[0].hazardHits).toBe(0);
  });

  it('counts the hazards that catch a ship', () => {
    const track = trackWith('kraken');
    const race = new Race(track, [{ cls, name: 'Test', isPlayer: true, pace: 1 }]);
    const h = race.hazards!.hazards[0];
    for (let i = 0; i < 5 * 60; i++) race.step(DT, { throttle: 0, rudder: 0 });
    const p = track.pointAt(h.index, h.lateral);
    race.player.state.x = p.x;
    race.player.state.z = p.z;
    race.player.trackIndex = h.index;
    race.step(DT, { throttle: 1, rudder: 0 });
    expect(race.player.hazardHits).toBe(1);
    expect(race.events.filter((e) => e.kind === 'kraken')).toHaveLength(1);
    // Only collisions wear down the hull.
    expect(race.player.hull).toBe(1);
  });
});
