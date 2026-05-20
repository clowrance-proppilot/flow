# Host Repo Integration

Flow is a standalone workflow package. Host repos provide project-specific
configuration; Flow provides the runtime, CLI, dashboard, ledgers, prompts,
skills, and default adapters.

The intended integration contract is:

1. Add Flow as a dependency or keep a sibling checkout.
2. Add `flow.config.yaml` at the host repo root.
3. Run Flow from the host repo root, or set `FLOW_PROJECT_ROOT`.
4. Keep host-specific repo topology, branch policy, PR URL patterns, issue
   routing keywords, work types, and executors in `flow.config.yaml`.

## Package Surface

The package exposes:

- `flow` and `flow-dashboard` binaries.
- `flow` module exports from `src/index.ts` after build.
- Codex/Pi extension, prompt, skill, hook, and dashboard assets through the
  package files list.

For a sibling checkout:

```bash
FLOW_PROJECT_ROOT=/path/to/host-repo /path/to/flow/bin/flow queue
```

For an npm dependency in a host repo:

```bash
npm install --save-dev ../flow
npx flow queue
npx flow-dashboard
```

## Host-Owned Config

The consuming architecture owns the real `flow.config.yaml`. Start from the
generic shape:

```text
examples/flow.config.yaml
```

Copy it to the host repo:

```text
/path/to/host-repo/flow.config.yaml
```

Then update:

- `topology.repos`: repo keys, GitHub repo names, base branches, and paths from
  the host repo root.
- `topology.issueInference`: product-specific keywords that map issues to the
  right repo keys.
- `issueTracker`, `collaboration`, and `ledger`: host-specific provider details.
- `workTypes` and `executors`: executor names and capabilities available for
  that host architecture.

## Boundaries

Host repos should own configuration and local state only:

- `flow.config.yaml`
- `.context/flow/`
- optional host scripts that call `flow`

Flow should own reusable implementation:

- runtime and reconciliation behavior
- adapters and provider contracts
- executor contracts
- dashboard
- skills, prompts, hooks, and guard assets

Avoid adding host-specific repo names or routing rules to Flow source code unless
they are part of a deliberate built-in default. Prefer `flow.config.yaml` for
new host repo behavior.
