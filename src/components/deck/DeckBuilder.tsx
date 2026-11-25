'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { Card } from '../../engine/types';
import { validateDeck, DeckValidationResult } from '../../engine/deckValidator';
import allCardsData from '../../../cards_clean.json';
import starterDeckData from '../../engine/starterDeck.json';
import {
  Search, Plus, Minus, Trash2, CheckCircle, AlertTriangle, ArrowLeft,
  Shield, Sparkles, Filter, Save, Layers, Smartphone, Eye, LayoutGrid, List,
  RotateCcw, X, Info
} from 'lucide-react';

interface DeckBuilderProps {
  onBack: () => void;
  onSaveDeck: (mainDeck: Card[], lifeDeck: Card[], deckName: string) => void;
  initialMainDeck?: Card[];
  initialLifeDeck?: Card[];
  currentDeckName?: string;
}

// Resilient Card Image Component with loading state and Thai TCG stylized fallback
function CardImageThumbnail({
  src,
  alt,
  className = '',
  card
}: {
  src: string;
  alt: string;
  className?: string;
  card?: Card;
}) {
  const [error, setError] = useState(false);

  const colorStyles: Record<string, string> = {
    'แดง': 'border-red-600/60 bg-gradient-to-b from-red-950/80 to-slate-950 text-red-300',
    'ฟ้า': 'border-blue-600/60 bg-gradient-to-b from-blue-950/80 to-slate-950 text-blue-300',
    'เขียว': 'border-emerald-600/60 bg-gradient-to-b from-emerald-950/80 to-slate-950 text-emerald-300',
    'ม่วง': 'border-purple-600/60 bg-gradient-to-b from-purple-950/80 to-slate-950 text-purple-300',
    'ไร้สี': 'border-slate-600/60 bg-gradient-to-b from-slate-900 to-slate-950 text-slate-300'
  };

  const badgeColor = card?.color ? colorStyles[card.color] || colorStyles['ไร้สี'] : colorStyles['ไร้สี'];

  if (error || !src) {
    return (
      <div className={`flex flex-col items-center justify-between p-2 border rounded-lg text-center ${badgeColor} ${className}`}>
        <span className="text-[9px] font-bold opacity-75">{card?.type || 'การ์ด'}</span>
        <span className="text-[11px] font-semibold leading-tight line-clamp-2 px-1">{card?.name || alt}</span>
        <div className="flex items-center justify-between w-full text-[9px] opacity-70 px-1">
          <span>{card?.cost !== undefined ? `ใช้ ${card.cost}` : ''}</span>
          <span>{card?.power ? `PWR ${card.power}` : ''}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`relative w-full h-full overflow-hidden bg-slate-950 ${className}`}>
      <img
        src={src}
        alt={alt}
        referrerPolicy="no-referrer"
        crossOrigin="anonymous"
        loading="lazy"
        onError={() => setError(true)}
        className="w-full h-full object-cover transition-transform duration-200"
      />
    </div>
  );
}

