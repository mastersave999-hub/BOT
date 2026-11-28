import React, { useEffect, useState } from 'react';
import { Check, X, Wrench, ShieldCheck, ShieldX, Loader2, Plus, ListX } from 'lucide-react';
import type {
  Card,
  GameState,
  ManualDeckSearchCriteria,
  ManualOverrideAction,
  ManualOverrideContext,
  PendingDeckChoice,
  PendingHellChoice,
  PendingManualOverride,
} from '../../engine/types';
import { describeManualOverrideAction } from '../../engine/hybridMode';
import { parseCardText } from '../../engine/cardTextAdapter';
import { ClassificationBadge, OrnamentDivider } from './botTheme';

function findInstances(state: GameState, ownerPlayerId: string, zone: 'deck' | 'hell', ids: string[]): Card[] {
  const player = state.players[ownerPlayerId];
  if (!player) return [];
  const byId = new Map(player[zone].map(card => [card.instanceId, card.card]));
  return ids.map(id => byId.get(id)).filter((card): card is Card => !!card);
}

interface DeckChoiceModalProps {
  pending: PendingDeckChoice;
  state: GameState;
  submitted: boolean;
  onConfirm: (selectedInstanceIds: string[]) => void;
}

/** Scout / Deck search resolution for the authorized viewer only. */
export const DeckChoiceModal: React.FC<DeckChoiceModalProps> = ({ pending, state, submitted, onConfirm }) => {
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => setSelected([]), [pending.expectedRevision]);
  const candidates = findInstances(state, pending.deckOwnerId, 'deck', pending.candidateInstanceIds);
  const label = pending.kind === 'SCOUT' ? 'สอดแนม (Scout)' : 'ค้นหาการ์ดใน Deck';
  const destinationLabel = pending.destination === 'hand' ? 'เลือกไปไว้บนมือ'
    : pending.destination === 'hell' ? 'เลือกเพื่อส่งลงนรก'
      : pending.selectedDeckPosition === 'top' ? 'เลือกวางกลับด้านบนสุดของ Deck'
        : pending.selectedDeckPosition === 'bottom' ? 'เลือกวางกลับด้านล่างสุดของ Deck' : 'เลือกวางกลับใน Deck';
  const canConfirm = !submitted && selected.length >= pending.minSelect && selected.length <= pending.maxSelect;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="deck-choice-title" className="rounded-2xl border border-amber-500/60 bg-slate-900 max-w-lg w-full p-4 space-y-3 max-h-[85vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between border-b border-amber-500/20 pb-2">
          <h3 id="deck-choice-title" className="font-bold text-sm text-amber-400">{label} — เลือก {pending.minSelect === pending.maxSelect ? pending.minSelect : `${pending.minSelect}-${pending.maxSelect}`} ใบ</h3>
        </div>
        <p className="text-[11px] text-slate-400">{destinationLabel} (ด้านบนสุดของ Deck ก่อน)</p>
        <div className="grid grid-cols-1 gap-1.5">
          {candidates.map((card, index) => {
            const instanceId = pending.candidateInstanceIds[index];
            const isSelected = selected.includes(instanceId);
            const canToggle = isSelected || (!submitted && selected.length < pending.maxSelect);
            return (
              <button
                key={instanceId}
                type="button"
                disabled={!canToggle}
                aria-pressed={isSelected}
                onClick={() => setSelected(prev => isSelected ? prev.filter(id => id !== instanceId) : [...prev, instanceId])}
                className={`text-left px-3 py-2 rounded-lg border text-[11px] transition ${isSelected ? 'border-amber-400 bg-amber-950/50 text-amber-100' : 'border-slate-700 bg-slate-950 text-slate-200 hover:border-amber-500/60'} disabled:opacity-50`}
              >
                <span className="flex items-center gap-1.5">
                  <ClassificationBadge card={card} size="sm" />
                  <span className="font-bold truncate">{card.name}</span>
                </span>
                <span className="text-[9px] text-slate-400">{card.type}{card.subtype ? ` · ${card.subtype}` : ''} · Cost {card.cost} · {card.printId}</span>
              </button>
            );
          })}
          {candidates.length === 0 && <p className="text-xs text-slate-500 text-center py-4">ไม่มีการ์ดที่เลือกได้</p>}
        </div>
        <button
          type="button"
          disabled={!canConfirm}
          onClick={() => onConfirm(selected)}
          className="w-full py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-bold text-xs flex items-center justify-center gap-2"
        >
          {submitted ? <><Loader2 className="w-4 h-4 animate-spin" /> กำลังรอเจ้าของห้องยืนยัน…</> : <><Check className="w-4 h-4" /> ยืนยันการเลือก</>}
        </button>
      </div>
    </div>
  );
};

interface HellChoiceModalProps {
  pending: PendingHellChoice;
  state: GameState;
  submitted: boolean;
  onConfirm: (selectedInstanceIds: string[]) => void;
}

