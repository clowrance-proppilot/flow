export function normalizeRepoKey(value: string): string {
  return value.replace(/-/g, "_").replace(/[^a-zA-Z0-9_]/g, "_");
}

export function normalizeRepoKeys(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeRepoKey(value.trim());
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

export function existingString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function metadataBoolean(value: unknown): boolean | undefined {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return undefined;
}

export function metadataNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function metadataStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return undefined;
}

export function metadataValueEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
  }
  return false;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function workRuntimeQueueConcurrency(): number {
  const parsed = Number(process.env.FLOW_WORK_RUNTIME_QUEUE_CONCURRENCY ?? "4");
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 4;
}
