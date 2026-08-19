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
  type PushPullTarget,
  type PushPullResult,
} from "../pushPull";
import { selfDevelopmentSystem } from "../selfDevelopment";
import {
  nightPhaseCoordinator,
  type NightPhaseActivityResult,
  type NightPhaseIntro,
  type NightPhaseSelection,
} from "./nightPhase";
import {
  campaignInitialState,
  isGameModeId,
  modeDefinition,
  refreshUnlockedModes,
  resolveModeAccess,
  type ModeProfile,
} from "./gameModes";
import type {
  ChoiceOption,
  Condition,
  GameModeId,
  Runtime,
  RuntimeState,
  StoryNode,
  TimelineEvent,
  TimeSlot,
  Transition,
} from "../types";

export type BacklogEntry = {
  id: string;
  kind: "dialogue" | "narration" | "choice";
  sceneId: string;
  nodeId: string;
  speakerId?: string;
  optionId?: string;
  variantId?: string;
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
  version: 6;
  phase: "timeline" | "scene" | "self_development" | "complete";
  gameModeId: GameModeId;
  campaignId: string;
  continuityId: string;
  routeId: string;
  sceneId: string;
  nodeId: string;
  state: RuntimeState;
  backlog: BacklogEntry[];
  choices: Array<{ sceneId: string; nodeId: string; optionId: string }>;
  readNodes: string[];
  timelineLog: TimelineLogEntry[];
  currentEventId?: string;
  preparedTimeKey?: string;
  nightPhase?: NightPhaseIntro | NightPhaseSelection | NightPhaseActivityResult;
  lastFeedback?: PushPullResult;
  lastEntryDecision?: {
    sceneId: string;
    allowed: boolean;
    trace: Array<{ condition: Condition; actual: unknown; met: boolean }>;
  };
  endingId?: string;
};

export type StartGameError =
  | "unknown_mode"
  | "locked"
  | "coming_soon"
  | "missing_campaign"
  | "invalid_entry_event";

export type StartGameResult =
  | { ok: true; session: PlayerSession }
  | { ok: false; code: StartGameError };

export type ChoiceAnalysisHint = {
  direction: PushPullTarget;
  lesson?: string;
};

const MAX_AUTOMATIC_NODES = 100;

function readId(sceneId: string, nodeId: string): string {
  return `${sceneId}:${nodeId}`;
}

function requireCampaign(runtime: Runtime, campaignId: string) {
  const campaign = runtime.campaigns[campaignId];
  if (!campaign) throw new Error(`unknown-campaign:${campaignId}`);
  return campaign;
}

function finishEnding(runtime: Runtime, session: PlayerSession, endingId: string, grantRouteClear = false): void {
  session.phase = "complete";
  session.endingId = endingId;
  session.currentEventId = undefined;
  const route = session.routeId ? runtime.routes[session.routeId] : undefined;
  if (grantRouteClear && route?.final_selectable && !session.state.progress.cleared_routes.includes(session.routeId)) {
    session.state.progress.cleared_routes.push(session.routeId);
  }
  refreshUnlockedModes(runtime, session.state);
}

