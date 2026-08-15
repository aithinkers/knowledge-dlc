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

export function fromNativeError(error, {
  code = "KDLC_INTERNAL_ERROR",
  category = "internal-engine-error",
  message = "Lifecycle operation failed",
  retryable = false,
  details
} = {}) {
  if (error instanceof LifecycleError) return error;
  const nativeCode = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : undefined;
  return new LifecycleError(code, category, message, {
    retryable,
    details: {
      ...(details ?? {}),
      ...(nativeCode === undefined ? {} : { native_code: nativeCode })
    }
  });
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

export function assertIdentifier(value, label = "identifier") {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw invalid(`${label} must be a safe canonical identifier`);
  return value;
}
