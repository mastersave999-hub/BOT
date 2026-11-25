'use client'

import React, { useState } from 'react'
import { loginUser, registerUser, type UserAccount } from '../../engine/authService'
import { X, User, Lock, Mail, ArrowRight, CheckCircle2, AlertCircle } from 'lucide-react'

interface AuthModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: (user: UserAccount) => void
}

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [isRegisterMode, setIsRegisterMode] = useState(false)
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  if (!isOpen) return null

  const handleClose = () => {
    setPassword('')
    setErrorMsg(null)
    setSuccessMsg(null)
    onClose()
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setErrorMsg(null)
    setSuccessMsg(null)
    setIsSubmitting(true)

    try {
      const result = isRegisterMode
        ? await registerUser(email, username, password)
        : await loginUser(email, password)

      if (!result.success) {
        setErrorMsg(result.message)
      } else if (result.user) {
        onSuccess(result.user)
        handleClose()
      } else {
        setSuccessMsg(result.message)
      }
    } catch {
      setErrorMsg('เชื่อมต่อระบบบัญชีไม่สำเร็จ กรุณาลองอีกครั้ง')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 font-kanit">
      <div role="dialog" aria-modal="true" aria-labelledby="auth-title" className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <button
          type="button"
          onClick={handleClose}
          aria-label="ปิดหน้าต่าง"
          className="absolute right-4 top-4 rounded-full bg-slate-800 p-1 text-slate-400 transition hover:bg-slate-700 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-tr from-amber-500 to-red-600 shadow-lg shadow-red-950/50">
            <User className="h-6 w-6 text-slate-950" />
          </div>
          <h2 id="auth-title" className="text-xl font-bold text-slate-100">
            {isRegisterMode ? 'สมัครสมาชิกผู้เล่น' : 'เข้าสู่ระบบ'}
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            {isRegisterMode ? 'สร้างบัญชีเพื่อบันทึกเด็คและโปรไฟล์ของคุณ' : 'เข้าสู่ระบบเพื่อใช้เด็คและโปรไฟล์ได้ทุกอุปกรณ์'}
          </p>
        </div>

        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          {isRegisterMode && (
            <div className="space-y-1">
              <label htmlFor="auth-username" className="text-xs font-semibold text-slate-300">ชื่อผู้ใช้</label>
              <div className="relative">
                <User aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  id="auth-username"
                  type="text"
                  required
                  minLength={3}
                  maxLength={24}
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="ชื่อที่แสดงในเกม"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 py-2 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-amber-500 focus:outline-none"
                />
              </div>
            </div>
          )}

          <div className="space-y-1">
            <label htmlFor="auth-email" className="text-xs font-semibold text-slate-300">อีเมล</label>
            <div className="relative">
              <Mail aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                id="auth-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-xl border border-slate-700 bg-slate-950 py-2 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-amber-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="auth-password" className="text-xs font-semibold text-slate-300">รหัสผ่าน</label>
            <div className="relative">
              <Lock aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                id="auth-password"
                type="password"
                required
                minLength={isRegisterMode ? 8 : 1}
                autoComplete={isRegisterMode ? 'new-password' : 'current-password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={isRegisterMode ? 'อย่างน้อย 8 ตัวอักษร' : 'รหัสผ่าน'}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 py-2 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-amber-500 focus:outline-none"
              />
            </div>
          </div>

          {errorMsg && (
            <div role="alert" className="flex items-center gap-1.5 rounded-lg border border-red-800/80 bg-red-950/60 p-2.5 text-xs text-red-300">
              <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0 text-red-400" />
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div role="status" className="flex items-center gap-1.5 rounded-lg border border-emerald-800/60 bg-emerald-950/60 p-2.5 text-xs text-emerald-300">
              <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0 text-emerald-400" />
              <span>{successMsg}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 py-2.5 text-sm font-bold text-slate-950 shadow-lg shadow-amber-950/50 transition hover:from-amber-400 hover:to-amber-500 disabled:cursor-wait disabled:opacity-60"
          >
            {isSubmitting ? 'กำลังดำเนินการ…' : isRegisterMode ? 'สร้างบัญชี' : 'เข้าสู่ระบบ'}
            {!isSubmitting && <ArrowRight aria-hidden="true" className="h-4 w-4" />}
          </button>
        </form>

        <div className="mt-4 border-t border-slate-800 pt-3 text-center text-xs text-slate-400">
          {isRegisterMode ? 'มีบัญชีอยู่แล้ว?' : 'ยังไม่มีบัญชีผู้เล่น?'}{' '}
          <button
            type="button"
            onClick={() => {
              setIsRegisterMode((value) => !value)
              setPassword('')
              setErrorMsg(null)
              setSuccessMsg(null)
            }}
            className="ml-1 font-semibold text-amber-400 hover:underline"
          >
            {isRegisterMode ? 'เข้าสู่ระบบ' : 'สมัครสมาชิกที่นี่'}
          </button>
        </div>
      </div>
    </div>
  )
}
