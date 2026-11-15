import type { Clock, IdGenerator } from '../../application/ports/system';

export const systemClock: Clock = { now: () => new Date() };

/** UUIDv7: time-ordered → B-tree friendly primary keys and natural creation order. */
export const uuidV7Generator: IdGenerator = { next: () => Bun.randomUUIDv7() };
