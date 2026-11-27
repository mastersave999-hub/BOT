'use client';

import React, { useState, useEffect, useRef } from 'react';
import useSWR from 'swr';
import { useClerk, useUser } from '@clerk/nextjs';
import { Playmat } from '../components/game/Playmat';
import { DeckBuilder } from '../components/deck/DeckBuilder';
import { MatchmakingLobby } from '../components/lobby/MatchmakingLobby';
import { AuthModal } from '../components/auth/AuthModal';
import { ProfileMenu } from '../components/auth/ProfileMenu';
import { GameState, Card, PlayerState } from '../engine/types';
import {
  playerIdForSeat,
  type MatchSession, type PlayerSetup, type RoomMode
} from '../engine/multiplayer';
import { createCardInstance, createLocalMatchState, shuffled } from '../engine/localMatch';
import {
  getCurrentUser, saveDeckForUser, deleteDeckForUser,
  type SavedDeck, type UserAccount
} from '../engine/authService';
import { rollOpeningOrder } from '../engine/opening';
import sampleCardsData from '../engine/sampleCards.json';
import starterDeckData from '../engine/starterDeck.json';
import packageJson from '../../package.json';
import { Swords, Users, Library, Globe, User, Plus, Flame } from 'lucide-react';
import { PwaInstallButton } from '../components/PwaInstallButton';
import { CARD_BACK_SRC, OrnamentDivider } from '../components/game/botTheme';

function resolveDecks(main: Card[] | undefined, life: Card[] | undefined) {
  return {
    main: main && main.length === 50 ? main : (starterDeckData.mainDeck as Card[]),
    life: life && life.length === 5 ? life : (starterDeckData.lifeDeck as Card[])
  };
}

function createOnlinePlayer(playerId: string, seat: number, setup: PlayerSetup): PlayerState {
  const resolved = resolveDecks(setup.mainDeck, setup.lifeDeck);
  const main = shuffled(resolved.main);
  const life = shuffled(resolved.life);
  const prefix = `p${seat + 1}`;
  return {
    id: playerId,
    name: setup.name,
    seat,
    deck: main.slice(5).map((c, i) => createCardInstance(c, playerId, `${prefix}-deck-${i}`, false)),
    hand: main.slice(0, 5).map((c, i) => createCardInstance(c, playerId, `${prefix}-hand-${i}`, true)),
    lifeDeck: life.map((c, i) => createCardInstance(c, playerId, `${prefix}-life-${i}`, false)),
    avatarZone: [],
    constructZone: [],
    magicZone: [],
    hell: [],
    darkDimension: [],
    isCritical: false,
    reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 },
    usedMagicTypesThisTurn: new Set()
  };
}

function buildOnlineState(mode: RoomMode, setups: PlayerSetup[]): GameState {
  const ids = setups.map((_, seat) => playerIdForSeat(seat));
  const opening = rollOpeningOrder(ids);
  const players: Record<string, PlayerState> = {};
  setups.forEach((setup, seat) => {
    players[ids[seat]] = createOnlinePlayer(ids[seat], seat, setup);
  });

  return {
    id: `online-${Date.now()}`,
    mode,
    playerOrder: opening.order,
    openingRolls: opening.rolls,
    currentTurnPlayerIndex: 0,
    currentPhase: 'DRAW',
    turnNumber: 1,
    roundNumber: 1,
    landMagicZone: null,
    players,
    eventLog: [
      {
        timestamp: Date.now(),
        type: 'GAME_STARTED',
        description: `${setups.map(s => s.name).join(' vs ')} — ศึกออนไลน์โหมด ${mode === 'AD_MUA' ? 'อัดมั่ว' : 'Duel'} เริ่มแล้ว!`,
        actorId: 'system'
      }
    ]
  };
}

// Clerk is optional: without a publishable key the app renders in guest mode
// (local decks only) instead of crashing inside Clerk hooks.
const CLERK_ENABLED = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

interface ClerkAuth {
  isLoaded: boolean;
  isSignedIn: boolean;
  signOut: () => Promise<void>;
}

