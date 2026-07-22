import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clone, parseEditorValue, statePaths } from "./storyLogic";
import type {
  Condition,
  Campaign,
  DocumentActivity,
  DocumentMeta,
  JsonValue,
  ProjectPayload,
  MetaDocument,
  Route,
  Runtime,
  TimelineThread,
  TimeSlot,
  ValidationIssue,
  VisualObject,
  VisualVariant,
} from "./types";

export type SettingsKind = "campaign" | "route" | "thread" | "meta" | "visual";
type SettingsDocument = Campaign | Route | TimelineThread | MetaDocument | VisualObject;

export type SettingsRequest = { kind: SettingsKind; id: string; token: number };

type Props = {
  active: boolean;
  payload: ProjectPayload;
  onPayload: (payload: ProjectPayload) => void;
  onIssues: (issues: ValidationIssue[]) => void;
  onStatus: (status: string) => void;
  onDocumentActivity: (activity: DocumentActivity) => void;
  requestedDocument: SettingsRequest | null;
};

const MODE_LABELS: Record<Route["mode"], string> = {
  base: "기본 루트",
  truth_view: "진실 보기",
  survivor_view: "생존 모드",
};

const VISUAL_KIND_LABELS: Record<VisualObject["kind"], string> = {
  background_archetype: "배경 공통 규칙",
  background: "배경",
  character_archetype: "인물 공통 규칙",
  character: "인물",
};

const SETTINGS_KIND_LABELS: Record<SettingsKind, string> = {
  campaign: "시간축",
  route: "루트",
  thread: "스레드",
  meta: "해금",
  visual: "비주얼",
};

const SLOT_LABELS: Record<TimeSlot, string> = { morning: "오전", lunch: "점심", afternoon: "오후", after_work: "퇴근 후" };

const RENDER_LABELS = {
  background: "배경 이미지",
  flat_portrait: "단일 인물 이미지",
  layered_sprite: "레이어 인물 이미지",
};

function csv(values: string[] | undefined) {
  return (values || []).join(", ");
}

function parseCsv(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function editorText(value: JsonValue) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseLooseValue(value: string): JsonValue {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return value;
  }
}

function documentLabel(document: SettingsDocument, runtime: Runtime) {
  if ("scene_order" in document) return document.title;
  if ("acts" in document || "events" in document) return document.title;
  if ("unlock_rules" in document) return "모드 해금과 예고";
  if (document.character) return runtime.characters[document.character]?.display_name || document.id;
  return runtime.localization.source_strings[document.title_key || ""] || document.title_key || document.id;
}

