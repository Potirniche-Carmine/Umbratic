import React from "react";
import { Send, Square } from "lucide-react";
import { ShortcutTooltip } from "../Tooltip";

export function CloudSubmitControls({ running, hasDraft, disabled, stopPending, sendOnEnter, onStop }: {
  running: boolean; hasDraft: boolean; disabled: boolean; stopPending: boolean; sendOnEnter: boolean;
  onStop(): void;
}) {
  return <>
    {running && <ShortcutTooltip id="run.stop" label="Stop work"><button type="button" className="sendButton stopButton" aria-label="Stop work" disabled={stopPending} onClick={onStop}><Square size={16}/></button></ShortcutTooltip>}
    {(!running || hasDraft) && <ShortcutTooltip id="composer.send" label={running ? "Steer with prompt" : "Send prompt"} sendOnEnter={running || sendOnEnter}>
      <button className="sendButton" type="submit" aria-label="Send prompt" disabled={disabled || !hasDraft}><Send size={17}/></button>
    </ShortcutTooltip>}
  </>;
}
