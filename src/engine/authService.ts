'use client'

import type { Card } from './types'
import type { SavedDeck, UserAccount } from './authTypes'

export type { SavedDeck, UserAccount } from './authTypes'

async function readAccountResponse(response: Response): Promise<UserAccount> {
  const payload = await response.json().catch(() => null) as { message?: string } | null
  if (!response.ok) {
    throw new Error(payload?.message ?? 'ระบบบัญชีขัดข้องชั่วคราว กรุณาลองอีกครั้ง')
  }
  return payload as UserAccount
}

export async function getCurrentUser(): Promise<UserAccount | null> {
  const response = await fetch('/api/account', { cache: 'no-store' })
  if (response.status === 401) return null
  return readAccountResponse(response)
}

export async function saveDeckForUser(
  deckName: string,
  mainDeck: Card[],
  lifeDeck: Card[],
  deckId?: string | null,
): Promise<UserAccount> {
  const response = await fetch('/api/account', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ deckId, name: deckName, mainDeck, lifeDeck }),
  })
  return readAccountResponse(response)
}

export async function deleteDeckForUser(deckId: string): Promise<UserAccount> {
  const response = await fetch('/api/account', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ deckId }),
  })
  return readAccountResponse(response)
}