function ConditionRows({ runtime, values, onChange }: { runtime: Runtime; values: Condition[]; onChange: (values: Condition[]) => void }) {
  const paths = useMemo(() => statePaths(runtime), [runtime]);
  const update = (index: number, patch: Partial<Condition>) => {
    const next = clone(values);
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };
  return <div className="settings-condition-list">
    {values.map((condition, index) => {
      const path = paths.find((item) => item.value === condition.path) || paths[0];
      const operators = path.type === "number"
        ? [["gte", "이상"], ["gt", "초과"], ["lte", "이하"], ["lt", "미만"], ["eq", "같음"], ["ne", "다름"]]
        : path.type === "array" ? [["contains", "포함"], ["not_contains", "미포함"]] : [["eq", "같음"], ["ne", "다름"]];
      return <div className="settings-condition-row" key={`${condition.path}:${index}`}>
        <select aria-label="해금에 사용할 상태" value={condition.path} onChange={(event) => {
          const selected = paths.find((item) => item.value === event.target.value) || paths[0];
          update(index, { path: selected.value, op: selected.type === "array" ? "contains" : "eq", value: selected.type === "number" ? 0 : "" });
        }}>{paths.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select>
        <select aria-label="해금 비교 방식" value={condition.op} onChange={(event) => update(index, { op: event.target.value })}>
          {operators.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select>
        <input aria-label="해금 비교 값" type={path.type === "number" ? "number" : "text"} value={typeof condition.value === "string" || typeof condition.value === "number" ? condition.value : JSON.stringify(condition.value ?? "")} onChange={(event) => update(index, { value: parseEditorValue(event.target.value, path.type) })} />
        <button type="button" className="icon-button danger" aria-label="해금 조건 삭제" onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}>×</button>
      </div>;
    })}
    <button type="button" className="add-row-button" onClick={() => onChange([...values, { path: "progress.cleared_routes", op: "contains", value: "" }])}>＋ 해금 조건 추가</button>
  </div>;
}

function PropertyRows({ values, onChange }: { values: Record<string, JsonValue>; onChange: (values: Record<string, JsonValue>) => void }) {
  const [newKey, setNewKey] = useState("");
  const entries = Object.entries(values);
  return <div className="property-list">
    {entries.map(([key, value]) => <div className="property-row" key={key}>
      <input aria-label="속성 이름" value={key} onChange={(event) => {
        const nextKey = event.target.value.trim();
        if (!nextKey || nextKey === key || nextKey in values) return;
        const next: Record<string, JsonValue> = {};
        for (const [itemKey, itemValue] of entries) next[itemKey === key ? nextKey : itemKey] = itemValue;
        onChange(next);
      }} />
      <input aria-label={`${key} 값`} value={editorText(value)} onChange={(event) => onChange({ ...values, [key]: parseLooseValue(event.target.value) })} />
      <button type="button" className="icon-button danger" aria-label={`${key} 삭제`} onClick={() => {
        const next = { ...values };
        delete next[key];
        onChange(next);
      }}>×</button>
    </div>)}
    <div className="property-add-row"><input placeholder="새 속성 이름" value={newKey} onChange={(event) => setNewKey(event.target.value)} /><button type="button" onClick={() => {
      const key = newKey.trim();
      if (!key || key in values) return;
      onChange({ ...values, [key]: "" });
      setNewKey("");
    }}>추가</button></div>
  </div>;
}

function NestedObjectRows({ title, values, onChange }: { title: string; values: Record<string, Record<string, JsonValue>>; onChange: (values: Record<string, Record<string, JsonValue>>) => void }) {
  const [newId, setNewId] = useState("");
  return <fieldset><legend>{title}</legend><div className="settings-card-list">
    {Object.entries(values).map(([id, properties]) => <section className="settings-card" key={id}>
      <header><strong>{id}</strong><button type="button" className="icon-button danger" aria-label={`${id} 삭제`} onClick={() => {
        const next = { ...values };
        delete next[id];
        onChange(next);
      }}>×</button></header>
      <PropertyRows values={properties} onChange={(nextProperties) => onChange({ ...values, [id]: nextProperties })} />
    </section>)}
    <div className="settings-add-row"><input placeholder={`새 ${title} ID`} value={newId} onChange={(event) => setNewId(event.target.value)} /><button type="button" onClick={() => {
      const id = newId.trim();
      if (!/^[a-z][a-z0-9_]*$/.test(id) || id in values) return;
      onChange({ ...values, [id]: {} });
      setNewId("");
    }}>추가</button></div>
  </div></fieldset>;
}

function RouteEditor({ route, runtime, onChange }: { route: Route; runtime: Runtime; onChange: (route: Route) => void }) {
  const routeScenes = Object.values(runtime.scenes).filter((scene) => scene.route === route.id);
  const sequenceCandidates = routeScenes.filter((scene) => !route.scene_order.includes(scene.id) && !route.endings.some((ending) => ending.scene === scene.id));
  const update = (patch: Partial<Route>) => onChange({ ...route, ...patch });
  const moveScene = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= route.scene_order.length) return;
    const next = [...route.scene_order];
    [next[index], next[target]] = [next[target], next[index]];
    update({ scene_order: next });
  };
  return <div className="settings-form-scroll">
    <fieldset><legend>루트 개요</legend><div className="form-grid">
      <label className="field"><span>루트 ID · 파일명과 참조 보호</span><input value={route.id} readOnly /></label>
      <label className="field"><span>플레이 모드</span><select value={route.mode} onChange={(event) => update({ mode: event.target.value as Route["mode"] })}>{Object.entries(MODE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label className="field"><span>표시 제목</span><input value={route.title} onChange={(event) => update({ title: event.target.value })} /></label>
      <label className="field"><span>중심 인물</span><select value={route.heroine} onChange={(event) => update({ heroine: event.target.value })}>{Object.values(runtime.characters).map((character) => <option value={character.id} key={character.id}>{character.display_name} · {character.id}</option>)}</select></label>
      <label className="field field-wide"><span>루트가 약속하는 경험</span><textarea rows={3} value={route.summary} onChange={(event) => update({ summary: event.target.value })} /></label>
    </div></fieldset>

    <fieldset><legend>해금 조건 · 모두 만족해야 열림</legend><ConditionRows runtime={runtime} values={route.unlock_conditions || []} onChange={(unlock_conditions) => update({ unlock_conditions })} /></fieldset>

    <fieldset><legend>본편 장면 순서 ({route.scene_order.length})</legend>
      <p className="settings-help">위에서 아래로 실제 플레이 순서입니다. 시작 장면은 이 목록 안에 있어야 합니다.</p>
      <label className="field route-entry"><span>시작 장면</span><select value={route.entry_scene} onChange={(event) => update({ entry_scene: event.target.value })}>{route.scene_order.map((id) => <option value={id} key={id}>{runtime.scenes[id]?.title || id} · {id}</option>)}</select></label>
      <div className="route-order-list">{route.scene_order.map((id, index) => <div className={id === route.entry_scene ? "route-order-row entry" : "route-order-row"} key={id}>
        <span className="sequence-number">{index + 1}</span><span><strong>{runtime.scenes[id]?.title || id}</strong><small>{id}{id === route.entry_scene ? " · 시작" : ""}</small></span>
        <button type="button" className="icon-button" aria-label={`${id} 위로`} disabled={index === 0} onClick={() => moveScene(index, -1)}>↑</button>
        <button type="button" className="icon-button" aria-label={`${id} 아래로`} disabled={index === route.scene_order.length - 1} onClick={() => moveScene(index, 1)}>↓</button>
        <button type="button" className="icon-button danger" aria-label={`${id} 순서에서 제거`} disabled={route.scene_order.length <= 1 || id === route.entry_scene} title={id === route.entry_scene ? "먼저 다른 시작 장면을 선택하세요" : "루트 순서에서 제거"} onClick={() => update({ scene_order: route.scene_order.filter((sceneId) => sceneId !== id) })}>×</button>
      </div>)}</div>
      {sequenceCandidates.length > 0 && <label className="settings-select-add"><span>아직 배치하지 않은 장면</span><select defaultValue="" onChange={(event) => {
        if (!event.target.value) return;
        update({ scene_order: [...route.scene_order, event.target.value] });
        event.target.value = "";
      }}><option value="">장면 선택…</option>{sequenceCandidates.map((scene) => <option value={scene.id} key={scene.id}>{scene.title} · {scene.id}</option>)}</select></label>}
    </fieldset>

    <fieldset><legend>엔딩 ({route.endings.length})</legend><div className="settings-card-list">
      {route.endings.map((ending, index) => <section className="ending-row" key={`${ending.scene}:${index}`}>
        <span className="sequence-number">E{index + 1}</span>
        <label className="field"><span>엔딩 장면</span><select value={ending.scene} onChange={(event) => {
          const endings = clone(route.endings); endings[index].scene = event.target.value; update({ endings });
        }}>{routeScenes.map((scene) => <option value={scene.id} key={scene.id}>{scene.title} · {scene.id}</option>)}</select></label>
        <label className="field"><span>결과 ID</span><input value={ending.outcome} onChange={(event) => { const endings = clone(route.endings); endings[index].outcome = event.target.value; update({ endings }); }} /></label>
        <button type="button" className="icon-button danger" aria-label="엔딩 삭제" disabled={route.endings.length <= 1} onClick={() => update({ endings: route.endings.filter((_, itemIndex) => itemIndex !== index) })}>×</button>
      </section>)}
      <button type="button" className="add-card-button" onClick={() => update({ endings: [...route.endings, { scene: routeScenes.find((scene) => !route.endings.some((ending) => ending.scene === scene.id))?.id || routeScenes[0]?.id || "", outcome: "draft" }] })}>＋ 엔딩 추가</button>
    </div></fieldset>
  </div>;
}

function CampaignEditor({ campaign, onChange }: { campaign: Campaign; onChange: (campaign: Campaign) => void }) {
  const update = (patch: Partial<Campaign>) => onChange({ ...campaign, ...patch });
  const toggleSlot = (field: "slots" | "choice_slots", slot: TimeSlot, checked: boolean) => {
    const current = campaign[field];
    const ordered = (Object.keys(SLOT_LABELS) as TimeSlot[]).filter((value) => checked ? current.includes(value) || value === slot : current.includes(value) && value !== slot);
    update({ [field]: ordered });
  };
  return <div className="settings-form-scroll">
    <fieldset><legend>캠페인 달력</legend><div className="form-grid">
      <label className="field"><span>캠페인 ID · 참조 보호</span><input value={campaign.id} readOnly /></label>
      <label className="field"><span>표시 제목</span><input value={campaign.title} onChange={(event) => update({ title: event.target.value })} /></label>
      <label className="field"><span>전체 일수</span><input type="number" min="1" value={campaign.total_days} onChange={(event) => update({ total_days: Number(event.target.value) })} /></label>
      <div className="field"><span>하루 시간대</span><div className="mode-checks wrap">{(Object.entries(SLOT_LABELS) as Array<[TimeSlot, string]>).map(([slot, label]) => <label key={slot}><input type="checkbox" checked={campaign.slots.includes(slot)} onChange={(event) => toggleSlot("slots", slot, event.target.checked)} />{label}</label>)}</div></div>
      <div className="field field-wide"><span>플레이어가 일정을 고르는 시간대</span><div className="mode-checks wrap">{(Object.entries(SLOT_LABELS) as Array<[TimeSlot, string]>).map(([slot, label]) => <label key={slot}><input type="checkbox" checked={campaign.choice_slots.includes(slot)} disabled={!campaign.slots.includes(slot)} onChange={(event) => toggleSlot("choice_slots", slot, event.target.checked)} />{label}</label>)}</div></div>
    </div></fieldset>

    <fieldset><legend>막 구성 ({campaign.acts.length})</legend><p className="settings-help">각 막이 담당하는 날짜와 서사 목적입니다. 날짜가 겹치거나 비면 검증 결과에서 바로 알려줍니다.</p><div className="settings-card-list">
      {campaign.acts.map((act, index) => <section className="settings-card" key={`${act.id}:${index}`}><header><strong>{act.number}막 · {act.title}</strong><button type="button" className="icon-button danger" aria-label="막 삭제" onClick={() => update({ acts: campaign.acts.filter((_, itemIndex) => itemIndex !== index) })}>×</button></header><div className="form-grid">
        <label className="field"><span>막 번호</span><input type="number" min="1" value={act.number} onChange={(event) => { const acts = clone(campaign.acts); acts[index].number = Number(event.target.value); update({ acts }); }} /></label>
        <label className="field"><span>막 ID</span><input value={act.id} onChange={(event) => { const acts = clone(campaign.acts); acts[index].id = event.target.value; update({ acts }); }} /></label>
        <label className="field"><span>제목</span><input value={act.title} onChange={(event) => { const acts = clone(campaign.acts); acts[index].title = event.target.value; update({ acts }); }} /></label>
        <div className="field"><span>기간</span><div className="day-range"><input aria-label="막 시작일" type="number" min="1" max={campaign.total_days} value={act.days[0]} onChange={(event) => { const acts = clone(campaign.acts); acts[index].days[0] = Number(event.target.value); update({ acts }); }} /><span>~</span><input aria-label="막 종료일" type="number" min="1" max={campaign.total_days} value={act.days[1]} onChange={(event) => { const acts = clone(campaign.acts); acts[index].days[1] = Number(event.target.value); update({ acts }); }} /></div></div>
        <label className="field field-wide"><span>이 막의 서사 목적</span><textarea rows={2} value={act.purpose} onChange={(event) => { const acts = clone(campaign.acts); acts[index].purpose = event.target.value; update({ acts }); }} /></label>
      </div></section>)}
      <button type="button" className="add-card-button" onClick={() => update({ acts: [...campaign.acts, { number: campaign.acts.length + 1, id: `act_${campaign.acts.length + 1}`, title: "새 막", days: [campaign.total_days, campaign.total_days], purpose: "이 막의 서사 목적" }] })}>＋ 막 추가</button>
    </div></fieldset>

    <fieldset><legend>타임라인 레인 ({campaign.lanes.length})</legend><p className="settings-help">시간 설계 화면의 세로 행입니다. 레인 ID 변경은 연결된 사건·스레드도 함께 바꿔야 하므로 검증이 저장을 차단할 수 있습니다.</p><div className="settings-card-list">
      {campaign.lanes.map((lane, index) => <section className="lane-edit-row" key={`${lane.id}:${index}`}><label className="field"><span>레인 ID</span><input value={lane.id} onChange={(event) => { const lanes = clone(campaign.lanes); lanes[index].id = event.target.value; update({ lanes }); }} /></label><label className="field"><span>화면 이름</span><input value={lane.title} onChange={(event) => { const lanes = clone(campaign.lanes); lanes[index].title = event.target.value; update({ lanes }); }} /></label><label className="field"><span>종류</span><select value={lane.kind} onChange={(event) => { const lanes = clone(campaign.lanes); lanes[index].kind = event.target.value as Campaign["lanes"][number]["kind"]; update({ lanes }); }}><option value="world">세계·회사</option><option value="character">인물</option><option value="truth">숨은 진실</option></select></label><button type="button" className="icon-button danger" aria-label="레인 삭제" onClick={() => update({ lanes: campaign.lanes.filter((_, itemIndex) => itemIndex !== index) })}>×</button></section>)}
      <button type="button" className="add-card-button" onClick={() => update({ lanes: [...campaign.lanes, { id: `lane_${campaign.lanes.length + 1}`, title: "새 레인", kind: "world" }] })}>＋ 레인 추가</button>
    </div></fieldset>
  </div>;
}

function ThreadEditor({ thread, runtime, onChange }: { thread: TimelineThread; runtime: Runtime; onChange: (thread: TimelineThread) => void }) {
  const campaign = Object.values(runtime.campaigns)[0];
  const update = (patch: Partial<TimelineThread>) => onChange({ ...thread, ...patch });
  const availableEvents = Object.values(runtime.events).filter((event) => !thread.events.includes(event.id) && (!event.thread || event.thread === thread.id));
  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= thread.events.length) return;
    const events = [...thread.events];
    [events[index], events[target]] = [events[target], events[index]];
    update({ events });
  };
  return <div className="settings-form-scroll">
    <fieldset><legend>사건 스레드</legend><div className="form-grid">
      <label className="field"><span>스레드 ID · 사건 참조 보호</span><input value={thread.id} readOnly /></label>
      <label className="field"><span>표시 제목</span><input value={thread.title} onChange={(event) => update({ title: event.target.value })} /></label>
      <label className="field"><span>타임라인 레인</span><select value={thread.lane} onChange={(event) => update({ lane: event.target.value })}>{campaign?.lanes.map((lane) => <option value={lane.id} key={lane.id}>{lane.title} · {lane.id}</option>)}</select></label>
      <label className="field"><span>중심 인물</span><select value={thread.heroine || ""} onChange={(event) => update({ heroine: event.target.value || undefined })}><option value="">특정 인물 없음</option>{Object.values(runtime.characters).map((character) => <option value={character.id} key={character.id}>{character.display_name} · {character.id}</option>)}</select></label>
    </div></fieldset>
    <fieldset><legend>스레드 사건 순서 ({thread.events.length})</legend><p className="settings-help">날짜와 별개인 서사적 선후 관계입니다. 시간표에서 사건의 연결 맥락과 복제 위치를 결정합니다.</p><div className="route-order-list">{thread.events.map((id, index) => <div className="route-order-row" key={id}><span className="sequence-number">{index + 1}</span><span><strong>{runtime.events[id]?.title || id}</strong><small>{id} · {runtime.events[id]?.window.days.join("~")}일</small></span><button type="button" className="icon-button" disabled={index === 0} aria-label="사건 위로" onClick={() => move(index, -1)}>↑</button><button type="button" className="icon-button" disabled={index === thread.events.length - 1} aria-label="사건 아래로" onClick={() => move(index, 1)}>↓</button><button type="button" className="icon-button danger" disabled={thread.events.length <= 1} aria-label="스레드에서 사건 제거" onClick={() => update({ events: thread.events.filter((eventId) => eventId !== id) })}>×</button></div>)}</div>
      {availableEvents.length > 0 && <label className="settings-select-add"><span>연결할 사건</span><select defaultValue="" onChange={(event) => { if (!event.target.value) return; update({ events: [...thread.events, event.target.value] }); event.target.value = ""; }}><option value="">사건 선택…</option>{availableEvents.map((event) => <option value={event.id} key={event.id}>{event.title} · {event.id}</option>)}</select></label>}
    </fieldset>
  </div>;
}