/** Hell recovery / summon-from-Hell resolution for the authorized viewer only. */
export const HellChoiceModal: React.FC<HellChoiceModalProps> = ({ pending, state, submitted, onConfirm }) => {
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => setSelected([]), [pending.expectedRevision]);
  const candidates = findInstances(state, pending.playerId, 'hell', pending.candidateInstanceIds);
  const destinationLabel = pending.destination === 'avatarZone' ? 'อัญเชิญลง Avatar Zone'
    : pending.destination === 'hand' ? 'หยิบกลับขึ้นมือ'
      : pending.destination === 'banish' ? 'เนรเทศออกนอกเกม (มิติมืด)'
        : pending.destination === 'deck_top' ? 'วางกลับด้านบนสุดของ Deck'
          : 'วางกลับด้านล่างสุดของ Deck';
  const canConfirm = !submitted && selected.length >= pending.minSelect && selected.length <= pending.maxSelect;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="hell-choice-title" className="rounded-2xl border border-red-500/60 bg-slate-900 max-w-lg w-full p-4 space-y-3 max-h-[85vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between border-b border-red-500/20 pb-2">
          <h3 id="hell-choice-title" className="font-bold text-sm text-red-400">
            เลือกจากนรก ({pending.effectKind === 'summon_from_hell' ? 'อัญเชิญจากนรก' : 'นำกลับจากนรก'}) — {pending.minSelect} ใบ
          </h3>
        </div>
        <p className="text-[11px] text-slate-400">{destinationLabel}</p>
        <div className="grid grid-cols-1 gap-1.5">
          {candidates.map((card, index) => {
            const instanceId = pending.candidateInstanceIds[index];
            const isSelected = selected.includes(instanceId);
            const canToggle = isSelected || (!submitted && selected.length < pending.maxSelect);
            return (
              <button
                key={instanceId}
                type="button"
                disabled={!canToggle}
                aria-pressed={isSelected}
                onClick={() => setSelected(prev => isSelected ? prev.filter(id => id !== instanceId) : [...prev, instanceId])}
                className={`text-left px-3 py-2 rounded-lg border text-[11px] transition ${isSelected ? 'border-red-400 bg-red-950/50 text-red-100' : 'border-slate-700 bg-slate-950 text-slate-200 hover:border-red-500/60'} disabled:opacity-50`}
              >
                <span className="flex items-center gap-1.5">
                  <ClassificationBadge card={card} size="sm" />
                  <span className="font-bold truncate">{card.name}</span>
                </span>
                <span className="text-[9px] text-slate-400">{card.type} · POWER {card.power} · {card.printId}</span>
              </button>
            );
          })}
          {candidates.length === 0 && <p className="text-xs text-slate-500 text-center py-4">ไม่มีการ์ดที่เลือกได้ในนรก</p>}
        </div>
        <button
          type="button"
          disabled={!canConfirm}
          onClick={() => onConfirm(selected)}
          className="w-full py-2.5 rounded-xl bg-red-500 hover:bg-red-400 disabled:opacity-40 text-white font-bold text-xs flex items-center justify-center gap-2"
        >
          {submitted ? <><Loader2 className="w-4 h-4 animate-spin" /> กำลังรอเจ้าของห้องยืนยัน…</> : <><Check className="w-4 h-4" /> ยืนยันการเลือก</>}
        </button>
      </div>
    </div>
  );
};

interface ManualOverrideControlsProps {
  state: GameState;
  actorId: string;
  manualCard: { instanceId: string; card: Card; status: 'UNSUPPORTED' | 'AMBIGUOUS' | 'VERIFIED_WORKING' } | null;
  /** Accepts a single action or a Phase 8 multi-step queue resolved with one confirmation. */
  onSubmit: (action: ManualOverrideAction | ManualOverrideAction[], context?: ManualOverrideContext) => void;
  onClose: () => void;
}

const MOVE_DESTINATIONS: Array<{ destination: 'deck' | 'hand' | 'avatarZone' | 'constructZone' | 'magicZone' | 'hell' | 'darkDimension'; deckPosition?: 'top' | 'bottom'; label: string }> = [
  { destination: 'hand', label: 'บนมือ' },
  { destination: 'avatarZone', label: 'Avatar Zone' },
  { destination: 'magicZone', label: 'Magic Zone' },
  { destination: 'constructZone', label: 'Construct Zone' },
  { destination: 'hell', label: 'นรก (Hell)' },
  { destination: 'darkDimension', label: 'มิติมืด (Banish)' },
  { destination: 'deck', deckPosition: 'top', label: 'Deck (บนสุด)' },
  { destination: 'deck', deckPosition: 'bottom', label: 'Deck (ล่างสุด)' }
];

const MANUAL_TABS: Array<{ id: 'deck' | 'field' | 'hand' | 'life' | 'ability'; label: string }> = [
  { id: 'deck', label: 'ค้นหา / กองการ์ด' },
  { id: 'field', label: 'สนาม / พลัง' },
  { id: 'hand', label: 'มือ / นรก' },
  { id: 'life', label: 'LIFE' },
  { id: 'ability', label: 'สั่งใช้ความสามารถ' }
];

const MAX_MANUAL_STEPS = 8;

const inputClass = 'w-full min-w-0 px-2 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-[11px] text-slate-200';
const addStepClass = 'flex items-center justify-center gap-1 w-full py-2 rounded-lg bg-amber-600/80 hover:bg-amber-500 border border-amber-400/60 text-slate-950 text-[11px] font-bold disabled:opacity-40 disabled:hover:bg-amber-600/80';
const groupClass = 'rounded-lg border border-slate-800 bg-slate-950 p-2 space-y-1.5';
const groupTitleClass = 'text-[10px] font-bold text-amber-200/90';

/** Structured, rule-bounded manual controls for UNSUPPORTED / AMBIGUOUS card resolution.
 *  Phase 8: tabbed step-by-step resolver — every action queues a step and the whole
 *  card effect is submitted once for a single opponent Confirm/Reject. */
