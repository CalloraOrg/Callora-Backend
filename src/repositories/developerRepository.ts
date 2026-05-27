import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { Developer, NewDeveloper } from '../db/schema.js';
import type { UpdateDeveloperProfileInput } from '../types/developer.js';

export interface DeveloperRepository {
  findByUserId(userId: string): Promise<Developer | undefined>;
  getOrCreateByUserId(userId: string): Promise<Developer>;
  upsertProfile(userId: string, data: UpdateDeveloperProfileInput): Promise<Developer>;
}

export const defaultDeveloperRepository: DeveloperRepository = {
  findByUserId,
  getOrCreateByUserId,
  upsertProfile,
};

export async function findByUserId(userId: string): Promise<Developer | undefined> {
  const rows = await db
    .select()
    .from(schema.developers)
    .where(eq(schema.developers.user_id, userId))
    .limit(1);
  return rows[0];
}

export async function getOrCreateByUserId(userId: string): Promise<Developer> {
  const existing = await findByUserId(userId);
  if (existing) {
    return existing;
  }

  const [inserted] = await db
    .insert(schema.developers)
    .values({
      user_id: userId,
      name: null,
      website: null,
      description: null,
      category: null,
    } as NewDeveloper)
    .returning();

  if (!inserted) throw new Error('Developer insert failed');
  return inserted;
}

export async function upsertProfile(
  userId: string,
  data: UpdateDeveloperProfileInput,
): Promise<Developer> {
  const existing = await findByUserId(userId);
  const now = new Date();

  if (existing) {
    const [updated] = await db
      .update(schema.developers)
      .set({
        name: data.name ?? existing.name,
        website: data.website ?? existing.website,
        description: data.description ?? existing.description,
        category: data.category ?? existing.category,
        updated_at: now,
      })
      .where(eq(schema.developers.id, existing.id))
      .returning();
    if (!updated) throw new Error('Developer update failed');
    return updated;
  }

  const [inserted] = await db
    .insert(schema.developers)
    .values({
      user_id: userId,
      name: data.name ?? null,
      website: data.website ?? null,
      description: data.description ?? null,
      category: data.category ?? null,
    } as NewDeveloper)
    .returning();
  if (!inserted) throw new Error('Developer insert failed');
  return inserted;
}

export const upsert = upsertProfile;
