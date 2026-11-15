import { DomainValidationError } from './errors';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates a UUID (any version) and returns its canonical lowercase form, so that
 * identity comparisons in the domain never depend on the caller's casing and the
 * database `uuid` columns never receive a malformed value (which would surface as an
 * infrastructure error instead of a 400).
 */
export function canonicalUuid(field: string, value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new DomainValidationError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}
