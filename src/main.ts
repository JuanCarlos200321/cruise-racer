import * as THREE from 'three';
import { Input, type Action } from './input';
import { CameraRig } from './render/camera';
import { World, type ShipView } from './render/world';
import { COUNTDOWN_SECONDS, Race, type RaceEntry, type Racer } from './sim/race';
import { SHIP_CLASSES, toKnots, type ShipClass } from './sim/ships';
import { Track, TRACKS } from './sim/track';
import { formatTime, Ui, type HudState, type ResultRow, type ScreenId, type UiCommand } from './ui/ui';

const STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;
const LAPS = 3;
const RIVAL_PACES = [0.96, 0.94, 0.92, 0.9, 0.88];
const PLAYER_AUTOPILOT_PACE = 0.95;
const RESULTS_DELAY = 3;
const TAG_RANGE = 2600;

interface Pose {
  x: number;
  z: number;
  heading: number;
}

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const tracks = TRACKS.map((def) => new Track(def));
const rig = new CameraRig();
const input = new Input();
const ui = new Ui(document.getElementById('ui')!, TRACKS);

let screen: ScreenId = 'title';
let shipIndex = 2;
let trackIndex = 0;
let world = new World(tracks[trackIndex], renderer);
let worldTrack = trackIndex;
let race!: Race;
let views: ShipView[] = [];
let previous: Pose[] = [];
let demo = false;

let clock = 0;
let accumulator = 0;
let lastFrame = performance.now() / 1000;
let finishedAt: number | null = null;
let finalLapAt: number | null = null;
let resultsShownAt = 0;

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function useWorld(index: number): void {
  if (index === worldTrack) return;
  world.dispose();
  world = new World(tracks[index], renderer);
  worldTrack = index;
}

function beginRace(entries: RaceEntry[], laps: number): void {
  world.clearShips();
  race = new Race(tracks[worldTrack], entries, laps);
  views = race.racers.map((racer) => world.addShip(racer.cls));
  previous = race.racers.map((racer) => ({ ...racer.state }));
  accumulator = 0;
  finishedAt = null;
  finalLapAt = null;
  rig.snap();
}

/** Behind the menus, the chosen ship cruises the chosen course on its own. */
function startMenuCruise(): void {
  useWorld(trackIndex);
  const cls = SHIP_CLASSES[shipIndex];
  beginRace([{ cls, name: cls.shipNames[0], isPlayer: true, pace: 0.5, autopilot: true }], Infinity);
  race.cruiseFrom(race.player, 0.3, 0.5);
  previous = race.racers.map((racer) => ({ ...racer.state }));
  world.course.setGatesVisible(false);
}

function startRace(): void {
  useWorld(trackIndex);
  const player = SHIP_CLASSES[shipIndex];
  const paces = shuffled(RIVAL_PACES);
  const rivals: RaceEntry[] = SHIP_CLASSES.map((cls, i) => ({
    cls,
    name: cls.shipNames[cls === player ? 1 : 0],
    isPlayer: false,
    pace: paces[i],
  }));
  // The player starts at the back of the grid.
  const entries: RaceEntry[] = [
    ...shuffled(rivals),
    { cls: player, name: player.shipNames[0], isPlayer: true, pace: PLAYER_AUTOPILOT_PACE, autopilot: demo },
  ];
  beginRace(entries, LAPS);
  world.course.setGatesVisible(true);
  ui.beginRace(race.track, rivals.length);
  setScreen('race');
}

function setScreen(next: ScreenId): void {
  screen = next;
  ui.show(next);
}

function openMenu(next: 'title' | 'ship' | 'track'): void {
  startMenuCruise();
  ui.setShip(SHIP_CLASSES[shipIndex], shipIndex);
  ui.setTrackChoice(trackIndex);
  setScreen(next);
}

function stepShip(by: number): void {
  shipIndex = (shipIndex + by + SHIP_CLASSES.length) % SHIP_CLASSES.length;
  openMenu('ship');
}

function pickTrack(index: number): void {
  trackIndex = (index + tracks.length) % tracks.length;
  openMenu('track');
}

ui.onCommand((command: UiCommand) => {
  switch (command.type) {
    case 'start':
      return openMenu('ship');
    case 'ship-step':
      return stepShip(command.by);
    case 'ship-confirm':
      return setScreen('track');
    case 'track-pick':
      return pickTrack(command.index);
    case 'track-confirm':
      return startRace();
    case 'back':
      return setScreen(screen === 'track' ? 'ship' : 'title');
    case 'resume':
      return setScreen('race');
    case 'restart':
      return startRace();
    case 'quit':
      return openMenu('ship');
  }
});

