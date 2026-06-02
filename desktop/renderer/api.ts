let cachedApiToken: string | undefined;

function getApiToken(): string {
  if (cachedApiToken !== undefined) return cachedApiToken;
  const params = new URLSearchParams(window.location.search);
  cachedApiToken = params.get("_token") ?? "";
  return cachedApiToken;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getApiToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("X-Flow-Token", token);
  const response = await fetch(url, { cache: "no-store", ...init, headers });
  const payload = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

export function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}
