'use client';

import React from 'react';
import type { Card, CardInstance } from '../../engine/types';
import { classifyCard, type CardClassification } from '../../engine/hybridMode';

/**
 * Shared Battle of Talingchan tabletop theme primitives.
 *
 * Visual identity rules (Phase 6):
 * - Flat 2D tabletop with restrained depth; gold (amber) trim and crimson accents only.
 * - The AUTO/MANUAL badge is driven exclusively by classifyCard() from hybridMode.ts.
 * - Badges stay compact so original card artwork and Thai text are never obscured.
 */

const classificationCache = new Map<string, CardClassification>();

/** Memoized classifyCard(): the parser is pure per card, so cache by print id. */
export function getCardClassification(card: Card): CardClassification {
  const cached = classificationCache.get(card.printId);
  if (cached) return cached;
  const classification = classifyCard(card);
  classificationCache.set(card.printId, classification);
  return classification;
}

export function instanceClassification(instance: CardInstance): CardClassification {
  return getCardClassification(instance.card);
}

interface ClassificationBadgeProps {
  card: Card;
  /** `sm` fits on board cards; `md` for hand/inspector/deck builder rows. */
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Compact AUTO / MANUAL resolution badge.
 * AUTO  = VERIFIED_WORKING  (resolves 100% automatically)
 * MANUAL = UNSUPPORTED / AMBIGUOUS (opens the Anti-Cheat Manual Fallback when played)
 */
export const ClassificationBadge: React.FC<ClassificationBadgeProps> = ({ card, size = 'sm', className = '' }) => {
  const { status, reason } = getCardClassification(card);
  const isAuto = status === 'VERIFIED_WORKING';
  const label = isAuto ? 'AUTO' : 'MANUAL';
  const title = isAuto
    ? 'AUTO — เอนจินแก้ผลการ์ดนี้ได้ครบถ้วนโดยอัตโนมัติ'
    : `MANUAL — ${reason ?? 'ต้องใช้ช่องทางจัดการด้วยมือ (Manual Fallback)'}`;
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center justify-center rounded-sm border font-black tracking-widest ${
        size === 'sm' ? 'px-1 py-px text-[7px] leading-none' : 'px-1.5 py-0.5 text-[9px] leading-none'
      } ${
        isAuto
          ? 'border-emerald-400/70 bg-emerald-950/90 text-emerald-300 shadow-[0_0_0_1px_rgba(251,191,36,0.25)]'
          : 'border-amber-400/80 bg-red-950/90 text-amber-300'
      } ${className}`}
    >
      {label}
    </span>
  );
};

/** Thin gold divider with a restrained Thai ornamental diamond motif. */
export const OrnamentDivider: React.FC<{ className?: string; label?: string }> = ({ className = '', label }) => (
  <div className={`flex items-center gap-2 ${className}`} aria-hidden="true">
    <span className="bot-gold-line h-px flex-1" />
    <span className="bot-ornament-diamond" />
    {label ? <span className="text-[9px] font-bold tracking-[0.2em] text-amber-400/80">{label}</span> : null}
    <span className="bot-ornament-diamond" />
    <span className="bot-gold-line h-px flex-1" />
  </div>
);

/** Official card back artwork (Battle of Talingchan — hand-inked pylon emblem). */
export const CARD_BACK_SRC = '/images/card-back.png';

interface CardBackProps {
  /** Fills its parent when left empty; pass sizing classes for standalone use. */
  className?: string;
}

/**
 * The one true card back. Every face-down card in the game renders through this
 * component so the hidden-information surface stays visually consistent
 * (deck piles, LIFE tiles, opponent hands, face-down board cards).
 */
export const CardBack: React.FC<CardBackProps> = ({ className = '' }) => (
  <span
    aria-hidden="true"
    className={`block overflow-hidden rounded-[inherit] border border-amber-500/30 bg-black shadow-[inset_0_0_0_1px_rgba(251,191,36,0.12),0_2px_6px_rgba(0,0,0,0.55)] ${className}`}
  >
    <img
      src={CARD_BACK_SRC}
      alt=""
      draggable={false}
      loading="lazy"
      className="h-full w-full object-cover"
    />
    {/* Restrained sheen so stacks read as physical cards, not flat images. */}
    <span className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/10 via-transparent to-black/45" />
  </span>
);

/** Standard gold-trimmed zone frame used across the playmat. */
export const zoneFrameClass =
  'rounded-xl border border-amber-500/25 bg-slate-950/70 shadow-[inset_0_1px_0_rgba(251,191,36,0.08),0_2px_6px_rgba(0,0,0,0.45)]';

export const zoneTitleClass = 'text-[10px] font-bold tracking-wide text-amber-300/90';
