import type { SkillSourceFilter } from "./rendererTypes";
import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import type { DesktopApi, SkillInfo, SkillDocument } from "../shared/desktopApi";
import { filterSkillsBySource, skillPreviewMarkdown } from "./skillDisplay";
import type { SkillsSettingsPanel } from "./SkillsSettings";

export function useSkillSettings(api: DesktopApi) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [skillsEnabled, setSkillsEnabled] = useState<Record<string, boolean>>({});
  const [skillsMessage, setSkillsMessage] = useState<string | null>(null);
  const [newSkillFormOpen, setNewSkillFormOpen] = useState(false);
  const [newSkillName, setNewSkillName] = useState("");
  const [creatingSkill, setCreatingSkill] = useState(false);
  const [skillSourceFilter, setSkillSourceFilter] = useState<SkillSourceFilter>("local");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [skillDocument, setSkillDocument] = useState<SkillDocument | null>(null);
  const [skillPreviewLoading, setSkillPreviewLoading] = useState(false);
  const skillsSaveSequenceRef = useRef(0);
  const previewSequenceRef = useRef(0);
  const skillsLoadedRef = useRef(false);
  const enabledRef = useRef<Record<string, boolean>>({});
  const confirmedSkillsRef = useRef<SkillInfo[]>([]);
  const saveChainRef = useRef(Promise.resolve());

  const selectedSkillPreview = useMemo(
    () => (skillDocument ? skillPreviewMarkdown(skillDocument.content, skillDocument.name) : ""),
    [skillDocument],
  );
  const visibleSkills = useMemo(
    () => filterSkillsBySource(skills, skillSourceFilter),
    [skillSourceFilter, skills],
  );

  useEffect(() => {
    if (!selectedSkillId || skills.some((skill) => skill.id === selectedSkillId)) return;
    clearSkillPreview();
  }, [selectedSkillId, skills]);

  function clearSkillPreview() {
    previewSequenceRef.current++;
    setSelectedSkillId(null);
    setSkillDocument(null);
    setSkillPreviewLoading(false);
  }

  function acceptSkills(nextSkills: SkillInfo[]) {
    confirmedSkillsRef.current = nextSkills;
    enabledRef.current = Object.fromEntries(nextSkills.map((skill) => [skill.id, skill.enabled]));
    setSkills(nextSkills);
    setSkillsEnabled(enabledRef.current);
  }

  async function loadSkills() {
    setSkillsLoading(true);
    const sequence = skillsSaveSequenceRef.current;
    try {
      await saveChainRef.current;
      const result = await api.listSkills();
      if (sequence !== skillsSaveSequenceRef.current) return;
      acceptSkills(result.skills);
      setSelectedSkillId((current) => (current && result.skills.some((skill) => skill.id === current) ? current : null));
      skillsLoadedRef.current = true;
      setSkillsLoaded(true);
    } catch (cause) {
      if (!skillsLoadedRef.current) setSkills([]);
      console.warn("Failed to list skills", cause);
    } finally {
      setSkillsLoading(false);
    }
  }

  async function toggleSkillSetting(skillId: string) {
    // React may defer updater functions. Build the persisted value now, and
    // keep rapid clicks cumulative even before React paints the next render.
    const next = { ...enabledRef.current, [skillId]: !enabledRef.current[skillId] };
    enabledRef.current = next;
    setSkillsEnabled(next);
    setSkillsMessage(null);
    const requestId = ++skillsSaveSequenceRef.current;
    // Settings are whole-map replacements: serialize writes so an older
    // response can never overwrite a newer choice on disk.
    saveChainRef.current = saveChainRef.current.then(async () => {
      try {
        const result = await api.saveSkillSettings(next);
        confirmedSkillsRef.current = result.skills;
        if (requestId !== skillsSaveSequenceRef.current) return;
        acceptSkills(result.skills);
        setSkillDocument((current) => current ? {
          ...current, enabled: result.skills.find((skill) => skill.id === current.id)?.enabled ?? current.enabled,
        } : current);
      } catch (cause) {
        if (requestId !== skillsSaveSequenceRef.current) return;
        acceptSkills(confirmedSkillsRef.current);
        setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
      }
    });
    await saveChainRef.current;
  }

  async function openSkillsFolder() {
    setSkillsMessage(null);
    try {
      const result = await api.openSkillsFolder();
      if (!result.ok) {
        setSkillsMessage(result.message);
      }
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
    }
  }

  function selectSkillSourceFilter(filter: SkillSourceFilter) {
    setSkillSourceFilter(filter);
    clearSkillPreview();
    setSkillsMessage(null);
  }

  async function toggleSkillPreview(skillId: string) {
    if (skillPreviewLoading) return;
    if (selectedSkillId === skillId) {
      clearSkillPreview();
      setSkillsMessage(null);
      return;
    }
    setSelectedSkillId(skillId);
    setSkillDocument(null);
    setSkillsMessage(null);
    setSkillPreviewLoading(true);
    const sequence = ++previewSequenceRef.current;
    try {
      const result = await api.getSkillDocument({ id: skillId });
      if (sequence !== previewSequenceRef.current) return;
      if (!result.ok) {
        setSkillsMessage(result.message);
        setSkillDocument(null);
        return;
      }
      setSkillDocument(result.skill);
    } catch (cause) {
      if (sequence !== previewSequenceRef.current) return;
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
      setSkillDocument(null);
    } finally {
      if (sequence === previewSequenceRef.current) setSkillPreviewLoading(false);
    }
  }

  async function openSelectedSkillInEditor() {
    if (!skillDocument) return;
    setSkillsMessage(null);
    try {
      const result = await api.openSkillInEditor({ id: skillDocument.id });
      if (!result.ok) {
        setSkillsMessage(result.message);
        return;
      }
      setSkillsMessage("Opened skill file.");
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function resetSelectedSystemSkill() {
    if (!skillDocument || skillDocument.source !== "system") return;
    setSkillsMessage(null);
    setSkillPreviewLoading(true);
    try {
      const result = await api.resetSystemSkill({ id: skillDocument.id });
      if (!result.ok) {
        setSkillsMessage(result.message);
        return;
      }
      acceptSkills(result.skills);
      setSkillDocument(result.skill);
      setSkillsMessage(`Reset ${result.skill.name}.`);
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setSkillPreviewLoading(false);
    }
  }

  async function submitCreateSkill() {
    if (creatingSkill) return;
    setSkillsMessage(null);
    setCreatingSkill(true);
    try {
      const result = await api.createSkill({ name: newSkillName });
      if (!result.ok) {
        setSkillsMessage(result.message);
        return;
      }
      setNewSkillName("");
      setNewSkillFormOpen(false);
      await loadSkills();
      await toggleSkillPreview(result.skill.id);
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setCreatingSkill(false);
    }
  }

  async function importSkill() {
    if (skillsLoading) return;
    setSkillsMessage(null);
    setSkillsLoading(true);
    try {
      const result = await api.importSkill();
      if (!result.ok) {
        setSkillsMessage(result.message);
        return;
      }
      acceptSkills(result.skills);
      skillsLoadedRef.current = true;
      setSkillsLoaded(true);
      await toggleSkillPreview(result.skill.id);
      setSkillsMessage(`Imported ${result.skill.name}.`);
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setSkillsLoading(false);
    }
  }

  const panelProps: ComponentProps<typeof SkillsSettingsPanel> = {
    skills, visibleSkills, skillsEnabled, skillsLoading, skillsLoaded,
    skillSourceFilter, selectedSkillId, selectedSkillPreview, skillPreviewLoading,
    skillDocument, newSkillFormOpen, newSkillName, creatingSkill, skillsMessage,
    onRefresh: () => { setSkillsMessage(null); void loadSkills(); },
    onOpenFolder: () => void openSkillsFolder(),
    onImport: () => void importSkill(),
    onToggleNewSkillForm: () => { setNewSkillFormOpen((open) => !open); setSkillsMessage(null); },
    onSelectSourceFilter: selectSkillSourceFilter,
    onNewSkillName: setNewSkillName,
    onCreateSkill: () => void submitCreateSkill(),
    onCancelNewSkill: () => { setNewSkillFormOpen(false); setNewSkillName(""); },
    onTogglePreview: (skillId) => void toggleSkillPreview(skillId),
    onToggleEnabled: (skillId) => void toggleSkillSetting(skillId),
    onResetSystemSkill: () => void resetSelectedSystemSkill(),
    onOpenInEditor: () => void openSelectedSkillInEditor(),
  };
  return { skills, skillsEnabled, loadSkills, panelProps };
}
