import {
  Check,
  ChevronRight,
  ExternalLink,
  FileText,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import type { SkillDocument, SkillInfo } from "../shared/desktopApi";
import { MarkdownContent } from "./markdownContent";
import { SkillGovernance } from "./composerChrome";
import { skillMention } from "./promptMentions";
import type { SkillSourceFilter } from "./rendererTypes";

export function SkillsSettingsPanel({
  skills,
  visibleSkills,
  skillsEnabled,
  skillsLoading,
  skillsLoaded,
  skillSourceFilter,
  selectedSkillId,
  selectedSkillPreview,
  skillPreviewLoading,
  skillDocument,
  newSkillFormOpen,
  newSkillName,
  creatingSkill,
  skillsMessage,
  onRefresh,
  onOpenFolder,
  onImport,
  onToggleNewSkillForm,
  onSelectSourceFilter,
  onNewSkillName,
  onCreateSkill,
  onCancelNewSkill,
  onTogglePreview,
  onToggleEnabled,
  onResetSystemSkill,
  onOpenInEditor,
}: {
  skills: SkillInfo[];
  visibleSkills: SkillInfo[];
  skillsEnabled: Record<string, boolean>;
  skillsLoading: boolean;
  skillsLoaded: boolean;
  skillSourceFilter: SkillSourceFilter;
  selectedSkillId: string | null;
  selectedSkillPreview: string | null;
  skillPreviewLoading: boolean;
  skillDocument: SkillDocument | null;
  newSkillFormOpen: boolean;
  newSkillName: string;
  creatingSkill: boolean;
  skillsMessage: string | null;
  onRefresh(): void;
  onOpenFolder(): void;
  onImport(): void;
  onToggleNewSkillForm(): void;
  onSelectSourceFilter(filter: SkillSourceFilter): void;
  onNewSkillName(name: string): void;
  onCreateSkill(): void;
  onCancelNewSkill(): void;
  onTogglePreview(skillId: string): void;
  onToggleEnabled(skillId: string): void;
  onResetSystemSkill(): void;
  onOpenInEditor(): void;
}) {
  return (
    <div className="settingsPanel">
      <div className="settingsPanelHead">
        <h3>Skills</h3>
      </div>

      <div className="settingsGroup">
        <div className="skillSectionHeader">
          <div className="skillSectionActions">
            <button
              className="settingsInlineButton"
              type="button"
              onClick={onRefresh}
              disabled={skillsLoading}
              title="Refresh skills"
            >
              {skillsLoading ? <Loader2 className="spin" size={13} /> : <RefreshCw size={13} />}
              <span>Refresh</span>
            </button>
            <button className="settingsInlineButton" type="button" onClick={onOpenFolder}>
              <FolderOpen size={13} />
              <span>Open folder</span>
            </button>
            <button className="settingsInlineButton" type="button" onClick={onImport} disabled={skillsLoading}>
              <FileText size={13} />
              <span>Import</span>
            </button>
            <button
              className="settingsInlineButton"
              type="button"
              onClick={onToggleNewSkillForm}
            >
              <Plus size={13} />
              <span>New skill</span>
            </button>
          </div>
        </div>
        <div className="segmented skillFilter" aria-label="Skill source filter">
          <button
            type="button"
            className={skillSourceFilter === "local" ? "active" : ""}
            onClick={() => onSelectSourceFilter("local")}
          >
            Personal
          </button>
          <button
            type="button"
            className={skillSourceFilter === "system" ? "active" : ""}
            onClick={() => onSelectSourceFilter("system")}
          >
            System
          </button>
        </div>

        {newSkillFormOpen ? (
          <form
            className="skillCreateForm"
            onSubmit={(event) => {
              event.preventDefault();
              onCreateSkill();
            }}
          >
            <input
              type="text"
              placeholder="Skill name (e.g. Personal style guide)"
              value={newSkillName}
              onChange={(event) => onNewSkillName(event.target.value)}
              autoFocus
              disabled={creatingSkill}
            />
            <button type="submit" className="settingsInlineButton" disabled={creatingSkill || !newSkillName.trim()}>
              {creatingSkill ? <Loader2 className="spin" size={13} /> : <Check size={13} />}
              <span>Create</span>
            </button>
            <button
              type="button"
              className="chromeButton"
              onClick={onCancelNewSkill}
              disabled={creatingSkill}
            >
              <X size={13} />
            </button>
          </form>
        ) : null}

        {skillsLoading && !skillsLoaded ? (
          <div className="settingsEmpty">
            <Loader2 className="spin" size={16} />
            <span>Loading skills…</span>
          </div>
        ) : skills.length === 0 ? (
          <div className="settingsEmpty">
            <Sparkles size={16} />
            <span>No skills yet. Use New skill, or add a folder with a SKILL.md to the directory above.</span>
          </div>
        ) : visibleSkills.length === 0 ? (
          <div className="settingsEmpty">
            <Sparkles size={16} />
            <span>No skills match this filter.</span>
          </div>
        ) : (
          <ul className="skillList">
            {visibleSkills.map((skill) => (
              <li key={skill.id} className={`skillRow ${selectedSkillId === skill.id ? "isSelected" : ""}`}>
                <div className="skillRowTop">
                  <button
                    type="button"
                    className="skillRowButton"
                    onClick={() => onTogglePreview(skill.id)}
                    aria-expanded={selectedSkillId === skill.id}
                  >
                    <ChevronRight className="skillExpandIcon" size={14} aria-hidden="true" />
                    <div className="skillRowText">
                      <strong>{skill.name}</strong>
                      <em>{skill.description || skillMention(skill)}</em>
                      <SkillGovernance skill={skill} />
                    </div>
                  </button>
                  <button
                    type="button"
                    className={`toggle ${skillsEnabled[skill.id] ? "isOn" : ""}`}
                    role="switch"
                    aria-checked={!!skillsEnabled[skill.id]}
                    aria-label={`Toggle ${skill.name}`}
                    onClick={() => onToggleEnabled(skill.id)}
                  >
                    <span className="toggleKnob" />
                  </button>
                </div>
                {selectedSkillId === skill.id ? (
                  <div className="skillPreviewPanel">
                    <div className="skillPreviewHeader">
                      <span>{skillPreviewLoading ? "Loading preview" : "Preview"}</span>
                      <div className="skillPreviewActions">
                        {skillDocument?.source === "system" && skillDocument.modified ? (
                          <button
                            type="button"
                            className="settingsInlineButton"
                            onClick={onResetSystemSkill}
                            disabled={skillPreviewLoading}
                          >
                            <Undo2 size={13} />
                            <span>Reset</span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="settingsInlineButton"
                          onClick={onOpenInEditor}
                          disabled={!skillDocument || skillPreviewLoading}
                        >
                          <ExternalLink size={13} />
                          <span>Edit</span>
                        </button>
                      </div>
                    </div>
                    {skillPreviewLoading ? (
                      <div className="skillPreviewEmpty">
                        <Loader2 className="spin" size={14} />
                        <span>Loading skill preview</span>
                      </div>
                    ) : selectedSkillPreview ? (
                      <div className="skillPreviewBody">
                        <MarkdownContent content={selectedSkillPreview} />
                      </div>
                    ) : (
                      <p className="skillPreviewEmpty">No preview content.</p>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {skillsMessage ? <p className="settingsMessage">{skillsMessage}</p> : null}
      </div>
    </div>
  );
}
