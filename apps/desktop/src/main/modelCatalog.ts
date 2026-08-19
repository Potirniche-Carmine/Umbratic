/**
 * The models Umbratic will download and run locally.
 *
 * A closed, hand-reviewed list rather than a search over Hugging Face: every
 * row names a repository revision and the SHA-256 of each file at that
 * revision, which is what lets the downloader verify what it fetched instead of
 * trusting the transport. Adding a row means reading the model card and
 * recording those digests from the file's page — that is the supply-chain
 * review. Models a user adds by Hugging Face reference live in
 * `customModels.ts` and are pinned the same way, at the moment they are added.
 */

import type { ReasoningEffort } from "../shared/desktopApi";

export type CatalogModelKind = "chat" | "dictation";

/**
 * One sampling set, as a model card recommends it.
 *
 * These are the model's own numbers, not Umbratic's taste. They are recorded
 * per model for the same reason the digests are: reading them off the card once
 * and pinning them here is what keeps every machine sampling the same way.
 */
export type SamplingProfile = {
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  presencePenalty: number;
  repetitionPenalty: number;
};

/**
 * A model whose card recommends different sampling depending on whether it is
 * thinking. Qwen's instruct numbers are markedly less permissive than its
 * thinking ones, so serving one set for both would make it worse at whichever
 * mode it was not tuned for.
 */
export type SamplingProfiles = {
  thinking: SamplingProfile;
  instruct: SamplingProfile;
};

export type CatalogFile = {
  /** File name inside the repository, and on disk under the model's directory. */
  name: string;
  bytes: number;
  sha256: string;
};

/** One quantization of a model: the same weights at one size/quality point. */
export type CatalogQuant = {
  /** Quantization label as the repository spells it, e.g. "Q4_K_M". */
  quant: string;
  files: CatalogFile[];
};

export type CatalogModel = {
  id: string;
  kind: CatalogModelKind;
  displayName: string;
  hfRepo: string;
  /** Immutable commit the files are fetched from. Never a branch name. */
  hfRevision: string;
  /**
   * Offered quantizations, the default first. The default is the balance
   * point the catalog stands behind; the rest trade size against quality in
   * both directions and are the user's call.
   */
  quants: CatalogQuant[];
  /**
   * The memory this model wants to be comfortable in, at its default
   * quantization: weights, a long context's KV cache, and room for the rest of
   * the machine. Nothing is withheld because of it — the list stays complete
   * and every row stays selectable — it decides which row is suggested and
   * what each row says about how it will sit in this machine's memory.
   */
  minRamGB: number;
  /**
   * Whether the model has thinking to direct. Veil drops a thinking directive
   * for a model without it, so a wrong value here is a silently ignored
   * instruction rather than an error.
   */
  reasoning: boolean;
  /**
   * The effort levels this model's chat template actually reads, in the order
   * the menu should show them. Absent means the model takes no direction on how
   * hard to think — narrower than `reasoning`, because a model can think
   * without accepting a level, and offering a choice the template ignores is
   * worse than offering none.
   *
   * A list rather than a boolean: templates disagree about which levels exist,
   * and the menu should offer what this model has rather than a fixed four.
   */
  reasoningEfforts?: readonly ReasoningEffort[];
  /**
   * The sampling the model card recommends, when it recommends any. Absent
   * leaves the runtime's own defaults alone.
   */
  sampling?: SamplingProfiles;
  /**
   * Models with the safety training removed. Offered deliberately, never
   * suggested: a recommendation is what someone gets without choosing, and
   * this is a choice worth making on purpose.
   */
  uncensored?: boolean;
  /**
   * The weights carry a multi-token-prediction head llama.cpp can draft from,
   * so decoding can verify several tokens per step instead of producing one.
   * Either the head is inside the GGUF itself — Qwen3.5-family builds ship
   * it as an extra block — or it is the `mtp-` file listed among the quant's
   * files, downloaded alongside the weights so having it is never a second
   * decision. Recorded from the GGUF header or the repository's file list,
   * not assumed from the family: an abliterated rebuild can drop the head.
   */
  mtp?: boolean;
  /**
   * What this model is actually good for, in one line, shown on its row.
   *
   * Size is not the answer to "which of these should I pick": the thing that
   * separates them here is whether their tool calling holds up, and a list
   * that only prints gigabytes lets someone choose a 3 GB model for agentic
   * work and conclude the app is broken when it loops. Written as what the
   * model is for rather than as a warning — every row here is worth running,
   * for something.
   *
   * Optional, and absent in two places on purpose: dictation weights are
   * chosen by size alone, and a model somebody added from a Hugging Face
   * reference is one this catalog has never read the card for. Saying nothing
   * is the honest answer there.
   */
  role?: ModelRole;
};

