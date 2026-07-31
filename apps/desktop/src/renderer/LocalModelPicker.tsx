import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";

export type LocalModelDiscoveryStatus = "idle" | "loading" | "ready" | "unavailable";

type LocalModelPickerProps = {
  disabled: boolean;
  models: string[];
  selectedModel: string;
  status: LocalModelDiscoveryStatus;
  onModelChange(modelId: string): void;
};

export function LocalModelPicker({
  disabled,
  models,
  selectedModel,
  status,
  onModelChange,
}: LocalModelPickerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const options = useMemo(
    () => Array.from(new Set([selectedModel, ...models].map((modelId) => modelId.trim()).filter(Boolean))),
    [models, selectedModel],
  );
  const interactionDisabled = disabled || options.length === 0;
  const displayValue = selectedModel
    || (status === "loading"
      ? "Checking installed models..."
      : status === "unavailable"
        ? "Models unavailable"
        : status === "ready"
          ? options.length > 0 ? "Choose a model" : "No models installed"
          : "Refresh to find models");

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
    const selectedIndex = options.indexOf(selectedModel);
    setFocusedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }

  function selectModel(modelId: string) {
    onModelChange(modelId);
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
      if (open) selectModel(options[focusedIndex]);
      else openMenu();
    }
  }

  return (
    <div className="settingsField">
      <span>Model</span>
      <div className={`modelPicker ${open ? "isOpen" : ""}`} ref={rootRef}>
        <button
          className="modelPickerTrigger"
          type="button"
          role="combobox"
          aria-controls="local-model-options"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label="Local model"
          aria-activedescendant={open ? `local-model-option-${focusedIndex}` : undefined}
          disabled={interactionDisabled}
          onClick={() => open ? setOpen(false) : openMenu()}
          onKeyDown={handleKeyDown}
        >
          <span className={!selectedModel ? "isPlaceholder" : ""}>{displayValue}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        {open ? (
          <div className="modelPickerMenu" id="local-model-options" role="listbox" aria-label="Installed models">
            {options.map((modelId, index) => (
              <button
                id={`local-model-option-${index}`}
                key={modelId}
                className={`modelPickerOption ${focusedIndex === index ? "isFocused" : ""}`}
                type="button"
                role="option"
                aria-selected={selectedModel === modelId}
                onClick={() => selectModel(modelId)}
                onPointerEnter={() => setFocusedIndex(index)}
              >
                <span>{modelId}</span>
                {selectedModel === modelId ? <Check size={14} aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
