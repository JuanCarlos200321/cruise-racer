import { SHIP_CLASSES, statBars, toKnots, type ShipClass } from '../sim/ships';
import { Track, type TrackDef } from '../sim/track';
import { Minimap } from './minimap';

export type ScreenId = 'title' | 'ship' | 'track' | 'online' | 'lobby' | 'race' | 'paused' | 'results';

export type UiCommand =
  | { type: 'start' }
  | { type: 'ship-step'; by: number }
  | { type: 'ship-confirm' }
  | { type: 'track-pick'; index: number }
  | { type: 'track-confirm' }
  | { type: 'track-step'; by: number }
  | { type: 'online' }
  | { type: 'host' }
  | { type: 'join' }
  | { type: 'leave' }
  | { type: 'lobby-start' }
  | { type: 'copy-link' }
  | { type: 'back' }
  | { type: 'resume' }
  | { type: 'restart' }
  | { type: 'quit' };

export interface HudState {
  knots: number;
  throttle: number;
  rudder: number;
  position: number;
  fieldSize: number;
  /** Metres still to go to the finish line. */
  toGo: number;
  raceTime: number;
  /** Name and distance in metres of the next hazard ahead, if there is one. */
  nextHazard: { name: string; distance: number } | null;
  hazardHits: number;
  /** State of the hull, 1 to 0. */
  hull: number;
  /** The power-up in hand. */
  item: { name: string; hint: string } | null;
  /** Seconds of boost and shield left. */
  boost: number;
  shield: number;
  /** Seconds to the start, or negative once racing. */
  countdown: number;
  message: { text: string; kind: 'warn' | 'info' } | null;
  board: { position: number; name: string; gap: string; isPlayer: boolean }[];
  tags: { text: string; x: number; y: number; visible: boolean }[];
}

export interface ResultRow {
  position: number;
  name: string;
  className: string;
  time: string;
  note: string;
  isPlayer: boolean;
}

/** What the lobby screen shows. */
export interface LobbyView {
  code: string;
  link: string;
  players: { name: string; shipName: string; isMe: boolean; isHost: boolean }[];
  shipName: string;
  trackName: string;
  isHost: boolean;
  /** The host has a race under way that this player is not in. */
  racing: boolean;
  /** This player is connected through the relay rather than straight to the host. */
  relayed: boolean;
}

const NAME_KEY = 'cruise-racer-name';

/** Text made safe to put into HTML. Names come from other players. */
function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, '0')}`;
}

const ordinal = (n: number): string => ['1st', '2nd', '3rd'][n - 1] ?? `${n}th`;

const TEMPLATE = /* html */ `
<section class="screen" id="title">
  <div class="logo">
    <h1>Cruise<br /><span>Racer</span></h1>
    <div class="tagline">250,000 tons. Open water. Sharks, pirates and a kraken.</div>
  </div>
  <div class="start">
    <button class="primary" data-cmd="start">Set sail</button>
    <button data-cmd="online">Play with friends</button>
    <span class="hint">or press <kbd>Enter</kbd></span>
  </div>
</section>

<section class="screen" id="ship">
  <div class="menu-header">
    <div class="label">Step 1 of 2</div>
    <h2 class="heading">Choose your ship</h2>
  </div>
  <div class="dots" id="ship-dots"></div>
  <div class="arrows">
    <button data-cmd="ship-prev" aria-label="Previous ship">&#9664;</button>
    <button data-cmd="ship-next" aria-label="Next ship">&#9654;</button>
  </div>
  <div class="ship-card">
    <div class="label" id="ship-class"></div>
    <h3 class="heading" id="ship-name"></h3>
    <div class="lead" id="ship-sisters"></div>
    <p id="ship-tagline"></p>
    <div id="ship-stats"></div>
    <div class="specs">
      <div><span class="label">Length</span><b id="ship-length"></b></div>
      <div><span class="label">Beam</span><b id="ship-beam"></b></div>
      <div><span class="label">Race speed</span><b id="ship-speed"></b></div>
    </div>
  </div>
  <div class="menu-footer">
    <span class="keys"><kbd>&larr;</kbd> <kbd>&rarr;</kbd> browse &nbsp; <kbd>Enter</kbd> select &nbsp; <kbd>Backspace</kbd> back</span>
    <button class="primary" data-cmd="ship-confirm">Select ship</button>
  </div>
</section>

