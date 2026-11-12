import type { Helm } from '../sim/physics';
import { SHIP_CLASSES } from '../sim/ships';
import {
  cleanHelm,
  cleanName,
  cleanShip,
  HOST_ID,
  MAX_PLAYERS,
  type ClientMessage,
  type EntrySpec,
  type HostMessage,
  type Lobby,
  type Snapshot,
} from './protocol';

/** A connection to one other player. Messages are plain JSON values. */
export interface Link {
  send(message: unknown): void;
  close(): void;
  onMessage: ((message: unknown) => void) | null;
  onClose: (() => void) | null;
}

const AI_PACES = [0.96, 0.94, 0.92, 0.9, 0.88];

function shuffled<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** The host's side of a game: owns the lobby, starts races and hears every player's helm. */
export class HostSession {
  readonly lobby: Lobby;
  /** Called when the lobby changes. */
  onLobby: (() => void) | null = null;
  /** Called when a player leaves. */
  onLeave: ((id: string) => void) | null = null;
  /** Called when a player asks to be put back at the last checkpoint. */
  onReset: ((id: string) => void) | null = null;
  /** Called when a player uses their power-up. */
  onUse: ((id: string) => void) | null = null;
  private readonly links = new Map<string, Link>();
  private readonly helms = new Map<string, Helm>();
  private nextId = 1;

  constructor(
    name: string,
    ship: number,
    track: number,
    private readonly rng: () => number = Math.random,
  ) {
    this.lobby = { players: [{ id: HOST_ID, name: cleanName(name), ship: cleanShip(ship) }], track, racing: false };
  }

  /** Take on a new connection. The player joins the lobby when they say hello. */
  accept(link: Link): void {
    let id: string | null = null;
    link.onMessage = (raw) => {
      const message = raw as ClientMessage;
      if (!message || typeof message !== 'object') return;
      if (id === null) {
        if (message.t !== 'hello') return;
        if (this.lobby.players.length >= MAX_PLAYERS) {
          link.send({ t: 'full' } satisfies HostMessage);
          link.close();
          return;
        }
        id = `p${this.nextId++}`;
        this.links.set(id, link);
        this.lobby.players.push({ id, name: cleanName(message.name), ship: cleanShip(message.ship) });
        this.lobbyChanged();
        return;
      }
      if (message.t === 'ship') {
        const player = this.lobby.players.find((p) => p.id === id);
        if (player) player.ship = cleanShip(message.ship);
        this.lobbyChanged();
      } else if (message.t === 'helm') {
        this.helms.set(id, cleanHelm(message.throttle, message.rudder));
      } else if (message.t === 'reset') {
        this.onReset?.(id);
      } else if (message.t === 'use') {
        this.onUse?.(id);
      }
    };
    link.onClose = () => {
      if (id === null || !this.links.has(id)) return;
      this.links.delete(id);
      this.helms.delete(id);
      this.lobby.players = this.lobby.players.filter((p) => p.id !== id);
      this.onLeave?.(id);
      this.lobbyChanged();
    };
  }

  setShip(ship: number): void {
    this.lobby.players[0].ship = cleanShip(ship);
    this.lobbyChanged();
  }

  setTrack(track: number): void {
    this.lobby.track = track;
    this.lobbyChanged();
  }

  /** Draw up the grid for a race, with AI ships making up the numbers, and tell everyone. */
  start(): EntrySpec[] {
    const used = new Map<number, number>();
    const entries: EntrySpec[] = this.lobby.players.map((p) => ({
      ship: p.ship,
      name: p.name,
      pace: 0.95,
      playerId: p.id,
    }));
    const paces = shuffled(AI_PACES, this.rng);
    for (let i = 0; entries.length < MAX_PLAYERS; i++) {
      const ship = i % SHIP_CLASSES.length;
      const names = SHIP_CLASSES[ship].shipNames;
      const n = used.get(ship) ?? 0;
      used.set(ship, n + 1);
      entries.push({ ship, name: names[n % names.length], pace: paces[i % paces.length], playerId: null });
    }
    const grid = shuffled(entries, this.rng);
    this.helms.clear();
    this.lobby.racing = true;
    this.broadcast({ t: 'start', track: this.lobby.track, entries: grid });
    this.lobbyChanged();
    return grid;
  }

  /** End the race and bring everyone back to the lobby. */
  toLobby(): void {
    this.lobby.racing = false;
    this.broadcast({ t: 'to-lobby' });
    this.lobbyChanged();
  }

  /** The latest helm orders from a player. */
  helmOf(id: string): Helm {
    return this.helms.get(id) ?? { throttle: 0, rudder: 0 };
  }

  sendSnapshot(snap: Snapshot): void {
    this.broadcast({ t: 'snap', snap });
  }

  close(): void {
    for (const link of this.links.values()) link.close();
    this.links.clear();
  }

  private lobbyChanged(): void {
    for (const [id, link] of this.links) link.send({ t: 'lobby', lobby: this.lobby, you: id } satisfies HostMessage);
    this.onLobby?.();
  }

  private broadcast(message: HostMessage): void {
    for (const link of this.links.values()) link.send(message);
  }
}

export type ClosedReason = 'full' | 'lost';

/** A joining player's side of a game. */
export class ClientSession {
  /** This player's id, once the host has given one. */
  id: string | null = null;
  lobby: Lobby | null = null;
  onLobby: (() => void) | null = null;
  onStart: ((track: number, entries: EntrySpec[]) => void) | null = null;
  onSnapshot: ((snap: Snapshot) => void) | null = null;
  onToLobby: (() => void) | null = null;
  /** Called once if the game ends other than by this player leaving. */
  onClosed: ((reason: ClosedReason) => void) | null = null;
  private done = false;

  constructor(private readonly link: Link, name: string, ship: number) {
    link.onMessage = (raw) => {
      const message = raw as HostMessage;
      if (!message || typeof message !== 'object' || this.done) return;
      if (message.t === 'lobby') {
        this.id = message.you;
        this.lobby = message.lobby;
        this.onLobby?.();
      } else if (message.t === 'start') {
        if (this.id !== null) this.onStart?.(message.track, message.entries);
      } else if (message.t === 'snap') {
        this.onSnapshot?.(message.snap);
      } else if (message.t === 'to-lobby') {
        this.onToLobby?.();
      } else if (message.t === 'full') {
        this.finish('full');
      }
    };
    link.onClose = () => this.finish('lost');
    this.send({ t: 'hello', name: cleanName(name), ship: cleanShip(ship) });
  }

  setShip(ship: number): void {
    this.send({ t: 'ship', ship });
  }

  sendHelm(helm: Helm): void {
    this.send({ t: 'helm', throttle: helm.throttle, rudder: helm.rudder });
  }

  sendReset(): void {
    this.send({ t: 'reset' });
  }

  sendUse(): void {
    this.send({ t: 'use' });
  }

  leave(): void {
    this.done = true;
    this.link.close();
  }

  private send(message: ClientMessage): void {
    if (!this.done) this.link.send(message);
  }

  private finish(reason: ClosedReason): void {
    if (this.done) return;
    this.done = true;
    this.onClosed?.(reason);
  }
}
