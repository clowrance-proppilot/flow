export const workStatusSteps = ["Queued", "Active", "Ready", "Running", "In Review", "Done"] as const;
export const exceptionalWorkStatusLabels = ["Blocked", "Needs Input"] as const;
export const recordStatusLabels = ["Present", "Needed"] as const;

const allowedWorkStatusLabels = new Set<string>([
  ...workStatusSteps,
  ...exceptionalWorkStatusLabels,
  "Unknown",
]);
const allowedRecordStatusLabels = new Set<string>(recordStatusLabels);

export function normalizeWorkStatusLabel(value: unknown): string {
  return typeof value === "string" && allowedWorkStatusLabels.has(value) ? value : "Unknown";
}

export function normalizeRecordStatusLabel(value: unknown): string {
  return typeof value === "string" && allowedRecordStatusLabels.has(value) ? value : "Needed";
}

export function isExceptionalWorkStatusLabel(value: string): boolean {
  return exceptionalWorkStatusLabels.includes(value as typeof exceptionalWorkStatusLabels[number]);
}
