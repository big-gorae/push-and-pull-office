import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConditionEditor, EffectEditor } from "./App";
import {
  applyEffect,
  campaignAct,
  clone,
  conditionsMatch,
  eventsForDay,
  inspectTimelineEvent,
  setPath,
} from "./storyLogic";
import { breakPushPullFlow, readPushPullState, writePushPullState, type PushPullTarget } from "./pushPull";
import { campaignInitialState } from "./player/gameModes";
import type {
  ProjectPayload,
  DocumentActivity,
  Runtime,
  RuntimeState,
  TimeSlot,
  TimelineEvent,
  ValidationIssue,
  ViewMode,
} from "./types";

const SLOT_LABELS: Record<TimeSlot, string> = {
  morning: "오전 업무",
  lunch: "점심",
  afternoon: "오후 업무",
  after_work: "퇴근 후",
};

const STATUS_LABELS = {
  eligible: "발생 가능",
  blocked: "조건 미충족",
  upcoming: "예정",
  seen: "발생 완료",
  missed: "놓침",
};

const EVENT_TYPE_LABELS: Record<TimelineEvent["type"], string> = {
  anchor: "고정 사건",
  heroine: "인물 사건",
  company: "회사 사건",
  offscreen: "보이지 않는 사건",
  ending: "엔딩",
};

const AVAILABILITY_LABELS: Record<TimelineEvent["availability"], string> = {
  automatic: "조건 충족 시 자동 발생",
  player: "플레이어가 선택",
  hidden: "보이지 않게 자동 발생",
};

type Props = {
  active: boolean;
  payload: ProjectPayload;
  state: RuntimeState;
  mode: ViewMode;
  onMode: (mode: ViewMode) => void;
  onState: (state: RuntimeState) => void;
  onPayload: (payload: ProjectPayload) => void;
  onIssues: (issues: ValidationIssue[]) => void;
  onStatus: (status: string) => void;
  onOpenScene: (sceneId: string) => void;
  onDuplicateEvent: (event: TimelineEvent) => void;
  requestedEvent: { id: string; token: number } | null;
  onDocumentActivity: (activity: DocumentActivity) => void;
};

function timelineStatus(runtime: Runtime, event: TimelineEvent, state: RuntimeState, day: number) {
  const slot = event.window.slots[0];
  return inspectTimelineEvent(runtime, event, state, day, slot);
}