function MetaEditor({ meta, runtime, onChange }: { meta: MetaDocument; runtime: Runtime; onChange: (meta: MetaDocument) => void }) {
  const update = (patch: Partial<MetaDocument>) => onChange({ ...meta, ...patch });
  const rules = meta.unlock_rules || [];
  const teasers = meta.mode_teasers || [];
  return <div className="settings-form-scroll">
    <fieldset><legend>모드 해금 규칙 ({rules.length})</legend><p className="settings-help">조건을 모두 충족하면 모드를 열고 플레이어에게 보상을 안내합니다.</p><div className="settings-card-list">{rules.map((rule, index) => <section className="settings-card" key={`${rule.id}:${index}`}><header><strong>{rule.id}</strong><button type="button" className="icon-button danger" aria-label="해금 규칙 삭제" onClick={() => update({ unlock_rules: rules.filter((_, itemIndex) => itemIndex !== index) })}>×</button></header><div className="form-grid"><label className="field"><span>규칙 ID</span><input value={rule.id} onChange={(event) => { const next = clone(rules); next[index].id = event.target.value; update({ unlock_rules: next }); }} /></label><label className="field"><span>열리는 모드</span><input value={rule.mode} onChange={(event) => { const next = clone(rules); next[index].mode = event.target.value; update({ unlock_rules: next }); }} /></label><label className="field field-wide"><span>플레이어에게 보일 보상 설명</span><textarea rows={2} value={rule.reward} onChange={(event) => { const next = clone(rules); next[index].reward = event.target.value; update({ unlock_rules: next }); }} /></label></div><ConditionRows runtime={runtime} values={rule.conditions} onChange={(conditions) => { const next = clone(rules); next[index].conditions = conditions; update({ unlock_rules: next }); }} /></section>)}<button type="button" className="add-card-button" onClick={() => update({ unlock_rules: [...rules, { id: "new_unlock", mode: "truth_view", reward: "새 모드가 열립니다.", conditions: [] }] })}>＋ 해금 규칙 추가</button></div></fieldset>

    <fieldset><legend>클리어 후 다음 모드 예고 ({teasers.length})</legend><p className="settings-help">해금되는 콘텐츠를 제목과 한 문장으로 암시해 다음 플레이 동기를 만듭니다.</p><div className="settings-card-list">{teasers.map((teaser, teaserIndex) => <section className="settings-card" key={`${teaser.id}:${teaserIndex}`}><header><strong>{teaser.id}</strong><button type="button" className="icon-button danger" aria-label="예고 규칙 삭제" onClick={() => update({ mode_teasers: teasers.filter((_, index) => index !== teaserIndex) })}>×</button></header><label className="field"><span>예고 규칙 ID</span><input value={teaser.id} onChange={(event) => { const next = clone(teasers); next[teaserIndex].id = event.target.value; update({ mode_teasers: next }); }} /></label><ConditionRows runtime={runtime} values={teaser.conditions} onChange={(conditions) => { const next = clone(teasers); next[teaserIndex].conditions = conditions; update({ mode_teasers: next }); }} /><div className="reveal-list">{teaser.reveals.map((reveal, revealIndex) => <div className="reveal-row" key={`${reveal.mode}:${revealIndex}`}><label className="field"><span>모드</span><input value={reveal.mode} onChange={(event) => { const next = clone(teasers); next[teaserIndex].reveals[revealIndex].mode = event.target.value; update({ mode_teasers: next }); }} /></label><label className="field"><span>예고 제목</span><input value={reveal.title} onChange={(event) => { const next = clone(teasers); next[teaserIndex].reveals[revealIndex].title = event.target.value; update({ mode_teasers: next }); }} /></label><label className="field field-wide"><span>예고 문구</span><textarea rows={2} value={reveal.teaser} onChange={(event) => { const next = clone(teasers); next[teaserIndex].reveals[revealIndex].teaser = event.target.value; update({ mode_teasers: next }); }} /></label><button type="button" className="icon-button danger" disabled={teaser.reveals.length <= 1} aria-label="예고 항목 삭제" onClick={() => { const next = clone(teasers); next[teaserIndex].reveals = next[teaserIndex].reveals.filter((_, index) => index !== revealIndex); update({ mode_teasers: next }); }}>×</button></div>)}<button type="button" className="add-row-button" onClick={() => { const next = clone(teasers); next[teaserIndex].reveals.push({ mode: "survivor_view", title: "생존 모드", teaser: "증거를 모으고 살아남으십시오." }); update({ mode_teasers: next }); }}>＋ 예고 항목 추가</button></div></section>)}<button type="button" className="add-card-button" onClick={() => update({ mode_teasers: [...teasers, { id: "new_teaser", conditions: [], reveals: [{ mode: "survivor_view", title: "생존 모드", teaser: "증거를 모으고 살아남으십시오." }] }] })}>＋ 예고 규칙 추가</button></div></fieldset>
  </div>;
}