<section class="screen" id="track">
  <div class="menu-header">
    <div class="label">Step 2 of 2</div>
    <h2 class="heading">Choose your voyage</h2>
  </div>
  <div class="track-cards" id="track-cards"></div>
  <div class="menu-footer">
    <span class="keys"><kbd>&larr;</kbd> <kbd>&rarr;</kbd> browse &nbsp; <kbd>Enter</kbd> race &nbsp; <kbd>Backspace</kbd> back</span>
    <button class="primary" data-cmd="track-confirm">Start race</button>
  </div>
</section>

<section class="screen" id="online">
  <div class="menu-header">
    <div class="label">Multiplayer</div>
    <h2 class="heading">Play with friends</h2>
  </div>
  <div class="side-panel">
    <label class="label" for="online-name">Your name</label>
    <input id="online-name" maxlength="16" autocomplete="off" spellcheck="false" placeholder="Captain" />
    <p>Start a game and send your friends the link, up to six players. Empty places are filled by AI ships.</p>
    <button class="primary" data-cmd="host">Host a game</button>
    <p>Or join a friend's game with their code.</p>
    <div class="field-row">
      <input id="online-code" maxlength="5" autocomplete="off" spellcheck="false" placeholder="CODE" />
      <button data-cmd="join">Join</button>
    </div>
    <div id="online-status"></div>
  </div>
  <div class="menu-footer">
    <button data-cmd="back">Back</button>
  </div>
</section>

<section class="screen" id="lobby">
  <div class="menu-header">
    <div class="label">Game code</div>
    <h2 class="heading" id="lobby-code"></h2>
  </div>
  <div class="side-panel">
    <div class="label">Invite link</div>
    <div class="field-row">
      <input id="lobby-link" readonly />
      <button data-cmd="copy-link" id="lobby-copy">Copy</button>
    </div>
    <div class="label">Players</div>
    <div id="lobby-players"></div>
    <div class="picker">
      <span class="label">Your ship</span>
      <button data-cmd="ship-prev" aria-label="Previous ship">&#9664;</button>
      <b id="lobby-ship"></b>
      <button data-cmd="ship-next" aria-label="Next ship">&#9654;</button>
    </div>
    <div class="picker" id="lobby-voyage">
      <span class="label">Voyage</span>
      <button data-cmd="track-prev" aria-label="Previous voyage">&#9664;</button>
      <b id="lobby-track"></b>
      <button data-cmd="track-next" aria-label="Next voyage">&#9654;</button>
    </div>
    <div id="lobby-note"></div>
  </div>
  <div class="menu-footer">
    <button data-cmd="leave">Leave game</button>
    <button class="primary" data-cmd="lobby-start" id="lobby-start">Start race</button>
  </div>
</section>

<section class="screen" id="race">
  <div id="hud-tags"></div>
  <div class="hud-box" id="hud-position">
    <div class="label">Position</div>
    <div class="big"><span id="hud-pos"></span><small id="hud-field"></small></div>
  </div>
  <div class="hud-box" id="hud-board"></div>
  <div class="hud-box" id="hud-lap">
    <div class="label" id="hud-destination"></div>
    <div class="big" id="hud-to-go"></div>
    <div class="times">
      <span>Time</span><b id="hud-race-time"></b>
      <span>Next hazard</span><b id="hud-next-hazard"></b>
      <span>Hazards hit</span><b id="hud-hazard-hits"></b>
    </div>
  </div>
  <div class="hud-box" id="hud-map"><canvas id="hud-map-canvas"></canvas></div>
  <div class="hud-box" id="hud-speed">
    <div class="big" id="hud-knots"></div>
    <div class="unit">KNOTS</div>
    <div class="gauge"><i id="hud-throttle"></i></div>
    <div class="gauge-label"><span>ASTERN</span><span>ENGINES</span><span>AHEAD</span></div>
    <div class="gauge"><i id="hud-rudder"></i></div>
    <div class="gauge-label"><span>PORT</span><span>RUDDER</span><span>STBD</span></div>
    <div class="gauge hull"><i id="hud-hull"></i></div>
    <div class="gauge-label"><span></span><span id="hud-hull-label">HULL</span><span></span></div>
  </div>
  <div class="hud-box" id="hud-item">
    <div class="label">Power-up</div>
    <div class="name" id="hud-item-name"></div>
    <div class="hint" id="hud-item-hint"></div>
    <div class="active" id="hud-item-active"></div>
  </div>
  <div id="hud-message"></div>
  <div id="hud-countdown"></div>
  <div id="hud-keys">
    <kbd>W</kbd> ahead &nbsp; <kbd>S</kbd> astern &nbsp; <kbd>A</kbd> <kbd>D</kbd> rudder &nbsp; <kbd>Space</kbd> power-up &nbsp;
    <kbd>C</kbd> camera &nbsp; <kbd>R</kbd> reset &nbsp; <kbd>Esc</kbd> pause
  </div>
