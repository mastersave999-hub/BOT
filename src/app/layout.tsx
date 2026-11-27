import type { Metadata, Viewport } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { thTH } from '@clerk/localizations';
import './globals.css';

export const metadata: Metadata = {
  title: 'Battle of Talingchan Online | ศึกตลิ่งชัน ออนไลน์',
  description: 'Official Online Web Client for Thai Trading Card Game - Battle of Talingchan',
  manifest: '/manifest.webmanifest',
  applicationName: 'Battle of Talingchan',
  appleWebApp: {
    capable: true,
    title: 'Battle of Talingchan',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: '/icons/app-icon.png',
    apple: '/icons/app-icon.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#020617',
};

// Clerk is optional: without keys the app runs in guest mode (local decks only)
// instead of crashing. When keys exist, behavior is identical to before.
const CLERK_ENABLED = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="th">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Kanit:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased bg-slate-950 text-slate-100 overflow-x-hidden font-kanit">
        {CLERK_ENABLED ? <ClerkProvider localization={thTH}>{children}</ClerkProvider> : children}
      </body>
    </html>
  );
}
