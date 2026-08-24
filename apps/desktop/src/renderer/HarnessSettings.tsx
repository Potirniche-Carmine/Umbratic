import type { CSSProperties } from "react";
import { Check } from "lucide-react";
import type { HarnessProfileId, ModelEndpointMode } from "../shared/desktopApi";
import {
  CONTEXT_LENGTH_OPTIONS,
  DEFAULT_CONTEXT_LENGTH,
  formatTokenCount,
} from "../shared/contextWindow";
import { harnessProfiles } from "./harnessProfile";

export function HarnessSettingsPanel({
  draftProfile,
  draftContextLength,
  draftContextIndex,
  endpointMode,
  saving,
  saveFeedback,
  dirty,
  message,
  onSelectProfile,
  onDraftContextLength,
  onSave,
}: {
  draftProfile: HarnessProfileId;
  draftContextLength: number;
  draftContextIndex: number;
  endpointMode: ModelEndpointMode;
  saving: boolean;
  saveFeedback: "idle" | "saved";
  dirty: boolean;
  message: string | null;
  onSelectProfile(profileId: HarnessProfileId): void;
  onDraftContextLength(length: number): void;
  onSave(): void;
}) {
  return (
    <div className="settingsPanel">
      <div className="settingsPanelHead">
        <h3>Harness</h3>
        <p>Choose the working profile Umbratic uses when it starts a new run. Skills that do not belong with that work start off.</p>
      </div>

      <div className="settingsGroup">
        <div className="harnessOptionGrid">
          {harnessProfiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className={`harnessOption ${draftProfile === profile.id ? "isActive" : ""}`}
              aria-pressed={draftProfile === profile.id}
              onClick={() => onSelectProfile(profile.id)}
            >
              <span className="harnessOptionHead">
                <strong>{profile.name}</strong>
                {draftProfile === profile.id ? <Check size={14} /> : null}
              </span>
              <em>{profile.description}</em>
            </button>
          ))}
        </div>
      </div>

      <div className={`settingsGroup contextLengthGroup ${endpointMode === "server" ? "isDisabled" : ""}`}>
        <div className="contextLengthHead">
          <div>
            <p>Choose the context window the local model uses.</p>
          </div>
        </div>
        <div className="contextLengthSliderShell">
          <input
            className="contextLengthSlider"
            type="range"
            min={0}
            max={CONTEXT_LENGTH_OPTIONS.length - 1}
            step={1}
            value={draftContextIndex}
            disabled={endpointMode === "server"}
            aria-label="Model context length"
            aria-valuetext={`${formatTokenCount(draftContextLength)} tokens${draftContextLength === DEFAULT_CONTEXT_LENGTH ? ", default" : ""}`}
            style={{
              "--context-slider-progress": `${(draftContextIndex / (CONTEXT_LENGTH_OPTIONS.length - 1)) * 100}%`,
            } as CSSProperties}
            onChange={(event) => {
              const option = CONTEXT_LENGTH_OPTIONS[Number(event.currentTarget.value)] ?? DEFAULT_CONTEXT_LENGTH;
              onDraftContextLength(option);
            }}
          />
          <div className="contextLengthSliderLabels" aria-hidden="true">
            {CONTEXT_LENGTH_OPTIONS.map((option, index) => (
              <span
                key={option}
                className={draftContextLength === option ? "isActive" : ""}
                style={{ left: `${(index / (CONTEXT_LENGTH_OPTIONS.length - 1)) * 100}%` }}
              >
                <strong>{formatTokenCount(option)}</strong>
                {option === DEFAULT_CONTEXT_LENGTH ? <small>Default</small> : null}
              </span>
            ))}
          </div>
        </div>
        {/* The server case still needs its line: the slider is disabled and
            nothing else on screen says why. The local case explained what the
            slider already shows. */}
        {endpointMode === "server" ? (
          <p className="contextLengthHint">
            Context length is managed by your Veil server. Switch to Local to configure it here.
          </p>
        ) : null}
      </div>

      <div className="settingsActions harnessSettingsActions">
        <button
          className={`settingsInlineButton ${saveFeedback === "saved" ? "isSuccess" : ""}`}
          type="button"
          onClick={onSave}
          disabled={saving || !dirty}
        >
          <Check size={13} />
          <span>{saveFeedback === "saved" ? "Saved" : "Save harness"}</span>
        </button>
        {dirty ? <p className="settingsMessage">Unsaved harness changes.</p> : null}
        {message ? <p className="settingsMessage settingsMessageError">{message}</p> : null}
      </div>
    </div>
  );
}
