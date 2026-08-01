import {
  applyEffect,
  campaignAct,
  canEnterScene,
  chooseSceneTransition,
  chooseTransition,
  clone,
  conditionsMatch,
  inspectTimelineEvent,
  effectiveSpeaker,
  resolveDialogueNode,
} from "../storyLogic";
import {
  breakPushPullFlow,
  readPushPullState,
  resolvePushPull,
  type PushPullResult,
} from "../pushPull";
import { selfDevelopmentSystem } from "../selfDevelopment";
import {
  nightPhaseCoordinator,
  type NightPhaseActivityResult,
  type NightPhaseSelection,
} from "./nightPhase";
import type {
  ChoiceOption,
  Condition,
  Runtime,
  RuntimeState,
  StoryNode,
  TimelineEvent,
  TimeSlot,
  Transition,
  ViewMode,
} from "../types";

export type BacklogEntry = {
  id: string;
  kind: "dialogue" | "narration" | "choice";
  sceneId: string;
  nodeId: string;
  speakerId?: string;
  optionId?: string;
  variantId?: string;
  modeAtPresentation: ViewMode;
};

export type TimelineLogEntry = {
  id: string;
  eventId: string;
  day: number;
  slot: TimeSlot;
  status: "seen" | "missed";
  availability: TimelineEvent["availability"];
};

export type PlayerSession = {
  version: 4;
  phase: "timeline" | "scene" | "self_development" | "complete";
  campaignId: string;
  routeId: string;
  sceneId: string;
  nodeId: string;
  mode: ViewMode;
  state: RuntimeState;
  backlog: BacklogEntry[];
  choices: Array<{ sceneId: string; nodeId: string; optionId: string }>;
  readNodes: string[];
  timelineLog: TimelineLogEntry[];
  currentEventId?: string;
  preparedTimeKey?: string;
  nightPhase?: NightPhaseSelection | NightPhaseActivityResult;
  lastFeedback?: PushPullResult;
  lastEntryDecision?: {
    sceneId: string;
    allowed: boolean;
    trace: Array<{ condition: Condition; actual: unknown; met: boolean }>;
  };
  endingId?: string;
};

const MAX_AUTOMATIC_NODES = 100;

function readId(sceneId: string, nodeId: string): string {
  return `${sceneId}:${nodeId}`;
}

function firstCampaignId(runtime: Runtime): string {
  return Object.keys(runtime.campaigns)[0] || "main";
}

function finishEnding(runtime: Runtime, session: PlayerSession, endingId: string, grantRouteClear = false): void {
  session.phase = "complete";
  session.endingId = endingId;
  session.currentEventId = undefined;
  if (grantRouteClear && session.routeId && !session.state.progress.cleared_routes.includes(session.routeId)) {
    session.state.progress.cleared_routes.push(session.routeId);
  }
  Object.values(runtime.meta).flatMap((document) => document.unlock_rules || []).forEach((rule) => {
    if (!conditionsMatch(session.state, rule.conditions || [])) return;
    if (!session.state.progress.unlocked_modes.includes(rule.mode)) {
      session.state.progress.unlocked_modes.push(rule.mode);
    }
  });
}

function enterScene(runtime: Runtime, session: PlayerSession, sceneId: string): boolean {
  const scene = runtime.scenes[sceneId];
  if (!scene) {
    finishEnding(runtime, session, `missing-scene:${sceneId}`);
    return false;
  }
  const decision = canEnterScene(runtime, session.state, sceneId);
  session.lastEntryDecision = { sceneId, ...decision };
  if (!decision.allowed) {
    finishEnding(runtime, session, `scene-entry-rejected:${sceneId}`);
    return false;
  }
  session.phase = "scene";
  session.routeId = scene.route;
  session.sceneId = sceneId;
  session.nodeId = scene.start_node;
  return true;
}

function applyTransition(runtime: Runtime, session: PlayerSession, transition?: Transition): void {
  if (!transition) {
    finishEnding(runtime, session, `dead-end:${session.sceneId}:${session.nodeId}`);
  } else if (transition.ending) {
    finishEnding(runtime, session, transition.ending_id || "ending", true);
  } else if (transition.scene) {
    enterScene(runtime, session, transition.scene);
  } else if (transition.node) {
    session.nodeId = transition.node;
  } else {
    finishEnding(runtime, session, `invalid-transition:${session.sceneId}:${session.nodeId}`);
  }
}

