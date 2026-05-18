/** Base error for all storage operations. */
export class StoreError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

/** Thrown when attempting to access a session that does not exist. */
export class NotFoundError extends StoreError {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "NotFoundError";
  }
}

/** Thrown when stored data cannot be deserialized. */
export class CorruptDataError extends StoreError {
  constructor(sessionId: string, cause?: unknown) {
    super(`Corrupt data for session: ${sessionId}`, cause);
    this.name = "CorruptDataError";
  }
}
