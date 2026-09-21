/** The local model collection as the renderer sees it. */

export type LocalCatalogModelKind = "chat" | "dictation" | "image";

/**
 * How a download sits in this machine's memory: room to spare, will run but
 * short of memory, or more than the machine has. Shown on every row rather
 * than used to hide any — what runs slowly is the user's call, made knowing.
 */
export type LocalMemoryFit = "comfortable" | "tight" | "exceeds";

/** One quantization a model is offered at. */
export type LocalModelQuant = {
  /** Quantization label as the repository spells it, e.g. "Q4_K_M". */
  quant: string;
  bytes: number;
  /** The model's default: the balance point the collection stands behind. */
  recommended: boolean;
  downloaded: boolean;
  fit: LocalMemoryFit;
  /** The memory this quantization wants to be comfortable in. */
  neededRamGB: number;
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
  /** Included in `bytes`: image components reused by every quantization. */
  sharedBytes?: number;
  /** The suggestion for this machine: the most capable model it runs comfortably. */
  recommended: boolean;
  /** Safety training removed. Shown, never suggested. */
  uncensored: boolean;
  /** Dense model that drafts from its multi-token-prediction head when MTP is on. */
  mtp: boolean;
  /**
   * What the model is for, in a tag and a sentence. Absent for dictation
   * weights, which are chosen by size, and for models added from a Hugging
   * Face reference, which this collection has never read the card for.
   */
  role?: { label: string; detail: string };
  /** Added by the user from a Hugging Face reference, so it can be removed too. */
  custom: boolean;
  /**
   * Found in the models folder rather than downloaded here: nothing was
   * reviewed, verified, or pinned, and there is nothing to fetch.
   */
  discovered: boolean;
  selectedQuant: string;
  quants: LocalModelQuant[];
  /** The fit of `selectedQuant`, repeated here so the row need not look it up. */
  fit: LocalMemoryFit;
  neededRamGB: number;
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
