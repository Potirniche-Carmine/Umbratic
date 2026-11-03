import React from "react";

/** The same control positions for every chat backend. */
export function ComposerActionRail({ leading, trailing }: { leading: React.ReactNode; trailing: React.ReactNode }) {
  return <div className="promptActionRail">
    <div className="promptRailGroup promptRailLeft">{leading}</div>
    <div className="promptRailGroup promptRailRight">{trailing}</div>
  </div>;
}
