# Contributing

Flow is early-stage local workflow infrastructure.

Before opening a pull request:

```bash
npm ci
npm run check
npm test
npm run build
```

For release checks, also run the matrix in
[`docs/cross-platform-checks.md`](docs/cross-platform-checks.md).

See [`docs/releasing.md`](docs/releasing.md) for npm release steps.

Keep host-specific behavior in `.flow/config.yaml` when possible. Reusable
runtime behavior belongs in `src/`.
