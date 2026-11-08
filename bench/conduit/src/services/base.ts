import { BaseService as FrameworkBaseService } from '../../../../src/server/lib/base-service';
import type { ConduitRepos } from '../repos';
import type { ConduitServices } from '.';

/** The framework's `BaseService` on this app's aggregators. */
export abstract class BaseService extends FrameworkBaseService<ConduitRepos, ConduitServices> {}

const POSTGRES_INTEGRITY_CLASS = '23';

/** SQLAlchemy's `IntegrityError`: a constraint failed. Drizzle wraps the driver's error in `cause`. */
export function isIntegrityError(err: unknown): boolean {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' && code.startsWith(POSTGRES_INTEGRITY_CLASS);
}