function VariantEditor({ id, variant, onChange, onDelete, onChooseAsset }: { id: string; variant: VisualVariant; onChange: (variant: VisualVariant) => void; onDelete: () => void; onChooseAsset: () => void }) {
  const updateMatch = (key: keyof VisualVariant["match"], value: string) => onChange({ ...variant, match: { ...variant.match, [key]: parseCsv(value) } });
  return <section className="settings-card variant-card"><header><strong>{id}</strong><button type="button" className="icon-button danger" aria-label={`${id} variant 삭제`} onClick={onDelete}>×</button></header>
    <div className="form-grid">
      <label className="field field-wide"><span>이미지 경로</span><div className="asset-input"><input value={variant.asset} onChange={(event) => onChange({ ...variant, asset: event.target.value })} /><button type="button" onClick={onChooseAsset}>선택…</button></div></label>
      <label className="field"><span>우선순위 · 높을수록 먼저</span><input type="number" value={variant.priority} onChange={(event) => onChange({ ...variant, priority: Number(event.target.value) })} /></label>
      <label className="field"><span>장소 · 쉼표 구분</span><input value={csv(variant.match.locations)} onChange={(event) => updateMatch("locations", event.target.value)} /></label>
      <label className="field"><span>시간 · 쉼표 구분</span><input value={csv(variant.match.times)} onChange={(event) => updateMatch("times", event.target.value)} /></label>
      <label className="field"><span>분위기 · 쉼표 구분</span><input value={csv(variant.match.atmospheres)} onChange={(event) => updateMatch("atmospheres", event.target.value)} /></label>
      <label className="field"><span>화면 모드</span><div className="mode-checks">{(["perceived", "reality"] as const).map((mode) => <label key={mode}><input type="checkbox" checked={(variant.match.modes || []).includes(mode)} onChange={(event) => {
        const values = variant.match.modes || [];
        onChange({ ...variant, match: { ...variant.match, modes: event.target.checked ? [...values, mode] : values.filter((value) => value !== mode) } });
      }} />{mode === "perceived" ? "주인공 인식" : "실제"}</label>)}</div></label>
    </div>
  </section>;
}

