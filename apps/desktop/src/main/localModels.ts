/**
 * Local mode's model list and startup chain.
 *
 * The catalog and the user's custom additions say what exists, the machine's
 * memory says what is suggested, and the download directory says what is here.
 * This module is where those meet, and it is the only place that turns a
 * stored model id into a file path and a running sidecar.
 */

import { catalogAvailability, totalRamGB } from "./hardware";
import {
  catalogModel,
  catalogQuantBytes,
  defaultQuant,
  effectiveEffort,
  modelQuant,
  samplingFor,
  type CatalogModel,
  type CatalogModelKind,
  type CatalogQuant,
} from "./modelCatalog";
import { customModel, listCustomModels } from "./customModels";
import { downloadingModelId, modelDownloaded, modelFilePath } from "./modelDownloads";
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

/** Catalog rows and custom additions answer to one id namespace. */
export function resolveLocalModel(id: string): CatalogModel | null {
  return catalogModel(id) ?? customModel(id);
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

export function listLocalModels(dataRoot: string, kind: CatalogModelKind): LocalCatalogModel[] {
  const downloading = downloadingModelId();
  const selections = readLocalQuantSelections();
  const rows = catalogAvailability(kind, totalRamGB()).map(({ model, recommended }) => ({ model, recommended, custom: false }));
  if (kind === "chat") {
    rows.push(...listCustomModels().map((model) => ({ model, recommended: false, custom: true })));
  }
  const listed = rows.map(({ model, recommended, custom }) => {
    const chosen = selectedQuant(model, selections);
    return {
      id: model.id,
      kind: model.kind,
      displayName: model.displayName,
      bytes: catalogQuantBytes(chosen),
      minRamGB: model.minRamGB,
      recommended,
      uncensored: model.uncensored === true,
      custom,
      selectedQuant: chosen.quant,
      quants: model.quants.map((quant, index) => ({
        quant: quant.quant,
        bytes: catalogQuantBytes(quant),
        recommended: index === 0,
        downloaded: modelDownloaded(dataRoot, model, quant),
      })),
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
  const model = resolveLocalModel(modelId.trim());
  if (!model || model.kind !== "chat") return null;
  return activeQuant(dataRoot, model) ? model : null;
}

/** The weights llama-server loads. Chat quantizations are a single file by construction. */
export function localModelWeightsPath(dataRoot: string, model: CatalogModel): string {
  const quant = activeQuant(dataRoot, model) ?? defaultQuant(model);
  const weights = quant.files.find((file) => !file.name.startsWith("mmproj-")) ?? quant.files[0];
  return modelFilePath(dataRoot, model, weights);
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
  dictation: DictationSettings;
  /** How hard to ask a thinking model to think. Ignored by models that do not read one. */
  reasoningEffort: ReasoningEffort;
  onLlamaDiagnostic?: LlamaDiagnosticSink;
  onVeilDiagnostic?: (diagnostic: LocalVeilDiagnostic) => void;
}): Promise<LocalVeilConnection> {
  const model = selectedLocalChatModel(input.dataRoot, input.settings.modelId);
  if (!model) throw new Error(chooseLocalModelMessage);
  const runtime = await ensureLocalLlama(
    {
      modelFile: localModelWeightsPath(input.dataRoot, model),
      modelId: model.id,
      contextLength: input.contextLength,
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
      reasoningEffort: effort,
      sampling: samplingFor(model, effort ?? "off"),
      speech,
    },
    input.contextLength,
    input.onVeilDiagnostic,
  );
}
