# Troubleshooting

Common problems and how to fix them.

## Flow Config

### Flow config not found

```
Flow config not found.
```

Flow needs `.flow/config.yaml` in your project root. Bootstrap one:

```bash
flow '{"op":"bootstrap"}'
```

This creates a local config with a local issue tracker and no-op collaboration.
To use GitHub-backed adapters, edit `.flow/config.yaml` after bootstrapping.

### Flow config already exists

```
Flow config already exists at /path/to/.flow/config.yaml. Pass --force to overwrite it.
```

A config already exists at that path. To replace it, pass `force`:

```bash
flow '{"op":"bootstrap","force":true}'
```

### Unsupported config version

```
Unsupported Flow config version "2".
```

Flow only supports version `"1"`. Set `version: "1"` at the top of
`.flow/config.yaml`.

### Missing required fields

```
topology.repos: At least one repo must be configured.
```

Every Flow config needs at least one repo in `topology.repos`. Minimal
example:

```yaml
version: "1"
project:
  name: "my-project"
topology:
  repos:
    main:
      name: "my-project"
```

### GitHub issue tracker missing owner or repo

```
issueTracker.owner is required when issueTracker.type is github.
issueTracker.repo is required when issueTracker.type is github.
```

When `issueTracker.type` is `github`, both `owner` and `repo` are required:

```yaml
issueTracker:
  type: "github"
  owner: "my-org"
  repo: "my-repo"
```

### Jira issue tracker missing fields

```
issueTracker.siteUrl is required when issueTracker.type is jira.
issueTracker.projectKey is required when issueTracker.type is jira.
```

When `issueTracker.type` is `jira`, both `siteUrl` and `projectKey` are
required:

```yaml
issueTracker:
  type: "jira"
  siteUrl: "https://my-org.atlassian.net"
  projectKey: "PROJ"
```

### Branch pattern missing issueRef

```
topology.branchPattern must include {issueRef}.
```

If you set `branchPattern`, it must contain `{issueRef}` so Flow can match
branches to issues:

```yaml
topology:
  branchPattern: "{kind}/{issueRef}-{slug}"
```

### PR URL pattern missing placeholders

```
topology.pullRequestUrlPattern must include {repoName}.
topology.pullRequestUrlPattern must include {number}.
```

If you set `pullRequestUrlPattern`, it must include both `{repoName}` and
`{number}`:

```yaml
topology:
  pullRequestUrlPattern: "https://github.com/my-org/{repoName}/pull/{number}"
```

### Issue inference rule references unknown repo

```
issueInference[0].repo: Issue inference rule references unknown repo "backend".
```

Each entry in `issueInference` must reference a key that exists in
`topology.repos`:

```yaml
topology:
  repos:
    backend:
      name: "backend"
  issueInference:
    - repo: backend
      keywords: ["backend", "api"]
```

## Dashboard

### Dashboard port already in use

```
Flow Dashboard port 127.0.0.1:8767 is already in use.
```

Another process is using the dashboard port. Either stop that process or
change the port in `.flow/config.yaml`:

```yaml
runtime:
  dashboard:
    port: 9000
```

### Dashboard page not found (404)

The dashboard HTML assets are missing. Rebuild them:

```bash
npm run build
```

Then restart the dashboard:

```bash
npx flow-dashboard
```

### Dashboard returns 503

The dashboard could not read the Flow state snapshot. Check that the
ledger and runtime directories exist and are readable:

```text
.flow/ledger/workflow.jsonl
.flow/ledger/issues/
.flow/runtime/
```

### Dashboard does not show my issue

The dashboard mirrors Flow's ledger. If an issue is missing:

1. Confirm the issue exists in the queue:
   ```bash
   flow '{"op":"queue"}'
   ```
2. Refresh the dashboard snapshot using the browser refresh control or
   reload the page.

## CLI

### Empty or malformed JSON output

Flow CLI always writes one JSON document to stdout. If the output looks
truncated or corrupt, check that `maxBuffer` is large enough if you are
calling Flow from another process.

### "op" is required

```
"op" is required
```

Every Flow CLI invocation needs an `op` field. Common operations:

```bash
flow '{"op":"queue"}'
flow '{"op":"manifest","target":"workflow"}'
flow '{"op":"bootstrap"}'
```

See the full manifest:

```bash
flow --help
```

## Build and Test

### TypeScript compilation fails

```bash
npm run check
```

This runs `tsc --noEmit` and the contract checks. Fix the reported errors
before building.

### Tests fail

```bash
npm test
```

This runs the CLI contract check, the dashboard read-only check, and the
unit test suite. Check the output for the specific failing assertion.

### Smoke tests fail

```bash
npm run smoke:flow
npm run smoke:dashboard
```

Smoke tests create temporary directories and run Flow end-to-end. If they
fail:

1. Confirm `npm run build` succeeded.
2. Confirm Git is installed and on `PATH`.
3. Confirm Node.js 22 or later is installed.

## Git and Worktrees

### Flow cannot find the repo root

Flow resolves the repo root from the current working directory. Make sure
you run Flow commands from inside a Git repository.

### Branch pattern does not match

If Flow cannot match a branch to an issue, check that the branch name
follows the configured `branchPattern`. The default is:

```yaml
topology:
  branchPattern: "{kind}/{issueRef}-{slug}"
```

A matching branch looks like `feature/FLOW-123-add-login`.

### Worktree preparation fails

Flow uses Git worktrees for isolated workspaces. If worktree creation
fails:

1. Confirm the branch exists.
2. Confirm the repo is clean or has no conflicting worktrees.
3. Remove stale worktrees:
   ```bash
   git worktree prune
   ```

## Adapters

### GitHub adapter errors

If the GitHub adapter fails to create or update issues:

1. Confirm `GITHUB_TOKEN` is set and has the required scopes (`repo`,
   `issues`).
2. Confirm `issueTracker.owner` and `issueTracker.repo` match the token's
   accessible repositories.

### Jira adapter errors

If the Jira adapter fails:

1. Confirm `JIRA_API_TOKEN` and `JIRA_EMAIL` are set.
2. Confirm `issueTracker.siteUrl` is reachable from your network.
3. Confirm the project key exists in your Jira site.

## Still Stuck

If the steps above do not resolve the problem:

1. Run with debug logging enabled:
   ```yaml
   runtime:
     debug: true
   ```
2. Check the error output for stack traces.
3. Open an issue at
   [github.com/camden-lowrance/flow/issues](https://github.com/camden-lowrance/flow/issues)
   with the config, command, and full error output.
