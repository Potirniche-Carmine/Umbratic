import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";

export type ComboboxItem = {
  id: string;
  label: string;
  /**
   * Whether the thing behind the option is running right now. `undefined` where
   * availability is not a concept, which is most lists.
   */
  available?: boolean;
  /** Right-aligned context badge, e.g. "96k". */
  badge?: string;
};

type ComboboxProps = {
  label: string;
  disabled?: boolean;
  items: ComboboxItem[];
  selectedId: string;
  /** Shown in place of a selection. Lists that can be empty say why here. */
  placeholder?: string;
  onSelect(id: string): void;
};

/**
 * One dropdown for every choice in the settings pages.
 *
 * Two lists that behave differently are two chances to behave inconsistently,
 * and a native `<select>` is a third: it draws in the operating system's colours
 * rather than the app's. Everything that picks one value from a short list uses
 * this, differing only in what it is handed.
 */
export function Combobox({
  label,
  disabled = false,
  items,
  selectedId,
  placeholder = "",
  onSelect,
}: ComboboxProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const options = useMemo(() => {
    const seen = new Set<string>();
    const rows: ComboboxItem[] = [];
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

  function choose(id: string) {
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
      if (open) choose(options[focusedIndex].id);
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
          <span className={!selectedLabel ? "isPlaceholder" : ""}>{selectedLabel || placeholder}</span>
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
                onClick={() => choose(item.id)}
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
