export const DEFAULT_PI_PROVIDER = "openrouter";
export const DEFAULT_PI_MODEL = "google/gemini-3.5-flash";

export function configuredPiValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