/** Consumes nodes that do not require presentation or player input. */
export function settleSession(runtime: Runtime, value: PlayerSession): PlayerSession {
  const session = clone(value);
  selfDevelopmentSystem(runtime).hydrate(session.state);
  for (let index = 0; index < MAX_AUTOMATIC_NODES && session.phase === "scene"; index += 1) {
    const scene = runtime.scenes[session.sceneId];
    const node = scene?.nodes[session.nodeId];
    if (!scene || !node) {
      finishEnding(runtime, session, `missing-node:${session.sceneId}:${session.nodeId}`);
      break;
    }
    if (node.kind === "dual_dialogue" || node.kind === "dual_narration" || node.kind === "choice") {
      break;
    }
    if (node.kind === "effect") {
      (node.effects || []).forEach((effect) => applyEffect(runtime, session.state, effect));
      if (node.next) session.nodeId = node.next;
      else finishEnding(runtime, session, `dead-end:${session.sceneId}:${node.id}`);
      continue;
    }
    if (node.kind === "exit" && session.currentEventId) {
      const event = runtime.events[session.currentEventId];
      if (event?.completion === "return_to_timeline") {
        session.phase = "timeline";
        session.currentEventId = undefined;
        session.lastFeedback = undefined;
        break;
      }
    }
    if (node.kind === "state_gate" || node.kind === "exit") {
      const decision = node.kind === "exit"
        ? chooseSceneTransition(runtime, session.state, node.transitions || [])
        : chooseTransition(session.state, node.transitions || []);
      if (node.kind === "exit" && !decision.chosen) {
        finishEnding(runtime, session, `scene-entry-rejected:${session.sceneId}:${node.id}`);
        break;
      }
      applyTransition(runtime, session, decision.chosen);
    }
  }
  return session;
}

export function createSession(runtime: Runtime, routeId: string, mode: ViewMode = "perceived"): PlayerSession {
  const route = runtime.routes[routeId] || Object.values(runtime.routes)[0];
  if (!route) throw new Error("플레이할 루트가 없습니다.");
  const initial: PlayerSession = {
    version: 4,
    phase: "scene",
    campaignId: firstCampaignId(runtime),
    routeId: route.id,
    sceneId: route.entry_scene,
    nodeId: runtime.scenes[route.entry_scene]?.start_node || "",
    mode,
    state: clone(runtime.initial_state),
    backlog: [],
    choices: [],
    readNodes: [],
    timelineLog: [],
  };
  const entryDecision = canEnterScene(runtime, initial.state, route.entry_scene);
  initial.lastEntryDecision = { sceneId: route.entry_scene, ...entryDecision };
  if (!entryDecision.allowed) {
    finishEnding(runtime, initial, `scene-entry-rejected:${route.entry_scene}`);
    return initial;
  }
  return settleSession(runtime, initial);
}

export function normalizePlayerSession(value: PlayerSession, runtime?: Runtime): PlayerSession {
  const legacy = value as PlayerSession & Partial<Pick<PlayerSession, "phase" | "campaignId" | "timelineLog">> & {
    backlog?: Array<Partial<BacklogEntry> & {
      speaker?: string;
      text?: string;
      interpretation?: string;
      perceivedText?: string;
      realityText?: string;
      perceivedInterpretation?: string;
      realityInterpretation?: string;
    }>;
  };
  const normalized: PlayerSession = {
    ...legacy,
    version: 4,
    phase: legacy.phase || (legacy.endingId ? "complete" : "scene"),
    campaignId: legacy.campaignId || "main",
    timelineLog: legacy.timelineLog || [],
    backlog: (legacy.backlog || []).map((entry) => ({
      id: entry.id || "",
      kind: entry.kind || "narration",
      sceneId: entry.sceneId || "",
      nodeId: entry.nodeId || "",
      ...(entry.speakerId ? { speakerId: entry.speakerId } : {}),
      ...(entry.optionId ? { optionId: entry.optionId } : {}),
      ...(entry.variantId ? { variantId: entry.variantId } : {}),
      modeAtPresentation: entry.modeAtPresentation || legacy.mode || "perceived",
    })),
  };
  if (runtime) selfDevelopmentSystem(runtime).hydrate(normalized.state);
  return normalized;
}