export const ManualOverrideControls: React.FC<ManualOverrideControlsProps> = ({ state, actorId, manualCard, onSubmit, onClose }) => {
  const me = state.players[actorId];
  const opponentId = state.playerOrder.find(id => id !== actorId);
  const fieldCards = state.playerOrder.flatMap(playerId =>
    (['avatarZone', 'constructZone', 'magicZone'] as const).flatMap(zone =>
      (state.players[playerId]?.[zone] ?? []).map(instance => ({
        playerId, zone, instanceId: instance.instanceId, card: instance.card,
        isRested: instance.isRested, controllerId: instance.controllerId
      }))
    )
  );
  const [activeTab, setActiveTab] = useState<'deck' | 'field' | 'hand' | 'life' | 'ability'>('deck');
  const [steps, setSteps] = useState<ManualOverrideAction[]>([]);
  const [targetId, setTargetId] = useState<string>(manualCard?.instanceId ?? fieldCards[0]?.instanceId ?? '');
  const [lifeTarget, setLifeTarget] = useState<string>(actorId);
  const [discardId, setDiscardId] = useState<string>('');

  // Deck tab inputs
  const [searchName, setSearchName] = useState('');
  const [searchType, setSearchType] = useState('');
  const [searchColor, setSearchColor] = useState('');
  const [searchMinCost, setSearchMinCost] = useState('');
  const [searchMaxCost, setSearchMaxCost] = useState('');
  const [searchSymbol, setSearchSymbol] = useState('');
  const [searchCount, setSearchCount] = useState('1');
  const [searchDestination, setSearchDestination] = useState<'hand' | 'hell' | 'deck'>('hand');
  const [scoutCount, setScoutCount] = useState('2');
  const [scoutDestination, setScoutDestination] = useState<'hand' | 'hell' | 'deck'>('deck');
  const [scoutPosition, setScoutPosition] = useState<'top' | 'bottom'>('top');
  const [millCount, setMillCount] = useState('1');
  const [drawCount, setDrawCount] = useState('1');
  const [hellCardType, setHellCardType] = useState<'Avatar' | 'Construct' | 'Magic'>('Avatar');
  const [hellCount, setHellCount] = useState('1');
  const [hellDestination, setHellDestination] = useState<'hand' | 'deck_top' | 'deck_bottom' | 'avatarZone' | 'banish'>('hand');
  const [tokenName, setTokenName] = useState('');
  const [tokenPower, setTokenPower] = useState('0');
  const [controlTargetId, setControlTargetId] = useState<string>(opponentId ?? actorId);
  const [symbolValue, setSymbolValue] = useState('');
  const [symbolDuration, setSymbolDuration] = useState<'END_OF_TURN' | 'PERMANENT'>('END_OF_TURN');
  const [abilityIndex, setAbilityIndex] = useState(0);
  const [abilityCostId, setAbilityCostId] = useState('');
  const [abilityTargetId, setAbilityTargetId] = useState('');

  // Phase 8.1: the pinned card's parsed activated abilities, executed through the
  // engine pipeline (activateRegisteredCardTextAbility) so costs, targets and the
  // once-per-turn limit are validated by the engine, not by the UI.
  const manualParsed = manualCard ? parseCardText(manualCard.card) : null;
  const activatedAbilities = (manualParsed?.clauses ?? [])
    .map((clause, index) => ({ clause, index }))
    .filter(entry => entry.clause.timing.mode === 'ACTIVATED');
  const activeAbility = activatedAbilities[abilityIndex] ?? activatedAbilities[0];

  const target = fieldCards.find(entry => entry.instanceId === targetId);
  const queueFull = steps.length >= MAX_MANUAL_STEPS;

  const matchesAbilitySelector = (entry: (typeof fieldCards)[number], selector: ReturnType<typeof parseCardText>['clauses'][number]['selector']): boolean => {
    if (!selector) return true;
    if (selector.controller === 'opponent' && entry.controllerId === actorId) return false;
    if (selector.controller === 'self' && entry.controllerId !== actorId) return false;
    if (selector.cardTypes.length > 0 && !selector.cardTypes.includes(entry.card.type)) return false;
    if (selector.cost) {
      if (selector.cost.comparison === 'at_most' && entry.card.cost > selector.cost.value) return false;
      if (selector.cost.comparison === 'at_least' && entry.card.cost < selector.cost.value) return false;
    }
    if (selector.rested !== undefined && entry.isRested !== selector.rested) return false;
    return true;
  };
  const abilityTargets = activeAbility ? fieldCards.filter(entry => matchesAbilitySelector(entry, activeAbility.clause.selector)) : [];
  const abilityUsageKey = manualCard && activeAbility
    ? `${state.turnNumber}:${state.landMagicZone?.instanceId === manualCard.instanceId ? state.landMagicZone.controllerId : actorId}:${manualCard.instanceId}:card-text:${activeAbility.index}`
    : '';
  const abilityUsedThisTurn = !!abilityUsageKey && (state.triggerUsage ?? []).includes(abilityUsageKey);
  const abilityNeedsTarget = !!activeAbility && activeAbility.clause.effects.some(effect =>
    ['change_control', 'modify_power', 'set_power', 'change_symbol', 'destroy_avatar', 'bounce_avatar', 'banish_avatar', 'sacrifice_avatar', 'summon_from_hell'].includes(effect.kind));

  const addStep = (action: ManualOverrideAction) => {
    if (queueFull) return;
    setSteps(prev => [...prev, action]);
  };
  const removeStep = (index: number) => setSteps(prev => prev.filter((_, i) => i !== index));

  const submitSearch = () => {
    const criteria: ManualDeckSearchCriteria = {};
    if (searchName.trim()) criteria.nameIncludes = searchName.trim();
    if (searchType) criteria.types = [searchType as Card['type']];
    if (searchColor) criteria.colors = [searchColor];
    if (searchMinCost !== '') criteria.minCost = Number(searchMinCost);
    if (searchMaxCost !== '') criteria.maxCost = Number(searchMaxCost);
    if (searchSymbol.trim()) criteria.symbols = [searchSymbol.trim()];
    addStep({
      kind: 'MANUAL_SEARCH_DECK',
      deckOwnerId: actorId,
      criteria,
      selectCount: Math.max(1, Number(searchCount) || 1),
      destination: searchDestination
    });
  };

  const tabPanel: React.ReactNode = activeTab === 'deck' ? (
    <div className="space-y-2">
      <div className={groupClass}>
        <p className={groupTitleClass}>ค้นหาใน Deck (Search) — สับ Deck อัตโนมัติหลังค้นหา</p>
        <div className="grid grid-cols-2 gap-1.5">
          <input aria-label="ค้นหาจากชื่อการ์ด" placeholder="ชื่อมีคำว่า…" value={searchName} onChange={event => setSearchName(event.target.value)} className={inputClass} />
          <input aria-label="ค้นหาจาก Symbol" placeholder="Symbol…" value={searchSymbol} onChange={event => setSearchSymbol(event.target.value)} className={inputClass} />
          <select aria-label="กรองประเภทการ์ด" value={searchType} onChange={event => setSearchType(event.target.value)} className={inputClass}>
            <option value="">ทุกประเภท</option>
            <option value="Avatar">Avatar</option>
            <option value="Magic">Magic</option>
            <option value="Construct">Construct</option>
            <option value="Life">Life</option>
          </select>
          <select aria-label="กรองสีการ์ด" value={searchColor} onChange={event => setSearchColor(event.target.value)} className={inputClass}>
            <option value="">ทุกสี</option>
            <option value="แดง">แดง</option>
            <option value="ฟ้า">ฟ้า</option>
            <option value="เขียว">เขียว</option>
            <option value="ม่วง">ม่วง</option>
            <option value="ไร้สี">ไร้สี</option>
          </select>
          <input aria-label="Cost ต่ำสุด" type="number" min={0} placeholder="Cost ต่ำสุด" value={searchMinCost} onChange={event => setSearchMinCost(event.target.value)} className={inputClass} />
          <input aria-label="Cost สูงสุด" type="number" min={0} placeholder="Cost สูงสุด" value={searchMaxCost} onChange={event => setSearchMaxCost(event.target.value)} className={inputClass} />
          <select aria-label="จำนวนการ์ดที่ค้นหา" value={searchCount} onChange={event => setSearchCount(event.target.value)} className={inputClass}>
            {[1, 2, 3, 4, 5].map(count => <option key={count} value={count}>เลือก {count} ใบ</option>)}
          </select>
          <select aria-label="ปลายทางของการ์ดที่ค้นหา" value={searchDestination} onChange={event => setSearchDestination(event.target.value as 'hand' | 'hell' | 'deck')} className={inputClass}>
            <option value="hand">ขึ้นมือ</option>
            <option value="hell">ลงนรก</option>
            <option value="deck">กลับสู่ Deck</option>
          </select>
        </div>
        <button type="button" disabled={queueFull} onClick={submitSearch} className={addStepClass}><Plus className="w-3.5 h-3.5" /> เพิ่มขั้นตอนค้นหา Deck</button>
      </div>
      <div className={groupClass}>
        <p className={groupTitleClass}>สอดแนม (Scout) — ดูการ์ด N ใบด้านบนสุด</p>
        <div className="grid grid-cols-2 gap-1.5">
          <select aria-label="จำนวนการ์ดที่สอดแนม" value={scoutCount} onChange={event => setScoutCount(event.target.value)} className={inputClass}>
            {[1, 2, 3, 4, 5].map(count => <option key={count} value={count}>ดู {count} ใบ</option>)}
          </select>
          <select aria-label="ปลายทางของการ์ดที่สอดแนม" value={scoutDestination} onChange={event => setScoutDestination(event.target.value as 'hand' | 'hell' | 'deck')} className={inputClass}>
            <option value="deck">วางกลับ Deck</option>
            <option value="hand">ขึ้นมือ</option>
            <option value="hell">ลงนรก</option>
          </select>
          {scoutDestination === 'deck' && (
            <select aria-label="ตำแหน่งวางกลับ" value={scoutPosition} onChange={event => setScoutPosition(event.target.value as 'top' | 'bottom')} className={inputClass}>
              <option value="top">บนสุด</option>
              <option value="bottom">ล่างสุด</option>
            </select>
          )}
        </div>
        <button
          type="button"
          disabled={queueFull}
          onClick={() => addStep({
            kind: 'MANUAL_SCOUT_DECK', deckOwnerId: actorId, count: Math.max(1, Number(scoutCount) || 1),
            destination: scoutDestination,
            ...(scoutDestination === 'deck' ? { selectedDeckPosition: scoutPosition } : {})
          })}
          className={addStepClass}
        ><Plus className="w-3.5 h-3.5" /> เพิ่มขั้นตอนสอดแนม</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className={groupClass}>
          <p className={groupTitleClass}>Mill — ส่ง N ใบบนสุดลงนรก</p>
          <select aria-label="จำนวนการ์ดที่ Mill" value={millCount} onChange={event => setMillCount(event.target.value)} className={inputClass}>
            {[1, 2, 3, 4, 5].map(count => <option key={count} value={count}>{count} ใบ</option>)}
          </select>
          <button type="button" disabled={queueFull} onClick={() => addStep({ kind: 'MANUAL_MILL_DECK', deckOwnerId: actorId, count: Math.max(1, Number(millCount) || 1) })} className={addStepClass}><Plus className="w-3.5 h-3.5" /> เพิ่มขั้นตอน Mill</button>
        </div>
        <div className={groupClass}>
          <p className={groupTitleClass}>สับ Deck ใหม่</p>
          <p className="text-[9px] text-slate-500">บันทึกสาธารณะใน Match Action Log</p>
          <button type="button" disabled={queueFull} onClick={() => addStep({ kind: 'MANUAL_SHUFFLE_DECK', deckOwnerId: actorId })} className={addStepClass}><Plus className="w-3.5 h-3.5" /> เพิ่มขั้นตอนสับ Deck</button>
        </div>
      </div>
    </div>
  ) : activeTab === 'field' ? (
    <div className="space-y-2">
      <div className="space-y-1">
        <label htmlFor="manual-target" className="text-[11px] font-semibold text-slate-400">การ์ดเป้าหมายบนสนาม</label>
        <select
          id="manual-target"
          value={targetId}
          onChange={event => setTargetId(event.target.value)}
          className={inputClass}
        >
          {fieldCards.map(entry => (
            <option key={entry.instanceId} value={entry.instanceId}>
              {entry.card.name} ({entry.card.type} · {state.players[entry.playerId]?.name ?? entry.playerId})
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className={groupClass}>
          <p className={groupTitleClass}>ปรับ POWER</p>
          <div className="flex gap-1.5">
            <button type="button" disabled={!targetId || queueFull} onClick={() => addStep({ kind: 'ADJUST_POWER', instanceId: targetId, delta: -1 })} className="flex-1 py-1.5 rounded bg-red-900/70 border border-red-500/50 text-red-100 text-[11px] font-bold disabled:opacity-40">−1</button>
            <button type="button" disabled={!targetId || queueFull} onClick={() => addStep({ kind: 'ADJUST_POWER', instanceId: targetId, delta: 1 })} className="flex-1 py-1.5 rounded bg-emerald-900/70 border border-emerald-500/50 text-emerald-100 text-[11px] font-bold disabled:opacity-40">+1</button>
          </div>
        </div>
        <div className={groupClass}>
          <p className={groupTitleClass}>สภาพ Wake / Rest</p>
          <div className="flex gap-1.5">
            <button type="button" disabled={!target || queueFull} onClick={() => addStep({ kind: 'SET_WAKE_STATE', instanceId: targetId, isRested: false })} className="flex-1 py-1.5 rounded bg-slate-800 border border-slate-600 text-slate-100 text-[11px] font-bold disabled:opacity-40">ตื่น</button>
            <button type="button" disabled={!target || queueFull} onClick={() => addStep({ kind: 'SET_WAKE_STATE', instanceId: targetId, isRested: true })} className="flex-1 py-1.5 rounded bg-slate-800 border border-slate-600 text-slate-100 text-[11px] font-bold disabled:opacity-40">นอน</button>
          </div>
        </div>
      </div>
      <div className={groupClass}>
        <p className={groupTitleClass}>ย้ายการ์ดระหว่างโซน</p>
        <div className="flex flex-wrap gap-1.5">
          {MOVE_DESTINATIONS.map(move => (
            <button
              key={`${move.destination}-${move.deckPosition ?? ''}`}
              type="button"
              disabled={!target || queueFull}
              onClick={() => addStep({
                kind: 'MOVE_CARD', instanceId: targetId, destination: move.destination,
                ...(move.deckPosition ? { deckPosition: move.deckPosition } : {})
              })}
              className="px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-slate-100 text-[10px] font-semibold hover:bg-slate-700 disabled:opacity-40"
            >
              {move.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className={groupClass}>
          <p className={groupTitleClass}>สร้าง Token (รวมสูงสุด 6 ใบ)</p>
          <input aria-label="ชื่อ Token" placeholder="ชื่อ Token (ถ้ามี)" value={tokenName} onChange={event => setTokenName(event.target.value)} className={inputClass} />
          <input aria-label="POWER ของ Token" type="number" placeholder="POWER" value={tokenPower} onChange={event => setTokenPower(event.target.value)} className={inputClass} />
          <button
            type="button"
            disabled={queueFull || (me?.avatarZone.length ?? 0) >= 6}
            onClick={() => addStep({
              kind: 'MANUAL_SPAWN_TOKEN', playerId: actorId,
              ...(tokenName.trim() ? { name: tokenName.trim() } : {}),
              ...(tokenPower !== '' ? { power: Number(tokenPower) } : {})
            })}
            className={addStepClass}
          ><Plus className="w-3.5 h-3.5" /> เพิ่มขั้นตอนสร้าง Token</button>
        </div>
        <div className={groupClass}>
          <p className={groupTitleClass}>เปลี่ยนผู้ควบคุม Avatar</p>
          <select aria-label="ผู้ควบคุมใหม่" value={controlTargetId} onChange={event => setControlTargetId(event.target.value)} className={inputClass}>
            {/* Every player is a valid new controller — the engine only rejects
                same-controller and zone-capacity cases, so the actor must be able
                to take an Avatar back too (e.g. returning a borrowed Avatar). */}
            {state.playerOrder.map(id => (
              <option key={id} value={id}>{state.players[id]?.name ?? id}{id === actorId ? ' (คุณ)' : ''}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={!target || !controlTargetId || queueFull}
            onClick={() => addStep({ kind: 'MANUAL_CHANGE_CONTROL', instanceId: targetId, newControllerId: controlTargetId })}
            className={addStepClass}
          ><Plus className="w-3.5 h-3.5" /> เพิ่มขั้นตอนเปลี่ยนผู้ควบคุม</button>
          <button
            type="button"
            disabled={!target || !controlTargetId || queueFull}
            onClick={() => addStep({ kind: 'MANUAL_CHANGE_CONTROL_TEMPORARY', instanceId: targetId, newControllerId: controlTargetId })}
            className={addStepClass}
          ><Plus className="w-3.5 h-3.5" /> เปลี่ยนผู้ควบคุมชั่วคราว (คืนสิทธิ์อัตโนมัติจนจบเทิร์น)</button>
        </div>
      </div>
      <div className={groupClass}>
        <p className={groupTitleClass}>เปลี่ยน Symbol ของ Avatar (layer modifier — Symbol ตัวพิมพ์เดิมไม่ถูกแก้)</p>
        <div className="grid grid-cols-2 gap-1.5">
          <input aria-label="Symbol ใหม่" placeholder="Symbol เช่น เทพ" value={symbolValue} onChange={event => setSymbolValue(event.target.value)} className={inputClass} />
          <select aria-label="ระยะเวลาของ Symbol ใหม่" value={symbolDuration} onChange={event => setSymbolDuration(event.target.value as 'END_OF_TURN' | 'PERMANENT')} className={inputClass}>
            <option value="END_OF_TURN">จนจบเทิร์น</option>
            <option value="PERMANENT">ต่อเนื่อง (จนการ์ดออกจากสนาม)</option>
          </select>
        </div>
        <button
          type="button"
          disabled={!target || !symbolValue.trim() || queueFull}
          onClick={() => { addStep({ kind: 'MANUAL_SET_SYMBOL', instanceId: targetId, symbol: symbolValue.trim(), duration: symbolDuration }); setSymbolValue(''); }}
          className={addStepClass}
        ><Plus className="w-3.5 h-3.5" /> เพิ่มขั้นตอนเปลี่ยน Symbol</button>
      </div>
    </div>
  ) : activeTab === 'hand' ? (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div className={groupClass}>
          <p className={groupTitleClass}>จั่วการ์ด</p>
          <select aria-label="จำนวนการ์ดที่จั่ว" value={drawCount} onChange={event => setDrawCount(event.target.value)} className={inputClass}>
            {[1, 2, 3].map(count => <option key={count} value={count}>จั่ว {count} ใบ</option>)}
          </select>
          <button
            type="button"
            disabled={queueFull}
            onClick={() => {
              const count = Math.max(1, Number(drawCount) || 1);
              setSteps(prev => [...prev, ...Array.from({ length: Math.min(count, MAX_MANUAL_STEPS - prev.length) }, () => ({ kind: 'DRAW_CARD' as const, playerId: actorId }))]);
            }}
            className={addStepClass}
          ><Plus className="w-3.5 h-3.5" /> เพิ่มขั้นตอนจั่ว</button>
        </div>
        <div className={groupClass}>
          <p className={groupTitleClass}>ทิ้งการ์ดจากมือ</p>
          <select
            aria-label="เลือกการ์ดบนมือเพื่อทิ้ง"
            value={discardId}
            onChange={event => setDiscardId(event.target.value)}
            className={inputClass}
          >
            <option value="">เลือกการ์ดบนมือ…</option>
            {(me?.hand ?? []).map(card => <option key={card.instanceId} value={card.instanceId}>{card.card.name}</option>)}
          </select>
          <button type="button" disabled={!discardId || queueFull} onClick={() => { addStep({ kind: 'DISCARD_CARD', instanceId: discardId }); setDiscardId(''); }} className={addStepClass}><Plus className="w-3.5 h-3.5" /> เพิ่มขั้นตอนทิ้ง</button>
        </div>
      </div>
      <div className={groupClass}>
        <p className={groupTitleClass}>หยิบจากนรก / มิติมืด (Hell Choice)</p>
        <div className="grid grid-cols-3 gap-1.5">
          <select aria-label="ประเภทการ์ดจากนรก" value={hellCardType} onChange={event => setHellCardType(event.target.value as 'Avatar' | 'Construct' | 'Magic')} className={inputClass}>
            <option value="Avatar">Avatar</option>
            <option value="Construct">Construct</option>
            <option value="Magic">Magic</option>
          </select>
          <select aria-label="จำนวนการ์ดจากนรก" value={hellCount} onChange={event => setHellCount(event.target.value)} className={inputClass}>
            {[1, 2, 3].map(count => <option key={count} value={count}>{count} ใบ</option>)}
          </select>
          <select aria-label="ปลายทางจากนรก" value={hellDestination} onChange={event => setHellDestination(event.target.value as 'hand' | 'deck_top' | 'deck_bottom' | 'avatarZone' | 'banish')} className={inputClass}>
            <option value="hand">ขึ้นมือ</option>
            <option value="avatarZone">Avatar Zone</option>
            <option value="deck_top">Deck บนสุด</option>
            <option value="deck_bottom">Deck ล่างสุด</option>
            <option value="banish">มิติมืด</option>
          </select>
        </div>
        <button
          type="button"
          disabled={queueFull}
          onClick={() => addStep({
            kind: 'MANUAL_HELL_CHOICE', playerId: actorId, cardType: hellCardType,
            count: Math.max(1, Number(hellCount) || 1), destination: hellDestination
          })}
          className={addStepClass}
        ><Plus className="w-3.5 h-3.5" /> เพิ่มขั้นตอนเลือกจากนรก</button>
      </div>
    </div>
  ) : activeTab === 'ability' ? (
    <div className="space-y-2">
      {activatedAbilities.length === 0 || !manualCard ? (
        <div className={groupClass}>
          <p className={groupTitleClass}>ไม่มีความสามารถสั่งใช้ที่เอนจินแยกวิเคราะห์ได้</p>
          <p className="text-[10px] text-slate-500">การ์ดที่กำลังแก้ผลไม่มีข้อความ &quot;สั่งใช้&quot; ที่แปลงเป็นขั้นตอนเอนจินได้ — ใช้แท็บอื่นเพื่อแก้ผลด้วยมือแทน</p>
        </div>
      ) : (
        <div className={groupClass}>
          <p className={groupTitleClass}>ความสามารถสั่งใช้ — เอนจินตรวจ Cost เป้าหมาย และเทิร์นละครั้ง</p>
          {activatedAbilities.length > 1 && (
            <select
              aria-label="เลือกความสามารถสั่งใช้"
              value={abilityIndex}
              onChange={event => { setAbilityIndex(Number(event.target.value)); setAbilityCostId(''); setAbilityTargetId(''); }}
              className={inputClass}
            >
              {activatedAbilities.map((entry, index) => (
                <option key={entry.index} value={index}>#{entry.index + 1}: {entry.clause.effectText.slice(0, 48)}</option>
              ))}
            </select>
          )}
          <p className="text-[10px] text-slate-200 whitespace-pre-line">{activeAbility?.clause.source}</p>
          <p className="flex flex-wrap items-center gap-1 text-[9px] text-slate-400">
            <span className="rounded border border-emerald-400/60 bg-emerald-950/60 px-1 py-0.5 font-bold text-emerald-200">เอนจินรองรับ</span>
            {activeAbility?.clause.timing.frequency === 'ONCE_PER_TURN' && (
              <span className="rounded border border-amber-400/60 bg-amber-950/60 px-1 py-0.5 font-bold text-amber-200">เทิร์นละครั้ง{abilityUsedThisTurn ? ' — ใช้ไปแล้วเทิร์นนี้' : ''}</span>
            )}
          </p>
          {activeAbility?.clause.cost && (
            <div className="space-y-1">
              <p className="text-[10px] font-bold text-amber-200">Cost: ทิ้งการ์ด {activeAbility.clause.cost.count} ใบจากมือ</p>
              <select aria-label="เลือกการ์ดจ่าย Cost" value={abilityCostId} onChange={event => setAbilityCostId(event.target.value)} className={inputClass}>
                <option value="">เลือกการ์ดบนมือ…</option>
                {(me?.hand ?? []).map(card => (
                  <option key={card.instanceId} value={card.instanceId}>{card.card.name} ({card.card.type})</option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-amber-200">เป้าหมายตามเงื่อนไขบนการ์ด (เอนจินตรวจซ้ำอีกชั้น)</p>
            <select aria-label="เลือกเป้าหมายความสามารถ" value={abilityTargetId} onChange={event => setAbilityTargetId(event.target.value)} className={inputClass}>
              <option value="">เลือกเป้าหมาย…</option>
              {abilityTargets.map(entry => (
                <option key={entry.instanceId} value={entry.instanceId}>
                  {entry.card.name} (Cost {entry.card.cost}{entry.isRested ? ' · นอน' : ' · ตื่น'} · {state.players[entry.playerId]?.name ?? entry.playerId})
                </option>
              ))}
            </select>
            {activeAbility && abilityTargets.length === 0 && (
              <p className="text-[10px] text-red-300">ไม่มีเป้าหมายที่ถูกต้องบนสนาม — จึงสั่งใช้ไม่ได้</p>
            )}
          </div>
          <button
            type="button"
            disabled={queueFull || !activeAbility || abilityUsedThisTurn ||
              (!!activeAbility.clause.cost && !abilityCostId) || (abilityNeedsTarget && !abilityTargetId)}
            onClick={() => {
              if (!manualCard || !activeAbility) return;
              addStep({
                kind: 'MANUAL_ACTIVATE_ABILITY',
                sourceInstanceId: manualCard.instanceId,
                abilityIndex: activeAbility.index,
                costInstanceIds: abilityCostId ? [abilityCostId] : [],
                targetInstanceIds: abilityTargetId ? [abilityTargetId] : []
              });
              setAbilityCostId('');
              setAbilityTargetId('');
            }}
            className={addStepClass}
          ><Plus className="w-3.5 h-3.5" /> เพิ่มขั้นตอนสั่งใช้ความสามารถ</button>
        </div>
      )}
    </div>
  ) : (
    <div className={groupClass}>
      <p className={groupTitleClass}>LIFE — เซ็น (หงาย) / ฮีล (คว่ำ)</p>
      <div className="flex gap-1.5">
        <button type="button" aria-pressed={lifeTarget === actorId} onClick={() => setLifeTarget(actorId)} className={`flex-1 py-1.5 rounded text-[11px] font-bold border ${lifeTarget === actorId ? 'bg-emerald-900/70 border-emerald-500/60 text-emerald-100' : 'bg-slate-900 border-slate-700 text-slate-400'}`}>ฝ่ายเรา</button>
        <button type="button" aria-pressed={lifeTarget === opponentId} disabled={!opponentId} onClick={() => opponentId && setLifeTarget(opponentId)} className={`flex-1 py-1.5 rounded text-[11px] font-bold border disabled:opacity-40 ${lifeTarget === opponentId ? 'bg-red-900/70 border-red-500/60 text-red-100' : 'bg-slate-900 border-slate-700 text-slate-400'}`}>คู่แข่ง</button>
      </div>
      <div className="flex gap-1.5">
        <button type="button" disabled={queueFull} onClick={() => addStep({ kind: 'ADJUST_LIFE', playerId: lifeTarget, face: 'up' })} className="flex-1 py-1.5 rounded bg-red-900/70 border border-red-500/50 text-red-100 text-[11px] font-bold disabled:opacity-40">เซ็น LIFE (หงาย)</button>
        <button type="button" disabled={queueFull} onClick={() => addStep({ kind: 'ADJUST_LIFE', playerId: lifeTarget, face: 'down' })} className="flex-1 py-1.5 rounded bg-emerald-900/70 border border-emerald-500/50 text-emerald-100 text-[11px] font-bold disabled:opacity-40">ฮีล LIFE (คว่ำ)</button>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="manual-controls-title" className="rounded-2xl border border-amber-500/60 bg-slate-900 max-w-lg w-full p-4 space-y-3 max-h-[92vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between border-b border-amber-500/20 pb-2">
          <h3 id="manual-controls-title" className="font-bold text-sm text-amber-300 flex items-center gap-1.5">
            <Wrench className="w-4 h-4" /> Manual Effect Resolution — ช่องทางจัดการด้วยมือ
          </h3>
          <button type="button" aria-label="ปิดช่องทางจัดการด้วยมือ" onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
        </div>

        {/* Pinned card effect header: the exact Thai text both players must verify. */}
        {manualCard && (
          <div className="sticky top-0 z-10 -mx-4 px-4 pt-1 pb-2 bg-slate-900/95 rounded-t-2xl border-b border-amber-500/30">
            <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-2 space-y-1">
              <p className="flex items-center gap-1.5 text-[11px] font-bold text-amber-100">
                การ์ด: {manualCard.card.name}
                <span className="rounded border border-amber-400/70 bg-red-950/90 px-1.5 py-0.5 text-[9px] font-black tracking-widest text-amber-300">
                  {manualCard.status === 'AMBIGUOUS' ? 'MANUAL · AMBIGUOUS' : manualCard.status === 'VERIFIED_WORKING' ? 'MANUAL · ESCAPE HATCH' : 'MANUAL · UNSUPPORTED'}
                </span>
              </p>
              <p className="text-[10px] text-slate-200 whitespace-pre-line max-h-24 overflow-y-auto">{manualCard.card.mainEffect}</p>
              <p className="text-[9px] text-slate-500">ทุกขั้นตอนถูกบันทึกใน Match Action Log และต้องได้รับการยืนยันจากคู่แข่งก่อนนำไปใช้ (All-or-Nothing ตามกติกา หน้า 12)</p>
            </div>
          </div>
        )}

        {/* Category tabs */}
        <div role="tablist" aria-label="หมวดการกระทำ Manual Resolver" className="grid grid-cols-5 gap-1">
          {MANUAL_TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`manual-tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              aria-controls={`manual-panel-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`px-1 py-2 rounded-lg text-[10px] font-bold border transition ${activeTab === tab.id ? 'bg-amber-500 text-slate-950 border-amber-400' : 'bg-slate-950 text-slate-300 border-slate-700 hover:border-amber-500/60'}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`manual-panel-${activeTab}`} aria-labelledby={`manual-tab-${activeTab}`} className="space-y-2">
          {tabPanel}
        </div>

        {/* Multi-step queue with a single opponent confirmation */}
        <div className="rounded-lg border border-amber-500/40 bg-amber-950/20 p-2 space-y-1.5">
          <p className="text-[10px] font-bold text-amber-200">คิวขั้นตอน ({steps.length}/{MAX_MANUAL_STEPS}) — ส่งครั้งเดียว เพื่อให้คู่แข่งยืนยันทั้งหมด</p>
          {steps.length === 0 ? (
            <p className="text-[10px] text-slate-500">ยังไม่มีขั้นตอน — เลือกการกระทำจากแท็บด้านบนเพื่อเพิ่มขั้นตอน</p>
          ) : (
            <ol className="space-y-1">
              {steps.map((step, index) => (
                <li key={`${index}-${step.kind}`} className="flex items-start gap-1.5 text-[10px] text-slate-200">
                  <span className="shrink-0 rounded bg-amber-500/20 border border-amber-500/40 px-1 font-bold text-amber-200">{index + 1}</span>
                  <span className="min-w-0 flex-1">{describeManualOverrideAction(state, step)}</span>
                  <button type="button" aria-label={`ลบขั้นตอนที่ ${index + 1}`} onClick={() => removeStep(index)} className="shrink-0 text-slate-500 hover:text-red-300"><ListX className="w-3.5 h-3.5" /></button>
                </li>
              ))}
            </ol>
          )}
          <button
            type="button"
            disabled={steps.length === 0}
            onClick={() => { onSubmit(steps); setSteps([]); }}
            className="w-full py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-bold text-xs flex items-center justify-center gap-2"
          >
            <Check className="w-4 h-4" /> ส่ง {steps.length} ขั้นตอนเพื่อยืนยันจากคู่แข่ง
          </button>
        </div>
      </div>
    </div>
  );
};

interface ManualOverrideBannerProps {
  pending: PendingManualOverride;
  state: GameState;
  meId: string;
  onApprove: () => void;
  onReject: () => void;
}

/** Anti-cheat approval banner: the opponent must Confirm or Reject every staged override. */
export const ManualOverrideBanner: React.FC<ManualOverrideBannerProps> = ({ pending, state, meId, onApprove, onReject }) => {
  const isActor = pending.actorId === meId;
  const context = pending.context;
  return (
    <section aria-label="Manual override approval" aria-live="polite" className="z-30 flex flex-wrap items-center gap-2 border-b border-amber-400/50 bg-red-950/95 px-3 py-2 text-xs text-amber-100">
      <div className="mr-auto min-w-0 space-y-0.5">
        <p className="font-bold">
          Manual Override · {state.players[pending.actorId]?.name ?? pending.actorId}
          {context?.cardName ? ` · ${context.cardName} (${context.cardStatus ?? 'Manual Effect Resolution'})` : ''}
        </p>
        <p className="text-[11px] text-amber-200">{describeManualOverrideAction(state, pending.action)}</p>
        {context?.cardText && <p className="text-[10px] text-amber-300/80 line-clamp-2">{context.cardText}</p>}
      </div>
      {isActor ? (
        <span className="flex items-center gap-1.5 text-[11px] text-amber-300"><Loader2 className="w-3.5 h-3.5 animate-spin" /> รอคู่แข่งยืนยัน…</span>
      ) : (
        <span className="flex items-center gap-2">
          <button type="button" onClick={onApprove} className="rounded bg-emerald-400 px-3 py-1.5 font-bold text-slate-950 flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5" /> ยืนยัน</button>
          <button type="button" onClick={onReject} className="rounded border border-red-400/70 px-3 py-1.5 font-bold text-red-200 flex items-center gap-1"><ShieldX className="w-3.5 h-3.5" /> ปฏิเสธ</button>
        </span>
      )}
    </section>
  );
};
