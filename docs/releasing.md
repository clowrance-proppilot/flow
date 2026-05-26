# Releasing Flow

Flow publishes to npm from GitHub Releases.

## One-time npm setup

Configure npm trusted publishing for `@camden-lowrance/flow`:

- Publisher: GitHub Actions
- Organization or user: `camden-lowrance`
- Repository: `flow`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

Do not add an `NPM_TOKEN` repository secret for this workflow.

## Release steps

1. Bump `version` in `package.json` and `package-lock.json`.
2. Run:

```bash
npm ci
npm run check
npm test
npm run build
npm run readiness:public
```

3. Merge the version bump to `main`.
4. Create and publish a GitHub Release tagged `vX.Y.Z`, matching the package version.
5. GitHub Actions runs `.github/workflows/publish.yml` and publishes to npm.

The workflow fails if the release tag does not match `package.json` or if that
version is already published.
