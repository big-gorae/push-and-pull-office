import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clone } from "./storyLogic";
import type { Character, DocumentActivity, JsonValue, ProjectPayload, Runtime, ValidationIssue, ViewMode } from "./types";

type Props = {
  active: boolean;
  payload: ProjectPayload;
  onPayload: (payload: ProjectPayload) => void;
  onIssues: (issues: ValidationIssue[]) => void;
  onStatus: (status: string) => void;
  onDocumentActivity: (activity: DocumentActivity) => void;
  requestedCharacter: { id: string; token: number } | null;
};

type CharacterHistory = { past: Character[]; future: Character[] };
type StatCondition = { stat: string; op: string; value?: JsonValue };

const ROLE_ORDER: Record<string, number> = {
  unreliable_protagonist: 0,
  main_heroine: 1,
  supporting_witness_candidate: 2,
  past_survivor: 3,
};

const NARRATIVE_ROLE_LABELS: Record<string, string> = {
  unreliable_protagonist: "신뢰할 수 없는 주인공",
  main_heroine: "기본 루트 핵심 인물",
  supporting_witness_candidate: "역할 미확정 후보 인물",
  past_survivor: "과거 사건 생존자",
};

const LAYER_LABELS: Record<ViewMode, string> = { perceived: "주인공 인식", reality: "실제" };
const STAT_LABELS: Record<string, string> = {
  affection: "호감도",
  initiative: "밀당 주도권",
  suspicion: "의심도",
  dislike: "비호감",
  evidence_count: "물리적 증거",
};

function orderedCharacters(runtime: Runtime) {
  return Object.values(runtime.characters).sort((left, right) =>
    (ROLE_ORDER[left.narrative_role] ?? 99) - (ROLE_ORDER[right.narrative_role] ?? 99) || left.age - right.age);
}

function LinesEditor({ values, placeholder, onChange }: { values: string[]; placeholder: string; onChange: (values: string[]) => void }) {
  return <div className="lines-editor">
    {values.map((value, index) => <div className="line-editor-row" key={index}>
      <textarea rows={2} value={value} placeholder={placeholder} onChange={(event) => {
        const next = [...values];
        next[index] = event.target.value;
        onChange(next);
      }} />
      <button type="button" className="icon-button danger" aria-label="항목 삭제" onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}>×</button>
    </div>)}
    <button type="button" className="add-row-button" onClick={() => onChange([...values, ""])}>＋ 항목 추가</button>
  </div>;
}

