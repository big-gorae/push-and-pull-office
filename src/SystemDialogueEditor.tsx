import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getStoryTextOwner,
  inverseStoryTextEdits,
  saveStoryText,
  type StoryTextEdit,
  type StoryTextSaveResult,
  type SystemFlowAuthoringTarget,
} from "./player/storyAuthoring";
import {
  systemDialogueFlows,
  systemDialogueSourceFingerprint,
  type SystemDialogueItem,
  type SystemDialogueRow,
} from "./player/systemDialogueAuthoring";
import type {
  DocumentActivity,
  ProjectPayload,
  ValidationIssue,
} from "./types";

type Props = {
  active: boolean;
  payload: ProjectPayload;
  onPayload: (payload: ProjectPayload) => void;
  onIssues: (issues: ValidationIssue[]) => void;
  onStatus: (status: string) => void;
  onDocumentActivity: (activity: DocumentActivity) => void;
  onPreview: (target: SystemFlowAuthoringTarget) => void;
};

type UndoState = {
  edits: StoryTextEdit[];
  count: number;
};

const AUTO_SAVE_DELAY = 1600;

function rowsInFlows(flows: ReturnType<typeof systemDialogueFlows>): SystemDialogueRow[] {
  return flows.flatMap((flow) => flow.groups.flatMap((group) => group.items.flatMap((item) => item.rows)));
}

function itemMatches(item: SystemDialogueItem, query: string, drafts: Record<string, string>): boolean {
  if (!query) return true;
  return [
    item.flowTitle,
    item.groupLabel,
    item.label,
    item.context,
    ...item.rows.flatMap((row) => [row.fieldLabel, row.source, drafts[row.key] || ""]),
  ].join("\n").toLocaleLowerCase().includes(query);
}

function savedTimeLabel(savedAt?: number): string {
  return savedAt
    ? `저장 완료 · ${new Date(savedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`
    : "원본 YAML과 동기화됨";
}

