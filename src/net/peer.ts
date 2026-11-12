import { Peer, type DataConnection } from 'peerjs';
import type { Link } from './session';

/** Room codes become PeerJS ids with this in front, so they do not clash with other apps. */
const PREFIX = 'cruise-racer-v1-';
/** No letters or digits that are easily mistaken for each other. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const CONNECT_TIMEOUT = 20000;

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

/** Open a room other players can join by its code. onLink is called for each player who connects. */
export function openRoom(onLink: (link: Link) => void, attempt = 0): Promise<Room> {
  if (LOCAL) return Promise.resolve(openLocalRoom(onLink));
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
      if (error.type === 'unavailable-id' && attempt < 3) openRoom(onLink, attempt + 1).then(resolve, reject);
      else reject(new Error('Could not reach the matchmaking service. Check your connection and try again.'));
    });
  });
}

/** Connect to the host of a room. */
export function joinRoom(code: string): Promise<{ link: Link; close(): void }> {
  if (LOCAL) return joinLocalRoom(code);
  return new Promise((resolve, reject) => {
    const peer = new Peer();
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      peer.destroy();
      reject(new Error(message));
    };
    const timer = setTimeout(
      () => fail('Could not connect to the host. One of your networks may be blocking direct connections.'),
      CONNECT_TIMEOUT,
    );
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
      fail(
        error.type === 'peer-unavailable'
          ? `There is no game with the code ${code}.`
          : 'Could not reach the matchmaking service. Check your connection and try again.',
      );
    });
  });
}
