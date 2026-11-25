'use client';

import { useEffect, useState } from 'react';
import { Download, Smartphone } from 'lucide-react';

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

export function PwaInstallButton() {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const handleInstalled = () => {
      setIsInstalled(true);
      setInstallPrompt(null);
      setNotice('ติดตั้งแอปเรียบร้อยแล้ว');
    };

    window.addEventListener('beforeinstallprompt', handleInstallPrompt);
    window.addEventListener('appinstalled', handleInstalled);
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', handleInstallPrompt);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, []);

  const installApp = async () => {
    if (!installPrompt) {
      setNotice('เปิดเมนู Chrome ⋮ แล้วเลือก “ติดตั้งแอป” หรือ “สร้างทางลัด”');
      return;
    }

    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    setInstallPrompt(null);
    setNotice(choice.outcome === 'accepted' ? 'กำลังติดตั้งแอป' : 'ยกเลิกการติดตั้งแล้ว');
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void installApp()}
        disabled={isInstalled}
        aria-label={isInstalled ? 'ติดตั้งแอปแล้ว' : 'ติดตั้ง Battle of Talingchan เป็นแอป'}
        className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-600/15 px-2.5 py-1.5 text-xs font-semibold text-emerald-200 transition hover:border-emerald-400/70 hover:bg-emerald-600/25 disabled:cursor-default"
      >
        {isInstalled ? <Smartphone className="h-3.5 w-3.5" aria-hidden="true" /> : <Download className="h-3.5 w-3.5" aria-hidden="true" />}
        {isInstalled ? 'ติดตั้งแล้ว' : 'ติดตั้งแอป'}
      </button>
      <span className="sr-only" aria-live="polite">{notice}</span>
    </div>
  );
}
