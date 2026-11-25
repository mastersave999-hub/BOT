'use client'

import { useRef, useState } from 'react'
import { ImagePlus, LoaderCircle, LogOut, Trash2, User, X } from 'lucide-react'
import { removeAvatar, uploadAvatar, type UserAccount } from '../../engine/authService'

interface ProfileMenuProps {
  user: UserAccount
  onUserUpdate: (user: UserAccount) => void
  onLogout: () => void
}

export function ProfileMenu({ user, onUserUpdate, onLogout }: ProfileMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setMessage(null)
    setIsSaving(true)
    try {
      const updatedUser = await uploadAvatar(user, file)
      onUserUpdate(updatedUser)
      setMessage('อัปเดตรูปโปรไฟล์แล้ว')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'อัปโหลดรูปไม่สำเร็จ กรุณาลองอีกครั้ง')
    } finally {
      setIsSaving(false)
    }
  }

  const handleRemove = async () => {
    setMessage(null)
    setIsSaving(true)
    try {
      const updatedUser = await removeAvatar(user)
      onUserUpdate(updatedUser)
      setMessage('ลบรูปโปรไฟล์แล้ว')
    } catch {
      setMessage('ลบรูปไม่สำเร็จ กรุณาลองอีกครั้ง')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1">
        <button
          type="button"
          onClick={() => {
            setMessage(null)
            setIsOpen(true)
          }}
          aria-label={`แก้ไขโปรไฟล์ ${user.username}`}
          className="flex items-center gap-1.5 text-xs font-semibold text-amber-400"
        >
          <Avatar user={user} size="small" />
          {user.username}
        </button>
        <button
          type="button"
          onClick={onLogout}
          aria-label="ออกจากระบบ"
          className="rounded p-1 text-slate-500 transition hover:text-red-400"
        >
          <LogOut className="h-3.5 w-3.5" />
        </button>
      </div>

      {isOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <section role="dialog" aria-modal="true" aria-labelledby="profile-title" className="relative w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-6 text-center shadow-2xl">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              aria-label="ปิดหน้าต่าง"
              className="absolute right-4 top-4 rounded-full bg-slate-800 p-1 text-slate-400 transition hover:bg-slate-700 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
            <h2 id="profile-title" className="text-lg font-bold text-slate-100">รูปโปรไฟล์</h2>
            <p className="mt-1 text-xs text-slate-400">รูปนี้จะเชื่อมกับบัญชีและใช้ได้บนอุปกรณ์อื่น</p>

            <div className="my-5 flex justify-center">
              <Avatar user={user} size="large" />
            </div>
            <p className="mb-4 text-sm font-semibold text-amber-300">{user.username}</p>

            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={isSaving}
                className="flex min-h-10 items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-slate-950 transition hover:bg-amber-400 disabled:opacity-60"
              >
                {isSaving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                {isSaving ? 'กำลังบันทึก…' : 'เลือกรูปภาพ'}
              </button>
              {user.avatarUrl && (
                <button
                  type="button"
                  onClick={() => void handleRemove()}
                  disabled={isSaving}
                  className="flex min-h-10 items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:border-red-800 hover:text-red-300 disabled:opacity-60"
                >
                  <Trash2 className="h-4 w-4" />
                  ลบรูปโปรไฟล์
                </button>
              )}
              <input
                ref={inputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(event) => void handleUpload(event)}
                className="sr-only"
                aria-label="เลือกรูปโปรไฟล์ JPG, PNG หรือ WebP"
              />
            </div>
            <p className="mt-3 text-[11px] text-slate-500">JPG, PNG หรือ WebP • ขนาดไม่เกิน 5 MB</p>
            {message && <p role="status" className="mt-3 text-xs text-amber-300">{message}</p>}
          </section>
        </div>
      )}
    </>
  )
}

function Avatar({ user, size }: { user: UserAccount; size: 'small' | 'large' }) {
  const sizeClass = size === 'small' ? 'h-7 w-7' : 'h-24 w-24'
  return user.avatarUrl ? (
    <img
      src={user.avatarUrl}
      alt={`${user.username} รูปโปรไฟล์`}
      className={`${sizeClass} rounded-full border border-amber-500/50 object-cover`}
    />
  ) : (
    <span className={`${sizeClass} flex items-center justify-center rounded-full border border-slate-700 bg-slate-800 text-amber-400`}>
      <User className={size === 'small' ? 'h-3.5 w-3.5' : 'h-10 w-10'} aria-hidden="true" />
    </span>
  )
}
