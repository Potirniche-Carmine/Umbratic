import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cloudEffortLabels, type CloudModel, type CloudModelChoice } from "../../shared/cloud";
import { choiceForCloudModel, cloudModelDisplayName } from "./cloudModelChoices";

function modelLabel(model: CloudModel) {
  return model.label === model.id ? cloudModelDisplayName(model.id) : model.label;
}

/** Save the model and effort together when the user finishes choosing. */
export function CloudModelMenu({ value, models, disabled, onChange }: {
  value: CloudModelChoice; models: CloudModel[]; disabled?: boolean; onChange(value: CloudModelChoice): void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [draftModel, setDraftModel] = useState<string>();
  const returnToModel = useRef<string>(undefined);
  const selected = models.find(model => model.id === value.model);
  const label = selected ? modelLabel(selected) : cloudModelDisplayName(value.model);
  const effort = selected?.efforts.length ? cloudEffortLabels[value.effort] : "Default";
  const draft = models.find(model => model.id === draftModel && !model.unavailableReason && model.efforts.length);
  const preferredEffort = draft && choiceForCloudModel(value, draft).effort;

  function close() { menu.current?.hidePopover(); }
  function commit(choice: CloudModelChoice) {
    close();
    trigger.current?.focus();
    if (choice.model !== value.model || choice.effort !== value.effort) onChange(choice);
  }
  function position() {
    const element = menu.current; const button = trigger.current;
    if (!element || !button) return;
    const rect = button.getBoundingClientRect();
    const above = rect.top - 12; const below = window.innerHeight - rect.bottom - 12;
    const goesUp = above > below;
    element.style.maxHeight = `${Math.max(80, Math.min(420, (goesUp ? above : below) - 8))}px`;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - bounds.width - 12))}px`;
    element.style.top = `${goesUp ? rect.top - bounds.height - 8 : rect.bottom + 8}px`;
  }
  function optionButtons() {
    return Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button[data-choice]:not(:disabled)") || []);
  }
  useLayoutEffect(() => {
    if (!open || !menu.current?.matches(":popover-open")) return;
    if (disabled) { close(); return; }
    position();
    if (!menu.current.contains(document.activeElement)) {
      const options = optionButtons();
      const target = draft ? preferredEffort : returnToModel.current || value.model;
      (options.find(button => button.dataset.choice === target) || options[0])?.focus();
    }
  }, [open, disabled, draft, preferredEffort, value.model, models]);
  useEffect(() => {
    if (!open) return;
    const onScroll = (event: Event) => { if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) close(); };
    window.addEventListener("resize", close); window.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("resize", close); window.removeEventListener("scroll", onScroll, true); };
  }, [open]);

  return <div className="cloudComposerModel">
    <button ref={trigger} type="button" className="cloudModelTrigger" disabled={disabled || !models.length}
      aria-label={`Model and reasoning: ${label}, ${effort}`} title={`${label} · ${effort} reasoning`} aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
      popoverTarget={id} popoverTargetAction="toggle" onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); menu.current?.showPopover(); }
      }}>
      <span className="cloudModelName">{label}</span><ChevronDown size={13} aria-hidden="true"/>
    </button>
    <div ref={menu} id={id} popover="auto" className="cloudModelMenu" role="dialog" aria-labelledby={`${id}-heading`}
      onToggle={event => {
        const showing = event.newState === "open";
        setOpen(showing);
        if (showing) position();
        else { setDraftModel(undefined); returnToModel.current = undefined; }
      }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); trigger.current?.focus(); return; }
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        const options = optionButtons();
        if (!options.length) return;
        event.preventDefault();
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
          : index === -1 ? (event.key === "ArrowUp" ? options.length - 1 : 0)
          : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        options[next].focus();
      }}>
      {draft ? <React.Fragment key="effort">
        <div className="cloudModelStepHeader">
          <button type="button" className="cloudModelBack" aria-label="Back to models" onClick={() => setDraftModel(undefined)}><ChevronLeft size={16} aria-hidden="true"/></button>
          <div className="cloudModelStepTitle"><strong id={`${id}-heading`}>Reasoning effort</strong><span>{modelLabel(draft)}</span></div>
        </div>
        <div className="cloudModelChoices">
          {draft.efforts.map(level => <button type="button" className="cloudModelChoice" key={level} data-choice={level}
            aria-current={level === preferredEffort || undefined}
            onClick={() => commit({ model: draft.id, effort: level })}>
            <span>{cloudEffortLabels[level]}</span>{level === preferredEffort && <Check size={14} aria-hidden="true"/>}
          </button>)}
        </div>
      </React.Fragment> : <React.Fragment key="models">
        <div className="cloudModelMenuHeading" id={`${id}-heading`}>Model</div>
        <div className="cloudModelChoices">
          {!selected && <div className="cloudModelUnavailable">{label}{models.length ? " · unavailable" : ""}</div>}
          {models.map(model => <button type="button" className="cloudModelChoice" key={model.id} title={model.unavailableReason}
            data-choice={model.id} aria-current={model.id === value.model || undefined} disabled={disabled || !!model.unavailableReason}
            onClick={() => {
              if (!model.efforts.length) { commit(choiceForCloudModel(value, model)); return; }
              returnToModel.current = model.id;
              setDraftModel(model.id);
            }}>
            <span>{modelLabel(model)}{model.unavailableReason && <small>Separate billing</small>}</span>
            {model.id === value.model ? <Check size={14} aria-hidden="true"/> : !!model.efforts.length && !model.unavailableReason && <ChevronRight size={13} aria-hidden="true"/>}
          </button>)}
        </div>
      </React.Fragment>}
    </div>
  </div>;
}