input.onAction((action: Action) => {
  switch (screen) {
    case 'title':
      if (action === 'confirm') openMenu('ship');
      break;
    case 'ship':
      if (action === 'left') stepShip(-1);
      else if (action === 'right') stepShip(1);
      else if (action === 'confirm') setScreen('track');
      else if (action === 'back') setScreen('title');
      break;
    case 'track':
      if (action === 'left') pickTrack(trackIndex - 1);
      else if (action === 'right') pickTrack(trackIndex + 1);
      else if (action === 'confirm') startRace();
      else if (action === 'back') setScreen('ship');
      break;
    case 'race':
      if (action === 'camera') rig.toggleMode();
      else if (action === 'pause') setScreen('paused');
      else if (action === 'reset' && race.phase === 'racing' && !race.player.finished) {
        race.resetToCheckpoint(race.player);
        rig.snap();
      }
      break;
    case 'paused':
      if (action === 'pause' || action === 'confirm') setScreen('race');
      break;
    case 'results':
      if (action === 'confirm') startRace();
      break;
  }
});

function resize(): void {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  rig.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);
resize();

function simulate(dt: number): void {
  accumulator += dt;
  let steps = 0;
  const helm = input.helm();
  while (accumulator >= STEP && steps < MAX_STEPS_PER_FRAME) {
    race.racers.forEach((racer, i) => {
      const p = previous[i];
      p.x = racer.state.x;
      p.z = racer.state.z;
      p.heading = racer.state.heading;
    });
    race.step(STEP, helm);
    accumulator -= STEP;
    steps++;
  }
  if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;
}

/** Where to draw a ship this frame, between the last two simulation steps. */
function poseOf(index: number, alpha: number): Pose {
  const now = race.racers[index].state;
  const before = previous[index];
  const turn = Math.atan2(Math.sin(now.heading - before.heading), Math.cos(now.heading - before.heading));
  return {
    x: before.x + (now.x - before.x) * alpha,
    z: before.z + (now.z - before.z) * alpha,
    heading: before.heading + turn * alpha,
  };
}

const projected = new THREE.Vector3();

function hudState(player: Racer, poses: Pose[]): HudState {
  const standings = race.standings();
  const spacing = race.track.spacing;

  let message: HudState['message'] = null;
  if (race.phase === 'racing' && !player.finished) {
    if (race.isWrongWay(player) && player.state.u > 3) message = { text: 'Wrong way', kind: 'warn' };
    else if (player.offCourse) message = { text: 'Off course', kind: 'warn' };
    else if (finalLapAt !== null && race.time - finalLapAt < 3) message = { text: 'Final lap', kind: 'info' };
    else if (player.drafting) message = { text: 'Slipstream', kind: 'info' };
  }

  const width = window.innerWidth;
  const height = window.innerHeight;
  const tags = race.racers
    .map((racer, i) => ({ racer, pose: poses[i] }))
    .filter(({ racer }) => !racer.isPlayer)
    .map(({ racer, pose }) => {
      projected.set(pose.x, racer.cls.height + 30, pose.z);
      const distance = projected.distanceTo(rig.camera.position);
      projected.project(rig.camera);
      const visible =
        distance < TAG_RANGE && projected.z < 1 && Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1;
      return {
        text: `${standings.indexOf(racer) + 1} · ${racer.name}`,
        x: (projected.x * 0.5 + 0.5) * width,
        y: (-projected.y * 0.5 + 0.5) * height,
        visible,
      };
    });

  const lapTimes = player.lapTimes;
  return {
    knots: toKnots(Math.abs(player.state.u)),
    throttle: player.state.throttle,
    rudder: player.state.rudder,
    position: standings.indexOf(player) + 1,
    fieldSize: race.racers.length,
    lap: race.lapOf(player),
    totalLaps: race.totalLaps,
    raceTime: player.finished ? player.finishTime : race.time,
    lapTime: player.finished ? lapTimes[lapTimes.length - 1] : race.time - player.lapStart,
    bestLap: lapTimes.length ? Math.min(...lapTimes) : null,
    lastLap: lapTimes.length ? lapTimes[lapTimes.length - 1] : null,
    countdown: race.phase === 'countdown' ? race.countdown : -1,
    message,
    board: standings.map((racer, i) => {
      const metres = Math.round(((racer.progress - player.progress) * spacing) / 10) * 10;
      let gap = '';
      if (racer.finished) gap = formatTime(racer.finishTime);
      else if (racer !== player) gap = `${metres > 0 ? '+' : '−'}${Math.abs(metres)} m`;
      return { position: i + 1, name: racer.name, gap, isPlayer: racer.isPlayer };
    }),
    tags,
  };
}

