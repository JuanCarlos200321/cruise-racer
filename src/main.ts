import * as THREE from 'three';
import { Input, type Action } from './input';
import { CameraRig } from './render/camera';
import { World, type ShipView } from './render/world';
import { cleanCode, inviteLink, joinRoom, openRoom } from './net/peer';
import { entriesFor, HOST_ID, SnapshotBuffer, takeSnapshot, type EntrySpec } from './net/protocol';
import { ClientSession, HostSession } from './net/session';
import { HAZARD_NAMES, type HazardEvent } from './sim/hazards';
import { COUNTDOWN_SECONDS, Race, type RaceEntry, type RaceOptions, type Racer } from './sim/race';
import { SHIP_CLASSES, toKnots, type ShipClass } from './sim/ships';
import { Track, TRACKS } from './sim/track';
import { formatTime, Ui, type HudState, type ResultRow, type ScreenId, type UiCommand } from './ui/ui';

const STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;
const RIVAL_PACES = [0.96, 0.94, 0.92, 0.9, 0.88];
const PLAYER_AUTOPILOT_PACE = 0.95;
const RESULTS_DELAY = 3;
const TAG_RANGE = 2600;
/** Times a second the host sends the race to the other players, and they send their helm. */
const NET_RATE = 30;
/** How long the message about a hazard catching the player stays up, seconds. */
const HIT_MESSAGE_SECONDS = 3;
/** A hazard this close ahead is called out on the HUD, metres. */
const HAZARD_WARNING_RANGE = 1200;

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
/** Demo with no rivals, for a clear view of the hazards. */
let solo = false;
let inspect: { angle: number; distance: number; height: number } | null = null;

let clock = 0;
let accumulator = 0;
let lastFrame = performance.now() / 1000;
let finishedAt: number | null = null;
let resultsShownAt = 0;

/** A game with friends: either hosting it or joined to someone else's. */
type Net =
  | {
      role: 'host';
      code: string;
      session: HostSession;
      close(): void;
      /** Which racer each remote player is steering. */
      racers: Map<string, number>;
      /** Hazard hits not yet sent to the other players. */
      events: HazardEvent[];
    }
  | { role: 'client'; code: string; session: ClientSession; close(): void; buffer: SnapshotBuffer };
let net: Net | null = null;
/** True while the race on screen is one shared with other players. */
let onlineRace = false;
let connecting = false;
let lastNetSend = 0;
let lastHit: { event: HazardEvent; at: number } | null = null;

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

function beginRace(entries: RaceEntry[], options: RaceOptions = {}): void {
  world.clearShips();
  onlineRace = false;
  race = new Race(tracks[worldTrack], entries, options);
  world.setHazards(race.hazards?.hazards ?? null);
  lastHit = null;
  views = race.racers.map((racer) => world.addShip(racer.cls));
  previous = race.racers.map((racer) => ({ ...racer.state }));
  accumulator = 0;
  finishedAt = null;
  rig.snap();
}

/** Behind the menus, the chosen ship cruises the chosen route on its own, with no hazards. */
function startMenuCruise(): void {
  useWorld(trackIndex);
  const cls = SHIP_CLASSES[shipIndex];
  beginRace([{ cls, name: cls.shipNames[0], isPlayer: true, pace: 0.5, autopilot: true }], {
    hazards: false,
    loop: true,
  });
  race.cruiseFrom(race.player, 0.02, 0.5);
  previous = race.racers.map((racer) => ({ ...racer.state }));
  world.course.setGatesVisible(false);
}

