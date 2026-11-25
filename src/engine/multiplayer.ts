import type { Card, GameState } from './types';

export interface PlayerSetup {
  name: string;
  mainDeck: Card[];
  lifeDeck: Card[];
}

export type NetMessage =
  | { type: 'HELLO'; setup: PlayerSetup }
  | { type: 'START'; state: GameState }
  | { type: 'SYNC'; state: GameState; winner: string | null }
  | { type: 'PING' }
  | { type: 'LEAVE' };

export interface RoomLink {
  send: (msg: NetMessage) => void;
  /** Messages received before the first subscriber attaches are buffered and replayed. */
  onMessage: (cb: (msg: NetMessage) => void) => () => void;
  onClose: (cb: () => void) => () => void;
  close: () => void;
}

export interface MatchSession {
  link: RoomLink;
  role: 'host' | 'guest';
  myPlayerId: string;
  code: string;
  initialState: GameState;
}

export interface RoomHandlers {
  onStatus: (status: string) => void;
  onError: (message: string) => void;
  onReady: (session: MatchSession) => void;
  /** Host only: called once the room code is registered with the signalling server. */
  onCode?: (code: string) => void;
}

export interface RoomController {
  cancel: () => void;
}

const PEER_PREFIX = 'bot-tcg-talingchan-';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CONNECT_TIMEOUT_MS = 20000;
const HEARTBEAT_INTERVAL_MS = 5000;
// Generous so that browsers throttling timers in background tabs are not mistaken for a disconnect.
const HEARTBEAT_TIMEOUT_MS = 45000;

export const HOST_PLAYER_ID = 'player-1';
export const GUEST_PLAYER_ID = 'player-2';

// JSON cannot represent Set, but PlayerState.usedMagicTypesThisTurn is one.
function encode(msg: NetMessage): string {
  return JSON.stringify(msg, (_key, value) =>
    value instanceof Set ? { __set: Array.from(value) } : value
  );
}

function decode(raw: unknown): NetMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw, (_key, value) =>
      value && typeof value === 'object' && Array.isArray(value.__set) ? new Set(value.__set) : value
    ) as NetMessage;
  } catch {
    return null;
  }
}

export function generateRoomCode(): string {
  let suffix = '';
  for (let i = 0; i < 5; i++) {
    suffix += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return `BOT-${suffix}`;
}

export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase();
}

function peerIdFor(code: string): string {
  return `${PEER_PREFIX}${normalizeRoomCode(code).toLowerCase()}`;
}

interface DataConnectionLike {
  open: boolean;
  send: (data: unknown) => void;
  close: () => void;
  on: (event: string, cb: (...args: any[]) => void) => void;
}

function createLink(conn: DataConnectionLike, handshake?: (msg: NetMessage) => boolean): RoomLink {
  const messageListeners = new Set<(msg: NetMessage) => void>();
  const closeListeners = new Set<() => void>();
  const buffer: NetMessage[] = [];
  let closed = false;

  const dispatch = (msg: NetMessage) => {
    if (messageListeners.size === 0) {
      buffer.push(msg);
      return;
    }
    messageListeners.forEach(cb => cb(msg));
  };

  let lastSeen = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const notifyClosed = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    closeListeners.forEach(cb => cb());
  };

  const startHeartbeat = () => {
    if (heartbeat) return;
    lastSeen = Date.now();
    heartbeat = setInterval(() => {
      if (Date.now() - lastSeen > HEARTBEAT_TIMEOUT_MS) {
        notifyClosed();
        return;
      }
      if (conn.open) conn.send(encode({ type: 'PING' }));
    }, HEARTBEAT_INTERVAL_MS);
  };

  conn.on('data', (raw: unknown) => {
    lastSeen = Date.now();
    const msg = decode(raw);
    if (!msg || msg.type === 'PING') return;
    if (msg.type === 'LEAVE') {
      notifyClosed();
      return;
    }
    if (handshake && handshake(msg)) {
      handshake = undefined;
      startHeartbeat();
      return;
    }
    dispatch(msg);
  });
  conn.on('close', notifyClosed);
  conn.on('error', notifyClosed);

  if (!handshake) startHeartbeat();

  return {
    send: msg => {
      if (closed || !conn.open) return;
      conn.send(encode(msg));
    },
    onMessage: cb => {
      messageListeners.add(cb);
      if (buffer.length > 0) {
        const pending = buffer.splice(0, buffer.length);
        pending.forEach(cb);
      }
      return () => messageListeners.delete(cb);
    },
    onClose: cb => {
      closeListeners.add(cb);
      if (closed) cb();
      return () => closeListeners.delete(cb);
    },
    close: () => {
      if (!closed && conn.open) {
        try {
          conn.send(encode({ type: 'LEAVE' }));
        } catch {}
      }
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      try {
        conn.close();
      } catch {}
    }
  };
}

