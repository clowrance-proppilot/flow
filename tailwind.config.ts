import type { Config } from "tailwindcss";

export default {
  content: [
    "./src/dashboard/**/*.{html,ts,tsx}",
    "./desktop/renderer/**/*.{html,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        /* ---- Brand ---- */
        flow: {
          primary: "var(--flow-primary)",
          "primary-dark": "var(--flow-primary-dark)",
          "primary-fg": "var(--flow-primary-fg)",
        },
        /* ---- Surfaces ---- */
        surface: {
          app: "var(--flow-app)",
          DEFAULT: "var(--flow-surface)",
          card: "var(--flow-card)",
          "card-hover": "var(--flow-card-hover)",
          input: "var(--flow-input)",
          overlay: "var(--flow-overlay)",
        },
        /* ---- Borders ---- */
        border: {
          DEFAULT: "var(--flow-border)",
          strong: "var(--flow-border-strong)",
        },
        /* ---- Text ---- */
        fg: {
          DEFAULT: "var(--flow-fg)",
          soft: "var(--flow-fg-soft)",
          muted: "var(--flow-fg-muted)",
          faint: "var(--flow-fg-faint)",
        },
        /* ---- Interactive ---- */
        hover: "var(--flow-hover)",
        "focus-ring": "var(--flow-focus-ring)",
        /* ---- Semantic Status ---- */
        success: {
          DEFAULT: "var(--flow-success)",
          soft: "var(--flow-success-soft)",
          border: "var(--flow-success-border)",
          text: "var(--flow-success-text)",
        },
        warning: {
          DEFAULT: "var(--flow-warning)",
          soft: "var(--flow-warning-soft)",
          border: "var(--flow-warning-border)",
          text: "var(--flow-warning-text)",
        },
        error: {
          DEFAULT: "var(--flow-error)",
          soft: "var(--flow-error-soft)",
          border: "var(--flow-error-border)",
          text: "var(--flow-error-text)",
        },
        info: {
          DEFAULT: "var(--flow-info)",
          soft: "var(--flow-info-soft)",
          border: "var(--flow-info-border)",
          text: "var(--flow-info-text)",
        },
        /* ---- Work Status Colors ---- */
        status: {
          queued: {
            DEFAULT: "var(--flow-status-queued)",
            soft: "var(--flow-status-queued-soft)",
            border: "var(--flow-status-queued-border)",
            text: "var(--flow-status-queued-text)",
          },
          active: {
            DEFAULT: "var(--flow-status-active)",
            soft: "var(--flow-status-active-soft)",
            border: "var(--flow-status-active-border)",
            text: "var(--flow-status-active-text)",
          },
          ready: {
            DEFAULT: "var(--flow-status-ready)",
            soft: "var(--flow-status-ready-soft)",
            border: "var(--flow-status-ready-border)",
            text: "var(--flow-status-ready-text)",
          },
          running: {
            DEFAULT: "var(--flow-status-running)",
            soft: "var(--flow-status-running-soft)",
            border: "var(--flow-status-running-border)",
            text: "var(--flow-status-running-text)",
          },
          review: {
            DEFAULT: "var(--flow-status-review)",
            soft: "var(--flow-status-review-soft)",
            border: "var(--flow-status-review-border)",
            text: "var(--flow-status-review-text)",
          },
          done: {
            DEFAULT: "var(--flow-status-done)",
            soft: "var(--flow-status-done-soft)",
            border: "var(--flow-status-done-border)",
            text: "var(--flow-status-done-text)",
          },
          blocked: {
            DEFAULT: "var(--flow-status-blocked)",
            soft: "var(--flow-status-blocked-soft)",
            border: "var(--flow-status-blocked-border)",
            text: "var(--flow-status-blocked-text)",
          },
          "needs-input": {
            DEFAULT: "var(--flow-status-needs-input)",
            soft: "var(--flow-status-needs-input-soft)",
            border: "var(--flow-status-needs-input-border)",
            text: "var(--flow-status-needs-input-text)",
          },
          unknown: {
            DEFAULT: "var(--flow-status-unknown)",
            soft: "var(--flow-status-unknown-soft)",
            border: "var(--flow-status-unknown-border)",
            text: "var(--flow-status-unknown-text)",
          },
          all: {
            DEFAULT: "var(--flow-status-all)",
            soft: "var(--flow-status-all-soft)",
            border: "var(--flow-status-all-border)",
            text: "var(--flow-status-all-text)",
          },
        },
      },
      fontFamily: {
        sans: ["var(--flow-font-sans)"],
        mono: ["var(--flow-font-mono)"],
      },
      spacing: {
        "flow-0": "var(--flow-space-0)",
        "flow-px": "var(--flow-space-px)",
        "flow-0.5": "var(--flow-space-0-5)",
        "flow-1": "var(--flow-space-1)",
        "flow-1.5": "var(--flow-space-1-5)",
        "flow-2": "var(--flow-space-2)",
        "flow-2.5": "var(--flow-space-2-5)",
        "flow-3": "var(--flow-space-3)",
        "flow-3.5": "var(--flow-space-3-5)",
        "flow-4": "var(--flow-space-4)",
        "flow-5": "var(--flow-space-5)",
        "flow-6": "var(--flow-space-6)",
        "flow-8": "var(--flow-space-8)",
        "flow-10": "var(--flow-space-10)",
        "flow-12": "var(--flow-space-12)",
        "flow-16": "var(--flow-space-16)",
      },
      borderRadius: {
        sm: "var(--flow-radius-sm)",
        DEFAULT: "var(--flow-radius-md)",
        md: "var(--flow-radius-md)",
        lg: "var(--flow-radius-lg)",
        xl: "var(--flow-radius-xl)",
        "2xl": "var(--flow-radius-2xl)",
      },
      boxShadow: {
        sm: "var(--flow-shadow-sm)",
        DEFAULT: "var(--flow-shadow-md)",
        md: "var(--flow-shadow-md)",
        lg: "var(--flow-shadow-lg)",
        app: "var(--flow-shadow-app)",
      },
    },
  },
} satisfies Config;
