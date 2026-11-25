import type { Card } from './types'

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
  avatarUrl: string | null
  savedDecks: SavedDeck[]
}
