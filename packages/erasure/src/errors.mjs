export class ErasureError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ErasureError";
    this.code = code;
    this.details = details;
  }
}

export const invalid = (message, details) =>
  new ErasureError("KDLC_ERASURE_INPUT_INVALID", message, details);
export const denied = (message, details) =>
  new ErasureError("KDLC_ERASURE_POLICY_DENIED", message, details);
export const conflict = (message, details) =>
  new ErasureError("KDLC_ERASURE_CONFLICT", message, details);
export const incomplete = (message, details) =>
  new ErasureError("KDLC_ERASURE_INCOMPLETE", message, details);
