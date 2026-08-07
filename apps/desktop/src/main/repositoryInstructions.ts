import * as fs from "node:fs";
import * as path from "node:path";

import { pathInside } from "./utils";

export type AgentInstructionFile = {
  path: string;
  text: string;
};

type AgentInstructionDiscoveryOptions = {
  readTextFile(filePath: string): string | null;
};

/// The workspace root's AGENTS.md, or null when there is none.
///
/// Only the root file is injected. A monorepo can hold a nested AGENTS.md in
/// every package, and sending all of them costs the model a large block of
/// instructions for directories the task will never touch — while burying the
/// one file that governs the whole workspace. The nested files still apply;
/// the model is told they exist and reads the one nearest its work, which is a
/// single targeted read instead of a standing tax on every turn.
export function rootAgentInstructions(
  rootPath: string,
  options: AgentInstructionDiscoveryOptions,
): AgentInstructionFile | null {
  const root = path.resolve(rootPath);
  const absolute = path.join(root, "AGENTS.md");
  if (!pathInside(root, absolute) || !fs.existsSync(absolute)) return null;
  const text = options.readTextFile(absolute);
  if (text === null) return null;
  return { path: "AGENTS.md", text };
}
