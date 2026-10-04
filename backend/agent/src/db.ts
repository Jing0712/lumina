import { GridFSBucket, MongoClient, type Collection, type Db, type Document } from 'mongodb';
import { COLLECTIONS, GRIDFS_BUCKETS } from '@lumina/contract';
import { env } from './env.js';

let client: MongoClient | null = null;
let connecting: Promise<MongoClient> | null = null;

/** One client per process. The driver pools connections; do not open one per request. */
export async function db(): Promise<Db> {
  if (!env.mongoUri) throw new Error('MONGODB_URI is not set — copy .env.example to .env');
  if (!client) {
    if (!connecting) {
      const c = new MongoClient(env.mongoUri, { serverSelectionTimeoutMS: 5000 });
      connecting = c.connect().then(
        () => {
          client = c;
          return c;
        },
        (err) => {
          connecting = null;
          throw err;
        }
      );
    }
    await connecting;
  }
  return (client as MongoClient).db(env.mongoDb);
}

export async function pingDb(): Promise<'ok' | 'down'> {
  try {
    await (await db()).command({ ping: 1 });
    return 'ok';
  } catch {
    return 'down';
  }
}

export type CollectionName = keyof typeof COLLECTIONS | 'usage' | 'answerCache';

/** Typed access to one of the contract's collections (plus `usage`, the deep-search counter). */
export async function col<T extends Document = Document>(name: CollectionName): Promise<Collection<T>> {
  const d = await db();
  const real = name === 'usage' || name === 'answerCache' ? name : COLLECTIONS[name];
  return d.collection<T>(real);
}

let bucket: GridFSBucket | null = null;

/**
 * One bucket per process. A GridFSBucket checks (and creates) its indexes on its first write,
 * which costs two or three Atlas round trips; a fresh bucket per upload paid that on every
 * 202 (accept_202_p95_ms).
 */
export async function uploadsBucket(): Promise<GridFSBucket> {
  if (!bucket) bucket = new GridFSBucket(await db(), { bucketName: GRIDFS_BUCKETS.uploads });
  return bucket;
}

export async function closeDb(): Promise<void> {
  if (client) await client.close();
  client = null;
  connecting = null;
  bucket = null;
}
