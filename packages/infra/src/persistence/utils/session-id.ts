import { StoreError } from "../errors.js";

const MAX_SESSION_ID_LENGTH = 191;

export function validateSessionId(sessionId: string): void {
  if (
    sessionId.length === 0 ||
    sessionId.length > MAX_SESSION_ID_LENGTH ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId === "." ||
    sessionId === ".."
  ) {
    throw new StoreError(`Invalid sessionId: ${sessionId}`);
  }
}
