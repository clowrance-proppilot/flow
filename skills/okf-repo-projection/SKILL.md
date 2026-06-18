---
name: okf-repo-projection
description: Draft and validate thin Open Knowledge Format (OKF) knowledge projections for repositories. Use when Codex needs to generate an OKF bundle from repo docs/code, add or revise OKF concept files, keep an OKF projection aligned with canonical repo sources, or run OKF conformance validation.
---

# OKF Repo Projection

Use this skill to create a small OKF knowledge projection over a repository. The projection explains where repo truth lives; it must not become the truth itself.

Canonical spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md

## OKF v0.1 Rules

- A knowledge bundle is a directory tree of UTF-8 Markdown files.
- Every non-reserved `.md` file is a concept document.
- A concept ID is the concept file path within the bundle with the `.md` suffix removed.
- Every concept document must start with YAML frontmatter delimited by `---` lines.
- Every concept frontmatter block must contain a non-empty `type` field.
- Recommended concept frontmatter fields are `title`, `description`, `resource`, `tags`, and `timestamp`.
- Producers may add other frontmatter keys. Consumers must tolerate and preserve unknown keys.
- Type values are not centrally registered. Consumers must tolerate unknown `type` values.
- The concept body is standard Markdown. Prefer structural Markdown: headings, lists, tables, and fenced code blocks.
- Conventional body headings are `# Schema`, `# Examples`, and `# Citations` when applicable.
- `index.md` and `log.md` are reserved filenames at every directory level.
- `index.md` is a progressive-disclosure listing, not a concept document. It normally has no frontmatter.
- The root `index.md` may contain frontmatter only to declare `okf_version: "0.1"`.
- `log.md` records update history for its directory scope. Date headings must use `YYYY-MM-DD`.
- Links between concepts are normal Markdown links. Bundle-relative absolute links begin with `/`; these are preferred for stable cross-links.
- Link prose carries relationship meaning. The OKF link itself is an untyped directed relationship.
- Broken local links are tolerated by OKF consumers. Treat them as warnings, not invalid bundle errors.
- Claims sourced from external material should be backed by a `# Citations` section at the bottom of the concept.
- Citation links may be external URLs, bundle-relative paths, or references mirrored as concepts.
- A conformant bundle has parseable concept frontmatter, non-empty concept `type` fields, and reserved files that follow the reserved-file rules.

If the user asks for the latest OKF version, inspect the canonical spec before changing behavior.

## Projection Rules

- Generate the smallest useful knowledge projection.
- Do not mirror the repo's docs, issues, source files, modules, or full history.
- Do not create per-file, per-module, per-test, or per-issue concepts.
- Do not introduce durable config, workflow state, operational state, or a second control surface.
- Prefer concepts for stable repo-level contracts: architecture boundaries, source-of-truth locations, external surfaces, workflow records, adapter responsibilities, runtime ownership, release gates, and recurring agent failure points.
- Create a concept only when it helps an agent find the right owner faster or avoid a repeated wrong turn.
- When uncertain, omit the concept and mention it as a candidate in the final response.
- Keep concepts short. Prefer one purpose statement, a few precise bullets, and links to canonical sources.
- Put canonical repo file links in the concept body and use `resource` when one underlying asset is clearly the subject.
- Use `# Citations` for claims grounded in repo files, docs, issues, PRs, specs, or external sources.
- Preserve existing OKF frontmatter keys and body sections unless the user asks to rewrite them.

## Refresh Behavior

- Treat every run as a refresh pass when `.okf/` already exists.
- Read `.okf/index.md` first, then only the existing concepts needed to assess drift.
- Compare existing concept claims against canonical repo landmarks and cited source files.
- Update stale `.okf/` concepts when canonical sources have changed.
- Add only obvious missing repo-level concepts from strong landmarks.
- Remove concepts only when they clearly duplicate another concept or point to a contract that no longer exists; otherwise prefer marking uncertainty in the final response.
- Do not rewrite canonical repo docs, source files, tests, issue history, or Flow state unless the user explicitly asks. The projection follows those sources.
- Refresh the repo-local agent instruction pointer if missing or stale.

## Agent Instruction Adoption

- When creating or materially updating a repo's OKF projection, add or refresh a concise pointer in repo-local agent instruction files when they exist.
- Candidate files include `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `.cursor/rules/*`, `prompts/agents.md`, and other host-specific agent prompts.
- Update only files that directly instruct agents. If a file only delegates to another instruction file, update the delegated source instead of duplicating the note.
- Keep the note short and non-authoritative:

```md
The repo's thin OKF knowledge projection lives in `.okf/`. Use it as a navigation aid for stable repo contracts; canonical docs, code, tests, runtime state, and managed config remain the sources of truth.
```

## Workflow

1. Inspect repo landmarks with targeted reads: `README*`, `AGENTS.md`, `CONTRIBUTING*`, `docs/`, `prompts/`, package/config files, important tests, and files the user names.
2. Choose the bundle directory. Use the user's path when provided; otherwise default to `.okf/` in the repo.
3. If an OKF bundle already exists, read `index.md` first, then only the concepts relevant to the request.
4. Draft a small concept set from strong landmarks. Stop before it becomes a repo map.
5. Write or update concept files with valid frontmatter and source-backed bodies.
6. Write or update `index.md` as a concise progressive-disclosure list.
7. Add or refresh the repo-local agent instruction pointer when appropriate.
8. Run the validator:

If registered Flow MCP tools are available, prefer the MCP lifecycle surface:

```text
flow_okf_list
flow_okf_validate
flow_okf_status
flow_okf_record_disposition
```

Use the script directly when Flow MCP is unavailable or when validating outside a Flow project:

```bash
python skills/okf-repo-projection/scripts/validate_okf.py .okf
```

On Windows, use:

```powershell
python .\skills\okf-repo-projection\scripts\validate_okf.py .\.okf
```

9. Fix validator errors. Broken local links are warnings unless the user asks for stricter cleanup.
10. Report what was generated, which agent instruction files were updated or intentionally skipped, the validator result, and any intentionally omitted candidates.

## Validator

Use `scripts/validate_okf.py` for concrete OKF checks. It validates hard conformance only:

- concept frontmatter exists
- frontmatter parses with PyYAML when available, or with the bundled stdlib parser for simple OKF frontmatter
- concept `type` is non-empty
- reserved `index.md` and `log.md` rules are respected
- `log.md` date headings use `YYYY-MM-DD`
- broken local Markdown links are warnings

The validator must not enforce taste, concept count, known type names, optional fields, or link completeness.
