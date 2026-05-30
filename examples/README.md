# Flow CLI Protocol Examples

This directory contains examples demonstrating the Flow CLI JSON protocol.

## Quick Start

Flow CLI uses a JSON protocol where you send one JSON body and receive one JSON document on stdout.

```bash
# Get the compact manifest
flow --help

# Get targeted manifest for specific operations
flow '{"op":"manifest","target":"workflow"}'

# Read current state
flow '{"op":"state"}'

# Inspect the issue queue
flow '{"op":"queue"}'
```

## Examples

- [shell-examples.sh](./shell-examples.sh) - Common shell commands
- [json-requests.json](./json-requests.json) - Request/response examples
- [workflow-lifecycle.ts](./workflow-lifecycle.ts) - Programmatic usage
- [error-handling.md](./error-handling.md) - Error response patterns

## Protocol Rules

1. **One JSON body in, one JSON document out**
2. **Stdout is always JSON** - no `--json` flag needed
3. **Config lives in `.flow/config.yaml`** - not environment variables
4. **Work-item requests use `id`** as the public identifier

## Operations

| Operation   | Description                                      |
|-------------|--------------------------------------------------|
| `manifest`  | Get compact or targeted capability metadata       |
| `state`     | Read current Flow state, optionally scoped by id  |
| `queue`     | Inspect active issue queue                         |
| `backlog`   | Inspect backlog                                    |
| `bootstrap` | Create Flow config from repo metadata              |
| `config`    | Validate or explain Flow config                    |
| `ledger`    | Verify workflow ledger                             |
| `issue`     | Inspect, create, select, or adopt issue/workspace  |
| `workflow`  | Advance, audit, autoflow, record, or observe       |
| `runtime`   | Call a raw Work Runtime method by name             |
