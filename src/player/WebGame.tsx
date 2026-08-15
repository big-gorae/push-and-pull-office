import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import runtimeJson from "../../build/story-runtime.json";
import { useDocumentAutosave, useSaveCommandBinding } from "../editorAutosave";
import { editorDraftJournal, useDraftJournal } from "../editorDraftJournal";
import { editorSaveCoordinator, SaveFailure, type DocumentSnapshot, type SaveCompletion, type SaveState } from "../editorSave";
import {
  pushPullPositionLabel,
  pushPullTargetLabel,
  readPushPullState,
} from "../pushPull";
import { VisualResolver } from "../presentation";
import { canRevealProtagonistArtwork } from "../protagonistArtworkPolicy";
import {
  selfDevelopmentSystem,
  type SelfDevelopmentActivityOption,
} from "../selfDevelopment";
import { canEnterScene, effectiveSpeaker, resolveDialogueNode } from "../storyLogic";
import type {
  ChoiceOption,
  GalleryEntry,
  GameModeId,
  Runtime,
  SelfDevelopmentStat,
  StoryNode,
  TimelineEvent,
  TimeSlot,
} from "../types";
import {
  advanceTimeline,
  advanceSession,
  availableTimelineEvents,
  availableOptions,
  beginSelfDevelopmentNight,
  consumeChoiceAnalysisHint,
  createSession,
  currentNode,
  finishSelfDevelopmentNight,
  nodeRead,
  prepareTimeSlot,
  selectSelfDevelopmentActivity,
  selectOption,
  startGameMode,
  startTimelineEvent,
  type ChoiceAnalysisHint,
  type PlayerSession,
} from "./playerRuntime";
import { nightPhaseCoordinator } from "./nightPhase";
import { resolveModeAccess } from "./gameModes";
import {
  choiceDebugEffect,
  dayChanged,
  showDialogueChrome,
  showSceneHud,
  stageCharacterFocusClass,
  visibleStageCharacters,
  visibleTimelineLogs,
} from "./playerUiPolicy";
import {
  readAutosave,
  readProfile,
  readSettings,
  readSlots,
  writeAutosave,
  writeSettings,
  writeSlot,
  type PlayerSettings,
  type PlayerProfile,
  type ReadableSaveSlot,
  type SaveSlot,
} from "./playerStorage";
import { GameLocalizer, gameLocales, type GameLocale } from "./gameI18n";
import {
  fetchLatestBuildId,
  refreshBuildShell,
  reloadUrlForBuild,
  shortBuildId,
} from "../mobile-authoring/appUpdate";
import {
  authoringRoot,
  consumeAuthoringPreviewTarget,
  copySourceLocator,
  getStoryTextOwner,
  inverseStoryTextEdits,
  openStorySource,
  readSourceEditor,
  revealStorySource,
  returnToStoryEditor,
  runtimeTextValues,
  saveStoryText,
  sourceLocator,
  writeSourceEditor,
  type SourceEditor,
  type StoryTextEdit,
  type StoryTextOwner,
  type StoryTextSaveResult,
  type StoryTextSource,
  type AuthoringTarget,
} from "./storyAuthoring";
import { rhythmGaugeMotion, rhythmMarkerPercent } from "./rhythmGauge";
import "./web-game.css";

