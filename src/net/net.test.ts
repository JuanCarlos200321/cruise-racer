import { describe, expect, it } from 'vitest';
import { Race } from '../sim/race';
import { createRng } from '../sim/rng';
import { SHIP_CLASSES } from '../sim/ships';
import { Track, TRACKS } from '../sim/track';
import { cleanHelm, cleanName, entriesFor, HOST_ID, MAX_PLAYERS, SnapshotBuffer, takeSnapshot } from './protocol';
import { ClientSession, HostSession, type Link } from './session';

const DT = 1 / 60;

/** Two ends of a connection that deliver straight away, as JSON, like the real thing. */
function linkPair(): [Link, Link] {
  let open = true;
  const make = (): Link => ({ send: () => {}, close: () => {}, onMessage: null, onClose: null });
  const a = make();
  const b = make();
  const wire = (from: Link, to: Link): void => {
    from.send = (message) => {
      if (open) to.onMessage?.(JSON.parse(JSON.stringify(message)));
    };
    from.close = () => {
      if (!open) return;
      open = false;
      a.onClose?.();
      b.onClose?.();
    };
  };
  wire(a, b);
  wire(b, a);
  return [a, b];
}

function join(host: HostSession, name: string, ship = 1): ClientSession {
  const [hostEnd, clientEnd] = linkPair();
  host.accept(hostEnd);
  return new ClientSession(clientEnd, name, ship);
}

describe('lobby', () => {
  it('gives each player an id and shows everyone the same lobby', () => {
    const host = new HostSession('Ana', 2, 0);
    const ben = join(host, 'Ben', 4);
    const cy = join(host, 'Cy', 0);
    expect(ben.id).not.toBe(cy.id);
    expect(ben.id).not.toBe(HOST_ID);
    expect(host.lobby.players.map((p) => p.name)).toEqual(['Ana', 'Ben', 'Cy']);
    expect(ben.lobby).toEqual(host.lobby);
    expect(cy.lobby).toEqual(host.lobby);
  });

  it('passes on changes of ship and voyage', () => {
    const host = new HostSession('Ana', 2, 0);
    const ben = join(host, 'Ben', 4);
    ben.setShip(3);
    host.setTrack(2);
    host.setShip(1);
    expect(host.lobby.players.map((p) => p.ship)).toEqual([1, 3]);
    expect(ben.lobby).toEqual(host.lobby);
    expect(ben.lobby!.track).toBe(2);
  });

  it('turns away a player when the game is full', () => {
    const host = new HostSession('Ana', 0, 0);
    for (let i = 1; i < MAX_PLAYERS; i++) join(host, `P${i}`);
    const late = join(host, 'Late');
    let reason = '';
    late.onClosed = (r) => (reason = r);
    // The refusal arrived during construction, before the handler was set.
    expect(late.id).toBeNull();
    expect(host.lobby.players).toHaveLength(MAX_PLAYERS);
    expect(reason).toBe('');
  });

  it('drops a player who leaves and tells the rest', () => {
    const host = new HostSession('Ana', 0, 0);
    const ben = join(host, 'Ben');
    const cy = join(host, 'Cy');
    const left: string[] = [];
    host.onLeave = (id) => left.push(id);
    const benId = ben.id!;
    ben.leave();
    expect(left).toEqual([benId]);
    expect(cy.lobby!.players.map((p) => p.name)).toEqual(['Ana', 'Cy']);
  });

  it('tells a player when the host goes away, but not when they leave themselves', () => {
    const host = new HostSession('Ana', 0, 0);
    const ben = join(host, 'Ben');
    const cy = join(host, 'Cy');
    const closed: string[] = [];
    ben.onClosed = () => closed.push('ben');
    cy.onClosed = () => closed.push('cy');
    cy.leave();
    host.close();
    expect(closed).toEqual(['ben']);
  });

  it('does not trust what players send', () => {
    expect(cleanName('  <b>x</b>   y  ')).toBe('<b>x</b> y');
    expect(cleanName('a'.repeat(50))).toHaveLength(16);
    expect(cleanName(42)).toBe('Captain');
    expect(cleanHelm(5, -7)).toEqual({ throttle: 1, rudder: -1 });
    expect(cleanHelm(NaN, 'x')).toEqual({ throttle: 0, rudder: 0 });
    const host = new HostSession('Ana', 0, 0);
    const ben = join(host, 'Ben');
    ben.setShip(99);
    expect(host.lobby.players[1].ship).toBe(0);
  });
});

