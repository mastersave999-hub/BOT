import { randomUUID } from 'node:crypto'
import { auth, currentUser } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { CardSchema } from '../../../engine/types'
import type { SavedDeck, UserAccount } from '../../../engine/authTypes'
import { getMongoDb } from '../../../lib/mongodb'

export const dynamic = 'force-dynamic'

interface PlayerProfileDocument {
  _id: string
  email: string
  username: string
  savedDecks: SavedDeck[]
  createdAt: Date
  updatedAt: Date
}

const saveDeckSchema = z.object({
  deckId: z.string().max(100).nullable().optional(),
  name: z.string().trim().max(120).optional().default(''),
  mainDeck: z.array(CardSchema).max(100),
  lifeDeck: z.array(CardSchema).max(20),
})

const deleteDeckSchema = z.object({
  deckId: z.string().min(1).max(100),
})

function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

async function getPlayerContext() {
  const { userId } = await auth()
  if (!userId) return null

  const identity = await currentUser()
  if (!identity) return null

  const email = identity.primaryEmailAddress?.emailAddress ?? ''
  const nameFromIdentity = identity.username ||
    [identity.firstName, identity.lastName].filter(Boolean).join(' ') ||
    email.split('@')[0]
  const username = nameFromIdentity.trim().slice(0, 24) || `player-${userId.slice(-8)}`
  const profiles = (await getMongoDb()).collection<PlayerProfileDocument>('player_profiles')
  const now = new Date()

  await profiles.updateOne(
    { _id: userId },
    {
      $set: { email, username, updatedAt: now },
      $setOnInsert: { savedDecks: [], createdAt: now },
    },
    { upsert: true },
  )

  const profile = await profiles.findOne({ _id: userId })
  if (!profile) return null

  const account: UserAccount = {
    id: profile._id,
    email: profile.email,
    username: profile.username,
    avatarUrl: identity.imageUrl || null,
    savedDecks: Array.isArray(profile.savedDecks) ? profile.savedDecks : [],
  }

  return { profiles, profile, identity, account }
}

export async function GET() {
  try {
    const context = await getPlayerContext()
    if (!context) return jsonResponse({ message: 'กรุณาเข้าสู่ระบบก่อน' }, 401)
    return jsonResponse(context.account)
  } catch (error) {
    console.error('[account] Failed to load player profile', error)
    return jsonResponse({ message: 'โหลดโปรไฟล์ไม่สำเร็จ กรุณาลองอีกครั้ง' }, 500)
  }
}

export async function PUT(request: Request) {
  try {
    const context = await getPlayerContext()
    if (!context) return jsonResponse({ message: 'กรุณาเข้าสู่ระบบก่อน' }, 401)

    const body: unknown = await request.json().catch(() => null)
    const parsed = saveDeckSchema.safeParse(body)
    if (!parsed.success) {
      return jsonResponse({ message: 'ข้อมูลเด็คไม่ถูกต้อง กรุณาตรวจสอบแล้วลองอีกครั้ง' }, 400)
    }

    const savedDecks = Array.isArray(context.profile.savedDecks) ? context.profile.savedDecks : []
    const requestedDeckId = parsed.data.deckId ?? null
    const existingDeck = requestedDeckId
      ? savedDecks.find((deck) => deck.id === requestedDeckId)
      : undefined
    const savedDeck: SavedDeck = {
      id: existingDeck?.id ?? randomUUID(),
      name: parsed.data.name || `เด็คใหม่ ${savedDecks.length + 1}`,
      createdAt: existingDeck?.createdAt ?? Date.now(),
      mainDeck: parsed.data.mainDeck,
      lifeDeck: parsed.data.lifeDeck,
    }
    const updatedAt = new Date()

    if (existingDeck) {
      const result = await context.profiles.updateOne(
        { _id: context.profile._id, 'savedDecks.id': existingDeck.id },
        { $set: { 'savedDecks.$': savedDeck, updatedAt } },
      )
      if (result.matchedCount === 0) {
        return jsonResponse({ message: 'เด็คเปลี่ยนแปลงระหว่างบันทึก กรุณาลองอีกครั้ง' }, 409)
      }
    } else {
      await context.profiles.updateOne(
        { _id: context.profile._id },
        {
          $push: { savedDecks: { $each: [savedDeck], $position: 0 } },
          $set: { updatedAt },
        },
      )
    }

    const updatedProfile = await context.profiles.findOne({ _id: context.profile._id })
    if (!updatedProfile) return jsonResponse({ message: 'ไม่พบโปรไฟล์ผู้เล่น' }, 404)

    return jsonResponse({
      ...context.account,
      savedDecks: Array.isArray(updatedProfile.savedDecks) ? updatedProfile.savedDecks : [],
    } satisfies UserAccount)
  } catch (error) {
    console.error('[account] Failed to save player deck', error)
    return jsonResponse({ message: 'บันทึกเด็คไม่สำเร็จ กรุณาลองอีกครั้ง' }, 500)
  }
}

export async function DELETE(request: Request) {
  try {
    const context = await getPlayerContext()
    if (!context) return jsonResponse({ message: 'กรุณาเข้าสู่ระบบก่อน' }, 401)

    const body: unknown = await request.json().catch(() => null)
    const parsed = deleteDeckSchema.safeParse(body)
    if (!parsed.success) {
      return jsonResponse({ message: 'รหัสเด็คไม่ถูกต้อง' }, 400)
    }

    await context.profiles.updateOne(
      { _id: context.profile._id },
      {
        $pull: { savedDecks: { id: parsed.data.deckId } },
        $set: { updatedAt: new Date() },
      },
    )

    const updatedProfile = await context.profiles.findOne({ _id: context.profile._id })
    if (!updatedProfile) return jsonResponse({ message: 'ไม่พบโปรไฟล์ผู้เล่น' }, 404)

    return jsonResponse({
      ...context.account,
      savedDecks: Array.isArray(updatedProfile.savedDecks) ? updatedProfile.savedDecks : [],
    } satisfies UserAccount)
  } catch (error) {
    console.error('[account] Failed to delete player deck', error)
    return jsonResponse({ message: 'ลบเด็คไม่สำเร็จ กรุณาลองอีกครั้ง' }, 500)
  }
}
