export class FlowInputError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly target?: string;

  constructor(code: string, message: string, options: { details?: Record<string, unknown>; target?: string } = {}) {
    super(message);
    this.name = "FlowInputError";
    this.code = code;
    this.details = options.details;
    this.target = options.target;
  }
}
