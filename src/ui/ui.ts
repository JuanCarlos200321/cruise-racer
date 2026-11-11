import { SHIP_CLASSES, statBars, toKnots, type ShipClass } from '../sim/ships';
import { Track, type TrackDef } from '../sim/track';
import { Minimap } from './minimap';

export type ScreenId = 'title' | 'ship' | 'track' | 'race' | 'paused' | 'results';

export type UiCommand =
  | { type: 'start' }
  | { type: 'ship-step'; by: number }
  | { type: 'ship-confirm' }
  | { type: 'track-pick'; index: number }
  | { type: 'track-confirm' }
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
  lap: number;
  totalLaps: number;
  raceTime: number;
  lapTime: number;
  bestLap: number | null;
  lastLap: number | null;
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
  bestLap: string;
  isPlayer: boolean;
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
    <div class="tagline">250,000 tons. Three laps. No brakes.</div>
  </div>
  <div class="start">
    <button class="primary" data-cmd="start">Set sail</button>
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
    <h2 class="heading">Choose your course</h2>
  </div>
  <div class="track-cards" id="track-cards"></div>
  <div class="menu-footer">
    <span class="keys"><kbd>&larr;</kbd> <kbd>&rarr;</kbd> browse &nbsp; <kbd>Enter</kbd> race &nbsp; <kbd>Backspace</kbd> back</span>
    <button class="primary" data-cmd="track-confirm">Start race</button>
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
    <div class="label">Lap</div>
    <div class="big" id="hud-lap-count"></div>
    <div class="times">
      <span>Race</span><b id="hud-race-time"></b>
      <span>Lap</span><b id="hud-lap-time"></b>
      <span>Last</span><b id="hud-last-lap"></b>
      <span>Best</span><b id="hud-best-lap"></b>
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
  </div>
  <div id="hud-message"></div>
  <div id="hud-countdown"></div>
  <div id="hud-keys">
    <kbd>W</kbd> ahead &nbsp; <kbd>S</kbd> astern &nbsp; <kbd>A</kbd> <kbd>D</kbd> rudder &nbsp;
    <kbd>C</kbd> camera &nbsp; <kbd>R</kbd> reset &nbsp; <kbd>Esc</kbd> pause
  </div>
</section>

<section class="screen overlay" id="paused">
  <div class="dialog">
    <div class="label">Engines stopped</div>
    <h2 class="heading">Paused</h2>
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
      <button data-cmd="quit">Quit to menu</button>
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
      <button data-cmd="quit">Change ship or course</button>
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
        `${(track.length / 1852).toFixed(1)} nautical miles · 3 laps`;
      card.addEventListener('click', () => {
        const wasSelected = card.classList.contains('on');
        this.emit({ type: 'track-pick', index: i });
        if (wasSelected) this.emit({ type: 'track-confirm' });
      });
    });

    this.map = new Minimap(this.el<HTMLCanvasElement>('hud-map-canvas'), 220);

    root.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-cmd]');
      if (!button) return;
      button.blur();
      const cmd = button.dataset.cmd!;
      if (cmd === 'ship-prev') this.emit({ type: 'ship-step', by: -1 });
      else if (cmd === 'ship-next') this.emit({ type: 'ship-step', by: 1 });
      else this.emit({ type: cmd } as UiCommand);
    });
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

  /** Prepare the HUD for a race on a track with a given number of rivals. */
  beginRace(track: Track, rivals: number): void {
    this.map.setTrack(track);
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

  drawMap(markers: Parameters<Minimap['draw']>[0], nextCheckpoint: number): void {
    this.map.draw(markers, nextCheckpoint);
  }

  updateHud(hud: HudState): void {
    this.el('hud-knots').textContent = hud.knots.toFixed(1);
    this.el('hud-pos').textContent = ordinal(hud.position);
    this.el('hud-field').textContent = ` / ${hud.fieldSize}`;
    this.el('hud-lap-count').textContent = `${hud.lap} / ${hud.totalLaps}`;
    this.el('hud-race-time').textContent = formatTime(hud.raceTime);
    this.el('hud-lap-time').textContent = formatTime(hud.lapTime);
    this.el('hud-last-lap').textContent = hud.lastLap === null ? '-:--.--' : formatTime(hud.lastLap);
    this.el('hud-best-lap').textContent = hud.bestLap === null ? '-:--.--' : formatTime(hud.bestLap);

    this.setGauge('hud-throttle', hud.throttle);
    this.setGauge('hud-rudder', hud.rudder);

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
          <span>${row.position}</span><span>${row.name}</span><span>${row.gap}</span>
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
      playerPosition === 1 ? 'You win' : `You finished ${ordinal(playerPosition)}`;
    this.el('results-table').innerHTML = rows
      .map(
        (row) => /* html */ `
        <tr class="${row.isPlayer ? 'me' : ''}">
          <td>${row.position}</td>
          <td>${row.name}<div class="cls">${row.className}</div></td>
          <td>${row.time}<div class="cls">${row.bestLap}</div></td>
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
