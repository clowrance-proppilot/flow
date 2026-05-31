#!/usr/bin/env bash
# Flow CLI Protocol Examples - Shell Commands
#
# Flow uses a JSON protocol. Each command sends one JSON body
# and receives one JSON document on stdout.

set -euo pipefail

# =============================================================================
# MANIFEST
# =============================================================================

# Get the compact manifest (also works with: flow, flow --help, flow manifest)
flow --help

# Get targeted manifest for specific operations
flow '{"op":"manifest","target":"workflow"}'
flow '{"op":"manifest","target":"issue"}'
flow '{"op":"manifest","target":"config"}'
flow '{"op":"manifest","target":"runtime"}'
flow '{"op":"manifest","target":"layout"}'

# =============================================================================
# STATE AND QUEUE
# =============================================================================

# Read current Flow state
flow '{"op":"state"}'

# Read state for a specific session
flow '{"op":"state","id":"cli"}'

# Inspect active issue queue (default limit: 10)
flow '{"op":"queue"}'

# Inspect queue with custom limit
flow '{"op":"queue","limit":20}'

# Inspect backlog
flow '{"op":"backlog"}'

# Inspect backlog with custom limit
flow '{"op":"backlog","limit":50}'

# =============================================================================
# CONFIG
# =============================================================================

# Validate Flow config
flow '{"op":"config","mode":"validate"}'

# Explain Flow config (shows parsed structure)
flow '{"op":"config","mode":"explain"}'

# Migrate config (dry run)
flow '{"op":"config","mode":"migrate"}'

# Migrate config and write changes
flow '{"op":"config","mode":"migrate","write":true}'

# =============================================================================
# BOOTSTRAP
# =============================================================================

# Bootstrap Flow config from repo metadata (default: user storage)
flow '{"op":"bootstrap"}'

# Bootstrap with repo-tracked storage
flow '{"op":"bootstrap","storage":"repo-tracked"}'

# Bootstrap with repo-untracked storage
flow '{"op":"bootstrap","storage":"repo-untracked"}'

# Force overwrite existing config
flow '{"op":"bootstrap","force":true,"storage":"repo-tracked"}'

# =============================================================================
# LEDGER
# =============================================================================

# Verify workflow ledger
flow '{"op":"ledger"}'

# Verify and rebuild projections
flow '{"op":"ledger","rebuildProjections":true}'

# =============================================================================
# ISSUE OPERATIONS
# =============================================================================

# View an issue
flow '{"op":"issue","mode":"view","id":"FLOW-123"}'

# Select an issue for work
flow '{"op":"issue","mode":"select","id":"FLOW-123"}'

# Route an issue to specific repos
flow '{"op":"issue","mode":"route","id":"FLOW-123","repoKeys":["main","api"]}'

# Create a new issue
flow '{"op":"issue","mode":"create","summary":"Fix login bug","description":"Users cannot login with SSO"}'

# Create issue with specific type and branch kind
flow '{"op":"issue","mode":"create","summary":"Add dark mode","issueType":"Task","branchKind":"feature"}'

# Adopt a branch for an issue
flow '{"op":"issue","mode":"adoptBranch","id":"FLOW-123","repoKey":"main"}'

# Adopt an existing workspace
flow '{"op":"issue","mode":"adoptWorkspace","id":"FLOW-123","repoKey":"main","worktreePath":"/path/to/worktree"}'

# =============================================================================
# WORKFLOW OPERATIONS
# =============================================================================

# Advance an issue to next state
flow '{"op":"workflow","mode":"advance","id":"FLOW-123"}'

# Audit an issue (check state and findings)
flow '{"op":"workflow","mode":"audit","id":"FLOW-123"}'

# Run autoflow (automated workflow steps)
flow '{"op":"workflow","mode":"autoflow","id":"FLOW-123"}'

# Run autoflow with step limit
flow '{"op":"workflow","mode":"autoflow","id":"FLOW-123","limit":10}'

# Diagnose an issue (doctor mode)
flow '{"op":"workflow","mode":"doctor","id":"FLOW-123"}'

# Get handoff summary
flow '{"op":"workflow","mode":"handoff","id":"FLOW-123"}'

# Record work result
flow '{"op":"workflow","mode":"recordResult","id":"FLOW-123","repoKey":"main","summary":"Fixed the bug","testsRun":["npm test"]}'

# Record pull request
flow '{"op":"workflow","mode":"recordPullRequest","id":"FLOW-123","repo":"org/repo","number":42,"url":"https://github.com/org/repo/pull/42"}'

# Record evidence
flow '{"op":"workflow","mode":"recordEvidence","id":"FLOW-123","summary":"npm test passed","criteria":["tests"]}'

# Record documentation
flow '{"op":"workflow","mode":"recordDocumentation","id":"FLOW-123","disposition":"completed","summary":"Updated API docs"}'

# Observe a flow subject
flow '{"op":"workflow","mode":"observe","id":"FLOW-123"}'

# =============================================================================
# STDIN PIPE
# =============================================================================

# You can also pipe JSON via stdin
echo '{"op":"state"}' | flow

# Or use printf for complex JSON
printf '{"op":"queue","limit":5}\n' | flow

# =============================================================================
# ERROR HANDLING
# =============================================================================

# Invalid JSON will return an error
flow 'not valid json' || true

# Missing op field
flow '{"foo":"bar"}' || true

# Unsupported op
flow '{"op":"nonexistent"}' || true

# =============================================================================
# SESSION MANAGEMENT
# =============================================================================

# All workflow operations use a session (default: "cli")
# You can specify a custom session with the id field
flow '{"op":"state","id":"my-session"}'

# Create a session explicitly
flow '{"op":"runtime","method":"createSession","params":{"id":"my-session"}}'

# =============================================================================
# RUNTIME DISPATCH
# =============================================================================

# Call raw runtime methods directly
flow '{"op":"runtime","method":"inspectQueue","params":{"limit":5}}'

flow '{"op":"runtime","method":"inspectBacklog","params":{"limit":10}}'

flow '{"op":"runtime","method":"summarizeHandoff","params":{"sessionId":"cli"}}'
