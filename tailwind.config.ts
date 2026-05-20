import type { Config } from "tailwindcss";

export default {
  content: ["./src/dashboard/**/*.{html,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        fs: {
          green: "#64a844",
          greenDark: "#35661e",
          blue: "#448ea8",
          yellow: "#e5c240",
          red: "#b62928",
          purple: "#702f7e",
        },
      },
      fontFamily: {
        sans: ["Open Sans", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      boxShadow: {
        app: "0 0 0 0.5px rgb(255 255 255 / 0.06), 0 30px 80px rgb(0 0 0 / 0.55), 0 8px 24px rgb(0 0 0 / 0.35)",
        selected: "0 0 0 1px #64a844 inset, 0 0 0 3px rgb(100 168 68 / 0.18)",
      },
    },
  },
} satisfies Config;