function StatConditions({ conditions, onChange }: { conditions: StatCondition[]; onChange: (conditions: StatCondition[]) => void }) {
  const update = (index: number, patch: Partial<StatCondition>) => {
    const next = clone(conditions);
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };
  return <div className="character-condition-list">
    {conditions.map((condition, index) => <div className="character-condition" key={`${condition.stat}-${index}`}>
      <select value={condition.stat} onChange={(event) => update(index, { stat: event.target.value })}>
        {Object.entries(STAT_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select>
      <select value={condition.op} onChange={(event) => update(index, { op: event.target.value })}>
        <option value="gte">이상</option><option value="gt">초과</option><option value="lte">이하</option><option value="lt">미만</option><option value="eq">같음</option>
      </select>
      <input type="number" value={Number(condition.value || 0)} onChange={(event) => update(index, { value: Number(event.target.value) })} />
      <button type="button" className="icon-button danger" aria-label="조건 삭제" onClick={() => onChange(conditions.filter((_, itemIndex) => itemIndex !== index))}>×</button>
    </div>)}
    <button type="button" className="add-row-button" onClick={() => onChange([...conditions, { stat: "suspicion", op: "gte", value: 0 }])}>＋ 조건 추가</button>
  </div>;
}

export default function CharacterEditor({ active, payload, onPayload, onIssues, onStatus, onDocumentActivity, requestedCharacter }: Props) {
  const runtime = payload.runtime;
  const characters = useMemo(() => orderedCharacters(runtime), [runtime]);
  const [selectedId, setSelectedId] = useState(characters[0]?.id || "");
  const [draft, setDraft] = useState<Character | null>(characters[0] ? clone(characters[0]) : null);
  const [revision, setRevision] = useState(characters[0] ? payload.documents.characters[characters[0].id]?.revision || "" : "");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [savedAt, setSavedAt] = useState<number>();
  const [history, setHistory] = useState<CharacterHistory>({ past: [], future: [] });
  const [image, setImage] = useState("");
  const [newExpressionId, setNewExpressionId] = useState("");
  const lastAutoSaveAttempt = useRef("");
  const initialRecoveryChecked = useRef(false);
  const handledRequestToken = useRef(0);

  const selectCharacter = (id: string, force = false) => {
    if (!force && dirty) {
      if (!window.confirm("저장되지 않은 인물 변경을 버리고 다른 인물을 열까요?")) return;
      if (draft) localStorage.removeItem(`love-office-character-draft:${payload.root}:${draft.id}`);
    }
    const source = runtime.characters[id];
    const meta = payload.documents.characters[id];
    if (!source || !meta) return;
    const key = `love-office-character-draft:${payload.root}:${id}`;
    let next = clone(source);
    let recovered = false;
    const stored = localStorage.getItem(key);
    if (stored) {
      try {
        const recovery = JSON.parse(stored) as { revision: string; character: Character };
        if (recovery.revision === meta.revision && JSON.stringify(recovery.character) !== JSON.stringify(source)
          && window.confirm(`저장되지 않은 '${source.display_name}' 인물 초안이 있습니다. 복구할까요?`)) {
          next = recovery.character;
          recovered = true;
          onStatus("종료 전 보관된 인물 초안을 복구했습니다. 자동 저장을 다시 시도합니다.");
        } else localStorage.removeItem(key);
      } catch {
        localStorage.removeItem(key);
      }
    }
    setSelectedId(id);
    setDraft(next);
    setRevision(meta.revision);
    setDirty(recovered);
    setSaveError(false);
    setHistory({ past: [], future: [] });
    setNewExpressionId("");
  };

  useEffect(() => {
    if (!active) return;
    if (requestedCharacter?.id && requestedCharacter.token !== handledRequestToken.current) {
      handledRequestToken.current = requestedCharacter.token;
      selectCharacter(requestedCharacter.id);
    }
    else if (!initialRecoveryChecked.current && selectedId) selectCharacter(selectedId, true);
    initialRecoveryChecked.current = true;
    // Request tokens intentionally reopen the same character from quick open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, requestedCharacter?.token]);

  const applyDraft = (next: Character, previous?: Character) => {
    if (previous) setHistory((value) => ({ past: [...value.past, clone(previous)].slice(-100), future: [] }));
    const changed = JSON.stringify(next) !== JSON.stringify(runtime.characters[next.id]);
    setDraft(next);
    setDirty(changed);
    setSaveError(false);
  };

  const updateDraft = (updater: (character: Character) => void) => {
    if (!draft) return;
    const next = clone(draft);
    updater(next);
    applyDraft(next, draft);
  };

  const undo = () => {
    if (!draft || !history.past.length) return;
    const previous = history.past[history.past.length - 1];
    setHistory({ past: history.past.slice(0, -1), future: [clone(draft), ...history.future].slice(0, 100) });
    applyDraft(previous);
  };

  const redo = () => {
    if (!draft || !history.future.length) return;
    const next = history.future[0];
    setHistory({ past: [...history.past, clone(draft)].slice(-100), future: history.future.slice(1) });
    applyDraft(next);
  };

  const save = useCallback(async () => {
    if (!draft || !revision) return;
    setSaving(true);
    setSaveError(false);
    onStatus(`${draft.display_name} 인물 문서를 검증하고 저장하는 중…`);
    try {
      const result = await invoke<{
        saved: boolean;
        issues: ValidationIssue[];
        runtime?: Runtime;
        document?: ProjectPayload["documents"]["characters"][string];
      }>("save_document", { root: payload.root, kind: "characters", document: draft, revision });
      onIssues(result.issues);
      if (!result.saved || !result.runtime || !result.document) {
        setSaveError(true);
        onStatus("인물 문서에 오류가 있어 원본에는 저장하지 않았습니다.");
        return;
      }
      const nextPayload = clone(payload);
      nextPayload.runtime = result.runtime;
      nextPayload.documents.characters[draft.id] = result.document;
      onPayload(nextPayload);
      setDraft(clone(result.runtime.characters[draft.id]));
      setRevision(result.document.revision);
      setDirty(false);
      setSavedAt(Date.now());
      localStorage.removeItem(`love-office-character-draft:${payload.root}:${draft.id}`);
      onStatus(`${draft.display_name} 인물 YAML과 런타임을 저장했습니다.`);
    } catch (error) {
      setSaveError(true);
      const message = String(error);
      onStatus(message.includes("REVISION_CONFLICT") ? "외부에서 인물 파일이 변경되었습니다. 프로젝트를 다시 여세요." : `인물 저장 실패: ${message}`);
    } finally {
      setSaving(false);
    }
  }, [draft, onIssues, onPayload, onStatus, payload, revision]);

  useEffect(() => {
    if (!draft) return;
    const key = `love-office-character-draft:${payload.root}:${draft.id}`;
    if (!dirty) {
      localStorage.removeItem(key);
      return;
    }
    const timer = window.setTimeout(() => localStorage.setItem(key, JSON.stringify({ revision, character: draft })), 300);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, payload.root, revision]);

  useEffect(() => {
    const preserveDraft = () => {
      if (dirty && draft) localStorage.setItem(`love-office-character-draft:${payload.root}:${draft.id}`, JSON.stringify({ revision, character: draft }));
    };
    window.addEventListener("beforeunload", preserveDraft);
    return () => window.removeEventListener("beforeunload", preserveDraft);
  }, [dirty, draft, payload.root, revision]);

  useEffect(() => {
    if (!dirty || !draft || saving) return;
    const signature = JSON.stringify(draft);
    if (signature === lastAutoSaveAttempt.current) return;
    const timer = window.setTimeout(() => {
      lastAutoSaveAttempt.current = signature;
      void save();
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, save, saving]);

  useEffect(() => {
    if (!draft) return;
    onDocumentActivity({
      phase: saving ? "saving" : saveError ? "error" : dirty ? "dirty" : "saved",
      label: `${draft.display_name} 인물 설정`,
      path: payload.documents.characters[draft.id]?.path || "",
      detail: saving ? "검증 후 디스크에 기록 중" : saveError ? "저장 실패 · 마지막 정상 파일은 보존됨" : dirty ? "자동 저장 대기" : "인물 YAML + 런타임 동기화됨",
      savedAt,
    });
  }, [dirty, draft, onDocumentActivity, payload.documents.characters, saveError, savedAt, saving]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!active || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLocaleLowerCase();
      if (key === "s") {
        event.preventDefault();
        if (dirty && !saving) void save();
      }
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, dirty, history, save, saving]);

  useEffect(() => {
    const art = draft?.visual.concept_art;
    if (!art) {
      setImage("");
      return;
    }
    invoke<string>("read_asset", { root: payload.root, relativePath: art })
      .then(setImage)
      .catch(() => setImage(""));
  }, [draft?.id, draft?.visual.concept_art, payload.root]);

  if (!draft) return <div className="character-empty">편집할 인물이 없습니다.</div>;
  const expressions = Object.entries(draft.expressions || {});
  const emotionRules = draft.emotion_rules || [];
  const reportingRules = draft.reporting_rules || [];

  return <div className="character-shell">
    <nav className="character-list" aria-label="인물 목록">
      <div className="panel-heading"><div><p className="eyebrow">CAST</p><h2>인물</h2></div><span>{characters.length}명</span></div>
      {characters.map((character) => <button type="button" className={character.id === selectedId ? "character-link active" : "character-link"} key={character.id} onClick={() => selectCharacter(character.id)}>
        <strong>{character.display_name}<small>{character.age}세</small></strong>
        <span>{character.role}</span>
      </button>)}
    </nav>

    <section className="character-editor-panel">
      <header className="character-editor-heading">
        <div><p className="eyebrow">{draft.id}</p><h2>{draft.display_name}</h2><p>{draft.summary}</p></div>
        <div className="character-actions"><button type="button" onClick={undo} disabled={!history.past.length || saving} title="⌘Z">↶</button><button type="button" onClick={redo} disabled={!history.future.length || saving} title="⇧⌘Z">↷</button><button type="button" className="primary-button" onClick={save} disabled={!dirty || saving}>{saving ? "저장 중…" : "지금 저장 ⌘S"}</button></div>
      </header>
      <div className="character-form-scroll">
        <fieldset><legend>기본 프로필</legend><div className="form-grid">
          <label className="field"><span>이름</span><input value={draft.display_name} onChange={(event) => updateDraft((value) => { value.display_name = event.target.value; })} /></label>
          <label className="field"><span>나이</span><input type="number" min="18" value={draft.age} onChange={(event) => updateDraft((value) => { value.age = Number(event.target.value); })} /></label>
          <label className="field"><span>직책·역할</span><input value={draft.role} onChange={(event) => updateDraft((value) => { value.role = event.target.value; })} /></label>
          <label className="field"><span>서사 역할</span><select value={draft.narrative_role} onChange={(event) => updateDraft((value) => { value.narrative_role = event.target.value; })}>{Object.entries(NARRATIVE_ROLE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label className="field field-wide"><span>인물 요약</span><textarea rows={3} value={draft.summary} onChange={(event) => updateDraft((value) => { value.summary = event.target.value; })} /></label>
        </div></fieldset>

        <fieldset><legend>바뀌면 안 되는 사실</legend><LinesEditor values={draft.immutable_facts || []} placeholder="이 인물에 대해 반드시 지켜야 할 사실" onChange={(values) => updateDraft((character) => { character.immutable_facts = values; })} /></fieldset>

        <fieldset><legend>말투와 목소리</legend><div className="form-grid">
          <label className="field"><span>말투</span><input value={draft.voice.register} onChange={(event) => updateDraft((value) => { value.voice.register = event.target.value; })} /></label>
          <label className="field"><span>안전한 상황의 모습</span><input value={draft.voice.safe_context || ""} onChange={(event) => updateDraft((value) => { value.voice.safe_context = event.target.value || undefined; })} /></label>
          <div className="field field-wide"><span>말버릇</span><LinesEditor values={draft.voice.habits || []} placeholder="반복되는 말버릇" onChange={(values) => updateDraft((character) => { character.voice.habits = values; })} /></div>
        </div></fieldset>

        <fieldset><legend>외형·소품</legend><div className="form-grid">
          <label className="field field-wide"><span>콘셉트 아트 경로</span><input value={draft.visual.concept_art || ""} onChange={(event) => updateDraft((value) => { value.visual.concept_art = event.target.value || undefined; })} /></label>
          <label className="field field-wide"><span>실루엣 설명</span><textarea rows={2} value={draft.visual.silhouette || ""} onChange={(event) => updateDraft((value) => { value.visual.silhouette = event.target.value; })} /></label>
          <label className="field"><span>색상 팔레트</span><input value={(draft.visual.palette || []).join(", ")} onChange={(event) => updateDraft((value) => { value.visual.palette = event.target.value.split(",").map((item) => item.trim()).filter(Boolean); })} /></label>
          <label className="field"><span>대표 소품</span><input value={(draft.visual.props || []).join(", ")} onChange={(event) => updateDraft((value) => { value.visual.props = event.target.value.split(",").map((item) => item.trim()).filter(Boolean); })} /></label>
        </div></fieldset>

        <fieldset><legend>표정 ({expressions.length})</legend><div className="character-card-list">
          {expressions.map(([id, expression]) => <section className="character-rule-card" key={id}>
            <header><strong>{id}</strong><button type="button" className="icon-button danger" aria-label="표정 삭제" onClick={() => updateDraft((character) => { delete character.expressions?.[id]; })}>×</button></header>
            <div className="form-grid"><label className="field"><span>화면 레이어</span><select value={expression.layer} onChange={(event) => updateDraft((character) => { character.expressions![id].layer = event.target.value as ViewMode; })}>{Object.entries(LAYER_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label className="field"><span>감정 ID</span><input value={expression.emotion} onChange={(event) => updateDraft((character) => { character.expressions![id].emotion = event.target.value; })} /></label><label className="field field-wide"><span>표정 설명</span><textarea rows={2} value={expression.description} onChange={(event) => updateDraft((character) => { character.expressions![id].description = event.target.value; })} /></label></div>
          </section>)}
          <div className="new-expression-row"><input placeholder="새 표정 ID" value={newExpressionId} onChange={(event) => setNewExpressionId(event.target.value)} /><button type="button" onClick={() => {
            const id = newExpressionId.trim();
            if (!/^[a-z][a-z0-9_]*$/.test(id) || draft.expressions?.[id]) { onStatus("표정 ID는 영문 소문자·숫자·밑줄을 사용하고 중복될 수 없습니다."); return; }
            updateDraft((character) => { character.expressions = { ...(character.expressions || {}), [id]: { layer: "reality", emotion: "neutral", description: "새 표정 설명" } }; });
            setNewExpressionId("");
          }}>표정 추가</button></div>
        </div></fieldset>

        <fieldset><legend>감정·행동 규칙 ({emotionRules.length})</legend><div className="character-card-list">
          {emotionRules.map((rule, index) => <section className="character-rule-card" key={`${rule.id}-${index}`}><header><strong>{index + 1}순위 · {rule.id}</strong><button type="button" className="icon-button danger" aria-label="감정 규칙 삭제" onClick={() => updateDraft((character) => { character.emotion_rules = emotionRules.filter((_, itemIndex) => itemIndex !== index); })}>×</button></header><div className="form-grid">
            <label className="field"><span>규칙 ID</span><input value={rule.id} onChange={(event) => updateDraft((character) => { character.emotion_rules![index].id = event.target.value; })} /></label>
            <label className="field"><span>우선순위</span><input type="number" value={rule.priority} onChange={(event) => updateDraft((character) => { character.emotion_rules![index].priority = Number(event.target.value); })} /></label>
            <label className="field"><span>파생 감정</span><input value={rule.emotion} onChange={(event) => updateDraft((character) => { character.emotion_rules![index].emotion = event.target.value; })} /></label>
            <label className="field"><span>행동</span><input value={rule.behavior} onChange={(event) => updateDraft((character) => { character.emotion_rules![index].behavior = event.target.value; })} /></label>
            <label className="field field-wide"><span>기본 실제 표정</span><select value={rule.default_expression} onChange={(event) => updateDraft((character) => { character.emotion_rules![index].default_expression = event.target.value; })}>{expressions.filter(([, value]) => value.layer === "reality").map(([id]) => <option value={id} key={id}>{id}</option>)}</select></label>
          </div><StatConditions conditions={rule.conditions} onChange={(conditions) => updateDraft((character) => { character.emotion_rules![index].conditions = conditions; })} /></section>)}
          <button type="button" className="add-card-button" onClick={() => updateDraft((character) => { character.emotion_rules = [...(character.emotion_rules || []), { id: "new_rule", priority: 0, conditions: [], emotion: "neutral", behavior: "work_normally", default_expression: expressions.find(([, value]) => value.layer === "reality")?.[0] || expressions[0]?.[0] || "" }]; })}>＋ 감정 규칙 추가</button>
        </div></fieldset>

        <fieldset><legend>신고 행동 규칙 ({reportingRules.length})</legend><div className="character-card-list">
          {reportingRules.map((rule, index) => <section className="character-rule-card" key={`${rule.id}-${index}`}><header><strong>{rule.id}</strong><button type="button" className="icon-button danger" aria-label="신고 규칙 삭제" onClick={() => updateDraft((character) => { character.reporting_rules = reportingRules.filter((_, itemIndex) => itemIndex !== index); })}>×</button></header><div className="form-grid"><label className="field"><span>규칙 ID</span><input value={rule.id} onChange={(event) => updateDraft((character) => { character.reporting_rules![index].id = event.target.value; })} /></label><label className="field"><span>행동</span><input value={rule.action} onChange={(event) => updateDraft((character) => { character.reporting_rules![index].action = event.target.value; })} /></label></div><StatConditions conditions={rule.conditions} onChange={(conditions) => updateDraft((character) => { character.reporting_rules![index].conditions = conditions; })} /></section>)}
          <button type="button" className="add-card-button" onClick={() => updateDraft((character) => { character.reporting_rules = [...(character.reporting_rules || []), { id: "new_report_rule", conditions: [], action: "report" }]; })}>＋ 신고 규칙 추가</button>
        </div></fieldset>

        <fieldset><legend>인물 관계</legend><div className="relationship-grid">{characters.filter((character) => character.id !== draft.id).map((character) => <label className="field" key={character.id}><span>{character.display_name}</span><textarea rows={2} value={draft.relationships?.[character.id] || ""} onChange={(event) => updateDraft((value) => { const relationships = { ...(value.relationships || {}) }; if (event.target.value) relationships[character.id] = event.target.value; else delete relationships[character.id]; value.relationships = relationships; })} /></label>)}</div></fieldset>
      </div>
    </section>

    <aside className="character-preview">
      <p className="eyebrow">PORTRAIT</p><h2>{draft.display_name}</h2>
      <div className="character-portrait">{image ? <img src={image} alt={`${draft.display_name} 콘셉트 아트`} /> : <div className="image-placeholder">NO IMAGE</div>}</div>
      <dl><div><dt>나이</dt><dd>{draft.age}세</dd></div><div><dt>직책</dt><dd>{draft.role}</dd></div><div><dt>말투</dt><dd>{draft.voice.register}</dd></div><div><dt>실루엣</dt><dd>{draft.visual.silhouette}</dd></div></dl>
      <small className="document-path">{payload.documents.characters[draft.id]?.path}</small>
    </aside>
  </div>;
}
