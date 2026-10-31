import { localImageRuntime } from "./localImage";
/**
 * Local mode's model list and startup chain.
 *
 * The catalog, the user's custom additions, and whatever GGUF files are sitting
 * in the models folder say what exists; the machine's memory says what is
 * suggested; and the download directory says what is here.
 * This module is where those meet, and it is the only place that turns a
 * stored model id into a file path and a running sidecar.
 */

import { catalogAvailability, memoryBudget, memoryFit, neededRamGB } from "./hardware";
import {
  catalogModel,
  catalogQuantBytes,
  defaultQuant,
  effectiveEffort,
  modelQuant,
  quantMtpFile,
  quantProjectorFile,
  quantWeightsFile,
  samplingFor,
  type CatalogModel,
  type CatalogModelKind,
  type CatalogQuant,
} from "./modelCatalog";
import { customModel, listCustomModels } from "./customModels";
import { discoveredModel, listDiscoveredModels } from "./discoveredModels";
import { downloadingModelId, modelDownloaded, modelFileDownloaded, modelFilePath } from "./modelDownloads";
import { readLocalQuantSelections } from "./settingsStorage";
import { ensureLocalLlama } from "./localLlama";
import { localSpeechEndpoint } from "./localSpeech";
import { ensureLocalVeil, type LocalVeilConnection } from "./localVeil";
import type { DictationSettings, LocalCatalogModel, ReasoningEffort } from "../shared/desktopApi";
import type { ActiveModelEndpointSettings } from "./types";
import type { LlamaDiagnosticSink } from "./llamaServer";
import type { LocalVeilDiagnostic } from "./localVeil";

/** What the user must do before local mode can work at all. */
export const chooseLocalModelMessage = "Download a model in Settings → Connection";

/**
 * Catalog rows, custom additions, and whatever is already in the models folder
 * all answer to one id namespace. The folder is only searched when a data root
 * is given, because a caller without one has no folder to search.
 */
export function resolveLocalModel(id: string, dataRoot?: string): CatalogModel | null {
  return catalogModel(id) ?? customModel(id) ?? (dataRoot ? discoveredModel(dataRoot, id) : null);
}

/** The quantization the user chose for a model, or the model's default. */
export function selectedQuant(
  model: CatalogModel,
  selections: Record<string, string> = readLocalQuantSelections(),
): CatalogQuant {
  const chosen = selections[model.id];
  return (chosen ? modelQuant(model, chosen) : null) ?? defaultQuant(model);
}

/**
 * The quantization the runtime should load: the chosen one when its files are
 * here, otherwise whichever downloaded one the model lists first. A quant
 * choice that has not been downloaded yet must not silence a model that is
 * already on disk and working.
 */
export function activeQuant(
  dataRoot: string,
  model: CatalogModel,
  selections: Record<string, string> = readLocalQuantSelections(),
): CatalogQuant | null {
  const chosen = selectedQuant(model, selections);
  if (modelDownloaded(dataRoot, model, chosen)) return chosen;
  return model.quants.find((quant) => modelDownloaded(dataRoot, model, quant)) ?? null;
}

export async function listLocalModels(dataRoot: string, kind: CatalogModelKind): Promise<LocalCatalogModel[]> {
  const downloading = downloadingModelId();
  const selections = readLocalQuantSelections();
  const budget = await memoryBudget();
  const rows = catalogAvailability(kind, budget).map(({ model, recommended }) => ({ model, recommended, custom: false }));
  if (kind === "chat") {
    rows.push(...listCustomModels().map((model) => ({ model, recommended: false, custom: true })));
    // Never suggested: nothing here was reviewed, and a suggestion is what
    // someone gets without choosing.
    rows.push(...listDiscoveredModels(dataRoot).map((model) => ({ model, recommended: false, custom: false })));
  }
  const listed = rows.map(({ model, recommended, custom }) => {
    const chosen = selectedQuant(model, selections);
    return {
      id: model.id,
      kind: model.kind,
      displayName: model.displayName,
      bytes: catalogQuantBytes(chosen),
      ...(model.kind === "image" ? { sharedBytes: catalogQuantBytes(chosen) - quantWeightsFile(chosen).bytes } : {}),
      recommended,
      uncensored: model.uncensored === true,
      mtp: model.mtp === true,
      ...(model.role ? { role: model.role } : {}),
      custom,
      discovered: model.discovered === true,
      selectedQuant: chosen.quant,
      quants: model.quants.map((quant, index) => ({
        quant: quant.quant,
        bytes: catalogQuantBytes(quant),
        recommended: index === 0,
        downloaded: modelDownloaded(dataRoot, model, quant),
        fit: memoryFit(model, quant, budget),
        neededRamGB: neededRamGB(model, quant),
      })),
      fit: memoryFit(model, chosen, budget),
      neededRamGB: neededRamGB(model, chosen),
      downloaded: modelDownloaded(dataRoot, model, chosen),
      downloading: downloading === model.id,
    };
  });
  // What is on this computer leads the list; within each half the curated
  // order holds. Sorted here so every consumer of the list agrees.
  return [...listed.filter((row) => row.downloaded), ...listed.filter((row) => !row.downloaded)];
}