function timeKey(state: RuntimeState): string {
  return `${state.progress.time.day}:${state.progress.time.slot}`;
}

function appendTimelineLog(session: PlayerSession, event: TimelineEvent, status: TimelineLogEntry["status"]): void {
  const key = `${status}:${event.id}`;
  if (session.timelineLog.some((entry) => entry.id === key)) return;
  session.timelineLog.push({
    id: key,
    eventId: event.id,
    day: session.state.progress.time.day,
    slot: session.state.progress.time.slot,
    status,
    availability: event.availability,
  });
}

function markEventSeen(runtime: Runtime, session: PlayerSession, event: TimelineEvent): void {
  event.on_seen.effects.forEach((effect) => applyEffect(runtime, session.state, effect));
  if (!session.state.progress.events.seen.includes(event.id)) {
    session.state.progress.events.seen.push(event.id);
  }
  appendTimelineLog(session, event, "seen");
}

function eventHeroine(runtime: Runtime, event: TimelineEvent): string | undefined {
  if (event.scene) {
    const routeId = runtime.scenes[event.scene]?.route;
    const routeHeroine = routeId ? runtime.routes[routeId]?.heroine : undefined;
    if (routeHeroine) return routeHeroine;
  }
  return (event.participants || []).find((id) => Boolean(runtime.initial_state.visible.heroines[id]));
}

function enterTimelineEvent(runtime: Runtime, session: PlayerSession, event: TimelineEvent): boolean {
  if (event.scene && !canEnterScene(runtime, session.state, event.scene).allowed) return false;
  const currentRhythm = readPushPullState(session.state);
  const nextHeroine = eventHeroine(runtime, event);
  if (currentRhythm.combo > 0 && nextHeroine && currentRhythm.heroine && currentRhythm.heroine !== nextHeroine) {
    breakPushPullFlow(session.state);
  }
  markEventSeen(runtime, session, event);
  if (!event.scene) return true;
  session.currentEventId = event.id;
  return enterScene(runtime, session, event.scene);
}

function automaticCandidates(runtime: Runtime, session: PlayerSession): TimelineEvent[] {
  const { day, slot } = session.state.progress.time;
  return Object.values(runtime.events)
    .filter((event) => event.availability === "automatic" || event.availability === "hidden")
    .filter((event) => inspectTimelineEvent(runtime, event, session.state, day, slot).eligible)
    .filter((event) => !event.scene || canEnterScene(runtime, session.state, event.scene).allowed)
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
}

export function prepareTimeSlot(runtime: Runtime, value: PlayerSession): PlayerSession {
  const session = normalizePlayerSession(clone(value), runtime);
  if (session.phase === "complete" || session.phase === "self_development") return session;
  session.phase = "timeline";
  const campaign = runtime.campaigns[session.campaignId] || Object.values(runtime.campaigns)[0];
  if (!campaign) return session;
  const { day, slot } = session.state.progress.time;
  session.state.progress.time.act = campaignAct(campaign, day);
  const key = timeKey(session.state);
  if (session.preparedTimeKey === key) return session;
  session.preparedTimeKey = key;

  let missedAny = false;
  Object.values(runtime.events).forEach((event) => {
    const events = session.state.progress.events;
    if (events.seen.includes(event.id) || events.missed.includes(event.id)) return;
    if (day <= event.window.deadline_day) return;
    event.on_missed.effects.forEach((effect) => applyEffect(runtime, session.state, effect));
    events.missed.push(event.id);
    if (!events.expired.includes(event.id)) events.expired.push(event.id);
    appendTimelineLog(session, event, "missed");
    missedAny = true;
  });
  if (missedAny) breakPushPullFlow(session.state);

  const occupied = new Set<string>();
  for (const event of automaticCandidates(runtime, session)) {
    const occupancyKey = `${event.lane}:${event.exclusive_group || ""}`;
    if (occupied.has(occupancyKey)) continue;
    occupied.add(occupancyKey);
    if (!enterTimelineEvent(runtime, session, event)) continue;
    if (event.scene) return settleSession(runtime, session);
  }
  return session;
}

