'use client';

import React from 'react';
import { CardInstance } from '../../engine/types';
import { CardBack } from './botTheme';
import { Info } from 'lucide-react';

interface CardProps {
  cardInstance: CardInstance;
  isOpponent?: boolean;
  isRested?: boolean;
  isSelected?: boolean;
  onClick?: () => void;
  onInspect?: () => void;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

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
        className={`relative ${sizeClasses} rounded-lg border-2 border-slate-700 shadow-lg transition-transform hover:scale-105 cursor-pointer ${
          isRested ? 'rotate-90 origin-center my-2' : ''
        } ${className}`}
      >
        <CardBack className="absolute inset-0" />
      </div>
    );
  }

  // Color border accent
  const colorAccents: Record<string, string> = {
    'แดง': 'border-red-500 shadow-red-950/50',
    'ฟ้า': 'border-blue-500 shadow-blue-950/50',
    'เขียว': 'border-emerald-500 shadow-emerald-950/50',
    'ม่วง': 'border-purple-500 shadow-purple-950/50',
    'ไร้สี': 'border-slate-500 shadow-slate-950/50'
  };

  const borderClass = colorAccents[card.color] || 'border-slate-600 shadow-slate-950/50';

  // Card face only: full-bleed artwork with a name strip. Stats, cost and rules
  // live in the detail view (tap the info button or select the card).
  return (
    <div
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onInspect?.();
      }}
      className={`group relative ${sizeClasses} rounded-lg border-2 ${borderClass} bg-slate-900 bot-card-depth overflow-hidden transition-all hover:scale-105 hover:z-20 cursor-pointer ${
        isRested ? 'rotate-90 origin-center my-3' : ''
      } ${isSelected ? 'ring-2 ring-amber-400 shadow-lg shadow-amber-500/30' : ''} ${className}`}
      title={card.name}
    >
      {card.imageUrl ? (
        <img
          src={card.imageUrl}
          alt={card.name}
          referrerPolicy="no-referrer"
          crossOrigin="anonymous"
          className="absolute inset-0 h-full w-full object-cover"
          loading="lazy"
          onError={(e) => {
            // Hide the broken image so the name fallback below stays readable.
            (e.target as HTMLElement).style.display = 'none';
          }}
        />
      ) : null}

      {/* Name strip doubles as the fallback face when no artwork loaded. */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-950 via-slate-950/90 to-transparent px-1 pb-1 pt-3">
        <span className="block truncate text-center font-semibold leading-tight text-slate-100">
          {card.name}
        </span>
      </div>

      {onInspect && (
        <button
          type="button"
          aria-label={`ดูรายละเอียด ${card.name}`}
          title="ดูรายละเอียดการ์ด"
          onClick={(e) => {
            e.stopPropagation();
            onInspect();
          }}
          className="absolute top-1 right-1 z-10 w-5 h-5 rounded-full bg-slate-950/90 border border-amber-400/70 text-amber-300 flex items-center justify-center hover:bg-amber-500 hover:text-slate-950 transition"
        >
          <Info className="w-3 h-3" />
        </button>
      )}
    </div>
  );
};