/**
 * The short tag and the sentence behind it. The tag is what the eye catches
 * scanning the list; the sentence is what settles the choice.
 */
export type ModelRole = {
  /** One or two words, shown as the row's tag. */
  label: string;
  detail: string;
};

/**
 * The E-series: small enough to run anywhere, and the reason the list needs
 * this column at all. They hold a conversation well and call tools erratically,
 * which is the one thing gigabytes never say.
 */
const chatOnlyRole: ModelRole = {
  label: "Chat",
  detail: "Good for questions and drafting. Tool calling is inconsistent, so not for agentic runs.",
};

const uncensoredChatRole: ModelRole = {
  label: "Security chat",
  detail: "Answers security questions the safety-trained builds decline. Tool calling is inconsistent.",
};

/**
 * Gemma 4's recommended sampling. One set for every use case — its card gives
 * the same numbers whether or not the model is thinking, so both slots below
 * point at this rather than repeating it and inviting them to drift apart.
 */
const gemmaSampling: SamplingProfile = {
  temperature: 1.0,
  topP: 0.95,
  topK: 64,
  minP: 0.0,
  presencePenalty: 0.0,
  repetitionPenalty: 1.0,
};

/** Gemma 4 reads `enable_thinking` and nothing finer, so the choice is binary. */
const gemmaReasoning = {
  reasoning: true,
  reasoningEfforts: ["off", "on"] as const,
  sampling: { thinking: gemmaSampling, instruct: gemmaSampling },
};

/**
 * Gemma 4's multi-token-prediction heads. Google ships them as separate
 * drafter models rather than inside the weights, so each quantization below
 * lists its head alongside the GGUF: one download brings both, and the head
 * is shared by every quantization of the model — the same file under the same
 * name, fetched once. These are the Q8_0 builds at the repository root, the
 * ones the card's own examples load.
 */
const gemmaE2BHead: CatalogFile = {
  name: "mtp-gemma-4-E2B-it.gguf",
  bytes: 97_817_664,
  sha256: "9eba819938efccfd6044f8af84e3bbfddc639a2bcf32ebc36420e6a649191919",
};
const gemmaE4BHead: CatalogFile = {
  name: "mtp-gemma-4-E4B-it.gguf",
  bytes: 98_653_248,
  sha256: "b6a723115efa510d3b3215db1e26790dae84cd08c2134a764f3d194f1f0c3376",
};
const gemma12BHead: CatalogFile = {
  name: "mtp-gemma-4-12b-it.gguf",
  bytes: 465_109_248,
  sha256: "145db9094bc0f85f1701e255a2ed216dcc9800fc8bc8631ad00905b456bd451b",
};

/**
 * Ordered, within each kind, from the lightest model to the most capable. The
 * order is load-bearing: the machine's suggestion is the most capable
 * safety-trained model whose comfortable memory it has, read straight off this
 * list, so a new model goes where its capability puts it rather than at the
 * end. Uncensored builds sit after the models they derive from and are never
 * suggested, so their position only decides where they are listed.
 */
