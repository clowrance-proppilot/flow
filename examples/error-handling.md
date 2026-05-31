# Flow CLI Error Handling

Flow CLI returns structured JSON errors. All responses include `ok: true` or `ok: false`.

## Error Response Structure

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "hint": "Suggestion for fixing the error",
    "details": {}
  }
}
```

## Common Error Codes

### INVALID_JSON

The request body is not valid JSON.

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_JSON",
    "message": "Unexpected token 'n', \"not valid\"... is not valid JSON"
  }
}
```

**Fix:** Ensure the request body is valid JSON.

### BAD_REQUEST

The JSON body is missing required fields or has invalid structure.

```json
{
  "ok": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "JSON body must include a non-empty string op.",
    "details": {
      "expected": { "op": "string" }
    }
  }
}
```

**Fix:** Include a non-empty `op` field in the request.

### BAD_OP

The requested operation is not supported.

```json
{
  "ok": false,
  "error": {
    "code": "BAD_OP",
    "message": "Unsupported Flow op: nonexistent",
    "details": {
      "supportedOps": ["manifest", "state", "queue", "backlog", "bootstrap", "config", "ledger", "issue", "workflow", "runtime"]
    }
  }
}
```

**Fix:** Use one of the supported operations listed in `details.supportedOps`.

### BAD_MODE

The requested mode for an operation is not supported.

```json
{
  "ok": false,
  "error": {
    "code": "BAD_MODE",
    "message": "Unsupported config mode: invalid",
    "details": {
      "op": "config",
      "mode": "invalid",
      "supportedModes": ["validate", "explain", "migrate"]
    }
  }
}
```

**Fix:** Use one of the supported modes listed in `details.supportedModes`.

### BAD_ARGS

Invalid command-line arguments.

```json
{
  "ok": false,
  "error": {
    "code": "BAD_ARGS",
    "message": "Expected at most one JSON body argument.",
    "details": {
      "expected": "flow, flow manifest, or flow '<json-body>'"
    }
  }
}
```

**Fix:** Pass at most one JSON body argument.

### RUNTIME_ERROR

An error occurred during operation execution.

```json
{
  "ok": false,
  "error": {
    "code": "RUNTIME_ERROR",
    "message": "Cannot read properties of undefined",
    "details": {
      "op": "workflow"
    }
  }
}
```

**Fix:** Check the error message and ensure all required fields are provided.

### DOCTOR_STRICT_FAILED

The doctor check failed in strict mode.

```json
{
  "ok": false,
  "error": {
    "code": "DOCTOR_STRICT_FAILED",
    "message": "Flow doctor reported error status for FLOW-123.",
    "details": {
      "issueRef": "FLOW-123",
      "status": "error",
      "blockers": 1,
      "warnings": 0,
      "nextAction": "resolve-blockers"
    }
  }
}
```

**Fix:** Address the blockers and warnings reported in the diagnosis.

## Success Response Structure

```json
{
  "ok": true,
  "op": "operation-name",
  "result": {}
}
```

## Error Handling Example

```typescript
import { execFileSync } from "node:child_process";

function callFlow(body: Record<string, unknown>): unknown {
  const stdout = execFileSync("flow", [JSON.stringify(body)], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const response = JSON.parse(stdout);
  
  if (!response.ok) {
    const error = new Error(response.error.message);
    error.code = response.error.code;
    error.details = response.error.details;
    throw error;
  }
  
  return response.result;
}

// Usage with error handling
try {
  const result = callFlow({ op: "issue", mode: "view", id: "FLOW-123" });
  console.log("Issue:", result);
} catch (error) {
  if (error.code === "BAD_MODE") {
    console.error("Invalid mode. Check manifest for supported modes.");
  } else {
    console.error("Flow error:", error.message);
  }
}
```

## Debugging Tips

1. **Check the manifest first:**
   ```bash
   flow --help
   flow '{"op":"manifest","target":"issue"}'
   ```

2. **Use explain mode for config issues:**
   ```bash
   flow '{"op":"config","mode":"explain"}'
   ```

3. **Run doctor for issue diagnostics:**
   ```bash
   flow '{"op":"workflow","mode":"doctor","id":"FLOW-123"}'
   ```

4. **Verify ledger integrity:**
   ```bash
   flow '{"op":"ledger"}'
   ```
