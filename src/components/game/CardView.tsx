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
        className={`relative ${sizeClasses} rounded-lg border-2 border-slate-700 shadow-lg transition-transform hover:scale-105 cursor-pointer ${
          isRested ? 'rotate-90 origin-center my-2' : ''
        } ${className}`}
      >
        <CardBack className="absolute inset-0" />
      </div>
    );
  }

  // Face-up cards show the artwork alone — no frame, no cost/gem badges, no type
  // or power labels. Stats live in the confirmation bar and the inspect modal.
  return (
    <div
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onInspect?.();
      }}
      className={`group relative ${sizeClasses} rounded-lg overflow-hidden bg-slate-950 shadow-lg transition-all hover:scale-105 hover:z-20 cursor-pointer ${
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
            // Hide the broken image so the name fallback underneath shows through.
            (e.target as HTMLElement).style.display = 'none';
          }}
        />
      ) : null}
      {/* Name fallback: only visible when the card has no artwork or it fails to load. */}
      <div className="absolute inset-0 flex items-center justify-center p-1 text-center font-semibold leading-tight text-slate-200">
        {card.name}
      </div>
    </div>
  );
};
