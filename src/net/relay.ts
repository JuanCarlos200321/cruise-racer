import type { MqttClient } from 'mqtt';
import type { Link } from './session';

/**
 * Fallback for networks that block direct connections between browsers: game
 * messages go through a free public message broker instead, as ordinary web
 * traffic. Anyone who knows a room's code can read and send on its topics,
 * just as anyone with the code can join the game.
 */
const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
const TOPIC = 'cruise-racer-v1';
const CONNECT_TIMEOUT = 6000;
/** How long a joining player waits for the host to answer on one broker. */
const ANSWER_TIMEOUT = 4000;
const PING_EVERY = 3000;
/** The broker does not say when the other end has gone, so silence this long counts as gone. */
const SILENT_LIMIT = 12000;
const MAX_LINKS = 32;

interface Packet {
  kind: 'open' | 'data' | 'close' | 'ping';
  data?: unknown;
}

type RelayLink = Link & { receive(packet: Packet): void };

async function connect(url: string): Promise<MqttClient> {
  const { default: mqtt } = await import('mqtt');
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, { connectTimeout: CONNECT_TIMEOUT, reconnectPeriod: 2000 });
    const timer = setTimeout(() => {
      client.end(true);
      reject(new Error(`No answer from ${url}`));
    }, CONNECT_TIMEOUT);
    client.once('connect', () => {
      clearTimeout(timer);
      resolve(client);
    });
    // Errors before the first connection are retried until the timer gives up.
    client.on('error', () => {});
  });
}

function parse(payload: Uint8Array): Packet | null {
  try {
    const packet = JSON.parse(new TextDecoder().decode(payload)) as Packet;
    return packet && typeof packet === 'object' && typeof packet.kind === 'string' ? packet : null;
  } catch {
    return null;
  }
}

/** One end of a connection through the broker: sends on a topic the other end listens to. */
function relayLink(client: MqttClient, topic: string): RelayLink {
  let open = true;
  let heard = Date.now();
  const post = (packet: Packet): void => {
    client.publish(topic, JSON.stringify(packet));
  };
  const stop = (): boolean => {
    if (!open) return false;
    open = false;
    clearInterval(timer);
    return true;
  };
  const timer = setInterval(() => {
    if (Date.now() - heard <= SILENT_LIMIT) post({ kind: 'ping' });
    else if (stop()) link.onClose?.();
  }, PING_EVERY);
  const link: RelayLink = {
    send: (message) => {
      if (open) post({ kind: 'data', data: message });
    },
    close: () => {
      if (stop()) post({ kind: 'close' });
    },
    onMessage: null,
    onClose: null,
    receive: (packet) => {
      if (!open) return;
      heard = Date.now();
      if (packet.kind === 'data') link.onMessage?.(packet.data);
      else if (packet.kind === 'close' && stop()) link.onClose?.();
    },
  };
  return link;
}

/** Listen on the relay for players joining a room. Fails if no broker can be reached. */
export async function openRelayRoom(code: string, onLink: (link: Link) => void): Promise<{ close(): void }> {
  let client: MqttClient | null = null;
  for (const url of BROKERS) {
    client = await connect(url).catch(() => null);
    if (client) break;
  }
  if (!client) throw new Error('No relay could be reached.');
  const broker = client;
  const inbox = `${TOPIC}/${code}/host/`;
  const links = new Map<string, RelayLink>();
  broker.on('message', (topic, payload) => {
    const from = topic.slice(inbox.length);
    const packet = parse(payload);
    if (!packet || !topic.startsWith(inbox) || !/^[a-z0-9]{6,20}$/.test(from)) return;
    let link = links.get(from);
    if (packet.kind === 'open') {
      if (!link) {
        if (links.size >= MAX_LINKS) return;
        link = relayLink(broker, `${TOPIC}/${code}/guest/${from}`);
        links.set(from, link);
        onLink(link);
      }
      broker.publish(`${TOPIC}/${code}/guest/${from}`, JSON.stringify({ kind: 'open' } satisfies Packet));
    } else {
      link?.receive(packet);
    }
  });
  await broker.subscribeAsync(`${inbox}+`);
  return {
    close: () => {
      for (const link of links.values()) link.close();
      broker.end();
    },
  };
}

/**
 * Join a room through the relay. Gives null if no host answers, and fails if
 * no broker can be reached at all.
 */
export async function joinRelayRoom(code: string): Promise<{ link: Link; close(): void } | null> {
  let reached = false;
  for (const url of BROKERS) {
    const client = await connect(url).catch(() => null);
    if (!client) continue;
    reached = true;
    const me = Math.random().toString(36).slice(2, 12).padEnd(6, '0');
    const toHost = `${TOPIC}/${code}/host/${me}`;
    const link = await new Promise<RelayLink | null>((resolve) => {
      let answered: RelayLink | null = null;
      const timer = setTimeout(() => resolve(null), ANSWER_TIMEOUT);
      client.on('message', (_topic, payload) => {
        const packet = parse(payload);
        if (!packet) return;
        if (answered) {
          if (packet.kind !== 'open') answered.receive(packet);
        } else if (packet.kind === 'open') {
          answered = relayLink(client, toHost);
          clearTimeout(timer);
          resolve(answered);
        }
      });
      client.subscribe(`${TOPIC}/${code}/guest/${me}`, (error) => {
        if (error) {
          clearTimeout(timer);
          resolve(null);
        } else {
          client.publish(toHost, JSON.stringify({ kind: 'open' } satisfies Packet));
        }
      });
    });
    if (link) {
      return {
        link,
        close: () => {
          link.close();
          client.end();
        },
      };
    }
    client.end(true);
  }
  if (!reached) throw new Error('No relay could be reached.');
  return null;
}
