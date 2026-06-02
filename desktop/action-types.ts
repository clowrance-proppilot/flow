export const desktopActionValues = ["autoflow", "approve_confirmation", "record_evidence", "record_result", "record_documentation", "run_doctor"] as const;

export type DesktopAction = typeof desktopActionValues[number];
