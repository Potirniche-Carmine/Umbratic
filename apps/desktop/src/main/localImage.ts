import * as fs from "node:fs";
import * as path from "node:path";
import { imageModel } from "./imageModelCatalog";
import { modelDownloaded, modelFilePath } from "./modelDownloads";
import { modelQuant, defaultQuant } from "./modelCatalog";
import { readImageModelSetting, readLocalQuantSelections } from "./settingsStorage";

export type LocalImageRuntime = { binary: string; weights: string; encoder: string; vae: string };

export function imageRuntimeBinary(): string | null {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const executable = process.platform === "win32" ? "sd-cli.exe" : "sd-cli";
  const packaged = resources ? path.join(resources, "image-runtime", executable) : "";
  const development = path.resolve(__dirname, "../../.package/image-runtime", executable);
  return [packaged, process.env.UMBRATIC_IMAGE_BINARY?.trim(), development]
    .find((file): file is string => !!file && fs.existsSync(file)) ?? null;
}

export function localImageRuntime(dataRoot: string): LocalImageRuntime | undefined {
  if (readImageModelSetting() !== imageModel.id) return undefined;
  const quant = modelQuant(imageModel, readLocalQuantSelections()[imageModel.id]) ?? defaultQuant(imageModel);
  if (!modelDownloaded(dataRoot, imageModel, quant)) return undefined;
  const binary = imageRuntimeBinary();
  if (!binary) return undefined;
  const [weights, encoder, vae] = quant.files.map((file) => modelFilePath(dataRoot, imageModel, file));
  return { binary, weights, encoder, vae };
}
