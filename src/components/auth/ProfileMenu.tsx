'use client'

import { useClerk } from '@clerk/nextjs'
import { LogOut, User } from 'lucide-react'
import type { UserAccount } from '../../engine/authTypes'

interface ProfileMenuProps {
  user: UserAccount
  onLogout: () => void
}

export function ProfileMenu({ user, onLogout }: ProfileMenuProps) {
  const { openUserProfile } = useClerk()

  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1">
      <button
        type="button"
        onClick={() => openUserProfile()}
        aria-label={`แก้ไขโปรไฟล์ ${user.username}`}
        className="flex items-center gap-1.5 text-xs font-semibold text-amber-400"
      >
        <Avatar user={user} />
        {user.username}
      </button>
      <button
        type="button"
        onClick={onLogout}
        aria-label="ออกจากระบบ"
        className="rounded p-1 text-slate-500 transition hover:text-red-400"
      >
        <LogOut aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function Avatar({ user }: { user: UserAccount }) {
  return user.avatarUrl ? (
    <img
      src={user.avatarUrl}
      alt=""
      className="h-7 w-7 rounded-full border border-amber-500/50 object-cover"
    />
  ) : (
    <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-full border border-slate-700 bg-slate-800 text-amber-400">
      <User className="h-3.5 w-3.5" />
    </span>
  )
}
