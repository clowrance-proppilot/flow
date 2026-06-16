# Cross-Platform Checks

Every release must pass these checks on all supported platforms and Node versions.

Release matrix:

- Linux, macOS, Windows
- Node 22 and 24

Commands:

```bash
npm ci
npm run check
npm test
npm run build
npm run smoke:flow
npm run smoke:dashboard
npm run smoke:desktop
npm run readiness:public
```

If Electron is not installed on a local machine, document the local blocker and
run the desktop smoke in CI or another environment with the Electron binary
available.