export function createCampaignSession(
  runtime: Runtime,
  mode: ViewMode = "perceived",
  carry?: Pick<RuntimeState["progress"], "cleared_routes" | "unlocked_modes" | "memories">,
): PlayerSession {
  const campaignId = firstCampaignId(runtime);
  const state = clone(runtime.initial_state);
  if (carry) {
    state.progress.cleared_routes = [...carry.cleared_routes];
    state.progress.unlocked_modes = [...carry.unlocked_modes];
    state.progress.memories = [...carry.memories];
  }
  return prepareTimeSlot(runtime, {
    version: 4,
    phase: "timeline",
    campaignId,
    routeId: "",
    sceneId: "",
    nodeId: "",
    mode,
    state,
    backlog: [],
    choices: [],
    readNodes: [],
    timelineLog: [],
  });
}

export function availableTimelineEvents(runtime: Runtime, session: PlayerSession): TimelineEvent[] {
  if (session.phase !== "timeline") return [];
  const { day, slot } = session.state.progress.time;
  return Object.values(runtime.events)
    .filter((event) => event.availability === "player")
    .filter((event) => inspectTimelineEvent(runtime, event, session.state, day, slot).eligible)
    .filter((event) => !event.scene || canEnterScene(runtime, session.state, event.scene).allowed)
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
}

export function startTimelineEvent(runtime: Runtime, value: PlayerSession, eventId: string): PlayerSession {
  const session = normalizePlayerSession(clone(value), runtime);
  const event = availableTimelineEvents(runtime, session).find((candidate) => candidate.id === eventId);
  if (!event) return session;
  enterTimelineEvent(runtime, session, event);
  return session.phase === "scene" ? settleSession(runtime, session) : session;
}

export function advanceTimeline(runtime: Runtime, value: PlayerSession): PlayerSession {
  const session = normalizePlayerSession(clone(value), runtime);
  if (session.phase !== "timeline") return session;
  const campaign = runtime.campaigns[session.campaignId] || Object.values(runtime.campaigns)[0];
  if (!campaign) return session;
  const currentSlot = campaign.slots.indexOf(session.state.progress.time.slot);
  const atLastSlot = currentSlot < 0 || currentSlot === campaign.slots.length - 1;
  if (atLastSlot) {
    const coordinator = nightPhaseCoordinator(runtime);
    if (coordinator.shouldStart(session.state)) {
      session.phase = "self_development";
      session.nightPhase = coordinator.start(session.state);
      session.lastFeedback = undefined;
      return session;
    }
    session.state.progress.time.day += 1;
    session.state.progress.time.slot = campaign.slots[0];
  } else {
    session.state.progress.time.slot = campaign.slots[currentSlot + 1];
  }
  session.preparedTimeKey = undefined;
  session.lastFeedback = undefined;
  if (session.state.progress.time.day > campaign.total_days) {
    finishEnding(runtime, session, "campaign.complete");
    return session;
  }
  return prepareTimeSlot(runtime, session);
}

export function advanceToNextMoment(runtime: Runtime, value: PlayerSession): PlayerSession {
  let session = normalizePlayerSession(clone(value), runtime);
  const campaign = runtime.campaigns[session.campaignId] || Object.values(runtime.campaigns)[0];
  const safetyLimit = Math.max(1, (campaign?.total_days || 17) * (campaign?.slots.length || 4) + 1);
  let previousLogCount = session.timelineLog.length;
  for (let index = 0; index < safetyLimit; index += 1) {
    session = advanceTimeline(runtime, session);
    if (session.phase !== "timeline") return session;
    if (availableTimelineEvents(runtime, session).length > 0) return session;
    const visibleNewLog = session.timelineLog.slice(previousLogCount).some((entry) =>
      entry.status === "missed" || session.mode === "reality" || entry.availability !== "hidden");
    if (visibleNewLog) return session;
    previousLogCount = session.timelineLog.length;
  }
  return session;
}

export function currentNode(runtime: Runtime, session: PlayerSession): StoryNode | undefined {
  if (session.phase !== "scene") return undefined;
  return runtime.scenes[session.sceneId]?.nodes[session.nodeId];
}

