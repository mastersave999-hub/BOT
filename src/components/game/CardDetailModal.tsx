'use client';

import React from 'react';
import { CardInstance } from '../../engine/types';
import { ClassificationBadge, OrnamentDivider, getCardClassification } from './botTheme';
import { X, Sparkles } from 'lucide-react';

interface CardDetailModalProps {
  cardInstance: CardInstance | null;
  onClose: () => void;
  /** Effective summon Cost after continuous Land Magic auras (hand cards only). */
  effectiveCost?: number;
  /** Always-available escape hatch into the Phase 8 Universal Manual Effect Resolver. */
  onManualOverride?: () => void;
}

/**
 * BOT Card Inspector: uncropped original artwork, exact Thai text and the
 * classifyCard() resolution status. Tap-first: opened by tapping the info
 * corner of any visible card.
 */
export const CardDetailModal: React.FC<CardDetailModalProps> = ({ cardInstance, onClose, effectiveCost, onManualOverride }) => {
  if (!cardInstance) return null;
  const { card } = cardInstance;
  const classification = getCardClassification(card);
  const isAuto = classification.status === 'VERIFIED_WORKING';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`ตรวจการ์ด ${card.name}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-3 sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="relative w-full max-w-lg rounded-2xl border border-amber-500/40 bg-slate-900 shadow-2xl overflow-hidden flex flex-col md:flex-row max-h-[92vh]"
      >
        {/* Close Button */}
        <button
          onClick={onClose}
          aria-label="ปิดหน้าต่างตรวจการ์ด"
          className="absolute top-3 right-3 z-10 p-1.5 rounded-full bg-slate-950/80 text-amber-300 border border-amber-500/40 hover:text-white hover:bg-amber-500 transition"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Original Card Art — uncropped, original aspect ratio */}
        <div className="w-full md:w-1/2 p-4 flex items-center justify-center bg-slate-950/80 border-b md:border-b-0 md:border-r border-amber-500/20">
          <img
            src={card.imageUrl}
            alt={card.name}
            className="max-h-[38vh] md:max-h-[70vh] w-auto max-w-full object-contain rounded-lg shadow-lg bot-card-depth"
            referrerPolicy="no-referrer"
            crossOrigin="anonymous"
          />
        </div>

        {/* Card Details */}
        <div className="w-full md:w-1/2 p-4 sm:p-5 flex flex-col gap-3 overflow-y-auto">
          <div>
            <div className="flex flex-wrap items-center gap-1.5 pr-10">
              <span className="text-xs px-2 py-0.5 rounded bg-slate-950 text-amber-300 border border-amber-500/40 font-mono">
                {card.printId}
              </span>
              <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-200 font-medium">
                {card.type} {card.subtype ? `(${card.subtype})` : ''}
              </span>
              <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-400">
                {card.rarity}
              </span>
              <ClassificationBadge card={card} size="md" />
            </div>

            <h2 className="text-xl font-bold text-amber-300 mt-2">{card.name}</h2>
          </div>

          <OrnamentDivider />

          {/* Stats */}
          <div className="grid grid-cols-3 gap-2 p-2 rounded-lg border border-amber-500/20 bg-slate-950/80 text-center text-xs">
            <div>
              <span className="text-slate-400 block text-[10px]">ค่าใช้ (Cost)</span>
              <span className="font-bold text-amber-400 text-sm">{card.cost ?? 0}</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[10px]">เจม (GEM)</span>
              <span className="font-bold text-emerald-400 text-sm">{card.gem ?? 0}</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[10px]">พลัง (POWER)</span>
              <span className="font-bold text-red-400 text-sm">{card.power ?? 0}</span>
            </div>
          </div>

          <p className="text-[11px] text-slate-300">
            หมวด (Symbol): <b className="text-slate-100">{card.symbol || 'ทั่วไป'}</b>
            {' · '}สี: <b className="text-slate-100">{card.color}</b>
          </p>

          {effectiveCost !== undefined && effectiveCost !== (card.cost ?? 0) && (
            <p className="rounded-lg border border-sky-500/40 bg-sky-950/40 px-2.5 py-1.5 text-[11px] text-sky-200">
              Cost จาก {card.cost ?? 0} กลายเป็น <b>{effectiveCost}</b> ตาม Land Magic ต่อเนื่องที่กำลังทำงาน
            </p>
          )}

          {/* Exact Thai effect text */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-400/90 mb-1 flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              ความสามารถหลัก (Main Effect)
            </h3>
            <div className="p-3 rounded-lg border border-slate-800 bg-slate-950/60 text-xs text-slate-200 leading-relaxed whitespace-pre-line">
              {card.mainEffect || 'ไม่มีความสามารถพิเศษ (Normal Avatar)'}
            </div>
          </div>

          {card.favorText && (
            <div className="text-[11px] italic text-slate-400 border-l-2 border-amber-500/40 pl-2">
              &ldquo;{card.favorText}&rdquo;
            </div>
          )}

          {/* Engine resolution status */}
          <div
            className={`rounded-lg border p-2.5 text-[11px] leading-relaxed ${
              isAuto
                ? 'border-emerald-500/40 bg-emerald-950/40 text-emerald-200'
                : 'border-amber-500/40 bg-red-950/40 text-amber-200'
            }`}
          >
            <p className="font-bold flex items-center gap-1.5">
              <ClassificationBadge card={card} size="md" />
              สถานะการแก้ผลโดยเอนจิน
            </p>
            <p className="mt-1 text-slate-300">
              {isAuto
                ? 'การ์ดนี้ถูกแก้ผลครบถ้วนโดยอัตโนมัติ 100% ตาม Rule Book 3.2'
                : `ต้องใช้ช่องทางจัดการด้วยมือ (Manual Fallback) เมื่อเล่น: ${classification.reason ?? 'ยังไม่รองรับ'}`}
            </p>
            {onManualOverride && (
              <button
                type="button"
                onClick={onManualOverride}
                className="mt-2 w-full rounded-lg border border-amber-400/60 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-200 hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
              >
                แก้ผลด้วยมือ (Manual Override)
              </button>
            )}
          </div>

          <div className="pt-1 border-t border-slate-800 text-[10px] text-slate-500 flex justify-between">
            <span>{card.creator || 'Team YUK / PASULOL'}</span>
            <span>Rule Book Ver. 3.2</span>
          </div>
        </div>
      </div>
    </div>
  );
};
