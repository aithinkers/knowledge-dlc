export class LifecycleError extends Error {
  constructor(code, category, message, { retryable = false, details } = {}) {
    super(message);
    this.name = "LifecycleError";
    this.code = code;
    this.category = category;
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }

  structured(correlationId) {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      correlation_id: correlationId,
      ...(this.details === undefined ? {} : { details: this.details })
    };
  }
}

export function conflict(message, details) {
  return new LifecycleError("KDLC_HASH_CONFLICT", "concurrency-conflict", message, { details });
}

export function invalid(message, details) {
  return new LifecycleError("KDLC_INPUT_INVALID", "user-correctable-input", message, { details });
}

export function denied(message, details) {
  return new LifecycleError("KDLC_POLICY_DENIED", "policy-denial", message, { details });
}
