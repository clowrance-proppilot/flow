# Flow Design System

Flow shared UI tokens live in `src/theme/tokens.css` and are exposed to Tailwind through `tailwind.config.ts`.

## Surfaces

- Dashboard imports tokens from `src/dashboard/styles.css`.
- Desktop imports tokens from `desktop/renderer/styles.css`.
- Legacy `--th-*` names are aliases in `src/theme/tokens.css`; new CSS should prefer `--flow-*`.

## Token Groups

- Color: brand, surface, border, text, semantic, and work-status tokens.
- Typography: `--flow-font-sans` and `--flow-font-mono`.
- Spacing: `--flow-space-*`, exposed as `flow-*` Tailwind spacing keys.
- Radius: `--flow-radius-*`, exposed through Tailwind radius keys.
- Shadow: `--flow-shadow-*`, exposed through Tailwind shadow keys.

## Usage

Use Tailwind token names for component layout where possible:

```tsx
<div className="rounded-lg bg-surface-card p-flow-4 text-fg">
  ...
</div>
```

Use CSS variables for shared CSS files and status theme helpers:

```css
.status-pill {
  border-color: var(--flow-status-ready-border);
  background: var(--flow-status-ready-soft);
  color: var(--flow-status-ready-text);
}
```

Avoid adding one-off color, spacing, radius, or shadow values unless the token set cannot represent the need.
