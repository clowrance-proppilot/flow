# Flow Agent Instructions

- Inspect large files with `rg` (or targeted line-range reads) before reading the whole file. Never read a file over 50 KB in full when a targeted search gives the same answer.
- Prefer `rg -n "search term" path/to/file` to find relevant locations, then read only those ranges.
- Flow test files are split by domain. When working on readiness, check `test/readiness.test.ts`. For autoflow, check `test/work-runtime-autoflow.test.ts`. For adapter/triage, check `test/adapter-triage.test.ts`.
- Work as the executor. Do not delegate implementation or review work to another agent or advisor process.
- Keep Flow's durable configuration in `.flow/config.yaml`, following a Kubernetes-style declarative config model.
- Do not make environment variables the primary configuration surface for workflow topology, provider selection, executor policy, ports, ledgers, or other durable settings.
- Environment variables are acceptable for process context, local launch mechanics, and secret injection when a concrete adapter requires them, but config should remain the source of truth for behavior.
- Use command-line flags only for one-off command input, not durable settings.
- Flow CLI stdout is always JSON; do not add human-output modes or `--json` toggles.
- Keep SDKs, CLIs, issue trackers, code review tools, and model providers behind plugin or adapter boundaries.
