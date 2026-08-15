import type { LocalCatalogModel } from "../shared/desktopApi";

/**
 * The local collection as the browser preview shows it.
 *
 * Chosen to put every state the list can be in on one screen: one model already
 * downloaded, several only an icon away, one suggestion, a row larger than the
 * machine wants, the uncensored builds that are offered but never suggested,
 * and one custom addition with its remove control.
 */
export function previewCatalog(kind: "chat" | "dictation"): LocalCatalogModel[] {
  const row = (
    id: string,
    displayName: string,
    bytes: number,
    minRamGB: number,
    extra: { recommended?: boolean; downloaded?: boolean; uncensored?: boolean; custom?: boolean; role?: LocalCatalogModel["role"] } = {},
  ): LocalCatalogModel => ({
    id,
    kind,
    displayName,
    bytes,
    minRamGB,
    recommended: extra.recommended === true,
    uncensored: extra.uncensored === true,
    ...(extra.role ? { role: extra.role } : {}),
    custom: extra.custom === true,
    selectedQuant: kind === "dictation" ? "Q8_0" : "Q4_K_M",
    quants: kind === "dictation"
      ? [{ quant: "Q8_0", bytes, recommended: true, downloaded: extra.downloaded === true }]
      : [
          { quant: "Q4_K_M", bytes, recommended: true, downloaded: extra.downloaded === true },
          { quant: "Q3_K_M", bytes: Math.round(bytes * 0.8), recommended: false, downloaded: false },
          { quant: "Q5_K_M", bytes: Math.round(bytes * 1.16), recommended: false, downloaded: false },
          { quant: "Q6_K", bytes: Math.round(bytes * 1.38), recommended: false, downloaded: false },
          { quant: "Q8_0", bytes: Math.round(bytes * 1.78), recommended: false, downloaded: false },
        ],
    downloaded: extra.downloaded === true,
    downloading: false,
  });

  if (kind === "dictation") {
    return [
      row("qwen3-asr-0.6b", "Qwen3 ASR 0.6B", 1_019_141_728, 8, { downloaded: true }),
      row("qwen3-asr-1.7b", "Qwen3 ASR 1.7B", 2_520_744_288, 12, { recommended: true }),
    ];
  }
  // The catalog's own words, copied rather than imported: the preview runs in
  // the browser and the catalog is a main-process module.
  const chatRole = {
    label: "Chat",
    detail: "Good for questions and drafting. Tool calling is inconsistent, so not for agentic runs.",
  };
  const securityChatRole = {
    label: "Security chat",
    detail: "Answers security questions the safety-trained builds decline. Tool calling is inconsistent.",
  };
  // Downloaded first, matching the main process's ordering.
  return [
    row("gemma4-e2b", "Gemma 4 E2B", 3_106_738_272, 8, { downloaded: true, role: chatRole }),
    row("custom-thebloke-mistral-7b", "Mistral 7B Instruct", 4_368_439_296, 8, { custom: true, downloaded: true }),
    row("gemma4-e4b", "Gemma 4 E4B", 4_977_171_584, 12, { role: chatRole }),
    row("gemma4-12b", "Gemma 4 12B", 7_121_861_440, 16, {
      role: {
        label: "Light agentic",
        detail: "Steadier tool calling than the E-series, and still light. Fine for short agentic runs.",
      },
    }),
    row("qwen38-27b", "Qwen3.8 27B", 17_106_775_008, 32, {
      downloaded: true,
      recommended: true,
      role: {
        label: "Agentic",
        detail: "Reliable tool calling over long multi-step runs. The one to pick for agentic work.",
      },
    }),
    row("gemma4-e4b-uncensored", "Gemma 4 E4B Uncensored", 5_335_285_728, 12, { uncensored: true, role: securityChatRole }),
    row("qwen38-27b-abliterated", "Qwen3.8 27B Abliterated", 16_547_401_920, 32, {
      uncensored: true,
      role: {
        label: "Security agentic",
        detail: "Security and offensive research, with tool calling solid enough for agentic runs.",
      },
    }),
  ];
}