function startRace(): void {
  useWorld(trackIndex);
  const player = SHIP_CLASSES[shipIndex];
  const paces = shuffled(RIVAL_PACES);
  const rivals: RaceEntry[] = (solo ? [] : SHIP_CLASSES).map((cls, i) => ({
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
  beginRace(entries);
  world.course.setGatesVisible(true);
  ui.beginRace(race.track, rivals.length);
  setScreen('race');
}

function setScreen(next: ScreenId): void {
  screen = next;
  ui.show(next);
}

function openMenu(next: 'title' | 'ship' | 'track' | 'online' | 'lobby'): void {
  startMenuCruise();
  if (next === 'lobby') refreshLobby();
  ui.setShip(SHIP_CLASSES[shipIndex], shipIndex);
  ui.setTrackChoice(trackIndex);
  setScreen(next);
}

function stepShip(by: number): void {
  shipIndex = (shipIndex + by + SHIP_CLASSES.length) % SHIP_CLASSES.length;
  if (screen === 'lobby') {
    net?.session.setShip(shipIndex);
    openMenu('lobby');
  } else {
    openMenu('ship');
  }
}

const nowSeconds = (): number => performance.now() / 1000;

function refreshLobby(): void {
  if (!net || !net.session.lobby) return;
  const lobby = net.session.lobby;
  const me = net.role === 'host' ? HOST_ID : net.session.id;
  ui.setLobby({
    code: net.code,
    link: inviteLink(net.code),
    players: lobby.players.map((p) => ({
      name: p.name,
      shipName: SHIP_CLASSES[p.ship]?.name ?? '',
      isMe: p.id === me,
      isHost: p.id === HOST_ID,
    })),
    shipName: SHIP_CLASSES[shipIndex].name,
    trackName: TRACKS[lobby.track]?.name ?? '',
    isHost: net.role === 'host',
    racing: lobby.racing && !onlineRace,
  });
}

async function hostGame(): Promise<void> {
  if (connecting || net) return;
  connecting = true;
  ui.setOnlineStatus('Opening a room...');
  const session = new HostSession(ui.playerName, shipIndex, trackIndex);
  try {
    const room = await openRoom((link) => session.accept(link));
    const game: Net = { role: 'host', code: room.code, session, close: room.close, racers: new Map(), events: [] };
    net = game;
    session.onLobby = refreshLobby;
    session.onLeave = (id) => {
      // The AI takes over the ship of a player who drops out.
      const index = game.racers.get(id);
      game.racers.delete(id);
      if (index === undefined || !onlineRace) return;
      race.racers[index].helm = null;
      race.racers[index].autopilot = true;
    };
    session.onReset = (id) => {
      const index = game.racers.get(id);
      if (index === undefined || !onlineRace || race.phase !== 'racing') return;
      if (!race.racers[index].finished) race.resetToCheckpoint(race.racers[index]);
    };
    ui.setOnline('host');
    ui.setOnlineStatus('');
    openMenu('lobby');
  } catch (error) {
    ui.setOnlineStatus((error as Error).message);
  }
  connecting = false;
}

async function joinGame(): Promise<void> {
  if (connecting || net) return;
  const code = cleanCode(ui.roomCode);
  ui.roomCode = code;
  if (code.length < 5) return ui.setOnlineStatus('Enter the five-character code your friend sent you.');
  connecting = true;
  ui.setOnlineStatus('Connecting...');
  try {
    const room = await joinRoom(code);
    const session = new ClientSession(room.link, ui.playerName, shipIndex);
    const game: Net = { role: 'client', code, session, close: room.close, buffer: new SnapshotBuffer() };
    net = game;
    session.onLobby = () => {
      const track = session.lobby!.track;
      const changed = track !== trackIndex && track >= 0 && track < tracks.length;
      if (changed) trackIndex = track;
      if (screen === 'online' || (screen === 'lobby' && changed)) {
        ui.setOnline('client');
        ui.setOnlineStatus('');
        openMenu('lobby');
      } else {
        refreshLobby();
      }
    };
    session.onStart = (track, entries) => {
      if (track < 0 || track >= tracks.length || session.id === null) return;
      game.buffer = new SnapshotBuffer();
      beginOnlineRace(track, entries, session.id);
    };
    session.onSnapshot = (snap) => {
      if (onlineRace) game.buffer.push(snap, nowSeconds());
    };
    session.onToLobby = () => openMenu('lobby');
    session.onClosed = (reason) =>
      leaveOnline(reason === 'full' ? 'That game is full.' : 'The host ended the game, or the connection was lost.');
  } catch (error) {
    ui.setOnlineStatus((error as Error).message);
  }
  connecting = false;
}

/** Leave the game with friends and go back to the multiplayer menu. */
function leaveOnline(status = ''): void {
  if (!net) return;
  if (net.role === 'host') net.session.close();
  else net.session.leave();
  net.close();
  net = null;
  ui.setOnline(null);
  ui.setOnlineStatus(status);
  openMenu('online');
}

/** Line up the grid the host drew for a shared race. */
function beginOnlineRace(track: number, grid: EntrySpec[], me: string): void {
  trackIndex = track;
  useWorld(track);
  beginRace(entriesFor(grid, me));
  onlineRace = true;
  world.course.setGatesVisible(true);
  ui.beginRace(race.track, grid.length - 1);
  setScreen('race');
}

function startOnlineRace(): void {
  if (net?.role !== 'host') return;
  const grid = net.session.start();
  net.racers = new Map(
    grid.flatMap((entry, i): [string, number][] =>
      entry.playerId !== null && entry.playerId !== HOST_ID ? [[entry.playerId, i]] : [],
    ),
  );
  net.events = [];
  beginOnlineRace(net.session.lobby.track, grid, HOST_ID);
}

/** Race again: alone, or for everyone if hosting. Guests wait for the host. */
function raceAgain(): void {
  if (!net) startRace();
  else if (net.role === 'host') startOnlineRace();
}

function quitRace(): void {
  if (!net) return openMenu('ship');
  if (net.role === 'client') return leaveOnline();
  net.session.toLobby();
  openMenu('lobby');
}

function stepLobbyTrack(by: number): void {
  if (net?.role !== 'host' || screen !== 'lobby') return;
  trackIndex = (trackIndex + by + tracks.length) % tracks.length;
  net.session.setTrack(trackIndex);
  openMenu('lobby');
}

/** The guest's side of a shared race: show what the host says is happening. */
function followHost(buffer: SnapshotBuffer): void {
  for (const event of buffer.apply(race, nowSeconds())) {
    world.showHit(event);
    if (event.shipId === race.player.id) lastHit = { event, at: race.time };
  }
  race.racers.forEach((racer, i) => {
    const p = previous[i];
    p.x = racer.state.x;
    p.z = racer.state.z;
    p.heading = racer.state.heading;
  });
  accumulator = 0;
}

/** Send the race to the guests, or this guest's helm to the host. */
function exchange(): void {
  if (!net || !onlineRace) return;
  const now = nowSeconds();
  if (now - lastNetSend < 1 / NET_RATE) return;
  lastNetSend = now;
  if (net.role === 'host') net.session.sendSnapshot(takeSnapshot(race, now, net.events.splice(0)));
  else net.session.sendHelm(input.helm());
}

window.addEventListener('pagehide', () => net?.close());

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
      return raceAgain();
    case 'quit':
      return quitRace();
    case 'online':
      return setScreen('online');
    case 'host':
      return void hostGame();
    case 'join':
      return void joinGame();
    case 'leave':
      return leaveOnline();
    case 'lobby-start':
      return startOnlineRace();
    case 'track-step':
      return stepLobbyTrack(command.by);
    case 'copy-link':
      if (net) void navigator.clipboard?.writeText(inviteLink(net.code));
      return ui.linkCopied();
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
    case 'online':
      if (action === 'back') setScreen('title');
      break;
    case 'lobby':
      if (action === 'left') stepShip(-1);
      else if (action === 'right') stepShip(1);
      else if (action === 'confirm') startOnlineRace();
      break;
    case 'race':
      if (action === 'camera') rig.toggleMode();
      else if (action === 'pause') setScreen('paused');
      else if (action === 'reset' && race.phase === 'racing' && !race.player.finished) {
        // In a shared race only the host can move a ship.
        if (net?.role === 'client' && onlineRace) net.session.sendReset();
        else race.resetToCheckpoint(race.player);
        rig.snap();
      }
      break;
    case 'paused':
      if (action === 'pause' || action === 'confirm') setScreen('race');
      break;
    case 'results':
      if (action === 'confirm') raceAgain();
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
  const hosting = onlineRace && net?.role === 'host' ? net : null;
  if (hosting) {
    for (const [id, index] of hosting.racers) race.racers[index].helm = hosting.session.helmOf(id);
  }
  while (accumulator >= STEP && steps < MAX_STEPS_PER_FRAME) {
    race.racers.forEach((racer, i) => {
      const p = previous[i];
      p.x = racer.state.x;
      p.z = racer.state.z;
      p.heading = racer.state.heading;
    });
    race.step(STEP, helm);
    for (const event of race.events.splice(0)) {
      world.showHit(event);
      hosting?.events.push(event);
      if (event.shipId === race.player.id) lastHit = { event, at: race.time };
    }
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
    else if (lastHit && race.time - lastHit.at < HIT_MESSAGE_SECONDS) message = { text: hitMessage(lastHit.event), kind: 'warn' };
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

  // The nearest hazard still ahead on the route.
  let nextHazard: HudState['nextHazard'] = null;
  for (const hazard of race.hazards?.hazards ?? []) {
    const distance = (hazard.index - player.trackIndex) * spacing;
    if (distance < 0 || hazard.strength < 0.3) continue;
    if (!nextHazard || distance < nextHazard.distance) nextHazard = { name: HAZARD_NAMES[hazard.kind], distance };
  }
  if (!message && nextHazard && nextHazard.distance < HAZARD_WARNING_RANGE && race.phase === 'racing' && !player.finished) {
    message = { text: `${nextHazard.name} ahead`, kind: 'info' };
  }

  return {
    knots: toKnots(Math.abs(player.state.u)),
    throttle: player.state.throttle,
    rudder: player.state.rudder,
    position: standings.indexOf(player) + 1,
    fieldSize: race.racers.length,
    toGo: race.distanceToGo(player),
    raceTime: player.finished ? player.finishTime : race.time,
    nextHazard,
    hazardHits: player.hazardHits,
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

function hitMessage(event: HazardEvent): string {
  switch (event.kind) {
    case 'sharks':
      return 'Sharks! Get clear of them';
    case 'kraken':
      return 'The kraken has you';
    case 'pirate':
      return 'Cannon fire!';
    case 'wave':
      return event.heavy ? 'Slammed by the wave' : 'Rode the wave';
  }
}

function resultRows(): ResultRow[] {
  return race.standings().map((racer, i) => ({
    position: i + 1,
    name: racer.name,
    className: racer.cls.name,
    time: racer.finished ? formatTime(racer.finishTime) : 'Still at sea',
    note: racer.hazardHits === 1 ? 'Caught by 1 hazard' : `Caught by ${racer.hazardHits} hazards`,
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

  // A race shared with other players cannot be paused.
  const running = screen !== 'paused' || onlineRace;
  if (running) {
    clock += dt;
    if (onlineRace && net?.role === 'client') followHost(net.buffer);
    else simulate(dt);
  }
  exchange();

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
  const inMenu = screen === 'title' || screen === 'ship' || screen === 'track' || screen === 'online' || screen === 'lobby';

  if (inMenu) {
    const cls = player.cls;
    menuCentre.set(playerPose.x, cls.height * 0.35, playerPose.z);
    if (inspect) {
      rig.setFraming(0, 0);
      rig.orbit(menuCentre, cls.length * inspect.distance, cls.length * inspect.height, playerPose.heading + inspect.angle);
      world.update(clock, rig.camera, rig.focus);
      renderer.render(world.scene, rig.camera);
      return;
    }
    const wide = screen === 'title' ? 1.5 : 1.15;
    if (screen === 'ship' || screen === 'online' || screen === 'lobby') rig.setFraming(0.2, 0.04);
    else if (screen === 'track') rig.setFraming(0, 0.16);
    else rig.setFraming(0.1, -0.05);
    rig.orbit(menuCentre, cls.length * wide, cls.length * 0.2 * wide, playerPose.heading + 0.7 + clock * 0.1);
  } else {
    rig.setFraming(0, 0);
    if (running) {
      const view = views[race.racers.indexOf(player)];
      rig.follow({ ...playerPose, speed: player.state.u }, player.cls, view.bridge, dt);
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
      (race.hazards?.hazards ?? []).map((hazard) => ({ x: hazard.x, z: hazard.z, visible: hazard.strength > 0.3 })),
    );
  }

  if (race.hazards) world.updateHazards(race.hazards.hazards, clock, running ? dt : 0);
  world.update(clock, rig.camera, rig.focus);
  renderer.render(world.scene, rig.camera);
}

// ?demo=<route id>&ship=<class id> starts a race with the AI at the player's
// helm. &t=<seconds> runs the race ahead first, &near=<n> runs it until the
// player is coming up to the nth hazard, &solo leaves out the rivals, and
// &cam=bridge picks the camera.
// ?inspect=<class id>&angle=<radians>&dist=<lengths>&h=<lengths> shows one ship
// from a fixed angle with no menus, for checking the models.
const params = new URLSearchParams(location.search);
const demoTrack = params.get('demo');
if (demoTrack !== null) {
  demo = true;
  solo = params.has('solo');
  trackIndex = Math.max(0, TRACKS.findIndex((def) => def.id === demoTrack));
  shipIndex = Math.max(0, SHIP_CLASSES.findIndex((cls: ShipClass) => cls.id === params.get('ship')));
  if (params.get('cam') === 'bridge') rig.mode = 'bridge';
  startRace();
  const ahead = Number(params.get('t') ?? 0) + COUNTDOWN_SECONDS;
  for (let i = 0; i < ahead / STEP; i++) race.step(STEP, { throttle: 0, rudder: 0 });
  const near = race.hazards?.hazards[Number(params.get('near') ?? -1)];
  if (near) {
    const gap = Number(params.get('gap') ?? 500);
    for (let i = 0; i < 600 / STEP; i++) {
      if ((near.index - race.player.trackIndex) * race.track.spacing < gap) break;
      race.step(STEP, { throttle: 0, rudder: 0 });
    }
  }
  race.events.length = 0;
  previous = race.racers.map((racer) => ({ ...racer.state }));
} else if (params.get('inspect') !== null) {
  shipIndex = Math.max(0, SHIP_CLASSES.findIndex((cls: ShipClass) => cls.id === params.get('inspect')));
  trackIndex = Math.max(0, TRACKS.findIndex((def) => def.id === params.get('track')));
  inspect = {
    angle: Number(params.get('angle') ?? 0.7),
    distance: Number(params.get('dist') ?? 0.9),
    height: Number(params.get('h') ?? 0.2),
  };
  openMenu('ship');
  document.getElementById('ui')!.style.display = 'none';
} else if (params.get('room') !== null) {
  // An invite link: open the multiplayer menu with the code filled in.
  ui.roomCode = cleanCode(params.get('room')!);
  openMenu('online');
} else {
  openMenu('title');
}

requestAnimationFrame(frame);
