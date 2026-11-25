'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Copy, Check, ArrowRight, Play, ArrowLeft, Loader2, AlertTriangle, User } from 'lucide-react';
import type { GameState } from '../../engine/types';
import {
  hostRoom,
  joinRoom,
  normalizeRoomCode,
  ROOM_LIMITS,
  type HostController,
  type MatchSession,
  type PlayerSetup,
  type RoomController,
  type RoomMode
} from '../../engine/multiplayer';

interface MatchmakingLobbyProps {
  onBack: () => void;
  defaultPlayerName: string;
  localDeck: Pick<PlayerSetup, 'mainDeck' | 'lifeDeck'>;
  buildState: (mode: RoomMode, setups: PlayerSetup[]) => GameState;
  onMatchReady: (session: MatchSession) => void;
}

export const MatchmakingLobby: React.FC<MatchmakingLobbyProps> = ({
  onBack,
  defaultPlayerName,
  localDeck,
  buildState,
  onMatchReady
}) => {
  const [playerName, setPlayerName] = useState<string>(defaultPlayerName);
  const [roomCodeInput, setRoomCodeInput] = useState<string>('');
  const [generatedRoomCode, setGeneratedRoomCode] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'HOST' | 'JOIN' | null>(null);
  const [hostMode, setHostMode] = useState<RoomMode>('DUEL');
  const [roster, setRoster] = useState<string[]>([]);
  const [capacity, setCapacity] = useState<number>(2);
  const controllerRef = useRef<RoomController | HostController | null>(null);
  const hostControllerRef = useRef<HostController | null>(null);

  useEffect(() => {
    return () => controllerRef.current?.cancel();
  }, []);

  const localSetup = (): PlayerSetup => ({
    name: playerName.trim() || 'ผู้เล่น',
    mainDeck: localDeck.mainDeck,
    lifeDeck: localDeck.lifeDeck
  });

  const resetRoom = () => {
    controllerRef.current?.cancel();
    controllerRef.current = null;
    hostControllerRef.current = null;
    setGeneratedRoomCode(null);
    setBusy(null);
    setStatus('');
    setRoster([]);
  };

  const handleRoster = (names: string[], max: number) => {
    setRoster(names);
    setCapacity(max);
  };

  const handleCreateRoom = (mode: RoomMode) => {
    resetRoom();
    setError(null);
    setHostMode(mode);
    setBusy('HOST');
    setStatus('กำลังสร้างห้อง...');
    const controller = hostRoom(mode, localSetup(), setups => buildState(mode, setups), {
      onCode: setGeneratedRoomCode,
      onPlayers: handleRoster,
      onStatus: setStatus,
      onError: message => {
        setError(message);
        resetRoom();
      },
      onReady: onMatchReady
    });
    controllerRef.current = controller;
    hostControllerRef.current = controller;
  };

  const handleJoinRoom = () => {
    const code = normalizeRoomCode(roomCodeInput);
    if (!code) return;
    resetRoom();
    setError(null);
    setBusy('JOIN');
    controllerRef.current = joinRoom(code, localSetup(), {
      onPlayers: handleRoster,
      onStatus: setStatus,
      onError: message => {
        setError(message);
        resetRoom();
      },
      onReady: onMatchReady
    });
  };

  const handleCopyLink = () => {
    if (!generatedRoomCode) return;
    navigator.clipboard.writeText(generatedRoomCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleBack = () => {
    controllerRef.current?.cancel();
    onBack();
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-kanit flex flex-col items-center justify-between p-6">
      {/* Header */}
      <header className="w-full max-w-2xl flex items-center justify-between py-4 border-b border-slate-800">
        <button
          onClick={handleBack}
          className="p-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition"
        >
          <ArrowLeft className="w-4 h-4" /> ย้อนกลับ
        </button>
        <h1 className="text-lg font-bold text-amber-400">ระบบจับคู่ & เล่นกับเพื่อนออนไลน์</h1>
        <div className="w-20" />
      </header>

      {/* Main Form Box */}
      <div className="w-full max-w-xl bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-6 my-auto">
        {/* Player Name Input */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-400">ชื่อของคุณในเกม:</label>
          <input
            type="text"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            className="w-full px-4 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-sm text-slate-100 focus:outline-none focus:border-amber-500 transition"
            placeholder="ตั้งชื่อผู้เล่น..."
          />
        </div>

        {error && (
          <div role="alert" className="flex items-start gap-2 p-3 rounded-xl bg-red-950/50 border border-red-500/40 text-xs text-red-300">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {busy === 'HOST' ? (
          <div className="space-y-5 text-center p-4 bg-slate-950 rounded-xl border border-slate-800">
            {generatedRoomCode ? (
              <>
                <div className="space-y-1">
                  <span className="text-xs text-slate-400 block">
                    สร้างห้อง {hostMode === 'DUEL' ? 'Duel (2 คน)' : 'อัดมั่ว (3-4 คน)'} สำเร็จแล้ว!
                  </span>
                  <span className="text-3xl font-extrabold text-amber-400 font-mono tracking-widest block">
                    {generatedRoomCode}
                  </span>
                </div>

                <div className="flex items-center justify-center gap-2">
                  <button
                    onClick={handleCopyLink}
                    className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold flex items-center gap-1.5 transition text-slate-200"
                  >
                    {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                    {copied ? 'คัดลอกรหัสแล้ว!' : 'คัดลอกรหัสห้อง'}
                  </button>
                </div>

                <p className="text-xs text-slate-500">
                  {hostMode === 'DUEL'
                    ? 'ส่งรหัสนี้ให้เพื่อน แล้วอยู่หน้านี้ไว้ เมื่อเพื่อนใส่รหัส ระบบจะพาทั้งคู่เข้าสนามพร้อมกันอัตโนมัติ'
                    : 'ส่งรหัสนี้ให้เพื่อน 2-3 คน แล้วกด "เริ่มเกม" เมื่อทุกคนเข้าห้องครบ'}
                </p>

                <RosterList names={roster} capacity={capacity} />
              </>
            ) : null}

            <div role="status" className="flex items-center justify-center gap-2 text-sm text-emerald-400">
              <Loader2 className="w-4 h-4 animate-spin" />
              {status}
            </div>

            {hostMode === 'AD_MUA' && (
              <button
                onClick={() => hostControllerRef.current?.start()}
                disabled={roster.length < ROOM_LIMITS.AD_MUA.min}
                className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-sm flex items-center justify-center gap-2 transition"
              >
                <Play className="w-4 h-4 fill-white" />
                เริ่มเกม ({roster.length} คน)
              </button>
            )}

            <button
              onClick={resetRoom}
              className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs transition"
            >
              ยกเลิกห้อง
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <span className="text-xs font-semibold text-slate-400 block">เลือกสร้างห้องใหม่:</span>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => handleCreateRoom('DUEL')}
                disabled={busy !== null}
                className="p-4 rounded-xl bg-gradient-to-br from-red-950/60 to-slate-900 border border-red-500/30 hover:border-red-500 disabled:opacity-50 text-left transition flex flex-col justify-between"
              >
                <div>
                  <span className="font-bold text-red-400 text-sm block">ห้อง Duel (2 คน)</span>
                  <span className="text-[11px] text-slate-400 mt-1 block">ดวลกติกาหลัก 1 ต่อ 1</span>
                </div>
                <span className="mt-3 text-xs text-amber-400 font-semibold flex items-center gap-1">
                  สร้างห้อง Duel <ArrowRight className="w-3.5 h-3.5" />
                </span>
              </button>

              <button
                onClick={() => handleCreateRoom('AD_MUA')}
                disabled={busy !== null}
                className="p-4 rounded-xl bg-gradient-to-br from-purple-950/60 to-slate-900 border border-purple-500/30 hover:border-purple-500 disabled:opacity-50 text-left transition flex flex-col justify-between"
              >
                <div>
                  <span className="font-bold text-purple-400 text-sm block">ห้องอัดมั่ว (3-4 คน)</span>
                  <span className="text-[11px] text-slate-400 mt-1 block">Multiplayer Free-for-all</span>
                </div>
                <span className="mt-3 text-xs text-amber-400 font-semibold flex items-center gap-1">
                  สร้างห้องอัดมั่ว <ArrowRight className="w-3.5 h-3.5" />
                </span>
              </button>
            </div>

            <div className="flex items-center my-4">
              <div className="flex-1 border-t border-slate-800" />
              <span className="px-3 text-slate-500 text-xs">หรือเข้าร่วมห้องเพื่อน</span>
              <div className="flex-1 border-t border-slate-800" />
            </div>

            <div className="space-y-2">
              <label htmlFor="room-code" className="text-xs font-semibold text-slate-400">กรอกรหัสห้อง (Room Code):</label>
              <div className="flex gap-2">
                <input
                  id="room-code"
                  type="text"
                  placeholder="เช่น BOT-K7M2Q"
                  value={roomCodeInput}
                  onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229 && roomCodeInput.trim() && busy === null) {
                      handleJoinRoom();
                    }
                  }}
                  disabled={busy === 'JOIN'}
                  className="flex-1 px-4 py-2 bg-slate-950 border border-slate-700 rounded-xl text-sm font-mono tracking-wider focus:outline-none focus:border-amber-500 uppercase"
                />
                <button
                  disabled={!roomCodeInput.trim() || busy !== null}
                  onClick={handleJoinRoom}
                  className="px-6 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-bold text-xs transition flex items-center gap-1.5"
                >
                  {busy === 'JOIN' ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> กำลังเชื่อมต่อ
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5 fill-slate-950" /> เข้าร่วมห้อง
                    </>
                  )}
                </button>
              </div>
              {busy === 'JOIN' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span role="status" className="text-xs text-emerald-400">{status}</span>
                    <button onClick={resetRoom} className="text-xs text-slate-400 hover:text-slate-200 underline">
                      ยกเลิก
                    </button>
                  </div>
                  {roster.length > 0 && <RosterList names={roster} capacity={capacity} />}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer Info */}
      <footer className="text-xs text-slate-600 text-center">
        เชื่อมต่อตรงระหว่างผู้เล่น (P2P) ไม่ต้องติดตั้งโปรแกรมเสริม
      </footer>
    </div>
  );
};

const RosterList: React.FC<{ names: string[]; capacity: number }> = ({ names, capacity }) => (
  <ul aria-label="ผู้เล่นในห้อง" className="space-y-1.5 text-left">
    {Array.from({ length: capacity }, (_, index) => {
      const name = names[index];
      return (
        <li
          key={index}
          className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs ${
            name ? 'bg-slate-900 border-emerald-700/50 text-slate-100' : 'bg-slate-950 border-dashed border-slate-800 text-slate-600'
          }`}
        >
          <User className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{name ?? 'รอผู้เล่น...'}</span>
          {index === 0 && name && <span className="ml-auto text-[10px] text-amber-400 font-semibold">โฮสต์</span>}
        </li>
      );
    })}
  </ul>
);
