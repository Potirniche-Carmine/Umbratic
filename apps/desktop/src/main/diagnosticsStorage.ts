import { parsePayload, withAppDatabase } from "./storageDatabase";
import type { DiagnosticRow, DiagnosticStatsRow } from "./storageDatabase";
import type { LocalDiagnosticInfo, LocalDiagnosticLevel, LocalDiagnosticRecord } from "./types";

export type LocalDiagnosticInput = {
  at?: string;
  level: LocalDiagnosticLevel;
  source: string;
  event: string;
  taskId?: string;
  message?: string;
  data?: unknown;
};

function normalizedDiagnosticText(value: string | undefined, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, limit);
}

const maxLocalDiagnosticEntries = 2000;
const maxLocalDiagnosticBytes = 8 * 1024 * 1024;

export function appendLocalDiagnostic(input: LocalDiagnosticInput): void {
  if (input.level !== "warn" && input.level !== "error") return;
  const source = normalizedDiagnosticText(input.source, 80);
  const event = normalizedDiagnosticText(input.event, 160);
  if (!source || !event) return;
  const at = typeof input.at === "string" && Number.isFinite(Date.parse(input.at)) ? input.at : new Date().toISOString();
  const data = JSON.stringify(input.data ?? {});
  withAppDatabase((db) => {
    db.prepare(`
      INSERT INTO diagnostic_logs (at, level, source, event, task_id, message, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      at,
      input.level,
      source,
      event,
      normalizedDiagnosticText(input.taskId, 128) ?? null,
      normalizedDiagnosticText(input.message, 4000) ?? null,
      data,
    );
    const overflow = db.prepare(`
      SELECT COUNT(*) AS entries FROM diagnostic_logs
    `).get() as { entries: number };
    const excess = Math.max(0, Number(overflow.entries) - maxLocalDiagnosticEntries);
    if (excess > 0) {
      db.prepare(`
        DELETE FROM diagnostic_logs WHERE id IN (
          SELECT id FROM diagnostic_logs ORDER BY id ASC LIMIT ?
        )
      `).run(excess);
    }
    for (;;) {
      const stats = db.prepare(`
        SELECT
          COUNT(*) AS entries,
          COALESCE(SUM(
            LENGTH(CAST(at AS BLOB)) +
            LENGTH(CAST(level AS BLOB)) +
            LENGTH(CAST(source AS BLOB)) +
            LENGTH(CAST(event AS BLOB)) +
            COALESCE(LENGTH(CAST(task_id AS BLOB)), 0) +
            COALESCE(LENGTH(CAST(message AS BLOB)), 0) +
            LENGTH(CAST(data AS BLOB))
          ), 0) AS bytes
        FROM diagnostic_logs
      `).get() as DiagnosticStatsRow;
      if ((Number(stats.entries) || 0) === 0 || (Number(stats.bytes) || 0) <= maxLocalDiagnosticBytes) break;
      db.prepare(`
        DELETE FROM diagnostic_logs WHERE id = (
          SELECT id FROM diagnostic_logs ORDER BY id ASC LIMIT 1
        )
      `).run();
    }
  });
}

export function readLocalDiagnosticInfo(): LocalDiagnosticInfo {
  return withAppDatabase((db) => {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS entries,
        COALESCE(SUM(
          LENGTH(CAST(at AS BLOB)) +
          LENGTH(CAST(level AS BLOB)) +
          LENGTH(CAST(source AS BLOB)) +
          LENGTH(CAST(event AS BLOB)) +
          COALESCE(LENGTH(CAST(task_id AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(message AS BLOB)), 0) +
          LENGTH(CAST(data AS BLOB))
        ), 0) AS bytes
      FROM diagnostic_logs
    `).get() as DiagnosticStatsRow;
    return { bytes: Number(row.bytes) || 0, entries: Number(row.entries) || 0 };
  });
}

export function readLocalDiagnostics(): LocalDiagnosticRecord[] {
  return withAppDatabase((db) => {
    const rows = db.prepare(`
      SELECT id, at, level, source, event, task_id, message, data
      FROM diagnostic_logs
      ORDER BY id ASC
    `).all() as DiagnosticRow[];
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      level: row.level as LocalDiagnosticLevel,
      source: row.source,
      event: row.event,
      ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.message ? { message: row.message } : {}),
      data: parsePayload(row.data) ?? {},
    }));
  });
}

export function clearLocalDiagnostics(): LocalDiagnosticInfo {
  return withAppDatabase((db) => {
    db.exec("DELETE FROM diagnostic_logs; VACUUM;");
    return { bytes: 0, entries: 0 };
  });
}
