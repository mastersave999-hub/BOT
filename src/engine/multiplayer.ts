import type { Card, GameState } from './types';

const FACE_DOWN_LIFE_CARD: Card = {
  printId: 'hidden-life-card',
  name: 'Face-down LIFE',
  type: 'Life',
  soi: 1,
  cost: 0,
  gem: 0,
  power: 0,
  color: 'ไร้สี',
  rarity: 'C',
  mainEffect: '',
  isOnlyOne: false,
  isBias: false,
  isCollab: false,
  imageUrl: 'https://cdn.bottcg.com/cards/card-back.png'
};

/** Strip card identity from face-down LIFE cards before sending a state to a peer. */
export function redactLifeCardsInSetup(setup: PlayerSetup): PlayerSetup {
  return { ...setup, lifeDeck: setup.lifeDeck.map(() => FACE_DOWN_LIFE_CARD) };
}

export function restoreOwnLifeCardsFromSetup(
  state: GameState,
  setup: PlayerSetup,
  playerId: string
): GameState {
  const player = state.players[playerId];
  if (!player) return state;
  let changed = false;
  const lifeDeck = player.lifeDeck.map((card, index) => {
    const knownCard = setup.lifeDeck[index];
    if (!knownCard || card.card.printId !== 'hidden-life-card') return card;
    changed = true;
    return { ...card, card: knownCard };
  });
  if (!changed) return state;
  return { ...state, players: { ...state.players, [playerId]: { ...player, lifeDeck } } };
}

export function redactLifeCardsForViewer(state: GameState, viewerId: string): GameState {
  return {
    ...state,
    players: Object.fromEntries(
      Object.entries(state.players).map(([playerId, player]) => [
        playerId,
        playerId === viewerId
          ? player
          : {
              ...player,
              lifeDeck: player.lifeDeck.map(card =>
                card.isFaceUp ? card : { ...card, card: FACE_DOWN_LIFE_CARD }
              )
            }
      ])
    )
  };
}

export type RoomMode = 'DUEL' | 'AD_MUA';

export interface PlayerSetup {
  name: string;
  mainDeck: Card[];
  lifeDeck: Card[];
}

export type NetMessage =
  | { type: 'HELLO'; setup: PlayerSetup }
  | { type: 'ROOM'; mode: RoomMode; capacity: number; names: string[] }
  | { type: 'REJECT'; reason: string }
  | { type: 'START'; state: GameState; myPlayerId: string }
  | { type: 'SYNC'; state: GameState; winner: string | null }
  | { type: 'PING' }
  | { type: 'LEAVE' };

export interface RoomLink {
  send: (msg: NetMessage) => void;
  /** Messages received before the first subscriber attaches are buffered and replayed. */
  onMessage: (cb: (msg: NetMessage) => void) => () => void;
  /** Fires once nobody is connected any more (for a guest: the host is gone). */
  onClose: (cb: () => void) => () => void;
  /** Host only: fires with the player id whenever one guest drops out. */
  onPeerLeft?: (cb: (playerId: string) => void) => () => void;
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
  /** Called with the names of everybody in the room (host first) whenever it changes. */
  onPlayers?: (names: string[], capacity: number) => void;
  /** Host only: called once the room code is registered with the signalling server. */
  onCode?: (code: string) => void;
}

export interface HostController {
  cancel: () => void;
  /** Starts the match with whoever has joined so far. No-op when too few players joined. */
  start: () => void;
}

export interface RoomController {
  cancel: () => void;
}

export const ROOM_LIMITS: Record<RoomMode, { min: number; max: number }> = {
  DUEL: { min: 2, max: 2 },
  AD_MUA: { min: 3, max: 4 }
};

const PEER_PREFIX = 'bot-tcg-talingchan-';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CONNECT_TIMEOUT_MS = 20000;
const HEARTBEAT_INTERVAL_MS = 5000;
// Generous so that browsers throttling timers in background tabs are not mistaken for a disconnect.
const HEARTBEAT_TIMEOUT_MS = 45000;

export const HOST_PLAYER_ID = 'player-1';
export const playerIdForSeat = (seat: number) => `player-${seat + 1}`;

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

/**
 * 'pass'     - not a handshake message, deliver it to subscribers.
 * 'consumed' - handshake message handled, keep the handshake handler installed.
 * 'done'     - handshake message handled, remove the handshake handler.
 */
type HandshakeResult = 'pass' | 'consumed' | 'done';

