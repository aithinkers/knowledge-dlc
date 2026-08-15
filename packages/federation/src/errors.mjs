export class FederationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FederationError";
    this.code = code;
    this.details = details;
  }
}

export function federationFail(code, message, details) {
  throw new FederationError(code, message, details);
}
