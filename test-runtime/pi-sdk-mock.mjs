import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const statePath = globalThis.flowSmokeStatePath;
let activePrompts = 0;
let maxActivePrompts = 0;

function record(data) {
  if (!statePath) return;
  const current = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  writeFileSync(statePath, JSON.stringify({ ...current, ...data }, null, 2));
}

function appendRecord(key, value) {
  if (!statePath) return;
  const current = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const values = Array.isArray(current[key]) ? current[key] : [];
  writeFileSync(statePath, JSON.stringify({ ...current, [key]: [...values, value] }, null, 2));
}

export const AuthStorage = {
  create() {
    return {};
  },
};

export const ModelRegistry = {
  create() {
    return {
      find(provider, modelId) {
        return { provider, modelId };
      },
    };
  },
};

export class DefaultResourceLoader {
  constructor(options) {
    this.options = options;
    record({ loaderOptions: options });
  }

  async reload() {}
}

export const SessionManager = {
  inMemory() {
    return { kind: 'in-memory' };
  },
  create(cwd) {
    return { kind: 'file', cwd };
  },
  open(path, sessionDir, cwdOverride) {
    return { kind: 'open', path, sessionDir, cwdOverride };
  },
};

export async function createAgentSession(options) {
  record({ sessionOptions: options });
  appendRecord('sessionOptionsLog', options);
  const listeners = new Set();
  return {
    session: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt(promptText) {
        activePrompts += 1;
        maxActivePrompts = Math.max(maxActivePrompts, activePrompts);
        record({ activePrompts, maxActivePrompts });
        if (String(promptText).includes('DELAY')) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        for (const listener of listeners) {
          listener({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              delta: "OK",
            },
          });
        }
        activePrompts -= 1;
        record({ activePrompts, maxActivePrompts });
      },
      dispose() {},
    },
  };
}