function VisualEditor({ visual, runtime, onChange, chooseAsset }: { visual: VisualObject; runtime: Runtime; onChange: (visual: VisualObject) => void; chooseAsset: (assign: (path: string) => void) => void }) {
  const [newVariantId, setNewVariantId] = useState("");
  const variants = visual.variants || {};
  const compatibleParents = Object.values(runtime.visuals).filter((candidate) => candidate.abstract && candidate.id !== visual.id && (visual.kind.startsWith("background") ? candidate.kind === "background_archetype" : candidate.kind === "character_archetype"));
  const update = (patch: Partial<VisualObject>) => onChange({ ...visual, ...patch });
  return <div className="settings-form-scroll">
    <fieldset><legend>비주얼 객체</legend><div className="form-grid">
      <label className="field"><span>비주얼 ID · 참조 보호</span><input value={visual.id} readOnly /></label>
      <label className="field"><span>종류</span><input value={VISUAL_KIND_LABELS[visual.kind]} readOnly /></label>
      <label className="field"><span>공통 규칙 상속</span><select value={visual.extends || ""} onChange={(event) => update({ extends: event.target.value || undefined })}><option value="">상속하지 않음</option>{compatibleParents.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.id}</option>)}</select></label>
      <label className="field"><span>렌더 방식</span><select value={visual.render_strategy || ""} onChange={(event) => update({ render_strategy: (event.target.value || undefined) as VisualObject["render_strategy"] })}><option value="">상속 값 사용</option>{Object.entries(RENDER_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label className="field"><span>화면 제목 번역 키</span><input value={visual.title_key || ""} onChange={(event) => update({ title_key: event.target.value || undefined })} /></label>
      <label className="field"><span>검색 태그 · 쉼표 구분</span><input value={csv(visual.tags)} onChange={(event) => update({ tags: parseCsv(event.target.value) })} /></label>
      {visual.abstract !== undefined && <label className="check-field field-wide"><input type="checkbox" checked={visual.abstract} onChange={(event) => update({ abstract: event.target.checked })} /><span>직접 표시하지 않는 공통 규칙(아키타입)</span></label>}
    </div></fieldset>

    {visual.kind === "background" && <fieldset><legend>조건별 배경 이미지 ({Object.keys(variants).length})</legend>
      <p className="settings-help">현재 장면의 장소·시간·분위기·보기 모드가 많이 맞고 우선순위가 높은 항목이 표시됩니다.</p>
      <div className="settings-card-list">{Object.entries(variants).map(([id, variant]) => <VariantEditor id={id} variant={variant} key={id} onChooseAsset={() => chooseAsset((asset) => update({ variants: { ...variants, [id]: { ...variant, asset } } }))} onChange={(next) => update({ variants: { ...variants, [id]: next } })} onDelete={() => { const next = { ...variants }; delete next[id]; update({ variants: next }); }} />)}
        <div className="settings-add-row"><input placeholder="새 variant ID" value={newVariantId} onChange={(event) => setNewVariantId(event.target.value)} /><button type="button" onClick={() => {
          const id = newVariantId.trim();
          if (!/^[a-z][a-z0-9_]*$/.test(id) || id in variants) return;
          update({ variants: { ...variants, [id]: { asset: "assets/backgrounds/image.png", match: {}, priority: 0 } } }); setNewVariantId("");
        }}>조건 이미지 추가</button></div>
      </div>
    </fieldset>}

    {(visual.kind === "character" || visual.kind === "character_archetype") && <>
      <fieldset><legend>인물 이미지 연결</legend><div className="form-grid">
        <label className="field"><span>연결 인물</span><select value={visual.character || ""} onChange={(event) => update({ character: event.target.value || undefined })}><option value="">공통 규칙</option>{Object.values(runtime.characters).map((character) => <option value={character.id} key={character.id}>{character.display_name} · {character.id}</option>)}</select></label>
        <label className="field"><span>기본 의상</span><input value={visual.default_outfit || ""} onChange={(event) => update({ default_outfit: event.target.value || undefined })} /></label>
        <label className="field"><span>기본 자세</span><input value={visual.default_pose || ""} onChange={(event) => update({ default_pose: event.target.value || undefined })} /></label>
        <label className="field field-wide"><span>기본 이미지</span><div className="asset-input"><input value={visual.fallback_asset || ""} onChange={(event) => update({ fallback_asset: event.target.value || undefined })} /><button type="button" onClick={() => chooseAsset((asset) => update({ fallback_asset: asset }))}>선택…</button></div></label>
      </div></fieldset>
      <NestedObjectRows title="의상" values={visual.outfits || {}} onChange={(outfits) => update({ outfits })} />
      <NestedObjectRows title="자세" values={visual.poses || {}} onChange={(poses) => update({ poses })} />
      <fieldset><legend>표정별 이미지</legend><PropertyRows values={visual.expression_assets || {}} onChange={(values) => update({ expression_assets: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])) })} /></fieldset>
    </>}

    {(visual.defaults || visual.kind.endsWith("archetype")) && <fieldset><legend>상속될 기본 속성</legend><p className="settings-help">숫자와 true/false는 자동으로 해당 타입으로 저장됩니다.</p><PropertyRows values={visual.defaults || {}} onChange={(defaults) => update({ defaults })} /></fieldset>}
  </div>;
}

