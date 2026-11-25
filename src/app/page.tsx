'use client';

import React, { useState, useEffect } from 'react';
import { Playmat } from '../components/game/Playmat';
import { DeckBuilder } from '../components/deck/DeckBuilder';
import { MatchmakingLobby } from '../components/lobby/MatchmakingLobby';
import { AuthModal } from '../components/auth/AuthModal';
import { GameState, CardInstance, Card, PlayerState } from '../engine/types';
import {
  HOST_PLAYER_ID, GUEST_PLAYER_ID,
  type MatchSession, type PlayerSetup
} from '../engine/multiplayer';
import {
  getCurrentUser, logoutUser, saveDeckForUser,
  deleteDeckForUser, UserAccount
} from '../engine/authService';
import sampleCardsData from '../engine/sampleCards.json';
import starterDeckData from '../engine/starterDeck.json';
import {
  Swords, Users, Play, Library, Globe, User, LogOut,
  FolderOpen, Trash2, CheckCircle2, PlusCircle
} from 'lucide-react';

function createCardInstance(card: Card, ownerId: string, instanceId: string, isFaceUp = true): CardInstance {
  return {
    instanceId,
    card,
    ownerId,
    controllerId: ownerId,
    isRested: false,
    isFaceUp,
    attachedInstances: [],
    layerModifiers: []
  };
}

function resolveDecks(main: Card[] | undefined, life: Card[] | undefined) {
  return {
    main: main && main.length === 50 ? main : (starterDeckData.mainDeck as Card[]),
    life: life && life.length === 5 ? life : (starterDeckData.lifeDeck as Card[])
  };
}

