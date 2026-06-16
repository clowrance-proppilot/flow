# Changelog

Flow uses release notes in GitHub Releases as the authoritative published
changelog. This file records the policy for future entries.

## Policy

- User-visible changes should be grouped by release.
- Entries should mention behavior, not internal implementation detail.
- Breaking CLI, config, adapter, or ledger changes must be called out.
- Docs-only and test-only changes may be grouped separately.

## 0.3.0

### Breaking

- `flow` is now a stdio MCP server only. It no longer accepts JSON command
  bodies through argv or stdin.
- Removed the JSON CLI parser, raw runtime-method bridge, CLI contract check,
  CLI reference, and JSON request examples.
- Removed `.flow/config.yaml` as the project configuration authoring surface.
- Agent hosts must use MCP tool discovery and call explicit `flow_*` tools.

### Added

- Added typed MCP tools for state, queue, config, ledger verification, issue
  intake/create/route/triage, workspace prepare/adopt, workflow
  advance/audit/handoff, closeout records, review, and work-job bookkeeping.
- Added project registry and per-call project scope so one Flow MCP server can
  manage multiple project roots simultaneously.
- Added Flow-managed config tools so agents bootstrap, read, and update project
  configuration through MCP instead of editing `.flow/config.yaml`.
- Added MCP reference and migration documentation.
- Added MCP contract and smoke coverage that prevents reintroducing the JSON
  command surface or a raw runtime bridge.

### Changed

- Updated getting started, handoff, troubleshooting, runtime/dashboard,
  prompts, skills, and smoke scripts to describe MCP-only usage.
- Renamed next-action projections from JSON commands to MCP tool suggestions.
- Dashboard and desktop smoke fixtures now create Flow state through MCP tools.

## Unreleased

- No unreleased changes.
