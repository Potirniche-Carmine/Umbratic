import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Download, FolderOpen, HardDrive, Loader2, Plus, PowerOff, Star, Trash2, X } from "lucide-react";

import type { DesktopApi, LocalCatalogModel, LocalMemoryFit, LocalModelQuant, ModelDownloadEvent } from "../shared/desktopApi";

/**
 * The local model collection, shared by Connection (chat) and Voice (dictation).
 *
 * The whole collection lives in one dropdown: the trigger names the model that
 * runs, and the menu holds every model — a downloaded one is picked by
 * clicking its row, one that is not here yet offers its download instead, and
 * each row carries its quantization choice because the quant decides what the
 * download button actually fetches. Downloaded models lead the list.
 *
 * Every model in the catalog is offered and every one can be downloaded. A
 * machine with less memory than a model wants still sees the full list — what
 * runs slowly on someone's hardware is their call.
 */

function formatBytes(bytes: number): string {
  const gigabytes = bytes / 1_000_000_000;
  if (gigabytes >= 1) return `${gigabytes.toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * What a row says about how it sits in this machine's memory. Nothing when it
 * fits: the ordinary case should not shout, and a list where every row carries
 * a verdict is a list where none of them reads. The other two are said with
 * the number, because "too large" begs the question "how large is enough".
 */
function MemoryFitNote({ fit, neededRamGB }: { fit: LocalMemoryFit; neededRamGB: number }) {
  if (fit === "comfortable") return null;
  return (
    <span className={`localModelFit is-${fit}`}>
      {fit === "tight" ? `Tight fit · best with ${neededRamGB} GB` : `Needs ${neededRamGB} GB of memory`}
    </span>
  );
}

export function useLocalModelCatalog(api: DesktopApi, kind: "chat" | "dictation" | "image", active: boolean) {
  const [models, setModels] = useState<LocalCatalogModel[]>([]);
  const [progress, setProgress] = useState<ModelDownloadEvent | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const rows = await api.listLocalModels({ kind }).catch(() => [] as LocalCatalogModel[]);
    setModels(rows);
  }, [api, kind]);

  useEffect(() => {
    if (!active) return;
    void reload();
    // The models folder is openable from this panel, and the obvious thing to
    // do with an open folder is to put a file in it. Coming back to the window
    // is when that file should appear in the list, so the folder is read again
    // on focus rather than only when the panel opens.
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, reload]);

  useEffect(() => {
    return api.onModelDownloadEvent((event) => {
      setProgress(event.state === "downloading" || event.state === "verifying" ? event : null);
      // A finished, cancelled, or failed download changes what is on disk, so
      // the list is re-read rather than patched from the event.
      if (event.state !== "downloading" && event.state !== "verifying") void reload();
    });
  }, [api, reload]);

  const download = useCallback(async (id: string) => {
    setMessage(null);
    const result = await api.downloadLocalModel({ id }).catch(() => ({ ok: false as const, message: "The download failed." }));
    if (!result.ok) setMessage(result.message);
    await reload();
  }, [api, reload]);

  const cancel = useCallback(async (id: string) => {
    await api.cancelLocalModelDownload({ id }).catch(() => undefined);
  }, [api]);

  const setQuant = useCallback(async (id: string, quant: string) => {
    setMessage(null);
    const result = await api.setLocalModelQuant({ id, quant })
      .catch(() => ({ ok: false as const, message: "The quantization could not be changed." }));
    if (!result.ok) setMessage(result.message);
    await reload();
  }, [api, reload]);

  const addCustom = useCallback(async (reference: string): Promise<boolean> => {
    setMessage(null);
    const result = await api.addCustomLocalModel({ reference })
      .catch(() => ({ ok: false as const, message: "The model could not be added." }));
    if (!result.ok) setMessage(result.message);
    await reload();
    return result.ok;
  }, [api, reload]);

  const removeCustom = useCallback(async (id: string) => {
    setMessage(null);
    const result = await api.removeCustomLocalModel({ id })
      .catch(() => ({ ok: false as const, message: "The model could not be removed." }));
    if (!result.ok) setMessage(result.message);
    await reload();
  }, [api, reload]);

  return { models, progress, message, download, cancel, setQuant, addCustom, removeCustom, reload };
}

/**
 * The per-row quantization picker. Its menu is fixed-positioned so it can
 * escape the scrolling model menu it sits inside.
 */
function QuantPicker({
  modelName,
  quants,
  sharedBytes = 0,
  selected,
  disabled,
  onSelect,
}: {
  modelName: string;
  quants: LocalModelQuant[];
  sharedBytes?: number;
  selected: string;
  disabled: boolean;
  onSelect: (quant: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuAt, setMenuAt] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!menuAt) return;
    const close = () => setMenuAt(null);
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };
    document.addEventListener("pointerdown", closeOutside);
    // Any scroll would leave a fixed menu floating over the wrong row.
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("scroll", close, true);
    };
  }, [menuAt]);

  if (quants.length < 2) return null;

  const menuWidth = 240;

  function toggleMenu() {
    if (menuAt) {
      setMenuAt(null);
      return;
    }
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Fixed-positioned so the scrolling model menu cannot clip it; flipped
    // above the trigger when the viewport below is too short for it.
    const menuHeight = quants.length * 32 + 12 + (sharedBytes ? 33 : 0);
    const top = rect.bottom + 5 + menuHeight > window.innerHeight
      ? Math.max(8, rect.top - menuHeight - 5)
      : rect.bottom + 5;
    setMenuAt({ top, left: Math.max(8, rect.right - menuWidth) });
  }

  function choose(quant: string) {
    setMenuAt(null);
    if (quant !== selected) onSelect(quant);
  }

  return (
    <div
      className={`quantPicker ${menuAt ? "isOpen" : ""}`}
      ref={rootRef}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        className="quantPickerTrigger"
        type="button"
        aria-expanded={!!menuAt}
        aria-haspopup="listbox"
        aria-label={`Quantization for ${modelName}`}
        disabled={disabled}
        onClick={toggleMenu}
        onKeyDown={(event) => { if (event.key === "Escape") setMenuAt(null); }}
      >
        <span>{selected}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {menuAt ? createPortal(
        // Portalled to <body>: an ancestor's backdrop-filter would otherwise
        // become the containing block and pull "fixed" out of viewport space.
        <div
          className="modelPickerMenu quantPickerMenu"
          ref={menuRef}
          style={{ position: "fixed", top: menuAt.top, left: menuAt.left, width: menuWidth }}
          role="listbox"
          aria-label={`Quantizations for ${modelName}`}
          onClick={(event) => event.stopPropagation()}
        >
          {quants.map((entry) => (
            <button
              key={entry.quant}
              className={`modelPickerOption quantPickerOption ${entry.downloaded ? "isDownloaded" : ""}`}
              type="button"
              role="option"
              aria-selected={entry.quant === selected}
              onClick={() => choose(entry.quant)}
            >
              <span className="modelPickerOptionName">{entry.quant}</span>
              {entry.recommended ? <Star className="quantPickerStar" size={11} aria-label="Recommended" /> : null}
              <span
                className={`quantPickerSize is-${entry.fit}`}
                title={entry.fit === "comfortable" ? undefined : `Wants ${entry.neededRamGB} GB of memory`}
              >
                {formatBytes(entry.bytes - sharedBytes)}
              </span>
              {/* Which quantizations are already on disk decides whether picking
                  one costs a download, so it is said in words rather than left
                  to a dot the user has to learn. */}
              <span className={`quantPickerHere ${entry.downloaded ? "" : "isAbsent"}`}>
                {entry.downloaded ? <HardDrive size={11} aria-hidden="true" /> : null}
                {entry.downloaded ? "On disk" : "Download"}
              </span>
              {entry.quant === selected ? <Check size={13} aria-hidden="true" /> : null}
            </button>
          ))}
          {sharedBytes ? <div className="quantPickerShared">Plus {formatBytes(sharedBytes)} shared files</div> : null}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

/** A custom model's remove control: one press to arm, a second to delete. */
function RemoveModelButton({ modelName, onRemove }: { modelName: string; onRemove: () => void }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  return (
    <button
      className={`settingsIconButton localModelRemove ${armed ? "isArmed" : ""}`}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        if (armed) onRemove();
        else setArmed(true);
      }}
      aria-label={armed ? `Confirm removing ${modelName}` : `Remove ${modelName}`}
      title={armed ? "Press again to remove the model and its files" : "Remove model"}
    >
      {armed ? <span className="localModelRemoveConfirm">Remove?</span> : <Trash2 size={13} />}
    </button>
  );
}

/**
 * A divider between the two halves of the menu.
 *
 * The label, a rule that runs to the edge, and how many rows are under it. The
 * rule is what does the work: it draws the line the eye needs when the list is
 * long enough to scroll, which a row of small caps on its own never did.
 */
function MenuSection({ title, count, tone }: { title: string; count: number; tone: "here" | "away" }) {
  return (
    <div className={`localModelSection is-${tone}`} aria-hidden="true">
      <span className="localModelSectionLabel">{title}</span>
      <span className="localModelSectionCount">{count}</span>
      <span className="localModelSectionRule" />
    </div>
  );
}

export type LocalModelMenuProps = {
  label: string;
  models: LocalCatalogModel[];
  progress: ModelDownloadEvent | null;
  selectedId: string;
  disabled: boolean;
  /** True while the picked model's weights are loading into the runtime. */
  loading?: boolean;
  /** True while the picked model's weights are resident and answering. */
  loaded?: boolean;
  placeholder: string;
  /** An extra first row, used by Voice for "Off". */
  leadingOption?: { id: string; label: string };
  onSelect: (id: string) => void;
  onDownload: (id: string) => void;
  onCancel: (id: string) => void;
  onQuantChange?: (id: string, quant: string) => void;
  onRemove?: (id: string) => void;
  /** Gives the resident weights back. Omitted where there is nothing to unload. */
  onUnload?: () => void;
};

export function LocalModelMenu({
  label,
  models,
  progress,
  selectedId,
  disabled,
  loading = false,
  loaded = false,
  placeholder,
  leadingOption,
  onSelect,
  onDownload,
  onCancel,
  onQuantChange,
  onRemove,
  onUnload,
}: LocalModelMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const selectedModel = models.find((model) => model.id === selectedId);
  const percent = progress && progress.totalBytes > 0
    ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
    : 0;
  const triggerText = leadingOption && selectedId === leadingOption.id
    ? leadingOption.label
    : selectedModel
      ? selectedModel.displayName
      : selectedId.trim() || null;

  function choose(id: string) {
    setOpen(false);
    // Always forwarded, even for the row that is already selected: picking
    // the shown model again is how a selected-but-unloaded model gets loaded.
    onSelect(id);
  }

  const rowKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    choose(id);
  };

  const renderRow = (model: LocalCatalogModel) => {
    const downloading = progress?.id === model.id;
    const selected = model.downloaded && selectedId === model.id;
    const quantPicker = onQuantChange ? (
      <QuantPicker
        modelName={model.displayName}
        quants={model.quants}
        sharedBytes={model.sharedBytes}
        selected={model.selectedQuant}
        disabled={disabled || downloading}
        onSelect={(quant) => onQuantChange(model.id, quant)}
      />
    ) : null;
    const removeButton = model.custom && onRemove && !downloading ? (
      <RemoveModelButton modelName={model.displayName} onRemove={() => onRemove(model.id)} />
    ) : null;
    // Facts about the model sit next to its name as quiet marks, not as pills.
    // Only what changes the choice: where the weights came from, and that a
    // build has had its safety training removed. "MTP" was here too and is
    // gone — it named an implementation detail of how the model decodes, which
    // is the toggle's business below the list, not a thing to weigh when
    // picking between two models.
    const traits = (
      <>
        {model.discovered ? (
          <span className="localModelTrait" title="Found in your models folder. Umbratic did not download or check these weights.">
            In your folder
          </span>
        ) : null}
        {model.uncensored ? <span className="localModelTrait">Uncensored</span> : null}
        {/* The suggestion is spent once it has been taken: the selected row
            already carries a tick and, while it is resident, an Unload button,
            and the pill was the thing squeezing its name into an ellipsis. */}
        {model.recommended && !selected ? <span className="localModelBadge">Recommended</span> : null}
      </>
    );
    // The line under the controls: what the model is for on the left, how it
    // sits in this machine's memory on the right. Size answers "will this
    // run"; the role answers "should I pick it", and they are not the same
    // question — a 3 GB model chosen for agentic work reads as a broken app
    // rather than as the wrong model. Given the row's full width, so a row
    // carrying a badge does not get a narrower sentence than the row above it.
    const under = model.role || model.sharedBytes || model.fit !== "comfortable" ? (
      <span className="localModelRowUnder">
        <span className="localModelRole">
          {model.role ? <strong>{model.role.label}</strong> : null}
          {model.role?.detail}
          {model.sharedBytes ? <span title="Text encoder and image decoder, downloaded once for all quantizations.">Shared files: {formatBytes(model.sharedBytes)} · Total: {formatBytes(model.bytes)}</span> : null}
        </span>
        <MemoryFitNote fit={model.fit} neededRamGB={model.neededRamGB} />
      </span>
    ) : null;

    if (downloading) {
      return (
        <div className="localModelRow isMenuRow" key={model.id}>
          <div className="localModelRowMain">
          <span className="localModelName">{model.displayName}</span>
          <span
            className="localModelProgress"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Downloading ${model.displayName}`}
          >
            <span className="localModelProgressFill" style={{ width: `${percent}%` }} />
          </span>
          <span className="localModelRowSide">
            <span className="localModelNote">
              {progress.state === "verifying" ? "Verifying" : `${percent}%`}
            </span>
            <span className="localModelAction">
              <button
                className="settingsIconButton"
                type="button"
                onClick={(event) => { event.stopPropagation(); onCancel(model.id); }}
                aria-label={`Cancel downloading ${model.displayName}`}
                title="Cancel"
              >
                <X size={14} />
              </button>
            </span>
          </span>
          </div>
          {under}
        </div>
      );
    }

    if (!model.downloaded) {
      return (
        <div className="localModelRow isMenuRow" key={model.id}>
          <div className="localModelRowMain">
          <span className="localModelName">{model.displayName}</span>
          {traits}
          <span className="localModelRowSide">
            {quantPicker}
            <span className="localModelNote">{formatBytes(model.bytes - (model.sharedBytes ?? 0))}</span>
            {removeButton}
            <span className="localModelAction">
              <button
                className="settingsIconButton"
                type="button"
                disabled={disabled || progress !== null}
                onClick={(event) => { event.stopPropagation(); onDownload(model.id); }}
                aria-label={`Download ${model.displayName}`}
                title={progress !== null ? "Another model is downloading" : "Download"}
              >
                <Download size={14} />
              </button>
            </span>
          </span>
          </div>
          {under}
        </div>
      );
    }

    return (
      <div
        className={`localModelRow isMenuRow isDownloaded isSelectable ${selected ? "isSelected" : ""}`}
        key={model.id}
        role="option"
        aria-selected={selected}
        tabIndex={0}
        onClick={() => { if (!disabled) choose(model.id); }}
        onKeyDown={(event) => { if (!disabled) rowKeyDown(event, model.id); }}
      >
        <div className="localModelRowMain">
        <span className="localModelName">{model.displayName}</span>
        {traits}
        {/* The controls keep to the right in one group, so the model's name
            gets whatever width is left instead of being the one thing that
            gives way to them and ends up as an ellipsis. */}
        <span className="localModelRowSide">
          {/* Unload lives on the model's own row rather than beside the
              trigger: only the selected model can be resident, and a
              control that appears and disappears next to the picker
              shifts the whole field out from under the cursor. */}
          {selected && onUnload && loaded && !loading ? (
            <button
              className="settingsInlineButton modelUnloadButton"
              type="button"
              disabled={disabled}
              onClick={(event) => { event.stopPropagation(); setOpen(false); onUnload(); }}
              title="Free the memory this model is using"
            >
              <PowerOff size={13} />
              <span>Unload</span>
            </button>
          ) : null}
          {quantPicker}
          <span className="localModelNote">{formatBytes(model.bytes - (model.sharedBytes ?? 0))}</span>
          {removeButton}
          <span className="localModelAction">
            {selected ? <Check className="localModelTick" size={14} /> : null}
          </span>
        </span>
        </div>
        {under}
      </div>
    );
  };

  // What is on this computer leads, under its own heading once there is
  // something below it to tell apart. A model a download away is an offer; one
  // that is here is a choice — and the two halves are far enough apart in
  // meaning that a faint line of small caps was not enough to keep them
  // apart while scrolling.
  const here = models.filter((model) => model.downloaded);
  const away = models.filter((model) => !model.downloaded);
  const sections = here.length === 0 || away.length === 0
    ? models.map(renderRow)
    : (
      <>
        <MenuSection title="On this computer" count={here.length} tone="here" />
        {here.map(renderRow)}
        <MenuSection title="Available to download" count={away.length} tone="away" />
        {away.map(renderRow)}
      </>
    );

  return (
    <div className="settingsField">
      <span>{label}</span>
      <div className={`modelPicker ${open ? "isOpen" : ""}`} ref={rootRef}>
        <button
          className="modelPickerTrigger"
          type="button"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={label}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
        >
          {/* Loading is a state of the model, not a different name for it, so
              the model keeps its name and the state is said beside it. */}
          {loading ? (
            <span className="modelPickerLoading">
              <Loader2 className="spin" size={13} aria-hidden="true" />
              <span className="modelPickerLoadingName">{triggerText ?? placeholder}</span>
              <span className="modelPickerLoadingNote">Loading</span>
            </span>
          ) : (
            <span className={triggerText ? "" : "isPlaceholder"}>{triggerText ?? placeholder}</span>
          )}
          <span className="localMenuTriggerSide">
            {!loading && loaded ? <span className="modelPickerLive">Loaded</span> : null}
            {!loading && selectedModel ? <span className="modelPickerBadge">{selectedModel.selectedQuant}</span> : null}
            {progress ? (
              <span className="localMenuTriggerProgress">
                <Loader2 className="spin" size={11} aria-hidden="true" />
                {progress.state === "verifying" ? "Verifying" : `${percent}%`}
              </span>
            ) : null}
            <ChevronDown size={14} aria-hidden="true" />
          </span>
        </button>
        {open ? (
          <div className="modelPickerMenu localModelMenu" role="listbox" aria-label={label}>
            {leadingOption ? (
              <div
                className="localModelRow isMenuRow isSelectable"
                role="option"
                aria-selected={selectedId === leadingOption.id}
                tabIndex={0}
                onClick={() => choose(leadingOption.id)}
                onKeyDown={(event) => rowKeyDown(event, leadingOption.id)}
              >
                <div className="localModelRowMain">
                  <span className="localModelName">{leadingOption.label}</span>
                  <span className="localModelAction">
                    {selectedId === leadingOption.id ? <Check className="localModelTick" size={14} /> : null}
                  </span>
                </div>
              </div>
            ) : null}

            {sections}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The dictation collection, laid out flat.
 *
 * Two models and an off switch do not need a dropdown: hiding three rows behind
 * a trigger costs a click to answer "what are my options" and another to answer
 * "which of them are downloaded". They are all shown instead, and the choice is
 * a radio group — which is what it has always been.
 *
 * The rows only choose. Loading is not a decision anyone makes here: the model
 * loads when the microphone is pressed and lets itself go a minute after the
 * last dictation, so there is nothing for a control on this list to do.
 */
export function DictationModelList({
  models,
  progress,
  selectedId,
  disabled,
  onSelect,
  onDownload,
  onCancel,
}: {
  models: LocalCatalogModel[];
  progress: ModelDownloadEvent | null;
  selectedId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onDownload: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const percent = progress && progress.totalBytes > 0
    ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
    : 0;

  const chooseKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    onSelect(id);
  };

  return (
    <div className="localModelList" role="radiogroup" aria-label="Dictation model">
      <div
        className={`localModelRow isDownloaded isSelectable ${selectedId === "off" ? "isSelected" : ""}`}
        role="radio"
        aria-checked={selectedId === "off"}
        tabIndex={0}
        onClick={() => { if (!disabled) onSelect("off"); }}
        onKeyDown={(event) => { if (!disabled) chooseKeyDown(event, "off"); }}
      >
        <span className="localModelName">Off</span>
        <span className="localModelNote">No dictation</span>
        <span className="localModelAction">
          {selectedId === "off" ? <Check className="localModelTick" size={14} /> : null}
        </span>
      </div>

      {models.map((model) => {
        const downloading = progress?.id === model.id;
        const selected = model.downloaded && selectedId === model.id;

        if (downloading) {
          return (
            <div className="localModelRow" key={model.id}>
              <span className="localModelName">{model.displayName}</span>
              <span
                className="localModelProgress"
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Downloading ${model.displayName}`}
              >
                <span className="localModelProgressFill" style={{ width: `${percent}%` }} />
              </span>
              <span className="localModelNote">
                {progress.state === "verifying" ? "Verifying" : `${percent}%`}
              </span>
              <span className="localModelAction">
                <button
                  className="settingsIconButton"
                  type="button"
                  onClick={() => onCancel(model.id)}
                  aria-label={`Cancel downloading ${model.displayName}`}
                  title="Cancel"
                >
                  <X size={14} />
                </button>
              </span>
            </div>
          );
        }

        if (!model.downloaded) {
          return (
            <div className="localModelRow" key={model.id}>
              <span className="localModelName">{model.displayName}</span>
              <span className="localModelNote">{formatBytes(model.bytes)}</span>
              <span className="localModelAction">
                <button
                  className="settingsIconButton"
                  type="button"
                  disabled={disabled || progress !== null}
                  onClick={() => onDownload(model.id)}
                  aria-label={`Download ${model.displayName}`}
                  title={progress !== null ? "Another model is downloading" : "Download"}
                >
                  <Download size={14} />
                </button>
              </span>
            </div>
          );
        }

        return (
          <div
            className={`localModelRow isDownloaded isSelectable ${selected ? "isSelected" : ""}`}
            key={model.id}
            role="radio"
            aria-checked={selected}
            tabIndex={0}
            onClick={() => { if (!disabled) onSelect(model.id); }}
            onKeyDown={(event) => { if (!disabled) chooseKeyDown(event, model.id); }}
          >
            <span className="localModelName">{model.displayName}</span>
            <span className="localModelNote">{formatBytes(model.bytes)}</span>
            <span className="localModelAction">
              {selected ? <Check className="localModelTick" size={14} /> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The way into the collection for a model the catalog does not carry: a
 * Hugging Face link or author/model reference. Resolving it pins the current
 * revision and its digests, so what was reviewed at add time is what every
 * later download verifies against.
 */
export function CustomModelAdd({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (reference: string) => Promise<boolean>;
}) {
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const canAdd = !disabled && !busy && reference.trim().length > 0;

  async function submit() {
    if (!canAdd) return;
    setBusy(true);
    try {
      if (await onAdd(reference.trim())) setReference("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="customModelAdd">
      <input
        value={reference}
        disabled={disabled || busy}
        placeholder="Add from Hugging Face: link or author/model"
        spellCheck={false}
        aria-label="Hugging Face model reference"
        onChange={(event) => setReference(event.currentTarget.value)}
        onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
      />
      <button
        className="settingsInlineButton"
        type="button"
        disabled={!canAdd}
        onClick={() => void submit()}
      >
        {busy ? <Loader2 className="spin" size={13} /> : <Plus size={13} />}
        <span>{busy ? "Resolving" : "Add"}</span>
      </button>
    </div>
  );
}

/**
 * Multi-token prediction for the whole collection: dense models that carry a
 * head draft from it, mixture-of-experts are unaffected. One switch rather
 * than one per model because the reason to turn it off is the machine, not
 * the model — on some hardware drafting is no faster, and the user is the
 * one who can tell.
 */
export function LocalMtpToggle({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean | null;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const on = enabled === true;
  return (
    <div className="localMtpRow">
      <div className="localMtpText">
        <strong>Faster decoding (MTP)</strong>
      </div>
      <button
        type="button"
        className={`toggle ${on ? "isOn" : ""}`}
        role="switch"
        aria-checked={on}
        aria-label="Faster decoding with multi-token prediction"
        disabled={disabled}
        onClick={() => onChange(!on)}
      >
        <span className="toggleKnob" />
      </button>
    </div>
  );
}

/**
 * Where the weights live, and a way to get to them. Shown because several
 * gigabytes of files a user did not choose the location of should not be
 * something they have to go hunting for to reclaim.
 */
export function LocalModelFolder({ api }: { api: DesktopApi }) {
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="localModelFolder">
      <button
        className="settingsInlineButton"
        type="button"
        onClick={() => void api.openModelsFolder().then(
          (result) => setMessage(result.ok ? null : result.message),
          () => setMessage("Could not open the models folder."),
        )}
      >
        <FolderOpen size={13} />
        <span>Open models folder</span>
      </button>
      {message ? <p className="settingsMessage">{message}</p> : null}
    </div>
  );
}