export function availableOptions(runtime: Runtime, session: PlayerSession): ChoiceOption[] {
  const node = currentNode(runtime, session);
  if (node?.kind !== "choice") return [];
  const eligibility = selfDevelopmentSystem(runtime).eligibility;
  return (node.options || []).filter((option) =>
    conditionsMatch(session.state, option.conditions || [])
      && (!option.self_development
        || eligibility.isEligible(session.state, option.self_development.expression)));
}

function logCurrent(runtime: Runtime, session: PlayerSession): void {
  const node = currentNode(runtime, session);
  if (!node || (node.kind !== "dual_dialogue" && node.kind !== "dual_narration")) return;
  const resolved = resolveDialogueNode(runtime, session.state, node);
  session.backlog.push({
    id: `${readId(session.sceneId, node.id)}:${session.backlog.length}`,
    kind: node.kind === "dual_dialogue" ? "dialogue" : "narration",
    sceneId: session.sceneId,
    nodeId: node.id,
    speakerId: effectiveSpeaker(resolved.node, session.mode),
    variantId: resolved.variantId,
    modeAtPresentation: session.mode,
  });
  const key = readId(session.sceneId, node.id);
  if (!session.readNodes.includes(key)) session.readNodes.push(key);
}

export function advanceSession(runtime: Runtime, value: PlayerSession): PlayerSession {
  const session = clone(value);
  const node = currentNode(runtime, session);
  if (!node || (node.kind !== "dual_dialogue" && node.kind !== "dual_narration")) return session;
  logCurrent(runtime, session);
  if (!node.next) {
    finishEnding(runtime, session, `dead-end:${session.sceneId}:${node.id}`);
    return session;
  }
  session.nodeId = node.next;
  session.lastFeedback = undefined;
  return settleSession(runtime, session);
}

export function selectOption(runtime: Runtime, value: PlayerSession, optionId: string): PlayerSession {
  const session = normalizePlayerSession(clone(value), runtime);
  const node = currentNode(runtime, session);
  const option = availableOptions(runtime, session).find((candidate) => candidate.id === optionId);
  if (!node || node.kind !== "choice" || !option) return session;

  const visibleScoreBonus = option.self_development
    ? selfDevelopmentSystem(runtime).eligibility.scoreBonus(
      session.state,
      option.self_development.expression,
    )
    : 0;
  option.effects.forEach((effect) => applyEffect(runtime, session.state, effect));
  const sceneRoute = runtime.scenes[session.sceneId]?.route;
  const route = runtime.routes[sceneRoute || session.routeId];
  const heroine = route?.heroine;
  if (heroine && session.state.visible.heroines[heroine] && option.push_pull) {
    session.lastFeedback = resolvePushPull(session.state, heroine, option.push_pull, { visibleScoreBonus });
  }
  session.backlog.push({
    id: `${readId(session.sceneId, node.id)}:${session.backlog.length}`,
    kind: "choice",
    sceneId: session.sceneId,
    nodeId: node.id,
    optionId: option.id,
    modeAtPresentation: session.mode,
  });
  session.choices.push({ sceneId: session.sceneId, nodeId: node.id, optionId: option.id });
  const key = readId(session.sceneId, node.id);
  if (!session.readNodes.includes(key)) session.readNodes.push(key);
  session.nodeId = option.next;
  return settleSession(runtime, session);
}

export function selectSelfDevelopmentActivity(
  runtime: Runtime,
  value: PlayerSession,
  activityId: string,
): PlayerSession {
  const session = normalizePlayerSession(clone(value), runtime);
  if (session.phase !== "self_development" || session.nightPhase?.status !== "selecting") return session;
  session.nightPhase = nightPhaseCoordinator(runtime).choose(session.state, activityId);
  return session;
}

export function finishSelfDevelopmentNight(runtime: Runtime, value: PlayerSession): PlayerSession {
  const session = normalizePlayerSession(clone(value), runtime);
  if (session.phase !== "self_development" || session.nightPhase?.status !== "result") return session;
  nightPhaseCoordinator(runtime).finish(session.state);
  session.phase = "timeline";
  session.nightPhase = undefined;
  return advanceTimeline(runtime, session);
}

export function setViewMode(value: PlayerSession, mode: ViewMode): PlayerSession {
  return { ...value, mode };
}

export function nodeRead(session: PlayerSession): boolean {
  return session.readNodes.includes(readId(session.sceneId, session.nodeId));
}
