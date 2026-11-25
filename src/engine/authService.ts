'use client'

import type { Card } from './types'
import { createClient } from '../lib/supabase/client'

export interface SavedDeck {
  id: string
  name: string
  createdAt: number
  mainDeck: Card[]
  lifeDeck: Card[]
}

export interface UserAccount {
  id: string
  email: string
  username: string
  avatarPath: string | null
  avatarUrl: string | null
  savedDecks: SavedDeck[]
}

type ProfileRow = {
  username: string
  avatar_path: string | null
  saved_decks: SavedDeck[] | null
}

const AVATAR_BUCKET = 'avatars'
const MAX_AVATAR_SIZE = 5 * 1024 * 1024
const ALLOWED_AVATAR_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

function migrateLegacyDecks(username: string): SavedDeck[] {
  if (typeof window === 'undefined') return []

  try {
    const raw = localStorage.getItem('bot_users_db')
    if (!raw) {
      localStorage.removeItem('bot_current_user')
      return []
    }

    const oldUsers = JSON.parse(raw) as Record<string, { password?: string; account?: { username?: string; savedDecks?: SavedDeck[] } }>
    const matchingEntry = Object.entries(oldUsers).find(([key, value]) =>
      key.toLowerCase() === username.toLowerCase() ||
      value.account?.username?.toLowerCase() === username.toLowerCase(),
    )
    const legacyDecks = matchingEntry && Array.isArray(matchingEntry[1].account?.savedDecks)
      ? matchingEntry[1].account.savedDecks
      : []

    const passwordFreeUsers = Object.fromEntries(
      Object.entries(oldUsers).map(([key, value]) => [
        key,
        Object.fromEntries(Object.entries(value).filter(([field]) => field !== 'password')),
      ]),
    )
    localStorage.setItem('bot_users_db', JSON.stringify(passwordFreeUsers))
    localStorage.removeItem('bot_current_user')
    return legacyDecks
  } catch {
    localStorage.removeItem('bot_users_db')
    localStorage.removeItem('bot_current_user')
    return []
  }
}

async function loadAccount(userId: string, email: string, metadataUsername: unknown): Promise<UserAccount> {
  const supabase = createClient()
  const { data: existingProfile, error: readError } = await supabase
    .from('profiles')
    .select('username, avatar_path, saved_decks')
    .eq('id', userId)
    .maybeSingle()

  if (readError) throw readError

  let profile = existingProfile as ProfileRow | null
  if (!profile) {
    const candidate = typeof metadataUsername === 'string' ? metadataUsername.trim() : ''
    const username = candidate.length >= 3 && candidate.length <= 24
      ? candidate
      : `player-${userId.slice(0, 8)}`
    const { error: insertError } = await supabase.from('profiles').insert({ id: userId, username })
    if (insertError) throw insertError

    const { data, error } = await supabase
      .from('profiles')
      .select('username, avatar_path, saved_decks')
      .eq('id', userId)
      .single()
    if (error) throw error
    profile = data as ProfileRow
  }

  const legacyDecks = migrateLegacyDecks(profile.username)
  if (!profile.saved_decks?.length && legacyDecks.length > 0) {
    const { error } = await supabase
      .from('profiles')
      .update({ saved_decks: legacyDecks })
      .eq('id', userId)
    if (error) throw error
    profile.saved_decks = legacyDecks
  }

  let avatarUrl: string | null = null
  if (profile.avatar_path) {
    const { data } = await supabase.storage.from(AVATAR_BUCKET).createSignedUrl(profile.avatar_path, 3600)
    avatarUrl = data?.signedUrl ?? null
  }

  return {
    id: userId,
    email,
    username: profile.username,
    avatarPath: profile.avatar_path,
    avatarUrl,
    savedDecks: Array.isArray(profile.saved_decks) ? profile.saved_decks : [],
  }
}

export async function getCurrentUser(): Promise<UserAccount | null> {
  const supabase = createClient()
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return null

  return loadAccount(data.user.id, data.user.email ?? '', data.user.user_metadata?.username)
}

