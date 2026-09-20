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

import { resolveReasoningEffort } from "../shared/desktopApi";
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
   * Whether llama-server drafts from this model's multi-token-prediction head.
   * Dense models only: a mixture-of-experts already decodes cheaply, and
   * drafting from its head is a net loss. The head is either inside the GGUF
   * — Qwen3.5-family dense builds ship it as an extra block — or the `mtp-`
   * file listed among the quant's files. Recorded from the GGUF header or the
   * repository's file list, not assumed from the family: an abliterated
   * rebuild can drop the head, and a MoE can keep one we do not use.
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
  /**
   * Weights that were already in the models folder rather than fetched from
   * the catalog: a file someone downloaded from Hugging Face themselves, or a
   * model this collection does not offer. There is no repository behind them,
   * so there is nothing to download and nothing to verify against — they are
   * listed because they are here, and running them is the user's call.
   */
  discovered?: boolean;
  /**
   * Where the files actually live, when that is not the directory named after
   * the model's id. Only discovered models set it: a loose GGUF sits in the
   * models folder itself, and a folder somebody made is named whatever they
   * named it.
   */
  localDirectory?: string;
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

// Vision encoders from the same pinned revisions as their language weights.
const gemmaE2bProjector: CatalogFile = {
  name: "mmproj-BF16.gguf",
  bytes: 986_833_728,
  sha256: "a402f10fb5780bf91d03a10cd89061139f522bee2e679b1291bbfdcd71d9547d",
};

const ornith9bProjector: CatalogFile = {
  name: "mmproj-Ornith-1.5-9B-BF16.gguf",
  bytes: 921_704_672,
  sha256: "626f9f90627402a6bf4a999111d0fbd69b5fcca7aa8ba089d69e5f10e8858e1d",
};

const ornith35bProjector: CatalogFile = {
  name: "mmproj-Ornith-1.5-35B-BF16.gguf",
  bytes: 902_822_016,
  sha256: "d9ce31026d1cb1f3f8d5152e2e2a014d9d2b302b6c93a7dc07bb0a0487f52837",
};

const qwen27bProjector: CatalogFile = {
  name: "mmproj-BF16.gguf",
  bytes: 931_146_432,
  sha256: "83ee4f4f205fa514161778c41df1ea14144faa0f713510893b63c2395f5c2d53",
};

