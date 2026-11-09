import React, { Children, isValidElement, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

type Option = { value: string; label: string; disabled?: boolean };
function optionsFrom(children: React.ReactNode): Option[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ value?: string | number; children?: React.ReactNode; disabled?: boolean }>(child)) return [];
    if (child.type === React.Fragment) return optionsFrom(child.props.children);
    if (child.type !== "option") return [];
    const label = Children.toArray(child.props.children).join("");
    return [{ value: String(child.props.value ?? label), label, disabled: child.props.disabled }];
  });
}

/** App-styled listbox in the browser top layer, including inside a settings dialog. */
export function CloudSelect({ label, value, children, className = "", disabled, icons, iconOnly = false, onValueChange }: {
  label: string; value: string | number; children: React.ReactNode; className?: string; disabled?: boolean;
  icons?: Record<string, React.ReactNode>; iconOnly?: boolean; onValueChange(value: string): void;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef({ value: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const options = optionsFrom(children);
  const selected = options.findIndex(option => option.value === String(value));
  function close() { menu.current?.hidePopover(); setOpen(false); }
  function position() {
    if (!menu.current || !button.current) return;
    const rect = button.current.getBoundingClientRect();
    const element = menu.current;
    element.style.minWidth = `${Math.min(Math.max(rect.width, 168), window.innerWidth - 24)}px`;
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const goesUp = below < Math.min(element.scrollHeight, 320) && above > below;
    element.dataset.side = goesUp ? "top" : "bottom";
    element.style.maxHeight = `${Math.max(32, Math.min(320, (goesUp ? above : below) - 6))}px`;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(12, Math.min(rect.right - bounds.width, window.innerWidth - bounds.width - 12))}px`;
    element.style.top = `${goesUp ? rect.top - bounds.height - 6 : rect.bottom + 6}px`;
  }
  function show(index = selected) {
    if (disabled || !options.length) return;
    setActive(index >= 0 && !options[index]?.disabled ? index : options.findIndex(option => !option.disabled));
    menu.current?.showPopover(); position(); setOpen(true);
  }
  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    close(); button.current?.focus(); onValueChange(option.value);
  }
  function move(direction: number) {
    let index = active;
    for (let step = 0; step < options.length; step++) {
      index = (index + direction + options.length) % options.length;
      if (!options[index].disabled) { setActive(index); break; }
    }
  }
  useEffect(() => {
    if (disabled) close();
  }, [disabled]);
  useEffect(() => {
    if (open) menu.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);
  useEffect(() => {
    if (!open) return;
    const onScroll = (event: Event) => { if (event.target !== menu.current) close(); };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("resize", close); window.removeEventListener("scroll", onScroll, true); };
  }, [open]);
  return <span className={`cloudSelect ${className}`}>
    <button type="button" ref={button} role="combobox" aria-label={iconOnly ? `${label}: ${options[selected]?.label || value}` : label} title={options[selected]?.label} aria-expanded={open} aria-controls={id}
      aria-haspopup="listbox" aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
      disabled={disabled} className="cloudSelectTrigger" popoverTarget={id}
      onClick={event => { event.preventDefault(); if (open) close(); else show(); }}
      onKeyDown={event => {
        if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape"].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          if (event.key === "Escape") { close(); return; }
          if (event.key === "Home" || event.key === "End") {
            const indices = options.map((_, index) => index).filter(index => !options[index].disabled);
            const index = event.key === "Home" ? indices[0] : indices.at(-1);
            if (!open) show(index); else setActive(index ?? -1);
          } else if (!open) show();
          else if (event.key === "ArrowDown" || event.key === "ArrowUp") move(event.key === "ArrowDown" ? 1 : -1);
          else choose(active);
        } else if (event.key === "Tab") close();
        else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          const now = Date.now();
          const text = (now - search.current.time < 700 ? search.current.value : "") + event.key.toLowerCase();
          search.current = { value: text, time: now };
          const repeated = [...text].every(char => char === text[0]);
          const query = repeated ? text[0] : text;
          const start = open ? active : selected;
          for (let step = 1; step <= options.length; step++) {
            const index = (start + step + options.length) % options.length;
            if (!options[index].disabled && options[index].label.toLowerCase().startsWith(query)) {
              if (!open) show(index); else setActive(index);
              break;
            }
          }
        }
      }}>
      {icons?.[String(value)]}{!iconOnly && <span className="cloudSelectText">{options[selected]?.label || value}</span>}<ChevronDown size={14} strokeWidth={1.8} aria-hidden="true"/>
    </button>
    <div id={id} ref={menu} popover="auto" className="cloudSelectMenu" role="listbox" aria-label={label}
      onToggle={event => { const isOpen = event.newState === "open"; setOpen(isOpen); if (isOpen) position(); }}
      onPointerDown={event => event.preventDefault()}>
      {options.map((option, index) => <div key={option.value} id={`${id}-${index}`} role="option" data-index={index}
        aria-selected={selected === index} aria-disabled={option.disabled || undefined}
        className={`cloudSelectOption ${active === index ? "isActive" : ""}`}
        onPointerMove={() => { if (!option.disabled) setActive(index); }} onClick={() => choose(index)}>
        {icons?.[option.value]}<span className="cloudSelectOptionLabel">{option.label}</span>
        <Check size={14} strokeWidth={1.8} className={selected === index ? "cloudSelectCheck" : "cloudSelectCheck cloudSelectUnchecked"} aria-hidden="true"/>
      </div>)}
    </div>
  </span>;
}
