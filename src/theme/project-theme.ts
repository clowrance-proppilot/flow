export interface ProjectThemeInput {
  id: string;
  name: string;
  root?: string;
  icon?: string;
}

export interface ProjectTheme {
  color: string;
  colorSoft: string;
  colorText: string;
  initials: string;
  iconUrl?: string;
}

const palette = [
  "#38bdf8",
  "#2dd4bf",
  "#f59e0b",
  "#f97316",
  "#22c55e",
  "#ef4444",
  "#a78bfa",
  "#f472b6",
  "#84cc16",
  "#60a5fa",
];

export function projectThemeFor(project: ProjectThemeInput): ProjectTheme {
  const seed = project.id || project.root || project.name;
  const color = palette[hashString(seed) % palette.length] ?? palette[0];
  return {
    color,
    colorSoft: `${color}26`,
    colorText: readableTextColor(color),
    initials: projectInitials(project.name),
    iconUrl: project.icon,
  };
}

export function projectInitials(name: string): string {
  const parts = name
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0]?.slice(0, 2).toUpperCase() ?? "?";
  return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readableTextColor(hex: string): string {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.58 ? "#08111f" : "#f8fafc";
}
