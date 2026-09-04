export function releaseResources(releases: Array<() => void>): unknown[] {
  const errors: unknown[] = [];
  for (let index = releases.length - 1; index >= 0; index -= 1) {
    try {
      releases[index]();
      releases.splice(index, 1);
    } catch (error) {
      // Keep failed releases for a later attempt; still try every owner.
      errors.push(error);
    }
  }
  return errors;
}

/**
 * Owns resources left by failed construction. Retain this error until cleanup
 * succeeds; failed retries rethrow the same owner and append their errors.
 */
export class ConstructionCleanupError extends AggregateError {
  declare errors: unknown[];

  constructor(
    cause: unknown,
    cleanupErrors: readonly unknown[],
    private readonly releases: Array<() => void>,
    message: string,
  ) {
    super([cause, ...cleanupErrors], message, { cause });
    this.name = 'ConstructionCleanupError';
  }

  retryCleanup(): void {
    const errors = releaseResources(this.releases);
    if (errors.length > 0) {
      this.errors.push(...errors);
      throw this;
    }
  }

  dispose(): void {
    this.retryCleanup();
  }
}

export function rollbackConstruction(
  cause: unknown,
  releases: Array<() => void>,
  message: string,
): never {
  const errors = releaseResources(releases);
  if (errors.length === 0) throw cause;

  // The child already attempted rollback. Transfer ownership, not an implicit retry.
  if (cause instanceof ConstructionCleanupError) {
    releases.push(() => cause.retryCleanup());
  }
  throw new ConstructionCleanupError(cause, errors, releases, message);
}
