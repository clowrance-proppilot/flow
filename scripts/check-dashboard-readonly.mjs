#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const flowRoot = join(fileURLToPath(new URL("..", import.meta.url)));
const files = [
  "bin/flow-dashboard",
  "src/dashboard-server.ts",
  "src/dashboard-state.ts",
  "src/dashboard-labels.ts",
  "src/work-runtime.ts",
  "src/dashboard/index.html",
  "src/dashboard/main.tsx",
  "src/dashboard/styles.css",
  "scripts/smoke-dashboard.mjs",
].map((path) => [path, readFileSync(join(flowRoot, path), "utf8")]);

const violations = [];

checkAbsent("src/dashboard-server.ts", /\bapp\.(post|put|patch|delete)\s*\(/, "Dashboard server must not expose mutation routes.");
checkAbsent("src/dashboard-server.ts", /\/api\/actions\b/, "Dashboard server must not expose action endpoints.");
checkAbsent("src/dashboard-server.ts", /\/api\/events\b/, "Dashboard server must not expose event endpoints.");
checkAbsent("src/dashboard-server.ts", /\/dashboard\/custom\.css\b|\/dashboard\/custom-assets\b|customCssPath|resolveThemeConfig|themeConfig|ui:\s*themeConfig/, "Dashboard server must not expose mutable custom UI surfaces.");
checkAbsent("bin/flow-dashboard", /customCssPath|defaultThemeId|defaultMode|themes/, "Dashboard help must not advertise mutable UI configuration.");
checkAbsent("bin/flow-dashboard", /entry\.includes\(join\(["']dist["'],\s*["']bin["']\)\)\s*return false|entry\.includes\(join\(["']dist["'],\s*["']dashboard["']\)\)\s*return false/, "Dashboard launcher must rebuild stale dist assets instead of trusting existing output.");
checkAbsent("src/dashboard-server.ts", /\bhealth:\s*healthPayload\b|function healthPayload[\s\S]*\b(?:repoRoot|pid:\s*process\.pid|uptimeSeconds|startedAt)\b/, "Dashboard API must not expose host runtime details.");
checkAbsent("src/dashboard-server.ts", /function healthPayload[\s\S]*\b(?:role|refreshing)\s*:/, "Dashboard health endpoint should only expose basic liveness.");
checkAbsent("src/dashboard-server.ts", /json\(\{\s*ok:\s*false,\s*error\s*:/, "Dashboard API errors must not expose error detail fields.");
checkAbsent("src/dashboard-server.ts", /\bexpress\.json\s*\(/, "Dashboard server must not parse request bodies.");
checkAbsent("src/dashboard-server.ts", /\breq\.(?:query|body|params)\b/, "Dashboard server must not let request input shape mirror state.");
checkAbsent("src/dashboard-server.ts", /\bFlowEventStream\b/, "Dashboard server must not stream action events.");
checkRequired("src/dashboard-server.ts", /Cache-Control["'],\s*["']no-store/, "Dashboard mirror responses must disable caching.");
checkRequired("src/dashboard-server.ts", /function setMirrorHeaders/, "Dashboard server must use one mirror header policy for every route.");
checkRequired("src/dashboard-server.ts", /app\.use\(\(_req,\s*res,\s*next\)\s*=>\s*\{\s*setMirrorHeaders\(res\);[\s\S]*?next\(\);[\s\S]*?\}\)/, "Dashboard server must apply mirror headers before all routes.");
checkRequired("src/dashboard-server.ts", /if \(req\.method === ["']GET["'] \|\| req\.method === ["']HEAD["']\)[\s\S]*?res\.status\(404\)\.json\(\{\s*ok:\s*false\s*\}\)/, "Dashboard server must explicitly reject non-read methods with ok:false.");
checkAbsent("src/dashboard-server.ts", /\bres\.redirect\(/, "Dashboard server must serve the mirror shell directly instead of exposing redirect bodies.");
checkRequired("src/dashboard-server.ts", /app\.get\(["']\/["'], \(_req, res\) => sendDashboardHtml\(res\)\)/, "Dashboard root must serve the same mirror shell as /dashboard.");
checkRequired("src/dashboard-server.ts", /function sendDashboardHtml\(res: Response\): void[\s\S]*?res\.status\(404\)\.json\(\{\s*ok:\s*false\s*\}\)/, "Dashboard shell failures must expose only ok:false.");
checkRequired("src/dashboard-server.ts", /Content-Security-Policy/, "Dashboard mirror responses must include a content security policy.");
for (const directive of ["default-src 'none'", "connect-src 'self'", "form-action 'none'", "frame-ancestors 'none'", "script-src 'self'", "style-src 'self'"]) {
  checkRequired("src/dashboard-server.ts", new RegExp(escapeRegExp(directive)), `Dashboard CSP must include ${directive}.`);
}
for (const directive of ["frame-src 'none'", "manifest-src 'none'", "object-src 'none'", "worker-src 'none'"]) {
  checkRequired("src/dashboard-server.ts", new RegExp(escapeRegExp(directive)), `Dashboard CSP must include ${directive}.`);
}
checkAbsent("src/dashboard-server.ts", /unsafe-inline|unsafe-eval/, "Dashboard CSP must not allow inline or eval code.");
checkRequired("src/dashboard-server.ts", /Cross-Origin-Opener-Policy["'],\s*["']same-origin/, "Dashboard mirror responses must isolate opener context.");
checkRequired("src/dashboard-server.ts", /Cross-Origin-Resource-Policy["'],\s*["']same-origin/, "Dashboard mirror responses must restrict cross-origin resource use.");
checkRequired("src/dashboard-server.ts", /Origin-Agent-Cluster["'],\s*["']\?1/, "Dashboard mirror responses must request origin agent clustering.");
checkRequired("src/dashboard-server.ts", /Referrer-Policy["'],\s*["']no-referrer/, "Dashboard mirror responses must not send referrers.");
checkRequired("src/dashboard-server.ts", /Permissions-Policy/, "Dashboard mirror responses must include a browser permissions policy.");
for (const directive of ["camera=()", "microphone=()", "geolocation=()", "payment=()", "usb=()", "serial=()", "hid=()", "bluetooth=()", "clipboard-read=()", "clipboard-write=(self)", "display-capture=()", "fullscreen=()", "web-share=()"]) {
  checkRequired("src/dashboard-server.ts", new RegExp(escapeRegExp(directive)), `Dashboard permissions policy must include ${directive}.`);
}
checkRequired("src/dashboard-server.ts", /X-Content-Type-Options["'],\s*["']nosniff/, "Dashboard mirror responses must disable content sniffing.");
checkRequired("src/dashboard-server.ts", /X-DNS-Prefetch-Control["'],\s*["']off/, "Dashboard mirror responses must disable DNS prefetch.");
checkRequired("src/dashboard-server.ts", /X-Frame-Options["'],\s*["']DENY/, "Dashboard mirror responses must deny framing.");
checkRequired("src/dashboard-server.ts", /express\.static\(dashboardAssetsPath,\s*\{\s*setHeaders:\s*setNoStore\s*\}\)/, "Dashboard assets must disable caching so stale command bundles cannot linger.");
checkRequired("src/dashboard-server.ts", /app\.use\(\(_req,\s*res\)\s*=>\s*\{\s*res\.status\(404\)\.json\(\{\s*ok:\s*false\s*\}\);[\s\S]*?\}\)/, "Dashboard server must own 404 responses so missing routes keep mirror headers.");
checkAbsent("src/dashboard-state.ts", /\bruntimeAction\s*\(/, "Dashboard state must not expose runtime mutation helpers.");
checkAbsent("src/dashboard-state.ts", /\bexport\s+async\s+function\s+callFlowCli\b/, "Dashboard Flow CLI bridge must stay private to the read-only state module.");
checkAbsent("src/dashboard-state.ts", /autoflow/i, "Dashboard API must not expose Autoflow orchestration fields.");
checkAbsent("src/dashboard-state.ts", /degraded|degradedError|refreshing:|stale:|source:/, "Dashboard API should expose only snapshot freshness and issue mirror data.");
checkAbsent("src/dashboard-state.ts", /\bisRefreshing\b|startRefreshDaemon|stopRefreshDaemon/, "Dashboard state should not expose unused daemon or refresh status surfaces.");
checkAbsent("src/dashboard-state.ts", /snapshot:\s*\{[\s\S]*(?:refreshedAt:\s*snapshot\.refreshedAt|ageSeconds)/, "Dashboard API must expose display snapshot freshness labels, not raw freshness fields.");
checkAbsent("src/dashboard-state.ts", /\bworktreePath\b/, "Dashboard API must not expose local worktree paths.");
checkAbsent("src/dashboard-state.ts", /\bheadSha\b/, "Dashboard API must not expose raw commit heads.");
checkAbsent("src/dashboard-state.ts", /assignString\(summary,\s*["']branch["']|summary\.branch\b/, "Dashboard API must not expose source-control branch details.");
checkAbsent("src/dashboard-state.ts", /\brepoKeys,|summary\.repoKeys\b/, "Dashboard API must expose repository labels, not raw repoKeys fields.");
checkAbsent("src/dashboard-state.ts", /assignString\(summary,\s*["']issueStatus["']|summary\.issueStatus\b/, "Dashboard API must expose display status labels, not raw issueStatus fields.");
checkAbsent("src/dashboard-state.ts", /assignString\(summary,\s*["']updatedAt["']|summary\.updatedAt\b/, "Dashboard API must expose display update labels, not raw per-issue timestamps.");
checkAbsent("src/dashboard-state.ts", /assignString\(summary,\s*["'](?:issueUrl|prUrl)["']|summary\.(?:issueUrl|prUrl|issueLinkStatus|prLinkStatus)\b/, "Dashboard API must not expose external URLs or non-actionable link presence fields.");
checkAbsent("src/dashboard-state.ts", /const blockers = Array\.isArray\(issue\.blockers\) \? issue\.blockers\.map\(String\) : \[\];/, "Dashboard API must label blockers before exposing them.");
checkAbsent("src/dashboard-state.ts", /\bblockers,|summary\.blockers\b/, "Dashboard API must expose blocker display labels, not raw blocker fields.");
checkAbsent("src/dashboard-state.ts", /assignString\(summary,\s*["']workflowState["']|summary\.workflowState/, "Dashboard API must expose display work status labels, not raw workflow state keys.");
checkAbsent("src/dashboard-state.ts", /\bworkflowState\b|\bready_to_run\b|\bawaiting_review\b|\bawaiting_human\b|\bselected\b/, "Dashboard state must consume display work status labels, not raw workflow state keys.");
checkRequired("src/dashboard-state.ts", /normalizeWorkStatusLabel\(issue\.workStatus\)/, "Dashboard API must normalize workStatus through the shared display-label allowlist.");
checkRequired("src/dashboard-state.ts", /normalizeRecordStatusLabel\(issue\.evidenceStatus\)/, "Dashboard API must normalize evidence status through the shared display-label allowlist.");
checkRequired("src/dashboard-state.ts", /normalizeRecordStatusLabel\(issue\.documentationStatus\)/, "Dashboard API must normalize documentation status through the shared display-label allowlist.");
checkAbsent("src/dashboard-state.ts", /\b(?:evidenceRecorded|documentationRecorded):/, "Dashboard API must expose display record status labels, not raw record booleans.");
checkAbsent("src/dashboard-state.ts", /summary\.(?:prIsDraft|prChecksPassing|prReviewDecision|humanReviewRequired)|assignString\(summary,\s*["']prReviewDecision["']/, "Dashboard API must expose display PR and review labels, not raw provider PR fields.");
checkDashboardLabelContract();
checkDashboardStatePublicContract();
checkDashboardQueueContract();
checkDashboardRuntimeMethods("src/dashboard-state.ts", ["inspectDashboardQueue"]);
checkDashboardSmokeContract();
checkAbsent("src/dashboard/main.tsx", /\bEventSource\b/, "Dashboard UI must not subscribe to command event streams.");
checkAbsent("src/dashboard/main.tsx", /\/api\/actions\b/, "Dashboard UI must not call action endpoints.");
checkAbsent("src/dashboard/main.tsx", /\bmethod\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/, "Dashboard UI must not issue mutation requests.");
checkAbsent("src/dashboard/main.tsx", /\bSettings2\b|settings-menu|aria-label=["']Settings["']/, "Dashboard UI must not expose non-state settings controls.");
checkAbsent("src/dashboard/main.tsx", /onRefresh|Reload dashboard snapshot|["'>(](?:Advance|Autoflow|Prepare Workspace|Run Flow|Command|Reload)["'<)]/, "Dashboard UI must not expose command-like labels or mutation controls.");
checkAbsent("src/dashboard/main.tsx", /Open Issue|Open PR|No Issue Link|No PR/, "Dashboard links should not use command-shaped labels.");
checkAbsent("src/dashboard/main.tsx", /\bExternalButton\b|\bDisabledButton\b/, "Dashboard links must render as mirror metadata, not button-like controls.");
checkAbsent("src/dashboard/main.tsx", /\bExternalLink\b|target=["']_blank["']|href=\{issue\.(?:issueUrl|prUrl)\}|href=\{href\}/, "Dashboard UI must not expose external navigation controls.");
checkAbsent("src/dashboard/main.tsx", /selected:\s*["'](?:Selected|In Flow)["']|Flow State|Flow Stage|No issue selected|accent-selected/, "Dashboard UI should use clear work status labels instead of raw workflow wording.");
checkAbsent("src/dashboard/main.tsx", /Flow stage|Flow Stage/, "Dashboard tooltips and headings should use work status wording.");
checkAbsent("src/dashboard/main.tsx", /\bworkflowState\b|ready_to_run|awaiting_review|awaiting_human/, "Dashboard UI should consume display work status labels, not raw workflow state keys.");
checkAbsent("src/dashboard/main.tsx", /\.split\(["']_["']\)|slice\(0,\s*1\).*toUpperCase/, "Dashboard UI must not derive visible labels from raw workflow state names.");
checkAbsent("src/dashboard/main.tsx", /["']Live["']/, "Dashboard status should describe snapshots, not a live stream.");
checkAbsent("src/dashboard/main.tsx", /Flow CLI|reconciliation|Flow runtime/, "Dashboard UI copy must not expose implementation-specific runtime wording.");
checkAbsent("src/dashboard/main.tsx", /No issue tracker status/, "Dashboard UI copy should avoid adapter-specific status wording.");
checkAbsent("src/dashboard/main.tsx", /\bapplyThemeToDOM\b|\bdefaultThemes\b|\bresolveTheme\b|\/dashboard\/custom\.css/, "Dashboard UI must use the built-in presentation only.");
checkAbsent("src/dashboard/main.tsx", /data-theme|themed-scroll|\[data-theme=/, "Dashboard UI must not keep mutable theme hooks.");
checkAbsent("src/dashboard/main.tsx", /autoflow/i, "Dashboard UI must not expose Autoflow orchestration fields.");
checkAbsent("src/dashboard/main.tsx", /statusMessage|degraded|degradedError|refreshing\?:|stale\?:|source\?:/, "Dashboard UI must not consume unused runtime status wrapper fields.");
checkAbsent("src/dashboard/main.tsx", /\berror\?:\s*string|payload\.error/, "Dashboard UI must not consume dashboard API error strings.");
checkAbsent("src/dashboard/main.tsx", /\brefreshedAt\b|\bageSeconds\b|toLocaleTimeString|new Date\(/, "Dashboard UI should consume display snapshot freshness labels, not raw snapshot freshness fields.");
checkAbsent("src/dashboard/main.tsx", /\b(?:evidenceRecorded|documentationRecorded)\b/, "Dashboard UI should consume display record status labels, not raw record booleans.");
checkAbsent("src/dashboard/main.tsx", /\b(?:prIsDraft|prChecksPassing|prReviewDecision|humanReviewRequired)\b/, "Dashboard UI should consume display PR and review labels, not raw provider PR fields.");
checkAbsent("src/dashboard/main.tsx", /\bworktreePath\b|Worktree/, "Dashboard UI must not expose local worktree paths.");
checkAbsent("src/dashboard/main.tsx", /\bheadSha\b|\bshortSha\b|>\s*Head\s*</, "Dashboard UI must not expose raw commit heads.");
checkAbsent("src/dashboard/main.tsx", /\bissue\.branch\b|>\s*Branch\s*</, "Dashboard UI must not expose source-control branch details.");
checkAbsent("src/dashboard/main.tsx", /\brepoKeys\b/, "Dashboard UI should consume repository labels, not raw repoKeys fields.");
checkAbsent("src/dashboard/main.tsx", /\bissueStatus\b/, "Dashboard UI should consume display status labels, not raw issueStatus fields.");
checkAbsent("src/dashboard/main.tsx", /\bupdatedAt\b|\brelativeTime\b/, "Dashboard UI should consume display update labels, not raw per-issue timestamps.");
checkAbsent("src/dashboard/main.tsx", /\b(?:issueUrl|prUrl|issueLinkStatus|prLinkStatus|LinkPresence|linkStatusLabel)\b/, "Dashboard UI must not expose external URLs or non-actionable link presence fields.");
checkAbsent("src/dashboard/main.tsx", /\bactiveState\b|\bactiveStage\b|\bstateCounts\b|\bstageCounts\b|\bonStateChange\b|\bonStageChange\b|\bStateFilter\b|\bStageFilter\b/, "Dashboard status filters must be keyed by visible labels, not raw workflow states.");
checkAbsent("src/dashboard/main.tsx", /const state = flowState\(issue\);\s*counts\[state\]|\bflowState\(/, "Dashboard status counts must use visible labels, not raw workflow state names.");
checkAbsent("src/dashboard/main.tsx", /setActiveRef[\s\S]*nextIssues\[0\]\?\.ref/, "Dashboard initial focus should prefer the active Flow issue, not the first queue item.");
checkAbsent("src/dashboard/main.tsx", /<DetailSection title=["']Work Status["']>[\s\S]*workflowStatusLabel\(workflowStatusKey\(issue\)\)[\s\S]*<WorkflowTrack statusKey=\{issue\.workflowState\} size=["']md["'] \/>/, "Dashboard detail status should not render duplicate visible status labels.");
checkAbsent("src/dashboard/main.tsx", /function matchesQuery[\s\S]*issue\.workflowState/, "Dashboard search must use visible stage labels, not raw workflow state names.");
checkAbsent("src/dashboard/main.tsx", /function matchesQuery[\s\S]*issue\.(?:issueUrl|prUrl)/, "Dashboard search must not index hidden link URLs.");
checkAbsent("src/dashboard/main.tsx", /\{issue\.prReviewDecision\s*\|\|/, "Dashboard UI must label review decisions instead of rendering raw provider values.");
checkAbsent("src/dashboard/main.tsx", /checks passing|checks failing/, "Dashboard UI must label PR check state with display wording.");
checkAbsent("src/dashboard/main.tsx", />\s*\{blocker\}\s*</, "Dashboard UI must label blockers instead of rendering raw blocker text directly.");
checkAbsent("src/dashboard/main.tsx", /function matchesQuery[\s\S]*\?\s*issue\.blockers\s*:\s*\[\]/, "Dashboard search must use visible blocker labels, not raw blocker text.");
checkAbsent("src/dashboard/main.tsx", /\bissue\.blockers\b|\bblockerLabel\b/, "Dashboard UI should consume blocker display labels, not raw blocker fields.");
checkAbsent("src/dashboard/main.tsx", /issue\.(?:evidenceRecorded|documentationRecorded)\s*\?\s*["']recorded["']\s*:\s*["']missing["']/, "Dashboard UI must label record booleans as dashboard status, not raw recorded/missing wording.");
checkAbsent("src/dashboard/main.tsx", /No blockers recorded/, "Dashboard blocker empty state should be concise mirror wording.");
checkAbsent("src/dashboard/index.html", /%2364a844|viewBox='0 0 35 46'/, "Dashboard favicon must use the current flow mark.");
checkAbsent("src/dashboard/index.html", /<a\b|<button\b|<form\b|\bon[a-z]+\s*=|\btarget\s*=\s*["']_blank["']|\bdownload\s*=/i, "Dashboard HTML shell must not expose controls before React loads.");
checkAbsent("src/dashboard/styles.css", /data-theme|themed-scroll|color-scheme:\s*light/, "Dashboard CSS must keep a single fixed navy mirror presentation.");
checkDashboardClientPublicContract();
checkDashboardFetches("src/dashboard/main.tsx", ["/api/dashboard"]);
checkDashboardBrowserIsolation("src/dashboard/main.tsx");
checkDashboardMirrorControls("src/dashboard/main.tsx", ["copy-handoff-prompt", "issue-focus", "refresh-snapshot", "search-filter", "status-filter"]);

if (violations.length > 0) {
  console.error("Flow dashboard read-only contract check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("dashboard readonly contract: ok");

function checkAbsent(path, pattern, message) {
  const source = files.find(([candidate]) => candidate === path)?.[1] ?? "";
  if (pattern.test(source)) violations.push(message);
}

function checkRequired(path, pattern, message) {
  const source = files.find(([candidate]) => candidate === path)?.[1] ?? "";
  if (!pattern.test(source)) violations.push(message);
}

function checkDashboardFetches(path, allowedPrefixes) {
  const source = files.find(([candidate]) => candidate === path)?.[1] ?? "";
  const fetchCalls = source.match(/\bfetch\s*\(/g) ?? [];
  const literalFetches = [
    ...[...source.matchAll(/\bfetch\s*\(\s*`([^`]+)`/g)].map((match) => match[1]),
    ...[...source.matchAll(/\bfetch\s*\(\s*(["'])([^"']+)\1/g)].map((match) => match[2]),
  ];
  if (fetchCalls.length !== literalFetches.length) {
    violations.push("Dashboard UI fetch targets must be literal read-only endpoints.");
    return;
  }
  for (const target of literalFetches) {
    if (!allowedPrefixes.includes(target)) {
      violations.push(`Dashboard UI must only fetch ${allowedPrefixes.join(", ")}; found ${target}.`);
    }
  }
}

function checkDashboardClientPublicContract() {
  checkRequired("src/dashboard/main.tsx", /function normalizeDashboardIssue/, "Dashboard UI must normalize fetched issues through a display-field allowlist.");
  checkRequired("src/dashboard/main.tsx", /payload\.issues\)\s*\?\s*payload\.issues\.map\(normalizeDashboardIssue\)/, "Dashboard UI must not trust raw fetched issues directly.");
  checkRequired("src/dashboard/main.tsx", /normalizeWorkStatusLabel/, "Dashboard UI must use the shared visible work status label allowlist.");
  checkRequired("src/dashboard/main.tsx", /function normalizeWorkStatus/, "Dashboard UI must normalize work status labels before rendering.");
  checkRequired("src/dashboard/main.tsx", /issue\.workStatus = normalizeWorkStatus\(input\.workStatus\)/, "Dashboard UI must not copy raw work status strings directly.");
  checkRequired("src/dashboard/main.tsx", /normalizeRecordStatusLabel/, "Dashboard UI must use the shared record status label allowlist.");
  checkRequired("src/dashboard/main.tsx", /function normalizeRecordStatus/, "Dashboard UI must normalize evidence and documentation status labels before rendering.");
  checkRequired("src/dashboard/main.tsx", /issue\.evidenceStatus = normalizeRecordStatus\(input\.evidenceStatus\)/, "Dashboard UI must not copy raw evidence status strings directly.");
  checkRequired("src/dashboard/main.tsx", /issue\.documentationStatus = normalizeRecordStatus\(input\.documentationStatus\)/, "Dashboard UI must not copy raw documentation status strings directly.");
  checkAbsent("src/dashboard/main.tsx", /assignDisplayString\(issue,\s*["'](?:workStatus|evidenceStatus|documentationStatus)["']/, "Dashboard UI must not copy guarded display status fields with generic string assignment.");
  checkAbsent("src/dashboard/main.tsx", /return issue\.workStatus \|\| ["']Unknown["']/, "Dashboard UI must render normalized work status labels.");
  checkAbsent("src/dashboard/main.tsx", /return status \|\| ["']Needed["']/, "Dashboard UI must render normalized record status labels.");
  for (const rawField of ["workflowState", "issueUrl", "prUrl", "repoKeys", "worktreePath", "headSha", "prIsDraft", "prChecksPassing", "prReviewDecision", "humanReviewRequired", "evidenceRecorded", "documentationRecorded"]) {
    if (new RegExp(`\\b${rawField}\\b`).test(files.find(([candidate]) => candidate === "src/dashboard/main.tsx")?.[1] ?? "")) {
      violations.push(`Dashboard UI normalizer must not expose raw field ${rawField}.`);
    }
  }
}

function checkDashboardLabelContract() {
  checkRequired("src/dashboard-labels.ts", /export const workStatusSteps = \["Queued", "Active", "Ready", "Running", "In Review", "Done"\] as const;/, "Dashboard shared labels must define the normal display work status sequence.");
  checkRequired("src/dashboard-labels.ts", /export const exceptionalWorkStatusLabels = \["Blocked", "Needs Input"\] as const;/, "Dashboard shared labels must define exceptional display work status labels.");
  checkRequired("src/dashboard-labels.ts", /export function normalizeWorkStatusLabel/, "Dashboard shared labels must expose work status normalization.");
  checkRequired("src/dashboard-labels.ts", /export function normalizeRecordStatusLabel/, "Dashboard shared labels must expose record status normalization.");
  checkRequired("src/dashboard-labels.ts", /return typeof value === ["']string["'] && allowedWorkStatusLabels\.has\(value\) \? value : ["']Unknown["'];/, "Dashboard shared labels must map unknown work status values to Unknown.");
  checkRequired("src/dashboard-labels.ts", /return typeof value === ["']string["'] && allowedRecordStatusLabels\.has\(value\) \? value : ["']Needed["'];/, "Dashboard shared labels must map unknown record status values to Needed.");
  checkAbsent("src/dashboard-labels.ts", /\bselected\b|\bready_to_run\b|\bawaiting_review\b|\bawaiting_human\b|\bworkflowState\b/, "Dashboard shared labels must not include raw workflow state keys.");
}

function checkDashboardBrowserIsolation(path) {
  const source = files.find(([candidate]) => candidate === path)?.[1] ?? "";
  const forbidden = [
    [/\blocalStorage\b/, "localStorage"],
    [/\bsessionStorage\b/, "sessionStorage"],
    [/\bindexedDB\b/, "indexedDB"],
    [/\bdocument\.cookie\b/, "document.cookie"],
    [/\bnavigator\.sendBeacon\b|\bsendBeacon\b/, "sendBeacon"],
    [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
    [/\bWebSocket\b/, "WebSocket"],
    [/\bBroadcastChannel\b/, "BroadcastChannel"],
    [/\bSharedWorker\b/, "SharedWorker"],
    [/\bserviceWorker\b/, "serviceWorker"],
    [/\bNotification\b/, "Notification"],
    [/\bnavigator\.clipboard\.(?:read|readText)\b|\bclipboard-read\b/, "clipboard read"],
    [/\bwindow\.open\b/, "window.open"],
    [/\blocation\.(?:assign|replace|href)\b/, "location navigation"],
    [/\bhistory\.(?:pushState|replaceState)\b/, "history navigation"],
    [/\bpostMessage\b/, "postMessage"],
    [/\bFormData\b/, "FormData"],
    [/<form\b/i, "form"],
    [/\bsubmit\s*\(/, "submit"],
    [/\bdownload\s*=/, "download"],
    [/\btarget\s*=\s*["']_blank["']/, "new-window target"],
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(source)) {
      violations.push(`Dashboard UI must stay a passive mirror and not use browser ${label} APIs.`);
    }
  }
}

function checkDashboardMirrorControls(path, allowedControls) {
  const source = files.find(([candidate]) => candidate === path)?.[1] ?? "";
  const allowed = new Set(allowedControls);
  const controlTags = [...source.matchAll(/<(button|input)\b[\s\S]*?(?:>|\/>)/g)];
  if (!controlTags.length) {
    violations.push("Dashboard UI should declare local mirror controls explicitly.");
  }
  for (const match of controlTags) {
    const tag = match[0];
    const control = tag.match(/\bdata-mirror-control=["']([^"']+)["']/)?.[1];
    if (!control) {
      violations.push(`Dashboard ${match[1]} controls must be marked with data-mirror-control.`);
      continue;
    }
    if (!allowed.has(control)) {
      violations.push(`Dashboard mirror control ${control} is not an allowed local view control.`);
    }
  }
}

function checkDashboardRuntimeMethods(path, allowedMethods) {
  const source = files.find(([candidate]) => candidate === path)?.[1] ?? "";
  const calls = [...source.matchAll(/\bcallFlowCli\s*\([^,]+,\s*["']([^"']+)["']/g)].map((match) => match[1]);
  for (const method of calls) {
    if (!allowedMethods.includes(method)) {
      violations.push(`Dashboard state must only call read-only Flow runtime methods; found ${method}.`);
    }
  }
}

function checkDashboardStatePublicContract() {
  checkRequired("src/dashboard-state.ts", /const dashboardIssueFields = \[/, "Dashboard API must define an explicit public issue field allowlist.");
  checkRequired("src/dashboard-state.ts", /function publicDashboardIssue/, "Dashboard API must compact issue summaries through the public field allowlist.");
  checkRequired("src/dashboard-state.ts", /issues:\s*snapshot\.issues\.map\(\(issue\) => publicDashboardIssue\(summarizeIssue\(issue\)\)\)/, "Dashboard API must return only allowlisted issue fields.");
  for (const field of ["ref", "title", "workStatus", "statusLabel", "repositories", "blockerLabels", "evidenceStatus", "documentationStatus", "updatedLabel", "nextPickup", "handoffPrompt"]) {
    checkRequired("src/dashboard-state.ts", new RegExp(`["']${field}["']`), `Dashboard API issue allowlist must include ${field}.`);
  }
}

function checkDashboardQueueContract() {
  const source = files.find(([candidate]) => candidate === "src/work-runtime.ts")?.[1] ?? "";
  const interfaceSource = between(source, "export interface DashboardQueueIssue", "export interface GitInspector");
  const methodSource = between(source, "async inspectDashboardQueue", "async inspectBacklog");
  const returnSource = between(methodSource, "return {", "};");
  if (/\b(?:worktreePath|headSha)\b/.test(interfaceSource) || /\b(?:worktreePath|headSha)\s*:/.test(returnSource)) {
    violations.push("Dashboard queue contract must not expose local worktree paths or raw commit heads.");
  }
  if (/\bworkflowState\b/.test(interfaceSource) || /(?:^|\n)\s*workflowState\s*,/.test(returnSource) || /\bworkflowState\s*:/.test(returnSource)) {
    violations.push("Dashboard queue contract must expose display workStatus labels, not raw workflowState.");
  }
  if (/\b(?:issueUrl|prUrl|branch|repoKeys|blockers|evidenceRecorded|documentationRecorded|prIsDraft|prChecksPassing|prReviewDecision|humanReviewRequired)\b/.test(interfaceSource) ||
    /\b(?:issueUrl|prUrl|branch|repoKeys|blockers|evidenceRecorded|documentationRecorded|prIsDraft|prChecksPassing|prReviewDecision|humanReviewRequired)\s*:/.test(returnSource)) {
    violations.push("Dashboard queue contract must expose display fields, not URLs, branch details, raw blocker text, booleans, or provider PR fields.");
  }
  if (!/\bworkStatus\s*:/.test(interfaceSource)) {
    violations.push("Dashboard queue contract must include a display workStatus label.");
  }
  for (const field of ["statusLabel", "repositories", "blockerLabels", "evidenceStatus", "documentationStatus"]) {
    if (!new RegExp(`\\b${field}\\??\\s*:`).test(interfaceSource)) {
      violations.push(`Dashboard queue contract must include display ${field}.`);
    }
  }
}

function checkDashboardSmokeContract() {
  checkRequired("scripts/smoke-dashboard.mjs", /allowedWorkStatuses/, "Dashboard smoke must allowlist display work status labels.");
  checkRequired("scripts/smoke-dashboard.mjs", /assertRuntimeDashboardQueueShape/, "Dashboard smoke must verify the runtime dashboard queue contract.");
  checkRequired("scripts/smoke-dashboard.mjs", /assertSelectedIssueMirrorsAsActive/, "Dashboard smoke must prove selected internal state mirrors as Active.");
  checkRequired("scripts/smoke-dashboard.mjs", /assertNoRawWorkflowStates/, "Dashboard smoke must prove raw workflow states are absent from mirror payloads.");
  checkRequired("scripts/smoke-dashboard.mjs", /assertMirrorStateUnchanged/, "Dashboard smoke must prove blocked dashboard requests do not mutate mirrored state.");
  checkRequired("scripts/smoke-dashboard.mjs", /assertMirrorStateUnchanged\(dashboardFingerprintBeforeBlockedRequests,\s*queryPayload\.issues,\s*["']dashboard API with query input["']\)/, "Dashboard smoke must prove query input does not shape mirrored state.");
  checkRequired("scripts/smoke-dashboard.mjs", /assertUnavailablePayloadShape/, "Dashboard smoke must prove unavailable routes expose only ok:false.");
  checkRequired("scripts/smoke-dashboard.mjs", /\["OPTIONS", "POST", "PUT", "PATCH", "DELETE"\]/, "Dashboard smoke must verify OPTIONS and mutation methods are unavailable.");
  checkRequired("scripts/smoke-dashboard.mjs", /dashboardFingerprintBeforeBlockedRequests/, "Dashboard smoke must fingerprint API state before blocked requests.");
  checkRequired("scripts/smoke-dashboard.mjs", /runtimeFingerprintBeforeBlockedRequests/, "Dashboard smoke must fingerprint runtime state before blocked requests.");
  checkRequired("scripts/smoke-dashboard.mjs", /assertServedDashboardHtml/, "Dashboard smoke must verify served dashboard HTML for forbidden mirror controls and tokens.");
  checkRequired("scripts/smoke-dashboard.mjs", /rootHtml !== html/, "Dashboard smoke must prove root serves the same mirror shell as /dashboard.");
  checkRequired("scripts/smoke-dashboard.mjs", /queryHtml !== html/, "Dashboard smoke must prove dashboard shell query input does not change the mirror shell.");
  checkRequired("scripts/smoke-dashboard.mjs", /dashboard\/assets\/missing\.js/, "Dashboard smoke must prove missing served assets expose only ok:false.");
  checkRequired("scripts/smoke-dashboard.mjs", /favicon\.ico/, "Dashboard smoke must prove favicon fallback exposes only ok:false.");
  checkRequired("scripts/smoke-dashboard.mjs", /assertServedDashboardAssets/, "Dashboard smoke must verify served dashboard assets for forbidden mirror tokens.");
  checkRequired("scripts/smoke-dashboard.mjs", /assertServedMirrorControlMarkers/, "Dashboard smoke must verify served dashboard assets mark local view controls as mirror controls.");
  checkRequired("scripts/smoke-dashboard.mjs", /forbiddenServedAssetTokens/, "Dashboard smoke must define forbidden served asset tokens.");
  checkRequired("scripts/smoke-dashboard.mjs", /data-theme/, "Dashboard smoke must reject served mutable theme hooks.");
  checkRequired("scripts/smoke-dashboard.mjs", /themed-scroll/, "Dashboard smoke must reject old theme-scroll hooks.");
  checkRequired("scripts/smoke-dashboard.mjs", /assertMirrorHeaders\(assetUrl\)/, "Dashboard smoke must verify served dashboard assets use mirror headers.");
  checkRequired("scripts/smoke-dashboard.mjs", /assertMirrorHeaders/, "Dashboard smoke must verify mirror response headers.");
  checkRequired("scripts/smoke-dashboard.mjs", /assertMirrorHeaders\(`\$\{dashboardUrl\}\/healthz`\)/, "Dashboard smoke must verify health responses use mirror headers.");
  checkRequired("scripts/smoke-dashboard.mjs", /content-security-policy/, "Dashboard smoke must verify CSP response headers.");
  checkRequired("scripts/smoke-dashboard.mjs", /cross-origin-opener-policy/, "Dashboard smoke must verify cross-origin opener policy headers.");
  checkRequired("scripts/smoke-dashboard.mjs", /cross-origin-resource-policy/, "Dashboard smoke must verify cross-origin resource policy headers.");
  checkRequired("scripts/smoke-dashboard.mjs", /origin-agent-cluster/, "Dashboard smoke must verify origin agent cluster headers.");
  checkRequired("scripts/smoke-dashboard.mjs", /referrer-policy/, "Dashboard smoke must verify referrer policy headers.");
  checkRequired("scripts/smoke-dashboard.mjs", /permissions-policy/, "Dashboard smoke must verify permissions policy headers.");
  checkRequired("scripts/smoke-dashboard.mjs", /assertNotAvailable[\s\S]*assertResponseMirrorHeaders/, "Dashboard smoke must verify mirror headers on unavailable routes.");
  checkRequired("scripts/smoke-dashboard.mjs", /x-content-type-options/, "Dashboard smoke must verify content sniffing headers.");
  checkRequired("scripts/smoke-dashboard.mjs", /x-dns-prefetch-control/, "Dashboard smoke must verify DNS prefetch headers.");
  checkRequired("scripts/smoke-dashboard.mjs", /x-frame-options/, "Dashboard smoke must verify frame denial headers.");
  checkRequired("scripts/smoke-dashboard.mjs", /function assertHealthPayloadShape/, "Dashboard smoke must verify health responses only expose liveness.");
  checkRequired("scripts/smoke-dashboard.mjs", /topLevelKeys !== "issues,ok,snapshot"/, "Dashboard smoke must enforce the top-level API shape.");
  checkRequired("scripts/smoke-dashboard.mjs", /snapshotKeys !== "freshnessLabel"/, "Dashboard smoke must enforce the snapshot API shape.");
  checkRequired("scripts/smoke-dashboard.mjs", /allowedIssueKeys/, "Dashboard smoke must allowlist public issue fields.");
}

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) return "";
  const endIndex = source.indexOf(end, startIndex + start.length);
  return source.slice(startIndex, endIndex < 0 ? undefined : endIndex);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