export default function TimelineEditor({
  active,
  payload,
  state,
  mode,
  onMode,
  onState,
  onPayload,
  onIssues,
  onStatus,
  onOpenScene,
  onDuplicateEvent,
  requestedEvent,
  onDocumentActivity,
}: Props) {
  const runtime = payload.runtime;
  const [campaignId, setCampaignId] = useState("main");
  const campaign = runtime.campaigns[campaignId];
  const [week, setWeek] = useState(0);
  const [selectedDay, setSelectedDay] = useState(state.progress.time.day);
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot>(state.progress.time.slot);
  const [selectedEventId, setSelectedEventId] = useState(
    Object.values(runtime.events).find((event) => event.campaign_id === "main")?.id || "",
  );
  const [eventDraft, setEventDraft] = useState<TimelineEvent | null>(selectedEventId ? clone(runtime.events[selectedEventId]) : null);
  const [eventRevision, setEventRevision] = useState(selectedEventId ? payload.documents.events[selectedEventId]?.revision || "" : "");
  const [eventDirty, setEventDirty] = useState(false);
  const [heroineId, setHeroineId] = useState("yoon_seo_a");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [savedAt, setSavedAt] = useState<number>();
  const lastAutoSaveAttempt = useRef("");
  const initialRecoveryChecked = useRef(false);

  useEffect(() => {
    const firstDay = Math.floor((selectedDay - 1) / 5);
    setWeek(Math.max(0, Math.min(2, firstDay)));
  }, [selectedDay]);

  const days = useMemo(() => Array.from({ length: 5 }, (_, index) => week * 5 + index + 1), [week]);
  const lanes = campaign.lanes.filter((lane) => mode === "reality" || lane.kind !== "truth");
  const act = campaign.acts.find((item) => selectedDay >= item.days[0] && selectedDay <= item.days[1]);
  const selectedEvent = selectedEventId ? runtime.events[selectedEventId] : undefined;
  const verdict = selectedEvent ? inspectTimelineEvent(runtime, selectedEvent, state, selectedDay, selectedSlot) : undefined;
  const modeIds = useMemo(() => Object.keys(runtime.game_modes), [runtime.game_modes]);
  const memoryIds = useMemo(() => Array.from(new Set(
    Object.values(runtime.events).filter((event) => event.campaign_id === campaignId).flatMap((event) => [
      ...event.on_seen.effects,
      ...event.on_missed.effects,
    ]).filter((effect) => effect.path === "progress.memories").map((effect) => String(effect.value)),
  )), [campaignId, runtime.events]);
  const visibleTeasers = Object.values(runtime.meta).flatMap((document) => document.mode_teasers || []).filter((teaser) => conditionsMatch(state, teaser.conditions));

  const selectEvent = (eventId: string) => {
    if (eventDirty) {
      if (!window.confirm("저장하지 않은 이벤트 변경을 버릴까요?")) return;
      if (selectedEventId) localStorage.removeItem(`love-office-event-draft:${payload.root}:${selectedEventId}`);
    }
    const event = runtime.events[eventId];
    if (!event) return;
    const revision = payload.documents.events[eventId]?.revision || "";
    const draftKey = `love-office-event-draft:${payload.root}:${eventId}`;
    let next = clone(event);
    let recovered = false;
    const stored = localStorage.getItem(draftKey);
    if (stored) {
      try {
        const recovery = JSON.parse(stored) as { revision: string; event: TimelineEvent };
        if (recovery.revision === revision && JSON.stringify(recovery.event) !== JSON.stringify(event)
          && window.confirm(`저장되지 않은 '${event.title}' 이벤트 초안이 있습니다. 복구할까요?`)) {
          next = recovery.event;
          recovered = true;
          onStatus("종료 전 보관된 이벤트 초안을 복구했습니다. 자동 저장을 다시 시도합니다.");
        } else localStorage.removeItem(draftKey);
      } catch {
        localStorage.removeItem(draftKey);
      }
    }
    setSelectedEventId(eventId);
    setCampaignId(event.campaign_id);
    setEventDraft(next);
    setEventRevision(revision);
    setEventDirty(recovered);
    setSaveError(false);
    const day = Math.max(event.window.days[0], Math.min(selectedDay, event.window.days[1]));
    setSelectedDay(day);
    setSelectedSlot(event.window.slots[0]);
  };

  const selectCampaign = (nextCampaignId: string) => {
    if (nextCampaignId === campaignId) return;
    if (eventDirty && !window.confirm("저장하지 않은 이벤트 변경을 버리고 캠페인을 바꿀까요?")) return;
    if (selectedEventId) localStorage.removeItem(`love-office-event-draft:${payload.root}:${selectedEventId}`);
    const nextEvent = Object.values(runtime.events).find((event) => event.campaign_id === nextCampaignId);
    setCampaignId(nextCampaignId);
    onState(campaignInitialState(runtime, nextCampaignId));
    if (nextEvent) {
      setSelectedEventId(nextEvent.id);
      setEventDraft(clone(nextEvent));
      setEventRevision(payload.documents.events[nextEvent.id]?.revision || "");
      setEventDirty(false);
      setSaveError(false);
      setSelectedDay(nextEvent.window.days[0]);
      setSelectedSlot(nextEvent.window.slots[0]);
    } else {
      setSelectedEventId("");
      setEventDraft(null);
      setEventRevision("");
      setEventDirty(false);
    }
  };

  useEffect(() => {
    if (requestedEvent?.id) selectEvent(requestedEvent.id);
    else if (!initialRecoveryChecked.current && selectedEventId) selectEvent(selectedEventId);
    initialRecoveryChecked.current = true;
    // token intentionally retriggers opening the same event from quick open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedEvent?.token]);

  const updateEvent = (updater: (event: TimelineEvent) => void) => {
    setEventDraft((current) => {
      if (!current) return current;
      const next = clone(current);
      updater(next);
      setEventDirty(JSON.stringify(next) !== JSON.stringify(runtime.events[next.id]));
      return next;
    });
    setSaveError(false);
  };

  const saveEvent = useCallback(async () => {
    if (!eventDraft || !eventRevision) return;
    setSaving(true);
    setSaveError(false);
    onStatus("시간 이벤트를 검증하고 저장하는 중…");
    try {
      const result = await invoke<{
        saved: boolean;
        issues: ValidationIssue[];
        runtime?: Runtime;
        document?: ProjectPayload["documents"]["events"][string];
      }>("save_document", {
        root: payload.root,
        kind: "events",
        document: eventDraft,
        revision: eventRevision,
      });
      onIssues(result.issues);
      if (!result.saved || !result.runtime || !result.document) {
        onStatus("시간 이벤트에 오류가 있어 저장하지 않았습니다.");
        setSaveError(true);
        return;
      }
      const nextPayload = clone(payload);
      nextPayload.runtime = result.runtime;
      nextPayload.documents.events[eventDraft.id] = result.document;
      onPayload(nextPayload);
      setEventDraft(clone(result.runtime.events[eventDraft.id]));
      setEventRevision(result.document.revision);
      setEventDirty(false);
      setSavedAt(Date.now());
      localStorage.removeItem(`love-office-event-draft:${payload.root}:${eventDraft.id}`);
      onStatus("시간 이벤트 YAML과 런타임을 저장했습니다.");
    } catch (error) {
      const message = String(error);
      setSaveError(true);
      onStatus(message.includes("REVISION_CONFLICT") ? "외부에서 이벤트 파일이 변경되었습니다. 프로젝트를 다시 여세요." : `이벤트 저장 실패: ${message}`);
    } finally {
      setSaving(false);
    }
  }, [eventDraft, eventRevision, onIssues, onPayload, onStatus, payload]);

  useEffect(() => {
    if (!eventDraft) return;
    onDocumentActivity({
      phase: saving ? "saving" : saveError ? "error" : eventDirty ? "dirty" : "saved",
      label: eventDraft.title,
      path: payload.documents.events[eventDraft.id]?.path || "",
      detail: saving ? "검증 후 디스크에 기록 중"
        : saveError ? "저장 실패 · 마지막 정상 파일은 보존됨"
          : eventDirty ? "자동 저장 대기" : "이벤트 YAML + 런타임 동기화됨",
      savedAt,
    });
  }, [eventDirty, eventDraft, onDocumentActivity, payload.documents.events, saveError, savedAt, saving]);

  useEffect(() => {
    if (!eventDraft) return;
    const key = `love-office-event-draft:${payload.root}:${eventDraft.id}`;
    if (!eventDirty) {
      localStorage.removeItem(key);
      return;
    }
    const timer = window.setTimeout(() => {
      localStorage.setItem(key, JSON.stringify({ revision: eventRevision, event: eventDraft }));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [eventDirty, eventDraft, eventRevision, payload.root]);

  useEffect(() => {
    const preserveDraft = () => {
      if (eventDirty && eventDraft) {
        localStorage.setItem(`love-office-event-draft:${payload.root}:${eventDraft.id}`, JSON.stringify({ revision: eventRevision, event: eventDraft }));
      }
    };
    window.addEventListener("beforeunload", preserveDraft);
    return () => window.removeEventListener("beforeunload", preserveDraft);
  }, [eventDirty, eventDraft, eventRevision, payload.root]);

  useEffect(() => {
    if (!eventDirty || !eventDraft || saving) return;
    const signature = JSON.stringify(eventDraft);
    if (signature === lastAutoSaveAttempt.current) return;
    const timer = window.setTimeout(() => {
      lastAutoSaveAttempt.current = signature;
      void saveEvent();
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [eventDirty, eventDraft, saveEvent, saving]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!active || !(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "s") return;
      event.preventDefault();
      if (eventDirty && !saving) void saveEvent();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, eventDirty, saveEvent, saving]);

  const setTimelineTime = (next: RuntimeState, day: number, slot: TimeSlot) => {
    setPath(next, "progress.time.day", day);
    setPath(next, "progress.time.slot", slot);
    setPath(next, "progress.time.act", campaignAct(campaign, day));
  };

  const applyEventToState = (next: RuntimeState, event: TimelineEvent) => {
    event.on_seen.effects.forEach((effect) => applyEffect(runtime, next, effect));
    if (!next.progress.events.seen.includes(event.id)) next.progress.events.seen.push(event.id);
  };

  const runSelectedEvent = () => {
    if (!selectedEvent) return;
    const eventDay = Math.max(selectedEvent.window.days[0], Math.min(selectedDay, selectedEvent.window.days[1]));
    const eventSlot = selectedEvent.window.slots.includes(selectedSlot) ? selectedSlot : selectedEvent.window.slots[0];
    const check = inspectTimelineEvent(runtime, selectedEvent, state, eventDay, eventSlot);
    if (!check.eligible) {
      onStatus(`사건을 실행할 수 없습니다: ${check.reasons.join(" / ")}`);
      return;
    }
    const next = clone(state);
    setTimelineTime(next, eventDay, eventSlot);
    applyEventToState(next, selectedEvent);
    onState(next);
    setSelectedDay(eventDay);
    setSelectedSlot(eventSlot);
    onStatus(`'${selectedEvent.title}' 사건을 테스트 상태에 적용했습니다.`);
  };

  const runTimeSlot = () => {
    const next = clone(state);
    setTimelineTime(next, selectedDay, selectedSlot);
    let missedCount = 0;
    Object.values(runtime.events).forEach((event) => {
      if (event.campaign_id !== campaignId) return;
      if (next.progress.events.seen.includes(event.id) || next.progress.events.missed.includes(event.id)) return;
      if (selectedDay <= event.window.deadline_day) return;
      event.on_missed.effects.forEach((effect) => applyEffect(runtime, next, effect));
      next.progress.events.missed.push(event.id);
      if (!next.progress.events.expired.includes(event.id)) next.progress.events.expired.push(event.id);
      missedCount += 1;
    });
    if (missedCount > 0) breakPushPullFlow(next);
    const candidates = Object.values(runtime.events)
      .filter((event) => event.campaign_id === campaignId)
      .filter((event) => ["automatic", "hidden"].includes(event.availability))
      .filter((event) => inspectTimelineEvent(runtime, event, next, selectedDay, selectedSlot).eligible)
      .sort((a, b) => b.priority - a.priority);
    const occupied = new Set<string>();
    let automaticCount = 0;
    candidates.forEach((event) => {
      const key = `${event.lane}:${event.exclusive_group || ""}`;
      if (occupied.has(key)) return;
      applyEventToState(next, event);
      occupied.add(key);
      automaticCount += 1;
    });
    onState(next);
    const playerCount = Object.values(runtime.events).filter((event) => event.campaign_id === campaignId && event.availability === "player" && inspectTimelineEvent(runtime, event, next, selectedDay, selectedSlot).eligible).length;
    onStatus(`${selectedDay}일 ${SLOT_LABELS[selectedSlot]} 실행 · 자동 ${automaticCount}개 · 선택 가능 ${playerCount}개 · 만료 ${missedCount}개`);
  };

  const updateHeroine = (section: "visible" | "hidden", key: string, value: number | string) => {
    const next = clone(state);
    const target = next[section].heroines[heroineId] as unknown as Record<string, number | string>;
    target[key] = value;
    onState(next);
  };

  const updateRhythm = (patch: { position?: number; combo?: number; target?: PushPullTarget }) => {
    const next = clone(state);
    writePushPullState(next, { ...readPushPullState(next), ...patch });
    onState(next);
  };

  const toggleProgressValue = (key: "cleared_routes" | "unlocked_modes" | "memories", value: string, checked: boolean) => {
    const next = clone(state);
    const current = next.progress[key];
    next.progress[key] = (checked ? Array.from(new Set([...current, value])) : current.filter((item) => item !== value)) as never;
    onState(next);
  };

  const visible = state.visible.heroines[heroineId];
  const hidden = state.hidden.heroines[heroineId];
  const rhythmState = readPushPullState(state);

  return <div className="timeline-shell">
    <section className="timeline-main">
      <div className="timeline-toolbar">
        <div>
          <p className="eyebrow">CAMPAIGN · ACT {act?.number || 1}</p>
          <h2>{campaign.title}</h2>
          <p>{act?.title} · {act?.purpose}</p>
        </div>
        <div className="timeline-controls">
          <label className="campaign-picker"><span>캠페인</span><select value={campaignId} onChange={(event) => selectCampaign(event.target.value)}>{Object.values(runtime.campaigns).map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>
          <div className="segmented" aria-label="시간표 시점">
            <button type="button" className={mode === "perceived" ? "active" : ""} onClick={() => onMode("perceived")}>주인공 인식</button>
            <button type="button" className={mode === "reality" ? "active" : ""} onClick={() => onMode("reality")}>실제 시간선</button>
          </div>
          <div className="week-stepper">
            <button type="button" onClick={() => setWeek(Math.max(0, week - 1))} disabled={week === 0}>←</button>
            <strong>{week + 1}주차 · {days[0]}~{days[4]}일</strong>
            <button type="button" onClick={() => setWeek(Math.min(2, week + 1))} disabled={week === 2}>→</button>
          </div>
        </div>
      </div>

      <div className="timeline-board" aria-label={`${week + 1}주차 사건 타임보드`}>
        <div className="timeline-header-cell">시간선</div>
        {days.map((day) => <button type="button" key={day} className={day === selectedDay ? "timeline-day active" : "timeline-day"} onClick={() => setSelectedDay(day)}>
          <strong>{day}일</strong><small>{campaign.acts.find((item) => day >= item.days[0] && day <= item.days[1])?.title}</small>
        </button>)}
        {lanes.map((lane) => <div className="timeline-lane" key={lane.id}>
          <div className={`lane-label ${lane.kind}`}><strong>{lane.title}</strong><small>{lane.kind === "truth" ? "클리어 후 공개" : lane.kind === "world" ? "고정 사건" : "인물 스레드"}</small></div>
          {days.map((day) => <div className={day === selectedDay ? "timeline-cell selected" : "timeline-cell"} key={`${lane.id}-${day}`}>
            {eventsForDay(runtime.events, day).filter((event) => event.campaign_id === campaignId && event.lane === lane.id).map((event) => {
              const check = timelineStatus(runtime, event, state, day);
              const presentation = event.presentation[mode];
              return <button
                type="button"
                className={`event-card ${event.type} ${check.status} ${event.id === selectedEventId ? "active" : ""}`}
                key={event.id}
                onClick={() => selectEvent(event.id)}
                onDoubleClick={() => {
                  if (event.scene) {
                    onOpenScene(event.scene);
                  }
                }}
                title={event.scene ? "더블클릭하여 연결 장면 편집" : undefined}
                aria-label={`${presentation.title}, ${STATUS_LABELS[check.status]}`}
              >
                <span>{SLOT_LABELS[event.window.slots[0]]}</span>
                <strong>{presentation.title}</strong>
                <small>{event.window.days[0] === event.window.days[1]
                  ? `${day}일 고정`
                  : `${day}일 · 기회 ${day - event.window.days[0] + 1}/${event.window.days[1] - event.window.days[0] + 1}`} · {STATUS_LABELS[check.status]}</small>
              </button>;
            })}
          </div>)}
        </div>)}
      </div>
    </section>

    <aside className="timeline-inspector">
      <div className="inspector-section time-simulator">
        <div className="inspector-heading"><div><p className="eyebrow">SIMULATOR</p><h3>현재 시각 판정</h3></div><button type="button" onClick={() => onState(campaignInitialState(runtime, campaignId))}>초기화</button></div>
        <div className="time-pickers">
          <label><span>날짜</span><input type="number" min="1" max={campaign.total_days} value={selectedDay} onChange={(event) => setSelectedDay(Math.max(1, Math.min(campaign.total_days, Number(event.target.value))))} /></label>
          <label><span>시간대</span><select value={selectedSlot} onChange={(event) => setSelectedSlot(event.target.value as TimeSlot)}>{campaign.slots.map((slot) => <option value={slot} key={slot}>{SLOT_LABELS[slot]}</option>)}</select></label>
        </div>
        <button type="button" className="primary-button full-button" onClick={runTimeSlot}>이 시간대 실행</button>
        <div className="sim-state-summary"><span>본 사건 {state.progress.events.seen.filter((id) => runtime.events[id]?.campaign_id === campaignId).length}</span><span>놓친 사건 {state.progress.events.missed.filter((id) => runtime.events[id]?.campaign_id === campaignId).length}</span><span>기억 {state.progress.memories.length}</span></div>
      </div>

      <div className="inspector-section heroine-state">
        <div className="inspector-heading"><div><p className="eyebrow">STATE</p><h3>인물 수치</h3></div></div>
        <select value={heroineId} onChange={(event) => setHeroineId(event.target.value)}>{Object.keys(runtime.initial_state.visible.heroines).map((id) => <option value={id} key={id}>{runtime.characters[id]?.display_name || id}</option>)}</select>
        <label><span>밀당 주도권 <strong>{visible.initiative}</strong></span><input type="range" min="0" max="100" value={visible.initiative} onChange={(event) => updateHeroine("visible", "initiative", Number(event.target.value))} /></label>
        <label><span>리듬 위치 <strong>{rhythmState.position}</strong></span><input type="range" min="-100" max="100" value={rhythmState.position} onChange={(event) => updateRhythm({ position: Number(event.target.value) })} /></label>
        <label><span>콤보 <strong>x{rhythmState.combo}</strong></span><input type="range" min="0" max="5" value={rhythmState.combo} onChange={(event) => updateRhythm({ combo: Number(event.target.value) })} /></label>
        <label><span>활성 득점선</span><select value={rhythmState.target} onChange={(event) => updateRhythm({ target: event.target.value as PushPullTarget })}><option value="pull">당기기</option><option value="push">밀기</option><option value="none">첫 방향 대기</option></select></label>
        <label><span>의심도 <strong>{hidden.suspicion}</strong></span><input type="range" min="0" max="100" value={hidden.suspicion} onChange={(event) => updateHeroine("hidden", "suspicion", Number(event.target.value))} /></label>
        <label><span>비호감 <strong>{hidden.dislike}</strong></span><input type="range" min="0" max="100" value={hidden.dislike} onChange={(event) => updateHeroine("hidden", "dislike", Number(event.target.value))} /></label>
        <label><span>물리적 증거 <strong>{hidden.evidence_count}</strong></span><input type="range" min="0" max="10" value={hidden.evidence_count} onChange={(event) => updateHeroine("hidden", "evidence_count", Number(event.target.value))} /></label>
        <details className="progress-state">
          <summary>회차·해금 상태</summary>
          <strong>클리어 루트</strong>
          {Object.values(runtime.routes).map((route) => <label key={route.id}><input type="checkbox" checked={state.progress.cleared_routes.includes(route.id)} onChange={(event) => toggleProgressValue("cleared_routes", route.id, event.target.checked)} />{route.title}</label>)}
          <strong>해금 모드</strong>
          {modeIds.map((id) => <label key={id}><input type="checkbox" checked={state.progress.unlocked_modes.includes(id)} onChange={(event) => toggleProgressValue("unlocked_modes", id, event.target.checked)} />{id}</label>)}
          <strong>회차 기억</strong>
          {memoryIds.map((id) => <label key={id}><input type="checkbox" checked={state.progress.memories.includes(id)} onChange={(event) => toggleProgressValue("memories", id, event.target.checked)} />{id}</label>)}
        </details>
        {visibleTeasers.length > 0 && <div className="mode-teasers"><strong>클리어 후 예고</strong>{visibleTeasers.flatMap((teaser) => teaser.reveals).map((reveal) => <div key={reveal.mode}><span>{reveal.title}</span><small>{reveal.teaser}</small></div>)}</div>}
      </div>

      {eventDraft && <div className="inspector-section event-inspector">
        <div className="inspector-heading"><div><p className="eyebrow">EVENT</p><h3>{eventDraft.title}</h3></div><span className={`verdict ${verdict?.status || ""}`}>{verdict ? STATUS_LABELS[verdict.status] : ""}</span></div>
        {verdict?.reasons.length ? <ul className="blocked-reasons">{verdict.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
        <div className="event-actions">
          <button type="button" className="primary-button" onClick={runSelectedEvent} disabled={!verdict?.eligible}>사건 실행</button>
          {eventDraft.scene && <button type="button" onClick={() => onOpenScene(eventDraft.scene!)}>연결 장면 열기</button>}
          <button type="button" onClick={() => onDuplicateEvent(eventDraft)} disabled={eventDirty || saving}>사건 복제</button>
          <button type="button" onClick={saveEvent} disabled={!eventDirty || saving}>{saving ? "저장 중…" : "지금 저장 ⌘S"}</button>
        </div>
        <label><span>제목</span><input value={eventDraft.title} onChange={(event) => updateEvent((draft) => { draft.title = event.target.value; })} /></label>
        <div className="event-field-grid">
          <label><span>캠페인</span><select value={eventDraft.campaign_id} onChange={(event) => { const nextCampaign = runtime.campaigns[event.target.value]; setCampaignId(nextCampaign.id); updateEvent((draft) => { draft.campaign_id = nextCampaign.id; draft.lane = nextCampaign.lanes[0].id; }); }}>{Object.values(runtime.campaigns).map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>
          <label><span>종류</span><select value={eventDraft.type} onChange={(event) => updateEvent((draft) => { draft.type = event.target.value as TimelineEvent["type"]; })}>{runtime.enums.event_type.map((value) => <option value={value} key={value}>{EVENT_TYPE_LABELS[value as TimelineEvent["type"]] || value}</option>)}</select></label>
          <label><span>레인</span><select value={eventDraft.lane} onChange={(event) => updateEvent((draft) => { draft.lane = event.target.value; })}>{campaign.lanes.map((lane) => <option value={lane.id} key={lane.id}>{lane.title}</option>)}</select></label>
          <label><span>발생 방식</span><select value={eventDraft.availability} onChange={(event) => updateEvent((draft) => { draft.availability = event.target.value as TimelineEvent["availability"]; })}>{runtime.enums.event_availability.map((value) => <option value={value} key={value}>{AVAILABILITY_LABELS[value as TimelineEvent["availability"]] || value}</option>)}</select></label>
          <label><span>소요 시간대</span><input type="number" min="0" value={eventDraft.duration} onChange={(event) => updateEvent((draft) => { draft.duration = Number(event.target.value); })} /></label>
          <label><span>시작일</span><input type="number" min="1" max={campaign.total_days} value={eventDraft.window.days[0]} onChange={(event) => updateEvent((draft) => { draft.window.days[0] = Number(event.target.value); })} /></label>
          <label><span>종료일</span><input type="number" min="1" max={campaign.total_days} value={eventDraft.window.days[1]} onChange={(event) => updateEvent((draft) => { draft.window.days[1] = Number(event.target.value); })} /></label>
          <label><span>마감일</span><input type="number" min="1" max={campaign.total_days} value={eventDraft.window.deadline_day} onChange={(event) => updateEvent((draft) => { draft.window.deadline_day = Number(event.target.value); })} /></label>
          <label><span>우선순위</span><input type="number" value={eventDraft.priority} onChange={(event) => updateEvent((draft) => { draft.priority = Number(event.target.value); })} /></label>
        </div>
        <label><span>장소</span><input placeholder="예: office_desk" value={eventDraft.location || ""} onChange={(event) => updateEvent((draft) => { draft.location = event.target.value || undefined; })} /></label>
        <label><span>연결 장면</span><select value={eventDraft.scene || ""} onChange={(event) => updateEvent((draft) => { draft.scene = event.target.value || undefined; })}><option value="">장면 없음</option>{Object.values(runtime.scenes).map((scene) => <option value={scene.id} key={scene.id}>{scene.title} · {scene.id}</option>)}</select></label>
        <fieldset className="slot-picker"><legend>발생 시간대</legend>{campaign.slots.map((slot) => <label key={slot}><input type="checkbox" checked={eventDraft.window.slots.includes(slot)} onChange={(event) => updateEvent((draft) => { draft.window.slots = event.target.checked ? [...draft.window.slots, slot] : draft.window.slots.filter((item) => item !== slot); })} />{SLOT_LABELS[slot]}</label>)}</fieldset>
        <label><span>선행 사건 ID</span><input value={eventDraft.requires.events.join(", ")} onChange={(event) => updateEvent((draft) => { draft.requires.events = event.target.value.split(",").map((value) => value.trim()).filter(Boolean); })} /></label>
        <details className="event-advanced">
          <summary>연결·진행 고급 설정</summary>
          <div className="event-field-grid">
            <label><span>이벤트 ID</span><input value={eventDraft.id} readOnly /></label>
            <label><span>스레드</span><select value={eventDraft.thread || ""} onChange={(event) => updateEvent((draft) => { draft.thread = event.target.value || undefined; })}><option value="">스레드 없음</option>{Object.values(runtime.threads).filter((thread) => thread.campaign_id === eventDraft.campaign_id).map((thread) => <option value={thread.id} key={thread.id}>{thread.title}</option>)}</select></label>
            <label><span>스레드 순서</span><input type="number" value={eventDraft.sequence || 0} onChange={(event) => updateEvent((draft) => { draft.sequence = Number(event.target.value) || undefined; })} /></label>
            <label><span>독점 그룹</span><input placeholder="같은 그룹 중 하나만 발생" value={eventDraft.exclusive_group || ""} onChange={(event) => updateEvent((draft) => { draft.exclusive_group = event.target.value || undefined; })} /></label>
            <label><span>장면 종료 후</span><select value={eventDraft.completion} onChange={(event) => updateEvent((draft) => { draft.completion = event.target.value as TimelineEvent["completion"]; })}><option value="return_to_timeline">시간표로 복귀</option><option value="honor_scene_exit">장면의 이탈 분기 따름</option></select></label>
            <label><span>놓치면 이어질 사건</span><select value={eventDraft.on_missed.trigger_event || ""} onChange={(event) => updateEvent((draft) => { draft.on_missed.trigger_event = event.target.value || undefined; })}><option value="">연쇄 사건 없음</option>{Object.values(runtime.events).filter((item) => item.campaign_id === eventDraft.campaign_id && item.id !== eventDraft.id).map((item) => <option value={item.id} key={item.id}>{item.title} · {item.id}</option>)}</select></label>
          </div>
          <fieldset className="participant-picker"><legend>참여 인물</legend>{Object.values(runtime.characters).map((character) => <label key={character.id}><input type="checkbox" checked={(eventDraft.participants || []).includes(character.id)} onChange={(event) => updateEvent((draft) => { const participants = draft.participants || []; draft.participants = event.target.checked ? [...participants, character.id] : participants.filter((id) => id !== character.id); })} />{character.display_name}</label>)}</fieldset>
        </details>
        <details><summary>발생 조건 ({eventDraft.requires.conditions.length})</summary><ConditionEditor runtime={runtime} conditions={eventDraft.requires.conditions} onChange={(conditions) => updateEvent((draft) => { draft.requires.conditions = conditions; })} /></details>
        <details><summary>발생 시 효과 ({eventDraft.on_seen.effects.length})</summary><EffectEditor runtime={runtime} effects={eventDraft.on_seen.effects} onChange={(effects) => updateEvent((draft) => { draft.on_seen.effects = effects; })} /></details>
        <details><summary>놓쳤을 때 효과 ({eventDraft.on_missed.effects.length})</summary><EffectEditor runtime={runtime} effects={eventDraft.on_missed.effects} onChange={(effects) => updateEvent((draft) => { draft.on_missed.effects = effects; })} /></details>
        <fieldset className="dual-event-copy"><legend>두 시점의 일정 카드</legend>
          <label><span>주인공 제목</span><input value={eventDraft.presentation.perceived.title} onChange={(event) => updateEvent((draft) => { draft.presentation.perceived.title = event.target.value; })} /></label>
          <label><span>주인공 해석</span><textarea rows={2} value={eventDraft.presentation.perceived.summary} onChange={(event) => updateEvent((draft) => { draft.presentation.perceived.summary = event.target.value; })} /></label>
          <label><span>실제 제목</span><input value={eventDraft.presentation.reality.title} onChange={(event) => updateEvent((draft) => { draft.presentation.reality.title = event.target.value; })} /></label>
          <label><span>실제 사건</span><textarea rows={2} value={eventDraft.presentation.reality.summary} onChange={(event) => updateEvent((draft) => { draft.presentation.reality.summary = event.target.value; })} /></label>
        </fieldset>
        <small className="document-path">{payload.documents.events[eventDraft.id]?.path}</small>
      </div>}
    </aside>
  </div>;
}
