import React, { useEffect, useState } from 'react';
import { Check, X, Wrench, ShieldCheck, ShieldX, Loader2 } from 'lucide-react';
import type {
  Card,
  GameState,
  ManualOverrideAction,
  ManualOverrideContext,
  PendingDeckChoice,
  PendingHellChoice,
  PendingManualOverride,
} from '../../engine/types';
import { describeManualOverrideAction } from '../../engine/hybridMode';
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
  manualCard: { instanceId: string; card: Card; status: 'UNSUPPORTED' | 'AMBIGUOUS' } | null;
  onSubmit: (action: ManualOverrideAction, context?: ManualOverrideContext) => void;
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

/** Structured, rule-bounded manual controls for UNSUPPORTED / AMBIGUOUS card resolution. */
export const ManualOverrideControls: React.FC<ManualOverrideControlsProps> = ({ state, actorId, manualCard, onSubmit, onClose }) => {
  const me = state.players[actorId];
  const opponentId = state.playerOrder.find(id => id !== actorId);
  const fieldCards = state.playerOrder.flatMap(playerId =>
    (['avatarZone', 'constructZone', 'magicZone'] as const).flatMap(zone =>
      (state.players[playerId]?.[zone] ?? []).map(instance => ({ playerId, zone, instanceId: instance.instanceId, card: instance.card }))
    )
  );
  const [targetId, setTargetId] = useState<string>(manualCard?.instanceId ?? fieldCards[0]?.instanceId ?? '');
  const [lifeTarget, setLifeTarget] = useState<string>(actorId);
  const [discardId, setDiscardId] = useState<string>('');
  const target = fieldCards.find(entry => entry.instanceId === targetId);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="manual-controls-title" className="rounded-2xl border border-amber-500/60 bg-slate-900 max-w-lg w-full p-4 space-y-3 max-h-[88vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between border-b border-amber-500/20 pb-2">
          <h3 id="manual-controls-title" className="font-bold text-sm text-amber-300 flex items-center gap-1.5">
            <Wrench className="w-4 h-4" /> Manual Effect Resolution — ช่องทางจัดการด้วยมือ
          </h3>
          <button type="button" aria-label="ปิดช่องทางจัดการด้วยมือ" onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
        </div>

        {manualCard && (
          <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-2 space-y-1">
            <p className="flex items-center gap-1.5 text-[11px] font-bold text-amber-100">
              การ์ด: {manualCard.card.name}
              <span className="rounded border border-amber-400/70 bg-red-950/90 px-1.5 py-0.5 text-[9px] font-black tracking-widest text-amber-300">
                {manualCard.status === 'AMBIGUOUS' ? 'MANUAL · AMBIGUOUS' : 'MANUAL · UNSUPPORTED'}
              </span>
            </p>
            <p className="text-[10px] text-slate-300 whitespace-pre-line max-h-24 overflow-y-auto">{manualCard.card.mainEffect}</p>
            <p className="text-[9px] text-slate-500">ทุกการกระทำต้องได้รับการยืนยันจากคู่แข่ง และถูกบันทึกใน Match Action Log</p>
          </div>
        )}

        <div className="space-y-1">
          <label htmlFor="manual-target" className="text-[11px] font-semibold text-slate-400">การ์ดเป้าหมายบนสนาม</label>
          <select
            id="manual-target"
            value={targetId}
            onChange={event => setTargetId(event.target.value)}
            className="w-full px-2 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-[11px] text-slate-200"
          >
            {fieldCards.map(entry => (
              <option key={entry.instanceId} value={entry.instanceId}>
                {entry.card.name} ({entry.card.type} · {state.players[entry.playerId]?.name ?? entry.playerId})
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-slate-800 bg-slate-950 p-2 space-y-1.5">
            <p className="text-[10px] font-bold text-slate-300">ปรับ POWER</p>
            <div className="flex gap-1.5">
              <button type="button" disabled={!targetId} onClick={() => onSubmit({ kind: 'ADJUST_POWER', instanceId: targetId, delta: -1 })} className="flex-1 py-1 rounded bg-red-900/70 border border-red-500/50 text-red-100 text-[11px] font-bold disabled:opacity-40">−1</button>
              <button type="button" disabled={!targetId} onClick={() => onSubmit({ kind: 'ADJUST_POWER', instanceId: targetId, delta: 1 })} className="flex-1 py-1 rounded bg-emerald-900/70 border border-emerald-500/50 text-emerald-100 text-[11px] font-bold disabled:opacity-40">+1</button>
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-950 p-2 space-y-1.5">
            <p className="text-[10px] font-bold text-slate-300">สภาพ Wake / Rest</p>
            <div className="flex gap-1.5">
              <button type="button" disabled={!target} onClick={() => onSubmit({ kind: 'SET_WAKE_STATE', instanceId: targetId, isRested: false })} className="flex-1 py-1 rounded bg-slate-800 border border-slate-600 text-slate-100 text-[11px] font-bold disabled:opacity-40">ตื่น</button>
              <button type="button" disabled={!target} onClick={() => onSubmit({ kind: 'SET_WAKE_STATE', instanceId: targetId, isRested: true })} className="flex-1 py-1 rounded bg-slate-800 border border-slate-600 text-slate-100 text-[11px] font-bold disabled:opacity-40">นอน</button>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950 p-2 space-y-1.5">
          <p className="text-[10px] font-bold text-slate-300">ย้ายการ์ดระหว่างโซน</p>
          <div className="flex flex-wrap gap-1.5">
            {MOVE_DESTINATIONS.map(move => (
              <button
                key={`${move.destination}-${move.deckPosition ?? ''}`}
                type="button"
                disabled={!target}
                onClick={() => onSubmit({
                  kind: 'MOVE_CARD', instanceId: targetId, destination: move.destination,
                  ...(move.deckPosition ? { deckPosition: move.deckPosition } : {})
                })}
                className="px-2 py-1 rounded bg-slate-800 border border-slate-600 text-slate-100 text-[10px] font-semibold hover:bg-slate-700 disabled:opacity-40"
              >
                {move.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-slate-800 bg-slate-950 p-2 space-y-1.5">
            <p className="text-[10px] font-bold text-slate-300">จั่ว / ทิ้ง 1 ใบ</p>
            <button type="button" onClick={() => onSubmit({ kind: 'DRAW_CARD', playerId: actorId })} className="w-full py-1 rounded bg-slate-800 border border-slate-600 text-slate-100 text-[11px] font-bold">จั่ว 1 ใบ</button>
            <div className="flex gap-1.5">
              <select
                aria-label="เลือกการ์ดบนมือเพื่อทิ้ง"
                value={discardId}
                onChange={event => setDiscardId(event.target.value)}
                className="flex-1 min-w-0 px-1.5 py-1 bg-slate-950 border border-slate-700 rounded text-[10px] text-slate-200"
              >
                <option value="">เลือกการ์ดบนมือ…</option>
                {(me?.hand ?? []).map(card => <option key={card.instanceId} value={card.instanceId}>{card.card.name}</option>)}
              </select>
              <button type="button" disabled={!discardId} onClick={() => { onSubmit({ kind: 'DISCARD_CARD', instanceId: discardId }); setDiscardId(''); }} className="px-2 py-1 rounded bg-slate-800 border border-slate-600 text-slate-100 text-[10px] font-bold disabled:opacity-40">ทิ้ง</button>
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-950 p-2 space-y-1.5">
            <p className="text-[10px] font-bold text-slate-300">LIFE (เซ็น / ฮีล)</p>
            <div className="flex gap-1.5">
              <button type="button" aria-pressed={lifeTarget === actorId} onClick={() => setLifeTarget(actorId)} className={`flex-1 py-1 rounded text-[10px] font-bold border ${lifeTarget === actorId ? 'bg-emerald-900/70 border-emerald-500/60 text-emerald-100' : 'bg-slate-900 border-slate-700 text-slate-400'}`}>ฝ่ายเรา</button>
              <button type="button" aria-pressed={lifeTarget === opponentId} disabled={!opponentId} onClick={() => opponentId && setLifeTarget(opponentId)} className={`flex-1 py-1 rounded text-[10px] font-bold border disabled:opacity-40 ${lifeTarget === opponentId ? 'bg-red-900/70 border-red-500/60 text-red-100' : 'bg-slate-900 border-slate-700 text-slate-400'}`}>คู่แข่ง</button>
            </div>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => onSubmit({ kind: 'ADJUST_LIFE', playerId: lifeTarget, face: 'up' })} className="flex-1 py-1 rounded bg-red-900/70 border border-red-500/50 text-red-100 text-[10px] font-bold">เซ็น LIFE (หงาย)</button>
              <button type="button" onClick={() => onSubmit({ kind: 'ADJUST_LIFE', playerId: lifeTarget, face: 'down' })} className="flex-1 py-1 rounded bg-emerald-900/70 border border-emerald-500/50 text-emerald-100 text-[10px] font-bold">ฮีล LIFE (คว่ำ)</button>
            </div>
          </div>
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