function createOnlinePlayer(playerId: string, seat: number, setup: PlayerSetup): PlayerState {
  const { main, life } = resolveDecks(setup.mainDeck, setup.lifeDeck);
  const prefix = seat === 0 ? 'p1' : 'p2';
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

function buildOnlineState(host: PlayerSetup, guest: PlayerSetup): GameState {
  return {
    id: `online-${Date.now()}`,
    mode: 'DUEL',
    playerOrder: [HOST_PLAYER_ID, GUEST_PLAYER_ID],
    currentTurnPlayerIndex: 0,
    currentPhase: 'DRAW',
    turnNumber: 1,
    roundNumber: 1,
    landMagicZone: null,
    players: {
      [HOST_PLAYER_ID]: createOnlinePlayer(HOST_PLAYER_ID, 0, host),
      [GUEST_PLAYER_ID]: createOnlinePlayer(GUEST_PLAYER_ID, 1, guest)
    },
    eventLog: [
      {
        timestamp: Date.now(),
        type: 'GAME_STARTED',
        description: `${host.name} พบกับ ${guest.name} ในศึกออนไลน์! เริ่มเกมรอบแรก`,
        actorId: 'system'
      }
    ]
  };
}

export default function Home() {
  const [currentView, setCurrentView] = useState<'HOME' | 'DECK_BUILDER' | 'LOBBY' | 'GAME'>('HOME');
  const [gameMode, setGameMode] = useState<'DUEL' | 'AD_MUA'>('DUEL');
  const [initialGameState, setInitialGameState] = useState<GameState | null>(null);
  const [onlineSession, setOnlineSession] = useState<MatchSession | null>(null);

  // Auth State
  const [user, setUser] = useState<UserAccount | null>(null);
  const [isAuthOpen, setIsAuthOpen] = useState<boolean>(false);

  // Custom User Decks
  const [activeDeckName, setActiveDeckName] = useState<string>('เด็คเริ่มต้นทางการ');
  const [customMainDeck, setCustomMainDeck] = useState<Card[]>(starterDeckData.mainDeck as Card[]);
  const [customLifeDeck, setCustomLifeDeck] = useState<Card[]>(starterDeckData.lifeDeck as Card[]);

  useEffect(() => {
    const cur = getCurrentUser();
    if (cur) {
      setUser(cur);
      // Auto load first saved deck if any
      if (cur.savedDecks && cur.savedDecks.length > 0) {
        setActiveDeckName(cur.savedDecks[0].name);
        setCustomMainDeck(cur.savedDecks[0].mainDeck);
        setCustomLifeDeck(cur.savedDecks[0].lifeDeck);
      }
    }
  }, []);

  const handleLogout = () => {
    logoutUser();
    setUser(null);
  };

  const handleSaveDeck = (main: Card[], life: Card[], deckName: string) => {
    setCustomMainDeck(main);
    setCustomLifeDeck(life);
    setActiveDeckName(deckName);

    // If logged in, persist to user account
    if (user) {
      const updatedUser = saveDeckForUser(user.username, deckName, main, life);
      if (updatedUser) setUser(updatedUser);
    }
    setCurrentView('HOME');
  };

  const handleLoadSavedDeck = (deck: any) => {
    setActiveDeckName(deck.name);
    setCustomMainDeck(deck.mainDeck);
    setCustomLifeDeck(deck.lifeDeck);
  };

  const handleDeleteSavedDeck = (deckId: string) => {
    if (!user) return;
    const updated = deleteDeckForUser(user.username, deckId);
    if (updated) setUser(updated);
  };

  const startMatch = (mode: 'DUEL' | 'AD_MUA', opponentName = 'ผู้เล่นฝ่ายตรงข้าม (AI Opponent)') => {
    const rawCards = sampleCardsData as Card[];

    // Use custom decks if built, otherwise official starter deck
    const mainCardsPool = customMainDeck && customMainDeck.length === 50 ? customMainDeck : (starterDeckData.mainDeck as Card[]);
    const lifeCardsPool = customLifeDeck && customLifeDeck.length === 5 ? customLifeDeck : (starterDeckData.lifeDeck as Card[]);

    // Player 1
    const p1DeckCards = mainCardsPool.slice(5).map((c, i) => createCardInstance(c, 'player-1', `p1-deck-${i}`, false));
    const p1Hand = mainCardsPool.slice(0, 5).map((c, i) => createCardInstance(c, 'player-1', `p1-hand-${i}`, true));
    const p1Life = lifeCardsPool.map((c, i) => createCardInstance(c, 'player-1', `p1-life-${i}`, false));

    // Player 2
    const p2DeckCards = rawCards.slice(20, 65).map((c, i) => createCardInstance(c, 'player-2', `p2-deck-${i}`, false));
    const p2Hand = rawCards.slice(10, 15).map((c, i) => createCardInstance(c, 'player-2', `p2-hand-${i}`, false));
    const p2Life = rawCards.slice(15, 20).map((c, i) => createCardInstance(c, 'player-2', `p2-life-${i}`, false));
    const p2StarterAvatar = createCardInstance(rawCards[0], 'player-2', 'p2-starter-1', true);

    const initialGame: GameState = {
      id: `match-${Date.now()}`,
      mode,
      playerOrder: ['player-1', 'player-2'],
      currentTurnPlayerIndex: 0,
      currentPhase: 'DRAW',
      turnNumber: 1,
      roundNumber: 1,
      landMagicZone: null,
      players: {
        'player-1': {
          id: 'player-1',
          name: user ? user.username : 'ผู้เล่นฝั่งเรา (You)',
          seat: 0,
          deck: p1DeckCards,
          hand: p1Hand,
          lifeDeck: p1Life,
          avatarZone: [],
          constructZone: [],
          magicZone: [],
          hell: [],
          darkDimension: [],
          isCritical: false,
          reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 },
          usedMagicTypesThisTurn: new Set()
        },
        'player-2': {
          id: 'player-2',
          name: opponentName,
          seat: 1,
          deck: p2DeckCards,
          hand: p2Hand,
          lifeDeck: p2Life,
          avatarZone: [p2StarterAvatar],
          constructZone: [],
          magicZone: [],
          hell: [],
          darkDimension: [],
          isCritical: false,
          reactMagicBudget: { ownTurnRemaining: 1, opponentTurnRemaining: 1 },
          usedMagicTypesThisTurn: new Set()
        }
      },
      eventLog: [
        {
          timestamp: Date.now(),
          type: 'GAME_STARTED',
          description: `ยินดีต้อนรับสู่ Battle of Talingchan Online (${mode} Mode)! เริ่มเกมรอบแรก`,
          actorId: 'system'
        }
      ]
    };

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
        initialMainDeck={customMainDeck || []}
        initialLifeDeck={customLifeDeck || []}
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
          setGameMode('DUEL');
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
        link={onlineSession?.link}
      />
    );
  }

  return (
    <div className="min-h-[100dvh] bg-slate-950 text-slate-100 font-kanit flex flex-col justify-between p-3 sm:p-6">
      {/* Top Header Banner */}
      <header className="w-full max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-3 py-3 border-b border-slate-800">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 md:w-11 md:h-11 rounded-xl bg-gradient-to-tr from-red-600 via-amber-500 to-yellow-400 flex items-center justify-center font-black text-lg md:text-xl shadow-lg shadow-red-950/60 border border-amber-400/30 shrink-0">
            BOT
          </div>
          <div>
            <h1 className="text-base sm:text-xl font-extrabold text-amber-400 tracking-wide">
              BATTLE OF TALINGCHAN ONLINE
            </h1>
            <p className="text-[11px] text-slate-400">ศึกตลิ่งชัน ออนไลน์ • การ์ดเกมไทยทางการ</p>
          </div>
        </div>

        {/* Top Nav Buttons & User Profile */}
        <div className="flex items-center space-x-2 text-xs">
          <button
            onClick={() => setCurrentView('DECK_BUILDER')}
            className="px-2.5 sm:px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-medium flex items-center gap-1.5 transition"
          >
            <Library className="w-3.5 h-3.5 text-amber-400" />
            <span className="hidden sm:inline">จัดเด็ค</span>
            <span className="sm:hidden">เด็ค</span>
          </button>

          <button
            onClick={() => setCurrentView('LOBBY')}
            className="px-2.5 sm:px-3.5 py-1.5 rounded-lg bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-300 border border-indigo-500/40 font-medium flex items-center gap-1.5 transition"
          >
            <Globe className="w-3.5 h-3.5 text-indigo-400" />
            <span className="hidden sm:inline">สร้างห้อง / เล่นกับเพื่อน</span>
            <span className="sm:hidden">ห้องเล่น</span>
          </button>

          {/* User Account Button */}
          {user ? (
            <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-700 px-2.5 py-1 rounded-lg">
              <span className="text-amber-400 font-semibold text-xs flex items-center gap-1">
                <User className="w-3.5 h-3.5" />
                {user.username}
              </span>
              <button
                onClick={handleLogout}
                className="p-1 rounded text-slate-500 hover:text-red-400 transition"
                title="ออกจากระบบ"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setIsAuthOpen(true)}
              className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow transition"
            >
              <User className="w-3.5 h-3.5" />
              เข้าสู่ระบบ
            </button>
          )}
        </div>
      </header>

      {/* Hero Action Cards & Saved Decks Drawer */}
      <div className="w-full max-w-5xl mx-auto my-auto py-4 sm:py-8 space-y-6">
        {/* Active Deck Selector Bar */}
        <div className="p-3 bg-slate-900/60 border border-slate-800 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-slate-400">เด็คที่เลือกใช้:</span>
            <span className="font-bold text-amber-400">{activeDeckName}</span>
            <span className="text-[10px] text-emerald-400 bg-emerald-950/60 border border-emerald-800/60 px-1.5 py-0.5 rounded">
              Main {customMainDeck.length}/50 ใบ • LIFE {customLifeDeck.length}/5
            </span>
          </div>

          {user && user.savedDecks.length > 0 && (
            <div className="flex items-center gap-1 overflow-x-auto max-w-full">
              <span className="text-slate-500 text-[11px] shrink-0">เลือกเด็คของคุณ:</span>
              {user.savedDecks.map(d => (
                <button
                  key={d.id}
                  onClick={() => handleLoadSavedDeck(d)}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium transition shrink-0 ${
                    activeDeckName === d.name
                      ? 'bg-amber-500 text-slate-950 font-bold'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {d.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Game Mode Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
          {/* Duel Mode */}
          <div className="group relative bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800 hover:border-amber-500/50 rounded-2xl p-5 sm:p-6 shadow-xl transition-all flex flex-col justify-between">
            <div>
              <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-red-950/80 border border-red-500/30 flex items-center justify-center text-red-400 mb-3 sm:mb-4">
                <Swords className="w-5 h-5 sm:w-6 sm:h-6" />
              </div>
              <h2 className="text-xl sm:text-2xl font-bold text-slate-100 group-hover:text-amber-400 transition">
                Duel Mode (ดวล 2 ผู้เล่น)
              </h2>
              <p className="text-xs sm:text-sm text-slate-400 mt-2 leading-relaxed">
                การประลองตัวต่อตัวตามกฎทางการ <b>Rule Book Ver. 3.2</b> เต็มรูปแบบ บริหาร Avatar Zone (สูงสุด 4 ตัว), ก่อสร้าง Construct, ร่ายเวทย์ และชิงทำลาย LIFE Deck 5 ใบ
              </p>
            </div>

            <div className="mt-5 sm:mt-6 flex gap-2">
              <button
                onClick={() => startMatch('DUEL')}
                className="flex-1 py-2.5 sm:py-3 rounded-xl bg-gradient-to-r from-red-600 to-amber-600 hover:from-red-500 hover:to-amber-500 text-white font-bold text-xs sm:text-sm shadow-lg shadow-red-950/50 flex items-center justify-center gap-2 transition cursor-pointer"
              >
                <Play className="w-4 h-4 fill-white" /> เล่นทันที (Quick Match)
              </button>
              <button
                onClick={() => setCurrentView('LOBBY')}
                className="px-3 sm:px-4 py-2.5 sm:py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs border border-slate-700 transition"
                title="สร้างห้องให้เพื่อนเข้าร่วม"
              >
                สร้างห้อง
              </button>
            </div>
          </div>

          {/* Ad-Mua Mode */}
          <div className="group relative bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800 hover:border-purple-500/50 rounded-2xl p-5 sm:p-6 shadow-xl transition-all flex flex-col justify-between">
            <div>
              <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-purple-950/80 border border-purple-500/30 flex items-center justify-center text-purple-400 mb-3 sm:mb-4">
                <Users className="w-5 h-5 sm:w-6 sm:h-6" />
              </div>
              <h2 className="text-xl sm:text-2xl font-bold text-slate-100 group-hover:text-purple-400 transition">
                โหมดอัดมั่ว (Ad-Mua 3–4 คน)
              </h2>
              <p className="text-xs sm:text-sm text-slate-400 mt-2 leading-relaxed">
                โหมดชุลมุนหลายคน Free-For-All วนเทิร์นตามเข็มนาฬิกา คนสุดท้ายของรอบแรกได้ตีคนแรก พร้อมระบบโควตา React Magic รวม และการกำจัดผู้เล่นจนเหลือผู้ชนะคนสุดท้าย
              </p>
            </div>

            <div className="mt-5 sm:mt-6 flex gap-2">
              <button
                onClick={() => startMatch('AD_MUA')}
                className="flex-1 py-2.5 sm:py-3 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold text-xs sm:text-sm shadow-lg shadow-purple-950/50 flex items-center justify-center gap-2 transition cursor-pointer"
              >
                <Play className="w-4 h-4 fill-white" /> เล่นโหมดอัดมั่ว
              </button>
              <button
                onClick={() => setCurrentView('LOBBY')}
                className="px-3 sm:px-4 py-2.5 sm:py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs border border-slate-700 transition"
                title="สร้างห้องสำหรับกลุ่มเพื่อน 3-4 คน"
              >
                สร้างห้อง
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="w-full max-w-5xl mx-auto text-center py-3 border-t border-slate-900 text-[11px] text-slate-500 flex flex-col md:flex-row items-center justify-between gap-1.5">
        <span>© 2026 Battle of Talingchan Online • Licensed by PASULOL & Team YUK</span>
        <div className="flex space-x-3 text-slate-400">
          <span>กฎฉบับ 3.2 ของแทร่</span>
          <span>•</span>
          <span>โมบายล์ Responsive</span>
          <span>•</span>
          <span>คลังข้อมูลการ์ด 2,014 ใบ</span>
        </div>
      </footer>

      {/* Auth Modal */}
      <AuthModal
        isOpen={isAuthOpen}
        onClose={() => setIsAuthOpen(false)}
        onSuccess={(u) => setUser(u)}
      />
    </div>
  );
}