function resultRows(): ResultRow[] {
  return race.standings().map((racer, i) => ({
    position: i + 1,
    name: racer.name,
    className: racer.cls.name,
    time: racer.finished ? formatTime(racer.finishTime) : 'Still racing',
    bestLap: racer.lapTimes.length ? `Best lap ${formatTime(Math.min(...racer.lapTimes))}` : '',
    isPlayer: racer.isPlayer,
  }));
}

function showResults(): void {
  ui.showResults(race.track.def.name, race.positionOf(race.player), resultRows());
  resultsShownAt = clock;
}

const menuCentre = new THREE.Vector3();

function frame(ms: number): void {
  requestAnimationFrame(frame);
  const now = ms / 1000;
  const dt = Math.min(0.1, Math.max(0, now - lastFrame));
  lastFrame = now;
  input.poll();

  const running = screen !== 'paused';
  if (running) {
    clock += dt;
    simulate(dt);
  }

  const alpha = accumulator / STEP;
  const poses = race.racers.map((_, i) => poseOf(i, alpha));
  if (running) {
    race.racers.forEach((racer, i) => {
      const s = racer.state;
      views[i].update(poses[i].x, poses[i].z, poses[i].heading, s.u, s.r, s.throttle, clock, dt);
    });
  }

  const player = race.player;
  const playerPose = poses[race.racers.indexOf(player)];
  const inMenu = screen === 'title' || screen === 'ship' || screen === 'track';

  if (inMenu) {
    const cls = player.cls;
    menuCentre.set(playerPose.x, cls.height * 0.35, playerPose.z);
    const wide = screen === 'title' ? 1.5 : 1.15;
    if (screen === 'ship') rig.setFraming(0.16, 0.04);
    else if (screen === 'track') rig.setFraming(0, 0.16);
    else rig.setFraming(0.1, -0.05);
    rig.orbit(menuCentre, cls.length * wide, cls.length * 0.2 * wide, playerPose.heading + 0.7 + clock * 0.1);
  } else {
    rig.setFraming(0, 0);
    if (running) {
      const view = views[race.racers.indexOf(player)];
      rig.follow({ ...playerPose, speed: player.state.u }, player.cls, view.bridge, dt);
    }

    if (race.lapOf(player) === race.totalLaps && finalLapAt === null && race.totalLaps > 1) {
      finalLapAt = race.time;
    }
    if (player.finished && finishedAt === null) finishedAt = clock;
    if (screen === 'race' && finishedAt !== null && clock - finishedAt > RESULTS_DELAY) {
      showResults();
      setScreen('results');
    }
    if (screen === 'results' && clock - resultsShownAt > 1) showResults();

    const next = race.nextCheckpoint(player);
    world.course.setNextCheckpoint(next);
    ui.updateHud(hudState(player, poses));
    ui.drawMap(
      race.racers.map((racer, i) => ({ ...poses[i], isPlayer: racer.isPlayer })),
      next,
    );
  }

  world.update(clock, rig.camera, rig.focus);
  renderer.render(world.scene, rig.camera);
}

// ?demo=<track id>&ship=<class id> starts a race with the AI at the player's
// helm. &t=<seconds> runs the race ahead first, and &cam=bridge picks the camera.
const params = new URLSearchParams(location.search);
const demoTrack = params.get('demo');
if (demoTrack !== null) {
  demo = true;
  trackIndex = Math.max(0, TRACKS.findIndex((def) => def.id === demoTrack));
  shipIndex = Math.max(0, SHIP_CLASSES.findIndex((cls: ShipClass) => cls.id === params.get('ship')));
  if (params.get('cam') === 'bridge') rig.mode = 'bridge';
  startRace();
  const ahead = Number(params.get('t') ?? 0) + COUNTDOWN_SECONDS;
  for (let i = 0; i < ahead / STEP; i++) race.step(STEP, { throttle: 0, rudder: 0 });
  previous = race.racers.map((racer) => ({ ...racer.state }));
} else {
  openMenu('title');
}

requestAnimationFrame(frame);