</section>

<section class="screen overlay" id="paused">
  <div class="dialog">
    <div class="label" id="paused-label">Engines stopped</div>
    <h2 class="heading" id="paused-title">Paused</h2>
    <div class="controls-list">
      <span><kbd>W</kbd> / <kbd>&uarr;</kbd></span><span>Engines ahead</span>
      <span><kbd>S</kbd> / <kbd>&darr;</kbd></span><span>Engines astern (this is your brake)</span>
      <span><kbd>A</kbd> <kbd>D</kbd> / <kbd>&larr;</kbd> <kbd>&rarr;</kbd></span><span>Rudder to port and starboard</span>
      <span><kbd>C</kbd></span><span>Switch between chase and bridge camera</span>
      <span><kbd>R</kbd></span><span>Reset to the last checkpoint</span>
      <span>Gamepad</span><span>Triggers for engines, left stick for rudder</span>
    </div>
    <div class="buttons">
      <button class="primary" data-cmd="resume">Resume</button>
      <button data-cmd="restart">Restart race</button>
      <button data-cmd="quit" data-offline="Quit to menu">Quit to menu</button>
    </div>
  </div>
</section>

<section class="screen overlay" id="results">
  <div class="dialog">
    <div class="label" id="results-track"></div>
    <h2 class="heading" id="results-title"></h2>
    <table class="results-table" id="results-table"></table>
    <div class="buttons">
      <button class="primary" data-cmd="restart">Race again</button>
      <button data-cmd="quit" data-offline="Change ship or voyage">Change ship or voyage</button>
    </div>
  </div>
