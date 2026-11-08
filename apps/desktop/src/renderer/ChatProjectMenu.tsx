import React, { useEffect, useRef } from "react";
import { Ellipsis } from "lucide-react";

type Action = { id: string; label: string; icon: React.ReactNode; disabled?: boolean; danger?: boolean; onSelect(): void };
/** The same project menu, focus behavior, and dismissal rules in every archive. */
export function ChatProjectMenu({ name, open, onOpenChange, actions }: {
  name: string; open: boolean; onOpenChange(open: boolean): void; actions: Action[];
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const change = useRef(onOpenChange); change.current = onOpenChange;
  useEffect(() => {
    if (!open) return;
    const visible = () => !!root.current?.checkVisibility();
    if (visible()) root.current?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) change.current(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !visible()) return;
      event.preventDefault(); event.stopPropagation(); change.current(false); trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  return <div ref={root} className="chatProjectActions">
    <button ref={trigger} className="chatProjectActionButton" type="button" aria-expanded={open} aria-haspopup="menu"
      title={`Project actions for "${name}"`} onClick={() => onOpenChange(!open)}><Ellipsis size={14}/></button>
    {open && <div className="chatProjectMenu" role="menu" aria-label={`Project actions for ${name}`} onKeyDown={event => {
      if (event.key === "Tab") { onOpenChange(false); return; }
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)"));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      let next: number;
      if (event.key === "ArrowDown") next = (index + 1) % items.length;
      else if (event.key === "ArrowUp") next = (index + items.length - 1) % items.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = items.length - 1;
      else return;
      event.preventDefault(); items[next]?.focus();
    }}>
      {actions.map(action => <button key={action.id} type="button" role="menuitem" className={action.danger ? "danger" : undefined} disabled={action.disabled}
        onClick={() => { onOpenChange(false); trigger.current?.focus(); action.onSelect(); }}>{action.icon}<span>{action.label}</span></button>)}
    </div>}
  </div>;
}
