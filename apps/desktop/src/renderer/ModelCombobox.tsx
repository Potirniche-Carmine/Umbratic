import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";

export type ModelDiscoveryStatus = "idle" | "loading" | "ready" | "unavailable";

export type ModelComboboxItem = {
  id: string;
  label: string;
  /**
   * Whether the model is running right now. `undefined` where availability is
   * not a concept — a local runtime either lists a model or does not.
   */
  available?: boolean;
  /** Right-aligned context badge, e.g. "96k". */
  badge?: string;
};

type ModelComboboxProps = {
  label: string;
  disabled: boolean;
  items: ModelComboboxItem[];
  selectedId: string;
  status: ModelDiscoveryStatus;
  /** Placeholders by status. The picker is often the only place a runtime's
   * state is reported, so each one says what happened. */
  placeholders: { loading: string; unavailable: string; empty: string; choose: string };
  onSelect(id: string): void;
};

/**
 * One combobox for every model list in the app.
 *
 * Two lists that behave differently are two chances to behave inconsistently:
 * the local runtime's models and the server's registry look the same to a user
 * and now are the same control, differing only in what they are handed.
 */
export function ModelCombobox({
  label,
  disabled,
  items,
  selectedId,
  status,
  placeholders,
  onSelect,
}: ModelComboboxProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const options = useMemo(() => {
    const seen = new Set<string>();
    const rows: ModelComboboxItem[] = [];
    // The current selection leads even when the list no longer offers it: a
    // stopped or uninstalled model must stay visible rather than silently
    // reading as a different one.
    if (selectedId.trim() && !items.some((item) => item.id === selectedId)) {
      rows.push({ id: selectedId, label: selectedId });
      seen.add(selectedId);
    }
    for (const item of items) {
      const id = item.id.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push(item);
    }
    return rows;
  }, [items, selectedId]);
  const interactionDisabled = disabled || options.length === 0;
  const selectedLabel = options.find((item) => item.id === selectedId)?.label ?? selectedId;
  const displayValue = selectedLabel
    || (status === "loading"
      ? placeholders.loading
      : status === "unavailable"
        ? placeholders.unavailable
        : options.length > 0
          ? placeholders.choose
          : placeholders.empty);
  const optionId = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (interactionDisabled) setOpen(false);
  }, [interactionDisabled]);

  function openMenu() {
    if (interactionDisabled) return;
    const selectedIndex = options.findIndex((item) => item.id === selectedId);
    setFocusedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }

  function selectModel(id: string) {
    onSelect(id);
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (interactionDisabled) return;
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setFocusedIndex((current) => (current + direction + options.length) % options.length);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) selectModel(options[focusedIndex].id);
      else openMenu();
    }
  }

  return (
    <div className="settingsField">
      <span>{label}</span>
      <div className={`modelPicker ${open ? "isOpen" : ""}`} ref={rootRef}>
        <button
          className="modelPickerTrigger"
          type="button"
          role="combobox"
          aria-controls={`${optionId}-options`}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={label}
          aria-activedescendant={open ? `${optionId}-option-${focusedIndex}` : undefined}
          disabled={interactionDisabled}
          onClick={() => open ? setOpen(false) : openMenu()}
          onKeyDown={handleKeyDown}
        >
          <span className={!selectedLabel ? "isPlaceholder" : ""}>{displayValue}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        {open ? (
          <div className="modelPickerMenu" id={`${optionId}-options`} role="listbox" aria-label={label}>
            {options.map((item, index) => (
              <button
                id={`${optionId}-option-${index}`}
                key={item.id}
                className={[
                  "modelPickerOption",
                  focusedIndex === index ? "isFocused" : "",
                  item.available === false ? "isStopped" : "",
                ].filter(Boolean).join(" ")}
                type="button"
                role="option"
                aria-selected={selectedId === item.id}
                onClick={() => selectModel(item.id)}
                onPointerEnter={() => setFocusedIndex(index)}
              >
                {item.available === undefined ? null : (
                  <span className="modelPickerStatusDot" aria-hidden="true" />
                )}
                <span className="modelPickerOptionName">{item.label}</span>
                {item.badge ? <span className="modelPickerBadge">{item.badge}</span> : null}
                {selectedId === item.id ? <Check size={14} aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
