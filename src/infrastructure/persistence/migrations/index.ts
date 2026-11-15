import { Migration20261115000001InitialSchema } from './Migration20261115000001InitialSchema';
import { Migration20261115000002IntegrityTriggers } from './Migration20261115000002IntegrityTriggers';

/**
 * Explicit, ordered list instead of filesystem globbing: deterministic under Bun,
 * works the same from source and from a bundle.
 */
export const migrationsList = [
  { name: 'Migration20261115000001InitialSchema', class: Migration20261115000001InitialSchema },
  { name: 'Migration20261115000002IntegrityTriggers', class: Migration20261115000002IntegrityTriggers },
];