export function hostRoom(
  local: PlayerSetup,
  buildState: (host: PlayerSetup, guest: PlayerSetup) => GameState,
  handlers: RoomHandlers
): RoomController {
  let cancelled = false;
  let peer: any = null;
  let guestConn: DataConnectionLike | null = null;
  let matched = false;

  const start = async (attempt: number) => {
    const { Peer } = await import('peerjs');
    if (cancelled) return;

    const code = generateRoomCode();
    peer = new Peer(peerIdFor(code));

    peer.on('open', () => {
      if (cancelled) return;
      handlers.onCode?.(code);
      handlers.onStatus('รอเพื่อนเข้าห้อง...');
    });

    peer.on('connection', (conn: DataConnectionLike) => {
      if (matched || guestConn) {
        conn.on('open', () => conn.close());
        return;
      }
      guestConn = conn;
      handlers.onStatus('เพื่อนกำลังเชื่อมต่อ...');

      const link = createLink(conn, msg => {
        if (msg.type !== 'HELLO' || matched) return false;
        matched = true;
        const initialState = buildState(local, msg.setup);
        conn.send(encode({ type: 'START', state: initialState }));
        handlers.onReady({
          link,
          role: 'host',
          myPlayerId: HOST_PLAYER_ID,
          code,
          initialState
        });
        return true;
      });

      conn.on('close', () => {
        if (!matched) {
          guestConn = null;
          handlers.onStatus('เพื่อนหลุดการเชื่อมต่อ รอเข้าห้องใหม่อีกครั้ง...');
        }
      });
    });

    peer.on('error', (err: { type?: string; message?: string }) => {
      if (cancelled || matched) return;
      if (err.type === 'unavailable-id' && attempt < 5) {
        peer.destroy();
        start(attempt + 1);
        return;
      }
      handlers.onError(
        err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error'
          ? 'เชื่อมต่อเซิร์ฟเวอร์จับคู่ไม่ได้ ลองใหม่อีกครั้ง'
          : `สร้างห้องไม่สำเร็จ (${err.type ?? 'unknown'})`
      );
    });
  };

  start(0).catch(() => handlers.onError('โหลดระบบเชื่อมต่อไม่สำเร็จ'));

  return {
    cancel: () => {
      cancelled = true;
      if (!matched && peer) {
        try {
          peer.destroy();
        } catch {}
      }
    }
  };
}

export function joinRoom(
  rawCode: string,
  local: PlayerSetup,
  handlers: RoomHandlers
): RoomController {
  const code = normalizeRoomCode(rawCode);
  let cancelled = false;
  let peer: any = null;
  let matched = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const fail = (message: string) => {
    if (cancelled || matched) return;
    if (timeout) clearTimeout(timeout);
    handlers.onError(message);
    try {
      peer?.destroy();
    } catch {}
  };

  (async () => {
    const { Peer } = await import('peerjs');
    if (cancelled) return;
    handlers.onStatus('กำลังค้นหาห้อง...');
    peer = new Peer();

    timeout = setTimeout(() => fail('เชื่อมต่อห้องไม่สำเร็จ (หมดเวลา) ตรวจสอบรหัสห้องแล้วลองใหม่'), CONNECT_TIMEOUT_MS);

    peer.on('error', (err: { type?: string }) => {
      if (err.type === 'peer-unavailable') {
        fail(`ไม่พบห้อง ${code} — ตรวจสอบรหัส หรือให้โฮสต์สร้างห้องก่อน`);
      } else {
        fail(`เชื่อมต่อไม่สำเร็จ (${err.type ?? 'unknown'})`);
      }
    });

    peer.on('open', () => {
      if (cancelled) return;
      const conn: DataConnectionLike = peer.connect(peerIdFor(code), { reliable: true });

      const link = createLink(conn, msg => {
        if (msg.type !== 'START' || matched) return false;
        matched = true;
        if (timeout) clearTimeout(timeout);
        handlers.onReady({
          link,
          role: 'guest',
          myPlayerId: GUEST_PLAYER_ID,
          code,
          initialState: msg.state
        });
        return true;
      });

      conn.on('open', () => {
        handlers.onStatus('พบห้องแล้ว กำลังเข้าสู่สนาม...');
        conn.send(encode({ type: 'HELLO', setup: local }));
      });
    });
  })().catch(() => fail('โหลดระบบเชื่อมต่อไม่สำเร็จ'));

  return {
    cancel: () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
      if (!matched && peer) {
        try {
          peer.destroy();
        } catch {}
      }
    }
  };
}