function createLink(
  conn: DataConnectionLike,
  handshake?: (msg: NetMessage) => HandshakeResult,
  transformOutgoing?: (msg: NetMessage) => NetMessage
): RoomLink {
  const messageListeners = new Set<(msg: NetMessage) => void>();
  const closeListeners = new Set<() => void>();
  const buffer: NetMessage[] = [];
  let closed = false;
  let lastSeen = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const dispatch = (msg: NetMessage) => {
    if (messageListeners.size === 0) {
      buffer.push(msg);
      return;
    }
    messageListeners.forEach(cb => cb(msg));
  };

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
    if (handshake) {
      const result = handshake(msg);
      if (result !== 'pass') {
        startHeartbeat();
        if (result === 'done') handshake = undefined;
        return;
      }
    }
    dispatch(msg);
  });

  conn.on('close', notifyClosed);
  conn.on('error', notifyClosed);

  if (!handshake) startHeartbeat();

  return {
    send: msg => {
      if (closed || !conn.open) return;
      conn.send(encode(transformOutgoing ? transformOutgoing(msg) : msg));
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

interface GuestEntry {
  playerId: string;
  conn: DataConnectionLike;
  link: RoomLink;
  setup: PlayerSetup | null;
}

/** Star topology: the host owns every connection and relays guest updates to the other guests. */
function createHostLink(guests: GuestEntry[]): RoomLink {
  const messageListeners = new Set<(msg: NetMessage) => void>();
  const closeListeners = new Set<() => void>();
  const peerLeftListeners = new Set<(playerId: string) => void>();
  const buffer: NetMessage[] = [];
  const openGuests = new Set(guests.map(g => g.playerId));
  let allClosed = false;

  guests.forEach(guest => {
    guest.link.onMessage(msg => {
      if (msg.type === 'SYNC') {
        guests.forEach(other => {
          if (other.playerId !== guest.playerId) {
            other.link.send({
              ...msg,
              state: redactLifeCardsForViewer(msg.state, other.playerId)
            });
          }
        });
      }
      const hostView = msg.type === 'SYNC'
        ? { ...msg, state: redactLifeCardsForViewer(msg.state, HOST_PLAYER_ID) }
        : msg;
      if (messageListeners.size === 0) {
        buffer.push(hostView);
        return;
      }
      messageListeners.forEach(cb => cb(hostView));
    });

    guest.link.onClose(() => {
      openGuests.delete(guest.playerId);
      peerLeftListeners.forEach(cb => cb(guest.playerId));
      if (openGuests.size === 0 && !allClosed) {
        allClosed = true;
        closeListeners.forEach(cb => cb());
      }
    });
  });

  return {
    send: msg => guests.forEach(g => {
      const viewerMessage = msg.type === 'SYNC'
        ? { ...msg, state: redactLifeCardsForViewer(msg.state, g.playerId) }
        : msg;
      g.link.send(viewerMessage);
    }),
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
      if (allClosed) cb();
      return () => closeListeners.delete(cb);
    },
    onPeerLeft: cb => {
      peerLeftListeners.add(cb);
      return () => peerLeftListeners.delete(cb);
    },
    close: () => guests.forEach(g => g.link.close())
  };
}

export function hostRoom(
  mode: RoomMode,
  local: PlayerSetup,
  buildState: (setups: PlayerSetup[]) => GameState,
  handlers: RoomHandlers
): HostController {
  const { min, max } = ROOM_LIMITS[mode];
  let cancelled = false;
  let started = false;
  let peer: any = null;
  let roomCode = '';
  const guests: GuestEntry[] = [];

  const joinedGuests = () => guests.filter(g => g.setup);
  const names = () => [local.name, ...joinedGuests().map(g => g.setup!.name)];

  const publishRoster = () => {
    const roster = names();
    handlers.onPlayers?.(roster, max);
    joinedGuests().forEach(g => g.link.send({ type: 'ROOM', mode, capacity: max, names: roster }));
    if (roster.length < min) {
      handlers.onStatus(`รอเพื่อนเข้าห้อง... (${roster.length}/${max})`);
    } else {
      handlers.onStatus(
        mode === 'DUEL' ? 'เพื่อนเข้าห้องแล้ว' : `ผู้เล่นครบขั้นต่ำแล้ว (${roster.length}/${max}) กดเริ่มเกมได้เลย`
      );
    }
  };

  const startMatch = () => {
    const ready = joinedGuests();
    if (started || cancelled || ready.length + 1 < min) return;
    started = true;

    const setups = [local, ...ready.map(g => g.setup!)];
    const initialState = buildState(setups);
    ready.forEach((guest, index) => {
      guest.playerId = playerIdForSeat(index + 1);
    });
    ready.forEach(guest => {
      guest.link.send({
        type: 'START',
        state: redactLifeCardsForViewer(initialState, guest.playerId),
        myPlayerId: guest.playerId
      });
    });

    // Anybody who connected but never said hello is not part of the match.
    guests.filter(g => !g.setup).forEach(g => g.link.close());

    handlers.onReady({
      link: createHostLink(ready),
      role: 'host',
      myPlayerId: HOST_PLAYER_ID,
      code: roomCode,
      initialState
    });
  };

  const begin = async (attempt: number) => {
    const { Peer } = await import('peerjs');
    if (cancelled) return;

    const code = generateRoomCode();
    peer = new Peer(peerIdFor(code));

    peer.on('open', () => {
      if (cancelled) return;
      roomCode = code;
      handlers.onCode?.(code);
      publishRoster();
    });

    peer.on('connection', (conn: DataConnectionLike) => {
      const reject = (reason: string) => {
        conn.on('open', () => {
          conn.send(encode({ type: 'REJECT', reason }));
          setTimeout(() => conn.close(), 500);
        });
      };
      if (started) return reject('เกมในห้องนี้เริ่มไปแล้ว');
      if (guests.length >= max - 1) return reject('ห้องเต็มแล้ว');

      const entry: GuestEntry = {
        playerId: playerIdForSeat(guests.length + 1),
        conn,
        setup: null,
        link: createLink(conn, msg => {
          if (msg.type !== 'HELLO' || started) return 'pass';
          entry.setup = msg.setup;
          publishRoster();
          if (mode === 'DUEL') startMatch();
          return 'consumed';
        })
      };
      guests.push(entry);
      handlers.onStatus('เพื่อนกำลังเชื่อมต่อ...');

      entry.link.onClose(() => {
        if (started) return;
        const index = guests.indexOf(entry);
        if (index !== -1) guests.splice(index, 1);
        if (!cancelled) publishRoster();
      });
    });

    peer.on('error', (err: { type?: string; message?: string }) => {
      if (cancelled || started) return;
      if (err.type === 'unavailable-id' && attempt < 5) {
        peer.destroy();
        begin(attempt + 1);
        return;
      }
      handlers.onError(
        err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error'
          ? 'เชื่อมต่อเซิร์ฟเวอร์จับคู่ไม่ได้ ลองใหม่อีกครั้ง'
          : `สร้างห้องไม่สำเร็จ (${err.type ?? 'unknown'})`
      );
    });
  };

  begin(0).catch(() => handlers.onError('โหลดระบบเชื่อมต่อไม่สำเร็จ'));

  return {
    start: startMatch,
    cancel: () => {
      cancelled = true;
      if (!started) {
        guests.forEach(g => g.link.close());
        try {
          peer?.destroy();
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
  let link: RoomLink | null = null;
  let matched = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const fail = (message: string) => {
    if (cancelled || matched) return;
    if (timeout) clearTimeout(timeout);
    handlers.onError(message);
    link?.close();
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

      link = createLink(conn, msg => {
        if (msg.type === 'REJECT') {
          fail(msg.reason);
          return 'consumed';
        }
        if (msg.type === 'ROOM') {
          // Connected: from here the host decides when the match begins, so stop the connect timeout.
          if (timeout) clearTimeout(timeout);
          handlers.onPlayers?.(msg.names, msg.capacity);
          handlers.onStatus(
            msg.mode === 'DUEL'
              ? 'เข้าห้องแล้ว กำลังเริ่มเกม...'
              : `เข้าห้องแล้ว รอโฮสต์กดเริ่มเกม (${msg.names.length}/${msg.capacity})`
          );
          return 'consumed';
        }
        if (msg.type === 'START') {
          matched = true;
          if (timeout) clearTimeout(timeout);
          handlers.onReady({
            link: link!,
            role: 'guest',
            myPlayerId: msg.myPlayerId,
            code,
            initialState: restoreOwnLifeCardsFromSetup(msg.state, local, msg.myPlayerId)
          });
          return 'done';
        }
        return 'pass';
      }, msg => msg.type === 'SYNC'
        ? { ...msg, state: redactLifeCardsForViewer(msg.state, HOST_PLAYER_ID) }
        : msg);

      link.onClose(() => fail('การเชื่อมต่อกับห้องถูกตัด'));

      conn.on('open', () => {
        handlers.onStatus('พบห้องแล้ว กำลังเข้าร่วม...');
        conn.send(encode({ type: 'HELLO', setup: redactLifeCardsInSetup(local) }));
      });
    });
  })().catch(() => fail('โหลดระบบเชื่อมต่อไม่สำเร็จ'));

  return {
    cancel: () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
      if (!matched) {
        link?.close();
        try {
          peer?.destroy();
        } catch {}
      }
    }
  };
}
