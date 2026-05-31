import { BrandMark } from "./BrandMark.js";

export function TopBar() {
  return (
    <header className="grid grid-cols-[auto_1fr] items-center gap-3 border-b border-[var(--th-border)] bg-[var(--th-surface)] px-4 sm:gap-4 sm:px-5 lg:px-6">
      <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
        <BrandMark className="h-8 w-8 rounded-md" iconClassName="h-4 w-4" />
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-[var(--th-fg)]">Flow</div>
        </div>
      </div>
      <div />
    </header>
  );
}
