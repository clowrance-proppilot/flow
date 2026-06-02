import { Search } from "lucide-react";
import type { DashboardIssue, WorkStatusFilter } from "../types.js";
import { cx, workStatusThemeClass } from "../utils.js";
import { SectionLabel } from "./DetailSection.js";

export function Sidebar(props: {
  activeStatus: WorkStatusFilter;
  issues: DashboardIssue[];
  query: string;
  statusCounts: Record<string, number>;
  onStatusChange: (status: WorkStatusFilter) => void;
  onQueryChange: (query: string) => void;
}) {
  const statusFilters: Array<{ id: WorkStatusFilter; label: string; count: number }> = [
    { id: "all", label: "All Flow Items", count: props.issues.length },
    ...Object.keys(props.statusCounts).sort().map((label) => ({
      id: label,
      label,
      count: props.statusCounts[label] || 0,
    })),
  ];

  return (
    <aside className="flex min-h-0 flex-col border-b border-[var(--th-border)] bg-[var(--th-surface)] p-3.5 sm:p-4 md:border-b-0 md:border-r lg:p-5">
      <label className="relative mb-3.5 sm:mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--th-fg-muted)]" />
        <input
          type="search"
          data-mirror-control="search-filter"
          placeholder="Search issues..."
          autoComplete="off"
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
          className="accent-ring-focus h-9 w-full rounded-md border border-[var(--th-border)] bg-[var(--th-input)] px-3 pl-9 text-[0.8rem] text-[var(--th-fg)] outline-none"
        />
      </label>

      <SectionLabel>Work Status</SectionLabel>
      <div className="mb-3.5 grid grid-cols-2 gap-1.5 sm:grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] sm:mb-4 md:grid-cols-1">
        {statusFilters.map((filter) => (
          <button
            key={filter.id}
            type="button"
            data-mirror-control="status-filter"
            onClick={() => props.onStatusChange(filter.id)}
            className={cx(
              "status-filter grid min-h-9 min-w-0 grid-cols-[0.5rem_minmax(0,1fr)_auto] items-center gap-1.5 overflow-hidden rounded-md border px-2 text-left text-[0.76rem] font-semibold sm:gap-2 sm:px-2.5 sm:text-[0.8rem]",
              workStatusThemeClass(filter.id === "all" ? "all" : filter.label),
              props.activeStatus === filter.id && "is-active",
            )}
          >
            <span className="status-dot h-2 w-2 rounded-full" />
            <span className="min-w-0 truncate">{filter.label}</span>
            <span className="shrink-0 font-mono text-xs font-bold text-[var(--th-fg-muted)]">{filter.count}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