export default function ProjectSettingsEditor({ active, payload, onPayload, onIssues, onStatus, onDocumentActivity, requestedDocument }: Props) {
  const runtime = payload.runtime;
  const firstCampaign = Object.values(runtime.campaigns)[0];
  const [kind, setKind] = useState<SettingsKind>("campaign");
  const [selectedId, setSelectedId] = useState(firstCampaign?.id || "");
  const [draft, setDraft] = useState<SettingsDocument | null>(firstCampaign ? clone(firstCampaign) : null);
  const [revision, setRevision] = useState(firstCampaign ? payload.documents.campaigns[firstCampaign.id]?.revision || "" : "");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [savedAt, setSavedAt] = useState<number>();
  const [history, setHistory] = useState<{ past: SettingsDocument[]; future: SettingsDocument[] }>({ past: [], future: [] });
  const [previewAsset, setPreviewAsset] = useState("");
  const handledRequestToken = useRef(0);
  const lastAutoSaveAttempt = useRef("");
  const initialRecoveryChecked = useRef(false);

  const sourceFor = (nextKind: SettingsKind, id: string): SettingsDocument | undefined => {
    if (nextKind === "campaign") return runtime.campaigns[id];
    if (nextKind === "route") return runtime.routes[id];
    if (nextKind === "thread") return runtime.threads[id];
    if (nextKind === "meta") return runtime.meta[id];
    return runtime.visuals[id];
  };
  const metaFor = (nextKind: SettingsKind, id: string): DocumentMeta | undefined => {
    if (nextKind === "campaign") return payload.documents.campaigns[id];
    if (nextKind === "route") return payload.documents.routes[id];
    if (nextKind === "thread") return payload.documents.threads[id];
    if (nextKind === "meta") return payload.documents.meta[id];
    return payload.documents.visuals[id];
  };

  const selectDocument = (nextKind: SettingsKind, id: string, force = false) => {
    if (!force && dirty) {
      if (!window.confirm("자동 저장 전 변경을 버리고 다른 설정 문서를 열까요?")) return;
      if (draft) localStorage.removeItem(`love-office-settings-draft:${payload.root}:${kind}:${draft.id}`);
    }
    const source = sourceFor(nextKind, id);
    const meta = metaFor(nextKind, id);
    if (!source || !meta) return;
    const key = `love-office-settings-draft:${payload.root}:${nextKind}:${id}`;
    let next = clone(source);
    let recovered = false;
    const stored = localStorage.getItem(key);
    if (stored) {
      try {
        const recovery = JSON.parse(stored) as { revision: string; document: SettingsDocument };
        if (recovery.revision === meta.revision && JSON.stringify(recovery.document) !== JSON.stringify(source)
          && window.confirm(`저장되지 않은 '${documentLabel(source, runtime)}' 설정 초안을 복구할까요?`)) {
          next = recovery.document;
          recovered = true;
          onStatus("종료 전 보관된 설정 초안을 복구했습니다. 자동 저장을 다시 시도합니다.");
        } else localStorage.removeItem(key);
      } catch {
        localStorage.removeItem(key);
      }
    }
    setKind(nextKind);
    setSelectedId(id);
    setDraft(next);
    setRevision(meta.revision);
    setDirty(recovered);
    setSaveError(false);
    setHistory({ past: [], future: [] });
  };

  useEffect(() => {
    if (!active) return;
    if (requestedDocument && requestedDocument.token !== handledRequestToken.current) {
      handledRequestToken.current = requestedDocument.token;
      selectDocument(requestedDocument.kind, requestedDocument.id);
    } else if (!initialRecoveryChecked.current && selectedId) selectDocument(kind, selectedId, true);
    initialRecoveryChecked.current = true;
    // Requests intentionally reopen the same file from quick open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, requestedDocument?.token]);

  const applyDraft = (next: SettingsDocument, previous?: SettingsDocument) => {
    if (previous) setHistory((value) => ({ past: [...value.past, clone(previous)].slice(-100), future: [] }));
    setDraft(next);
    setDirty(JSON.stringify(next) !== JSON.stringify(sourceFor(kind, next.id)));
    setSaveError(false);
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
    const label = documentLabel(draft, runtime);
    onStatus(`${label} 설정을 전체 참조와 함께 검증하는 중…`);
    const collection = kind === "campaign" ? "campaigns" : kind === "route" ? "routes" : kind === "thread" ? "threads" : kind === "meta" ? "meta" : "visuals";
    try {
      const result = await invoke<{ saved: boolean; issues: ValidationIssue[]; runtime?: Runtime; document?: DocumentMeta }>("save_document", {
        root: payload.root, kind: collection, document: draft, revision,
      });
      onIssues(result.issues);
      if (!result.saved || !result.runtime || !result.document) {
        setSaveError(true);
        onStatus("참조 또는 스키마 오류가 있어 디스크에는 쓰지 않았습니다. 아래 검증 결과를 확인하세요.");
        return;
      }
      const nextPayload = clone(payload);
      nextPayload.runtime = result.runtime;
      if (kind === "campaign") nextPayload.documents.campaigns[draft.id] = result.document;
      else if (kind === "route") nextPayload.documents.routes[draft.id] = result.document;
      else if (kind === "thread") nextPayload.documents.threads[draft.id] = result.document;
      else if (kind === "meta") nextPayload.documents.meta[draft.id] = result.document;
      else nextPayload.documents.visuals[draft.id] = result.document;
      onPayload(nextPayload);
      const savedDocument = kind === "campaign" ? result.runtime.campaigns[draft.id]
        : kind === "route" ? result.runtime.routes[draft.id]
          : kind === "thread" ? result.runtime.threads[draft.id]
            : kind === "meta" ? result.runtime.meta[draft.id]
              : result.runtime.visuals[draft.id];
      setDraft(clone(savedDocument));
      setRevision(result.document.revision);
      setDirty(false);
      setSavedAt(Date.now());
      localStorage.removeItem(`love-office-settings-draft:${payload.root}:${kind}:${draft.id}`);
      onStatus(`${label} YAML과 런타임을 안전하게 저장했습니다.`);
    } catch (error) {
      setSaveError(true);
      const message = String(error);
      onStatus(message.includes("REVISION_CONFLICT") ? "외부에서 설정 파일이 변경되었습니다. 프로젝트를 다시 열어 충돌을 피하세요." : `설정 저장 실패: ${message}`);
    } finally {
      setSaving(false);
    }
  }, [draft, kind, onIssues, onPayload, onStatus, payload, revision, runtime]);

  useEffect(() => {
    if (!draft) return;
    const key = `love-office-settings-draft:${payload.root}:${kind}:${draft.id}`;
    if (!dirty) { localStorage.removeItem(key); return; }
    const timer = window.setTimeout(() => localStorage.setItem(key, JSON.stringify({ revision, document: draft })), 300);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, kind, payload.root, revision]);

  useEffect(() => {
    const preserve = () => {
      if (dirty && draft) localStorage.setItem(`love-office-settings-draft:${payload.root}:${kind}:${draft.id}`, JSON.stringify({ revision, document: draft }));
    };
    window.addEventListener("beforeunload", preserve);
    return () => window.removeEventListener("beforeunload", preserve);
  }, [dirty, draft, kind, payload.root, revision]);

  useEffect(() => {
    if (!dirty || !draft || saving) return;
    const signature = JSON.stringify(draft);
    if (signature === lastAutoSaveAttempt.current) return;
    const timer = window.setTimeout(() => { lastAutoSaveAttempt.current = signature; void save(); }, 1000);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, save, saving]);

  useEffect(() => {
    if (!draft) return;
    onDocumentActivity({
      phase: saving ? "saving" : saveError ? "error" : dirty ? "dirty" : "saved",
      label: `${documentLabel(draft, runtime)} ${SETTINGS_KIND_LABELS[kind]}`,
      path: metaFor(kind, draft.id)?.path || "",
      detail: saving ? "전체 참조 검증 후 디스크 기록 중" : saveError ? "저장 실패 · 마지막 정상 파일 보존됨" : dirty ? "자동 저장 대기" : "YAML + 런타임 동기화됨",
      savedAt,
    });
    // metaFor is stable for the current payload but not memoized.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, draft, kind, saveError, savedAt, saving]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!active || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLocaleLowerCase();
      if (key === "s") { event.preventDefault(); if (dirty && !saving) void save(); }
      if (key === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, dirty, history, save, saving]);

  const visualAsset = draft && "kind" in draft ? draft.fallback_asset || Object.values(draft.variants || {})[0]?.asset || "" : "";
  useEffect(() => {
    if (!visualAsset) { setPreviewAsset(""); return; }
    invoke<string>("read_asset", { root: payload.root, relativePath: visualAsset }).then(setPreviewAsset).catch(() => setPreviewAsset(""));
  }, [payload.root, visualAsset]);

  const chooseAsset = async (assign: (path: string) => void) => {
    const selected = await open({ multiple: false, directory: false, filters: [{ name: "이미지", extensions: ["png", "jpg", "jpeg", "webp", "avif"] }] });
    if (typeof selected !== "string") return;
    const prefix = `${payload.root}/`;
    if (!selected.startsWith(prefix)) { onStatus("프로젝트 폴더 안의 assets 이미지만 연결할 수 있습니다."); return; }
    const relative = selected.slice(prefix.length);
    if (!relative.startsWith("assets/")) { onStatus("선택한 이미지를 프로젝트의 assets 폴더 안으로 옮긴 뒤 다시 선택하세요."); return; }
    assign(relative);
  };

  if (!draft) return <div className="settings-empty">편집할 프로젝트 설정 문서가 없습니다.</div>;
  const campaigns = Object.values(runtime.campaigns);
  const routes = Object.values(runtime.routes);
  const threads = Object.values(runtime.threads);
  const metaDocuments = Object.values(runtime.meta);
  const visuals = Object.values(runtime.visuals).sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));

  const collections: Record<SettingsKind, SettingsDocument[]> = { campaign: campaigns, route: routes, thread: threads, meta: metaDocuments, visual: visuals };
  const documents = collections[kind];
  const openFirst = (nextKind: SettingsKind) => selectDocument(nextKind, collections[nextKind][0]?.id || "");

  return <div className="settings-shell">
    <nav className="settings-list" aria-label="프로젝트 구조와 자산 문서">
      <div className="settings-kind-switch">{(Object.entries(SETTINGS_KIND_LABELS) as Array<[SettingsKind, string]>).map(([value, label]) => <button type="button" className={kind === value ? "active" : ""} key={value} onClick={() => openFirst(value)}>{label}</button>)}</div>
      <div className="panel-heading"><div><p className="eyebrow">PROJECT</p><h2>{SETTINGS_KIND_LABELS[kind]}</h2></div><span>{documents.length}개</span></div>
      <div className="settings-document-list">{documents.map((document) => <button type="button" className={selectedId === document.id ? "settings-document active" : "settings-document"} key={document.id} onClick={() => selectDocument(kind, document.id)}><strong>{documentLabel(document, runtime)}</strong><span>{"scene_order" in document ? `${runtime.characters[document.heroine]?.display_name} · ${MODE_LABELS[document.mode]}` : "acts" in document ? `${document.total_days}일 · ${document.acts.length}막` : "events" in document ? `${document.events.length}개 사건 · ${document.lane}` : "unlock_rules" in document ? `${document.unlock_rules.length}개 해금 · ${document.mode_teasers?.length || 0}개 예고` : `${VISUAL_KIND_LABELS[document.kind]}${document.extends ? ` · ${document.extends} 상속` : ""}`}</span><small>{document.id}</small></button>)}</div>
    </nav>

    <section className="settings-editor-panel">
      <header className="settings-editor-heading"><div><p className="eyebrow">{draft.id}</p><h2>{documentLabel(draft, runtime)}</h2><p>{kind === "campaign" ? "전체 날짜·시간대·막·타임라인 레인을 관리합니다." : kind === "route" ? "플레이 순서·해금·엔딩을 관리합니다." : kind === "thread" ? "시간 사건의 서사적 선후 관계를 관리합니다." : kind === "meta" ? "클리어 후 모드 해금과 다음 이야기 예고를 관리합니다." : "장면 조건이 어떤 실제 이미지로 해석되는지 관리합니다."}</p></div><div className="character-actions"><button type="button" onClick={undo} disabled={!history.past.length || saving} title="⌘Z">↶</button><button type="button" onClick={redo} disabled={!history.future.length || saving} title="⇧⌘Z">↷</button><button type="button" className="primary-button" onClick={save} disabled={!dirty || saving}>{saving ? "저장 중…" : "지금 저장 ⌘S"}</button></div></header>
      {kind === "campaign" && "acts" in draft ? <CampaignEditor campaign={draft} onChange={(next) => applyDraft(next, draft)} />
        : kind === "route" && "scene_order" in draft ? <RouteEditor route={draft} runtime={runtime} onChange={(next) => applyDraft(next, draft)} />
          : kind === "thread" && "events" in draft ? <ThreadEditor thread={draft} runtime={runtime} onChange={(next) => applyDraft(next, draft)} />
            : kind === "meta" && "unlock_rules" in draft ? <MetaEditor meta={draft} runtime={runtime} onChange={(next) => applyDraft(next, draft)} />
              : "kind" in draft ? <VisualEditor visual={draft} runtime={runtime} chooseAsset={chooseAsset} onChange={(next) => applyDraft(next, draft)} /> : null}
    </section>

    <aside className="settings-preview">
      <p className="eyebrow">{kind === "visual" ? "ASSET PREVIEW" : "STRUCTURE PREVIEW"}</p>
      {kind === "campaign" && "acts" in draft ? <><h2>{draft.title}</h2><div className="campaign-mini-timeline" style={{ gridTemplateColumns: `repeat(${Math.max(1, draft.total_days)}, minmax(2px, 1fr))` }}>{draft.acts.map((act) => <section key={act.id} style={{ gridColumn: `${Math.max(1, act.days[0])} / ${Math.min(draft.total_days + 1, act.days[1] + 1)}` }}><strong>{act.number}막</strong><span>{act.title}</span><small>{act.days[0]}~{act.days[1]}일</small></section>)}</div><div className="lane-preview">{draft.lanes.map((lane) => <span className={lane.kind} key={lane.id}>{lane.title}<small>{lane.kind}</small></span>)}</div><p className="settings-preview-note">총 {draft.total_days}일 · 하루 {draft.slots.length}개 시간대 · {draft.choice_slots.length}개 선택 시간대</p></>
        : kind === "route" && "scene_order" in draft ? <><h2>{draft.title}</h2><div className="route-mini-flow">{draft.scene_order.map((id, index) => <div key={id}><span>{index + 1}</span><strong>{runtime.scenes[id]?.title || id}</strong><small>{id}</small></div>)}<div className="route-ending-branches">{draft.endings.map((ending) => <span key={`${ending.scene}:${ending.outcome}`}><strong>{runtime.scenes[ending.scene]?.title || ending.scene}</strong><small>{ending.outcome}</small></span>)}</div></div><p className="settings-preview-note">해금 조건 {draft.unlock_conditions.length}개 · 본편 {draft.scene_order.length}개 · 엔딩 {draft.endings.length}개</p></>
          : kind === "thread" && "events" in draft ? <><h2>{draft.title}</h2><div className="route-mini-flow">{draft.events.map((id, index) => <div key={id}><span>{index + 1}</span><strong>{runtime.events[id]?.title || id}</strong><small>{runtime.events[id]?.window.days.join("~")}일 · {id}</small></div>)}</div><p className="settings-preview-note">{draft.events.length}개 사건 · {Object.values(runtime.campaigns)[0]?.lanes.find((lane) => lane.id === draft.lane)?.title || draft.lane}</p></>
            : kind === "meta" && "unlock_rules" in draft ? <><h2>클리어 이후의 약속</h2><div className="unlock-preview">{draft.unlock_rules.map((rule) => <section key={rule.id}><strong>{rule.mode}</strong><span>{rule.reward}</span><small>{rule.conditions.length}개 조건</small></section>)}</div><div className="unlock-preview teasers">{(draft.mode_teasers || []).flatMap((teaser) => teaser.reveals.map((reveal) => <section key={`${teaser.id}:${reveal.mode}`}><strong>{reveal.title}</strong><span>{reveal.teaser}</span><small>{reveal.mode}</small></section>))}</div></>
              : "kind" in draft ? <><h2>{documentLabel(draft, runtime)}</h2><div className="settings-asset-preview">{previewAsset ? <img src={previewAsset} alt={`${documentLabel(draft, runtime)} 미리보기`} /> : <div className="image-placeholder">NO IMAGE</div>}</div><dl><div><dt>종류</dt><dd>{VISUAL_KIND_LABELS[draft.kind]}</dd></div><div><dt>상속</dt><dd>{draft.extends || "없음"}</dd></div><div><dt>렌더</dt><dd>{draft.render_strategy ? RENDER_LABELS[draft.render_strategy] : "상속"}</dd></div><div><dt>조건 이미지</dt><dd>{Object.keys(draft.variants || {}).length}개</dd></div></dl></> : null}
      <small className="document-path">{metaFor(kind, draft.id)?.path}</small>
    </aside>
  </div>;
}
