import * as fs from "node:fs";
import * as path from "node:path";
import { parseWorkspaceGraph } from "./schema.js";
import type { WorkspaceGraphV1 } from "./types.js";

export const maxGraphArtifactBytes = 32 * 1024 * 1024;

export class WorkspaceGraphStore {
  constructor(readonly artifactPath: string, readonly sizeLimit = maxGraphArtifactBytes) {}

  load(): WorkspaceGraphV1 {
    const stat = fs.statSync(this.artifactPath);
    if (!stat.isFile()) throw new Error("Workspace graph artifact is not a file");
    if (stat.size > this.sizeLimit) throw new Error(`Workspace graph artifact exceeds ${this.sizeLimit} bytes`);
    return parseWorkspaceGraph(JSON.parse(fs.readFileSync(this.artifactPath, "utf8")) as unknown);
  }

  save(graph: WorkspaceGraphV1): void {
    const validated = parseWorkspaceGraph(graph);
    const body = `${JSON.stringify(validated)}\n`;
    if (Buffer.byteLength(body, "utf8") > this.sizeLimit) throw new Error(`Workspace graph artifact exceeds ${this.sizeLimit} bytes`);
    fs.mkdirSync(path.dirname(this.artifactPath), { recursive: true });
    const temporary = `${this.artifactPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, body, { encoding: "utf8", flag: "wx" });
      fs.renameSync(temporary, this.artifactPath);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  }

  quarantine(reason = "corrupt"): string | undefined {
    if (!fs.existsSync(this.artifactPath)) return undefined;
    const target = `${this.artifactPath}.${reason}.${Date.now()}`;
    fs.renameSync(this.artifactPath, target);
    return target;
  }
}
