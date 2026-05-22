export type ProviderErrorCode =
  | "cli_missing"
  | "auth_missing"
  | "rate_limited"
  | "network"
  | "malformed_output"
  | "unsupported"
  | "provider_failed";

export class ProviderAdapterError extends Error {
  readonly provider: string;
  readonly operation: string;
  readonly code: ProviderErrorCode;
  readonly cause?: unknown;

  constructor(input: {
    provider: string;
    operation: string;
    code: ProviderErrorCode;
    message: string;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = "ProviderAdapterError";
    this.provider = input.provider;
    this.operation = input.operation;
    this.code = input.code;
    this.cause = input.cause;
  }
}

export function classifyProviderCliError(provider: string, operation: string, error: unknown): ProviderAdapterError {
  if (error instanceof ProviderAdapterError) return error;
  const text = providerErrorText(error);
  const lower = text.toLowerCase();
  const code: ProviderErrorCode =
    lower.includes("enoent") || lower.includes("command not found")
      ? "cli_missing"
      : /auth|login|credential|token|unauthorized|forbidden/.test(lower)
        ? "auth_missing"
        : /rate.?limit|secondary rate/.test(lower)
          ? "rate_limited"
          : /network|econnreset|etimedout|enotfound|could not resolve|timeout/.test(lower)
            ? "network"
            : "provider_failed";
  return new ProviderAdapterError({
    provider,
    operation,
    code,
    message: `${provider} ${operation} failed (${code}): ${compactProviderError(text)}`,
    cause: error,
  });
}

function providerErrorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const record = error as Record<string, unknown>;
  return [
    typeof record.message === "string" ? record.message : "",
    typeof record.stderr === "string" ? record.stderr : "",
    typeof record.stdout === "string" ? record.stdout : "",
    typeof record.code === "string" ? record.code : "",
  ].filter(Boolean).join("\n");
}

function compactProviderError(text: string): string {
  const compacted = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" ");
  return compacted || "provider command failed";
}