const runtime = runtimeJson as unknown as Runtime;
const selfDevelopment = selfDevelopmentSystem(runtime);
// Keep the finished title art and localized title data intact so the normal
// lobby can be restored later by changing only this switch.
const DISCREET_PUBLIC_LOBBY = true;
const DISCREET_PUBLIC_TITLE = "office";
const SELF_DEVELOPMENT_STATS: readonly SelfDevelopmentStat[] = [
  "health",
  "appearance",
  "humor",
  "intelligence",
];
const assetModules = import.meta.glob([
  "../../assets/backgrounds/**/*",
  "../../assets/concept-art/*",
  "../../assets/concept-art-archive/*",
  "../../assets/characters/**/*",
  "../../assets/gallery/*",
  "../../assets/hud/*",
  "!../../assets/concept-art/lineup-*",
], {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

type Screen = "title" | "new-game" | "game";
type Overlay = "backlog" | "save" | "load" | "gallery" | "characters" | "settings" | "menu" | "text-edit" | null;

function assetUrl(path?: string): string | undefined {
  if (!path) return undefined;
  return assetModules[`../../${path.replace(/^\.\//, "")}`];
}

function slotLabel(i18n: GameLocalizer, slot: string): string {
  return i18n.ui(`slot.${slot}` as Parameters<GameLocalizer["ui"]>[0]);
}

function sceneTitle(i18n: GameLocalizer, sceneId: string): string {
  const scene = runtime.scenes[sceneId];
  return scene ? i18n.story(`scenes.${scene.id}.title`, scene.title) : sceneId;
}

function eventPresentation(i18n: GameLocalizer, event: TimelineEvent) {
  const source = event.presentation;
  return {
    title: i18n.story(`events.${event.id}.presentation.title`, source.title),
    summary: i18n.story(`events.${event.id}.presentation.summary`, source.summary),
  };
}

function choiceTriggerSummary(session: PlayerSession, i18n: GameLocalizer): { speaker: string; line: string } | undefined {
  const entries = [...session.backlog].reverse();
  const entry = entries.find((candidate) => {
    if (candidate.kind !== "dialogue") return false;
    const candidateNode = runtime.scenes[candidate.sceneId]?.nodes[candidate.nodeId];
    if (!candidateNode || (candidateNode.kind !== "dialogue" && candidateNode.kind !== "narration")) return false;
    const resolved = resolveDialogueNode(runtime, session.state, candidateNode, candidate.variantId);
    const speaker = effectiveSpeaker(resolved.node);
    return Boolean(speaker && speaker !== "han_do_yoon");
  })
    || entries.find((candidate) => candidate.kind !== "choice");
  if (!entry) return undefined;
  const sourceNode = runtime.scenes[entry.sceneId]?.nodes[entry.nodeId];
  if (!sourceNode || (sourceNode.kind !== "dialogue" && sourceNode.kind !== "narration")) return undefined;
  const resolved = resolveDialogueNode(runtime, session.state, sourceNode, entry.variantId);
  if (!resolved.node.line) return undefined;
  return {
    speaker: i18n.characterName(effectiveSpeaker(resolved.node)),
    line: i18n.story(dialogueKey(
      entry.sceneId,
      entry.nodeId,
      resolved.variantId,
      "line",
      Boolean(sourceNode.variants?.length),
    ), resolved.node.line),
  };
}

export function dialogueKey(
  sceneId: string,
  nodeId: string,
  variantId: string | undefined,
  field: string,
  hasVariants = false,
): string {
  const variant = variantId && (variantId !== "default" || hasVariants) ? `.variants.${variantId}` : "";
  return `scenes.${sceneId}.nodes.${nodeId}${variant}.${field}`;
}

const NIGHT_FLOW_ID = "system.night_activity";
const ANALYSIS_FLOW_ID = "system.analysis_hint";

function systemFlowKey(flowId: string, nodeId: string, variantId?: string): string {
  const variant = variantId ? `.variants.${variantId}` : "";
  return `system_flows.${flowId}.nodes.${nodeId}${variant}.line`;
}

function systemFlowLine(i18n: GameLocalizer, flowId: string, nodeId: string, variantId?: string): string {
  const node = runtime.system_flows[flowId]?.nodes[nodeId];
  const source = variantId
    ? node?.variants?.find((variant) => variant.id === variantId)?.line
    : node?.line;
  return i18n.story(systemFlowKey(flowId, nodeId, variantId), source || "");
}

function nightOption(i18n: GameLocalizer, activityId: string, field: "label" | "description"): string {
  const source = runtime.system_flows[NIGHT_FLOW_ID]?.options?.find((option) => option.id === activityId)?.[field] || activityId;
  return i18n.story(`system_flows.${NIGHT_FLOW_ID}.options.${activityId}.${field}`, source);
}

function signedValue(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function expressionStat(option: ChoiceOption): SelfDevelopmentStat | undefined {
  const stat = option.self_development?.expression.split(".")[0] as SelfDevelopmentStat | undefined;
  return stat && SELF_DEVELOPMENT_STATS.includes(stat) ? stat : undefined;
}

export function sessionSlot(session: PlayerSession): SaveSlot {
  const node = currentNode(runtime, session);
  const lastTimelineEvent = [...session.timelineLog].reverse().find((entry) => entry.status === "seen");
  const resolved = node && (node.kind === "dialogue" || node.kind === "narration")
    ? resolveDialogueNode(runtime, session.state, node)
    : undefined;
  return {
    schema_version: 6,
    savedAt: Date.now(),
    preview: {
      kind: session.phase === "complete" ? "ending" : session.phase,
      day: session.state.progress.time.day,
      slot: session.state.progress.time.slot,
      eventId: session.currentEventId || lastTimelineEvent?.eventId,
      sceneId: session.sceneId,
      nodeId: session.nodeId,
      variantId: resolved?.variantId,
      gameModeId: session.gameModeId,
      campaignId: session.campaignId,
      continuityId: session.continuityId,
      endingId: session.endingId,
    },
    session,
  };
}

export function savePreview(slot: ReadableSaveSlot, i18n: GameLocalizer): { title: string; line: string } {
  const session = slot.session;
  const preview = slot.preview;
  const scene = preview.sceneId ? runtime.scenes[preview.sceneId] : undefined;
  const node = preview.nodeId ? scene?.nodes[preview.nodeId] : undefined;
  if (preview.kind === "timeline") {
    const event = preview.eventId ? runtime.events[preview.eventId] : undefined;
    return {
      title: `DAY ${String(preview.day).padStart(2, "0")} · ${slotLabel(i18n, preview.slot as TimeSlot)}`,
      line: event ? eventPresentation(i18n, event).title : i18n.ui("save.waiting"),
    };
  }
  if (preview.kind === "self_development") {
    const activityId = session.nightPhase?.status === "result"
      ? session.nightPhase.result.activityId
      : undefined;
    const activity = runtime.self_development?.activities.find((candidate) => candidate.id === activityId);
    return {
      title: i18n.ui("slot.night"),
      line: activity
        ? nightOption(i18n, activity.id, "label")
        : systemFlowLine(i18n, NIGHT_FLOW_ID, "intro"),
    };
  }
  if (preview.kind === "ending") {
    return {
      title: preview.endingId || slot.legacy?.sceneTitle || i18n.ui("save.waiting"),
      line: slot.legacy?.line || i18n.ui("save.waiting"),
    };
  }
  let line = node?.prompt || slot.legacy?.line || preview.nodeId || i18n.ui("save.waiting");
  if (node && (node.kind === "dialogue" || node.kind === "narration")) {
    const resolved = resolveDialogueNode(runtime, session.state, node, preview.variantId);
    if (resolved.node.line) {
      line = i18n.story(dialogueKey(
        scene?.id || preview.sceneId || "",
        node.id,
        resolved.variantId,
        "line",
        Boolean(node.variants?.length),
      ), resolved.node.line);
    }
  }
  return {
    title: scene ? sceneTitle(i18n, scene.id) : slot.legacy?.sceneTitle || preview.sceneId || i18n.ui("save.waiting"),
    line,
  };
}

function Modal({
  title,
  children,
  onClose,
  i18n,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  i18n: GameLocalizer;
  wide?: boolean;
}) {
  return <div className="vn-modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className={`vn-modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
      <header><div><span>{i18n.ui("app.brand")}</span><h2>{title}</h2></div><button type="button" onClick={onClose} aria-label={i18n.ui("menu.close")}>×</button></header>
      <div className="vn-modal-body">{children}</div>
    </section>
  </div>;
}

type StoryTextUndo = {
  edits: StoryTextEdit[];
  keys: string[];
  locale: GameLocale;
};

function storySourceId(source: StoryTextSource): string {
  return `${source.relativePath}::${source.fieldPath}`;
}

function storyOwnersFingerprint(owners: StoryTextOwner[]): string {
  return JSON.stringify(owners.map((owner) => ({
    key: owner.key,
    revision: owner.revision,
    currentValueHash: owner.currentValueHash,
    sources: owner.sources.map((source) => [
      source.relativePath,
      source.fieldPath,
      source.revision,
      source.currentValueHash,
    ]),
  })));
}

type StoryTextCommitResult = {
  revision: string;
  result: StoryTextSaveResult;
  refreshed: StoryTextOwner[];
  undo: StoryTextUndo;
};

function StoryTextEditor({
  root,
  keys,
  locale,
  onSaved,
  onClose,
  i18n,
}: {
  root: string;
  keys: string[];
  locale: GameLocale;
  onSaved: (result: StoryTextSaveResult, undo: StoryTextUndo, editedLocale: GameLocale) => void;
  onClose: () => void;
  i18n: GameLocalizer;
}) {
  const [editingLocale, setEditingLocale] = useState(locale);
  const [owners, setOwners] = useState<StoryTextOwner[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [editVersion, setEditVersion] = useState(0);
  const [sourceEditor, setSourceEditor] = useState<SourceEditor>(() => readSourceEditor());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("원본 위치를 찾는 중…");
  const ownersRef = useRef(owners);
  const valuesRef = useRef(values);
  ownersRef.current = owners;
  valuesRef.current = values;
  const draftKey = useMemo(
    () => `love-office:story-text-draft:${encodeURIComponent(root)}:${editingLocale}:${keys.join("|")}`,
    [editingLocale, keys, root],
  );

  const installOwners = useCallback((loaded: StoryTextOwner[]) => {
    ownersRef.current = loaded;
    setOwners(loaded);
    const nextValues = Object.fromEntries(loaded.map((owner) => [owner.key, owner.currentValue]));
    valuesRef.current = nextValues;
    setValues(nextValues);
    setEditVersion(0);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage("원본 위치를 찾는 중…");
    try {
      const loaded = await Promise.all(keys.map((key) => getStoryTextOwner(root, key, editingLocale)));
      installOwners(loaded);
      let recoveredDraft = false;
      try {
        const journalDraft = await editorDraftJournal.read<{ fingerprint?: string; values?: Record<string, string> }>(draftKey);
        const rawDraft = window.localStorage.getItem(draftKey);
        const draft = journalDraft?.value || (rawDraft ? JSON.parse(rawDraft) as { fingerprint?: string; values?: Record<string, string> } : undefined);
        if (draft) {
          if (draft.fingerprint === storyOwnersFingerprint(loaded)) {
            setValues((current) => {
              const recovered = { ...current, ...draft.values };
              valuesRef.current = recovered;
              return recovered;
            });
            setEditVersion(Math.max(1, journalDraft?.editVersion || 1));
            recoveredDraft = true;
          } else void editorDraftJournal.remove(draftKey);
          window.localStorage.removeItem(draftKey);
        }
      } catch {
        // Restricted WebViews may not expose localStorage; editing still works without draft recovery.
      }
      const missingTranslations = loaded.filter((owner) => owner.isTranslation && !owner.translationExists).length;
      setMessage(recoveredDraft
        ? "저장하지 않은 인게임 편집 초안을 복구했습니다."
        : missingTranslations
          ? `${missingTranslations}개 문장은 아직 직접 번역이 없습니다. 현재 원문을 바탕으로 새 번역을 만들 수 있습니다.`
          : "저장하면 YAML과 게임 런타임을 함께 검증해 현재 화면에 반영합니다.");
    } catch (error) {
      setMessage(`원본을 찾지 못했습니다: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [draftKey, editingLocale, installOwners, keys, root]);

  useEffect(() => { void load(); }, [load]);

  const hasChanges = owners.some((owner) => owner.editable && values[owner.key] !== owner.currentValue);

  const sourceFingerprint = useMemo(() => storyOwnersFingerprint(owners), [owners]);
  useDraftJournal({
    enabled: hasChanges,
    key: draftKey,
    projectRoot: root,
    baseRevision: sourceFingerprint,
    editVersion,
    value: hasChanges ? { fingerprint: sourceFingerprint, values } : null,
  });

  const commitStoryText = useCallback(async (snapshot: DocumentSnapshot<Record<string, string>>): Promise<StoryTextCommitResult> => {
    const activeOwners = ownersRef.current;
    const edits: StoryTextEdit[] = activeOwners
      .filter((owner) => owner.editable && snapshot.value[owner.key] !== owner.currentValue)
      .map((owner) => ({
        localization_key: owner.key,
        locale: editingLocale,
        expected_revision: owner.revision!,
        expected_value_hash: owner.currentValueHash!,
        next_value: snapshot.value[owner.key],
      }));
    try {
      const result = await saveStoryText(root, edits);
      if (!result.saved || !result.runtime && !result.runtimePatch) {
        const error = result.issues.find((issue) => issue.severity === "error");
        throw new SaveFailure(error?.message || result.errorCode || "검증 오류로 저장하지 않았습니다.", "validation");
      }
      const refreshed = await Promise.all(keys.map((key) => getStoryTextOwner(root, key, editingLocale)));
      ownersRef.current = refreshed;
      return {
        revision: storyOwnersFingerprint(refreshed),
        result,
        refreshed,
        undo: { edits: inverseStoryTextEdits(result.changes || [], refreshed, editingLocale), keys, locale: editingLocale },
      };
    } catch (error) {
      if (error instanceof SaveFailure) throw error;
      const text = String(error);
      throw new SaveFailure(
        text.includes("REVISION_CONFLICT") || text.includes("VALUE_CONFLICT")
          ? "외부에서 원본이 변경되었습니다. 초안은 유지했습니다. 다시 불러온 뒤 비교해 주세요."
          : `저장하지 못했습니다: ${text}`,
        text.includes("CONFLICT") ? "conflict" : "transient",
      );
    }
  }, [editingLocale, keys, root]);

  const handleCommitted = useCallback((commit: StoryTextCommitResult, completion: SaveCompletion<Record<string, string>>) => {
    setOwners(commit.refreshed);
    if (completion.isLatest) {
      const nextValues = Object.fromEntries(commit.refreshed.map((owner) => [owner.key, owner.currentValue]));
      valuesRef.current = nextValues;
      setValues(nextValues);
      void editorDraftJournal.remove(draftKey);
    }
    onSaved(commit.result, commit.undo, editingLocale);
    setMessage(completion.isLatest
      ? "저장 완료 · 실제 원본과 현재 게임 화면에 반영했습니다. 화면의 ‘마지막 문구 저장 취소’로 되돌릴 수 있습니다."
      : "이전 변경 저장 완료 · 저장 중 입력한 최신 문구를 이어서 저장합니다.");
  }, [draftKey, editingLocale, onSaved]);

  const handleSaveState = useCallback((state: SaveState) => {
    setSaving(state.phase === "saving" || state.phase === "queued");
    if (state.phase === "saving") setMessage(state.hasPendingChanges ? "이전 변경 저장 중 · 최신 입력 대기" : "백그라운드 저장 중…");
    else if (state.phase === "queued") setMessage("백그라운드 저장 대기 중…");
    else if (state.phase === "error" || state.phase === "conflict") setMessage(state.error || "저장 실패 · 초안은 보존했습니다.");
  }, []);

  const { flush: save, state: saveState } = useDocumentAutosave<Record<string, string>, StoryTextCommitResult>({
    slot: "play-story-text",
    active: true,
    projectRoot: root,
    documentKey: `story-text:${editingLocale}:${keys.join("|")}`,
    revision: sourceFingerprint,
    dirty: hasChanges,
    version: editVersion,
    read: () => valuesRef.current,
    commit: commitStoryText,
    onCommitted: handleCommitted,
    onState: handleSaveState,
  });
  useSaveCommandBinding();

  const switchEditingLocale = async (candidate: GameLocale) => {
    if (candidate === editingLocale) return;
    if (hasChanges) {
      await save();
      if (saveState()?.hasPendingChanges) {
        setMessage("현재 언어의 저장 문제를 해결한 뒤 다른 언어로 이동할 수 있습니다. 초안은 보존했습니다.");
        return;
      }
    }
    setLoading(true);
    setEditingLocale(candidate);
  };

  const closeEditor = async () => {
    if (hasChanges) await editorSaveCoordinator.barrier("play-story-text");
    await editorDraftJournal.flush();
    onClose();
  };

  const reloadSource = async () => {
    if (hasChanges && !window.confirm("저장하지 않은 현재 초안을 원본으로 다시 불러올까요?")) return;
    await load();
  };

  const openSource = (source: StoryTextSource) => void openStorySource(root, source, sourceEditor);
  const updateSourceEditor = (editor: SourceEditor) => {
    setSourceEditor(editor);
    writeSourceEditor(editor);
  };

  return <Modal title="인게임 원본 문구 편집" onClose={() => void closeEditor()} i18n={i18n} wide>
    <div className="vn-story-editor">
      <div className="vn-authoring-toolbar">
        <div className="vn-authoring-locales" aria-label="편집 언어">
          {gameLocales(runtime).map((candidate) => <button type="button" className={editingLocale === candidate ? "active" : ""} disabled={loading} onClick={() => void switchEditingLocale(candidate)} key={candidate}>
            {candidate === runtime.localization.default_locale ? "한국어 원본" : `${i18n.localeName(candidate)} 번역`}
          </button>)}
        </div>
        <label>원본 열기<select value={sourceEditor} onChange={(event) => updateSourceEditor(event.target.value as SourceEditor)}>
          <option value="system">시스템 기본 앱</option>
          <option value="vscode">VS Code · 정확한 줄</option>
          <option value="cursor">Cursor · 정확한 줄</option>
          <option value="zed">Zed · 정확한 줄</option>
        </select></label>
      </div>
      <p className="vn-story-editor-status" role="status">{message}</p>
      {owners.map((owner) => <section className={owner.editable ? "editable" : "fallback"} key={owner.key}>
        <header><strong>{owner.isTranslation ? (owner.translationExists ? `${editingLocale} 번역 편집` : `${editingLocale} 새 번역`) : owner.editable ? "직접 편집" : "편집 불가"}</strong><code>{owner.key}</code></header>
        {owner.isTranslation && !owner.translationExists && <small className="vn-translation-fallback">현재 한국어 원문: {owner.sourceValue}</small>}
        {owner.editable && <textarea
          autoFocus={owner.key === owners.find((candidate) => candidate.editable)?.key}
          rows={Math.max(3, Math.min(9, (values[owner.key]?.split("\n").length || 1) + 2))}
          value={values[owner.key] || ""}
          maxLength={owner.maxLength}
          onChange={(event) => {
            const nextValue = event.target.value;
            setValues((current) => {
              const next = { ...current, [owner.key]: nextValue };
              valuesRef.current = next;
              return next;
            });
            setEditVersion((current) => current + 1);
          }}
          disabled={loading}
        />}
        {!owner.editable && <blockquote>{owner.currentValue}</blockquote>}
        <div className="vn-story-source-list">{owner.sources.map((source) => <div key={storySourceId(source)}>
          <code>{sourceLocator(source)}</code>
          <button type="button" onClick={() => openSource(source)}>원본 파일 열기</button>
          <button type="button" onClick={() => void revealStorySource(root, source)}>Finder에서 보기</button>
          <button type="button" onClick={() => void copySourceLocator(source)}>위치 복사</button>
        </div>)}</div>
      </section>)}
      <footer>
        <button type="button" onClick={() => void reloadSource()} disabled={loading}>원본 다시 불러오기</button>
        <button type="button" onClick={() => void closeEditor()}>닫기</button>
        <button type="button" className="primary" onClick={() => void save()} disabled={loading || !hasChanges}>{saving ? "저장 중…" : editingLocale === runtime.localization.default_locale ? "원본 저장" : `${editingLocale} 번역 저장`} <kbd>⌘S</kbd></button>
      </footer>
    </div>
  </Modal>;
}

function galleryEntryUnlocked(entry: GalleryEntry, profile: PlayerProfile): boolean {
  return entry.default_unlocked === true || profile.memories.includes(entry.unlock_memory);
}

function GalleryPanel({ profile, i18n }: { profile: PlayerProfile; i18n: GameLocalizer }) {
  const entries = runtime.gallery?.entries || [];
  const unlockedEntries = entries.filter((entry) => galleryEntryUnlocked(entry, profile));
  const [selectedId, setSelectedId] = useState(() => unlockedEntries[0]?.id || "");
  const selected = unlockedEntries.find((entry) => entry.id === selectedId) || unlockedEntries[0];
  return <div className="vn-gallery">
    <div className="vn-gallery-summary">
      <strong>{i18n.ui("gallery.progress", { unlocked: unlockedEntries.length, total: entries.length })}</strong>
    </div>
    {entries.length ? <div className="vn-gallery-layout">
      <div className="vn-gallery-grid">
        {entries.map((entry) => {
          const unlocked = galleryEntryUnlocked(entry, profile);
          const title = unlocked
            ? i18n.ui(entry.title_key as Parameters<GameLocalizer["ui"]>[0])
            : i18n.ui("gallery.lockedTitle");
          return <button
            type="button"
            className={`${unlocked ? "unlocked" : "locked"} ${selected?.id === entry.id ? "active" : ""}`}
            disabled={!unlocked}
            onClick={() => setSelectedId(entry.id)}
            aria-label={title}
            key={entry.id}
          >
            {unlocked && <img src={assetUrl(entry.asset)} alt="" />}
            {!unlocked && <i aria-hidden="true">?</i>}
            <span>{title}</span>
          </button>;
        })}
      </div>
      <article className="vn-gallery-viewer">
        {selected ? <>
          <img src={assetUrl(selected.asset)} alt={i18n.ui(selected.title_key as Parameters<GameLocalizer["ui"]>[0])} />
          <div><h3>{i18n.ui(selected.title_key as Parameters<GameLocalizer["ui"]>[0])}</h3><p>{i18n.ui(selected.description_key as Parameters<GameLocalizer["ui"]>[0])}</p></div>
        </> : <p>{i18n.ui("gallery.lockedDescription")}</p>}
      </article>
    </div> : <p className="vn-empty">{i18n.ui("gallery.empty")}</p>}
  </div>;
}

const CHARACTER_PROFILE_FIELD_IDS = [
  "name",
  "affiliation",
  "mbti",
  "hobby",
  "likes",
  "ideal_type",
  "residence",
  "tmi",
] as const;

type CharacterProfileFieldId = typeof CHARACTER_PROFILE_FIELD_IDS[number];

export function characterProfileFieldUnlocked(unlockMemory: string, profile: PlayerProfile): boolean {
  return profile.memories.includes(unlockMemory);
}

export function primaryCharacterProfileIds(): string[] {
  return Object.values(runtime.characters)
    .filter((character) => character.player_profile)
    .sort((left, right) => left.player_profile!.order - right.player_profile!.order)
    .map((character) => character.id);
}

function CharacterPanel({ profile, i18n }: { profile: PlayerProfile; i18n: GameLocalizer }) {
  const profiles = Object.values(runtime.characters)
    .filter((character) => character.player_profile)
    .sort((left, right) => left.player_profile!.order - right.player_profile!.order);
  const [showOthers, setShowOthers] = useState(false);
  const [selectedId, setSelectedId] = useState(() => profiles[0]?.id || "");
  const selected = profiles.find((character) => character.id === selectedId) || profiles[0];
  const otherMembers = (runtime.world?.by_kind.member || [])
    .map((memberId) => runtime.world?.entities[memberId])
    .filter((member): member is NonNullable<typeof member> => Boolean(
      member && !profiles.some((character) => character.id === member.story_character),
    ))
    .sort((left, right) => {
      if (left.story_character === "han_do_yoon") return -1;
      if (right.story_character === "han_do_yoon") return 1;
      return String(left.display_name || left.id).localeCompare(String(right.display_name || right.id), i18n.locale);
    });

  return <div className="vn-characters">
    <nav className="vn-character-switch" aria-label={i18n.ui("character.title")}>
      <button type="button" className={!showOthers ? "active" : ""} onClick={() => setShowOthers(false)}>{i18n.ui("character.main")}</button>
      <button type="button" className={showOthers ? "active" : ""} onClick={() => setShowOthers(true)}>{i18n.ui("character.others")}</button>
    </nav>
    {showOthers ? <div className="vn-coworker-grid">
      {otherMembers.map((member) => {
        const sourceName = String(member.display_name || member.id);
        const name = member.story_character
          ? i18n.characterName(member.story_character)
          : i18n.story(`world.members.${member.id}.display_name`, sourceName);
        const summarySource = typeof member.compendium_summary === "string" ? member.compendium_summary : "";
        const summary = i18n.story(`world.members.${member.id}.compendium_summary`, summarySource);
        return <article key={member.id}>
          <i aria-hidden="true">{name.slice(0, 1)}</i>
          <div><h3>{name}</h3><strong>{String(member.title || "")}</strong><p>{summary}</p></div>
        </article>;
      })}
    </div> : selected && <>
      <div className="vn-character-lineup">
        {profiles.map((character) => {
          const characterProfile = character.player_profile!;
          const portraitUnlocked = profile.memories.includes(characterProfile.portrait_unlock_memory);
          const unlocked = Object.values(characterProfile.fields)
            .filter((field) => characterProfileFieldUnlocked(field.unlock_memory, profile)).length;
          return <button
            type="button"
            className={selected.id === character.id ? "active" : ""}
            onClick={() => setSelectedId(character.id)}
            key={character.id}
          >
            <span className={`vn-character-lineup-art ${portraitUnlocked ? "revealed" : "silhouette"}`}>
              <img src={assetUrl(character.visual.concept_art)} alt="" />
            </span>
            <strong>{i18n.characterName(character.id)}</strong>
            <small>{i18n.ui("character.progress", { unlocked, total: CHARACTER_PROFILE_FIELD_IDS.length })}</small>
          </button>;
        })}
      </div>
      <section className="vn-character-profile">
        <div className={`vn-character-portrait ${profile.memories.includes(selected.player_profile!.portrait_unlock_memory) ? "revealed" : "silhouette"}`}>
          <img src={assetUrl(selected.visual.concept_art)} alt="" />
          <span>{String(selected.player_profile!.order).padStart(2, "0")}</span>
        </div>
        <dl>
          {CHARACTER_PROFILE_FIELD_IDS.map((fieldId) => {
            const field = selected.player_profile!.fields[fieldId];
            const unlocked = characterProfileFieldUnlocked(field.unlock_memory, profile);
            const value = unlocked
              ? i18n.story(`characters.${selected.id}.player_profile.fields.${fieldId}.value`, field.value)
              : i18n.ui("character.locked");
            return <div className={unlocked ? "unlocked" : "locked"} key={fieldId}>
              <dt>{i18n.ui(`character.field.${fieldId}` as `character.field.${CharacterProfileFieldId}`)}</dt>
              <dd>{value}</dd>
            </div>;
          })}
        </dl>
      </section>
    </>}
  </div>;
}

function TitleScreen({
  autosave,
  onContinue,
  onNewGame,
  onLoad,
  onGallery,
  onCharacters,
  onSettings,
  i18n,
  onLocale,
}: {
  autosave?: SaveSlot;
  onContinue: () => void;
  onNewGame: () => void;
  onLoad: () => void;
  onGallery: () => void;
  onCharacters: () => void;
  onSettings: () => void;
  i18n: GameLocalizer;
  onLocale: (locale: GameLocale) => void;
}) {
  return <main className={`vn-title ${DISCREET_PUBLIC_LOBBY ? "discreet" : ""}`}>
    {!DISCREET_PUBLIC_LOBBY && <img
      className="vn-title-key-art"
      src={`${import.meta.env.BASE_URL}og.png`}
      alt=""
      aria-hidden="true"
    />}
    <h1 className={DISCREET_PUBLIC_LOBBY ? "vn-title-private-name" : "vn-visually-hidden"}>
      {DISCREET_PUBLIC_LOBBY ? DISCREET_PUBLIC_TITLE : i18n.ui("app.title")}
    </h1>
    <header className="vn-title-topbar">
      <div className="vn-language-tabs" aria-label={i18n.ui("locale.label")}>
        {gameLocales(runtime).map((locale) => <button
          type="button"
          className={i18n.locale === locale ? "active" : ""}
          onClick={() => onLocale(locale)}
          key={locale}
        >{i18n.localeName(locale)}</button>)}
      </div>
    </header>
    <section className="vn-title-lobby">
      <nav className="vn-title-menu" aria-label={i18n.ui("menu.main")}>
        <button type="button" data-icon="♥" className={autosave ? "primary" : ""} disabled={!autosave} onClick={onContinue}><span>{i18n.ui("menu.continue")}</span><small>{autosave ? savePreview(autosave, i18n).title : i18n.ui("menu.noSave")}</small></button>
        <button type="button" data-icon="✦" className={!autosave ? "primary" : ""} onClick={onNewGame}><span>{i18n.ui("menu.newGame")}</span></button>
        <button type="button" data-icon="♡" onClick={onLoad}><span>{i18n.ui("menu.load")}</span></button>
        <button type="button" data-icon="▣" onClick={onGallery}><span>{i18n.ui("menu.gallery")}</span><small>{i18n.ui("menu.galleryHint")}</small></button>
        <button type="button" data-icon="♟" onClick={onCharacters}><span>{i18n.ui("menu.characters")}</span><small>{i18n.ui("menu.charactersHint")}</small></button>
        <button type="button" data-icon="⚙" onClick={onSettings}><span>{i18n.ui("menu.settings")}</span></button>
      </nav>
      <footer><span>{i18n.ui("app.brand")}</span><span>{i18n.ui("app.webPlayer")}</span></footer>
    </section>
  </main>;
}

function NewGameScreen({
  onStart,
  onBack,
  i18n,
}: {
  onStart: (mode: GameModeId) => void;
  onBack: () => void;
  i18n: GameLocalizer;
}) {
  const profile = readProfile();
  const anotherAccess = resolveModeAccess(runtime, "survivor_view", profile);
  const anotherUnlocked = anotherAccess !== "locked";
  return <main className="vn-route-screen">
    <button type="button" className="vn-route-back" onClick={onBack}>{i18n.ui("newGame.back")}</button>
    <div className="vn-mode-grid">
      <button type="button" className="vn-mode-card story" onClick={() => onStart("base")}>
        <i>♥</i><span>{i18n.ui("mode.story.label")}</span><h2>{i18n.ui("mode.story.title")}</h2><strong>{i18n.ui("mode.story.strong")}</strong>
        <p>{i18n.ui("mode.story.copy")}</p><em>{i18n.ui("mode.story.action")}</em>
      </button>
      <button type="button" className={`vn-mode-card survivor ${anotherUnlocked ? "" : "locked"}`} disabled={!anotherUnlocked} onClick={() => onStart("survivor_view")}>
        <i>♡</i><span>{i18n.ui("mode.survivor.label")}</span><h2>{i18n.ui("mode.survivor.title")}</h2><strong>{i18n.ui(anotherUnlocked ? "mode.survivor.unlocked" : "mode.survivor.strong")}</strong>
        <p>{i18n.ui("mode.survivor.copy")}</p><em>{i18n.ui(anotherUnlocked ? "mode.survivor.action" : "mode.locked")}</em>
      </button>
    </div>
  </main>;
}

function DayTransition({ from, to, i18n }: { from: number; to: number; i18n: GameLocalizer }) {
  return <main className="vn-day-transition" role="status" aria-live="assertive">
    <div className="vn-day-transition-orbit" aria-hidden="true"><i /><i /><i /></div>
    <div className="vn-day-transition-copy">
      <span>{i18n.ui("dayChange.label")}</span>
      <div><small>DAY {String(from).padStart(2, "0")}</small><i>→</i><strong>DAY {String(to).padStart(2, "0")}</strong></div>
    </div>
  </main>;
}

function FlowScreen({
  session,
  acknowledgedLogs,
  debugMode,
  onAcknowledge,
  onSelect,
  onAdvance,
  onStepBack,
  canStepBack,
  onMenu,
  onEditText,
  i18n,
}: {
  session: PlayerSession;
  acknowledgedLogs: ReadonlySet<string>;
  debugMode: boolean;
  onAcknowledge: (logId: string) => void;
  onSelect: (eventId: string) => void;
  onAdvance: () => void;
  onStepBack: () => void;
  canStepBack: boolean;
  onMenu: () => void;
  onEditText?: (keys: string[]) => void;
  i18n: GameLocalizer;
}) {
  const { day, slot } = session.state.progress.time;
  const events = availableTimelineEvents(runtime, session);
  const relevantLogs = session.timelineLog
    .filter((entry) => entry.day === day && entry.slot === slot)
    .filter((entry) => Boolean(runtime.events[entry.eventId]))
    .map((entry) => ({ ...entry, eventHasScene: Boolean(runtime.events[entry.eventId]?.scene) }));
  const pendingLog = visibleTimelineLogs(relevantLogs, acknowledgedLogs, false)[0];
  const pendingEvent = pendingLog ? runtime.events[pendingLog.eventId] : undefined;
  const background = assetUrl(slot === "morning"
    ? "assets/backgrounds/office-pantry-morning.png"
    : slot === "lunch"
      ? "assets/backgrounds/glass-meeting-room-afternoon.png"
      : "assets/backgrounds/open-office-late-afternoon.png");

  return <main className="vn-game vn-flow-game">
    <div className="vn-stage">
      {background && <img className="vn-stage-bg" src={background} alt="" />}
      <div className="vn-stage-light" />
      <div className="vn-flow-shade" />
    </div>
    <header className="vn-flow-hud">
      <div><span>DAY {String(day).padStart(2, "0")}</span><strong>{slotLabel(i18n, slot)}</strong></div>
      {debugMode && <button type="button" className="vn-debug-previous" disabled={!canStepBack} onClick={onStepBack}>{i18n.ui("debug.previous")}</button>}
      <button type="button" className="vn-menu-button" onClick={onMenu} aria-label={i18n.ui("hud.gameMenu")}>☰</button>
    </header>

    {pendingEvent && pendingLog && <section className="vn-flow-dialogue">
      <p>{eventPresentation(i18n, pendingEvent).summary}</p>
      <button type="button" onClick={() => onAcknowledge(pendingLog.id)}>{i18n.ui("flow.continue")}</button>
      {debugMode && <small>DEBUG · {pendingEvent.id} · {pendingLog.status}</small>}
      {debugMode && onEditText && <button type="button" className="vn-authoring-button" onClick={() => onEditText([
        `events.${pendingEvent.id}.title`,
        `events.${pendingEvent.id}.presentation.title`,
        `events.${pendingEvent.id}.presentation.summary`,
      ])}>사건 문구 편집</button>}
      {debugMode && onEditText && <button type="button" className="vn-authoring-button" onClick={() => onEditText(["flow.continue"])}>진행 문구 편집</button>}
    </section>}

    {!pendingEvent && events.length > 0 && <section className="vn-flow-choices" aria-label={i18n.ui("flow.choicePrompt")}>
      <div className="vn-choice-context"><span>{i18n.ui("flow.choiceContext")}</span><strong>{i18n.ui("flow.choicePrompt")}</strong></div>
      <div className="vn-flow-option-list">
        {events.map((event, index) => {
          const presentation = eventPresentation(i18n, event);
          return <button type="button" onClick={() => onSelect(event.id)} key={event.id}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div><strong>{presentation.title}</strong><small>{presentation.summary}</small></div>
            {debugMode && <em>DEBUG · {event.id}</em>}
          </button>;
        })}
        <button type="button" className="pass" onClick={onAdvance}>
          <span>{String(events.length + 1).padStart(2, "0")}</span>
          <div><strong>{i18n.ui("flow.passAction")}</strong><small>{i18n.ui("flow.passCopy")}</small></div>
        </button>
      </div>
      {debugMode && onEditText && <div className="vn-flow-authoring-list">
        <button type="button" onClick={() => onEditText(["flow.choiceContext", "flow.choicePrompt", "flow.passAction", "flow.passCopy"])}>이 화면 공통 문구</button>
        {events.map((event) => <button type="button" key={event.id} onClick={() => onEditText([
          `events.${event.id}.title`,
          `events.${event.id}.presentation.title`,
          `events.${event.id}.presentation.summary`,
        ])}>{event.id} 원본 문구</button>)}
      </div>}
    </section>}
  </main>;
}

function activityIcon(activityId: string): string {
  if (activityId === "workout") return "◆";
  if (activityId === "reading") return "▤";
  if (activityId === "ott") return "▶";
  if (activityId === "dark_psychology") return "✦";
  if (activityId === "solo_drinking") return "◒";
  return "☾";
}

function NightDialogueFlow({
  session,
  debugMode,
  onBegin,
  onActivity,
  onContinue,
  onMenu,
  onEditText,
  i18n,
}: {
  session: PlayerSession;
  debugMode: boolean;
  onBegin: () => void;
  onActivity: (activityId: string) => void;
  onContinue: () => void;
  onMenu: () => void;
  onEditText?: (keys: string[]) => void;
  i18n: GameLocalizer;
}) {
  const night = session.nightPhase;
  const profile = selfDevelopment.profile(session.state).snapshot();
  const options = selfDevelopment.activityOptions(session.state);
  const result = night?.status === "result" ? night.result : undefined;
  const resultActivity = result
    ? runtime.self_development.activities.find((activity) => activity.id === result.activityId)
    : undefined;
  const activityTags = (option: SelfDevelopmentActivityOption) => [
    ...(option.activity.appeal_delta
      ? [`${i18n.ui("selfDevelopment.appeal")} ${signedValue(option.activity.appeal_delta)}`]
      : []),
    ...SELF_DEVELOPMENT_STATS
      .filter((stat) => Boolean(option.activity.stat_deltas[stat]))
      .map((stat) => `${i18n.ui(`selfDevelopment.stat.${stat}` as Parameters<GameLocalizer["ui"]>[0])} ${signedValue(option.activity.stat_deltas[stat] || 0)}`),
    ...(option.activity.fatigue_delta
      ? [`${i18n.ui("selfDevelopment.fatigue")} ${signedValue(option.activity.fatigue_delta)}`]
      : []),
    ...(option.activity.hint_charge
      ? [`${i18n.ui("analysisHint.charge")} ${signedValue(option.activity.hint_charge)}`]
      : []),
  ];
  const introNodeId = night?.status === "intro" && night.forcedActivityId ? "forced_intro" : "intro";
  const visibleTextKeys = [
    systemFlowKey(NIGHT_FLOW_ID, introNodeId),
    "selfDevelopment.status",
    "selfDevelopment.appeal",
    "selfDevelopment.fatigue",
    "selfDevelopment.choose",
    "selfDevelopment.blocked",
    "analysisHint.charge",
    "analysisHint.charges",
    ...SELF_DEVELOPMENT_STATS.map((stat) => `selfDevelopment.stat.${stat}`),
    ...(night?.status === "selecting" ? options.flatMap((option) => [
      `system_flows.${NIGHT_FLOW_ID}.options.${option.activity.id}.label`,
      `system_flows.${NIGHT_FLOW_ID}.options.${option.activity.id}.description`,
    ]) : []),
    ...(resultActivity ? [
      `system_flows.${NIGHT_FLOW_ID}.options.${resultActivity.id}.label`,
      systemFlowKey(NIGHT_FLOW_ID, "activity_result", resultActivity.id),
    ] : []),
  ];
  const reflection = resultActivity
    ? systemFlowLine(i18n, NIGHT_FLOW_ID, "activity_result", resultActivity.id)
    : "";
  const intro = systemFlowLine(i18n, NIGHT_FLOW_ID, introNodeId);
  const dialogueLine = night?.status === "result" ? reflection : intro;
  const dialogueAction = night?.status === "result" ? onContinue : onBegin;
  const showHanName = true;

  return <main className="vn-game vn-night-story">
    <div className="vn-night-home" aria-hidden="true">
      <i className="window" /><i className="lamp" /><i className="sofa" /><i className="table" />
    </div>
    <header className="vn-flow-hud">
      <div><span>DAY {String(session.state.progress.time.day).padStart(2, "0")}</span><strong>{i18n.ui("slot.night")}</strong></div>
      <button type="button" className="vn-menu-button" onClick={onMenu} aria-label={i18n.ui("hud.gameMenu")}>☰</button>
      {debugMode && <div className="vn-debug-badge">DEBUG</div>}
    </header>

    {debugMode && onEditText && <button type="button" className="vn-authoring-button vn-night-authoring" onClick={() => onEditText(visibleTextKeys)}>현재 화면 문구 편집</button>}
    {night?.status === "selecting" && <>
      <section className="vn-night-status" aria-label={i18n.ui("selfDevelopment.status")}>
        <span><small>{i18n.ui("selfDevelopment.appeal")}</small><strong>{profile.appeal}</strong></span>
        {SELF_DEVELOPMENT_STATS.map((stat) => <span key={stat}>
          <small>{i18n.ui(`selfDevelopment.stat.${stat}` as Parameters<GameLocalizer["ui"]>[0])}</small>
          <strong>{profile.stats[stat]}</strong>
        </span>)}
        <span><small>{i18n.ui("selfDevelopment.fatigue")}</small><strong>{profile.fatigue}<i>/6</i></strong></span>
        <span><small>{i18n.ui("analysisHint.charges")}</small><strong>{session.state.progress.self_development.hint_charges}</strong></span>
      </section>
      <section className="vn-choices vn-night-choices" aria-label={i18n.ui("selfDevelopment.choose")}>
        <div className="vn-night-activity-list">
          {options.map((option) => {
            const title = nightOption(i18n, option.activity.id, "label");
            return <button
              type="button"
              className={option.available ? "" : "blocked"}
              disabled={!option.available}
              onClick={() => onActivity(option.activity.id)}
              aria-label={`${title}${option.available ? "" : ` · ${i18n.ui("selfDevelopment.blocked")}`}`}
              key={option.activity.id}
            >
              <span aria-hidden="true">{activityIcon(option.activity.id)}</span>
              <strong>{title}</strong>
              <em>{option.available
                ? activityTags(option).join(" · ")
                : i18n.ui("selfDevelopment.blocked")}</em>
              {debugMode && <code>DEBUG · {option.activity.id}</code>}
            </button>;
          })}
        </div>
      </section>
    </>}

    {(night?.status === "intro" || night?.status === "result") && <section
      className="vn-dialogue vn-night-dialogue"
      role="button"
      tabIndex={0}
      aria-live={night.status === "result" ? "polite" : undefined}
      onClick={dialogueAction}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") dialogueAction();
      }}
    >
      {showHanName && <div className="vn-nameplate">{i18n.characterName("han_do_yoon")}</div>}
      <p className="vn-line">{dialogueLine}<i className="done" /></p>
      {debugMode && night.status === "result" && <code>DEBUG · {night.result.activityId}</code>}
    </section>}
  </main>;
}

function AnimatedRhythmScore({
  score,
  from,
  animationId,
  reducedMotion,
  label,
}: {
  score: number;
  from: number;
  animationId: string;
  reducedMotion: boolean;
  label: string;
}) {
  const [displayedScore, setDisplayedScore] = useState(score);

  useEffect(() => {
    if (!animationId || reducedMotion || from === score) {
      setDisplayedScore(score);
      return undefined;
    }
    let frame = 0;
    const duration = 450;
    const startedAt = performance.now();
    setDisplayedScore(from);
    const count = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - ((1 - progress) ** 3);
      setDisplayedScore(Math.round(from + ((score - from) * eased)));
      if (progress < 1) frame = window.requestAnimationFrame(count);
    };
    frame = window.requestAnimationFrame(count);
    return () => window.cancelAnimationFrame(frame);
  }, [animationId, from, reducedMotion, score]);

  return <output className={`vn-rhythm-score ${animationId ? "changed" : ""}`} aria-live="polite" aria-label={`${label} SCORE ${score} / 100`}>
    <small>SCORE</small>
    <strong aria-hidden="true">{String(displayedScore).padStart(3, "0")}</strong>
    <span aria-hidden="true">/100</span>
  </output>;
}

function RhythmGauge({
  session,
  debugMode,
  animationId,
  reducedMotion,
  i18n,
}: {
  session: PlayerSession;
  debugMode: boolean;
  animationId: string;
  reducedMotion: boolean;
  i18n: GameLocalizer;
}) {
  const value = readPushPullState(session.state);
  const marker = rhythmMarkerPercent(value.position);
  const target = value.target === "pull" ? 34 : value.target === "push" ? 66 : 50;
  const routeHeroine = runtime.routes[session.routeId]?.heroine;
  const heroineId = value.heroine || routeHeroine || "";
  const heroineName = heroineId ? i18n.characterName(heroineId) : i18n.ui("rhythm.status");
  const heroine = heroineId ? session.state.visible.heroines[heroineId] : undefined;
  const score = heroine?.initiative ?? 0;
  const portrait = heroineId ? assetUrl(runtime.characters[heroineId]?.visual.hud_portrait) : undefined;
  const feedback = animationId ? session.lastFeedback : undefined;
  const motion = rhythmGaugeMotion(feedback);
  const motionClass = feedback ? `motion-${feedback.kind}` : "";
  return <div
    className={`vn-rhythm ${motion ? "has-motion" : ""} ${motionClass}`}
    aria-label={debugMode ? pushPullPositionLabel(value.position) : i18n.ui("rhythm.status")}
    data-rhythm-position={value.position}
    data-rhythm-score={score}
    data-rhythm-heroine={heroineId}
  >
    <div className="vn-rhythm-head">
      <div className="vn-rhythm-labels"><span>{i18n.ui("rhythm.pull")}</span><span>{i18n.ui("rhythm.push")}</span></div>
      <AnimatedRhythmScore
        score={score}
        from={motion?.scoreFrom ?? score}
        animationId={motion && motion.scoreFrom !== motion.scoreTo ? animationId : ""}
        reducedMotion={reducedMotion}
        label={heroineName}
      />
    </div>
    <div className="vn-rhythm-meter">
      <div className="vn-rhythm-avatar" role="img" aria-label={heroineName} title={heroineName}>
        {portrait ? <img src={portrait} alt="" /> : <i aria-hidden="true"><b /></i>}
      </div>
      <div className="vn-rhythm-track">
        <i className="optimal" />
        <i className="checkpoint left" /><i className="checkpoint right" />
        <i className="target" style={{ left: `${target}%`, opacity: debugMode && value.target !== "none" ? 1 : 0 }} />
        {motion && <>
          <i className="vn-rhythm-ghost" key={`ghost-${animationId}`} style={{ left: `${motion.from}%` }} />
          <i className="vn-rhythm-trail" key={`trail-${animationId}`} style={{ left: `${motion.trailLeft}%`, width: `${motion.trailWidth}%` }} />
          <i className="vn-rhythm-impact" key={`impact-${animationId}`} style={{ left: `${motion.to}%` }} />
          {motion.gain > 0 && <em className="vn-rhythm-gain" key={`gain-${animationId}`} style={{ left: `${motion.to}%` }}>+{motion.gain}</em>}
        </>}
        <i className="vn-rhythm-marker" style={{ left: `${marker}%` }} />
      </div>
    </div>
    {debugMode && <small>DEBUG · {i18n.ui("rhythm.next", { target: pushPullTargetLabel(value.target) })}</small>}
  </div>;
}

function GameHud({ session, debugMode, onMenu, i18n }: { session: PlayerSession; debugMode: boolean; onMenu: () => void; i18n: GameLocalizer }) {
  const scene = runtime.scenes[session.sceneId];
  const route = runtime.routes[session.routeId];
  const rhythm = readPushPullState(session.state);
  const heroineId = rhythm.heroine || route?.heroine;
  const heroine = heroineId ? session.state.visible.heroines[heroineId] : undefined;
  const isCommonScene = scene?.id.startsWith("common.") ?? false;
  const hasChoice = scene ? Object.values(scene.nodes).some((node) => node.kind === "choice") : false;
  const showPushPull = !isCommonScene || hasChoice;
  return <header className="vn-game-hud">
    <div className="vn-day">
      <span>DAY {String(session.state.progress.time.day).padStart(2, "0")}</span>
      <strong>{slotLabel(i18n, session.state.progress.time.slot)}</strong>
      <small>{scene ? sceneTitle(i18n, scene.id) : ""}</small>
    </div>
    {debugMode && showPushPull && <div className="vn-stats">
      <div><span>{i18n.ui("hud.initiative")}</span><strong>{heroine?.initiative ?? 0}</strong><small>/ 100</small><i className="vn-initiative-line"><b style={{ width: `${heroine?.initiative ?? 0}%` }} /></i></div>
      {rhythm.combo > 0 && <div className={rhythm.combo >= 3 ? "hot" : ""}><span>{i18n.ui("hud.combo")}</span><strong>×{rhythm.combo}</strong></div>}
    </div>}
    <button type="button" className="vn-menu-button" onClick={onMenu} aria-label={i18n.ui("hud.gameMenu")}>☰</button>
    {debugMode && <div className="vn-debug-badge">DEBUG</div>}
  </header>;
}

function Stage({ session, node, settings, i18n }: { session: PlayerSession; node?: StoryNode; settings: PlayerSettings; i18n: GameLocalizer }) {
  const resolver = useMemo(() => new VisualResolver(runtime), []);
  const scene = runtime.scenes[session.sceneId];
  const resolvedNode = node || scene.nodes[session.nodeId];
  const stage = resolver.resolveStage(scene, session.nodeId, resolvedNode);
  const background = assetUrl(stage.background?.asset);
  const visibleCharacters = visibleStageCharacters(stage.characters, canRevealProtagonistArtwork(scene, resolvedNode));
  return <div className="vn-stage">
    {background && <img className="vn-stage-bg" src={background} alt="" />}
    <div className="vn-stage-light" />
    <div className="vn-cast" style={{
      left: `${settings.characterX}vw`,
      bottom: `${14 - settings.characterY}vh`,
      "--vn-character-scale": settings.characterScale / 100,
    } as CSSProperties}>
      {visibleCharacters.map((character, index) => <figure
        className={`vn-character ${character.position} ${stageCharacterFocusClass(character)}`}
        key={`${character.position}:${character.character}:${character.artwork || character.expression || "default"}`}
        style={{ "--breath-delay": `${index * -1.1}s` } as CSSProperties}
      >
        <img src={assetUrl(character.asset)} alt={i18n.characterName(character.character)} />
      </figure>)}
    </div>
    {node?.kind === "choice" && <div className="vn-choice-vignette" />}
  </div>;
}

function DebugPanel({
  session,
  settings,
  canStepBack,
  onSettings,
  onStepBack,
  onReturnToEditor,
  i18n,
}: {
  session: PlayerSession;
  settings: PlayerSettings;
  canStepBack: boolean;
  onSettings: (settings: PlayerSettings) => void;
  onStepBack: () => void;
  onReturnToEditor?: () => void;
  i18n: GameLocalizer;
}) {
  return <aside className="vn-debug-panel" aria-label={i18n.ui("debug.panel")}>
    <header><span>DEBUG MODE</span><button type="button" disabled={!canStepBack} onClick={onStepBack}>{i18n.ui("debug.previous")}</button></header>
    <dl className="vn-debug-identity" aria-label="Session identity">
      <div><dt>MODE</dt><dd>{session.gameModeId}</dd></div>
      <div><dt>CAMPAIGN</dt><dd>{session.campaignId}</dd></div>
      <div><dt>CONTINUITY</dt><dd>{session.continuityId}</dd></div>
    </dl>
    <label><span>{i18n.ui("debug.positionX")}</span><input type="range" min="-24" max="24" value={settings.characterX} onChange={(event) => onSettings({ ...settings, characterX: Number(event.target.value) })} /><output>{settings.characterX}</output></label>
    <label><span>{i18n.ui("debug.positionY")}</span><input type="range" min="-8" max="24" value={settings.characterY} onChange={(event) => onSettings({ ...settings, characterY: Number(event.target.value) })} /><output>{settings.characterY}</output></label>
    <label><span>{i18n.ui("debug.scale")}</span><input type="range" min="75" max="135" value={settings.characterScale} onChange={(event) => onSettings({ ...settings, characterScale: Number(event.target.value) })} /><output>{settings.characterScale}%</output></label>
    {onReturnToEditor && <button type="button" className="vn-debug-editor-return" onClick={onReturnToEditor}>스토리 에디터로 돌아가기</button>}
  </aside>;
}

function SaveGrid({
  mode,
  session,
  onLoad,
  onSaved,
  i18n,
}: {
  mode: "save" | "load";
  session?: PlayerSession;
  onLoad: (session: PlayerSession) => void;
  onSaved: () => void;
  i18n: GameLocalizer;
}) {
  const [slots, setSlots] = useState(() => readSlots(runtime));
  const pick = (index: number) => {
    if (mode === "load") {
      if (slots[index]) onLoad(slots[index]!.session);
      return;
    }
    if (!session) return;
    const next = sessionSlot(session);
    writeSlot(index, next);
    setSlots(readSlots(runtime));
    onSaved();
  };
  return <div className="vn-save-grid">
    {slots.map((slot, index) => <button type="button" className={slot ? "filled" : ""} onClick={() => pick(index)} key={index}>
      <span>{i18n.ui("save.slot", { slot: String(index + 1).padStart(2, "0") })}</span>
      {slot ? (() => {
        const preview = savePreview(slot, i18n);
        return <><strong>{preview.title}</strong><p>{preview.line}</p><small>{new Date(slot.savedAt).toLocaleString(i18n.locale)}</small></>;
      })()
        : <em>{i18n.ui(mode === "save" ? "save.here" : "save.empty")}</em>}
    </button>)}
  </div>;
}

function SettingsPanel({
  value,
  onChange,
  i18n,
  refreshingApp,
  onForceRefresh,
}: {
  value: PlayerSettings;
  onChange: (value: PlayerSettings) => void;
  i18n: GameLocalizer;
  refreshingApp: boolean;
  onForceRefresh?: () => void;
}) {
  return <div className="vn-settings">
    <fieldset className="vn-locale-setting">
      <legend>{i18n.ui("locale.label")}</legend>
      <div>{gameLocales(runtime).map((locale) => <button type="button" className={value.locale === locale ? "active" : ""} onClick={() => onChange({ ...value, locale })} key={locale}>{i18n.localeName(locale)}</button>)}</div>
    </fieldset>
    <label><span><strong>{i18n.ui("settings.textSpeed")}</strong><small>{i18n.ui("settings.textSpeedHint")}</small></span><input type="range" min="8" max="55" value={value.textSpeed} onChange={(event) => onChange({ ...value, textSpeed: Number(event.target.value) })} /><output>{value.textSpeed}</output></label>
    <label><span><strong>{i18n.ui("settings.autoDelay")}</strong><small>{i18n.ui("settings.autoDelayHint")}</small></span><input type="range" min="600" max="3500" step="100" value={value.autoDelay} onChange={(event) => onChange({ ...value, autoDelay: Number(event.target.value) })} /><output>{(value.autoDelay / 1000).toFixed(1)}s</output></label>
    <label className="vn-switch"><span><strong>{i18n.ui("settings.reducedMotion")}</strong><small>{i18n.ui("settings.reducedMotionHint")}</small></span><input type="checkbox" checked={value.reducedMotion} onChange={(event) => onChange({ ...value, reducedMotion: event.target.checked })} /><i /></label>
    <label className="vn-switch"><span><strong>{i18n.ui("settings.debugMode")}</strong><small>{i18n.ui("settings.debugModeHint")}</small></span><input type="checkbox" checked={value.debugMode} onChange={(event) => onChange({ ...value, debugMode: event.target.checked })} /><i /></label>
    {onForceRefresh && <div className="vn-app-refresh"><small>현재 {shortBuildId()}</small><button type="button" onClick={onForceRefresh} disabled={refreshingApp}>{refreshingApp ? "갱신 중…" : "강제 갱신"}</button></div>}
    <button type="button" className="vn-fullscreen" onClick={() => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()}>{i18n.ui("settings.fullscreen")}</button>
  </div>;
}

export default function WebGame() {
  const projectRoot = useMemo(() => authoringRoot(), []);
  const [screen, setScreen] = useState<Screen>("title");
  const [session, setSession] = useState<PlayerSession>();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [settings, setSettings] = useState(() => {
    const stored = readSettings(runtime.localization.supported_locales, runtime.localization.default_locale);
    return projectRoot ? { ...stored, debugMode: true } : stored;
  });
  const [autosave, setAutosave] = useState(() => readAutosave(runtime));
  const [auto, setAuto] = useState(false);
  const [skip, setSkip] = useState(false);
  const [uiHidden, setUiHidden] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [visibleCharacters, setVisibleCharacters] = useState(0);
  const [feedbackVisible, setFeedbackVisible] = useState(false);
  const [rhythmAnimationId, setRhythmAnimationId] = useState("");
  const [choiceHint, setChoiceHint] = useState<(ChoiceAnalysisHint & { sceneId: string; nodeId: string })>();
  const [toast, setToast] = useState("");
  const [debugHistory, setDebugHistory] = useState<PlayerSession[]>([]);
  const [acknowledgedLogs, setAcknowledgedLogs] = useState<Set<string>>(() => new Set());
  const [dayTransition, setDayTransition] = useState<{ from: number; to: number; next: PlayerSession }>();
  const [textEditKeys, setTextEditKeys] = useState<string[]>([]);
  const [sourceOverrides, setSourceOverrides] = useState<Record<string, string>>({});
  const [lastTextUndo, setLastTextUndo] = useState<StoryTextUndo>();
  const [undoBusy, setUndoBusy] = useState(false);
  const [refreshingApp, setRefreshingApp] = useState(false);
  const toastTimer = useRef<number | undefined>(undefined);
  const i18n = useMemo(() => new GameLocalizer(runtime, settings.locale, sourceOverrides), [settings.locale, sourceOverrides]);
  const rawNode = session ? currentNode(runtime, session) : undefined;
  const resolvedDialogue = session && rawNode && (rawNode.kind === "dialogue" || rawNode.kind === "narration")
    ? resolveDialogueNode(runtime, session.state, rawNode)
    : undefined;
  const node = resolvedDialogue?.node || rawNode;
  const fullText = session && node?.line
    ? i18n.story(dialogueKey(
      session.sceneId,
      node.id,
      resolvedDialogue?.variantId,
      "line",
      Boolean(rawNode?.variants?.length),
    ), node.line)
    : "";

  const notify = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 1800);
  }, []);

  const forceRefreshApp = useCallback(async () => {
    if (!navigator.onLine || refreshingApp) {
      if (!navigator.onLine) notify("강제 갱신에는 인터넷 연결이 필요합니다.");
      return;
    }
    setRefreshingApp(true);
    try {
      const nextBuildId = await fetchLatestBuildId();
      await refreshBuildShell(nextBuildId);
      window.location.replace(reloadUrlForBuild(window.location.href, nextBuildId, Date.now()));
    } catch {
      setRefreshingApp(false);
      notify("강제 갱신에 실패했습니다. 저장 데이터는 그대로 유지됩니다.");
    }
  }, [notify, refreshingApp]);

  const applySavedRuntimeText = useCallback((result: StoryTextSaveResult, keys: string[], locale: GameLocale) => {
    if (!result.runtime) return;
    const values = runtimeTextValues(result.runtime, keys, locale);
    setSourceOverrides((current) => ({
      ...current,
      ...Object.fromEntries(Object.entries(values).map(([key, value]) => [`${locale}:${key}`, value])),
    }));
  }, []);

  const undoStoryText = useCallback(async () => {
    if (!projectRoot || !lastTextUndo || undoBusy) return;
    setUndoBusy(true);
    try {
      const result = await saveStoryText(projectRoot, lastTextUndo.edits);
      if (!result.saved) {
        notify(result.issues.find((issue) => issue.severity === "error")?.message || "문구 저장 취소가 검증을 통과하지 못했습니다.");
        return;
      }
      applySavedRuntimeText(result, lastTextUndo.keys, lastTextUndo.locale);
      setLastTextUndo(undefined);
      notify("마지막 문구 저장을 실제 원본과 화면에서 되돌렸습니다.");
    } catch (error) {
      const text = String(error);
      notify(text.includes("CONFLICT") ? "원본이 외부에서 바뀌어 자동으로 되돌리지 않았습니다." : `문구 저장 취소 실패: ${text}`);
    } finally {
      setUndoBusy(false);
    }
  }, [applySavedRuntimeText, lastTextUndo, notify, projectRoot, undoBusy]);

  const editStoryText = useCallback((keys: string[]) => {
    if (!projectRoot || !keys.length) return;
    setAuto(false);
    setSkip(false);
    setTextEditKeys([...new Set(keys)]);
    setOverlay("text-edit");
  }, [projectRoot]);

  const closeStoryTextEditor = useCallback(() => {
    setOverlay(null);
    setTextEditKeys([]);
  }, []);

  const saveAutosave = useCallback((value: PlayerSession) => {
    const slot = sessionSlot(value);
    writeAutosave(slot);
    setAutosave(slot);
  }, []);

  const loadSession = useCallback((value: PlayerSession) => {
    const ready = value.phase === "timeline" ? prepareTimeSlot(runtime, value) : value;
    setSession(ready);
    setDebugHistory([]);
    setAcknowledgedLogs(new Set(ready.timelineLog.map((entry) => entry.id)));
    setDayTransition(undefined);
    setScreen("game");
    setOverlay(null);
    setAuto(false);
    setSkip(false);
    setUiHidden(false);
    setFeedbackVisible(false);
    setRhythmAnimationId("");
  }, []);

  const previewAuthoringDialogue = useCallback((target: AuthoringTarget) => {
    if (target.kind === "system_flow") {
      const route = Object.values(runtime.routes)[0];
      if (!route) {
        notify("시스템 대사를 표시할 플레이 루트가 없습니다.");
        return;
      }
      if (target.flowId === NIGHT_FLOW_ID) {
        const preview = createSession(runtime, route.id);
        preview.phase = "self_development";
        preview.state.progress.time.day = 1;
        preview.state.progress.time.slot = "after_work";
        preview.state.progress.self_development.completed_days = [];
        preview.state.visible.protagonist.self_development.fatigue = target.nodeId === "forced_intro" || target.variantId === "solo_drinking" || target.optionId === "solo_drinking" ? 6 : 1;
        const coordinator = nightPhaseCoordinator(runtime);
        try {
          preview.nightPhase = coordinator.start(preview.state);
          if (target.optionId) {
            preview.nightPhase = coordinator.continueIntro(preview.state, preview.nightPhase);
          } else if (target.nodeId === "activity_result" && target.variantId) {
            const next = coordinator.continueIntro(preview.state, preview.nightPhase);
            preview.nightPhase = next.status === "result"
              ? next
              : coordinator.choose(preview.state, target.variantId);
          }
          loadSession(preview);
          notify(`밤 활동 · ${target.variantId || target.optionId || target.nodeId || "도입 대사"} 화면을 열었습니다.`);
        } catch (error) {
          notify(`밤 활동 미리보기를 만들 수 없습니다: ${String(error)}`);
        }
        return;
      }
      if (target.flowId === ANALYSIS_FLOW_ID) {
        const direction = target.variantId === "pull" || target.variantId === "push" ? target.variantId : "none";
        const choiceScene = Object.values(runtime.scenes).find((scene) => Object.values(scene.nodes).some((node) => node.kind === "choice"));
        const choiceNode = choiceScene && Object.values(choiceScene.nodes).find((node) => node.kind === "choice");
        if (!choiceScene || !choiceNode) {
          notify("강사 분석을 표시할 선택 장면이 없습니다.");
          return;
        }
        const preview = createSession(runtime, choiceScene.route);
        preview.phase = "scene";
        preview.sceneId = choiceScene.id;
        preview.nodeId = choiceNode.id;
        preview.lastEntryDecision = { sceneId: choiceScene.id, ...canEnterScene(runtime, preview.state, choiceScene.id) };
        loadSession(preview);
        window.setTimeout(() => setChoiceHint({ direction, sceneId: choiceScene.id, nodeId: choiceNode.id }), 0);
        notify(`심리학 강사 · ${direction} 분석 화면을 열었습니다.`);
        return;
      }
      notify("선택한 시스템 대사를 게임 런타임에서 찾을 수 없습니다.");
      return;
    }
    const targetScene = runtime.scenes[target.sceneId];
    const targetNodeId = target.nodeId || targetScene?.start_node;
    if (!targetScene || !targetNodeId || !targetScene.nodes[targetNodeId]) {
      notify("선택한 대사를 게임 런타임에서 찾을 수 없습니다. 먼저 장면을 저장해 주세요.");
      return;
    }
    const preview = createSession(runtime, targetScene.route);
    preview.phase = "scene";
    preview.sceneId = targetScene.id;
    preview.nodeId = targetNodeId;
    preview.lastEntryDecision = { sceneId: targetScene.id, ...canEnterScene(runtime, preview.state, targetScene.id) };
    loadSession(preview);
    notify(`${targetScene.title} · 선택한 대사를 열었습니다.`);
  }, [loadSession, notify]);

  useEffect(() => {
    if (!projectRoot) return;
    const initialTarget = consumeAuthoringPreviewTarget();
    if (initialTarget) previewAuthoringDialogue(initialTarget);
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => listen<AuthoringTarget>("authoring:preview-dialogue", ({ payload }) => {
      window.localStorage.removeItem("love-office:authoring-preview-target");
      previewAuthoringDialogue(payload);
    }, { target: "authoring-play" })).then((dispose) => { unlisten = dispose; }).catch(() => undefined);
    return () => unlisten?.();
  }, [previewAuthoringDialogue, projectRoot]);

  const startCampaign = (gameModeId: GameModeId) => {
    const profile = readProfile();
    const result = startGameMode(runtime, profile, gameModeId);
    if (!result.ok) {
      notify(i18n.ui("mode.survivor.notice"));
      return;
    }
    loadSession(result.session);
    saveAutosave(result.session);
  };

  const updateSession = useCallback((next: PlayerSession, remember = false) => {
    if (remember && session) {
      setDebugHistory((history) => [...history.slice(-99), structuredClone(session)]);
    }
    setSession(next);
    saveAutosave(next);
  }, [saveAutosave, session]);

  const moveSession = useCallback((next: PlayerSession, remember = false) => {
    if (session && next.phase !== "complete" && dayChanged(session.state.progress.time.day, next.state.progress.time.day)) {
      if (remember) setDebugHistory((history) => [...history.slice(-99), structuredClone(session)]);
      setDayTransition({
        from: session.state.progress.time.day,
        to: next.state.progress.time.day,
        next,
      });
      return;
    }
    updateSession(next, remember);
  }, [session, updateSession]);

  const stepBack = useCallback(() => {
    const previous = debugHistory.at(-1);
    if (!settings.debugMode || !previous) return;
    setDebugHistory((history) => history.slice(0, -1));
    setDayTransition(undefined);
    setSession(previous);
    saveAutosave(previous);
    setAuto(false);
    setSkip(false);
    setFeedbackVisible(false);
    setRhythmAnimationId("");
  }, [debugHistory, saveAutosave, settings.debugMode]);

  const advance = useCallback(() => {
    if (!session || session.phase !== "scene" || overlay || uiHidden || node?.kind === "choice" || session.endingId) return;
    if (!revealed) {
      setVisibleCharacters(fullText.length);
      setRevealed(true);
      return;
    }
    updateSession(advanceSession(runtime, session), true);
  }, [fullText.length, node?.kind, overlay, revealed, session, uiHidden, updateSession]);

  const choose = useCallback((optionId: string) => {
    if (!session || session.phase !== "scene") return;
    const next = selectOption(runtime, session, optionId);
    setFeedbackVisible(false);
    setRhythmAnimationId(next.lastFeedback
      ? `${session.sceneId}:${session.nodeId}:${optionId}:${next.choices.length}`
      : "");
    updateSession(next, true);
    window.setTimeout(() => setFeedbackVisible(true), settings.reducedMotion ? 0 : 650);
  }, [session, settings.reducedMotion, updateSession]);

  const showChoiceHint = useCallback(() => {
    if (!session || session.phase !== "scene") return;
    const consumed = consumeChoiceAnalysisHint(runtime, session);
    if (!consumed) return;
    setChoiceHint({ ...consumed.hint, sceneId: session.sceneId, nodeId: session.nodeId });
    updateSession(consumed.session, true);
  }, [session, updateSession]);

  const chooseNightActivity = useCallback((activityId: string) => {
    if (!session || session.phase !== "self_development") return;
    updateSession(selectSelfDevelopmentActivity(runtime, session, activityId), true);
  }, [session, updateSession]);

  const beginNight = useCallback(() => {
    if (!session || session.phase !== "self_development") return;
    updateSession(beginSelfDevelopmentNight(runtime, session), true);
  }, [session, updateSession]);

  const finishNight = useCallback(() => {
    if (!session || session.phase !== "self_development") return;
    moveSession(finishSelfDevelopmentNight(runtime, session), true);
  }, [moveSession, session]);

  const chooseTimelineEvent = (eventId: string) => {
    if (!session) return;
    updateSession(startTimelineEvent(runtime, session, eventId), true);
  };

  const moveToNextMoment = (remember = true) => {
    if (!session) return;
    moveSession(advanceTimeline(runtime, session), remember);
  };

  useEffect(() => {
    document.title = DISCREET_PUBLIC_LOBBY ? DISCREET_PUBLIC_TITLE : i18n.ui("app.title");
    document.documentElement.lang = i18n.locale;
  }, [i18n]);

  useEffect(() => {
    const showAll = settings.reducedMotion || !fullText;
    setVisibleCharacters(showAll ? fullText.length : 0);
    setRevealed(showAll);
  }, [fullText, session?.nodeId, settings.reducedMotion]);

  useEffect(() => {
    setChoiceHint((current) => current?.sceneId === session?.sceneId && current?.nodeId === session?.nodeId
      ? current
      : undefined);
  }, [session?.nodeId, session?.sceneId]);

  useEffect(() => {
    if (revealed || !fullText || session?.phase !== "scene") return;
    const timer = window.setInterval(() => {
      setVisibleCharacters((value) => {
        const next = Math.min(fullText.length, value + 1);
        if (next >= fullText.length) {
          window.clearInterval(timer);
          setRevealed(true);
        }
        return next;
      });
    }, settings.textSpeed);
    return () => window.clearInterval(timer);
  }, [fullText, revealed, session?.phase, settings.textSpeed]);

  useEffect(() => {
    if (!session || session.phase !== "scene" || overlay || uiHidden || node?.kind === "choice" || session.endingId) return;
    const shouldAdvance = auto || (skip && nodeRead(session));
    if (!shouldAdvance) return;
    const delay = skip ? 90 : (revealed ? settings.autoDelay : fullText.length * settings.textSpeed + settings.autoDelay);
    const timer = window.setTimeout(() => {
      if (!revealed) {
        setVisibleCharacters(fullText.length);
        setRevealed(true);
      } else {
        updateSession(advanceSession(runtime, session), true);
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [auto, fullText.length, node?.kind, overlay, revealed, session, settings.autoDelay, settings.textSpeed, skip, uiHidden, updateSession]);

  useEffect(() => {
    if (skip && session && session.phase === "scene" && !nodeRead(session)) setSkip(false);
  }, [session?.nodeId, session?.phase, skip]);

  useEffect(() => {
    if (!dayTransition) return;
    const delay = settings.reducedMotion ? 220 : 1250;
    const timer = window.setTimeout(() => {
      setSession(dayTransition.next);
      saveAutosave(dayTransition.next);
      setDayTransition(undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [dayTransition, saveAutosave, settings.reducedMotion]);

  useEffect(() => {
    if (!session || session.phase !== "timeline" || dayTransition || overlay) return;
    const { day, slot } = session.state.progress.time;
    const logs = session.timelineLog
      .filter((entry) => entry.day === day && entry.slot === slot)
      .filter((entry) => Boolean(runtime.events[entry.eventId]))
      .map((entry) => ({ ...entry, eventHasScene: Boolean(runtime.events[entry.eventId]?.scene) }));
    const pending = visibleTimelineLogs(logs, acknowledgedLogs, false);
    if (pending.length || availableTimelineEvents(runtime, session).length) return;
    const timer = window.setTimeout(() => {
      moveSession(advanceTimeline(runtime, session));
    }, settings.reducedMotion ? 0 : 90);
    return () => window.clearTimeout(timer);
  }, [acknowledgedLogs, dayTransition, moveSession, overlay, session, settings.reducedMotion]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (overlay) {
          setOverlay(null);
          if (overlay === "text-edit") setTextEditKeys([]);
        }
        else if (screen === "game" && session?.phase === "scene") setUiHidden((value) => !value);
        return;
      }
      if (screen !== "game" || overlay || !session) return;
      if (settings.debugMode && event.key === "ArrowLeft") {
        event.preventDefault();
        stepBack();
        return;
      }
      if (session.phase === "scene" && node?.kind === "choice" && /^[1-9]$/.test(event.key)) {
        const option = availableOptions(runtime, session)[Number(event.key) - 1];
        if (option) choose(option.id);
        return;
      }
      if (session.phase !== "scene") return;
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        advance();
      } else if (event.key.toLowerCase() === "a") setAuto((value) => !value);
      else if (event.key.toLowerCase() === "s") setSkip((value) => !value);
      else if (event.key.toLowerCase() === "h") setUiHidden((value) => !value);
      else if (event.key === "PageUp") setOverlay("backlog");
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [advance, choose, node?.kind, overlay, screen, session, settings.debugMode, stepBack]);

  useEffect(() => {
    writeSettings(settings);
  }, [settings]);

  const overlays = session ? <>
    {overlay === "backlog" && <Modal title={i18n.ui("backlog.title")} onClose={() => setOverlay(null)} i18n={i18n} wide>
      <div className="vn-backlog">{[...session.backlog].reverse().map((entry) => {
        const sourceNode = runtime.scenes[entry.sceneId]?.nodes[entry.nodeId];
        const resolved = sourceNode && (sourceNode.kind === "dialogue" || sourceNode.kind === "narration")
          ? resolveDialogueNode(runtime, session.state, sourceNode, entry.variantId)
          : undefined;
        const sourceText = entry.kind === "choice" && entry.optionId
          ? sourceNode?.options?.find((option) => option.id === entry.optionId)?.label || entry.optionId
          : resolved?.node.line || entry.nodeId;
        const entryKey = entry.kind === "choice" && entry.optionId
          ? `scenes.${entry.sceneId}.nodes.${entry.nodeId}.options.${entry.optionId}.label`
          : dialogueKey(
            entry.sceneId,
            entry.nodeId,
            resolved?.variantId || entry.variantId,
            "line",
            Boolean(sourceNode?.variants?.length),
          );
        const text = i18n.story(entryKey, sourceText);
        const backlogSpeakerId = resolved ? effectiveSpeaker(resolved.node) : entry.speakerId;
        const speakerName = backlogSpeakerId
          ? i18n.characterName(backlogSpeakerId)
          : entry.kind === "choice" ? i18n.ui("dialogue.choice") : "";
        return <article className={entry.kind} key={entry.id}>{speakerName && <span>{speakerName}</span>}<p>{text}</p>
          {projectRoot && settings.debugMode && <button type="button" className="vn-backlog-edit" onClick={() => editStoryText([entryKey])}>원본 편집</button>}
        </article>;
      })}
        {!session.backlog.length && <p className="vn-empty">{i18n.ui("backlog.empty")}</p>}</div>
    </Modal>}
    {overlay === "save" && <Modal title={i18n.ui("save.title")} onClose={() => setOverlay(null)} i18n={i18n} wide><SaveGrid mode="save" session={session} onLoad={loadSession} onSaved={() => notify(i18n.ui("save.done"))} i18n={i18n} /></Modal>}
    {overlay === "load" && <Modal title={i18n.ui("load.title")} onClose={() => setOverlay(null)} i18n={i18n} wide><SaveGrid mode="load" onLoad={loadSession} onSaved={() => undefined} i18n={i18n} /></Modal>}
    {overlay === "gallery" && <Modal title={i18n.ui("gallery.title")} onClose={() => setOverlay(null)} i18n={i18n} wide><GalleryPanel profile={readProfile()} i18n={i18n} /></Modal>}
    {overlay === "characters" && <Modal title={i18n.ui("character.title")} onClose={() => setOverlay(null)} i18n={i18n} wide><CharacterPanel profile={readProfile()} i18n={i18n} /></Modal>}
    {overlay === "settings" && <Modal title={i18n.ui("settings.title")} onClose={() => setOverlay(null)} i18n={i18n}><SettingsPanel value={settings} onChange={setSettings} i18n={i18n} refreshingApp={refreshingApp} onForceRefresh={projectRoot ? undefined : forceRefreshApp} /></Modal>}
    {overlay === "menu" && <Modal title={i18n.ui("menu.game")} onClose={() => setOverlay(null)} i18n={i18n}>
      <div className="vn-pause-menu">
        <button type="button" onClick={() => setOverlay(null)}>{i18n.ui("menu.resume")}</button>
        <button type="button" onClick={() => setOverlay("backlog")}>{i18n.ui("menu.backlog")}</button>
        <button type="button" onClick={() => setOverlay("save")}>{i18n.ui("save.title")}</button>
        <button type="button" onClick={() => setOverlay("load")}>{i18n.ui("load.title")}</button>
        <button type="button" onClick={() => setOverlay("gallery")}>{i18n.ui("menu.gallery")}</button>
        <button type="button" onClick={() => setOverlay("characters")}>{i18n.ui("menu.characters")}</button>
        <button type="button" onClick={() => setOverlay("settings")}>{i18n.ui("settings.title")}</button>
        <button type="button" className="danger" onClick={() => { setOverlay(null); setScreen("title"); setSession(undefined); }}>{i18n.ui("menu.title")}</button>
      </div>
    </Modal>}
    {overlay === "text-edit" && projectRoot && textEditKeys.length > 0 && <StoryTextEditor
      root={projectRoot}
      keys={textEditKeys}
      locale={settings.locale}
      onSaved={(result, undo, editedLocale) => {
        applySavedRuntimeText(result, textEditKeys, editedLocale);
        setLastTextUndo(undo.edits.length ? undo : undefined);
      }}
      onClose={closeStoryTextEditor}
      i18n={i18n}
    />}
  </> : null;
  const authoringUndoButton = projectRoot && lastTextUndo
    ? <button type="button" className="vn-authoring-undo" onClick={() => void undoStoryText()} disabled={undoBusy}>{undoBusy ? "되돌리는 중…" : "↶ 마지막 문구 저장 취소"}</button>
    : null;

  if (screen === "title") {
    return <div className={settings.reducedMotion ? "vn-reduced-motion" : ""}>
      <TitleScreen autosave={autosave} onContinue={() => autosave && loadSession(autosave.session)} onNewGame={() => setScreen("new-game")} onLoad={() => setOverlay("load")} onGallery={() => setOverlay("gallery")} onCharacters={() => setOverlay("characters")} onSettings={() => setOverlay("settings")} i18n={i18n} onLocale={(locale) => setSettings((value) => ({ ...value, locale }))} />
      {overlay === "load" && <Modal title={i18n.ui("load.title")} onClose={() => setOverlay(null)} i18n={i18n} wide><SaveGrid mode="load" onLoad={loadSession} onSaved={() => undefined} i18n={i18n} /></Modal>}
      {overlay === "gallery" && <Modal title={i18n.ui("gallery.title")} onClose={() => setOverlay(null)} i18n={i18n} wide><GalleryPanel profile={readProfile()} i18n={i18n} /></Modal>}
      {overlay === "characters" && <Modal title={i18n.ui("character.title")} onClose={() => setOverlay(null)} i18n={i18n} wide><CharacterPanel profile={readProfile()} i18n={i18n} /></Modal>}
      {overlay === "settings" && <Modal title={i18n.ui("settings.title")} onClose={() => setOverlay(null)} i18n={i18n}><SettingsPanel value={settings} onChange={setSettings} i18n={i18n} refreshingApp={refreshingApp} onForceRefresh={projectRoot ? undefined : forceRefreshApp} /></Modal>}
      {toast && <div className="vn-toast">{toast}</div>}
    </div>;
  }

  if (screen === "new-game") return <div className={settings.reducedMotion ? "vn-reduced-motion" : ""}>
    <NewGameScreen onStart={startCampaign} onBack={() => setScreen("title")} i18n={i18n} />
    {toast && <div className="vn-toast">{toast}</div>}
  </div>;
  if (!session) return <TitleScreen autosave={autosave} onContinue={() => autosave && loadSession(autosave.session)} onNewGame={() => setScreen("new-game")} onLoad={() => setOverlay("load")} onGallery={() => setOverlay("gallery")} onCharacters={() => setOverlay("characters")} onSettings={() => setOverlay("settings")} i18n={i18n} onLocale={(locale) => setSettings((value) => ({ ...value, locale }))} />;

  if (dayTransition) {
    return <div className={settings.reducedMotion ? "vn-reduced-motion" : ""}>
      <DayTransition from={dayTransition.from} to={dayTransition.to} i18n={i18n} />
      {projectRoot && settings.debugMode && <button type="button" className="vn-screen-authoring" onClick={() => editStoryText(["dayChange.label"])}>날짜 전환 문구 편집</button>}
      {authoringUndoButton}
      {overlays}
    </div>;
  }

  if (session.phase === "timeline") {
    return <div className={settings.reducedMotion ? "vn-reduced-motion" : ""}>
      <FlowScreen
        session={session}
        acknowledgedLogs={acknowledgedLogs}
        debugMode={settings.debugMode}
        onAcknowledge={(logId) => setAcknowledgedLogs((logs) => new Set([...logs, logId]))}
        onSelect={chooseTimelineEvent}
        onAdvance={() => moveToNextMoment(true)}
        onStepBack={stepBack}
        canStepBack={debugHistory.length > 0}
        onMenu={() => setOverlay("menu")}
        onEditText={projectRoot && settings.debugMode ? editStoryText : undefined}
        i18n={i18n}
      />
      {authoringUndoButton}
      {toast && <div className="vn-toast">{toast}</div>}
      {overlays}
    </div>;
  }

  if (session.phase === "self_development") {
    return <div className={settings.reducedMotion ? "vn-reduced-motion" : ""}>
      <NightDialogueFlow
        session={session}
        debugMode={settings.debugMode}
        onBegin={beginNight}
        onActivity={chooseNightActivity}
        onContinue={finishNight}
        onMenu={() => setOverlay("menu")}
        onEditText={projectRoot && settings.debugMode ? editStoryText : undefined}
        i18n={i18n}
      />
      {authoringUndoButton}
      {toast && <div className="vn-toast">{toast}</div>}
      {overlays}
    </div>;
  }

  if (session.phase === "complete") {
    const anotherUnlocked = session.state.progress.unlocked_modes.includes("survivor_view");
    const route = runtime.routes[session.routeId];
    const endingTextKeys = [
      ...(route ? [`routes.${route.id}.title`] : []),
      "ending.label",
      session.endingId === "campaign.complete" ? "ending.incomplete" : "ending.complete",
      "ending.day",
      "ending.events",
      "ending.choices",
      "ending.newMode",
      "ending.unlocked",
      "ending.unlockedCopy",
      "ending.restart",
      "ending.toTitle",
    ];
    return <main className="vn-ending-screen">
      <div className="vn-ending-record"><span>{i18n.ui("ending.label")}</span><h1>{route ? i18n.story(`routes.${route.id}.title`, route.title) : i18n.ui("ending.defaultTitle")}</h1><p>{i18n.ui(session.endingId === "campaign.complete" ? "ending.incomplete" : "ending.complete")}</p>
        <div className="vn-ending-meta"><span>{i18n.ui("ending.day", { day: session.state.progress.time.day })}</span><span>{i18n.ui("ending.events", { count: session.state.progress.events.seen.length })}</span><span>{i18n.ui("ending.choices", { count: session.choices.length })}</span></div>
        {anotherUnlocked && <section><small>{i18n.ui("ending.newMode")}</small><strong>{i18n.ui("ending.unlocked")}</strong><p>{i18n.ui("ending.unlockedCopy")}</p></section>}
        <div className="vn-ending-actions"><button type="button" onClick={() => setScreen("new-game")}>{i18n.ui("ending.restart")}</button><button type="button" onClick={() => { setScreen("title"); setSession(undefined); }}>{i18n.ui("ending.toTitle")}</button></div>
      </div>
      {projectRoot && settings.debugMode && <button type="button" className="vn-screen-authoring" onClick={() => editStoryText(endingTextKeys)}>엔딩 화면 문구 편집</button>}
      {authoringUndoButton}
      {overlays}
    </main>;
  }

  if (!node) {
    const recovered = prepareTimeSlot(runtime, { ...session, phase: "timeline" });
    return <div className="vn-runtime-error"><h1>{i18n.ui("error.heading")}</h1><button type="button" onClick={() => updateSession(recovered)}>{i18n.ui("error.recover")}</button></div>;
  }

  const speaker = i18n.characterName(effectiveSpeaker(node));
  const displayedText = revealed ? fullText : fullText.slice(0, visibleCharacters);
  const options = availableOptions(runtime, session);
  const currentDialogueEditKeys = (node.kind === "dialogue" || node.kind === "narration") && node.line
    ? [dialogueKey(
      session.sceneId,
      node.id,
      resolvedDialogue?.variantId,
      "line",
      Boolean(rawNode?.variants?.length),
    )]
    : [];
  const choiceEditKeys = node.kind === "choice" ? [
    ...(node.prompt ? [`scenes.${session.sceneId}.nodes.${node.id}.prompt`] : []),
    ...(node.stimulus ? [`scenes.${session.sceneId}.nodes.${node.id}.stimulus`] : []),
    ...options.flatMap((option) => (["label", "interpretation", "action"] as const)
      .filter((field) => Boolean(option[field]))
      .map((field) => `scenes.${session.sceneId}.nodes.${node.id}.options.${option.id}.${field}`)),
  ] : [];
  const rhythm = readPushPullState(session.state);
  const feedback = session.lastFeedback;
  const triggerSummary = node.kind === "choice" ? choiceTriggerSummary(session, i18n) : undefined;
  const choiceStimulus = node.kind === "choice"
    ? i18n.story(`scenes.${session.sceneId}.nodes.${node.id}.stimulus`, node.stimulus || triggerSummary?.line || "")
    : "";
  const hintCharges = session.state.progress.self_development.hint_charges;
  const activeChoiceHint = choiceHint?.sceneId === session.sceneId && choiceHint.nodeId === session.nodeId
    ? choiceHint
    : undefined;
  const hintDirection = activeChoiceHint?.direction || "none";
  const hintLesson = activeChoiceHint?.lesson
    ? i18n.story(
      `scenes.${session.sceneId}.nodes.${node.id}.analysis_hints.${hintDirection}`,
      activeChoiceHint.lesson,
    )
    : systemFlowLine(i18n, ANALYSIS_FLOW_ID, "lesson", hintDirection);
  const hintEditKey = activeChoiceHint?.lesson
    ? `scenes.${session.sceneId}.nodes.${node.id}.analysis_hints.${hintDirection}`
    : systemFlowKey(ANALYSIS_FLOW_ID, "lesson", hintDirection);
  const scene = runtime.scenes[session.sceneId];
  const isCommonScene = scene?.id.startsWith("common.") ?? false;
  const hasChoice = scene ? Object.values(scene.nodes).some((candidate) => candidate.kind === "choice") : false;
  const showPushPull = !isCommonScene || hasChoice;
  const clickStage = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest("button, input, textarea, .vn-modal, .vn-debug-panel")) return;
    advance();
  };
  const choiceKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    const next = (Math.max(0, current) + offset + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next].focus();
  };
  const quickMenu = <div className="vn-quick-menu">
    {settings.debugMode && <button type="button" disabled={!debugHistory.length} onClick={stepBack}>{i18n.ui("debug.previous")}</button>}
    {projectRoot && settings.debugMode && currentDialogueEditKeys.length > 0 && <button type="button" className="vn-authoring-button" onClick={() => editStoryText(currentDialogueEditKeys)}>대사 편집</button>}
    {projectRoot && settings.debugMode && choiceEditKeys.length > 0 && <button type="button" className="vn-authoring-button" onClick={() => editStoryText(choiceEditKeys)}>선택지 문구 편집</button>}
    {projectRoot && settings.debugMode && activeChoiceHint && <button type="button" className="vn-authoring-button" onClick={() => editStoryText([hintEditKey])}>강사 대사 편집</button>}
    <button type="button" onClick={() => setOverlay("backlog")}>{i18n.ui("menu.backlog")}</button>
    <button type="button" className={auto ? "active" : ""} onClick={() => { setAuto((value) => !value); setSkip(false); }}>{i18n.ui("menu.auto")}</button>
    <button type="button" className={skip ? "active" : ""} onClick={() => { setSkip((value) => !value); setAuto(false); }}>{i18n.ui("menu.skip")}</button>
    <button type="button" onClick={() => setOverlay("save")}>{i18n.ui("menu.save")}</button>
    <button type="button" onClick={() => setOverlay("load")}>{i18n.ui("menu.load")}</button>
    <button type="button" onClick={() => setOverlay("settings")}>{i18n.ui("menu.settings")}</button>
    <button type="button" onClick={() => setUiHidden(true)}>{i18n.ui("menu.hide")}</button>
  </div>;

  return <main
    className={`vn-game ${node.kind === "silent" ? "silent" : ""} ${settings.reducedMotion ? "vn-reduced-motion" : ""} ${uiHidden ? "ui-hidden" : ""}`}
    onClick={clickStage}
    onContextMenu={(event) => { event.preventDefault(); setUiHidden((value) => !value); }}
    onWheel={(event) => { if (event.deltaY < -20 && !overlay) setOverlay("backlog"); }}
  >
    <Stage session={session} node={node} settings={settings} i18n={i18n} />
    {showSceneHud(node.kind) && <GameHud session={session} debugMode={settings.debugMode} onMenu={() => setOverlay("menu")} i18n={i18n} />}
    {showSceneHud(node.kind) && showPushPull && <RhythmGauge
      session={session}
      debugMode={settings.debugMode}
      animationId={rhythmAnimationId}
      reducedMotion={settings.reducedMotion}
      i18n={i18n}
    />}
    {settings.debugMode && <DebugPanel session={session} settings={settings} canStepBack={debugHistory.length > 0} onSettings={setSettings} onStepBack={stepBack} onReturnToEditor={projectRoot ? () => returnToStoryEditor({ sceneId: session.sceneId, nodeId: node.id }) : undefined} i18n={i18n} />}

    {node.kind === "choice" && !uiHidden && <section className="vn-choices" aria-label={i18n.story(`scenes.${session.sceneId}.nodes.${node.id}.prompt`, node.prompt || "")} onKeyDown={choiceKeyDown}>
      <div className="vn-choice-context">
        <span>{triggerSummary?.speaker || i18n.ui("flow.choiceContext")}</span><strong>{choiceStimulus}</strong>
        {!activeChoiceHint && <button type="button" className="vn-analysis-hint-button" disabled={hintCharges <= 0} onClick={showChoiceHint}>
          <b>{i18n.ui("analysisHint.recall")}</b><small>×{hintCharges}</small>
        </button>}
        {activeChoiceHint && <div className="vn-analysis-hint" aria-live="polite">
          <div className="vn-analysis-instructor"><i aria-hidden="true">講</i><p><small>{i18n.ui("analysisHint.instructor")}</small><strong>{hintLesson}</strong></p></div>
          <p><small>{i18n.ui("analysisHint.observation")}</small>{choiceStimulus}</p>
        </div>}
      </div>
      <p>{i18n.story(`scenes.${session.sceneId}.nodes.${node.id}.prompt`, node.prompt || "")}</p>
      {options.map((option, index) => {
        const debugEffect = choiceDebugEffect(option);
        const unlockedStat = expressionStat(option);
        const expressionBonus = option.self_development
          ? selfDevelopment.eligibility.scoreBonus(session.state, option.self_development.expression)
          : 0;
        const effectKey = debugEffect.action === "approach"
          ? "debug.effectApproach"
          : debugEffect.action === "space" ? "debug.effectSpace" : "debug.effectLiteral";
        return <button type="button" onClick={() => choose(option.id)} key={option.id}>
          <span>{String(index + 1).padStart(2, "0")}</span><strong>
            {unlockedStat && <i className="vn-expression-badge">✦ {i18n.ui(`selfDevelopment.stat.${unlockedStat}` as Parameters<GameLocalizer["ui"]>[0])}</i>}
            {i18n.story(`scenes.${session.sceneId}.nodes.${node.id}.options.${option.id}.label`, option.label)}
          </strong>
          {settings.debugMode && <em>
            DEBUG · {i18n.ui(effectKey)} {debugEffect.intensity}
            {expressionBonus > 0 && ` · ${i18n.ui("feedback.expressionBonus", { gain: expressionBonus })}`}
          </em>}
        </button>;
      })}
      {quickMenu}
    </section>}

    {!uiHidden && showDialogueChrome(node.kind) && <section className="vn-dialogue">
      {speaker && <div className="vn-nameplate">{speaker}</div>}
      <p className="vn-line">{displayedText}<i className={revealed ? "done" : ""} /></p>
      {settings.debugMode && feedback && feedbackVisible && <div className={`vn-feedback ${feedback.kind}`}>
        <strong>{feedback.kind === "turn" ? i18n.ui("feedback.turn") : feedback.kind === "score" ? `${i18n.ui("hud.combo")} ×${feedback.combo}` : i18n.ui(feedback.kind === "literal" ? "feedback.literal" : "feedback.break")}</strong>
        {feedback.gain > 0 && <span>{i18n.ui("feedback.gain", { gain: feedback.gain })}</span>}
        {feedback.bonusGain > 0 && <span>{i18n.ui("feedback.expressionBonus", { gain: feedback.bonusGain })}</span>}
        <small>{pushPullPositionLabel(rhythm.position)}</small>
      </div>}
      {quickMenu}
    </section>}

    {uiHidden && <button type="button" className="vn-show-ui" onClick={() => setUiHidden(false)}>{i18n.ui("menu.show")}</button>}
    {authoringUndoButton}
    {toast && <div className="vn-toast">{toast}</div>}
    {overlays}
  </main>;
}
