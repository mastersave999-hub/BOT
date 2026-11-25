'use client'

import React, { useState } from 'react'
import { useSignIn, useSignUp } from '@clerk/nextjs'
import { ArrowLeft, ArrowRight, LoaderCircle, User, X } from 'lucide-react'

interface AuthModalProps {
  isOpen: boolean
  onClose: () => void
}

type VerificationFlow = 'sign-in' | 'sign-up' | null

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose }) => {
  const { signIn } = useSignIn()
  const { signUp } = useSignUp()
  const [isRegisterMode, setIsRegisterMode] = useState(false)
  const [verificationFlow, setVerificationFlow] = useState<VerificationFlow>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  if (!isOpen) return null

  const clearAttempt = () => {
    void signIn.reset()
    void signUp.reset()
    setVerificationFlow(null)
    setVerificationCode('')
    setMessage(null)
  }

  const completeAuthentication = () => {
    clearAttempt()
    setEmail('')
    setPassword('')
    setIsRegisterMode(false)
    onClose()
  }

  const handlePasswordSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage(null)
    setIsSubmitting(true)

    try {
      if (isRegisterMode) {
        const result = await signUp.password({ emailAddress: email.trim(), password })
        if (result.error) throw result.error

        if (signUp.status === 'complete') {
          const finalized = await signUp.finalize()
          if (finalized.error) throw finalized.error
          completeAuthentication()
          return
        }

        const verification = await signUp.verifications.sendEmailCode()
        if (verification.error) throw verification.error
        setVerificationFlow('sign-up')
        return
      }

      const result = await signIn.password({ emailAddress: email.trim(), password })
      if (result.error) throw result.error

      if (signIn.status === 'complete') {
        const finalized = await signIn.finalize()
        if (finalized.error) throw finalized.error
        completeAuthentication()
        return
      }

      if (signIn.status === 'needs_second_factor' || signIn.status === 'needs_client_trust') {
        const emailFactor = signIn.supportedSecondFactors.find((factor) => factor.strategy === 'email_code')
        if (!emailFactor) {
          setMessage('บัญชีนี้ต้องยืนยันตัวตนเพิ่มเติมด้วยวิธีที่ยังไม่รองรับ')
          return
        }

        const verification = await signIn.mfa.sendEmailCode()
        if (verification.error) throw verification.error
        setVerificationFlow('sign-in')
        return
      }

      setMessage('เข้าสู่ระบบไม่สำเร็จ กรุณาตรวจสอบอีเมลและรหัสผ่าน')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'ทำรายการไม่สำเร็จ กรุณาลองอีกครั้ง')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleVerificationSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage(null)
    setIsSubmitting(true)

    try {
      if (verificationFlow === 'sign-up') {
        const result = await signUp.verifications.verifyEmailCode({ code: verificationCode.trim() })
        if (result.error) throw result.error
        if (signUp.status !== 'complete') {
          setMessage('การยืนยันยังไม่เสร็จสมบูรณ์ กรุณาลองอีกครั้ง')
          return
        }

        const finalized = await signUp.finalize()
        if (finalized.error) throw finalized.error
      } else {
        const result = await signIn.mfa.verifyEmailCode({ code: verificationCode.trim() })
        if (result.error) throw result.error
        if (signIn.status !== 'complete') {
          setMessage('การยืนยันยังไม่เสร็จสมบูรณ์ กรุณาลองอีกครั้ง')
          return
        }

        const finalized = await signIn.finalize()
        if (finalized.error) throw finalized.error
      }

      completeAuthentication()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'รหัสยืนยันไม่ถูกต้อง กรุณาลองอีกครั้ง')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleResendCode = async () => {
    setMessage(null)
    setIsSubmitting(true)
    try {
      const result = verificationFlow === 'sign-up'
        ? await signUp.verifications.sendEmailCode()
        : await signIn.mfa.sendEmailCode()
      if (result.error) throw result.error
      setMessage('ส่งรหัสยืนยันใหม่แล้ว')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'ส่งรหัสใหม่ไม่สำเร็จ กรุณาลองอีกครั้ง')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleModeChange = () => {
    clearAttempt()
    setIsRegisterMode((current) => !current)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm font-kanit">
      <section role="dialog" aria-modal="true" aria-labelledby="auth-title" className="relative w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          aria-label="ปิดหน้าต่าง"
          className="absolute right-4 top-4 rounded-full bg-slate-800 p-1 text-slate-400 transition hover:bg-slate-700 hover:text-white"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>

        <div className="mb-5 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-tr from-amber-500 to-red-600 shadow-lg shadow-red-950/50">
            <User aria-hidden="true" className="h-6 w-6 text-slate-950" />
          </div>
          <h2 id="auth-title" className="text-xl font-bold text-slate-100">
            {verificationFlow ? 'ยืนยันอีเมล' : isRegisterMode ? 'สร้างบัญชีผู้เล่น' : 'เข้าสู่ระบบ'}
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            {verificationFlow
              ? `กรอกรหัสที่ส่งไปยัง ${email}`
              : 'ใช้อีเมลและรหัสผ่านเพื่อบันทึกเด็คและโปรไฟล์'}
          </p>
        </div>

        {verificationFlow ? (
          <form onSubmit={(event) => void handleVerificationSubmit(event)} className="space-y-3">
            <label htmlFor="auth-verification-code" className="block text-xs font-semibold text-slate-300">รหัสยืนยัน</label>
            <input
              id="auth-verification-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={verificationCode}
              onChange={(event) => setVerificationCode(event.target.value)}
              required
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-center text-lg tracking-[0.3em] text-slate-100 outline-none transition focus:border-amber-500"
            />
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
              ยืนยันรหัส
            </button>
            <div className="flex items-center justify-between pt-1">
              <button
                type="button"
                onClick={() => {
                  clearAttempt()
                  setIsRegisterMode(false)
                }}
                disabled={isSubmitting}
                className="flex items-center gap-1 text-xs text-slate-400 transition hover:text-slate-200 disabled:opacity-50"
              >
                <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
                กลับไปเข้าสู่ระบบ
              </button>
              <button
                type="button"
                onClick={() => void handleResendCode()}
                disabled={isSubmitting}
                className="text-xs font-semibold text-amber-400 transition hover:text-amber-300 disabled:opacity-50"
              >
                ส่งรหัสอีกครั้ง
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={(event) => void handlePasswordSubmit(event)} className="space-y-3">
            <div>
              <label htmlFor="auth-email" className="mb-1.5 block text-xs font-semibold text-slate-300">อีเมล</label>
              <input
                id="auth-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-sm text-slate-100 outline-none transition focus:border-amber-500"
              />
            </div>
            <div>
              <label htmlFor="auth-password" className="mb-1.5 block text-xs font-semibold text-slate-300">รหัสผ่าน</label>
              <input
                id="auth-password"
                type="password"
                autoComplete={isRegisterMode ? 'new-password' : 'current-password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={8}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-sm text-slate-100 outline-none transition focus:border-amber-500"
              />
            </div>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 py-2.5 text-sm font-bold text-slate-950 shadow-lg shadow-amber-950/50 transition hover:from-amber-400 hover:to-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
              {isRegisterMode ? 'สร้างบัญชี' : 'เข้าสู่ระบบ'}
              {!isSubmitting && <ArrowRight aria-hidden="true" className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={handleModeChange}
              disabled={isSubmitting}
              className="w-full pt-1 text-xs text-slate-400 transition hover:text-amber-300 disabled:opacity-50"
            >
              {isRegisterMode ? 'มีบัญชีแล้ว? เข้าสู่ระบบ' : 'ยังไม่มีบัญชี? สมัครสมาชิก'}
            </button>
          </form>
        )}

        {message && <p role="alert" className="mt-3 text-center text-xs text-red-300">{message}</p>}
      </section>
    </div>
  )
}
