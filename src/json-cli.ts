export interface JsonCliManifestContext {
  target?: string;
}

export interface JsonCliRouteContext {
  argv: string[];
  source: "argv" | "stdin";
}

export interface JsonCliOptions {
  manifest: (context: JsonCliManifestContext) => unknown | Promise<unknown>;
  route: (request: Record<string, unknown>, context: JsonCliRouteContext) => unknown | Promise<unknown>;
}

export class JsonCliError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly manifestTarget?: string;

  constructor(code: string, message: string, options: { details?: Record<string, unknown>; manifestTarget?: string } = {}) {
    super(message);
    this.name = "JsonCliError";
    this.code = code;
    this.details = options.details;
    this.manifestTarget = options.manifestTarget;
  }
}

export async function runJsonCli(options: JsonCliOptions): Promise<void> {
  const argv = process.argv.slice(2);
  try {
    const input = await resolveInput(argv);
    if (input.kind === "manifest") {
      writeJson(await options.manifest(input));
      return;
    }
    if (input.kind === "bad_args") {
      writeJson(errorEnvelope("BAD_ARGS", input.message, { expected: "flow, flow manifest, or flow '<json-body>'" }));
      process.exitCode = 1;
      return;
    }

    const request = parseJsonRequest(input.body);
    if (!request.ok) {
      writeJson(errorEnvelope(request.code, request.message, {
        ...request.details,
        body: input.body.length > 120 ? `${input.body.slice(0, 120)}...` : input.body,
      }));
      process.exitCode = 1;
      return;
    }

    const op = String(request.value.op);
    try {
      const result = await options.route(request.value, { argv, source: input.source });
      writeJson({ ok: true, op, result });
    } catch (error) {
      writeJson(routeErrorEnvelope(op, error));
      process.exitCode = 1;
    }
  } catch (error) {
    writeJson(errorEnvelope("UNHANDLED_ERROR", errorMessage(error)));
    process.exitCode = 1;
  }
}

function parseJsonRequest(body: string):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return {
      ok: false,
      code: "INVALID_JSON",
      message: errorMessage(error),
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      code: "BAD_REQUEST",
      message: "JSON body must be an object.",
      details: { expected: { op: "string" } },
    };
  }
  if (typeof parsed.op !== "string" || !parsed.op.trim()) {
    return {
      ok: false,
      code: "BAD_REQUEST",
      message: "JSON body must include a non-empty string op.",
      details: { expected: { op: "string" } },
    };
  }
  return { ok: true, value: parsed };
}

async function resolveInput(argv: string[]): Promise<
  | { kind: "manifest"; target?: string }
  | { kind: "body"; body: string; source: "argv" | "stdin" }
  | { kind: "bad_args"; message: string }
> {
  if (argv.length === 0) {
    if (process.stdin.isTTY) return { kind: "manifest" };
    const stdin = await readStdin();
    return stdin.trim() ? { kind: "body", body: stdin, source: "stdin" } : { kind: "manifest" };
  }
  if (argv.length === 1 && (argv[0] === "manifest" || argv[0] === "--help" || argv[0] === "-h")) {
    return { kind: "manifest" };
  }
  if (argv.length === 1) {
    return { kind: "body", body: argv[0], source: "argv" };
  }
  return { kind: "bad_args", message: "Expected at most one JSON body argument." };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function errorEnvelope(code: string, message: string, details?: Record<string, unknown>) {
  const target = manifestTarget(details);
  const manifest = target
    ? { body: { op: "manifest", target } }
    : { argv: "flow manifest", body: { op: "manifest", target: "<target>" } };
  return {
    ok: false,
    error: {
      code,
      message,
      hint: target
        ? `Run flow '{"op":"manifest","target":"${target}"}' for this request shape.`
        : "Run `flow manifest` for the compact contract, then send one JSON body such as {\"op\":\"state\"}.",
      manifest,
      ...(details ? { details } : {}),
    },
  };
}

function routeErrorEnvelope(op: string, error: unknown) {
  if (error instanceof JsonCliError) {
    return errorEnvelope(error.code, error.message, {
      op,
      ...(error.manifestTarget ? { manifest: { op: "manifest", target: error.manifestTarget } } : {}),
      ...error.details,
    });
  }
  return errorEnvelope("RUNTIME_ERROR", errorMessage(error), { op });
}

function manifestTarget(details?: Record<string, unknown>): string | undefined {
  const manifest = details?.manifest;
  if (!isRecord(manifest)) return undefined;
  return typeof manifest.target === "string" && manifest.target.trim() ? manifest.target : undefined;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
