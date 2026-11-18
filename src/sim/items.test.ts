import { describe, expect, it } from 'vitest';
import { BOOST_SECONDS, ITEM_KINDS, ItemField, SHIELD_SECONDS, type ItemKind, type ItemUser } from './items';
import { createShipState } from './physics';
import { BUMPS_TO_DOCK, Race, DOCK_SECONDS } from './race';
import { SHIP_CLASSES } from './ships';
import { Track, TRACKS } from './track';

const DT = 1 / 60;
const cls = SHIP_CLASSES[3];
const track = new Track(TRACKS[0]);

/** A ship on the route at a sample, going along it at a share of top speed. */
function shipAt(id: number, index: number, lateral = 0, speed = 0.5): ItemUser {
  const p = track.pointAt(index, lateral);
  const state = createShipState(p.x, p.z, track.headingAt(index));
  state.u = cls.topSpeed * speed;
  return {
    id,
    state,
    cls,
    hull: 1,
    shield: 0,
    boost: 0,
    docked: 0,
    item: null,
    itemHeld: 0,
    progress: index - track.startIndex,
    finished: false,
  };
}

function holding(item: ItemKind, id = 0, index = track.startIndex + 100): ItemUser {
  return { ...shipAt(id, index), item };
}

describe('power-up boxes', () => {
  it('lie in a row across the channel at each quarter of the route', () => {
    for (const def of TRACKS) {
      const route = new Track(def);
      const field = new ItemField(route);
      expect(field.boxes).toHaveLength(15);
      const length = route.finishIndex - route.startIndex;
      const shares = field.boxes.map((box) => (route.nearest(box.x, box.z).index - route.startIndex) / length);
      expect([...new Set(shares.map((share) => Math.round(share * 20) / 20))]).toEqual([0.25, 0.5, 0.75]);
      for (const box of field.boxes) {
        expect(Math.abs(route.nearest(box.x, box.z).lateral)).toBeLessThan(route.halfWidth * 0.8);
        for (const rock of route.obstacles) {
          expect(Math.hypot(rock.x - box.x, rock.z - box.z)).toBeGreaterThan(rock.r);
        }
      }
    }
  });

  it('give a ship that sails through one a power-up, then come back after a while', () => {
    const field = new ItemField(track);
    const box = field.boxes[2];
    const ship = shipAt(0, track.nearest(box.x, box.z).index);
    const events = field.step(DT, [ship]);
    expect(events.map((e) => e.kind)).toEqual(['pickup']);
    expect(ITEM_KINDS).toContain(ship.item);
    expect(box.ready).toBe(false);
    for (let i = 0; i < 10 * 60; i++) field.step(DT, []);
    expect(box.ready).toBe(true);
  });

  it('give nothing to a ship that already holds a power-up', () => {
    const field = new ItemField(track);
    const box = field.boxes[2];
    const ship = { ...shipAt(0, track.nearest(box.x, box.z).index), item: 'shield' as const };
    expect(field.step(DT, [ship])).toHaveLength(0);
    expect(box.ready).toBe(true);
    expect(ship.item).toBe('shield');
  });

  it('never give the leader a cork, and give every kind to someone', () => {
    const field = new ItemField(track);
    const seen = new Set<ItemKind>();
    // Go through the boxes a few times over, to see plenty of picks.
    Array.from({ length: 60 }, (_, i) => i).forEach((i) => {
      const box = field.boxes[i % field.boxes.length];
      box.ready = true;
      const index = track.nearest(box.x, box.z).index;
      const leader = shipAt(0, index);
      leader.state.x = box.x;
      leader.state.z = box.z;
      const last = shipAt(1, index - 30);
      const who = i % 2 === 0 ? leader : last;
      if (who === last) {
        last.state.x = box.x;
        last.state.z = box.z;
        leader.state.x += 5000;
      }
      field.step(DT, [leader, last]);
      expect(who.item).not.toBeNull();
      if (who === leader) expect(who.item).not.toBe('cork');
      seen.add(who.item!);
    });
    expect([...seen].sort()).toEqual([...ITEM_KINDS].sort());
  });
});