/**
 * The chat model this app run should serve, or null when there is not one.
 *
 * Null covers both "nothing chosen yet" and "chosen but the files are gone",
 * because the product answer is the same in either case: send the user to the
 * connection panel to pick and download one.
 */
export function selectedLocalChatModel(dataRoot: string, modelId: string): CatalogModel | null {
  const model = resolveLocalModel(modelId.trim(), dataRoot);
  if (!model || model.kind !== "chat") return null;
  return activeQuant(dataRoot, model) ? model : null;
}

/** The weights llama-server loads. */
export function localModelWeightsPath(dataRoot: string, model: CatalogModel): string {
  const quant = activeQuant(dataRoot, model) ?? defaultQuant(model);
  return modelFilePath(dataRoot, model, quantWeightsFile(quant));
}

/**
 * What llama-server is told about drafting, or null to decode one token at a
 * time: the model has to carry a head and the user has to want it used. A
 * head that lives in its own file is named; one inside the weights is not.
 */
export function localModelMtp(dataRoot: string, model: CatalogModel, enabled: boolean): { draftFile: string | null } | null {
  if (!enabled || !model.mtp) return null;
  const quant = activeQuant(dataRoot, model) ?? defaultQuant(model);
  const head = quantMtpFile(quant);
  return { draftFile: head ? modelFilePath(dataRoot, model, head) : null };
}

/**
 * The dictation model to run, or null when dictation is off or its weights are
 * not on disk. Both files must be present: llama-server will not load the audio
 * encoder without its projector.
 */
export function selectedLocalDictationModel(
  dataRoot: string,
  modelId: string,
): { model: CatalogModel; modelId: string; modelFile: string; projectorFile: string } | null {
  if (modelId === "off") return null;
  const model = catalogModel(modelId);
  if (!model || model.kind !== "dictation") return null;
  const quant = activeQuant(dataRoot, model);
  if (!quant) return null;
  const weights = quant.files.find((file) => !file.name.startsWith("mmproj-"));
  const projector = quant.files.find((file) => file.name.startsWith("mmproj-"));
  if (!weights || !projector) return null;
  return {
    model,
    modelId: model.id,
    modelFile: modelFilePath(dataRoot, model, weights),
    projectorFile: modelFilePath(dataRoot, model, projector),
  };
}

/**
 * Brings up local mode: weights on disk, then llama-server, then the Veil in
 * front of it.
 *
 * Strictly ordered. Veil's health check requires the model runtime to answer,
 * so starting them the other way round produces a Veil that reports itself
 * broken for as long as the weights take to map.
 */
export async function ensureLocalChatRuntime(input: {
  dataRoot: string;
  settings: ActiveModelEndpointSettings;
  contextLength: number;
  /** Whether to draft from the model's MTP head, on dense models that have one. */
  mtp: boolean;
  dictation: DictationSettings;
  /** How hard to ask a thinking model to think. Ignored by models that do not read one. */
  reasoningEffort: ReasoningEffort;
  onLlamaDiagnostic?: LlamaDiagnosticSink;
  onVeilDiagnostic?: (diagnostic: LocalVeilDiagnostic) => void;
}): Promise<LocalVeilConnection> {
  const model = selectedLocalChatModel(input.dataRoot, input.settings.modelId);
  if (!model) throw new Error(chooseLocalModelMessage);
  const offeredProjector = quantProjectorFile(activeQuant(input.dataRoot, model)!);
  const projector = offeredProjector && modelFileDownloaded(input.dataRoot, model, offeredProjector) ? offeredProjector : null;
  const runtime = await ensureLocalLlama(
    {
      modelFile: localModelWeightsPath(input.dataRoot, model),
      projectorFile: projector ? modelFilePath(input.dataRoot, model, projector) : null,
      modelId: model.id,
      contextLength: input.contextLength,
      mtp: localModelMtp(input.dataRoot, model, input.mtp),
    },
    input.onLlamaDiagnostic,
  );
  // Veil is told where dictation will be before that sidecar exists. The
  // address and key are reserved for the app run, so the sidecar can start on
  // first use, stop when idle, and start again without restarting Veil.
  const dictationModel = selectedLocalDictationModel(input.dataRoot, input.dictation.model);
  const speech = dictationModel
    ? { ...(await localSpeechEndpoint()), model: dictationModel.model.id }
    : undefined;
  // Effort first, because it decides which of the card's two sampling sets
  // applies: "off" is exactly the non-thinking mode the instruct numbers were
  // published for.
  const effort = effectiveEffort(model, input.reasoningEffort);
  return ensureLocalVeil(
    input.settings,
    {
      ...runtime,
      reasoning: model.reasoning,
      vision: projector !== null,
      reasoningEffort: effort,
      sampling: samplingFor(model, effort ?? "off"),
      speech,
      image: localImageRuntime(input.dataRoot),
    },
    input.contextLength,
    input.onVeilDiagnostic,
  );
}