export default function SystemDialogueEditor({
  active,
  payload,
  onPayload,
  onIssues,
  onStatus,
  onDocumentActivity,
  onPreview,
}: Props) {
  const flows = useMemo(() => systemDialogueFlows(payload.runtime), [payload.runtime]);
  const rows = useMemo(() => rowsInFlows(flows), [flows]);
  const sourceValues = useMemo(
    () => Object.fromEntries(rows.map((row) => [row.key, row.source])),
    [rows],
  );
  const sourceFingerprint = useMemo(() => systemDialogueSourceFingerprint(rows), [rows]);
  const draftStorageKey = useMemo(
    () => `love-office:system-dialogue-draft:${encodeURIComponent(payload.root)}`,
    [payload.root],
  );
  const [drafts, setDrafts] = useState<Record<string, string>>(sourceValues);
  const [query, setQuery] = useState("");
  const [selectedFlowId, setSelectedFlowId] = useState(flows[0]?.id || "system.night_activity");
  const [selectedGroupId, setSelectedGroupId] = useState(flows[0]?.groups[0]?.id || "intro");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [lastSavedAt, setLastSavedAt] = useState<number>();
  const [lastUndo, setLastUndo] = useState<UndoState>();
  const searchRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const saveInFlight = useRef(false);
  const previousSources = useRef(sourceValues);
  const loadedDraftRoot = useRef("");

  useEffect(() => {
    const previous = previousSources.current;
    setDrafts((current) => Object.fromEntries(rows.map((row) => {
      const value = !(row.key in current) || current[row.key] === previous[row.key]
        ? row.source
        : current[row.key];
      return [row.key, value];
    })));
    previousSources.current = sourceValues;
  }, [rows, sourceValues]);

  useEffect(() => {
    if (loadedDraftRoot.current === payload.root) return;
    loadedDraftRoot.current = payload.root;
    try {
      const raw = window.localStorage.getItem(draftStorageKey);
      if (!raw) return;
      const cached = JSON.parse(raw) as { fingerprint?: string; values?: Record<string, string> };
      if (cached.fingerprint !== sourceFingerprint || !cached.values) {
        window.localStorage.removeItem(draftStorageKey);
        return;
      }
      setDrafts((current) => ({ ...current, ...cached.values }));
      onStatus("저장하지 않은 시스템 대사 초안을 복구했습니다.");
    } catch {
      // Draft recovery is a convenience layer; authoritative YAML loading must continue.
    }
  }, [draftStorageKey, onStatus, payload.root, sourceFingerprint]);

  const dirtyKeys = useMemo(
    () => rows.filter((row) => (drafts[row.key] ?? row.source) !== row.source).map((row) => row.key),
    [drafts, rows],
  );
  const dirtySet = useMemo(() => new Set(dirtyKeys), [dirtyKeys]);

  useEffect(() => {
    if (loadedDraftRoot.current !== payload.root) return;
    try {
      if (!dirtyKeys.length) {
        window.localStorage.removeItem(draftStorageKey);
        return;
      }
      window.localStorage.setItem(draftStorageKey, JSON.stringify({
        fingerprint: sourceFingerprint,
        values: Object.fromEntries(dirtyKeys.map((key) => [key, drafts[key]])),
      }));
    } catch {
      // The editor remains safe because YAML is still the authoritative save target.
    }
  }, [dirtyKeys, drafts, draftStorageKey, payload.root, sourceFingerprint]);

  const save = useCallback(async () => {
    if (!dirtyKeys.length || saveInFlight.current) return;
    const keys = [...dirtyKeys];
    const snapshot = Object.fromEntries(keys.map((key) => [key, drafts[key]]));
    const affected = rows.filter((row) => keys.includes(row.key));
    const activePath = affected[0]?.path || "story/system_flows";
    saveInFlight.current = true;
    setSaving(true);
    setSaveError("");
    onDocumentActivity({
      phase: "saving",
      label: "시스템 대사",
      path: activePath,
      detail: `${keys.length}개 문구 검증 후 물리 저장 중`,
    });
    try {
      const owners = await Promise.all(keys.map((key) => getStoryTextOwner(payload.root, key)));
      const edits = owners.map((owner): StoryTextEdit => {
        if (!owner.editable || !owner.revision || !owner.currentValueHash) {
          throw new Error(`${owner.key}: 편집 가능한 단일 YAML 원본이 없습니다.`);
        }
        return {
          localization_key: owner.key,
          expected_revision: owner.revision,
          expected_value_hash: owner.currentValueHash,
          next_value: snapshot[owner.key],
        };
      });
      const result = await saveStoryText(payload.root, edits) as StoryTextSaveResult;
      onIssues(result.issues);
      if (!result.saved || !result.runtime) {
        const firstError = result.issues.find((issue) => issue.severity === "error");
        throw new Error(firstError?.message || result.errorCode || "검증에 실패했습니다.");
      }
      const undoEdits = inverseStoryTextEdits(
        result.changes || [],
        result.owners || [],
        payload.runtime.localization.default_locale,
      );
      setLastUndo(undoEdits.length ? { edits: undoEdits, count: keys.length } : undefined);
      onPayload({
        ...payload,
        runtime: result.runtime,
        documents: result.documents || payload.documents,
      });
      const savedAt = Date.now();
      setLastSavedAt(savedAt);
      onDocumentActivity({
        phase: "saved",
        label: "시스템 대사",
        path: activePath,
        detail: `${keys.length}개 문구를 YAML에 저장함`,
        savedAt,
      });
      onStatus(`시스템 대사 ${keys.length}개를 원본 YAML과 게임 런타임에 저장했습니다.`);
    } catch (error) {
      const text = String(error);
      const message = text.includes("CONFLICT")
        ? "원본 파일이 다른 곳에서 변경되었습니다. 현재 초안은 보존했습니다. 프로젝트를 다시 열어 비교해 주세요."
        : `저장하지 못했습니다: ${text}`;
      setSaveError(message);
      onDocumentActivity({ phase: "error", label: "시스템 대사", path: activePath, detail: message });
      onStatus(message);
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }, [dirtyKeys, drafts, onDocumentActivity, onIssues, onPayload, onStatus, payload, rows]);

  const undoLastSave = useCallback(async () => {
    if (!lastUndo || dirtyKeys.length || saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    setSaveError("");
    onDocumentActivity({ phase: "saving", label: "시스템 대사", path: "story/system_flows", detail: "마지막 저장 되돌리는 중" });
    try {
      const result = await saveStoryText(payload.root, lastUndo.edits) as StoryTextSaveResult;
      onIssues(result.issues);
      if (!result.saved || !result.runtime) throw new Error(result.errorCode || "되돌리기 검증에 실패했습니다.");
      onPayload({ ...payload, runtime: result.runtime, documents: result.documents || payload.documents });
      setLastUndo(undefined);
      const savedAt = Date.now();
      setLastSavedAt(savedAt);
      onDocumentActivity({ phase: "saved", label: "시스템 대사", path: "story/system_flows", detail: `${lastUndo.count}개 문구 저장 취소`, savedAt });
      onStatus(`마지막 시스템 대사 저장 ${lastUndo.count}개를 실제 YAML에서 되돌렸습니다.`);
    } catch (error) {
      const message = String(error).includes("CONFLICT")
        ? "원본이 외부에서 바뀌어 마지막 저장을 자동으로 되돌리지 않았습니다."
        : `마지막 저장을 되돌리지 못했습니다: ${String(error)}`;
      setSaveError(message);
      onDocumentActivity({ phase: "error", label: "시스템 대사", path: "story/system_flows", detail: message });
      onStatus(message);
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }, [dirtyKeys.length, lastUndo, onDocumentActivity, onIssues, onPayload, onStatus, payload]);

  useEffect(() => {
    window.clearTimeout(saveTimer.current);
    if (!active || !dirtyKeys.length || saving) return;
    onDocumentActivity({
      phase: "dirty",
      label: "시스템 대사",
      path: rows.find((row) => dirtySet.has(row.key))?.path || "story/system_flows",
      detail: `${dirtyKeys.length}개 변경 · ${AUTO_SAVE_DELAY / 1000}초 후 자동 저장`,
    });
    saveTimer.current = window.setTimeout(() => void save(), AUTO_SAVE_DELAY);
    return () => window.clearTimeout(saveTimer.current);
  }, [active, dirtyKeys, dirtySet, onDocumentActivity, rows, save, saving]);

  useEffect(() => {
    if (!active) return;
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "s") {
        event.preventDefault();
        void save();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (event.key === "Escape" && query) {
        setQuery("");
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [active, query, save]);

  const resetKeys = (keys: string[]) => {
    setDrafts((current) => ({ ...current, ...Object.fromEntries(keys.map((key) => [key, sourceValues[key]])) }));
    setSaveError("");
  };
  const resetAll = () => {
    if (dirtyKeys.length > 1 && !window.confirm(`저장하지 않은 시스템 대사 ${dirtyKeys.length}개를 모두 취소할까요?`)) return;
    resetKeys(dirtyKeys);
    onStatus("저장하지 않은 시스템 대사 변경을 취소했습니다.");
  };

  const selectedFlow = flows.find((flow) => flow.id === selectedFlowId) || flows[0];
  const selectedGroup = selectedFlow?.groups.find((group) => group.id === selectedGroupId) || selectedFlow?.groups[0];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const allItems = flows.flatMap((flow) => flow.groups.flatMap((group) => group.items));
  const visibleItems = normalizedQuery
    ? allItems.filter((item) => itemMatches(item, normalizedQuery, drafts))
    : selectedGroup?.items || [];
  const totalFields = rows.length;
  const saveMessage = saveError || (saving
    ? "전체 스토리를 검증하고 원본 YAML에 저장하는 중…"
    : dirtyKeys.length
      ? `${dirtyKeys.length}개 변경됨 · 입력을 멈추면 ${AUTO_SAVE_DELAY / 1000}초 후 자동 저장`
      : savedTimeLabel(lastSavedAt));

  return <section className="system-dialogue-editor">
    <header className="system-dialogue-header">
      <div>
        <p className="eyebrow">SYSTEM DIALOGUE</p>
        <h2>시스템 대사</h2>
        <small>밤 활동과 심리학 강사 문구를 실제 등장 맥락별로 고칩니다.</small>
      </div>
      <div className="system-dialogue-search">
        <label htmlFor="system-dialogue-search">대사 내용 검색</label>
        <span><input
          ref={searchRef}
          id="system-dialogue-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="예: 벌써 세 편, 대화를 이어"
        />{query && <button type="button" aria-label="검색어 지우기" onClick={() => setQuery("")}>×</button>}</span>
        <small><kbd>⌘F</kbd> 검색 · <kbd>Esc</kbd> 지우기</small>
      </div>
      <div className="system-dialogue-save-actions">
        <button type="button" disabled={!lastUndo || Boolean(dirtyKeys.length) || saving} onClick={() => void undoLastSave()}>↶ 마지막 저장 취소</button>
        <button type="button" disabled={!dirtyKeys.length || saving} onClick={resetAll}>변경 취소</button>
        <button type="button" className="primary-button" disabled={!dirtyKeys.length || saving} onClick={() => void save()}>
          {saving ? "저장 중…" : <>지금 저장{dirtyKeys.length ? ` (${dirtyKeys.length})` : ""} <kbd>⌘S</kbd></>}
        </button>
      </div>
      <p className={`system-dialogue-save-state ${saveError ? "error" : dirtyKeys.length ? "dirty" : "saved"}`} role="status">
        <span aria-hidden="true">{saveError ? "!" : dirtyKeys.length ? "●" : "✓"}</span>{saveMessage}
      </p>
    </header>

    <div className="system-dialogue-workspace">
      <aside className="system-dialogue-navigation" aria-label="시스템 대사 구역">
        <p><strong>전체 문구</strong><span>{totalFields}</span></p>
        {flows.map((flow) => <section key={flow.id}>
          <button
            type="button"
            className={!normalizedQuery && selectedFlow?.id === flow.id ? "flow active" : "flow"}
            onClick={() => {
              setQuery("");
              setSelectedFlowId(flow.id);
              setSelectedGroupId(flow.groups[0]?.id || "");
            }}
          ><span>{flow.label}</span><b>{flow.fieldCount}</b></button>
          <div>{flow.groups.map((group) => <button
            type="button"
            className={!normalizedQuery && selectedFlow?.id === flow.id && selectedGroup?.id === group.id ? "active" : ""}
            onClick={() => {
              setQuery("");
              setSelectedFlowId(flow.id);
              setSelectedGroupId(group.id);
            }}
            key={group.id}
          ><span>{group.label}</span><small>{group.items.length}</small></button>)}</div>
        </section>)}
      </aside>

      <main className="system-dialogue-main">
        <header>
          <div>
            <p className="eyebrow">{normalizedQuery ? "SEARCH RESULTS" : selectedFlow?.label}</p>
            <h3>{normalizedQuery ? `‘${query.trim()}’ 검색 결과` : selectedGroup?.label}</h3>
            <small>{visibleItems.length}개 화면 단위 · {visibleItems.reduce((count, item) => count + item.rows.length, 0)}개 문구</small>
          </div>
          {!normalizedQuery && <p>내부 ID가 아니라 게임에서 언제 보이는지를 기준으로 묶었습니다.</p>}
        </header>

        <div className="system-dialogue-items">
          {visibleItems.map((item) => {
            const itemDirtyKeys = item.rows.filter((row) => dirtySet.has(row.key)).map((row) => row.key);
            const perceived = item.rows.find((row) => row.fieldRole === "perceived");
            const reality = item.rows.find((row) => row.fieldRole === "reality");
            return <article className={itemDirtyKeys.length ? "system-dialogue-item dirty" : "system-dialogue-item"} key={item.id}>
              <header>
                <div><span>{item.flowTitle} · {item.groupLabel}</span><h4>{item.label}</h4><p>{item.context}</p></div>
                <div>
                  {perceived && reality ? <>
                    <button type="button" disabled={saving || Boolean(dirtyKeys.length)} onClick={() => onPreview({ ...item.previewTarget, layer: "perceived" })} title={dirtyKeys.length ? "수정한 문구를 모두 저장한 뒤 확인할 수 있습니다" : "제작 플레이의 스토리 모드 화면으로 확인"}>▶ 화면 대사 보기</button>
                    <button type="button" disabled={saving || Boolean(dirtyKeys.length)} onClick={() => onPreview({ ...item.previewTarget, layer: "reality" })} title={dirtyKeys.length ? "수정한 문구를 모두 저장한 뒤 확인할 수 있습니다" : "제작 플레이의 원문 모드 화면으로 확인"}>실제 상황 보기</button>
                  </> : <button type="button" disabled={saving || Boolean(dirtyKeys.length)} onClick={() => onPreview(item.previewTarget)} title={dirtyKeys.length ? "수정한 문구를 모두 저장한 뒤 확인할 수 있습니다" : "제작 플레이에서 실제 화면으로 확인"}>▶ 게임에서 보기</button>}
                  {itemDirtyKeys.length > 0 && <button type="button" onClick={() => resetKeys(itemDirtyKeys)}>이 항목 취소</button>}
                </div>
              </header>
              <div className="system-dialogue-fields">
                {item.rows.map((row) => <label className={`${row.fieldRole} ${dirtySet.has(row.key) ? "dirty" : ""}`} key={row.key}>
                  <span><strong>{row.fieldLabel}</strong>{dirtySet.has(row.key) && <em>수정됨</em>}</span>
                  <textarea
                    rows={row.fieldRole === "label" ? 2 : 3}
                    value={drafts[row.key] ?? row.source}
                    onChange={(event) => {
                      setDrafts((current) => ({ ...current, [row.key]: event.target.value }));
                      setSaveError("");
                    }}
                  />
                </label>)}
              </div>
              <footer>
                <details><summary>저장 위치 보기</summary>{item.rows.map((row) => <code key={row.key}>{row.path} · {row.fieldPath}</code>)}</details>
                {perceived && reality && drafts[perceived.key] !== drafts[reality.key] && <button type="button" onClick={() => setDrafts((current) => ({ ...current, [reality.key]: current[perceived.key] }))}>화면 대사를 실제 상황에도 복사</button>}
              </footer>
            </article>;
          })}
          {!visibleItems.length && <div className="system-dialogue-empty"><strong>검색 결과가 없습니다.</strong><p>게임에 보이는 문장 일부나 활동 이름으로 다시 검색해 보세요.</p><button type="button" onClick={() => setQuery("")}>검색 지우기</button></div>}
        </div>
      </main>
    </div>
  </section>;
}
