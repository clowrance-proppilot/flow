# Cross-Platform Checks

Flow should stay portable across Linux, macOS, and Windows.

Run this matrix before a public release or after path/bootstrap changes:

- OS: Linux, macOS, Windows
- Node: 22, 24

Commands:

```bash
npm ci
npm run check
npm test
npm run build
npm run smoke:flow
npm run smoke:dashboard
```

`npm run readiness:public` is a release gate. It should pass before the repo is
made public.