export const DeckBuilder: React.FC<DeckBuilderProps> = ({
  onBack,
  onSaveDeck,
  initialMainDeck,
  initialLifeDeck,
  currentDeckName = 'เด็คหลักของฉัน'
}) => {
  // If user passes empty deck, preload default valid starter deck so they see cards immediately
  const defaultMain = (initialMainDeck && initialMainDeck.length > 0)
    ? initialMainDeck
    : (starterDeckData.mainDeck as Card[]);

  const defaultLife = (initialLifeDeck && initialLifeDeck.length > 0)
    ? initialLifeDeck
    : (starterDeckData.lifeDeck as Card[]);

  const [deckName, setDeckName] = useState<string>(currentDeckName);
  const [mainDeck, setMainDeck] = useState<Card[]>(defaultMain);
  const [lifeDeck, setLifeDeck] = useState<Card[]>(defaultLife);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedType, setSelectedType] = useState<string>('ALL');
  const [selectedColor, setSelectedColor] = useState<string>('ALL');
  const [activeTab, setActiveTab] = useState<'MAIN' | 'LIFE'>('MAIN');

  // Mobile drawer/view toggle: 'POOL' or 'DECK'
  const [mobileView, setMobileView] = useState<'POOL' | 'DECK'>('POOL');

  // Deck view display mode: 'GRID' or 'LIST'
  const [deckDisplayMode, setDeckDisplayMode] = useState<'GRID' | 'LIST'>('LIST');

  // Preview card modal
  const [previewCard, setPreviewCard] = useState<Card | null>(null);

  // Added notification toast for mobile UX
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 1800);
  };

  const allCards = allCardsData as Card[];

  // Filtered Cards Pool
  const filteredCards = useMemo(() => {
    return allCards.filter(c => {
      const matchSearch = c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        c.printId.toLowerCase().includes(searchTerm.toLowerCase()) ||
        c.mainEffect.toLowerCase().includes(searchTerm.toLowerCase());
      const matchType = selectedType === 'ALL' || c.type === selectedType;
      const matchColor = selectedColor === 'ALL' || c.color === selectedColor;
      return matchSearch && matchType && matchColor;
    });
  }, [allCards, searchTerm, selectedType, selectedColor]);

  // Pagination for high-performance rendering of 2,014 cards
  const [displayLimit, setDisplayLimit] = useState<number>(48);

  useEffect(() => {
    setDisplayLimit(48);
  }, [searchTerm, selectedType, selectedColor]);

  const visibleCards = useMemo(() => {
    return filteredCards.slice(0, displayLimit);
  }, [filteredCards, displayLimit]);

  // Grouped Main Deck for clear, beautiful display
  const groupedMainDeck = useMemo(() => {
    const map = new Map<string, { card: Card; count: number }>();
    for (const c of mainDeck) {
      const existing = map.get(c.printId);
      if (existing) {
        existing.count++;
      } else {
        map.set(c.printId, { card: c, count: 1 });
      }
    }
    return Array.from(map.values()).sort((a, b) => (b.card.cost ?? 0) - (a.card.cost ?? 0));
  }, [mainDeck]);

  // Validation
  const validation: DeckValidationResult = useMemo(() => {
    return validateDeck(mainDeck, lifeDeck);
  }, [mainDeck, lifeDeck]);

  // Add Card to Main Deck
  const handleAddToMain = (card: Card) => {
    if (mainDeck.length >= 50) {
      showToast('⚠️ Main Deck ครบ 50 ใบแล้ว!');
      return;
    }
    const sameNameCount = mainDeck.filter(c => c.name === card.name).length;
    if (sameNameCount >= 4) {
      showToast(`⚠️ การ์ด "${card.name}" ใส่ได้สูงสุด 4 ใบ!`);
      return;
    }
    if (card.isOnlyOne && mainDeck.some(c => c.isOnlyOne)) {
      showToast('⚠️ ใส่การ์ด Only #1 ได้เพียง 1 ใบเท่านั้น!');
      return;
    }
    if (card.isBias) {
      showToast('⚠️ การ์ดลำเอียงไม่อนุญาตในเด็ค!');
      return;
    }

    setMainDeck(prev => [...prev, card]);
    showToast(`+ เพิ่ม "${card.name}" เข้าเด็ค (${sameNameCount + 1}/4)`);
  };

  // Remove One Copy from Main Deck
  const handleRemoveOneFromMain = (card: Card) => {
    const idx = mainDeck.findIndex(c => c.printId === card.printId);
    if (idx !== -1) {
      const newDeck = [...mainDeck];
      newDeck.splice(idx, 1);
      setMainDeck(newDeck);
    }
  };

  // Remove All Copies of a Card from Main Deck
  const handleRemoveAllCopiesFromMain = (card: Card) => {
    setMainDeck(prev => prev.filter(c => c.printId !== card.printId));
  };

  // Add Card to Life Deck
  const handleAddToLife = (card: Card) => {
    if (lifeDeck.length >= 5) {
      showToast('⚠️ LIFE Deck ครบ 5 ใบแล้ว!');
      return;
    }
    if (lifeDeck.some(c => c.name === card.name)) {
      showToast(`⚠️ LIFE Deck ห้ามมีชื่อซ้ำ (${card.name})`);
      return;
    }
    setLifeDeck(prev => [...prev, card]);
    showToast(`+ เพิ่ม "${card.name}" เข้า LIFE Deck (${lifeDeck.length + 1}/5)`);
  };

  const handleRemoveFromLife = (index: number) => {
    setLifeDeck(prev => prev.filter((_, i) => i !== index));
  };

  const handleAutoFill = () => {
    const pool = allCards.filter(c => !c.isBias && c.type !== 'Token');
    const newMain = [...mainDeck];
    const newLife = [...lifeDeck];

    // 1. Ensure exactly 1 Only #1 card
    if (!newMain.some(c => c.isOnlyOne)) {
      const onlyOneCard = pool.find(c => c.isOnlyOne);
      if (onlyOneCard) newMain.push(onlyOneCard);
    }

    // 2. Fill Main Deck up to 50
    for (const card of pool) {
      if (newMain.length >= 50) break;
      if (card.isOnlyOne) continue;
      const count = newMain.filter(c => c.name === card.name).length;
      if (count < 4) {
        newMain.push(card);
      }
    }

    // 3. Fill Life Deck up to 5 with unique names
    for (const card of pool) {
      if (newLife.length >= 5) break;
      if (!newLife.some(c => c.name === card.name)) {
        newLife.push(card);
      }
    }

    setMainDeck(newMain.slice(0, 50));
    setLifeDeck(newLife.slice(0, 5));
    showToast('✨ เติมเด็คอัตโนมัติสำเร็จ 50 + 5 ใบ!');
  };

  const handleClear = () => {
    setMainDeck([]);
    setLifeDeck([]);
    showToast('🗑️ ล้างเด็คเรียบร้อยแล้ว');
  };

  return (
    <div className="flex flex-col h-[100dvh] w-screen bg-slate-950 text-slate-100 font-kanit overflow-hidden select-none">
      {/* Toast Notification */}
      {toastMsg && (
        <div className="fixed top-14 left-1/2 -translate-x-1/2 z-50 bg-amber-500 text-slate-950 font-bold px-4 py-1.5 rounded-full shadow-2xl text-xs flex items-center gap-1.5 animate-bounce">
          <Sparkles className="w-3.5 h-3.5" />
          <span>{toastMsg}</span>
        </div>
      )}

      {/* Top Header Bar */}
      <header className="shrink-0 bg-slate-900 border-b border-slate-800 px-3 md:px-6 py-2 flex flex-wrap items-center justify-between gap-2 z-20">
        <div className="flex items-center space-x-2 md:space-x-3">
          <button
            onClick={onBack}
            className="p-1.5 md:p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition flex items-center gap-1 text-xs font-semibold"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">หน้าแรก</span>
          </button>
          <div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={deckName}
                onChange={(e) => setDeckName(e.target.value)}
                className="bg-transparent border-b border-slate-700 hover:border-amber-500 focus:border-amber-400 font-bold text-sm md:text-base text-amber-400 focus:outline-none max-w-[130px] sm:max-w-[180px]"
                placeholder="ชื่อเด็ค..."
              />
            </div>
            <p className="text-[10px] text-slate-400 hidden sm:block">กฎทางการ Ver 3.2 (50 Main + 5 LIFE)</p>
          </div>
        </div>

        {/* Action Controls & Mobile Toggle */}
        <div className="flex items-center space-x-1.5 md:space-x-2">
          {/* Mobile Tab Toggle */}
          <div className="flex md:hidden bg-slate-950 rounded-lg p-0.5 border border-slate-800">
            <button
              onClick={() => setMobileView('POOL')}
              className={`px-2.5 py-1 rounded text-xs font-semibold transition ${
                mobileView === 'POOL' ? 'bg-amber-500 text-slate-950 shadow' : 'text-slate-400'
              }`}
            >
              คลังการ์ด
            </button>
            <button
              onClick={() => setMobileView('DECK')}
              className={`px-2.5 py-1 rounded text-xs font-semibold flex items-center gap-1 transition ${
                mobileView === 'DECK' ? 'bg-amber-500 text-slate-950 shadow' : 'text-slate-400'
              }`}
            >
              <span>เด็ค</span>
              <span className={`text-[10px] px-1 rounded-full ${mainDeck.length === 50 ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-amber-300'}`}>
                {mainDeck.length}/50
              </span>
            </button>
          </div>

          <button
            onClick={handleAutoFill}
            className="px-2 md:px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium transition flex items-center gap-1"
            title="เติมเด็คให้ครบ 50 ใบตามกฎโดยอัตโนมัติ"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span className="hidden sm:inline">Auto-Fill</span>
          </button>
          <button
            onClick={handleClear}
            className="px-2 md:px-2.5 py-1.5 rounded-lg bg-slate-800/80 hover:bg-red-950/60 text-slate-400 hover:text-red-300 border border-slate-700 text-xs transition hidden sm:flex items-center gap-1"
            title="ล้างเด็คทั้งหมดเพื่อจัดใหม่ตั้งแต่ต้น"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>ล้าง</span>
          </button>
          <button
            disabled={!validation.isValid}
            onClick={() => onSaveDeck(mainDeck, lifeDeck, deckName)}
            className={`px-3 md:px-4 py-1.5 rounded-lg font-bold text-xs flex items-center gap-1.5 shadow transition ${
              validation.isValid
                ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-amber-950/50 cursor-pointer'
                : 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed'
            }`}
          >
            <Save className="w-3.5 h-3.5" />
            <span>บันทึกเด็ค</span>
          </button>
        </div>
      </header>

      {/* Main Workspace Layout */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Left Column: Card Pool (Always visible on desktop, toggled on mobile) */}
        <section
          className={`w-full md:w-1/2 flex flex-col border-r border-slate-800 bg-slate-900/40 ${
            mobileView === 'POOL' ? 'flex' : 'hidden md:flex'
          }`}
        >
          {/* Search & Filter Bar */}
          <div className="p-2 md:p-3 border-b border-slate-800 space-y-2 bg-slate-950/70 shrink-0">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                placeholder="ค้นหาชื่อการ์ด, รหัสพิมพ์, ความสามารถ..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-3 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-amber-500"
              />
            </div>

            {/* Filter Pills */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs no-scrollbar">
              <span className="text-slate-500 shrink-0 text-[10px]">ประเภท:</span>
              {['ALL', 'Avatar', 'Magic', 'Construct', 'Life'].map(t => (
                <button
                  key={t}
                  onClick={() => setSelectedType(t)}
                  className={`px-2 py-0.5 rounded shrink-0 transition text-[10px] md:text-xs ${
                    selectedType === t
                      ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 font-semibold'
                      : 'bg-slate-900 text-slate-400 border border-slate-800 hover:bg-slate-800'
                  }`}
                >
                  {t === 'ALL' ? 'ทั้งหมด' : t}
                </button>
              ))}

              <span className="text-slate-500 shrink-0 ml-1 text-[10px]">สี:</span>
              {['ALL', 'แดง', 'ฟ้า', 'เขียว', 'ม่วง', 'ไร้สี'].map(c => (
                <button
                  key={c}
                  onClick={() => setSelectedColor(c)}
                  className={`px-1.5 py-0.5 rounded shrink-0 transition text-[10px] md:text-xs ${
                    selectedColor === c
                      ? 'bg-amber-500 text-slate-950 font-bold'
                      : 'bg-slate-900 text-slate-400 border border-slate-800 hover:bg-slate-800'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          {/* Scrollable Card Pool Wrapper */}
          <div className="flex-1 overflow-y-auto p-2 md:p-3">
            {/* Cards Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2 md:gap-3">
              {visibleCards.map((card, cardIndex) => {
                const inMainCount = mainDeck.filter(c => c.name === card.name).length;
                const inLife = lifeDeck.some(c => c.name === card.name);

                return (
                  <div
                    key={`${card.printId}-${cardIndex}`}
                    className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-md flex flex-col justify-between group hover:border-slate-700 transition"
                  >
                    {/* Card Art Container with Click to Preview */}
                    <div
                      onClick={() => setPreviewCard(card)}
                      className="relative w-full h-48 sm:h-56 bg-slate-950 overflow-hidden cursor-pointer group/art shrink-0"
                      title="คลิกเพื่อดูรายละเอียดการ์ดขนาดใหญ่"
                    >
                    <CardImageThumbnail
                      src={card.imageUrl}
                      alt={card.name}
                      card={card}
                      className="w-full h-full group-hover/art:scale-105 transition duration-200"
                    />

                    {/* Quick Badges */}
                    <div className="absolute top-1 left-1 flex flex-col gap-0.5">
                      <span className="text-[9px] font-mono font-bold px-1 py-0.5 rounded bg-slate-950/90 text-amber-400 border border-slate-800">
                        {card.printId}
                      </span>
                    </div>

                    {card.isOnlyOne && (
                      <span className="absolute top-1 right-1 text-[9px] font-black px-1.5 py-0.5 rounded bg-red-600 text-white shadow">
                        Only #1
                      </span>
                    )}

                    {/* Eye icon overlay on hover */}
                    <div className="absolute inset-0 bg-slate-950/30 opacity-0 group-hover/art:opacity-100 flex items-center justify-center transition">
                      <Eye className="w-6 h-6 text-white drop-shadow" />
                    </div>
                  </div>

                  {/* Card Details & Add Actions */}
                  <div className="p-2 space-y-1.5 bg-slate-900 border-t border-slate-800/80 shrink-0">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-slate-100 truncate text-[11px] sm:text-xs">{card.name}</span>
                      <span className="text-slate-400 text-[10px] shrink-0 font-medium">{card.type}</span>
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-slate-400">
                      <span>ใช้ {card.cost ?? 0} | เจม {card.gem ?? 0}</span>
                      {card.power ? <span className="text-red-400 font-bold">PWR {card.power}</span> : null}
                    </div>

                    {/* Add Buttons */}
                    <div className="pt-1 flex gap-1">
                      <button
                        onClick={() => handleAddToMain(card)}
                        disabled={inMainCount >= 4 || mainDeck.length >= 50 || (card.isOnlyOne && mainDeck.some(c => c.isOnlyOne))}
                        className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold transition flex items-center justify-center gap-0.5 ${
                          inMainCount > 0
                            ? 'bg-amber-500 text-slate-950 shadow'
                            : 'bg-amber-600/30 hover:bg-amber-600/50 text-amber-300 border border-amber-500/40'
                        } disabled:opacity-25 disabled:cursor-not-allowed`}
                      >
                        + Main ({inMainCount}/4)
                      </button>
                      <button
                        onClick={() => handleAddToLife(card)}
                        disabled={inLife || lifeDeck.length >= 5}
                        className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold transition flex items-center justify-center gap-0.5 ${
                          inLife
                            ? 'bg-emerald-500 text-slate-950 shadow'
                            : 'bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 border border-emerald-500/40'
                        } disabled:opacity-25 disabled:cursor-not-allowed`}
                      >
                        + LIFE ({inLife ? '✓' : '0'}/1)
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Load More Button */}
            {displayLimit < filteredCards.length && (
              <div className="col-span-full py-4 flex flex-col items-center justify-center">
                <button
                  onClick={() => setDisplayLimit(prev => prev + 48)}
                  className="px-6 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-amber-400 font-bold text-xs border border-slate-700 shadow-lg flex items-center gap-2 transition"
                >
                  <Plus className="w-4 h-4" />
                  <span>แสดงเพิ่มอีก 48 ใบ (กำลังแสดง {visibleCards.length} จาก {filteredCards.length} ใบ)</span>
                </button>
              </div>
            )}
            </div>
          </div>

          {/* Mobile Bottom Floating Bar to jump to Deck */}
          <div className="p-2 bg-slate-900 border-t border-slate-800 flex md:hidden items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-400 text-[11px]">การ์ดในเด็ค:</span>
              <span className={`font-bold ${mainDeck.length === 50 ? 'text-emerald-400' : 'text-amber-400'}`}>
                {mainDeck.length} / 50 ใบ
              </span>
              <span className="text-slate-500 text-[10px]">• LIFE {lifeDeck.length}/5</span>
            </div>
            <button
              onClick={() => setMobileView('DECK')}
              className="px-3 py-1.5 rounded-lg bg-amber-500 text-slate-950 font-bold text-xs flex items-center gap-1 shadow"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>ดูเด็คของเรา</span>
            </button>
          </div>
        </section>

        {/* Right Column: Deck List & Validation (Toggled on mobile) */}
        <section
          className={`w-full md:w-1/2 flex flex-col bg-slate-950 ${
            mobileView === 'DECK' ? 'flex' : 'hidden md:flex'
          }`}
        >
          {/* Deck Tabs & Display Switcher */}
          <div className="h-11 md:h-12 border-b border-slate-800 px-3 md:px-4 flex items-center justify-between bg-slate-900/60 shrink-0">
            <div className="flex space-x-1.5 md:space-x-2">
              <button
                onClick={() => setActiveTab('MAIN')}
                className={`px-2.5 sm:px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
                  activeTab === 'MAIN'
                    ? 'bg-amber-500 text-slate-950 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <span>Main Deck</span>
                <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${activeTab === 'MAIN' ? 'bg-slate-950/30' : 'bg-slate-800 text-amber-400'}`}>
                  {mainDeck.length}/50
                </span>
              </button>
              <button
                onClick={() => setActiveTab('LIFE')}
                className={`px-2.5 sm:px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
                  activeTab === 'LIFE'
                    ? 'bg-emerald-500 text-slate-950 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <span>LIFE Deck</span>
                <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${activeTab === 'LIFE' ? 'bg-slate-950/30' : 'bg-slate-800 text-emerald-400'}`}>
                  {lifeDeck.length}/5
                </span>
              </button>
            </div>

            {/* Display toggle (Grid / List) */}
            <div className="flex items-center gap-2">
              <div className="flex bg-slate-900 rounded p-0.5 border border-slate-800">
                <button
                  onClick={() => setDeckDisplayMode('LIST')}
                  className={`p-1 rounded ${deckDisplayMode === 'LIST' ? 'bg-slate-800 text-amber-400' : 'text-slate-500'}`}
                  title="มุมมองรายการพร้อมภาพขนาดย่อ"
                >
                  <List className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setDeckDisplayMode('GRID')}
                  className={`p-1 rounded ${deckDisplayMode === 'GRID' ? 'bg-slate-800 text-amber-400' : 'text-slate-500'}`}
                  title="มุมมองตารางการ์ดพร้อมภาพใหญ่"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Validation Status */}
              <div className="text-[11px] md:text-xs">
                {validation.isValid ? (
                  <span className="text-emerald-400 font-semibold flex items-center gap-1">
                    <CheckCircle className="w-3.5 h-3.5 md:w-4 md:h-4" /> สมบูรณ์
                  </span>
                ) : (
                  <span className="text-amber-400 font-semibold flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5 md:w-4 md:h-4" /> ขาด {validation.errors.length} ข้อ
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Validation Errors Box */}
          {!validation.isValid && (
            <div className="bg-amber-950/40 border-b border-amber-900/50 p-2 px-3 md:px-4 text-[11px] text-amber-300 space-y-0.5 shrink-0 max-h-24 overflow-y-auto">
              {validation.errors.map((err, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                  <span>{err}</span>
                </div>
              ))}
            </div>
          )}

          {/* Active Deck Cards List */}
          <div className="flex-1 p-2 md:p-3 overflow-y-auto content-start">
            {activeTab === 'MAIN' ? (
              mainDeck.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-500 text-xs text-center p-6 space-y-3">
                  <div className="w-12 h-12 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-600">
                    <Layers className="w-6 h-6" />
                  </div>
                  <div>
                    <p className="font-bold text-slate-300 text-sm">Main Deck ยังไม่มีการ์ด</p>
                    <p className="mt-1 text-slate-500">เลือกเพิ่มการ์ดจากคลังทางซ้าย หรือกดปุ่ม Auto-Fill ด้านบนเพื่อเติมเด็คทันที</p>
                  </div>
                  <button
                    onClick={handleAutoFill}
                    className="px-4 py-2 rounded-xl bg-amber-500 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow"
                  >
                    <Sparkles className="w-4 h-4" />
                    <span>Auto-Fill เด็คสมบูรณ์ 50 ใบ</span>
                  </button>
                </div>
              ) : deckDisplayMode === 'LIST' ? (
                /* Compact List with Visual Thumbnail */
                <div className="space-y-1.5">
                  {groupedMainDeck.map(({ card, count }) => (
                    <div
                      key={card.printId}
                      className="p-1.5 rounded-xl bg-slate-900/90 border border-slate-800 hover:border-slate-700 flex items-center justify-between text-xs transition gap-2"
                    >
                      {/* Card Thumbnail & Info */}
                      <div
                        onClick={() => setPreviewCard(card)}
                        className="flex items-center space-x-2.5 truncate cursor-pointer flex-1"
                        title="คลิกเพื่อดูการ์ดขยาย"
                      >
                        <div className="w-10 h-14 shrink-0 rounded overflow-hidden border border-slate-800 bg-slate-950">
                          <CardImageThumbnail
                            src={card.imageUrl}
                            alt={card.name}
                            card={card}
                            className="w-full h-full"
                          />
                        </div>
                        <div className="truncate">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-slate-100 truncate text-xs">{card.name}</span>
                            {card.isOnlyOne && (
                              <span className="px-1 py-0.2 rounded bg-red-600 text-white text-[8px] font-bold shrink-0">
                                Only #1
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-[10px] text-slate-400 mt-0.5">
                            <span className="font-mono text-amber-400">{card.printId}</span>
                            <span>•</span>
                            <span>{card.type}</span>
                            <span>•</span>
                            <span>ใช้ {card.cost ?? 0}</span>
                            {card.power ? <span className="text-red-400 font-semibold">• PWR {card.power}</span> : null}
                          </div>
                        </div>
                      </div>

                      {/* Quantity Controls & Remove */}
                      <div className="flex items-center space-x-1 shrink-0">
                        <button
                          onClick={() => handleRemoveOneFromMain(card)}
                          className="w-7 h-7 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition"
                          title="ลด 1 ใบ"
                        >
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                        <span className="w-7 text-center font-bold text-amber-400 text-xs">
                          {count}x
                        </span>
                        <button
                          onClick={() => handleAddToMain(card)}
                          disabled={count >= 4 || mainDeck.length >= 50 || (card.isOnlyOne && count >= 1)}
                          className="w-7 h-7 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-25 disabled:cursor-not-allowed flex items-center justify-center transition"
                          title="เพิ่ม 1 ใบ"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleRemoveAllCopiesFromMain(card)}
                          className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 transition ml-1"
                          title="นำการ์ดนี้ทั้งหมดออกจากเด็ค"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                /* Card Grid View with Art Preview */
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {groupedMainDeck.map(({ card, count }) => (
                    <div
                      key={card.printId}
                      className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow flex flex-col justify-between"
                    >
                      <div
                        onClick={() => setPreviewCard(card)}
                        className="relative w-full aspect-[3/4] min-h-[170px] bg-slate-950 cursor-pointer"
                      >
                        <CardImageThumbnail
                          src={card.imageUrl}
                          alt={card.name}
                          card={card}
                          className="w-full h-full"
                        />
                        <div className="absolute top-1 right-1 bg-amber-500 text-slate-950 font-black text-xs px-2 py-0.5 rounded-full shadow-lg">
                          {count}x
                        </div>
                      </div>
                      <div className="p-1.5 space-y-1">
                        <div className="font-semibold text-slate-200 text-xs truncate">{card.name}</div>
                        <div className="flex items-center justify-between gap-1 pt-1">
                          <button
                            onClick={() => handleRemoveOneFromMain(card)}
                            className="flex-1 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs flex items-center justify-center"
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => handleAddToMain(card)}
                            disabled={count >= 4 || mainDeck.length >= 50 || (card.isOnlyOne && count >= 1)}
                            className="flex-1 py-1 rounded bg-amber-500 text-slate-950 font-bold text-xs flex items-center justify-center disabled:opacity-25"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )
            ) : (
              /* LIFE Deck Tab */
              lifeDeck.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-500 text-xs text-center p-6 space-y-3">
                  <div className="w-12 h-12 rounded-2xl bg-emerald-950/40 border border-emerald-800/40 flex items-center justify-center text-emerald-400">
                    <Shield className="w-6 h-6" />
                  </div>
                  <div>
                    <p className="font-bold text-slate-300 text-sm">LIFE Deck ยังไม่มีการ์ด</p>
                    <p className="mt-1 text-slate-500">เลือกการ์ด 5 ใบที่มีชื่อไม่ซ้ำกันเพื่อเป็นพลังชีวิตของคุณ</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-2 max-w-md mx-auto">
                  <p className="text-[11px] text-slate-400 mb-2">การ์ด LIFE 5 ใบ (ห้ามชื่อซ้ำกัน):</p>
                  {lifeDeck.map((card, idx) => (
                    <div
                      key={`${card.printId}-${idx}`}
                      className="p-2 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between text-xs hover:border-slate-700 transition"
                    >
                      <div
                        onClick={() => setPreviewCard(card)}
                        className="flex items-center space-x-3 truncate cursor-pointer flex-1"
                        title="คลิกเพื่อดูการ์ด"
                      >
                        <span className="w-6 h-6 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800 flex items-center justify-center font-bold text-xs shrink-0">
                          #{idx + 1}
                        </span>
                        <div className="w-10 h-14 shrink-0 rounded overflow-hidden border border-slate-800 bg-slate-950">
                          <CardImageThumbnail
                            src={card.imageUrl}
                            alt={card.name}
                            card={card}
                            className="w-full h-full"
                          />
                        </div>
                        <div className="truncate">
                          <span className="font-bold text-slate-100 block text-xs truncate">{card.name}</span>
                          <span className="text-[10px] text-slate-400">{card.type} • {card.printId} • ใช้ {card.cost ?? 0}</span>
                        </div>
                      </div>
                      <button
                        onClick={() => handleRemoveFromLife(idx)}
                        className="p-2 rounded-lg text-slate-500 hover:text-red-400 transition"
                        title="นำออกจาก LIFE Deck"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>

          {/* Mobile Back to Pool Button */}
          <div className="p-2 bg-slate-900 border-t border-slate-800 flex md:hidden items-center justify-between text-xs">
            <button
              onClick={() => setMobileView('POOL')}
              className="w-full py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs flex items-center justify-center gap-1.5"
            >
              <Plus className="w-4 h-4 text-amber-400" />
              <span>เลือกการ์ดเพิ่มจากคลัง</span>
            </button>
          </div>
        </section>
      </div>

      {/* Card Preview Modal */}
      {previewCard && (
        <div
          onClick={() => setPreviewCard(null)}
          className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full overflow-hidden shadow-2xl flex flex-col"
          >
            <div className="relative aspect-[3/4] bg-slate-950 w-full overflow-hidden">
              <CardImageThumbnail
                src={previewCard.imageUrl}
                alt={previewCard.name}
                card={previewCard}
                className="w-full h-full"
              />
              <button
                onClick={() => setPreviewCard(null)}
                className="absolute top-2 right-2 p-1.5 rounded-full bg-slate-950/80 text-slate-300 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-base text-amber-400">{previewCard.name}</h3>
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                  {previewCard.printId}
                </span>
              </div>

              <div className="flex items-center gap-3 text-xs text-slate-300">
                <span>ประเภท: <b className="text-white">{previewCard.type}</b></span>
                <span>สี: <b className="text-white">{previewCard.color || 'ไร้สี'}</b></span>
                <span>ใช้: <b className="text-amber-400">{previewCard.cost ?? 0}</b></span>
                {previewCard.power ? <span>PWR: <b className="text-red-400">{previewCard.power}</b></span> : null}
              </div>

              {previewCard.mainEffect && (
                <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-300 leading-relaxed">
                  <p className="font-semibold text-slate-400 text-[10px] mb-1">ความสามารถ:</p>
                  {previewCard.mainEffect}
                </div>
              )}

              <div className="pt-2 flex gap-2">
                <button
                  onClick={() => {
                    handleAddToMain(previewCard);
                    setPreviewCard(null);
                  }}
                  className="flex-1 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs"
                >
                  + ใส่ Main Deck
                </button>
                <button
                  onClick={() => {
                    handleAddToLife(previewCard);
                    setPreviewCard(null);
                  }}
                  className="flex-1 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs"
                >
                  + ใส่ LIFE Deck
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
