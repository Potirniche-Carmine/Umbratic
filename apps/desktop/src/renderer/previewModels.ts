import type { LocalCatalogModel, LocalMemoryFit } from "../shared/desktopApi";

/** The preview machine has 32 GB, which is what the fit notes are about. */
const previewRamGB = 32;

function fitFor(neededRamGB: number): LocalMemoryFit {
  if (previewRamGB >= neededRamGB) return "comfortable";
  return previewRamGB >= neededRamGB * 0.75 ? "tight" : "exceeds";
}

/**
 * The local collection as the browser preview shows it.
 *
 * Chosen to put every state the list can be in on one screen: one model already
 * downloaded, several only an icon away, one suggestion, a row larger than the
 * machine has, the uncensored builds that are offered but never suggested,
 * and custom additions with their remove control.
 */
export function previewCatalog(kind: "chat" | "dictation"): LocalCatalogModel[] {
  const row = (
    id: string,
    displayName: string,
    bytes: number,
    minRamGB: number,
    extra: { recommended?: boolean; downloaded?: boolean; uncensored?: boolean; mtp?: boolean; custom?: boolean; role?: LocalCatalogModel["role"] } = {},
  ): LocalCatalogModel => {
    const quantRow = (quant: string, scale: number, recommended: boolean) => {
      const needed = Math.ceil(minRamGB * scale);
      return {
        quant,
        bytes: Math.round(bytes * scale),
        recommended,
        downloaded: recommended && extra.downloaded === true,
        fit: fitFor(needed),
        neededRamGB: needed,
      };
    };
    return {
      id,
      kind,
      displayName,
      bytes,
      recommended: extra.recommended === true,
      uncensored: extra.uncensored === true,
      mtp: extra.mtp === true,
      ...(extra.role ? { role: extra.role } : {}),
      custom: extra.custom === true,
      selectedQuant: kind === "dictation" ? "Q8_0" : "Q4_K_M",
      quants: kind === "dictation"
        ? [quantRow("Q8_0", 1, true)]
        : [
            quantRow("Q4_K_M", 1, true),
            quantRow("Q3_K_M", 0.8, false),
            quantRow("Q5_K_M", 1.16, false),
            quantRow("Q6_K", 1.38, false),
            quantRow("Q8_0", 1.78, false),
          ],
      fit: fitFor(minRamGB),
      neededRamGB: minRamGB,
      downloaded: extra.downloaded === true,
      downloading: false,
    };
  };

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
    row("gemma4-e2b", "Gemma 4 E2B", 3_204_555_936, 8, { downloaded: true, mtp: true, role: chatRole }),
    row("custom-thebloke-mistral-7b", "Mistral 7B Instruct", 4_368_439_296, 8, { custom: true, downloaded: true }),
    row("custom-glm-4.7", "GLM 4.7", 68_900_000_000, 96, { custom: true }),
    row("gemma4-e4b", "Gemma 4 E4B", 5_075_824_832, 12, { mtp: true, role: chatRole }),
    row("gemma4-12b", "Gemma 4 12B", 7_586_970_688, 16, {
      mtp: true,
      role: {
        label: "Light agentic",
        detail: "Steadier tool calling than the E-series, and still light. Fine for short agentic runs.",
      },
    }),
    row("ornith-1.5-35b-a3b", "Ornith 1.5 35B A3B", 21_713_462_848, 32, {
      mtp: true,
      role: {
        label: "Agentic coding",
        detail: "Trained for terminal coding agents and tool calling. Mixture-of-experts, so it answers fast for its size.",
      },
    }),
    row("qwen38-27b", "Qwen3.8 27B", 17_106_775_008, 32, {
      downloaded: true,
      recommended: true,
      mtp: true,
      role: {
        label: "Agentic",
        detail: "Reliable tool calling over long multi-step runs. The one to pick for agentic work.",
      },
    }),
    row("gemma4-e4b-uncensored", "Gemma 4 E4B Uncensored", 5_335_285_728, 12, { uncensored: true, role: securityChatRole }),
    row("qwen38-27b-abliterated", "Qwen3.8 27B Abliterated", 16_810_716_384, 32, {
      uncensored: true,
      mtp: true,
      role: {
        label: "Security agentic",
        detail: "Security and offensive research, with tool calling solid enough for agentic runs.",
      },
    }),
  ];
}