</section>
`;

/** All DOM screens: menus, the race HUD and overlays. */
export class Ui {
  private readonly root: HTMLElement;
  private readonly listeners: ((command: UiCommand) => void)[] = [];
  private readonly map: Minimap;
  private readonly trackMaps: Minimap[] = [];
  private readonly tagElements: HTMLElement[] = [];
  private lastBoard = '';

  constructor(root: HTMLElement, tracks: TrackDef[]) {
    this.root = root;
    root.innerHTML = TEMPLATE;

    this.el('ship-dots').innerHTML = SHIP_CLASSES.map(() => '<i></i>').join('');
    this.el('track-cards').innerHTML = tracks
      .map(
        (def, i) => /* html */ `
        <div class="track-card" data-track="${i}">
          <canvas></canvas>
          <h3 class="heading">${def.name}</h3>
          <p>${def.description}</p>
          <div class="label" data-length></div>
        </div>`,
      )
      .join('');
    root.querySelectorAll<HTMLElement>('.track-card').forEach((card, i) => {
      const track = new Track(tracks[i]);
      const map = new Minimap(card.querySelector('canvas')!, 300, 150);
      map.setTrack(track);
      map.draw();
      this.trackMaps.push(map);
      card.querySelector('[data-length]')!.textContent =
        `${(track.raceLength / 1852).toFixed(1)} nautical miles · ${tracks[i].hazards.length} hazards`;
      card.addEventListener('click', () => {
        const wasSelected = card.classList.contains('on');
        this.emit({ type: 'track-pick', index: i });
        if (wasSelected) this.emit({ type: 'track-confirm' });
      });
    });

    const name = this.el<HTMLInputElement>('online-name');
    try {
      name.value = localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      // Private browsing: start with no name.
    }
    const code = this.el<HTMLInputElement>('online-code');
    code.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.emit({ type: 'join' });
    });
    this.el<HTMLInputElement>('lobby-link').addEventListener('focus', (event) =>
      (event.target as HTMLInputElement).select(),
    );

    this.map = new Minimap(this.el<HTMLCanvasElement>('hud-map-canvas'), 220);

    root.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-cmd]');
      if (!button) return;
      button.blur();
      const cmd = button.dataset.cmd!;
      if (cmd === 'ship-prev') this.emit({ type: 'ship-step', by: -1 });
      else if (cmd === 'ship-next') this.emit({ type: 'ship-step', by: 1 });
      else if (cmd === 'track-prev') this.emit({ type: 'track-step', by: -1 });
      else if (cmd === 'track-next') this.emit({ type: 'track-step', by: 1 });
      else this.emit({ type: cmd } as UiCommand);
    });
  }

  /** The name the player has typed, remembered between visits. */
  get playerName(): string {
    const name = this.el<HTMLInputElement>('online-name').value.trim();
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      // Private browsing: the name just is not remembered.
    }
    return name;
  }

  get roomCode(): string {
    return this.el<HTMLInputElement>('online-code').value;
  }

  set roomCode(code: string) {
    this.el<HTMLInputElement>('online-code').value = code;
  }

  /** A line under the host and join buttons: progress, or what went wrong. */
  setOnlineStatus(text: string): void {
    this.el('online-status').textContent = text;
  }

  setLobby(view: LobbyView): void {
    this.el('lobby-code').textContent = view.code;
    this.el<HTMLInputElement>('lobby-link').value = view.link;
    this.el('lobby-players').innerHTML = view.players
      .map(
        (p) => /* html */ `
        <div class="row${p.isMe ? ' me' : ''}">
          <span>${esc(p.name)}${p.isHost ? ' <small>host</small>' : ''}</span><span>${esc(p.shipName)}</span>
        </div>`,
      )
      .join('');
    this.el('lobby-ship').textContent = view.shipName;
    this.el('lobby-track').textContent = view.trackName;
    this.el('lobby-voyage').classList.toggle('fixed', !view.isHost);
    this.el('lobby-start').style.display = view.isHost ? '' : 'none';
    let note = '';
    if (view.racing) note = 'A race is under way. You will be in the next one.';
    else if (!view.isHost) note = 'Waiting for the host to start the race.';
    if (view.relayed) note += ' Connected through the relay.';
    else if (view.players.length === 1) note = 'Waiting for friends to join. You can start whenever you like.';
    this.el('lobby-note').textContent = note;
  }

  /** Briefly confirm that the invite link was copied. */
  linkCopied(): void {
    const button = this.el('lobby-copy');
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = 'Copy'), 1500);
  }

  /** Fit the pause and results buttons to who is playing: alone, as host, or as a guest. */
  setOnline(role: 'host' | 'client' | null): void {
    this.root.classList.toggle('guest', role === 'client');
    this.root.querySelectorAll<HTMLElement>('[data-cmd="quit"]').forEach((button) => {
      button.textContent = role === 'host' ? 'Back to lobby' : role === 'client' ? 'Leave game' : button.dataset.offline!;
    });
    this.el('paused-label').textContent = role ? 'The race goes on' : 'Engines stopped';
    this.el('paused-title').textContent = role ? 'Menu' : 'Paused';
  }

  onCommand(listener: (command: UiCommand) => void): void {
    this.listeners.push(listener);
  }

  /** Show one screen. Overlays (paused, results) keep the race HUD visible beneath. */
  show(screen: ScreenId): void {
    const hudToo = screen === 'paused' || screen === 'results';
    this.root.querySelectorAll<HTMLElement>('.screen').forEach((section) => {
      const active = section.id === screen || (hudToo && section.id === 'race');
      section.classList.toggle('active', active);
    });
  }

  setShip(cls: ShipClass, index: number): void {
    this.el('ship-class').textContent = cls.name;
    this.el('ship-name').textContent = cls.shipNames[0];
    this.el('ship-sisters').textContent = `Sister ships: ${cls.shipNames.slice(1).join(', ')}`;
    this.el('ship-tagline').textContent = cls.tagline;
    this.el('ship-length').textContent = `${cls.length} m`;
    this.el('ship-beam').textContent = `${cls.beam} m`;
    this.el('ship-speed').textContent = `${toKnots(cls.topSpeed).toFixed(1)} kn`;
    this.el('ship-stats').innerHTML = statBars(cls)
      .map(
        (stat) => /* html */ `
        <div class="stat"><span>${stat.label}</span>
          <div class="bar"><i style="width:${Math.round(stat.value * 100)}%"></i></div>
        </div>`,
      )
      .join('');
    this.el('ship-dots')
      .querySelectorAll('i')
      .forEach((dot, i) => dot.classList.toggle('on', i === index));
  }

  setTrackChoice(index: number): void {
    this.root
      .querySelectorAll('.track-card')
      .forEach((card, i) => card.classList.toggle('on', i === index));
  }

  /** Prepare the HUD for a race on a route with a given number of rivals. */
  beginRace(track: Track, rivals: number): void {
    this.map.setTrack(track);
    this.el('hud-destination').textContent = `To ${track.def.to}`;
    const tags = this.el('hud-tags');
    tags.innerHTML = '';
    this.tagElements.length = 0;
    for (let i = 0; i < rivals; i++) {
      const tag = document.createElement('div');
      tag.className = 'rival-tag';
      tags.appendChild(tag);
      this.tagElements.push(tag);
    }
    this.lastBoard = '';
  }

  drawMap(
    markers: Parameters<Minimap['draw']>[0],
    nextCheckpoint: number,
    dangers: Parameters<Minimap['draw']>[2],
  ): void {
    this.map.draw(markers, nextCheckpoint, dangers);
  }

  updateHud(hud: HudState): void {
    this.el('hud-knots').textContent = hud.knots.toFixed(1);
    this.el('hud-pos').textContent = ordinal(hud.position);
    this.el('hud-field').textContent = ` / ${hud.fieldSize}`;
    this.el('hud-to-go').textContent = hud.toGo > 0 ? `${(hud.toGo / 1852).toFixed(1)} nm` : 'Arrived';
    this.el('hud-race-time').textContent = formatTime(hud.raceTime);
    this.el('hud-next-hazard').textContent = hud.nextHazard
      ? `${hud.nextHazard.name} · ${Math.round(hud.nextHazard.distance / 50) * 50} m`
      : 'None';
    this.el('hud-hazard-hits').textContent = String(hud.hazardHits);

    this.setGauge('hud-throttle', hud.throttle);
    this.setGauge('hud-rudder', hud.rudder);

    const hull = this.el('hud-hull');
    hull.style.width = `${Math.max(0, hud.hull) * 100}%`;
    hull.className = hud.hull < 0.5 ? 'critical' : hud.hull < 0.9 ? 'damaged' : '';
    // Three collisions sink a ship.
    this.el('hud-hull-label').textContent = `HULL ${Math.round(Math.max(0, hud.hull) * 3)}/3`;
    this.el('hud-item').classList.toggle('empty', !hud.item);
    this.el('hud-item-name').textContent = hud.item?.name ?? 'None';
    this.el('hud-item-hint').textContent = hud.item ? `${hud.item.hint} · Space` : 'Sail through a gift box';
    const active = [
      hud.boost > 0 ? `Boost ${hud.boost.toFixed(1)}s` : '',
      hud.shield > 0 ? `Shield ${Math.ceil(hud.shield)}s` : '',
    ].filter(Boolean);
    this.el('hud-item-active').textContent = active.join(' · ');

    const countdown = this.el('hud-countdown');
    if (hud.countdown > 0) {
      countdown.textContent = hud.countdown > 3 ? '' : String(Math.ceil(hud.countdown));
      countdown.classList.remove('go');
    } else if (hud.raceTime < 1.5) {
      countdown.textContent = 'GO';
      countdown.classList.add('go');
    } else {
      countdown.textContent = '';
    }

    const message = this.el('hud-message');
    message.style.display = hud.message ? 'block' : 'none';
    if (hud.message) {
      message.textContent = hud.message.text;
      message.classList.toggle('info', hud.message.kind === 'info');
    }

    const board = hud.board
      .map(
        (row) => /* html */ `
        <div class="row${row.isPlayer ? ' me' : ''}">
          <span>${row.position}</span><span>${esc(row.name)}</span><span>${row.gap}</span>
        </div>`,
      )
      .join('');
    if (board !== this.lastBoard) {
      this.el('hud-board').innerHTML = board;
      this.lastBoard = board;
    }

    hud.tags.forEach((tag, i) => {
      const element = this.tagElements[i];
      if (!element) return;
      element.style.display = tag.visible ? 'block' : 'none';
      if (!tag.visible) return;
      element.textContent = tag.text;
      element.style.left = `${tag.x}px`;
      element.style.top = `${tag.y}px`;
    });
  }

  showResults(trackName: string, playerPosition: number, rows: ResultRow[]): void {
    this.el('results-track').textContent = trackName;
    this.el('results-title').textContent =
      playerPosition === 1 ? 'First into port' : `You arrived ${ordinal(playerPosition)}`;
    this.el('results-table').innerHTML = rows
      .map(
        (row) => /* html */ `
        <tr class="${row.isPlayer ? 'me' : ''}">
          <td>${row.position}</td>
          <td>${esc(row.name)}<div class="cls">${row.className}</div></td>
          <td>${row.time}<div class="cls">${row.note}</div></td>
        </tr>`,
      )
      .join('');
  }

  private setGauge(id: string, value: number): void {
    const bar = this.el(id);
    const half = Math.min(1, Math.abs(value)) * 50;
    bar.style.left = value >= 0 ? '50%' : `${50 - half}%`;
    bar.style.width = `${half}%`;
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = this.root.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`Missing UI element #${id}`);
    return element;
  }

  private emit(command: UiCommand): void {
    for (const listener of this.listeners) listener(command);
  }
}
