/** The shortest path suffix that distinguishes this item from its peers. */
export function compactPath(path: string, peers: readonly string[] = []): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  const others = [...new Set(peers)].filter(peer => peer !== path).map(peer => peer.replaceAll("\\", "/").split("/").filter(Boolean));
  for (let count = 1; count <= parts.length; count++) {
    const suffix = parts.slice(-count).join("/");
    if (!others.some(other => other.slice(-count).join("/") === suffix)) return suffix;
  }
  return parts.join("/") || path;
}
