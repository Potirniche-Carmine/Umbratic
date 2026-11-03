export function localFileLink(destination: string): { path: string; line?: number } | undefined {
  let value = destination.trim().replace(/^<(.*)>$/, "$1");
  try { value = decodeURIComponent(value); } catch { return undefined; }
  // No network paths, URL schemes, or control characters. The main process
  // separately checks that the resolved file stays inside the workspace.
  if (!value || /[\x00-\x1f\x7f]/.test(value) || /^(?:\/\/|\\\\)/.test(value) || (/^[a-z][\w+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value))) return undefined;
  const match = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(value);
  if (match) value = value.slice(0, match.index);
  if (!/[\\/]/.test(value) && !/^[^\s]+\.[a-z\d]{1,12}$/i.test(value)) return undefined;
  return { path: value, ...(match ? { line: Math.max(1, Number(match[1] || match[2])) } : {}) };
}
