/** The local model collection as the renderer sees it. */

export type LocalCatalogModelKind = "chat" | "dictation";

/** One quantization a model is offered at. */
export type LocalModelQuant = {
  /** Quantization label as the repository spells it, e.g. "Q4_K_M". */
  quant: string;
  bytes: number;
  /** The model's default: the balance point the collection stands behind. */
  recommended: boolean;
  downloaded: boolean;
};

/**
 * One row of the local model list. No repository, revision, URL, checksum, or
 * file path: the renderer picks between models and watches downloads, and none
 * of those would help it do either. `bytes`, `downloaded`, and the download
 * action all follow `selectedQuant` — the row is always about one concrete
 * download.
 */
export type LocalCatalogModel = {
  id: string;
  kind: LocalCatalogModelKind;
  displayName: string;
  bytes: number;
  minRamGB: number;
  recommended: boolean;
  /** Safety training removed. Shown, never suggested. */
  uncensored: boolean;
  /**
   * What the model is for, in a tag and a sentence. Absent for dictation
   * weights, which are chosen by size, and for models added from a Hugging
   * Face reference, which this collection has never read the card for.
   */
  role?: { label: string; detail: string };
  /** Added by the user from a Hugging Face reference, so it can be removed too. */
  custom: boolean;
  selectedQuant: string;
  quants: LocalModelQuant[];
  downloaded: boolean;
  downloading: boolean;
};

/** Progress for one download. `verifying` is the checksum pass, which on a
 * nine-gigabyte file is long enough that silence would read as a stall. */
export type ModelDownloadEvent = {
  id: string;
  receivedBytes: number;
  totalBytes: number;
  state: "downloading" | "verifying" | "done" | "cancelled" | "error";
};
