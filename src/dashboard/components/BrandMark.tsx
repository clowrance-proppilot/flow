import { Waypoints } from "lucide-react";
import { cx } from "../utils.js";

export function BrandMark({ className, iconClassName }: { className: string; iconClassName: string }) {
  return (
    <span className={cx("brand-mark accent-bg grid place-items-center shadow-sm", className)} aria-hidden="true">
      <Waypoints className={cx("brand-mark-icon", iconClassName)} />
    </span>
  );
}