describe('using a power-up', () => {
  it('does nothing without one', () => {
    const field = new ItemField(track);
    const ship = shipAt(0, track.startIndex + 100);
    field.use(ship);
    expect(ship.boost).toBe(0);
    expect(field.shots).toHaveLength(0);
    expect(field.drops).toHaveLength(0);
  });

  it('FlowRider Boost, Crown & Anchor Shield and Dry Dock Repair act on the ship itself', () => {
    const field = new ItemField(track);
    const boost = holding('boost');
    field.use(boost);
    expect(boost.boost).toBe(BOOST_SECONDS);
    expect(boost.item).toBeNull();

    const shield = holding('shield');
    field.use(shield);
    expect(shield.shield).toBe(SHIELD_SECONDS);

    const repair = { ...holding('repair'), hull: 0.3 };
    field.use(repair);
    expect(repair.hull).toBe(1);
  });

  it('a champagne cork bends its flight to hit the ship ahead', () => {
    const field = new ItemField(track);
    const from = holding('cork', 0, track.startIndex + 100);
    const target = { ...shipAt(1, track.startIndex + 100 + Math.round(900 / track.spacing), 250, 0.2), item: 'shield' as const };
    field.use(from);
    expect(field.shots).toHaveLength(1);
    const events = [];
    for (let i = 0; i < 8 * 60 && events.length === 0; i++) events.push(...field.step(DT, [from, target]));
    expect(events.map((e) => [e.kind, e.shipId])).toEqual([['cork', 1]]);
    expect(target.state.u).toBeLessThan(cls.topSpeed * 0.2 * 0.5);
    expect(field.shots).toHaveLength(0);
  });

  it('a cork that finds nobody falls into the sea', () => {
    const field = new ItemField(track);
    const from = holding('cork');
    field.use(from);
    for (let i = 0; i < 10 * 60; i++) expect(field.step(DT, [from])).toHaveLength(0);
    expect(field.shots).toHaveLength(0);
  });

  it('a shield stops a cork', () => {
    const field = new ItemField(track);
    const from = holding('cork', 0, track.startIndex + 100);
    const target = { ...shipAt(1, track.startIndex + 100 + Math.round(600 / track.spacing), 0, 0.2), shield: 5 };
    const speed = target.state.u;
    field.use(from);
    const events = [];
    for (let i = 0; i < 8 * 60 && events.length === 0; i++) events.push(...field.step(DT, [from, target]));
    expect(events.map((e) => e.kind)).toEqual(['blocked']);
    expect(target.shield).toBe(0);
    expect(target.state.u).toBe(speed);
  });

  it('limes and coconuts are left astern for the ship behind to run into', () => {
    const field = new ItemField(track);
    const from = holding('coconut', 0, track.startIndex + 100);
    field.use(from);
    expect(field.drops).toHaveLength(3);
    // The ship that dropped them is clear of them.
    expect(field.step(DT, [from])).toHaveLength(0);

    const drop = field.drops[1];
    const behind = { ...holding('shield', 1), shield: 0 };
    behind.state.x = drop.x;
    behind.state.z = drop.z;
    const speed = behind.state.u;
    const events = field.step(DT, [from, behind]);
    expect(events.map((e) => [e.kind, e.shipId])).toEqual([['coconut', 1]]);
    expect(behind.state.u).toBeLessThan(speed * 0.7);
    expect(field.drops).toHaveLength(2);
  });
});

describe('power-ups in a race', () => {
  function lone(): Race {
    const race = new Race(track, [{ cls, name: 'Test', isPlayer: true, pace: 1 }], { hazards: false, items: true });
    for (let i = 0; i < 5 * 60; i++) race.step(DT, { throttle: 0, rudder: 0 });
    expect(race.phase).toBe('racing');
    return race;
  }

  it('are on the route with the hazards, and can be left out', () => {
    expect(new Race(track, [{ cls, name: 'Test', isPlayer: true, pace: 1 }]).items).not.toBeNull();
    expect(new Race(track, [{ cls, name: 'Test', isPlayer: true, pace: 1 }], { hazards: false }).items).toBeNull();
  });

  it('a boost takes a ship past its top speed for a few seconds', () => {
    const race = lone();
    const player = race.player;
    player.state.u = cls.topSpeed;
    player.item = 'boost';
    race.useItem(player);
    let peak = 0;
    for (let i = 0; i < BOOST_SECONDS * 60; i++) {
      race.step(DT, { throttle: 1, rudder: 0 });
      peak = Math.max(peak, player.state.u);
    }
    expect(peak).toBeGreaterThan(cls.topSpeed * 1.2);
    expect(peak).toBeLessThan(cls.topSpeed * 1.8);
    expect(player.boost).toBeLessThan(0.01);
  });

  it('cannot be used before the start', () => {
    const race = new Race(track, [{ cls, name: 'Test', isPlayer: true, pace: 1 }]);
    race.player.item = 'boost';
    race.useItem(race.player);
    expect(race.player.item).toBe('boost');
  });

  it('AI ships pick them up and use them', () => {
    const entries = [0, 1, 2, 3].map((i) => ({ cls: SHIP_CLASSES[i], name: `Ship ${i}`, isPlayer: false, pace: 0.95 }));
    const race = new Race(track, entries);
    let pickups = 0;
    let used = 0;
    for (let i = 0; i < 200 * 60; i++) {
      const before = race.racers.map((r) => r.item);
      race.step(DT, { throttle: 0, rudder: 0 });
      pickups += race.events.splice(0).filter((e) => e.kind === 'pickup').length;
      used += race.racers.filter((r, n) => before[n] && !r.item).length;
    }
    expect(pickups).toBeGreaterThan(5);
    expect(used).toBeGreaterThan(pickups - 4);
  });
});