export default function Home() {
  if (!CLERK_ENABLED) {
    return <HomeShell clerk={{ isLoaded: true, isSignedIn: false, signOut: async () => {} }} />;
  }
  return <ClerkHomeShell />;
}

function ClerkHomeShell() {
  const { isLoaded: isClerkLoaded, isSignedIn } = useUser();
  const { signOut } = useClerk();
  return <HomeShell clerk={{ isLoaded: isClerkLoaded, isSignedIn, signOut }} />;
}

function HomeShell({ clerk }: { clerk: ClerkAuth }) {
  const [currentView, setCurrentView] = useState<'HOME' | 'DECK_BUILDER' | 'LOBBY' | 'GAME'>('HOME');
  const [gameMode, setGameMode] = useState<'DUEL' | 'AD_MUA'>('DUEL');
  const [initialGameState, setInitialGameState] = useState<GameState | null>(null);
  const [onlineSession, setOnlineSession] = useState<MatchSession | null>(null);

  const { isLoaded: isClerkLoaded, isSignedIn } = clerk;
  const { data: user = null, mutate: mutateUser } = useSWR<UserAccount | null>(
    isClerkLoaded && isSignedIn ? 'current-user' : null,
    getCurrentUser,
  );
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const loadedDeckUserId = useRef<string | null>(null);

  // Custom User Decks
  const [activeDeckName, setActiveDeckName] = useState<string>('เด็คเริ่มต้นทางการ');
  const [activeDeckId, setActiveDeckId] = useState<string | null>(null);
  const [guestDecks, setGuestDecks] = useState<SavedDeck[]>([]);
  const deckSlots = user?.savedDecks ?? guestDecks;
  const [customMainDeck, setCustomMainDeck] = useState<Card[]>(starterDeckData.mainDeck as Card[]);
  const [customLifeDeck, setCustomLifeDeck] = useState<Card[]>(starterDeckData.lifeDeck as Card[]);

  useEffect(() => {
    if (!user || loadedDeckUserId.current === user.id) return;
    loadedDeckUserId.current = user.id;
    const firstDeck = user.savedDecks[0];
    if (firstDeck) {
      setActiveDeckId(firstDeck.id);
      setActiveDeckName(firstDeck.name);
      setCustomMainDeck(firstDeck.mainDeck);
      setCustomLifeDeck(firstDeck.lifeDeck);
    }
  }, [user]);

  const handleLogout = async () => {
    await clerk.signOut();
    loadedDeckUserId.current = null;
    await mutateUser(null, { revalidate: false });
  };

  const handleSaveDeck = async (main: Card[], life: Card[], deckName: string, deckId: string | null) => {
    setAccountMessage(null);

    if (user) {
      try {
        const updatedUser = await saveDeckForUser(deckName, main, life, deckId);
        const savedDeck = deckId
          ? updatedUser.savedDecks.find((deck) => deck.id === deckId)
          : updatedUser.savedDecks[0];
        setActiveDeckId(savedDeck?.id ?? null);
        await mutateUser(updatedUser, { revalidate: false });
      } catch (error) {
        setAccountMessage(error instanceof TypeError
          ? 'เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง'
          : error instanceof Error
            ? error.message
            : 'บันทึกเด็คออนไลน์ไม่สำเร็จ กรุณาลองอีกครั้ง');
        return;
      }
    } else {
      const existingDeck = deckId ? guestDecks.find((deck) => deck.id === deckId) : undefined;
      const savedDeck: SavedDeck = {
        id: existingDeck?.id ?? crypto.randomUUID(),
        name: deckName.trim() || `เด็คใหม่ ${guestDecks.length + 1}`,
        createdAt: existingDeck?.createdAt ?? Date.now(),
        mainDeck: main,
        lifeDeck: life,
      };
      setGuestDecks((decks) => existingDeck
        ? decks.map((deck) => deck.id === existingDeck.id ? savedDeck : deck)
        : [savedDeck, ...decks]);
      setActiveDeckId(savedDeck.id);
    }

    setCustomMainDeck(main);
    setCustomLifeDeck(life);
    setActiveDeckName(deckName.trim() || `เด็คใหม่ ${deckSlots.length + 1}`);
    setCurrentView('HOME');
  };

  const handleLoadSavedDeck = (deck: SavedDeck) => {
    setActiveDeckId(deck.id);
    setActiveDeckName(deck.name);
    setCustomMainDeck(deck.mainDeck);
    setCustomLifeDeck(deck.lifeDeck);
  };

  const handleCreateDeck = () => {
    setAccountMessage(null);
    setActiveDeckId(null);
    setActiveDeckName(`เด็คใหม่ ${deckSlots.length + 1}`);
    setCustomMainDeck([]);
    setCustomLifeDeck([]);
    setCurrentView('DECK_BUILDER');
  };

  const handleDeleteSavedDeck = async (deckId: string) => {
    if (!user) return;
    try {
      const updated = await deleteDeckForUser(deckId);
      if (updated) await mutateUser(updated, { revalidate: false });
    } catch {
      setAccountMessage('ลบเด็คไม่สำเร็จ กรุณาลองอีกครั้ง');
    }
  };

  const startMatch = (mode: 'DUEL' | 'AD_MUA', opponentName = 'ผู้เล่นฝ่ายตรงข้าม (AI Opponent)') => {
    const sampleCards = sampleCardsData as Card[];
    const aiMainCandidates = shuffled(sampleCards.filter(card => card.type !== 'Life'));
    const aiLifeCandidates = shuffled(sampleCards.filter(card => card.type === 'Life'));
    const aiMainPool = aiMainCandidates.length >= 50
      ? aiMainCandidates.slice(0, 50)
      : (starterDeckData.mainDeck as Card[]);
    const aiLifePool = aiLifeCandidates.length >= 5
      ? aiLifeCandidates.slice(0, 5)
      : (starterDeckData.lifeDeck as Card[]);

    // Use custom decks if built, otherwise official starter deck
    const mainCardsPool = shuffled(
      customMainDeck && customMainDeck.length === 50 ? customMainDeck : (starterDeckData.mainDeck as Card[])
    );
    const lifeCardsPool = shuffled(
      customLifeDeck && customLifeDeck.length === 5 ? customLifeDeck : (starterDeckData.lifeDeck as Card[])
    );

    // Rule Book 3.2 Game Set up: both sides start with empty field zones —
    // no Avatar is pre-spawned; the AI summons during its own Main Phase.
    const initialGame = createLocalMatchState(
      mode,
      [
        {
          name: user ? user.username : 'ผู้เล่นฝั่งเรา (You)',
          mainDeck: mainCardsPool,
          lifeDeck: lifeCardsPool
        },
        {
          name: opponentName,
          mainDeck: aiMainPool,
          lifeDeck: aiLifePool,
          hideHand: true
        }
      ]
    );

    setGameMode(mode);
    setOnlineSession(null);
    setInitialGameState(initialGame);
    setCurrentView('GAME');
  };

  if (currentView === 'DECK_BUILDER') {
    return (
      <DeckBuilder
        onBack={() => setCurrentView('HOME')}
        currentDeckName={activeDeckName}
        currentDeckId={activeDeckId}
        initialMainDeck={customMainDeck || []}
        initialLifeDeck={customLifeDeck || []}
        saveError={accountMessage}
        onSaveDeck={handleSaveDeck}
      />
    );
  }

  if (currentView === 'LOBBY') {
    const { main, life } = resolveDecks(customMainDeck, customLifeDeck);
    return (
      <MatchmakingLobby
        onBack={() => setCurrentView('HOME')}
        defaultPlayerName={user ? user.username : `ผู้เล่น-${Math.floor(100 + Math.random() * 900)}`}
        localDeck={{ mainDeck: main, lifeDeck: life }}
        buildState={buildOnlineState}
        onMatchReady={(session) => {
          setOnlineSession(session);
          setGameMode(session.initialState.mode);
          setInitialGameState(session.initialState);
          setCurrentView('GAME');
        }}
      />
    );
  }

  if (currentView === 'GAME' && initialGameState) {
    return (
      <Playmat
        initialState={initialGameState}
        currentUserId={onlineSession ? onlineSession.myPlayerId : 'player-1'}
        isHost={!onlineSession || onlineSession.role === 'host'}
        link={onlineSession?.link}
      />
    );
  }

  return (
    <div className="bot-felt relative min-h-[100dvh] overflow-hidden text-slate-100 font-kanit flex flex-col">
      {/* Diegetic title-screen backdrop: the official emblem printed on the felt */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center">
        <img
          src={CARD_BACK_SRC}
          alt=""
          className="max-h-[80%] max-w-[60%] object-contain opacity-[0.07] mix-blend-screen"
        />
      </div>
      <span aria-hidden="true" className="bot-corner bot-corner-tl" />
      <span aria-hidden="true" className="bot-corner bot-corner-tr" />
      <span aria-hidden="true" className="bot-corner bot-corner-bl" />
      <span aria-hidden="true" className="bot-corner bot-corner-br" />

      {/* Slim top bar: account + utilities only */}
      <header className="relative z-10 flex w-full items-center justify-between gap-2 px-3 py-2 sm:px-6">
        <span className="flex items-center gap-1.5 text-[11px] font-bold tracking-wider text-amber-500/90 sm:text-xs">
          <Flame className="h-3.5 w-3.5 fill-red-500 text-red-500" />
          RULE BOOK VER. 3.2
        </span>
        <div className="flex items-center gap-2 text-xs">
          <PwaInstallButton />
          {user ? (
            <ProfileMenu user={user} onLogout={() => void handleLogout()} />
          ) : !isClerkLoaded || isSignedIn ? (
            <span role="status" className="text-xs text-slate-500">กำลังโหลดบัญชี…</span>
          ) : !CLERK_ENABLED ? (
            <span className="rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-1.5 text-xs font-semibold text-slate-400">
              โหมดผู้เล่น (Guest)
            </span>
          ) : (
            <button
              onClick={() => setIsAuthOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-slate-950/70 px-3 py-1.5 text-xs font-bold text-amber-300 shadow transition hover:bg-amber-500 hover:text-slate-950"
            >
              <User className="h-3.5 w-3.5" />
              เข้าสู่ระบบ
            </button>
          )}
        </div>
      </header>

      {/* Title & Matchmaking hero */}
      <main className="relative z-10 mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-4 px-4 py-6 text-center">
        {/* Official emblem in a gold ring */}
        <div className="relative mb-1 h-24 w-24 sm:h-28 sm:w-28">
          <span aria-hidden="true" className="absolute -inset-1.5 rounded-full border border-amber-500/40 shadow-[0_0_24px_rgba(251,191,36,0.15)]" />
          <img
            src={CARD_BACK_SRC}
            alt="ตราสัญลักษณ์ศึกตลิ่งชัน"
            className="h-full w-full rounded-full border-2 border-amber-500/60 object-cover shadow-2xl"
          />
        </div>

        <div>
          <h1 className="bg-gradient-to-b from-amber-200 via-amber-400 to-amber-600 bg-clip-text text-4xl font-black tracking-wide text-transparent drop-shadow-[0_2px_12px_rgba(251,191,36,0.25)] sm:text-5xl">
            ศึกตลิ่งชัน
          </h1>
          <p className="mt-1 text-[11px] font-bold tracking-[0.35em] text-amber-500/70 sm:text-xs">
            BATTLE OF TALINGCHAN ONLINE
          </p>
        </div>

        <OrnamentDivider className="w-56 sm:w-72" />

        {/* Active deck selector pill */}
        <div className="flex w-full max-w-sm flex-col items-center gap-2">
          <div className="flex items-center gap-2 rounded-full border border-amber-500/40 bg-slate-950/80 px-4 py-1.5 shadow-lg">
            <Library className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
            <span className="max-w-[10rem] truncate text-xs font-bold text-amber-300">{activeDeckName}</span>
            <span className="shrink-0 rounded-full border border-emerald-700/60 bg-emerald-950/60 px-1.5 py-px font-mono text-[9px] text-emerald-300">
              {customMainDeck.length}+{customLifeDeck.length} ใบ
            </span>
          </div>
          {accountMessage && <span role="status" className="text-[11px] text-red-300">{accountMessage}</span>}

          {/* Saved deck chips */}
          {deckSlots.length > 0 && (
            <div className="no-scrollbar flex w-full max-w-sm items-center gap-1.5 overflow-x-auto pb-1">
              {deckSlots.map((deck) => (
                <button
                  key={deck.id}
                  type="button"
                  aria-pressed={activeDeckId === deck.id}
                  onClick={() => handleLoadSavedDeck(deck)}
                  className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-semibold transition ${
                    activeDeckId === deck.id
                      ? 'border-amber-500/70 bg-amber-500/15 text-amber-300'
                      : 'border-slate-700 bg-slate-950/60 text-slate-300 hover:border-slate-500'
                  }`}
                >
                  {deck.name}
                </button>
              ))}
              <button
                type="button"
                onClick={handleCreateDeck}
                aria-label="สร้างเด็คใหม่"
                className="shrink-0 rounded-full border border-dashed border-slate-700 bg-slate-950/40 p-1 text-slate-400 transition hover:border-amber-500/60 hover:text-amber-300"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>

        {/* Primary & secondary triggers */}
        <div className="flex w-full max-w-sm flex-col gap-2.5">
          <button
            onClick={() => startMatch('DUEL')}
            className="group flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-red-700 via-red-600 to-amber-600 px-6 py-3.5 text-base font-black text-white shadow-xl shadow-red-950/50 ring-1 ring-amber-400/40 transition hover:from-red-600 hover:to-amber-500 active:scale-[0.98]"
          >
            <Swords className="h-5 w-5 fill-white/20" aria-hidden="true" />
            เข้าดวลทันที (Quick Match)
          </button>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <button
              onClick={() => setCurrentView('LOBBY')}
              className="flex items-center justify-center gap-1.5 rounded-xl border border-amber-500/30 bg-slate-950/70 px-3 py-2.5 text-[11px] font-bold text-amber-200 shadow transition hover:border-amber-400/60 hover:bg-slate-900"
            >
              <Globe className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
              ห้องออนไลน์ 2–4 คน
            </button>
            <button
              onClick={() => startMatch('AD_MUA')}
              className="flex items-center justify-center gap-1.5 rounded-xl border border-purple-500/30 bg-slate-950/70 px-3 py-2.5 text-[11px] font-bold text-purple-200 shadow transition hover:border-purple-400/60 hover:bg-slate-900"
            >
              <Users className="h-3.5 w-3.5 text-purple-400" aria-hidden="true" />
              อัดมั่ว 3–4 คน
            </button>
            <button
              onClick={() => {
                setAccountMessage(null);
                setCurrentView('DECK_BUILDER');
              }}
              className="flex items-center justify-center gap-1.5 rounded-xl border border-slate-600/60 bg-slate-950/70 px-3 py-2.5 text-[11px] font-bold text-slate-200 shadow transition hover:border-slate-400 hover:bg-slate-900"
            >
              <Library className="h-3.5 w-3.5 text-slate-300" aria-hidden="true" />
              จัดเด็ค (Deck Builder)
            </button>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 mx-auto flex w-full max-w-3xl flex-col items-center justify-between gap-1 border-t border-amber-500/10 px-4 py-2.5 text-center text-[10px] text-slate-500 sm:flex-row">
        <span>© 2026 Battle of Talingchan Online • Licensed by PASULOL &amp; Team YUK</span>
        <span>เวอร์ชัน {packageJson.version} • คลังการ์ด 2,014 ใบ</span>
      </footer>

      {/* Auth Modal — Clerk hooks require the provider, so it only mounts when Clerk is configured. */}
      {CLERK_ENABLED && (
        <AuthModal
          isOpen={isAuthOpen}
          onClose={() => setIsAuthOpen(false)}
        />
      )}
    </div>
  );
}
