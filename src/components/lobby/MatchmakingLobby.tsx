'use client';

import React, { useState } from 'react';
import { Users, Copy, Check, ArrowRight, ShieldCheck, Play, ArrowLeft } from 'lucide-react';

interface MatchmakingLobbyProps {
  onBack: () => void;
  onJoinRoom: (roomCode: string, isHost: boolean, playerName: string) => void;
}

export const MatchmakingLobby: React.FC<MatchmakingLobbyProps> = ({ onBack, onJoinRoom }) => {
  const [playerName, setPlayerName] = useState<string>('ผู้เล่นตลิ่งชัน');
  const [roomCodeInput, setRoomCodeInput] = useState<string>('');
  const [generatedRoomCode, setGeneratedRoomCode] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [gameMode, setGameMode] = useState<'DUEL' | 'AD_MUA'>('DUEL');

  const handleCreateRoom = (mode: 'DUEL' | 'AD_MUA') => {
    const randomCode = `BOT-${Math.floor(1000 + Math.random() * 9000)}`;
    setGeneratedRoomCode(randomCode);
    setGameMode(mode);
  };

  const handleCopyLink = () => {
    if (!generatedRoomCode) return;
    navigator.clipboard.writeText(generatedRoomCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-kanit flex flex-col items-center justify-between p-6">
      {/* Header */}
      <header className="w-full max-w-2xl flex items-center justify-between py-4 border-b border-slate-800">
        <button
          onClick={onBack}
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

        {/* Room Mode Choice */}
        {!generatedRoomCode ? (
          <div className="space-y-4">
            <span className="text-xs font-semibold text-slate-400 block">เลือกสร้างห้องใหม่:</span>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => handleCreateRoom('DUEL')}
                className="p-4 rounded-xl bg-gradient-to-br from-red-950/60 to-slate-900 border border-red-500/30 hover:border-red-500 text-left transition flex flex-col justify-between"
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
                className="p-4 rounded-xl bg-gradient-to-br from-purple-950/60 to-slate-900 border border-purple-500/30 hover:border-purple-500 text-left transition flex flex-col justify-between"
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

            {/* Divider */}
            <div className="flex items-center my-4">
              <div className="flex-1 border-t border-slate-800" />
              <span className="px-3 text-slate-500 text-xs">หรือเข้าร่วมห้องเพื่อน</span>
              <div className="flex-1 border-t border-slate-800" />
            </div>

            {/* Join Existing Room Code */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-400">กรอกรหัสห้อง (Room Code):</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="เช่น BOT-1234"
                  value={roomCodeInput}
                  onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                  className="flex-1 px-4 py-2 bg-slate-950 border border-slate-700 rounded-xl text-sm font-mono tracking-wider focus:outline-none focus:border-amber-500 uppercase"
                />
                <button
                  disabled={!roomCodeInput.trim()}
                  onClick={() => onJoinRoom(roomCodeInput.trim(), false, playerName)}
                  className="px-6 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-bold text-xs transition"
                >
                  เข้าร่วมห้อง
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* Host Waiting Screen */
          <div className="space-y-5 text-center p-4 bg-slate-950 rounded-xl border border-slate-800">
            <div className="space-y-1">
              <span className="text-xs text-slate-400 block">สร้างห้อง {gameMode} สำเร็จแล้ว!</span>
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
              ส่งรหัสห้องนี้ให้เพื่อนของคุณ เมื่อเพื่อนใส่รหัสจะเชื่อมต่อเข้าสนามแข่งทันที
            </p>

            <button
              onClick={() => onJoinRoom(generatedRoomCode, true, playerName)}
              className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm shadow-lg shadow-emerald-950/50 flex items-center justify-center gap-2 transition"
            >
              <Play className="w-4 h-4 fill-white" /> เข้าสู่สนามประลองทันที
            </button>
          </div>
        )}
      </div>

      {/* Footer Info */}
      <footer className="text-xs text-slate-600 text-center">
        ระบบเชื่อมต่อแบบ Realtime & Private Room รวดเร็ว ไม่ต้องติดตั้งโปรแกรมเสริม
      </footer>
    </div>
  );
};
