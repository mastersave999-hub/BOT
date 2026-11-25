'use client';

import React from 'react';
import { CardInstance } from '../../engine/types';
import { X, Sparkles, Shield, Swords, Layers } from 'lucide-react';

interface CardDetailModalProps {
  cardInstance: CardInstance | null;
  onClose: () => void;
}

export const CardDetailModal: React.FC<CardDetailModalProps> = ({ cardInstance, onClose }) => {
  if (!cardInstance) return null;
  const { card } = cardInstance;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col md:flex-row max-h-[90vh]">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-10 p-1.5 rounded-full bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 transition"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Card Image Display */}
        <div className="w-full md:w-1/2 p-4 flex items-center justify-center bg-slate-950/60 border-b md:border-b-0 md:border-r border-slate-800">
          <img
            src={card.imageUrl}
            alt={card.name}
            className="w-48 h-72 object-contain rounded-xl shadow-lg border border-slate-700"
          />
        </div>

        {/* Card Details & Rulings */}
        <div className="w-full md:w-1/2 p-5 flex flex-col justify-between overflow-y-auto space-y-4">
          <div>
            <div className="flex items-center space-x-2">
              <span className="text-xs px-2 py-0.5 rounded bg-amber-600/30 text-amber-400 border border-amber-500/40 font-mono">
                {card.printId}
              </span>
              <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-medium">
                {card.type} {card.subtype ? `(${card.subtype})` : ''}
              </span>
              <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-400">
                {card.rarity}
              </span>
            </div>

            <h2 className="text-xl font-bold text-slate-100 mt-2">
              {card.name}
            </h2>

            {/* Stats Bar */}
            <div className="grid grid-cols-3 gap-2 mt-3 p-2 bg-slate-950/80 rounded-lg border border-slate-800 text-center text-xs">
              <div>
                <span className="text-slate-400 block text-[10px]">ค่าใช้ (Cost)</span>
                <span className="font-bold text-amber-400 text-sm">{card.cost ?? 0}</span>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px]">เจม (GEM)</span>
                <span className="font-bold text-emerald-400 text-sm">{card.gem ?? 0}</span>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px]">พลัง (Power)</span>
                <span className="font-bold text-red-400 text-sm">{card.power ?? 0}</span>
              </div>
            </div>

            {/* Card Effect Text */}
            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1 flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                ความสามารถหลัก (Main Effect)
              </h3>
              <div className="p-3 bg-slate-950/50 rounded-lg border border-slate-800 text-xs text-slate-200 leading-relaxed whitespace-pre-line">
                {card.mainEffect || 'ไม่มีความสามารถพิเศษ (Normal Avatar)'}
              </div>
            </div>

            {/* Flavor Text */}
            {card.favorText && (
              <div className="mt-3 text-[11px] italic text-slate-400 border-l-2 border-slate-700 pl-2">
                "{card.favorText}"
              </div>
            )}
          </div>

          <div className="pt-2 border-t border-slate-800 text-[10px] text-slate-500 flex justify-between">
            <span>หมวด: {card.symbol || 'ทั่วไป'} | สี: {card.color}</span>
            <span>{card.creator || 'Team YUK / PASULOL'}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
