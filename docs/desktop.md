# Desktop Notes

The desktop/dashboard surface is the human control room for Flow projects. It
shows active projects, issue queues, status, handoff prompts, chat state, and
Autoflow health.

## Start

```bash
npm run dev:desktop
```

For the packaged dashboard server:

```bash
npx flow-dashboard
```

Default URL:

```text
http://127.0.0.1:8767/dashboard
```

Configure host and port in `.flow/config.yaml`:

```yaml
runtime:
  dashboard:
    host: "127.0.0.1"
    port: 8767
```

## Project Model

Desktop reads Flow project records and each project's `.flow/config.yaml`.
Durable project behavior comes from config. Local UI state, runtime sessions,
and refresh state stay in runtime storage.

## Mutations

The dashboard view is read-oriented, but the desktop app can call Flow action
routes for project and issue operations. Destructive actions should require a
confirmation dialog and must not delete repository files unless the user
explicitly requests that behavior.

## Verification

```bash
npm run check
npm run build:dashboard
npm run build:desktop:renderer
npm run smoke:dashboard
```

Use browser or desktop smoke testing for visual layout, keyboard behavior, and
project selection changes.
