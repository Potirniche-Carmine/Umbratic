import type { AppUpdater, UpdateInfo, ResolvedUpdateFileInfo } from "electron-updater";
import { Provider, type ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";

const repository = "Potirniche-Carmine/Umbratic";
const releasesUrl = `https://api.github.com/repos/${repository}/releases/latest`;

/** GitHub's asset digests replace separately published updater manifests. */
export function releaseUpdateInfo(release: unknown, platform: string, architecture: string): UpdateInfo {
  if (!release || typeof release !== "object") throw new Error("Invalid GitHub release.");
  const record = release as Record<string, unknown>;
  if (typeof record.tag_name !== "string" || !/^v\d+\.\d+\.\d+$/.test(record.tag_name)
      || record.draft !== false || record.prerelease !== false || !Array.isArray(record.assets)
      || typeof record.published_at !== "string" || !Number.isFinite(Date.parse(record.published_at))) {
    throw new Error("Invalid stable GitHub release.");
  }
  const version = record.tag_name.slice(1);
  let name: string;
  if (platform === "darwin" && architecture === "arm64") name = `Umbratic-${version}.zip`;
  else if (platform === "win32" && ["x64", "arm64"].includes(architecture)) name = `Umbratic-${version}-${architecture}.exe`;
  else throw new Error("Unsupported update platform.");

  const matches = record.assets.filter((asset) => asset?.name === name);
  if (matches.length !== 1) throw new Error("Release has no unique installer for this platform.");
  const asset = matches[0];
  const url = `https://github.com/${repository}/releases/download/${record.tag_name}/${name}`;
  if (asset.state !== "uploaded" || asset.browser_download_url !== url
      || !Number.isSafeInteger(asset.size) || asset.size <= 0
      || typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
    throw new Error("Release installer checksum or metadata is invalid.");
  }
  // The pinned updater supports sha2 on both platforms, although its public
  // types require sha512. Leave sha512 absent so the download verifies SHA-256.
  // Its SHA-512-only disk cache safely redownloads after a restart.
  return {
    version,
    files: [{ url, size: asset.size, sha2: asset.digest.slice("sha256:".length) }],
    path: url,
    releaseDate: record.published_at,
  } as unknown as UpdateInfo;
}

export class ReleaseUpdateProvider extends Provider<UpdateInfo> {
  private readonly platform: string;

  constructor(_configuration: unknown, _updater: AppUpdater, runtime: ProviderRuntimeOptions) {
    super({ ...runtime, isUseMultipleRangeRequest: false });
    this.platform = runtime.platform;
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    const response = await this.httpRequest(new URL(releasesUrl), { Accept: "application/vnd.github+json" });
    return releaseUpdateInfo(JSON.parse(response ?? "null"), this.platform, process.arch);
  }

  resolveFiles(info: UpdateInfo): ResolvedUpdateFileInfo[] {
    return info.files.map((file) => ({ url: new URL(file.url), info: file }));
  }
}
