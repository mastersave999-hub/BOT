'use client';

import React, { useMemo, useState } from 'react';
import { Card } from '../../engine/types';
import { parseDeckText, type DeckTextParseResult } from '../../engine/deckTextCodec';
import { X, ClipboardPaste, AlertTriangle, CheckCircle, Info } from 'lucide-react';

const PLACEHOLDER = `สุดโหด

Main Deck

2x B2SA-008-SR
1x BT01-039-R
1x PRMO-0562-C

Life Cards

1x BT05-072-C
1x BT05-073-C
1x BT05-074-C
1x BT05-075-C
1x KD03-022-C`;

interface DeckImportModalProps {
  catalog: Card[];
  currentDeckName: string;
  onApply: (result: DeckTextParseResult) => void;
  onClose: () => void;
}

/** One-paste deck list importer: live preview + Rulebook v3.2 diagnostics before applying. */
export const DeckImportModal: React.FC<DeckImportModalProps> = ({ catalog, currentDeckName, onApply, onClose }) => {
  const [text, setText] = useState('');

  const parsed = useMemo(
    () => parseDeckText(text, catalog, currentDeckName),
    [text, catalog, currentDeckName]
  );

  const hasInput = text.trim().length > 0;
  const hasCards = parsed.counts.main > 0 || parsed.counts.life > 0;
  const problemCount = parsed.unknownCodes.length + parsed.validation.errors.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="นำเข้ารหัสเด็ค"
      onClick={onClose}
    >
      <div
        className="bot-modal-in flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-amber-500/40 bg-slate-950 shadow-2xl sm:rounded-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-800 bg-gradient-to-r from-slate-950 via-red-950/40 to-slate-950 px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-bold text-amber-400">
            <ClipboardPaste className="h-4 w-4" />
            วางรหัสเด็ค (Import)
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิดหน้าต่างนำเข้าเด็ค"
            className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <textarea
            value={text}
            onChange={event => setText(event.target.value)}
            placeholder={PLACEHOLDER}
            rows={10}
            spellCheck={false}
            aria-label="รหัสเด็คสำหรับนำเข้า"
            className="w-full resize-y rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-slate-200 placeholder:text-slate-600 focus:border-amber-500 focus:outline-none"
          />

          {hasInput && (
            <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="max-w-full truncate text-xs font-bold text-amber-300">
                  {parsed.deckName ?? currentDeckName}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                  parsed.counts.main === 50 ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-amber-300'
                }`}>
                  Main {parsed.counts.main}/50
                </span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                  parsed.counts.life === 5 ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-amber-300'
                }`}>
                  Life {parsed.counts.life}/5
                </span>
              </div>

              {parsed.unknownCodes.length > 0 && (
                <ul className="space-y-1 rounded-lg border border-amber-900/60 bg-amber-950/30 p-2 text-[10px] text-amber-200">
                  {parsed.unknownCodes.map(entry => (
                    <li key={`${entry.lineNumber}-${entry.code}`} className="flex items-start gap-1.5">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" />
                      <span>ไม่รู้จักรหัส "{entry.code}" (บรรทัด {entry.lineNumber})</span>
                    </li>
                  ))}
                </ul>
              )}

              {parsed.validation.errors.length > 0 && (
                <ul className="space-y-1 rounded-lg border border-red-900/60 bg-red-950/30 p-2 text-[10px] text-red-200">
                  {parsed.validation.errors.map((error, index) => (
                    <li key={index} className="flex items-start gap-1.5">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-red-400" />
                      <span>{error}</span>
                    </li>
                  ))}
                </ul>
              )}

              {parsed.warnings.length > 0 && (
                <ul className="space-y-1 text-[10px] text-slate-500">
                  {parsed.warnings.map((warning, index) => (
                    <li key={index} className="flex items-start gap-1.5">
                      <Info className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>{warning}</span>
                    </li>
                  ))}
                </ul>
              )}

              {hasCards && problemCount === 0 && parsed.validation.isValid && (
                <p className="flex items-center gap-1.5 text-[10px] font-semibold text-emerald-300">
                  <CheckCircle className="h-3 w-3" />
                  เด็คนี้ผ่านกติกาทางการ Ver 3.2 ครบถ้วน
                </p>
              )}
              {hasCards && problemCount === 0 && !parsed.validation.isValid && (
                <p className="flex items-center gap-1.5 text-[10px] text-slate-400">
                  <Info className="h-3 w-3 shrink-0" />
                  นำเข้าได้แม้เด็คยังไม่สมบูรณ์ — จัดต่อใน Deck Builder แล้วบันทึกเมื่อครบตามกฎ
                </p>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-slate-800 px-4 py-3">
          <button
            type="button"
            disabled={!hasCards}
            onClick={() => onApply(parsed)}
            className="w-full rounded-xl bg-amber-500 py-2.5 text-xs font-bold text-slate-950 shadow transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
          >
            นำเข้าเด็คนี้ (Apply to Slot)
          </button>
        </div>
      </div>
    </div>
  );
};
