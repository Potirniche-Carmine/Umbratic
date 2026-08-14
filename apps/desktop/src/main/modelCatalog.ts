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

export type CatalogModelKind = "chat" | "dictation";

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
   * The memory this model wants to be comfortable in. Nothing is withheld
   * because of it — the list stays complete and every row stays selectable —
   * it only decides which row is suggested and what the size hint says.
   */
  minRamGB: number;
  /**
   * Whether the model has thinking to direct. Veil drops a thinking directive
   * for a model without it, so a wrong value here is a silently ignored
   * instruction rather than an error.
   */
  reasoning: boolean;
  /**
   * Models with the safety training removed. Offered deliberately, never
   * suggested: a recommendation is what someone gets without choosing, and
   * this is a choice worth making on purpose.
   */
  uncensored?: boolean;
};

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
        }],
      },
      {
        quant: "Q3_K_M",
        files: [{
          name: "gemma-4-E2B-it-Q3_K_M.gguf",
          bytes: 2_536_786_016,
          sha256: "086e2f5ba85057f8f19712e3160a644728f74f323c9feeac4cd73fab11b43085",
        }],
      },
      {
        quant: "Q5_K_M",
        files: [{
          name: "gemma-4-E2B-it-Q5_K_M.gguf",
          bytes: 3_356_037_216,
          sha256: "90293b8cdaf9c973012bf4df8a1e92bde7d74ad66a4fe56cf905ccd563d660c5",
        }],
      },
      {
        quant: "Q6_K",
        files: [{
          name: "gemma-4-E2B-it-Q6_K.gguf",
          bytes: 4_501_721_184,
          sha256: "f7b8980ecc1c115898fd8d9a3d421d90becbac984194a44b478669c26815843d",
        }],
      },
      {
        quant: "Q8_0",
        files: [{
          name: "gemma-4-E2B-it-Q8_0.gguf",
          bytes: 5_048_352_864,
          sha256: "605d3c2647d7c58c1e4b5375ccb5702acf94c2611b4c8d4877812f8fdd32d053",
        }],
      },
    ],
    minRamGB: 8,
    reasoning: false,
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
        }],
      },
      {
        quant: "Q3_K_M",
        files: [{
          name: "gemma-4-E4B-it-Q3_K_M.gguf",
          bytes: 4_058_137_728,
          sha256: "0980898d0e7d9c75cea05141bf4010393312101ef6cf5b31f8197e0de18655f4",
        }],
      },
      {
        quant: "Q5_K_M",
        files: [{
          name: "gemma-4-E4B-it-Q5_K_M.gguf",
          bytes: 5_481_798_784,
          sha256: "a5d6e634db151368d2caa4270fd32ab604d96c2d1291950586989f46d8e17d36",
        }],
      },
      {
        quant: "Q6_K",
        files: [{
          name: "gemma-4-E4B-it-Q6_K.gguf",
          bytes: 7_074_929_792,
          sha256: "fd83f3ef44d22e00ff0f638753dde9a66a83e8ccf79c11024f47d383c489531b",
        }],
      },
      {
        quant: "Q8_0",
        files: [{
          name: "gemma-4-E4B-it-Q8_0.gguf",
          bytes: 8_192_953_472,
          sha256: "f8854aa4480df62585a279e7ca0a881554fc18a41c59c4f62642d16a2ae47012",
        }],
      },
    ],
    minRamGB: 12,
    reasoning: false,
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
        }],
      },
      {
        quant: "Q3_K_M",
        files: [{
          name: "gemma-4-12b-it-Q3_K_M.gguf",
          bytes: 5_693_872_960,
          sha256: "dbf58f4c413b82b27106867eb42f7087e4172a172f6f201e2e11598a6582e504",
        }],
      },
      {
        quant: "Q5_K_M",
        files: [{
          name: "gemma-4-12b-it-Q5_K_M.gguf",
          bytes: 8_413_576_000,
          sha256: "32c554c7d1338a23837ae39b3db482213a4a642f96df3b2619f516a2375d16cd",
        }],
      },
      {
        quant: "Q6_K",
        files: [{
          name: "gemma-4-12b-it-Q6_K.gguf",
          bytes: 9_786_022_720,
          sha256: "6f394336500bb5409bd68c31aa9d75097b5e6104f6cf30c82a09a7b64df41faf",
        }],
      },
      {
        quant: "Q8_0",
        files: [{
          name: "gemma-4-12b-it-Q8_0.gguf",
          bytes: 12_669_647_680,
          sha256: "f20e7ff1be28c283eeeb18fc895733791c56a5851d5cd3fe9691b7f7d12afa72",
        }],
      },
    ],
    minRamGB: 16,
    reasoning: false,
  },
  {
    id: "qwen36-27b",
    kind: "chat",
    displayName: "Qwen3.6 27B",
    hfRepo: "unsloth/Qwen3.6-27B-GGUF",
    hfRevision: "82d411acf4a06cfb8d9b073a5211bf410bfc29bf",
    quants: [
      {
        quant: "Q4_K_M",
        files: [{
          name: "Qwen3.6-27B-Q4_K_M.gguf",
          bytes: 16_817_244_384,
          sha256: "5ed60d0af4650a854b1755bd392f9aef4872643dc25a254bc68043fa638392a0",
        }],
      },
      {
        quant: "Q3_K_M",
        files: [{
          name: "Qwen3.6-27B-Q3_K_M.gguf",
          bytes: 13_586_217_184,
          sha256: "bdfa99d488b501f5ca711f35c930f005319a064eabcaae23290571a25c499eeb",
        }],
      },
      {
        quant: "Q5_K_M",
        files: [{
          name: "Qwen3.6-27B-Q5_K_M.gguf",
          bytes: 19_509_790_944,
          sha256: "cfecab168156269f25d5ffe9e13cf2a401ca2f43a9693fa00bcd1625316ccbde",
        }],
      },
      {
        quant: "Q6_K",
        files: [{
          name: "Qwen3.6-27B-Q6_K.gguf",
          bytes: 22_523_238_624,
          sha256: "ec1805fe87e6519c461c1ed2d179865464a875ed241032ead65a354f979cfe14",
        }],
      },
      {
        quant: "Q8_0",
        files: [{
          name: "Qwen3.6-27B-Q8_0.gguf",
          bytes: 28_595_763_424,
          sha256: "f93f517f38e696d35a1a7df2c0e3155a64f4c4dcd662107a146ae263f7fb14ce",
        }],
      },
    ],
    minRamGB: 32,
    reasoning: true,
  },
  {
    id: "gemma4-e4b-uncensored",
    kind: "chat",
    displayName: "Gemma 4 E4B Uncensored",
    hfRepo: "HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive",
    hfRevision: "45b6a334b4bcd1d7f37179df58b3b1d66a184e5d",
    // The upper rungs are this repository's own K_P builds; it does not publish
    // a plain Q6_K or Q8_0.
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
    reasoning: false,
    uncensored: true,
  },
  {
    id: "qwen36-27b-uncensored",
    kind: "chat",
    displayName: "Qwen3.6 27B Uncensored",
    hfRepo: "DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-NEO-MAX-MTP-GGUF",
    hfRevision: "4106c6bd31bb0f7cd5fa3624b65eb198ed606c54",
    // IQ4_XS leads rather than Q4_K_M: this repository publishes the 27B at
    // that quantization as its balance point, and it lands at a comparable
    // size and quality.
    quants: [
      {
        quant: "IQ4_XS",
        files: [{
          name: "Qwen3.6-27B-Fable-Fus-711-UnHeretic-NM-DAU-NEO-MAX-NEO-IQ4_XS.gguf",
          bytes: 16_582_361_632,
          sha256: "d1175dc3668e8edcc922c790918e2123029aaf7697d706df65f8e088864b397c",
        }],
      },
      {
        quant: "IQ3_M",
        files: [{
          name: "Qwen3.6-27B-Fable-Fus-711-UnHeretic-NM-DAU-NEO-MAX-NEO-IQ3_M.gguf",
          bytes: 14_080_729_632,
          sha256: "4408a4815176070afb560ddadcf5883f524e159056e7e830274777a3a9c9b176",
        }],
      },
      {
        quant: "Q4_K_M",
        files: [{
          name: "Qwen3.6-27B-Fable-Fus-711-UnHeretic-NM-DAU-NEO-MAX-NEO-Q4_K_M.gguf",
          bytes: 18_047_255_072,
          sha256: "8440f2a076f149f65bf16975f3a08359936ba2658fc1827b51a30b717de49acb",
        }],
      },
      {
        quant: "Q5_K_M",
        files: [{
          name: "Qwen3.6-27B-Fable-Fus-711-UnHeretic-NM-DAU-NEO-MAX-NEO-Q5_K_M.gguf",
          bytes: 20_730_954_272,
          sha256: "8b92b4cdd0a0cdd1bb12f6568a41ae12ad4f0d0818d12e89bf89ecb2c0876860",
        }],
      },
      {
        quant: "Q6_K",
        files: [{
          name: "Qwen3.6-27B-Fable-Fus-711-UnHeretic-NM-DAU-NEO-MAX-NEO-Q6_K.gguf",
          bytes: 23_582_384_672,
          sha256: "f1e1b337fda4ec8e39974f69a385f970381488e9bb41d039d85959aeb5350457",
        }],
      },
    ],
    minRamGB: 32,
    reasoning: true,
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
    minRamGB: 12,
    reasoning: false,
  },
];

export function catalogModel(id: string): CatalogModel | null {
  return modelCatalog.find((entry) => entry.id === id) ?? null;
}

export function catalogModels(kind: CatalogModelKind): CatalogModel[] {
  return modelCatalog.filter((entry) => entry.kind === kind);
}

/** The quantization a model comes as when nobody chooses one. */
export function defaultQuant(model: CatalogModel): CatalogQuant {
  return model.quants[0];
}

/** The named quantization, or null when the model does not offer it. */
export function modelQuant(model: CatalogModel, quant: string): CatalogQuant | null {
  return model.quants.find((entry) => entry.quant === quant) ?? null;
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
