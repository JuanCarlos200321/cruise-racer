import { Peer, type DataConnection } from 'peerjs';
import { joinRelayRoom, openRelayRoom } from './relay';
import type { Link } from './session';

/** Room codes become PeerJS ids with this in front, so they do not clash with other apps. */
const PREFIX = 'cruise-racer-v2-';
/** No letters or digits that are easily mistaken for each other. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
/** How long to try a direct connection before falling back to the relay. */
const DIRECT_TIMEOUT = 8000;

export interface Room {
  code: string;
  close(): void;
}

function randomCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return code;
}

export function cleanCode(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
}

/**
 * With ?net=local in the address, games connect between tabs of one browser
 * instead of over the internet. For trying multiplayer out on one computer.
 */
const LOCAL = new URLSearchParams(location.search).get('net') === 'local';

/** The address friends open to join a room. */
export function inviteLink(code: string): string {
  return `${location.origin}${location.pathname}?room=${code}${LOCAL ? '&net=local' : ''}`;
}

interface LocalPacket {
  to: string;
  from: string;
  kind: 'open' | 'data' | 'close';
  data?: unknown;
}

/** One end of a connection between two tabs, over a channel the whole room shares. */
function localLink(channel: BroadcastChannel, me: string, other: string): Link & { receive(packet: LocalPacket): void } {
  let open = true;
  const link = {
    send: (message: unknown) => {
      if (open) channel.postMessage({ to: other, from: me, kind: 'data', data: message } satisfies LocalPacket);
    },
    close: () => {
      if (!open) return;
      open = false;
      channel.postMessage({ to: other, from: me, kind: 'close' } satisfies LocalPacket);
    },
    onMessage: null as Link['onMessage'],
    onClose: null as Link['onClose'],
    receive: (packet: LocalPacket) => {
      if (!open) return;
      if (packet.kind === 'data') link.onMessage?.(packet.data);
      else if (packet.kind === 'close') {
        open = false;
        link.onClose?.();
      }
    },
  };
  return link;
}

function openLocalRoom(onLink: (link: Link) => void): Room {
  const code = randomCode();
  const channel = new BroadcastChannel(PREFIX + code);
  const links = new Map<string, ReturnType<typeof localLink>>();
  channel.onmessage = (event: MessageEvent<LocalPacket>) => {
    const packet = event.data;
    if (packet.to !== 'host') return;
    if (packet.kind === 'open' && !links.has(packet.from)) {
      const link = localLink(channel, 'host', packet.from);
      links.set(packet.from, link);
      channel.postMessage({ to: packet.from, from: 'host', kind: 'open' } satisfies LocalPacket);
      onLink(link);
    } else {
      links.get(packet.from)?.receive(packet);
    }
  };
  return {
    code,
    close: () => {
      for (const link of links.values()) link.close();
      channel.close();
    },
  };
}

function joinLocalRoom(code: string): Promise<{ link: Link; close(): void }> {
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel(PREFIX + code);
    const me = `tab-${Math.random().toString(36).slice(2)}`;
    const link = localLink(channel, me, 'host');
    const timer = setTimeout(() => {
      channel.close();
      reject(new Error(`There is no game with the code ${code} in this browser.`));
    }, 1500);
    channel.onmessage = (event: MessageEvent<LocalPacket>) => {
      const packet = event.data;
      if (packet.to !== me) return;
      if (packet.kind === 'open') {
        clearTimeout(timer);
        resolve({
          link,
          close: () => {
            link.close();
            channel.close();
          },
        });
      } else {
        link.receive(packet);
      }
    };
    channel.postMessage({ to: 'host', from: me, kind: 'open' } satisfies LocalPacket);
  });
}

function linkOf(connection: DataConnection): Link {
  const link: Link = {
    send: (message) => {
      if (connection.open) connection.send(message);
    },
    close: () => connection.close(),
    onMessage: null,
    onClose: null,
  };
  connection.on('data', (data) => link.onMessage?.(data));
  connection.on('close', () => link.onClose?.());
  connection.on('error', () => link.onClose?.());
  return link;
}

/**
 * Open a room other players can join by its code. onLink is called for each
 * player who connects. The room listens both for direct connections and on
 * the relay, for players whose networks block direct ones.
 */
export async function openRoom(onLink: (link: Link) => void): Promise<Room> {
  if (LOCAL) return openLocalRoom(onLink);
  const direct = await openDirectRoom(onLink).catch(() => null);
  const code = direct?.code ?? randomCode();
  const relay = await openRelayRoom(code, onLink).catch(() => null);
  if (!direct && !relay) throw new Error('Could not reach the matchmaking service or the relay. Check your connection and try again.');
  return {
    code,
    close: () => {
      direct?.close();
      relay?.close();
    },
  };
}

function openDirectRoom(onLink: (link: Link) => void, attempt = 0): Promise<Room> {
  return new Promise((resolve, reject) => {
    const code = randomCode();
    const peer = new Peer(PREFIX + code);
    let opened = false;
    peer.on('open', () => {
      opened = true;
      resolve({ code, close: () => peer.destroy() });
    });
    peer.on('connection', (connection) => {
      connection.on('open', () => onLink(linkOf(connection)));
    });
    // The connection to the matchmaking service can drop while the game goes on; pick it up again.
    peer.on('disconnected', () => {
      if (opened && !peer.destroyed) peer.reconnect();
    });
    peer.on('error', (error) => {
      if (opened) return;
      peer.destroy();
      if (error.type === 'unavailable-id' && attempt < 3) openDirectRoom(onLink, attempt + 1).then(resolve, reject);
      else reject(new Error('Could not reach the matchmaking service.'));
    });
  });
}

export interface Joined {
  link: Link;
  close(): void;
  /** True when the game goes through the relay rather than straight to the host. */
  relayed: boolean;
}

/**
 * Connect to the host of a room: directly if the networks allow it, otherwise
 * through the relay. onStatus is told when it falls back.
 */
export async function joinRoom(code: string, onStatus: (text: string) => void = () => {}): Promise<Joined> {
  if (LOCAL) return { ...(await joinLocalRoom(code)), relayed: false };
  let reason: DirectFailure;
  try {
    return { ...(await joinDirect(code)), relayed: false };
  } catch (failure) {
    reason = failure as DirectFailure;
  }
  onStatus('Trying the relay...');
  const relay = await joinRelayRoom(code).catch(() => {
    throw new Error(
      reason === 'missing'
        ? `There is no game with the code ${code}.`
        : 'Could not connect to the host directly, and the relay could not be reached either.',
    );
  });
  if (relay) return { ...relay, relayed: true };
  throw new Error(
    reason === 'blocked'
      ? 'Could not connect to the host, directly or through the relay.'
      : `There is no game with the code ${code}.`,
  );
}

/** Why a direct connection failed: no such room, connection blocked, or matchmaking unreachable. */
type DirectFailure = 'missing' | 'blocked' | 'service';

function joinDirect(code: string): Promise<{ link: Link; close(): void }> {
  return new Promise((resolve, reject) => {
    const peer = new Peer();
    let settled = false;
    const fail = (reason: DirectFailure): void => {
      if (settled) return;
      settled = true;
      peer.destroy();
      reject(reason);
    };
    const timer = setTimeout(() => fail('blocked'), DIRECT_TIMEOUT);
    peer.on('open', () => {
      const connection = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      const link = linkOf(connection);
      connection.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ link, close: () => peer.destroy() });
      });
    });
    peer.on('error', (error) => {
      clearTimeout(timer);
      fail(error.type === 'peer-unavailable' ? 'missing' : 'service');
    });
  });
}