export const modelCatalog: readonly CatalogModel[] = [
  {
    id: "gemma4-e2b",
    kind: "chat",
    displayName: "Gemma 4 E2B",
    hfRepo: "unsloth/gemma-4-E2B-it-GGUF",
    hfRevision: "0314792d7f1f7e229411f620751375812bb9faf2",
    quants: [
      {
        quant: "Q4_K_M",
        files: [{
          name: "gemma-4-E2B-it-Q4_K_M.gguf",
          bytes: 3_106_738_272,
          sha256: "740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8",
        }, gemmaE2BHead],
      },
      {
        quant: "Q3_K_M",
        files: [{
          name: "gemma-4-E2B-it-Q3_K_M.gguf",
          bytes: 2_536_786_016,
          sha256: "086e2f5ba85057f8f19712e3160a644728f74f323c9feeac4cd73fab11b43085",
        }, gemmaE2BHead],
      },
      {
        quant: "Q5_K_M",
        files: [{
          name: "gemma-4-E2B-it-Q5_K_M.gguf",
          bytes: 3_356_037_216,
          sha256: "90293b8cdaf9c973012bf4df8a1e92bde7d74ad66a4fe56cf905ccd563d660c5",
        }, gemmaE2BHead],
      },
      {
        quant: "Q6_K",
        files: [{
          name: "gemma-4-E2B-it-Q6_K.gguf",
          bytes: 4_501_721_184,
          sha256: "f7b8980ecc1c115898fd8d9a3d421d90becbac984194a44b478669c26815843d",
        }, gemmaE2BHead],
      },
      {
        quant: "Q8_0",
        files: [{
          name: "gemma-4-E2B-it-Q8_0.gguf",
          bytes: 5_048_352_864,
          sha256: "605d3c2647d7c58c1e4b5375ccb5702acf94c2611b4c8d4877812f8fdd32d053",
        }, gemmaE2BHead],
      },
    ],
    minRamGB: 8,
    mtp: true,
    role: chatOnlyRole,
    ...gemmaReasoning,
  },
  {
    id: "gemma4-e4b",
    kind: "chat",
    displayName: "Gemma 4 E4B",
    hfRepo: "unsloth/gemma-4-E4B-it-GGUF",
    hfRevision: "bfc15c382204943c3a8fff0c750b94ae2364d7a3",
    quants: [
      {
        quant: "Q4_K_M",
        files: [{
          name: "gemma-4-E4B-it-Q4_K_M.gguf",
          bytes: 4_977_171_584,
          sha256: "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87",
        }, gemmaE4BHead],
      },
      {
        quant: "Q3_K_M",
        files: [{
          name: "gemma-4-E4B-it-Q3_K_M.gguf",
          bytes: 4_058_137_728,
          sha256: "0980898d0e7d9c75cea05141bf4010393312101ef6cf5b31f8197e0de18655f4",
        }, gemmaE4BHead],
      },
      {
        quant: "Q5_K_M",
        files: [{
          name: "gemma-4-E4B-it-Q5_K_M.gguf",
          bytes: 5_481_798_784,
          sha256: "a5d6e634db151368d2caa4270fd32ab604d96c2d1291950586989f46d8e17d36",
        }, gemmaE4BHead],
      },
      {
        quant: "Q6_K",
        files: [{
          name: "gemma-4-E4B-it-Q6_K.gguf",
          bytes: 7_074_929_792,
          sha256: "fd83f3ef44d22e00ff0f638753dde9a66a83e8ccf79c11024f47d383c489531b",
        }, gemmaE4BHead],
      },
      {
        quant: "Q8_0",
        files: [{
          name: "gemma-4-E4B-it-Q8_0.gguf",
          bytes: 8_192_953_472,
          sha256: "f8854aa4480df62585a279e7ca0a881554fc18a41c59c4f62642d16a2ae47012",
        }, gemmaE4BHead],
      },
    ],
    minRamGB: 12,
    mtp: true,
    role: chatOnlyRole,
    ...gemmaReasoning,
  },
  {
    id: "gemma4-12b",
    kind: "chat",
    displayName: "Gemma 4 12B",
    hfRepo: "unsloth/gemma-4-12b-it-GGUF",
    hfRevision: "fc034cfff751157913579611efad8462ac1be606",
    quants: [
      {
        quant: "Q4_K_M",
        files: [{
          name: "gemma-4-12b-it-Q4_K_M.gguf",
          bytes: 7_121_861_440,
          sha256: "0a270ec9fe6b34f4a0d33992b6135117b484ebc4766ab76b51d4ae8c457e4c42",
        }, gemma12BHead],
      },
      {
        quant: "Q3_K_M",
        files: [{
          name: "gemma-4-12b-it-Q3_K_M.gguf",
          bytes: 5_693_872_960,
          sha256: "dbf58f4c413b82b27106867eb42f7087e4172a172f6f201e2e11598a6582e504",
        }, gemma12BHead],
      },
      {
        quant: "Q5_K_M",
        files: [{
          name: "gemma-4-12b-it-Q5_K_M.gguf",
          bytes: 8_413_576_000,
          sha256: "32c554c7d1338a23837ae39b3db482213a4a642f96df3b2619f516a2375d16cd",
        }, gemma12BHead],
      },
      {
        quant: "Q6_K",
        files: [{
          name: "gemma-4-12b-it-Q6_K.gguf",
          bytes: 9_786_022_720,
          sha256: "6f394336500bb5409bd68c31aa9d75097b5e6104f6cf30c82a09a7b64df41faf",
        }, gemma12BHead],
      },
      {
        quant: "Q8_0",
        files: [{
          name: "gemma-4-12b-it-Q8_0.gguf",
          bytes: 12_669_647_680,
          sha256: "f20e7ff1be28c283eeeb18fc895733791c56a5851d5cd3fe9691b7f7d12afa72",
        }, gemma12BHead],
      },
    ],
    minRamGB: 16,
    mtp: true,
    role: {
      label: "Light agentic",
      detail: "Steadier tool calling than the E-series, and still light. Fine for short agentic runs.",
    },
    ...gemmaReasoning,
  },
  {
    id: "ornith-1.5-35b-a3b",
    kind: "chat",
    displayName: "Ornith 1.5 35B A3B",
    hfRepo: "ornith-ai/Ornith-1.5-35B-A3B-GGUF",
    hfRevision: "5ae357e3eaf951ae221e8d784c71a8a3cdb6aa5f",
    // The repository's own ladder starts at Q4_K_M; there is no Q3_K_M, and
    // the BF16 and the vision projector are left out — the one is 71 GB and
    // the other serves a vision path chat here does not take. The files drop
    // "A3B" from their names, as the repository spells them.
    quants: [
      {
        quant: "Q4_K_M",
        files: [{
          name: "Ornith-1.5-35B-Q4_K_M.gguf",
          bytes: 21_713_462_848,
          sha256: "ca6ea26329c88b78ffd90a85163be2e746c2fafd1024f56db47e499f117f9a7f",
        }],
      },
      {
        quant: "Q5_K_M",
        files: [{
          name: "Ornith-1.5-35B-Q5_K_M.gguf",
          bytes: 25_347_532_352,
          sha256: "2ac3a45979ffbdff1c7a6f3334e6d4c347274adbc33531d23bde6fa1dfdcb994",
        }],
      },
      {
        quant: "Q6_K",
        files: [{
          name: "Ornith-1.5-35B-Q6_K.gguf",
          bytes: 29_208_731_200,
          sha256: "1c4e5bb98a74c89a5d93a2488b5748b7b331daf77f6dbb64bd9b2ff864b64eb3",
        }],
      },
      {
        quant: "Q8_0",
        files: [{
          name: "Ornith-1.5-35B-Q8_0.gguf",
          bytes: 37_802_149_120,
          sha256: "854cf83f80cd37a061ed86df1fa7201162e4e1fb820b91068cc12a11d2746c9e",
        }],
      },
    ],
    // 35B of weights on disk, 3B of them active per token: it wants the memory
    // of a large model and answers at the speed of a small one. The Q4_K_M is
    // 21.7 GB, so it is comfortable where the 27B is.
    minRamGB: 32,
    role: {
      label: "Agentic coding",
      detail: "Trained for terminal coding agents and tool calling. Mixture-of-experts, so it answers fast for its size.",
    },
    // `qwen35moe.nextn_predict_layers = 1`, with the head in block 40.
    mtp: true,
    reasoning: true,
    // Its template reads `enable_thinking` and nothing finer — thinking is on
    // unless told off — so the choice is binary, like Gemma's.
    reasoningEfforts: ["off", "on"],
    // The card's numbers for general use (it reproduces its benchmarks at
    // temperature 1.0, which is not what a desktop wants). One set for both
    // modes; the card draws no distinction.
    sampling: {
      thinking: { temperature: 0.6, topP: 0.95, topK: 20, minP: 0.0, presencePenalty: 0.0, repetitionPenalty: 1.0 },
      instruct: { temperature: 0.6, topP: 0.95, topK: 20, minP: 0.0, presencePenalty: 0.0, repetitionPenalty: 1.0 },
    },
  },
  {
    id: "qwen38-27b",
    kind: "chat",
    displayName: "Qwen3.8 27B",
    hfRepo: "unsloth/Qwen3.8-27B-GGUF",
    hfRevision: "fe1e2a23d973adb629709749dc4f6756df66ef10",
    quants: [
      {
        quant: "Q4_K_M",
        files: [{
          name: "Qwen3.8-27B-Q4_K_M.gguf",
          bytes: 17_106_775_008,
          sha256: "7e78da5d7e3ae28d178121f58646953305f3e5bd3cb46f4a75584e8b6c6fe169",
        }],
      },
      {
        quant: "Q3_K_M",
        files: [{
          name: "Qwen3.8-27B-Q3_K_M.gguf",
          bytes: 13_818_690_528,
          sha256: "7f3b845b563888ec3abc269474cf744bf703a7ce8766dbb7f696c63975facfd7",
        }],
      },
      {
        quant: "Q5_K_M",
        files: [{
          name: "Qwen3.8-27B-Q5_K_M.gguf",
          bytes: 19_834_055_648,
          sha256: "07deb7fa91bf751d3000774fe5bb8afae5ffb41255fd19980147468052e07177",
        }],
      },
      {
        quant: "Q6_K",
        files: [{
          name: "Qwen3.8-27B-Q6_K.gguf",
          bytes: 22_884_408_288,
          sha256: "562fbf760503008f118e5df38de5b3e97992d1f693f475815631198547486727",
        }],
      },
      {
        quant: "Q8_0",
        files: [{
          name: "Qwen3.8-27B-Q8_0.gguf",
          bytes: 29_047_086_048,
          sha256: "a680f44a06920e5d689774823782006aa3acc8db95750323373b24139b67e348",
        }],
      },
    ],
    minRamGB: 32,
    role: {
      label: "Agentic",
      detail: "Reliable tool calling over long multi-step runs. The one to pick for agentic work.",
    },
    // The GGUF header carries `qwen35.nextn_predict_layers = 1` and a 65th
    // block of `nextn` tensors: the drafting head is inside the weights.
    mtp: true,
    reasoning: true,
    // Its chat template reads `reasoning_effort` and refuses anything but low,
    // medium and xhigh — "high" is remapped to xhigh by the template itself,
    // which is why these map onto it without a translation table. There is no
    // separate "extra high" here because the template treats it as high, and
    // two rows that do the same thing is a menu that lies.
    reasoningEfforts: ["off", "low", "medium", "high"],
    // Qwen's own recommended settings. The instruct set is the one that changes
    // materially: a presence penalty of 1.5 is what keeps the non-thinking mode
    // from looping, and it would flatten the thinking mode if applied to both.
    sampling: {
      thinking: { temperature: 1.0, topP: 0.95, topK: 20, minP: 0.0, presencePenalty: 0.0, repetitionPenalty: 1.0 },
      instruct: { temperature: 0.7, topP: 0.80, topK: 20, minP: 0.0, presencePenalty: 1.5, repetitionPenalty: 1.0 },
    },
  },
  {
    id: "gemma4-e4b-uncensored",
    kind: "chat",
    displayName: "Gemma 4 E4B Uncensored",
    hfRepo: "HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive",
    hfRevision: "45b6a334b4bcd1d7f37179df58b3b1d66a184e5d",
    // The upper rungs are this repository's own K_P builds; it does not publish
    // a plain Q6_K or Q8_0. No MTP: the GGUFs carry no head and the repository
    // ships no drafter, and Google's E4B drafter was trained against the
    // safety-trained weights, not this rebuild.
    quants: [
      {
        quant: "Q4_K_M",
        files: [{
          name: "Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf",
          bytes: 5_335_285_728,
          sha256: "d0027dd3a9128d9323e9f282c8bf010a8526c46477584535991dc1a869b56e96",
        }],
      },
      {
        quant: "Q3_K_M",
        files: [{
          name: "Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q3_K_M.gguf",
          bytes: 4_850_391_008,
          sha256: "a60db97bb4f61f0167d64f369c198428b2bb10a636b6f339f2f947ac40202a98",
        }],
      },
      {
        quant: "Q5_K_M",
        files: [{
          name: "Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q5_K_M.gguf",
          bytes: 5_762_908_128,
          sha256: "c96f1afc2af92bb27b1d5057fd91c8f6e41e9a72f9f32faa389e1601a6963ee6",
        }],
      },
      {
        quant: "Q6_K_P",
        files: [{
          name: "Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q6_K_P.gguf",
          bytes: 6_249_794_528,
          sha256: "f28b0ae262158af10d847c3f01bfdb943161dd31320f3aed20775ee2ad6c67a6",
        }],
      },
      {
        quant: "Q8_K_P",
        files: [{
          name: "Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf",
          bytes: 8_133_226_464,
          sha256: "a4c4177f9fd7e3f56522675afb742f079a53f9226195b7db5e9888c872f053da",
        }],
      },
    ],
    minRamGB: 12,
    role: uncensoredChatRole,
    ...gemmaReasoning,
    uncensored: true,
  },
  {
    id: "qwen38-27b-abliterated",
    kind: "chat",
    displayName: "Qwen3.8 27B Abliterated",
    hfRepo: "Blackfrost-AI/Qwen3.8-27B-ABLITERATED-GGUF",
    hfRevision: "4f6732ce2123ced5d9df722a934f700619e066a8",
    // The plain K-quant ladder, Q4_K_M first as the card's own default. The
    // repository also publishes vision projectors; they are left out because
    // chat here is text-only and an mmproj nobody loads is a gigabyte of
    // download for nothing. Pinned at the August 16 re-upload, which is the
    // first revision of this build to keep Qwen's MTP head in the weights.
    quants: [
      {
        quant: "Q4_K_M",
        files: [{
          name: "Qwen3.8-27B-ABLITERATED-Q4_K_M.gguf",
          bytes: 16_810_716_384,
          sha256: "5d53637a59cfcd3a4d8354e254ffd44943e5a693da2405a3e228c62962355509",
        }],
      },
      {
        quant: "Q3_K_M",
        files: [{
          name: "Qwen3.8-27B-ABLITERATED-Q3_K_M.gguf",
          bytes: 13_500_738_784,
          sha256: "18580f97cc179c2042ccca8ec52fa32921255ade624b5e28b69733c36ce4de2f",
        }],
      },
      {
        quant: "Q5_K_M",
        files: [{
          name: "Qwen3.8-27B-ABLITERATED-Q5_K_M.gguf",
          bytes: 19_535_703_264,
          sha256: "37e02edc312a35e73eca50ae26d72458f341e17427eeb1724d9927723256c49c",
        }],
      },
      {
        quant: "Q6_K",
        files: [{
          name: "Qwen3.8-27B-ABLITERATED-Q6_K.gguf",
          bytes: 22_431_001_824,
          sha256: "34264197c0188b1b09da05692fcdd4625b7d2231d40b07a4b29836bdb7b4d2a1",
        }],
      },
      {
        quant: "Q8_0",
        files: [{
          name: "Qwen3.8-27B-ABLITERATED-Q8_0.gguf",
          bytes: 29_047_086_304,
          sha256: "c01b61cf17a2ca61ed1476d0910f652388279fa91f0c223721a391457787cf39",
        }],
      },
    ],
    minRamGB: 32,
    // `qwen35.nextn_predict_layers = 1` with block 64 present in every
    // quantization at this revision; the earlier upload had stripped it.
    mtp: true,
    role: {
      label: "Security agentic",
      detail: "Security and offensive research, with tool calling solid enough for agentic runs.",
    },
    reasoning: true,
    // No "high" here, unlike the stock Qwen3.8 above. This build's template
    // dropped the line that remaps `high` onto `xhigh`, so anything outside
    // low/medium/xhigh raises out of the template and the request fails. The
    // ladder stops at medium rather than offering a level that errors.
    reasoningEfforts: ["off", "low", "medium"],
    // The card serves it with one set of numbers and says nothing about a
    // separate non-thinking set, so both slots point at the same thing.
    sampling: {
      thinking: { temperature: 1.0, topP: 0.95, topK: 20, minP: 0.0, presencePenalty: 0.0, repetitionPenalty: 1.0 },
      instruct: { temperature: 1.0, topP: 0.95, topK: 20, minP: 0.0, presencePenalty: 0.0, repetitionPenalty: 1.0 },
    },
    uncensored: true,
  },
  // Dictation weights stay at Q8_0, and it is the only quantization offered.
  // Transcription accuracy falls off sharply below it, and these models are
  // small enough that the saving is not worth hearing the difference in every
  // dictated sentence. Each needs its multimodal projector alongside the
  // weights; llama-server will not load the audio encoder without it.
  {
    id: "qwen3-asr-0.6b",
    kind: "dictation",
    displayName: "Qwen3 ASR 0.6B",
    hfRepo: "ggml-org/Qwen3-ASR-0.6B-GGUF",
    hfRevision: "928ab958557df9aa2ef1c93e0e83c7ad0933fae2",
    quants: [{
      quant: "Q8_0",
      files: [
        {
          name: "Qwen3-ASR-0.6B-Q8_0.gguf",
          bytes: 804_749_248,
          sha256: "bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971",
        },
        {
          name: "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
          bytes: 214_392_480,
          sha256: "41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d",
        },
      ],
    }],
    minRamGB: 8,
    reasoning: false,
  },
  {
    id: "qwen3-asr-1.7b",
    kind: "dictation",
    displayName: "Qwen3 ASR 1.7B",
    hfRepo: "ggml-org/Qwen3-ASR-1.7B-GGUF",
    hfRevision: "36a678687ba7d07a74ca70ccb0e36902e005fb80",
    quants: [{
      quant: "Q8_0",
      files: [
        {
          name: "Qwen3-ASR-1.7B-Q8_0.gguf",
          bytes: 2_165_034_944,
          sha256: "58e22d0532d4eacaf034cfac17a6fed159f37c41390c710186783be439d1fc57",
        },
        {
          name: "mmproj-Qwen3-ASR-1.7B-Q8_0.gguf",
          bytes: 355_709_344,
          sha256: "46c1d533af3f354ceb37ce855dbceff7da7fa7cf1e6a523df3b13440bd164c0d",
        },
      ],
    }],
    // Dictation runs beside the chat model, not instead of it, so the larger
    // transcriber is only comfortable once there is room for both.
    minRamGB: 16,
    reasoning: false,
  },
];

