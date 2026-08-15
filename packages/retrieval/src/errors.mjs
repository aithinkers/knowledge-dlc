export class RetrievalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RetrievalError";
    this.code = code;
    this.details = details;
  }
}

export function retrievalFail(code, message, details) { throw new RetrievalError(code, message, details); }