export async function registerUser(
  email: string,
  username: string,
  password: string,
): Promise<{ success: boolean; message: string; user?: UserAccount }> {
  const cleanEmail = email.trim().toLowerCase()
  const cleanUsername = username.trim()
  if (cleanUsername.length < 3 || cleanUsername.length > 24) {
    return { success: false, message: 'ชื่อผู้ใช้ต้องมีความยาว 3–24 ตัวอักษร' }
  }
  if (password.length < 8) {
    return { success: false, message: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' }
  }

  const supabase = createClient()
  const { data, error } = await supabase.auth.signUp({
    email: cleanEmail,
    password,
    options: {
      data: { username: cleanUsername },
      emailRedirectTo: process.env.NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL ??
        `${window.location.origin}/auth/callback`,
    },
  })

  if (error) {
    const details = error.message.toLowerCase()
    if (error.status === 429) {
      return { success: false, message: 'มีการสมัครบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่' }
    }
    if (details.includes('password') && (details.includes('weak') || details.includes('short'))) {
      return { success: false, message: 'รหัสผ่านยังไม่ปลอดภัยพอ กรุณาใช้รหัสผ่านที่ยาวและคาดเดายากขึ้น' }
    }
    if (details.includes('invalid email')) {
      return { success: false, message: 'รูปแบบอีเมลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง' }
    }
    return { success: false, message: 'สมัครบัญชีไม่สำเร็จ กรุณาตรวจสอบข้อมูลแล้วลองอีกครั้ง' }
  }

  if (!data.session || !data.user) {
    return { success: true, message: 'ส่งลิงก์ยืนยันไปยังอีเมลของคุณแล้ว กรุณายืนยันก่อนเข้าสู่ระบบ' }
  }

  try {
    const user = await loadAccount(data.user.id, data.user.email ?? cleanEmail, cleanUsername)
    return { success: true, message: 'สมัครสมาชิกสำเร็จ!', user }
  } catch {
    return { success: false, message: 'สร้างโปรไฟล์ไม่สำเร็จ กรุณาลองเข้าสู่ระบบอีกครั้ง' }
  }
}

export async function loginUser(
  identifier: string,
  password: string,
): Promise<{ success: boolean; message: string; user?: UserAccount }> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  })
  const result = await response.json() as { success: boolean; message: string }

  if (!response.ok || !result.success) {
    return { success: false, message: result.message ?? 'ระบบบัญชีขัดข้องชั่วคราว กรุณาลองอีกครั้ง' }
  }

  try {
    const user = await getCurrentUser()
    if (!user) return { success: false, message: 'เข้าสู่ระบบแล้วแต่โหลดโปรไฟล์ไม่สำเร็จ กรุณาลองอีกครั้ง' }
    return { success: true, message: result.message, user }
  } catch {
    return { success: false, message: 'โหลดโปรไฟล์ไม่สำเร็จ กรุณาลองอีกครั้ง' }
  }
}

export async function logoutUser(): Promise<void> {
  const supabase = createClient()
  await supabase.auth.signOut()
}

export async function saveDeckForUser(
  user: UserAccount,
  deckName: string,
  mainDeck: Card[],
  lifeDeck: Card[],
  deckId?: string | null,
): Promise<UserAccount | null> {
  const existingDeck = deckId ? user.savedDecks.find((deck) => deck.id === deckId) : undefined
  const savedDeck: SavedDeck = {
    id: existingDeck?.id ?? crypto.randomUUID(),
    name: deckName.trim() || `เด็คใหม่ ${user.savedDecks.length + 1}`,
    createdAt: existingDeck?.createdAt ?? Date.now(),
    mainDeck,
    lifeDeck,
  }
  const savedDecks = existingDeck
    ? user.savedDecks.map((deck) => deck.id === existingDeck.id ? savedDeck : deck)
    : [savedDeck, ...user.savedDecks]
  const supabase = createClient()
  const { error } = await supabase
    .from('profiles')
    .update({ saved_decks: savedDecks, updated_at: new Date().toISOString() })
    .eq('id', user.id)

  if (error) throw error
  return { ...user, savedDecks }
}

export async function deleteDeckForUser(user: UserAccount, deckId: string): Promise<UserAccount | null> {
  const savedDecks = user.savedDecks.filter((deck) => deck.id !== deckId)
  const supabase = createClient()
  const { error } = await supabase
    .from('profiles')
    .update({ saved_decks: savedDecks, updated_at: new Date().toISOString() })
    .eq('id', user.id)

  if (error) throw error
  return { ...user, savedDecks }
}

export async function uploadAvatar(user: UserAccount, file: File): Promise<UserAccount> {
  if (!ALLOWED_AVATAR_TYPES.has(file.type)) {
    throw new Error('รองรับเฉพาะไฟล์ JPG, PNG และ WebP')
  }
  if (file.size > MAX_AVATAR_SIZE) {
    throw new Error('รูปภาพต้องมีขนาดไม่เกิน 5 MB')
  }

  const supabase = createClient()
  const extension = file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1]
  const avatarPath = `${user.id}/${crypto.randomUUID()}.${extension}`
  const { error: uploadError } = await supabase.storage.from(AVATAR_BUCKET).upload(avatarPath, file, {
    contentType: file.type,
    cacheControl: '3600',
    upsert: false,
  })
  if (uploadError) throw uploadError

  const { error: updateError } = await supabase
    .from('profiles')
    .update({ avatar_path: avatarPath, updated_at: new Date().toISOString() })
    .eq('id', user.id)

  if (updateError) {
    await supabase.storage.from(AVATAR_BUCKET).remove([avatarPath])
    throw updateError
  }

  if (user.avatarPath) {
    await supabase.storage.from(AVATAR_BUCKET).remove([user.avatarPath])
  }

  const { data, error: signedUrlError } = await supabase.storage
    .from(AVATAR_BUCKET)
    .createSignedUrl(avatarPath, 3600)
  if (signedUrlError) throw signedUrlError

  return { ...user, avatarPath, avatarUrl: data.signedUrl }
}

export async function removeAvatar(user: UserAccount): Promise<UserAccount> {
  const supabase = createClient()
  const { error } = await supabase
    .from('profiles')
    .update({ avatar_path: null, updated_at: new Date().toISOString() })
    .eq('id', user.id)
  if (error) throw error

  if (user.avatarPath) {
    await supabase.storage.from(AVATAR_BUCKET).remove([user.avatarPath])
  }

  return { ...user, avatarPath: null, avatarUrl: null }
}