const qwenUncensoredProjector: CatalogFile = {
  name: "mmproj-model-bf16.gguf",
  bytes: 931_145_888,
  sha256: "42cee4f70c7c26bee4dc7e59872ceab4c67d1f6b2c87d9c32725ba1e2eaa9a4d",
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
        }, gemmaE2bProjector],
      },
      {
        quant: "Q5_K_M",
        files: [{
          name: "gemma-4-E2B-it-Q5_K_M.gguf",
          bytes: 3_356_037_216,
          sha256: "90293b8cdaf9c973012bf4df8a1e92bde7d74ad66a4fe56cf905ccd563d660c5",
        }, gemmaE2bProjector],
      },
      {
        quant: "Q6_K",
        files: [{
          name: "gemma-4-E2B-it-Q6_K.gguf",
          bytes: 4_501_721_184,
          sha256: "f7b8980ecc1c115898fd8d9a3d421d90becbac984194a44b478669c26815843d",
        }, gemmaE2bProjector],
      },
      {
        quant: "Q8_0",
        files: [{
          name: "gemma-4-E2B-it-Q8_0.gguf",
          bytes: 5_048_352_864,
          sha256: "605d3c2647d7c58c1e4b5375ccb5702acf94c2611b4c8d4877812f8fdd32d053",
        }, gemmaE2bProjector],
      },
    ],
    minRamGB: 8,
    role: chatOnlyRole,
    ...gemmaReasoning,
  },
  {
    id: "ornith-1.5-9b",
    kind: "chat",
    displayName: "Ornith 1.5 9B",
    hfRepo: "ornith-ai/Ornith-1.5-9B-GGUF",
    hfRevision: "abdd624b12ebf020b767fff532ff44fe552b28c3",
    // The same four rungs the 35B offers. The BF16 is left out at 18.4 GB, and
    // its vision projector is included with every quantization.
    quants: [
      {
        quant: "Q4_K_M",
        files: [{
          name: "Ornith-1.5-9B-Q4_K_M.gguf",
          bytes: 5_780_090_816,
          sha256: "70c112196e0b7023803c9762752e46d29e612a92c83f995bc3ba1ceb07e8fab6",
        }, ornith9bProjector],
      },
      {
        quant: "Q5_K_M",
        files: [{
          name: "Ornith-1.5-9B-Q5_K_M.gguf",
          bytes: 6_642_544_576,
          sha256: "e4d9634a3b6546a5c00a8680568fe1125f6c98c704ee51ae52ba07650fb4247d",
        }, ornith9bProjector],
      },
      {
        quant: "Q6_K",
        files: [{
          name: "Ornith-1.5-9B-Q6_K.gguf",
          bytes: 7_558_901_696,
          sha256: "b6f76e74f86245b3caee014b797c10dca931c4dfdaabfb134eab655f81e4154a",
        }, ornith9bProjector],
      },
      {
        quant: "Q8_0",
        files: [{
          name: "Ornith-1.5-9B-Q8_0.gguf",
          bytes: 9_786_060_384,
          sha256: "22086870b009dbe9815ee752c48a82de930118a7c5ce5599590892ae03b8b010",
        }, ornith9bProjector],
      },
    ],
    // The Q4_K_M is 5.8 GB, which leaves room for a working context on an 8 GB
    // card. This is the model an ordinary machine is pointed at.
    minRamGB: 8,
    role: {
      label: "Light agentic",
      detail: "Thinks before answering and calls tools. Small enough for a laptop, and fine for short agentic runs.",
    },
    // Dense, and the drafting head is inside the weights: the GGUF header at
    // this revision carries `qwen35.nextn_predict_layers = 1` and no
    // `expert_count`. Read from the file rather than assumed from the family.
    mtp: true,
    reasoning: true,
    // Its template reads `enable_thinking` and never `reasoning_effort`, so the
    // choice is binary — the 35B and Gemma are the same.
    reasoningEfforts: ["off", "on"],
    // The card's numbers for general tasks, in both slots. Its second set is
    // for "precise coding" — a distinction about the work rather than about
    // whether the model is thinking, and this app has no dial that means it.
    // That set is temperature 0.6 with no presence penalty, if the general
    // one's penalty of 1.5 ever proves wrong for code here.
    sampling: {
      thinking: { temperature: 1.0, topP: 0.95, topK: 20, minP: 0.0, presencePenalty: 1.5, repetitionPenalty: 1.0 },
      instruct: { temperature: 1.0, topP: 0.95, topK: 20, minP: 0.0, presencePenalty: 1.5, repetitionPenalty: 1.0 },
    },
  },
  {
    id: "ornith-1.5-35b-a3b",
    kind: "chat",
    displayName: "Ornith 1.5 35B A3B",
    hfRepo: "ornith-ai/Ornith-1.5-35B-A3B-GGUF",
    hfRevision: "5ae357e3eaf951ae221e8d784c71a8a3cdb6aa5f",
    // The repository's own ladder starts at Q4_K_M; there is no Q3_K_M, and
    // the 71 GB BF16 language weights are left out. The files drop
    // "A3B" from their names, as the repository spells them.
    quants: [
      {
        quant: "Q4_K_M",
        files: [{
          name: "Ornith-1.5-35B-Q4_K_M.gguf",
          bytes: 21_713_462_848,
          sha256: "ca6ea26329c88b78ffd90a85163be2e746c2fafd1024f56db47e499f117f9a7f",
        }, ornith35bProjector],
      },
      {
        quant: "Q5_K_M",
        files: [{
          name: "Ornith-1.5-35B-Q5_K_M.gguf",
          bytes: 25_347_532_352,
          sha256: "2ac3a45979ffbdff1c7a6f3334e6d4c347274adbc33531d23bde6fa1dfdcb994",
        }, ornith35bProjector],
      },
      {
        quant: "Q6_K",
        files: [{
          name: "Ornith-1.5-35B-Q6_K.gguf",
          bytes: 29_208_731_200,
          sha256: "1c4e5bb98a74c89a5d93a2488b5748b7b331daf77f6dbb64bd9b2ff864b64eb3",
        }, ornith35bProjector],
      },
      {
        quant: "Q8_0",
        files: [{
          name: "Ornith-1.5-35B-Q8_0.gguf",
          bytes: 37_802_149_120,
          sha256: "854cf83f80cd37a061ed86df1fa7201162e4e1fb820b91068cc12a11d2746c9e",
        }, ornith35bProjector],
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
    // The GGUF carries a nextn head in block 40, but this is a
    // mixture-of-experts: 3B active params already decode cheaply, and
    // drafting from that head is a net loss. MTP is for dense models.
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
        }, qwen27bProjector],
      },
      {
        quant: "Q5_K_M",
        files: [{
          name: "Qwen3.8-27B-Q5_K_M.gguf",
          bytes: 19_834_055_648,
          sha256: "07deb7fa91bf751d3000774fe5bb8afae5ffb41255fd19980147468052e07177",
        }, qwen27bProjector],
      },
      {
        quant: "Q6_K",
        files: [{
          name: "Qwen3.8-27B-Q6_K.gguf",
          bytes: 22_884_408_288,
          sha256: "562fbf760503008f118e5df38de5b3e97992d1f693f475815631198547486727",
        }, qwen27bProjector],
      },
      {
        quant: "Q8_0",
        files: [{
          name: "Qwen3.8-27B-Q8_0.gguf",
          bytes: 29_047_086_048,
          sha256: "a680f44a06920e5d689774823782006aa3acc8db95750323373b24139b67e348",
        }, qwen27bProjector],
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
    // The id is the folder these weights already live in on disk, so it keeps
    // the build's own name. "Obliterated" is what the upstream rebuild is
    // called, not something a reader of this list has to know; the name shown
    // says what the model is.
    id: "qwen38-27b-obliterated",
    kind: "chat",
    displayName: "Qwen3.8 27B Uncensored",
    hfRepo: "OBLITERATUS/Qwen3.8-27B-OBLITERATED",
    hfRevision: "e335d239dbdfae590687e24b800e81a18d070ebe",
    // One repository holding both the safetensors and its own GGUF builds,
    // which is why the server's catalog and this one name the same place. The
    // vision projector is included; the BF16 language weights the server serves
    // are left out. IQ4_XS sits below Q4_K_M rather than a Q3: it is
    // the smallest rung this build publishes, and an importance-weighted
    // four-bit holds together where a three-bit K-quant of a 27B does not.
    quants: [
      {
        quant: "Q4_K_M",
        files: [{
          name: "Qwen3.8-27B-OBLITERATED-Q4_K_M.gguf",
          bytes: 16_810_714_400,
          sha256: "da5da0b87a1501815f659a89641c75cff46cee722de0943a8fc136d39f654540",
        }, qwenUncensoredProjector],
      },
      {
        quant: "IQ4_XS",
        files: [{
          name: "Qwen3.8-27B-OBLITERATED-IQ4_XS.gguf",
          bytes: 15_420_450_080,
          sha256: "c8665fafeb02d67c13cde4fa4e2d62f922938962e373d07f7159358b3629fdbb",
        }, qwenUncensoredProjector],
      },
      {
        quant: "Q5_K_M",
        files: [{
          name: "Qwen3.8-27B-OBLITERATED-Q5_K_M.gguf",
          bytes: 19_535_701_280,
          sha256: "c52cc63130efda07259a62bb4081b1f0dac7c20564909eb02aafd64cb4d84f2c",
        }, qwenUncensoredProjector],
      },
      {
        quant: "Q6_K",
        files: [{
          name: "Qwen3.8-27B-OBLITERATED-Q6_K.gguf",
          bytes: 22_430_999_840,
          sha256: "d8de48c8de37c6238c24a719238e377f94ff1b51c8192029dbfba0a778debcd4",
        }, qwenUncensoredProjector],
      },
      {
        quant: "Q8_0",
        files: [{
          name: "Qwen3.8-27B-OBLITERATED-Q8_0.gguf",
          bytes: 29_047_084_320,
          sha256: "4cfb568f17fb58a0373279cc3b73602a350e25aea2953ce087dcea6b51fa6f3c",
        }, qwenUncensoredProjector],
      },
    ],
    minRamGB: 32,
    // `qwen35.nextn_predict_layers = 1`, and block 64 is present in the
    // Q4_K_M's tensor list — read from the GGUF header at this revision, not
    // assumed from Qwen3.8. The abliteration kept the head.
    mtp: true,
    role: {
      label: "Security agentic",
      detail: "Security and offensive research, with tool calling solid enough for agentic runs.",
    },
    reasoning: true,
    // Its template resolves `reasoning_effort` against xhigh, medium and low,
    // and raises out of the template on anything else — "high" included, which
    // stock Qwen3.8 remaps and this build does not. The ladder stops at medium
    // rather than offering a level that errors.
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
 * The fallback for a level this model does not offer lives in the shared
 * resolver, so the composer's menu checks the same row this starts the model
 * with.
 */
export function effectiveEffort(model: CatalogModel, effort: ReasoningEffort): ReasoningEffort | null {
  return resolveReasoningEffort(model.reasoningEfforts, effort);
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

/** The vision or audio encoder accompanying the language weights. */
export function quantProjectorFile(quant: CatalogQuant): CatalogFile | null {
  return quant.files.find((file) => /^mmproj-/i.test(file.name)) ?? null;
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
