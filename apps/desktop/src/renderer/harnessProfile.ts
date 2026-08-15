import type { HarnessProfileId } from "../shared/desktopApi";

export const defaultHarnessProfileId: HarnessProfileId = "engineering";

export const harnessProfiles: Array<{ id: HarnessProfileId; name: string; description: string }> = [
  {
    id: "marketing",
    name: "Marketing",
    description: "Campaigns, content, positioning, launch work, site copy, brand context, and lightweight implementation support.",
  },
  {
    id: "sales",
    name: "Sales",
    description: "Customer-facing workflows, enablement, proposals, demos, objections, CRM-style notes, and pipeline support.",
  },
  {
    id: "engineering",
    name: "Engineering",
    description: "Codebase inspection, implementation, debugging, tests, verification, and precise repository changes.",
  },
];

export function isHarnessProfileId(value: unknown): value is HarnessProfileId {
  return value === "marketing" || value === "sales" || value === "engineering";
}
