import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { flowConfigSchema, FlowWorkRuntime, configToProjectTopology } from "../../src/index.js";

export const execFileAsync = promisify(execFile);

export const legacyHostConfig = flowConfigSchema.parse({
  version: "1",
  project: { name: "Legacy Host Fixture" },
  topology: {
    repos: {
      main: { name: "HostProject", baseBranch: "main" },
      web_app: { name: "web-app", baseBranch: "develop", pathFromRoot: "web-app" },
      mobile_app: { name: "mobile-app", baseBranch: "develop", pathFromRoot: "mobile-app" },
      public_api: { name: "public-api", baseBranch: "develop", pathFromRoot: "public-api" },
      app_api: { name: "app-api", baseBranch: "develop", pathFromRoot: "app-api" },
      core_database: { name: "core-database", baseBranch: "develop", pathFromRoot: "core-database" },
    },
    branchPattern: "{kind}/{issueRef}-{slug}",
    pullRequestUrlPattern: "https://github.com/ExampleOrg/{repoName}/pull/{number}",
    issueInference: [
      { repo: "main", keywords: ["flow", "workflow workRuntime", "worker executor"] },
      { repo: "web_app", keywords: ["web-app", "pwa", "frontend", "react", "vite", "browser ui"] },
      { repo: "mobile_app", keywords: ["mobile-app", "ios", "swift", "xcode", "iphone"] },
      { repo: "public_api", keywords: ["public-api", "public api", "request-export", "endpoint contract", "nx workspace"] },
      { repo: "app_api", keywords: ["app-api", "provider", "agi", "partnercloud", "partner", "celery", "controller data", "controller-data", "pixi", "flask"] },
      { repo: "core_database", keywords: ["core-database", "stored procedure", "sproc", "sql revision", "sql trigger"] },
    ],
  },
  issueTracker: { type: "jira", projectKey: "ISSUE", siteUrl: "https://example.atlassian.net" },
  collaboration: { type: "github", owner: "ExampleOrg" },
});

export const legacyHostTopology = configToProjectTopology(legacyHostConfig);

export function testWorkRuntime(options: ConstructorParameters<typeof FlowWorkRuntime>[0]): FlowWorkRuntime {
  return new FlowWorkRuntime({
    topology: legacyHostTopology,
    defaultJiraProjectKey: configString(legacyHostConfig.issueTracker, "projectKey"),
    ...options,
  });
}

export function configString(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
