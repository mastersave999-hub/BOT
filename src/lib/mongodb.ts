import 'server-only'

import { MongoClient } from 'mongodb'

let localMongoClientPromise: Promise<MongoClient> | undefined

declare global {
  var mongoClientPromise: Promise<MongoClient> | undefined
}

export async function getMongoDb() {
  const uri = process.env.MONGODB_URI
  if (!uri) {
    throw new Error('MONGODB_URI is not configured')
  }

  let clientPromise = globalThis.mongoClientPromise ?? localMongoClientPromise
  if (!clientPromise) {
    clientPromise = new MongoClient(uri).connect()
    localMongoClientPromise = clientPromise
    if (process.env.NODE_ENV !== 'production') {
      globalThis.mongoClientPromise = clientPromise
    }
  }

  return (await clientPromise).db()
}
