export class ExtensionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ExtensionError";
    this.code = code;
    this.category = code.includes("POLICY") || code.includes("TRUST") || code.includes("WAIVER") ? "policy-denial" : "user-input";
    this.retryable = false;
    this.details = details;
  }
}

export function extensionFail(code, message, details) { throw new ExtensionError(code, message, details); }
