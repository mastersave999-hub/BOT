'use client';

import React from 'react';
import { CardInstance } from '../../engine/types';
import { CardBack } from './botTheme';

interface CardProps {
  cardInstance: CardInstance;
  isOpponent?: boolean;
  isRested?: boolean;
  isSelected?: boolean;
  onClick?: () => void;
  onInspect?: () => void;
  className?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
}

/** Per-color frame accent (Rule Book card colors: แดง ฟ้า เขียว ม่วง ไร้สี). */
const FRAME_GRADIENT: Record<string, string> = {
  'แดง': 'bg-gradient-to-br from-rose-400/80 via-slate-900 to-rose-800/80',
  'ฟ้า': 'bg-gradient-to-br from-sky-400/80 via-slate-900 to-sky-800/80',
  'เขียว': 'bg-gradient-to-br from-emerald-400/80 via-slate-900 to-emerald-800/80',
  'ม่วง': 'bg-gradient-to-br from-violet-400/80 via-slate-900 to-violet-800/80',
};
const DEFAULT_FRAME_GRADIENT = 'bg-gradient-to-br from-amber-300/80 via-slate-900 to-amber-700/80';

/** Badge metrics scale with the card size so xs board tiles stay readable. */
const BADGE_SIZE = {
  xs: 'h-3.5 w-3.5 text-[7px]',
  sm: 'h-4 w-4 text-[9px]',
  md: 'h-5 w-5 text-[10px]',
  lg: 'h-6 w-6 text-xs',
} as const;

export const CardView: React.FC<CardProps> = ({
  cardInstance,
  isOpponent = false,
  isRested = false,
  isSelected = false,
  onClick,
  onInspect,
  className = '',
  size = 'md'
}) => {
  const { card, isFaceUp } = cardInstance;

  const sizeClasses = {
    // xs scales with viewport height (dvh) so short preview panes and tall phones
    // both keep the whole playmat inside one screen.
    xs: 'w-[clamp(2.5rem,8dvh,3.25rem)] h-[clamp(3.25rem,11dvh,4.5rem)] text-[9px]',
    sm: 'w-16 h-24 text-[10px]',
    md: 'w-24 h-36 text-xs',
    lg: 'w-32 h-48 text-sm'
  }[size];

  if (!isFaceUp) {
    return (
      <div
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          onInspect?.();
        }}
        className={`group relative ${sizeClasses} rounded-lg transition-transform duration-200 hover:scale-105 hover:-translate-y-0.5 cursor-pointer ${
          isRested ? 'rotate-90 origin-center my-2' : ''
        } ${className}`}
      >
        <CardBack className="absolute inset-0" />
        <span className="pointer-events-none absolute inset-0 rounded-lg ring-0 ring-amber-300/0 transition-shadow duration-200 group-hover:ring-2 group-hover:ring-amber-300/50 group-hover:shadow-[0_0_14px_rgba(251,191,36,0.25)]" />
      </div>
    );
  }

  const frameGradient = FRAME_GRADIENT[card.color] ?? DEFAULT_FRAME_GRADIENT;
  const badgeSize = BADGE_SIZE[size];
  const showCost = (card.cost ?? 0) > 0;
  const showPower = (card.power ?? 0) > 0 && (card.type === 'Avatar' || card.type === 'Token');
  const showGem = (card.gem ?? 0) > 0;

  return (
    <div
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onInspect?.();
      }}
      className={`group relative ${sizeClasses} rounded-lg transition-all duration-200 hover:scale-105 hover:-translate-y-0.5 hover:z-20 cursor-pointer ${
        isRested ? 'rotate-90 origin-center my-3' : ''
      } ${isSelected ? 'scale-[1.06] -translate-y-1' : ''} ${className}`}
      title={card.name}
    >
      {/* Color-coded frame: a 2px gradient bezel around the art window. */}
      <div
        className={`absolute inset-0 rounded-lg p-[2px] shadow-[0_2px_4px_rgba(0,0,0,0.55),0_6px_14px_rgba(0,0,0,0.4)] ${frameGradient} ${
          isSelected
            ? 'ring-2 ring-amber-300 shadow-[0_0_18px_rgba(251,191,36,0.45),0_6px_14px_rgba(0,0,0,0.4)]'
            : ''
        }`}
      >
        <div className="relative h-full w-full overflow-hidden rounded-[6px] bg-slate-950">
          {card.imageUrl ? (
            <img
              src={card.imageUrl}
              alt={card.name}
              referrerPolicy="no-referrer"
              crossOrigin="anonymous"
              className="absolute inset-0 h-full w-full object-cover"
              loading="lazy"
              onError={(e) => {
                // Hide the broken image so the name fallback underneath shows through.
                (e.target as HTMLElement).style.display = 'none';
              }}
            />
          ) : null}
          {/* Name fallback: only visible when the card has no artwork or it fails to load. */}
          <div className="absolute inset-0 flex items-center justify-center p-1 text-center font-semibold leading-tight text-slate-200">
            {card.name}
          </div>

          {/* Name scrim: appears on hover so board cards stay pure art at rest. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-1 bg-gradient-to-t from-slate-950/95 via-slate-950/70 to-transparent px-1 pb-0.5 pt-2 opacity-0 transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
            <span className="block truncate text-center font-bold leading-tight text-amber-100">{card.name}</span>
          </div>

          {/* Holo sheen sweep on hover. */}
          <span className="bot-card-sheen pointer-events-none absolute inset-0" aria-hidden="true" />

          {/* Stat badges — corners only, artwork stays unobstructed. */}
          {showCost && (
            <span
              className={`absolute left-0.5 top-0.5 flex ${badgeSize} items-center justify-center rounded-full border border-amber-300/70 bg-slate-950/90 font-black leading-none text-amber-300 shadow`}
              aria-label={`Cost ${card.cost}`}
            >
              {card.cost}
            </span>
          )}
          {showGem && (
            <span
              className={`absolute bottom-0.5 left-0.5 flex ${badgeSize} items-center justify-center rounded-full border border-emerald-300/70 bg-slate-950/90 font-black leading-none text-emerald-300 shadow`}
              aria-label={`GEM ${card.gem}`}
            >
              {card.gem}
            </span>
          )}
          {showPower && (
            <span
              className={`absolute bottom-0.5 right-0.5 flex ${badgeSize} items-center justify-center rounded-md border border-red-400/70 bg-slate-950/90 font-black leading-none text-red-300 shadow`}
              aria-label={`POWER ${card.power}`}
            >
              {card.power}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
