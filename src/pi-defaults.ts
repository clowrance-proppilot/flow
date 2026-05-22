export const DEFAULT_PI_PROVIDER = "openrouter";
export const DEFAULT_PI_MODEL = "google/gemini-3.5-flash";

export const DEFAULT_AGENT_PROVIDER = DEFAULT_PI_PROVIDER;
export const DEFAULT_AGENT_MODEL = DEFAULT_PI_MODEL;

export function configuredPiValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export const configuredAgentValue = configuredPiValue;
