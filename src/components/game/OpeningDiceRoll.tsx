'use client';

import React, { useEffect, useState } from 'react';
import { Dice1, Dice2, Dice3, Dice4, Dice5, Dice6, Crown } from 'lucide-react';

interface OpeningDiceRollProps {
  playerOrder: string[];
  rolls: Record<string, number>;
  names: Record<string, string>;
  meId: string;
  onClose: () => void;
}

const FACES = [Dice1, Dice2, Dice3, Dice4, Dice5, Dice6];
const ROLL_DURATION_MS = 1500;
const TICK_MS = 90;

const randomFace = () => Math.floor(Math.random() * 6) + 1;

export const OpeningDiceRoll: React.FC<OpeningDiceRollProps> = ({ playerOrder, rolls, names, meId, onClose }) => {
  const [settled, setSettled] = useState<boolean>(false);
  const [tumbling, setTumbling] = useState<Record<string, number>>(() =>
    Object.fromEntries(playerOrder.map(id => [id, randomFace()]))
  );

  useEffect(() => {
    const tick = setInterval(() => {
      setTumbling(Object.fromEntries(playerOrder.map(id => [id, randomFace()])));
    }, TICK_MS);
    const stop = setTimeout(() => {
      clearInterval(tick);
      setSettled(true);
    }, ROLL_DURATION_MS);
    return () => {
      clearInterval(tick);
      clearTimeout(stop);
    };
  }, [playerOrder]);

  const firstId = playerOrder[0];
  const iGoFirst = firstId === meId;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="opening-roll-title"
      className="fixed inset-0 z-[60] bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="w-full max-w-md bg-slate-900 border border-amber-500/50 rounded-2xl p-5 shadow-2xl space-y-4">
        <div className="text-center space-y-1">
          <h2 id="opening-roll-title" className="text-lg font-bold text-amber-400">
            ทอยลูกเต๋าเลือกผู้เล่นเริ่มก่อน
          </h2>
          <p className="text-xs text-slate-400">ผู้เล่นที่ทอยได้แต้มสูงสุดจะได้เล่นเทิร์นแรก</p>
        </div>

        <ul className="space-y-2">
          {[...playerOrder]
            .sort((a, b) => Object.keys(names).indexOf(a) - Object.keys(names).indexOf(b))
            .map(id => {
              const value = settled ? rolls[id] : tumbling[id];
              const Face = FACES[value - 1];
              const isWinner = settled && id === firstId;
              return (
                <li
                  key={id}
                  className={`flex items-center justify-between gap-3 px-3 py-2 rounded-xl border transition ${
                    isWinner ? 'bg-amber-950/50 border-amber-400' : 'bg-slate-950 border-slate-800'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {isWinner && <Crown className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />}
                    <span className="text-sm font-semibold text-slate-100 truncate">
                      {names[id]}
                      {id === meId && <span className="ml-1 text-[10px] text-emerald-400">(คุณ)</span>}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Face
                      className={`w-9 h-9 ${settled ? (isWinner ? 'text-amber-400' : 'text-slate-300') : 'text-slate-500 animate-pulse'}`}
                      aria-hidden="true"
                    />
                    <span className="w-5 text-right text-lg font-extrabold text-slate-100">{settled ? rolls[id] : '?'}</span>
                  </div>
                </li>
              );
            })}
        </ul>

        <div role="status" aria-live="polite" className="min-h-10 text-center text-sm">
          {settled ? (
            <span className="font-bold text-emerald-400">
              {iGoFirst ? 'คุณได้เล่นก่อน!' : `${names[firstId]} ได้เล่นก่อน`}
              {playerOrder.length > 2 && (
                <span className="block text-[11px] font-normal text-slate-400 mt-0.5">
                  ลำดับเทิร์น: {playerOrder.map(id => names[id]).join(' → ')}
                </span>
              )}
            </span>
          ) : (
            <span className="text-slate-400">กำลังทอยลูกเต๋า...</span>
          )}
        </div>

        <button
          onClick={onClose}
          disabled={!settled}
          className="w-full py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-bold text-sm transition"
        >
          เริ่มเกม
        </button>
      </div>
    </div>
  );
};
