export type FlowTheme = {
  id: string;
  name: string;
  primary: string;
  primaryDark: string;
  primaryFg: string;
};

export type ColorMode = "dark" | "light";

export const defaultThemes: FlowTheme[] = [
  { id: "default", name: "Flow", primary: "#6366f1", primaryDark: "#4338ca", primaryFg: "#ffffff" },
  { id: "forest", name: "Forest", primary: "#64a844", primaryDark: "#35661e", primaryFg: "#0c1a05" },
  { id: "ocean", name: "Ocean", primary: "#0ea5e9", primaryDark: "#0369a1", primaryFg: "#ffffff" },
  { id: "ember", name: "Ember", primary: "#f97316", primaryDark: "#c2410c", primaryFg: "#ffffff" },
  { id: "farmserver", name: "FARMserver", primary: "#6fb143", primaryDark: "#3f6f24", primaryFg: "#102108" },
];

const THEME_KEY = "flow.theme";
const MODE_KEY = "flow.mode";

export function getStoredThemeId(): string {
  try {
    return localStorage.getItem(THEME_KEY) || "default";
  } catch {
    return "default";
  }
}

export function getStoredMode(): ColorMode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function resolveTheme(id: string, availableThemes: FlowTheme[] = defaultThemes): FlowTheme {
  return availableThemes.find((t) => t.id === id) || availableThemes[0] || defaultThemes[0];
}

export function applyThemeToDOM(theme: FlowTheme, mode: ColorMode): void {
  const s = document.documentElement.style;
  s.setProperty("--th-primary", theme.primary);
  s.setProperty("--th-primary-dark", theme.primaryDark);
  s.setProperty("--th-primary-fg", theme.primaryFg);
  document.body.dataset.theme = mode;
  try {
    localStorage.setItem(THEME_KEY, theme.id);
    localStorage.setItem(MODE_KEY, mode);
  } catch {}
}