export function catalogModel(id: string): CatalogModel | null {
  return modelCatalog.find((entry) => entry.id === id) ?? null;
}

export function catalogModels(kind: CatalogModelKind): CatalogModel[] {
  return modelCatalog.filter((entry) => entry.kind === kind);
}

/**
 * The sampling to serve a model at, given how hard it is being asked to think.
 *
 * Effort decides which of the card's two sets applies, because "off" is exactly
 * the non-thinking mode the instruct numbers were published for. A model that
 * recommends nothing returns null and is left on the runtime's defaults.
 */
export function samplingFor(model: CatalogModel, effort: ReasoningEffort): SamplingProfile | null {
  if (!model.sampling) return null;
  return effort === "off" ? model.sampling.instruct : model.sampling.thinking;
}

/**
 * The effort a model actually runs at, or null to say nothing about it.
 *
 * Null rather than "off" for a model whose template does not read an effort:
 * "off" forces thinking off, and turning a dial nobody was offered into a
 * thinking switch is the one outcome a user could not have intended.
 *
 * A stored level this model does not offer falls back to one it does, keeping
 * whether the user wanted thinking at all. Only the degree fails to survive a
 * model that grades it differently: someone on "medium" who switches to a
 * model that only knows on and off means on, and taking the first offered
 * level instead would quietly turn their thinking off.
 */