describe('starting a race', () => {
  it('puts every player on the grid once and fills the rest with AI ships', () => {
    const host = new HostSession('Ana', 2, 1, createRng(5));
    const ben = join(host, 'Ben', 4);
    let got: { track: number; ids: (string | null)[] } | null = null;
    ben.onStart = (track, entries) => (got = { track, ids: entries.map((e) => e.playerId) });
    const grid = host.start();
    expect(grid).toHaveLength(MAX_PLAYERS);
    expect(grid.filter((e) => e.playerId === HOST_ID)).toHaveLength(1);
    expect(grid.filter((e) => e.playerId === ben.id)).toHaveLength(1);
    expect(grid.filter((e) => e.playerId === null)).toHaveLength(MAX_PLAYERS - 2);
    expect(new Set(grid.map((e) => e.name)).size).toBe(MAX_PLAYERS);
    expect(got).toEqual({ track: 1, ids: grid.map((e) => e.playerId) });
    expect(host.lobby.racing).toBe(true);

    // Each player's race has their own ship as the player and the other human as remote.
    const mine = new Race(new Track(TRACKS[1]), entriesFor(grid, ben.id!));
    expect(mine.player.name).toBe('Ben');
    expect(mine.racers.some((r) => r.name === 'Icon of the Seas')).toBe(true);
    const theirs = new Race(new Track(TRACKS[1]), entriesFor(grid, HOST_ID));
    const benOnHost = theirs.racers.find((r) => r.name === 'Ben')!;
    expect(benOnHost.isPlayer).toBe(false);
    expect(benOnHost.autopilot).toBe(false);
    expect(benOnHost.helm).not.toBeNull();
  });

  it('brings everyone back to the lobby afterwards', () => {
    const host = new HostSession('Ana', 0, 0);
    const ben = join(host, 'Ben');
    let back = false;
    ben.onToLobby = () => (back = true);
    host.start();
    host.toLobby();
    expect(back).toBe(true);
    expect(ben.lobby!.racing).toBe(false);
  });
});

