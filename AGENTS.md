# Flow Agent Instructions

- Keep Flow's durable configuration in `.flow/config.yaml`, following a Kubernetes-style declarative config model.
- Do not make environment variables the primary configuration surface for workflow topology, provider selection, executor policy, ports, ledgers, or other durable settings.
- Environment variables are acceptable for process context, local launch mechanics, and secret injection when a concrete adapter requires them, but config should remain the source of truth for behavior.
- Use command-line flags only for one-off command input, not durable settings.
- Keep SDKs, CLIs, issue trackers, code review tools, and model providers behind plugin or adapter boundaries.
