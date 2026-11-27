'use client';

import React from 'react';
import { CardInstance } from '../../engine/types';
import { calculateNetPower } from '../../engine/layers';
import { CardBack, ClassificationDot } from './botTheme';

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

  return (
    <div
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onInspect?.();
      }}
      className={`group relative ${sizeClasses} rounded-lg border-2 ${borderClass} bg-slate-900 bot-card-depth flex flex-col overflow-hidden transition-all hover:scale-105 hover:z-20 cursor-pointer ${
        isRested ? 'rotate-90 origin-center my-3' : ''
      } ${isSelected ? 'ring-2 ring-amber-400 shadow-lg shadow-amber-500/30' : ''} ${className}`}
      title={card.name}
    >
      {/* Top Header: Cost, GEM, Name */}
      <div className="bg-slate-950/90 px-1 py-0.5 flex items-center justify-between border-b border-slate-800 text-[10px]">
        <div className="flex items-center space-x-1">
          {card.cost !== undefined && (
            <span className="w-3.5 h-3.5 rounded bg-amber-600 text-white font-bold flex items-center justify-center text-[9px]">
              {card.cost}
            </span>
          )}
          {card.gem !== undefined && card.gem > 0 && (
            <span className="w-3.5 h-3.5 rounded-full bg-emerald-600 text-white font-bold flex items-center justify-center text-[9px]">
              {card.gem}
            </span>
          )}
        </div>
        <span className="font-semibold text-slate-200 truncate flex-1 min-w-0 text-center px-1">
          {card.name}
        </span>
      </div>

      {/* Card Artwork / Image */}
      <div className="flex-1 relative bg-slate-950 flex items-center justify-center overflow-hidden">
        {/* Tiny A/M resolution tag (classifyCard) — corner only, art stays unobstructed */}
        <div className="absolute top-0.5 right-0.5 z-10">
          <ClassificationDot card={card} />
        </div>
        {card.imageUrl ? (
          <img
            src={card.imageUrl}
            alt={card.name}
            referrerPolicy="no-referrer"
            crossOrigin="anonymous"
            className="w-full h-full object-cover"
            loading="lazy"
            onError={(e) => {
              // Fallback to text placeholder on load fail
              (e.target as HTMLElement).style.display = 'none';
            }}
          />
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-transparent to-transparent opacity-80" />
      </div>

      {/* Card Footer: Power / Type — the type label shrinks with an ellipsis and the
          PWR badge never wraps, so the two can never collide on 64px-wide cards. */}
      <div className={`bg-slate-950/95 px-1 py-0.5 flex items-center justify-between gap-1 border-t border-slate-800 ${size === 'sm' ? 'text-[8px]' : 'text-[9px]'}`}>
        <span className="text-slate-400 font-medium truncate min-w-0 flex-1 flex items-center gap-0.5">
          {card.type}
          {cardInstance.attachedInstances && cardInstance.attachedInstances.length > 0 && (
            <span className="text-indigo-400 font-bold shrink-0" title="มีการ์ดสวมใส่">
              +{cardInstance.attachedInstances.length}
            </span>
          )}
        </span>
        {card.type === 'Avatar' && (() => {
          const netPwr = calculateNetPower(cardInstance);
          const isBuffed = netPwr > card.power;
          const isDebuffed = netPwr < card.power;
          return (
            <span
              title={`POWER ${netPwr}`}
              aria-label={`POWER ${netPwr}`}
              className={`shrink-0 whitespace-nowrap font-bold px-1 rounded border ${
                isBuffed
                  ? 'text-emerald-300 bg-emerald-950/90 border-emerald-600/60'
                  : isDebuffed
                  ? 'text-amber-300 bg-amber-950/90 border-amber-600/60'
                  : 'text-red-400 bg-red-950/80 border-red-800/60'
              }`}
            >
              {size === 'sm' ? netPwr : `PWR ${netPwr}`}
            </span>
          );
        })()}
      </div>
    </div>
  );
};