describe('a race over the network', () => {
  it('steers a remote player by their own helm, and hands the ship to the AI if they leave', () => {
    const host = new HostSession('Ana', 0, 0, createRng(2));
    const ben = join(host, 'Ben', 3);
    // Just the two players, so no AI ship can push either of them along.
    const grid = host.start().filter((e) => e.playerId !== null);
    const race = new Race(new Track(TRACKS[0]), entriesFor(grid, HOST_ID), { hazards: false });
    const benShip = race.racers[grid.findIndex((e) => e.playerId === ben.id)];
    const anaShip = race.player;

    ben.sendHelm({ throttle: 1, rudder: 0 });
    for (let i = 0; i < 20 * 60; i++) {
      benShip.helm = host.helmOf(ben.id!);
      race.step(DT, { throttle: 0, rudder: 0 });
    }
    expect(benShip.state.u).toBeGreaterThan(20);
    expect(anaShip.state.u).toBe(0);

    // Full astern: the ship ends up going backwards, which an AI ship would not do.
    ben.sendHelm({ throttle: -1, rudder: 0 });
    for (let i = 0; i < 30 * 60; i++) {
      benShip.helm = host.helmOf(ben.id!);
      race.step(DT, { throttle: 0, rudder: 0 });
    }
    expect(benShip.state.u).toBeLessThan(0);

    host.onLeave = () => {
      benShip.helm = null;
      benShip.autopilot = true;
    };
    ben.leave();
    for (let i = 0; i < 30 * 60; i++) race.step(DT, { throttle: 0, rudder: 0 });
    expect(benShip.state.u).toBeGreaterThan(20);
  });

  it('shows a joining player the host race, a moment late and in between snapshots', () => {
    const host = new HostSession('Ana', 0, 0, createRng(3));
    const ben = join(host, 'Ben', 3);
    const buffer = new SnapshotBuffer();
    // This player's clock runs 1000 s ahead of the host's and messages take 50 ms.
    const clockGap = 1000;
    const lag = 0.05;
    let hostNow = 0;
    ben.onSnapshot = (snap) => buffer.push(snap, hostNow + clockGap + lag);

    const track = new Track(TRACKS[0]);
    const grid = host.start();
    const hostRace = new Race(track, entriesFor(grid, HOST_ID));
    const mirror = new Race(track, entriesFor(grid, ben.id!));
    const history: { at: number; x: number; z: number }[] = [];
    const benIndex = grid.findIndex((e) => e.playerId === ben.id);
    ben.sendHelm({ throttle: 1, rudder: 0 });

    let hits = 0;
    for (let step = 0; step < 25 * 60; step++) {
      hostRace.racers[benIndex].helm = host.helmOf(ben.id!);
      hostRace.step(DT, { throttle: 1, rudder: 0 });
      hostNow += DT;
      const s = hostRace.racers[benIndex].state;
      history.push({ at: hostNow, x: s.x, z: s.z });
      if (step % 2 === 0) host.sendSnapshot(takeSnapshot(hostRace, hostNow, hostRace.events.splice(0)));
      hits += buffer.apply(mirror, hostNow + clockGap + lag).length;
    }

    expect(mirror.phase).toBe('racing');
    expect(mirror.player.state.u).toBeGreaterThan(20);
    // The mirror shows where the host had the ship DELAY seconds ago, give or take a step.
    const shownAt = hostNow - SnapshotBuffer.DELAY;
    const then = history.reduce((best, h) => (Math.abs(h.at - shownAt) < Math.abs(best.at - shownAt) ? h : best));
    const m = mirror.player.state;
    expect(Math.hypot(m.x - then.x, m.z - then.z)).toBeLessThan(mirror.player.state.u * DT * 2.5);
    // Everything else follows too.
    mirror.racers.forEach((r, i) => {
      expect(Math.abs(r.trackIndex - hostRace.racers[i].trackIndex)).toBeLessThanOrEqual(1);
      expect(r.hazardHits).toBe(hostRace.racers[i].hazardHits);
    });
    const whale = hostRace.hazards!.hazards.findIndex((h) => h.kind === 'whale');
    const hostWhale = hostRace.hazards!.hazards[whale];
    const mirrorWhale = mirror.hazards!.hazards[whale];
    expect(Math.hypot(hostWhale.x - mirrorWhale.x, hostWhale.z - mirrorWhale.z)).toBeLessThan(10);
    expect(mirrorWhale.cycle).toBeCloseTo(hostWhale.cycle, 1);
    expect(hits).toBeGreaterThan(0);
  });

  it('shows a joining player damage, power-ups, and what is in the water', () => {
    const track = new Track(TRACKS[0]);
    const entries = [0, 1].map((i) => ({ cls: SHIP_CLASSES[i], name: `Ship ${i}`, isPlayer: i === 0, pace: 0.95 }));
    const hostRace = new Race(track, entries);
    const mirror = new Race(track, entries);
    for (let i = 0; i < 6 * 60; i++) hostRace.step(DT, { throttle: 0, rudder: 0 });
    const [a, b] = hostRace.racers;
    a.hull = 0.4;
    a.shield = 5;
    a.boost = 2;
    a.item = 'cork';
    b.item = 'coconut';
    hostRace.useItem(b);
    hostRace.items!.boxes[3].ready = false;
    hostRace.items!.shots.push({ x: 10, z: 20, heading: 1, owner: 0, life: 3 });

    const buffer = new SnapshotBuffer();
    buffer.push(JSON.parse(JSON.stringify(takeSnapshot(hostRace, 1, []))), 1);
    buffer.push(JSON.parse(JSON.stringify(takeSnapshot(hostRace, 1.1, []))), 1.1);
    buffer.apply(mirror, 1.1 + SnapshotBuffer.DELAY);

    expect(mirror.racers[0].hull).toBeCloseTo(0.4);
    expect(mirror.racers[0].shield).toBeCloseTo(5);
    expect(mirror.racers[0].boost).toBeCloseTo(2);
    expect(mirror.racers[0].item).toBe('cork');
    expect(mirror.racers[1].item).toBeNull();
    expect(mirror.items!.boxes.map((box) => box.ready)).toEqual(hostRace.items!.boxes.map((box) => box.ready));
    expect(mirror.items!.boxes[3].ready).toBe(false);
    expect(mirror.items!.drops).toHaveLength(3);
    expect(mirror.items!.shots).toHaveLength(1);
    expect(mirror.items!.shots[0].x).toBeCloseTo(10);
  });

  it('lets a player ask the host to use their power-up', () => {
    const host = new HostSession('Ana', 0, 0, createRng(3));
    const ben = join(host, 'Ben', 3);
    const used: string[] = [];
    host.onUse = (id) => used.push(id);
    ben.sendUse();
    expect(used).toEqual([ben.id]);
  });

  it('ignores snapshots that arrive out of order', () => {
    const track = new Track(TRACKS[0]);
    const race = new Race(track, [{ cls: entriesFor([{ ship: 0, name: 'a', pace: 1, playerId: 'x' }], 'x')[0].cls, name: 'a', isPlayer: true, pace: 1 }]);
    const buffer = new SnapshotBuffer();
    const first = takeSnapshot(race, 1, []);
    for (let i = 0; i < 300; i++) race.step(DT, { throttle: 1, rudder: 0 });
    const second = takeSnapshot(race, 2, []);
    buffer.push(second, 2);
    buffer.push(first, 2.01);
    const mirror = new Race(track, [{ cls: race.player.cls, name: 'a', isPlayer: true, pace: 1 }]);
    buffer.apply(mirror, 5);
    expect(mirror.time).toBeCloseTo(race.time, 2);
  });
});
