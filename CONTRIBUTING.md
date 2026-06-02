# Contributing

Flow is early-stage local workflow infrastructure. This guide covers how to set
up a development environment and contribute changes.

## Prerequisites

- **Node.js** 22 or 24 (LTS versions tested in CI)
- **npm** 10+
- **Git**

Verify your versions:

```bash
node --version   # v22.x or v24.x
npm --version    # 10.x+
```

## Getting Started

1. Fork and clone the repository:

   ```bash
   git clone https://github.com/<your-username>/flow.git
   cd flow
   ```

2. Install dependencies:

   ```bash
   npm ci
   ```

3. Run the full check suite to confirm your environment is working:

   ```bash
   npm run check
   npm test
   npm run build
   ```

## Project Structure

```text
.flow/config.yaml     Durable project configuration (topology, adapters, ledger)
bin/                  CLI entry points (flow, flow-dashboard)
src/                  TypeScript source
  adapters/           Issue tracker and collaboration adapters
  config/             Config loading and schema
  contracts/          JSON contract definitions
  core/               Core runtime logic
  dashboard/          Dashboard UI (React)
  engine/             Workflow engine
  executors/          Execution backends
desktop/              Electron desktop app
test/                 Test suite
test-runtime/         Runtime test fixtures
scripts/              Build, smoke, and CI scripts
docs/                 Additional documentation
extensions/           Pi agent extensions
skills/               Pi agent skills
prompts/              Pi agent prompt templates
```

## Development Workflow

### Build

Compile TypeScript and build the dashboard:

```bash
npm run build
```

Or build components individually:

```bash
npm run build:flow       # TypeScript only
npm run build:dashboard  # Dashboard UI only
```

### Type Checking

Run the full type-check and contract validation suite:

```bash
npm run check
```

This runs:
- `check:cli-contract` — validates the Flow CLI JSON contract
- `check:dashboard-readonly` — ensures the dashboard stays read-only
- `tsc --noEmit` — TypeScript type checking

### Testing

Run the test suite:

```bash
npm test
```

### Smoke Tests

Smoke tests verify end-to-end behavior of each surface:

```bash
npm run smoke:flow       # CLI smoke test
npm run smoke:dashboard  # Dashboard smoke test
npm run smoke:desktop    # Desktop app smoke test
```

### Starting Services

Run the Flow CLI and dashboard together:

```bash
npm run start:all         # Start both services
npm run start:all:watch   # Start with file watching (auto-reload)
```

Or start them individually:

```bash
npm run start      # Flow CLI only
npm run dashboard   # Dashboard only
```

## Desktop Development

The desktop app uses Electron. To develop locally:

```bash
npm run dev:desktop        # Dev mode with hot reload
npm run build:desktop      # Production build
npm run start:desktop      # Start the built desktop app
```

Package for distribution:

```bash
npm run package:desktop:win     # Windows (NSIS installer)
npm run package:desktop:mac     # macOS
npm run package:desktop:linux   # Linux (AppImage)
```

## Configuration

Flow uses `.flow/config.yaml` for durable configuration. This file controls:

- **Project topology** — repos, branch patterns, PR URLs
- **Issue tracker** — GitHub owner/repo/assignee
- **Collaboration** — GitHub integration settings
- **Source control** — Git adapter
- **Ledger** — workflow state storage

Keep host-specific behavior in `.flow/config.yaml` when possible. Reusable
runtime behavior belongs in `src/`.

Environment variables are only for process context, local launch mechanics, and
secret injection. Do not use environment variables as the primary configuration
surface for workflow topology, provider selection, or other durable settings.

## Before Opening a Pull Request

Run the full check suite:

```bash
npm ci
npm run check
npm test
npm run build
```

For faster local feedback, run TypeScript tests directly:

```bash
npm run test:fast
npm run test:fast -- test/sql-store.test.ts
```

For release checks, also run the matrix in
[`docs/cross-platform-checks.md`](docs/cross-platform-checks.md).

## Branch Naming

Use the pattern: `{kind}/{issueRef}-{slug}`

Examples:
- `feature/gh-239-expand-contributing-md`
- `fix/gh-100-dashboard-crash`
- `chore/gh-50-update-deps`

## Code Style

- **TypeScript strict mode** is enabled.
- The project uses ES modules (`"type": "module"` in package.json).
- Node.js `ES2022` target with `NodeNext` module resolution.
- Keep the dashboard read-only — it mirrors state, it does not mutate it.
- CLI output is always JSON; do not add human-readable output modes or `--json`
  toggles.

## Releasing

See [`docs/releasing.md`](docs/releasing.md) for npm release steps. Releases
are published to npm from GitHub Releases via trusted publishing (no NPM_TOKEN
secret needed).

## Questions?

Open an issue at https://github.com/camden-lowrance/flow/issues.