function enterScene(runtime: Runtime, session: PlayerSession, sceneId: string): boolean {
  const scene = runtime.scenes[sceneId];
  if (!scene) {
    finishEnding(runtime, session, `missing-scene:${sceneId}`);
    return false;
  }
  const route = runtime.routes[scene.route];
  if (!route || route.campaign_id !== session.campaignId) {
    finishEnding(runtime, session, `cross-campaign-scene:${sceneId}`);
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
    if (node.kind === "dialogue" || node.kind === "narration" || node.kind === "silent" || node.kind === "choice") {
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
        if (event.duration === 0) session.preparedTimeKey = undefined;
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

export function createSession(runtime: Runtime, routeId: string): PlayerSession {
  const route = runtime.routes[routeId];
  if (!route) throw new Error("플레이할 루트가 없습니다.");
  const gameModeId: GameModeId = "base";
  const definition = modeDefinition(runtime, gameModeId);
  if (!definition || definition.campaign_id !== route.campaign_id) {
    throw new Error(`route-mode-campaign-mismatch:${routeId}:${gameModeId}`);
  }
  const initial: PlayerSession = {
    version: 6,
    phase: "scene",
    gameModeId,
    campaignId: route.campaign_id,
    continuityId: definition.continuity_id,
    routeId: route.id,
    sceneId: route.entry_scene,
    nodeId: runtime.scenes[route.entry_scene]?.start_node || "",
    state: campaignInitialState(runtime, route.campaign_id),
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

export function normalizePlayerSession(value: unknown, runtime?: Runtime): PlayerSession {
  if (!value || typeof value !== "object") throw new Error("invalid-player-session");
  const legacy = clone(value) as Omit<Partial<PlayerSession>, "version" | "backlog"> & {
    version?: number;
    mode?: "perceived" | "reality";
    viewLayer?: "perceived" | "reality";
    backlog?: Array<Partial<BacklogEntry> & {
      modeAtPresentation?: "perceived" | "reality";
      layerAtPresentation?: "perceived" | "reality";
      speaker?: string;
      text?: string;
      interpretation?: string;
      perceivedText?: string;
      realityText?: string;
      perceivedInterpretation?: string;
      realityInterpretation?: string;
    }>;
  };
  if (typeof legacy.version === "number" && legacy.version > 6) {
    throw new Error(`unsupported-player-session-version:${legacy.version}`);
  }
  const isCurrentVersion = legacy.version === 6;
  const isV5 = legacy.version === 5;
  const isV4 = legacy.version === 4;
  if (isCurrentVersion && !legacy.campaignId) throw new Error("missing-campaign-identity");
  if (isCurrentVersion && !isGameModeId(legacy.gameModeId)) throw new Error(`unknown-game-mode:${String(legacy.gameModeId)}`);
  if (isCurrentVersion && !legacy.continuityId) throw new Error("missing-continuity-identity");
  if (isV4 && !legacy.campaignId) throw new Error("missing-v4-campaign-identity");
  if (isV4 && legacy.mode !== "perceived" && legacy.mode !== "reality") throw new Error("missing-v4-view-layer");
  const campaignId = legacy.campaignId || "main";
  const legacyModeId = (legacy as { gameModeId?: string }).gameModeId;
  const gameModeId: GameModeId = legacyModeId === "survivor_view" ? "survivor_view" : "base";
  const definition = runtime?.game_modes[gameModeId];
  if (runtime && !runtime.campaigns[campaignId]) throw new Error(`unknown-campaign:${campaignId}`);
  if (runtime && !definition) throw new Error(`unknown-game-mode:${gameModeId}`);
  if (definition && definition.campaign_id !== campaignId) {
    throw new Error(`mode-campaign-mismatch:${gameModeId}:${campaignId}`);
  }
  if (definition && legacy.continuityId && legacy.continuityId !== definition.continuity_id) {
    throw new Error(`continuity-mismatch:${gameModeId}:${legacy.continuityId}`);
  }
  if (runtime && legacy.routeId && runtime.routes[legacy.routeId]?.campaign_id !== campaignId) {
    throw new Error(`route-campaign-mismatch:${legacy.routeId}:${campaignId}`);
  }
  if (runtime && legacy.currentEventId && runtime.events[legacy.currentEventId]?.campaign_id !== campaignId) {
    throw new Error(`event-campaign-mismatch:${legacy.currentEventId}:${campaignId}`);
  }
  if (!legacy.state) throw new Error("missing-player-session-state");
  const normalized: PlayerSession = {
    ...(legacy as PlayerSession),
    version: 6,
    phase: legacy.phase || (legacy.endingId ? "complete" : "scene"),
    gameModeId,
    campaignId,
    continuityId: legacy.continuityId || definition?.continuity_id || "main",
    routeId: legacy.routeId || "",
    sceneId: legacy.sceneId || "",
    nodeId: legacy.nodeId || "",
    state: migrateVisibleHeroineFields(legacy.state),
    choices: legacy.choices || [],
    readNodes: legacy.readNodes || [],
    timelineLog: legacy.timelineLog || [],
    backlog: (legacy.backlog || []).map((entry) => ({
      id: entry.id || "",
      kind: entry.kind || "narration",
      sceneId: entry.sceneId || "",
      nodeId: entry.nodeId || "",
      ...(entry.speakerId ? { speakerId: entry.speakerId } : {}),
      ...(entry.optionId ? { optionId: entry.optionId } : {}),
      ...(entry.variantId ? { variantId: entry.variantId } : {}),
    })),
  };
  delete (normalized as PlayerSession & { mode?: string }).mode;
  delete (normalized as PlayerSession & { viewLayer?: string }).viewLayer;
  if (isV5 || isV4) {
    normalized.backlog.forEach((entry) => delete (entry as BacklogEntry & { layerAtPresentation?: string }).layerAtPresentation);
  }
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
    const scene = runtime.scenes[event.scene];
    const routeId = scene?.route;
    const routeHeroine = routeId ? runtime.routes[routeId]?.heroine : undefined;
    const choiceTargets = new Set<string>();
    if (scene) {
      Object.values(scene.nodes).forEach((node) => {
        (node.options || []).forEach((option) => {
          if (!option.push_pull) return;
          const target = option.push_pull.target || routeHeroine;
          if (target) choiceTargets.add(target);
        });
      });
    }
    if (choiceTargets.size > 1) return undefined;
    if (choiceTargets.size === 1) return [...choiceTargets][0];
    if (routeHeroine && scene?.cast.includes(routeHeroine)) return routeHeroine;
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
    .filter((event) => event.campaign_id === session.campaignId)
    .filter((event) => event.availability === "automatic" || event.availability === "hidden")
    .filter((event) => inspectTimelineEvent(runtime, event, session.state, day, slot).eligible)
    .filter((event) => !event.scene || canEnterScene(runtime, session.state, event.scene).allowed)
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
}

export function prepareTimeSlot(runtime: Runtime, value: PlayerSession): PlayerSession {
  const session = normalizePlayerSession(clone(value), runtime);
  if (session.phase === "complete" || session.phase === "self_development") return session;
  session.phase = "timeline";
  const campaign = requireCampaign(runtime, session.campaignId);
  const { day, slot } = session.state.progress.time;
  session.state.progress.time.act = campaignAct(campaign, day);
  const key = timeKey(session.state);
  if (session.preparedTimeKey === key) return session;
  session.preparedTimeKey = key;

  let missedAny = false;
  Object.values(runtime.events)
    .filter((event) => event.campaign_id === session.campaignId)
    .forEach((event) => {
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
  gameModeId: GameModeId,
  carry?: Pick<RuntimeState["progress"], "cleared_routes" | "unlocked_modes" | "memories">,
): PlayerSession {
  const definition = modeDefinition(runtime, gameModeId);
  if (!definition) throw new Error(`unknown-game-mode:${gameModeId}`);
  if (definition.content_status !== "playable") throw new Error(`mode-not-playable:${gameModeId}`);
  if (!definition.campaign_id) throw new Error(`mode-missing-campaign:${gameModeId}`);
  const campaignId = definition.campaign_id;
  const campaign = requireCampaign(runtime, campaignId);
  const state = campaignInitialState(runtime, campaignId);
  if (carry) {
    state.progress.cleared_routes = [...carry.cleared_routes];
    state.progress.unlocked_modes = [...carry.unlocked_modes];
    state.progress.memories = [...carry.memories];
  }
  refreshUnlockedModes(runtime, state);
  const session: PlayerSession = {
    version: 6,
    phase: "timeline",
    gameModeId,
    campaignId,
    continuityId: definition.continuity_id,
    routeId: "",
    sceneId: "",
    nodeId: "",
    state,
    backlog: [],
    choices: [],
    readNodes: [],
    timelineLog: [],
  };
  selfDevelopmentSystem(runtime).hydrate(session.state);
  session.state.progress.time.act = campaignAct(campaign, session.state.progress.time.day);
  const entryEvent = runtime.events[campaign.entry_event_id];
  const { day, slot } = session.state.progress.time;
  if (
    !entryEvent
    || entryEvent.campaign_id !== campaignId
    || entryEvent.availability !== "automatic"
    || !inspectTimelineEvent(runtime, entryEvent, session.state, day, slot).eligible
    || !enterTimelineEvent(runtime, session, entryEvent)
  ) {
    throw new Error(`invalid-entry-event:${campaign.entry_event_id}`);
  }
  session.preparedTimeKey = timeKey(session.state);
  return session.phase === "scene" ? settleSession(runtime, session) : session;
}

export function startGameMode(
  runtime: Runtime,
  profile: ModeProfile,
  gameModeId: GameModeId,
): StartGameResult {
  const definition = modeDefinition(runtime, gameModeId);
  if (!definition) return { ok: false, code: "unknown_mode" };
  const access = resolveModeAccess(runtime, gameModeId, profile);
  if (access === "locked") return { ok: false, code: "locked" };
  if (access === "coming_soon") return { ok: false, code: "coming_soon" };
  if (!definition.campaign_id || !runtime.campaigns[definition.campaign_id]) {
    return { ok: false, code: "missing_campaign" };
  }
  try {
    return {
      ok: true,
      session: createCampaignSession(runtime, gameModeId, {
        cleared_routes: profile.clearedRoutes,
        unlocked_modes: profile.unlockedModes,
        memories: profile.memories,
      }),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("invalid-entry-event:")) {
      return { ok: false, code: "invalid_entry_event" };
    }
    if (error instanceof Error && error.message.includes("campaign")) {
      return { ok: false, code: "missing_campaign" };
    }
    throw error;
  }
}

export function availableTimelineEvents(runtime: Runtime, session: PlayerSession): TimelineEvent[] {
  if (session.phase !== "timeline") return [];
  const { day, slot } = session.state.progress.time;
  return Object.values(runtime.events)
    .filter((event) => event.campaign_id === session.campaignId)
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
  const campaign = requireCampaign(runtime, session.campaignId);
  const currentSlot = campaign.slots.indexOf(session.state.progress.time.slot);
  const atLastSlot = currentSlot < 0 || currentSlot === campaign.slots.length - 1;
  if (atLastSlot) {
    const coordinator = nightPhaseCoordinator(runtime);
    if (campaign.systems.self_development && coordinator.shouldStart(session.state)) {
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
  const campaign = requireCampaign(runtime, session.campaignId);
  const safetyLimit = Math.max(1, campaign.total_days * campaign.slots.length + 1);
  let previousLogCount = session.timelineLog.length;
  if (session.phase === "timeline" && session.preparedTimeKey === undefined) {
    session = prepareTimeSlot(runtime, session);
    if (session.phase !== "timeline") return session;
    if (availableTimelineEvents(runtime, session).length > 0) return session;
  }
  for (let index = 0; index < safetyLimit; index += 1) {
    session = advanceTimeline(runtime, session);
    if (session.phase !== "timeline") return session;
    if (availableTimelineEvents(runtime, session).length > 0) return session;
    const visibleNewLog = session.timelineLog.slice(previousLogCount).some((entry) =>
      entry.status === "missed" || entry.availability !== "hidden");
    if (visibleNewLog) return session;
    previousLogCount = session.timelineLog.length;
  }
  return session;
}

export function currentNode(runtime: Runtime, session: PlayerSession): StoryNode | undefined {
  if (session.phase !== "scene") return undefined;
  return runtime.scenes[session.sceneId]?.nodes[session.nodeId];
}

function migrateVisibleHeroineFields(state: RuntimeState): RuntimeState {
  Object.values(state.visible?.heroines || {}).forEach((heroine) => {
    const legacyHeroine = heroine as typeof heroine & {
      affection?: unknown;
      initiative?: unknown;
      perceived_state?: unknown;
    };
    const currentAffection = Number(legacyHeroine.affection);
    const legacyInitiative = Number(legacyHeroine.initiative);
    legacyHeroine.affection = Number.isFinite(currentAffection)
      ? Math.max(0, Math.min(100, currentAffection))
      : Number.isFinite(legacyInitiative)
        ? Math.max(0, Math.min(100, legacyInitiative))
        : 0;
    delete legacyHeroine.initiative;
    delete legacyHeroine.perceived_state;
  });
  return state;
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

export function consumeChoiceAnalysisHint(
  runtime: Runtime,
  value: PlayerSession,
): { session: PlayerSession; hint: ChoiceAnalysisHint } | undefined {
  const session = normalizePlayerSession(clone(value), runtime);
  const node = currentNode(runtime, session);
  if (node?.kind !== "choice") return undefined;
  const direction = readPushPullState(session.state).target;
  if (!selfDevelopmentSystem(runtime).consumeHint(session.state)) return undefined;
  return { session, hint: { direction, lesson: node.analysis_hints?.[direction] } };
}

function logCurrent(runtime: Runtime, session: PlayerSession): void {
  const node = currentNode(runtime, session);
  if (!node) return;
  const key = readId(session.sceneId, node.id);
  if (node.kind === "silent") {
    if (!session.readNodes.includes(key)) session.readNodes.push(key);
    return;
  }
  if (node.kind !== "dialogue" && node.kind !== "narration") return;
  const resolved = resolveDialogueNode(runtime, session.state, node);
  session.backlog.push({
    id: `${readId(session.sceneId, node.id)}:${session.backlog.length}`,
    kind: node.kind,
    sceneId: session.sceneId,
    nodeId: node.id,
    speakerId: effectiveSpeaker(resolved.node),
    variantId: resolved.variantId,
  });
  if (!session.readNodes.includes(key)) session.readNodes.push(key);
}

export function advanceSession(runtime: Runtime, value: PlayerSession): PlayerSession {
  const session = clone(value);
  const node = currentNode(runtime, session);
  if (!node || (node.kind !== "dialogue" && node.kind !== "narration" && node.kind !== "silent")) return session;
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
  const heroine = option.push_pull?.target || route?.heroine;
  if (heroine && session.state.visible.heroines[heroine] && option.push_pull) {
    session.lastFeedback = resolvePushPull(session.state, heroine, option.push_pull, { visibleScoreBonus });
  }
  session.backlog.push({
    id: `${readId(session.sceneId, node.id)}:${session.backlog.length}`,
    kind: "choice",
    sceneId: session.sceneId,
    nodeId: node.id,
    optionId: option.id,
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

export function beginSelfDevelopmentNight(runtime: Runtime, value: PlayerSession): PlayerSession {
  const session = normalizePlayerSession(clone(value), runtime);
  if (session.phase !== "self_development" || session.nightPhase?.status !== "intro") return session;
  session.nightPhase = nightPhaseCoordinator(runtime).continueIntro(session.state, session.nightPhase);
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

export function nodeRead(session: PlayerSession): boolean {
  return session.readNodes.includes(readId(session.sceneId, session.nodeId));
}
