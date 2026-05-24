# Host Repo Integration

Flow is a standalone workflow package. Host repos provide project-specific
configuration; Flow provides the runtime, CLI, dashboard, ledgers, and default
contracts. Agent plugins, prompts, skills, and provider adapters are optional
integration layers around that core.

The intended integration contract is:

1. Add Flow as a dependency or keep a sibling checkout.
2. Run `flow '{"op":"bootstrap"}'` at the host repo root to create hidden per-user state.
3. Run Flow from the host repo root.
4. Keep host-specific repo topology, branch policy, PR URL patterns, issue
   routing keywords, and provider choices in Flow config. Use
   `"storage":"repo-tracked"` only once the host repo is ready to share that
   config as `.flow/config.yaml`.
5. Add agent plugins or provider adapters only where the host repo needs them.

## Package Surface

The package exposes:

- `flow` and `flow-dashboard` binaries.
- `flow` module exports from `src/index.ts` after build.
- Optional agent extension, prompt, skill, and dashboard assets through the
  package files list.

For a sibling checkout:

```bash
cd /path/to/host-repo
/path/to/flow/bin/flow '{"op":"queue"}'
```

For an npm dependency in a host repo after package publication:

```bash
npm install --save-dev @camden-lowrance/flow
npx flow '{"op":"queue"}'
npx flow-dashboard
```

## Config Storage

Create the first draft from local folder and Git metadata:

```bash
cd /path/to/host-repo
/path/to/flow/bin/flow '{"op":"bootstrap"}'
```

Storage modes:

- `user`: default. Writes config, runtime, and ledger under user state outside
  the repo.
- `repo-untracked`: writes `.flow/config.yaml` in the checkout and adds
  `.flow/` to `.git/info/exclude`.
- `repo-tracked`: writes `.flow/config.yaml` for teams that are ready to share
  Flow config through git.

Or start from the generic shape:

```text
examples/.flow/config.yaml
```

For shared repo config, copy it to the host repo:

```text
/path/to/host-repo/.flow/config.yaml
```

Then update:

- `topology.repos`: repo keys, GitHub repo names, base branches, and paths from
  the host repo root.
- `topology.issueInference`: product-specific keywords that map issues to the
  right repo keys.
- `issueTracker`, `collaboration`, and `ledger`: host-specific provider details.
- `runtime.dashboard`: optional dashboard presentation overrides. Put broad UI
  styling in `.flow/dashboard.css` or point `runtime.dashboard.customCssPath` at
  another CSS file instead of expanding YAML with visual tokens.
- External worker launch belongs outside Flow. Flow emits execution handoff
  context and records structured results; host worker runtimes own launch,
  retry, scaling, provider credentials, logs, and cost.

Hosts that cannot or do not want to use hosted issue tracking or code review can
run Flow in stealth mode:

```yaml
issueTracker:
  type: "local"
  prefix: "FLOW"

collaboration:
  type: "none"

sourceControl:
  type: "git"

ledger:
  type: "flow"
```

In stealth mode, the CLI creates local issue refs and the Flow ledger is the
durable issue/workflow record. Git remains available for local branch and
worktree inspection, but no hosted code review provider is required.

When the branch already exists and the work should stay in stealth mode, use:

```bash
flow '{"op":"issue","mode":"adoptBranch","summary":"Spike checkout workflow","repoKey":"main"}'
```

That records the branch/worktree as a stealth-mode Flow item without publishing an
issue or code review. Hosted systems can be added later as checkpoint
projections.

Most hosts should not configure `workTypes` or `executors`. Flow ships
permissive defaults for prepare, implement, remediate, verify, live-thread
execution, and external execution results. The default workflow is intentionally
wide open so Flow can guide the current live agent thread instead of forcing
users to model executor capabilities up front. Treat those sections as advanced
extension points for hosts that are replacing Flow's built-in workflow
categories or result contract, not as onboarding requirements.

## Boundaries

Host repos should own configuration and let Flow manage local workflow state:

- Humans edit `.flow/config.yaml`.
- Flow writes `.flow/runtime/`.
- Flow writes `.flow/ledger/workflow.jsonl`.
- Flow writes `.flow/ledger/issues/`.
- optional host scripts that call `flow`

Flow should own reusable implementation:

- runtime and reconciliation behavior
- plugin-neutral adapter and provider contracts
- executor contracts
- dashboard
- optional skills, prompts, extensions, and guard assets

Keep the core runtime independent from any single agent SDK, model provider,
issue tracker, or code review provider. Compatibility names may remain at the
edges, but new host behavior should plug in through `.flow/config.yaml`,
provider adapters, executor adapters, or optional agent extensions.

Use `.flow/config.yaml` as the Kubernetes-style declarative configuration model
for durable Flow behavior. Environment variables are acceptable for process
context, local launch mechanics, and secret injection where an adapter needs
them, but they should not become the source of truth for workflow topology,
provider selection, worker runtime policy, ports, or ledger layout. Command-line
flags are for one-off command input only.

Avoid adding host-specific repo names or routing rules to Flow source code unless
they are part of a deliberate built-in default. Prefer `.flow/config.yaml` for
new host repo behavior.