describe('bumps and the dry dock', () => {
  function pair(): Race {
    const entries = [0, 4].map((i) => ({ cls: SHIP_CLASSES[i], name: `Ship ${i}`, isPlayer: i === 0, pace: 1 }));
    const race = new Race(track, entries, { hazards: false });
    for (let i = 0; i < 5 * 60; i++) race.step(DT, { throttle: 0, rudder: 0 });
    race.racers.forEach((r) => (r.autopilot = false));
    return race;
  }

  /** Put the second ship across the bows of the first, which is going at a share of top speed. */
  function ram(race: Race, speed: number): void {
    const [a, b] = race.racers;
    const index = a.trackIndex + 40;
    const p = track.pointAt(index, 0);
    const heading = track.headingAt(index);
    Object.assign(a.state, { x: p.x, z: p.z, heading, u: a.cls.topSpeed * speed, v: 0, r: 0 });
    const gap = a.cls.length / 2 + b.cls.beam / 2 + 6;
    Object.assign(b.state, {
      x: p.x + Math.sin(heading) * gap,
      z: p.z + Math.cos(heading) * gap,
      heading: heading + Math.PI / 2,
      u: 0,
      v: 0,
      r: 0,
    });
    b.helm = { throttle: 0, rudder: 0 };
  }

  it('a gentle touch does not count', () => {
    const race = pair();
    ram(race, 0.05);
    for (let i = 0; i < 3 * 60; i++) race.step(DT, { throttle: 0, rudder: 0 });
    expect(race.racers.map((r) => r.hull)).toEqual([1, 1]);
    expect(race.events.filter((e) => e.kind === 'bump')).toHaveLength(0);
  });

  it('a bump takes a third off both ships, once', () => {
    const race = pair();
    ram(race, 0.9);
    for (let i = 0; i < 30; i++) race.step(DT, { throttle: 0, rudder: 0 });
    for (const racer of race.racers) expect(racer.hull).toBeCloseTo(2 / 3);
    expect(race.events.filter((e) => e.kind === 'bump').map((e) => e.shipId).sort()).toEqual([0, 1]);
  });

  it('the third bump sends a ship into dry dock', () => {
    const race = pair();
    const small = race.racers[1];
    for (let n = 1; n <= BUMPS_TO_DOCK; n++) {
      expect(small.docked).toBe(0);
      ram(race, 0.9);
      race.racers[0].hull = 1;
      for (let i = 0; i < 2 * 60; i++) race.step(DT, { throttle: 0, rudder: 0 });
      expect(race.events.filter((e) => e.kind === 'bump' && e.shipId === 1)).toHaveLength(n);
    }
    expect(small.docked).toBeGreaterThan(0);
    expect(race.events.filter((e) => e.kind === 'drydock').map((e) => e.shipId)).toEqual([1]);
  });

  it('a shield takes a collision', () => {
    const race = pair();
    race.racers[1].shield = 5;
    ram(race, 0.9);
    for (let i = 0; i < 30; i++) race.step(DT, { throttle: 0, rudder: 0 });
    expect(race.racers[1].hull).toBe(1);
    expect(race.racers[1].shield).toBe(0);
    expect(race.racers[0].hull).toBeLessThan(1);
  });

  it('running into the rocks at speed counts as a bump', () => {
    const route = new Track(TRACKS.find((def) => def.id === 'seattle-juneau')!);
    const race = new Race(route, [{ cls, name: 'Test', isPlayer: true, pace: 1 }], { hazards: false });
    for (let i = 0; i < 5 * 60; i++) race.step(DT, { throttle: 0, rudder: 0 });
    const rock = route.obstacles[Math.floor(route.obstacles.length / 2)];
    const s = race.player.state;
    const gap = rock.r + cls.length / 2 + 20;
    Object.assign(s, { x: rock.x, z: rock.z - gap, heading: 0, u: cls.topSpeed, v: 0, r: 0 });
    for (let i = 0; i < 60 && race.player.hull === 1; i++) race.step(DT, { throttle: 1, rudder: 0 });
    expect(race.player.hull).toBeCloseTo(2 / 3);
  });

  it('a worn ship is slower than a shipshape one', () => {
    const top = (hull: number): number => {
      const race = new Race(track, [{ cls, name: 'Test', isPlayer: false, pace: 1 }], { hazards: false });
      for (let i = 0; i < 60 * 60; i++) {
        race.racers[0].hull = hull;
        race.step(DT, { throttle: 0, rudder: 0 });
      }
      return race.racers[0].state.u;
    };
    const sound = top(1);
    const worn = top(0.2);
    expect(worn).toBeLessThan(sound * 0.9);
    expect(worn).toBeGreaterThan(sound * 0.6);
  });

  it('a ship with no hull left is held in dry dock, then sets off shipshape', () => {
    const race = new Race(track, [{ cls, name: 'Test', isPlayer: false, pace: 1 }], { hazards: false });
    const racer = race.racers[0];
    for (let i = 0; i < 60 * 60; i++) race.step(DT, { throttle: 0, rudder: 0 });
    const dock = { x: racer.state.x, z: racer.state.z };
    racer.item = 'boost';
    racer.hull = 0;
    race.step(DT, { throttle: 0, rudder: 0 });
    expect(racer.docked).toBeGreaterThan(0);
    expect(racer.item).toBeNull();
    expect(race.events.map((e) => e.kind)).toContain('drydock');

    for (let i = 0; i < (DOCK_SECONDS - 0.5) * 60; i++) race.step(DT, { throttle: 0, rudder: 0 });
    expect(racer.docked).toBeGreaterThan(0);
    expect(racer.state.u).toBe(0);
    expect(Math.hypot(racer.state.x - dock.x, racer.state.z - dock.z)).toBeLessThan(20);

    for (let i = 0; i < 31; i++) race.step(DT, { throttle: 0, rudder: 0 });
    expect(racer.docked).toBe(0);
    expect(racer.hull).toBe(1);
    expect(racer.shield).toBeGreaterThan(0);
    // It has had a moment to get under way again.
    expect(Math.hypot(racer.state.x - dock.x, racer.state.z - dock.z)).toBeLessThan(25);
    expect(race.events.filter((e) => e.kind === 'drydock')).toHaveLength(1);
  });

  it('the dry dock leaves a ship in the middle of the channel, facing the finish', () => {
    const race = new Race(track, [{ cls, name: 'Test', isPlayer: true, pace: 1 }], { hazards: false });
    const racer = race.player;
    for (let i = 0; i < 20 * 60; i++) race.step(DT, { throttle: 1, rudder: 0 });
    // Out to one side and pointing back the way it came.
    const index = racer.trackIndex;
    const p = track.pointAt(index, track.halfWidth * 0.6);
    Object.assign(racer.state, { x: p.x, z: p.z, heading: track.headingAt(index) + 2.8, u: 5 });
    racer.hull = 0;
    race.step(DT, { throttle: 0, rudder: 0 });
    expect(Math.abs(racer.lateral)).toBeGreaterThan(track.halfWidth * 0.5);

    for (let i = 0; i < DOCK_SECONDS * 60 - 2; i++) race.step(DT, { throttle: 0, rudder: 0 });
    expect(racer.docked).toBeGreaterThan(0);
    expect(Math.abs(racer.lateral)).toBeLessThan(5);
    const here = track.nearest(racer.state.x, racer.state.z).index;
    expect(Math.abs(here - index)).toBeLessThanOrEqual(2);
    const off = racer.state.heading - track.headingAt(here);
    expect(Math.abs(Math.atan2(Math.sin(off), Math.cos(off)))).toBeLessThan(0.05);
    expect(race.isWrongWay(racer)).toBe(false);
  });

  it('a full field still gets everyone to the destination', () => {
    for (const def of TRACKS) {
      const route = new Track(def);
      const entries = [0, 1, 2, 3, 4, 0].map((c, i) => ({
        cls: SHIP_CLASSES[c],
        name: `Ship ${i}`,
        isPlayer: false,
        pace: 0.92 + (i % 3) * 0.02,
      }));
      const race = new Race(route, entries);
      for (let i = 0; i < 900 * 60 && !race.racers.every((r) => r.finished); i++) race.step(DT, { throttle: 0, rudder: 0 });
      expect(race.racers.filter((r) => !r.finished)).toHaveLength(0);
    }
  });
});
