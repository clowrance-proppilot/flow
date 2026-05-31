import React from "react";
import { cx } from "../utils.js";

export function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 border-b border-[var(--th-border)] p-4 text-[0.8rem] text-[var(--th-fg-soft)] [overflow-wrap:anywhere] sm:p-5">
      <h2 className="mb-2 text-[0.8rem] font-bold text-[var(--th-fg)] sm:mb-2.5">{title}</h2>
      {children}
    </section>
  );
}

export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cx("mx-0.5 mb-2 text-[0.66rem] font-bold uppercase tracking-wide text-[var(--th-fg-muted)]", className)}>{children}</div>;
}