export function effectiveEffort(model: CatalogModel, effort: ReasoningEffort): ReasoningEffort | null {
  const offered = model.reasoningEfforts;
  if (!offered || offered.length === 0) return null;
  if (offered.includes(effort)) return effort;
  const wantsThinking = effort !== "off";
  return offered.find((level) => (level !== "off") === wantsThinking) ?? offered[0];
}

/** The quantization a model comes as when nobody chooses one. */
export function defaultQuant(model: CatalogModel): CatalogQuant {
  return model.quants[0];
}

/** The named quantization, or null when the model does not offer it. */
export function modelQuant(model: CatalogModel, quant: string): CatalogQuant | null {
  return model.quants.find((entry) => entry.quant === quant) ?? null;
}

/** The weights llama-server loads: not the projector, not the drafting head. */
export function quantWeightsFile(quant: CatalogQuant): CatalogFile {
  return quant.files.find((file) => !/^(mmproj|mtp)-/i.test(file.name)) ?? quant.files[0];
}

/** The separate multi-token-prediction head, when the quant ships one. */
export function quantMtpFile(quant: CatalogQuant): CatalogFile | null {
  return quant.files.find((file) => /^mtp-/i.test(file.name)) ?? null;
}

/** Total download size of one quantization, which is what the user is agreeing to. */
export function catalogQuantBytes(quant: CatalogQuant): number {
  return quant.files.reduce((total, file) => total + file.bytes, 0);
}

/**
 * The revision-pinned download URL. Pinning to a commit rather than a branch
 * means the bytes behind this URL can never change under the recorded digest.
 */
export function catalogFileUrl(model: CatalogModel, file: CatalogFile): string {
  return `https://huggingface.co/${model.hfRepo}/resolve/${model.hfRevision}/${file.name}`;
}
