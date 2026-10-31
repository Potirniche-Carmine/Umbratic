import { Columns2, Rows3 } from "lucide-react";

import { setReviewLayout, setReviewWrap, useReviewLayout, useReviewWrap } from "./review/reviewPreferences";
import { setAutoExpandWorkingBlocks, useAutoExpandWorkingBlocks } from "./workingBlockPreferences";

function ToggleRow({
  title,
  description,
  on,
  disabled,
  onToggle,
}: {
  title: string;
  description: string;
  on: boolean;
  disabled?: boolean;
  onToggle(next: boolean): void;
}) {
  return (
    <div className="generalSettingRow">
      <div className="generalSettingText">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <button
        type="button"
        className={`toggle ${on ? "isOn" : ""}`}
        role="switch"
        aria-checked={on}
        aria-label={title}
        disabled={disabled}
        onClick={() => onToggle(!on)}
      >
        <span className="toggleKnob" />
      </button>
    </div>
  );
}

/**
 * The everyday preferences, first in the dialog because they are the ones a
 * new user goes looking for: how sending works, what the transcript shows,
 * how reviews open, and whether the app starts with the machine.
 */
export function GeneralSettingsPanel({
  showThinking,
  sendOnEnter,
  launchAtLogin,
  onToggleShowThinking,
  onToggleSendOnEnter,
  onToggleLaunchAtLogin,
}: {
  showThinking: boolean;
  sendOnEnter: boolean;
  launchAtLogin: { enabled: boolean; available: boolean };
  onToggleShowThinking(next: boolean): void;
  onToggleSendOnEnter(next: boolean): void;
  onToggleLaunchAtLogin(next: boolean): void;
}) {
  // The same store the review panel reads, subscribed to rather than copied:
  // this panel is a second door to one value, so a change made here is on the
  // diff behind the dialog before it is closed.
  const reviewLayout = useReviewLayout();
  const reviewWrap = useReviewWrap();
  const autoExpandWorkingBlocks = useAutoExpandWorkingBlocks();

  return (
    <div className="settingsPanel">
      <div className="settingsPanelHead">
        <h3>General</h3>
      </div>

      <div className="settingsGroup">
        <ToggleRow
          title="Auto-expand working blocks"
          description="Open working blocks as they stream in"
          on={autoExpandWorkingBlocks}
          onToggle={setAutoExpandWorkingBlocks}
        />
        <ToggleRow
          title="Show model thinking"
          description="Stream the model's reasoning inside the working block as it happens"
          on={showThinking}
          onToggle={onToggleShowThinking}
        />
        <ToggleRow
          title="Send with Enter"
          description={sendOnEnter ? "Enter sends · Shift+Enter starts a new line" : "Enter starts a new line · ⌘/Ctrl+Enter sends"}
          on={sendOnEnter}
          onToggle={onToggleSendOnEnter}
        />
      </div>

      <div className="settingsGroup">
        <div className="generalSettingRow">
          <div className="generalSettingText">
            <strong>Review layout</strong>
            <span>How diffs open in the review panel</span>
          </div>
          <span className="reviewSegmentedControl" aria-label="Default diff layout">
            <button
              type="button"
              className={reviewLayout === "split" ? "isActive" : ""}
              onClick={() => setReviewLayout("split")}
              title="Side by side"
            >
              <Columns2 size={14} />
              <span>Side by side</span>
            </button>
            <button
              type="button"
              className={reviewLayout === "unified" ? "isActive" : ""}
              onClick={() => setReviewLayout("unified")}
              title="Unified"
            >
              <Rows3 size={14} />
              <span>Unified</span>
            </button>
          </span>
        </div>
        <ToggleRow
          title="Wrap long lines in diffs"
          description="Wrap instead of scrolling horizontally"
          on={reviewWrap}
          onToggle={setReviewWrap}
        />
      </div>

      {launchAtLogin.available ? (
        <div className="settingsGroup">
          <ToggleRow
            title="Start at login"
            description="Open Umbratic when you sign in to this computer"
            on={launchAtLogin.enabled}
            onToggle={onToggleLaunchAtLogin}
          />
        </div>
      ) : null}
    </div>
  );
}
