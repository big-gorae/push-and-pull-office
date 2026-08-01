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
import {
  pushPullPositionLabel,
  pushPullTargetLabel,
  readPushPullState,
} from "../pushPull";
import { VisualResolver } from "../presentation";
import { effectiveSpeaker, resolveDialogueNode } from "../storyLogic";
import type { Runtime, StoryNode, TimelineEvent, TimeSlot, ViewMode } from "../types";
import {
  advanceTimeline,
  advanceSession,
  availableTimelineEvents,
  availableOptions,
  createCampaignSession,
  currentNode,
  nodeRead,
  prepareTimeSlot,
  selectOption,
  setViewMode,
  startTimelineEvent,
  type PlayerSession,
} from "./playerRuntime";
import {
  choiceDebugEffect,
  dayChanged,
  modeUnlocked,
  speakingCharacters,
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
  type ReadableSaveSlot,
  type SaveSlot,
} from "./playerStorage";
import { GameLocalizer, gameLocales, type GameLocale } from "./gameI18n";
import "./web-game.css";

const runtime = runtimeJson as unknown as Runtime;
const assetModules = import.meta.glob([
  "../../assets/backgrounds/*",
  "../../assets/concept-art/*",
  "!../../assets/concept-art/lineup-*",
], {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

type Screen = "title" | "new-game" | "game";
type Overlay = "backlog" | "save" | "load" | "settings" | "menu" | null;

function assetUrl(path?: string): string | undefined {
  if (!path) return undefined;
  return assetModules[`../../${path.replace(/^\.\//, "")}`];
}

function nodeLayer(node: StoryNode | undefined, mode: ViewMode) {
  return node?.[mode];
}

function slotLabel(i18n: GameLocalizer, slot: string): string {
  return i18n.ui(`slot.${slot}` as Parameters<GameLocalizer["ui"]>[0]);
}

function sceneTitle(i18n: GameLocalizer, sceneId: string): string {
  const scene = runtime.scenes[sceneId];
  return scene ? i18n.story(`scenes.${scene.id}.title`, scene.title) : sceneId;
}

function eventPresentation(i18n: GameLocalizer, event: TimelineEvent, mode: ViewMode) {
  const source = event.presentation[mode];
  return {
    title: i18n.story(`events.${event.id}.presentation.${mode}.title`, source.title),
    summary: i18n.story(`events.${event.id}.presentation.${mode}.summary`, source.summary),
  };
}

function choiceTriggerSummary(session: PlayerSession, i18n: GameLocalizer): { speaker: string; line: string } | undefined {
  const entries = [...session.backlog].reverse();
  const entry = entries.find((candidate) => {
    if (candidate.kind !== "dialogue") return false;
    const candidateNode = runtime.scenes[candidate.sceneId]?.nodes[candidate.nodeId];
    if (!candidateNode || (candidateNode.kind !== "dual_dialogue" && candidateNode.kind !== "dual_narration")) return false;
    const resolved = resolveDialogueNode(runtime, session.state, candidateNode, candidate.variantId);
    const speaker = effectiveSpeaker(resolved.node, session.mode);
    return Boolean(speaker && speaker !== "han_do_yoon");
  })
    || entries.find((candidate) => candidate.kind !== "choice");
  if (!entry) return undefined;
  const sourceNode = runtime.scenes[entry.sceneId]?.nodes[entry.nodeId];
  if (!sourceNode || (sourceNode.kind !== "dual_dialogue" && sourceNode.kind !== "dual_narration")) return undefined;
  const resolved = resolveDialogueNode(runtime, session.state, sourceNode, entry.variantId);
  const sourceLayer = resolved.node[session.mode];
  if (!sourceLayer?.line) return undefined;
  return {
    speaker: i18n.characterName(effectiveSpeaker(resolved.node, session.mode)),
    line: i18n.story(dialogueKey(entry.sceneId, entry.nodeId, resolved.variantId, session.mode, "line"), sourceLayer.line),
  };
}

function dialogueKey(sceneId: string, nodeId: string, variantId: string | undefined, mode: ViewMode, field: string): string {
  const variant = variantId && variantId !== "default" ? `.variants.${variantId}` : "";
  return `scenes.${sceneId}.nodes.${nodeId}${variant}.${mode}.${field}`;
}

export function sessionSlot(session: PlayerSession): SaveSlot {
  const node = currentNode(runtime, session);
  const lastTimelineEvent = [...session.timelineLog].reverse().find((entry) => entry.status === "seen");
  const resolved = node && (node.kind === "dual_dialogue" || node.kind === "dual_narration")
    ? resolveDialogueNode(runtime, session.state, node)
    : undefined;
  return {
    schema_version: 3,
    savedAt: Date.now(),
    preview: {
      kind: session.phase === "complete" ? "ending" : session.phase,
      day: session.state.progress.time.day,
      slot: session.state.progress.time.slot,
      eventId: session.currentEventId || lastTimelineEvent?.eventId,
      sceneId: session.sceneId,
      nodeId: session.nodeId,
      variantId: resolved?.variantId,
      mode: session.mode,
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
      line: event ? eventPresentation(i18n, event, preview.mode).title : i18n.ui("save.waiting"),
    };
  }
  if (preview.kind === "ending") {
    return {
      title: preview.endingId || slot.legacy?.sceneTitle || i18n.ui("save.waiting"),
      line: slot.legacy?.line || i18n.ui("save.waiting"),
    };
  }
  let line = node?.prompt || slot.legacy?.line || preview.nodeId || i18n.ui("save.waiting");
  if (node && (node.kind === "dual_dialogue" || node.kind === "dual_narration")) {
    const resolved = resolveDialogueNode(runtime, session.state, node, preview.variantId);
    const layer = nodeLayer(resolved.node, preview.mode);
    if (layer?.line) {
      line = i18n.story(dialogueKey(scene?.id || preview.sceneId || "", node.id, resolved.variantId, preview.mode, "line"), layer.line);
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

function TitleScreen({
  autosave,
  onContinue,
  onNewGame,
  onLoad,
  onSettings,
  i18n,
  onLocale,
}: {
  autosave?: SaveSlot;
  onContinue: () => void;
  onNewGame: () => void;
  onLoad: () => void;
  onSettings: () => void;
  i18n: GameLocalizer;
  onLocale: (locale: GameLocale) => void;
}) {
  return <main className="vn-title">
    <img
      className="vn-title-key-art"
      src="/og.png"
      alt=""
      aria-hidden="true"
    />
    <h1 className="vn-visually-hidden">{i18n.ui("app.title")}</h1>
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
      <p>{i18n.ui("app.subtitle")}</p>
      <nav className="vn-title-menu" aria-label={i18n.ui("menu.main")}>
        <button type="button" data-icon="♥" className={autosave ? "primary" : ""} disabled={!autosave} onClick={onContinue}><span>{i18n.ui("menu.continue")}</span><small>{autosave ? savePreview(autosave, i18n).title : i18n.ui("menu.noSave")}</small></button>
        <button type="button" data-icon="✦" className={!autosave ? "primary" : ""} onClick={onNewGame}><span>{i18n.ui("menu.newGame")}</span></button>
        <button type="button" data-icon="♡" onClick={onLoad}><span>{i18n.ui("menu.load")}</span></button>
        <button type="button" data-icon="⚙" onClick={onSettings}><span>{i18n.ui("menu.settings")}</span></button>
      </nav>
      <footer><span>{i18n.ui("app.brand")}</span><span>{i18n.ui("app.webPlayer")}</span></footer>
    </section>
  </main>;
}

function NewGameScreen({
  onStart,
  onAnother,
  onBack,
  i18n,
}: {
  onStart: (mode: ViewMode) => void;
  onAnother: () => void;
  onBack: () => void;
  i18n: GameLocalizer;
}) {
  const profile = readProfile();
  const truthUnlocked = modeUnlocked(profile, "truth_view");
  const anotherUnlocked = modeUnlocked(profile, "survivor_view");
  return <main className="vn-route-screen">
    <button type="button" className="vn-route-back" onClick={onBack}>{i18n.ui("newGame.back")}</button>
    <div className="vn-mode-grid">
      <button type="button" className="vn-mode-card story" onClick={() => onStart("perceived")}>
        <i>♥</i><span>{i18n.ui("mode.story.label")}</span><h2>{i18n.ui("mode.story.title")}</h2><strong>{i18n.ui("mode.story.strong")}</strong>
        <p>{i18n.ui("mode.story.copy")}</p><em>{i18n.ui("mode.story.action")}</em>
      </button>
      <button type="button" className={`vn-mode-card truth ${truthUnlocked ? "" : "locked"}`} disabled={!truthUnlocked} onClick={() => onStart("reality")}>
        <i>✦</i><span>{i18n.ui("mode.truth.label")}</span><h2>{i18n.ui("mode.truth.title")}</h2><strong>{i18n.ui(truthUnlocked ? "mode.truth.unlocked" : "mode.truth.locked")}</strong>
        <p>{i18n.ui(truthUnlocked ? "mode.truth.copyUnlocked" : "mode.truth.copyLocked")}</p>
        <em>{truthUnlocked ? i18n.ui("mode.truth.action") : i18n.ui("mode.locked")}</em>
      </button>
      <button type="button" className={`vn-mode-card survivor ${anotherUnlocked ? "" : "locked"}`} disabled={!anotherUnlocked} onClick={onAnother}>
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
  onMode,
  onMenu,
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
  onMode: () => void;
  onMenu: () => void;
  i18n: GameLocalizer;
}) {
  const { day, slot } = session.state.progress.time;
  const events = availableTimelineEvents(runtime, session);
  const relevantLogs = session.timelineLog
    .filter((entry) => entry.day === day && entry.slot === slot)
    .filter((entry) => Boolean(runtime.events[entry.eventId]))
    .map((entry) => ({ ...entry, eventHasScene: Boolean(runtime.events[entry.eventId]?.scene) }));
  const pendingLog = visibleTimelineLogs(relevantLogs, acknowledgedLogs, session.mode === "reality")[0];
  const pendingEvent = pendingLog ? runtime.events[pendingLog.eventId] : undefined;
  const background = assetUrl(slot === "morning"
    ? "assets/backgrounds/office-pantry-morning.png"
    : slot === "lunch"
      ? "assets/backgrounds/glass-meeting-room-afternoon.png"
      : "assets/backgrounds/open-office-late-afternoon.png");

  return <main className={`vn-game vn-flow-game ${session.mode}`}>
    <div className="vn-stage">
      {background && <img className="vn-stage-bg" src={background} alt="" />}
      <div className="vn-stage-light" />
      <div className="vn-flow-shade" />
    </div>
    <header className="vn-flow-hud">
      <div><span>DAY {String(day).padStart(2, "0")}</span><strong>{slotLabel(i18n, slot)}</strong></div>
      {debugMode && <button type="button" className="vn-debug-previous" disabled={!canStepBack} onClick={onStepBack}>{i18n.ui("debug.previous")}</button>}
      <button type="button" className="vn-mode-button" onClick={onMode}><span>{i18n.ui(session.mode === "reality" ? "hud.original" : "hud.story")}</span><small>{i18n.ui(session.mode === "reality" ? "hud.reality" : "hud.subjective")}</small></button>
      <button type="button" className="vn-menu-button" onClick={onMenu} aria-label={i18n.ui("hud.gameMenu")}>☰</button>
    </header>

    {pendingEvent && pendingLog && <section className="vn-flow-dialogue">
      <p>{eventPresentation(i18n, pendingEvent, session.mode).summary}</p>
      <button type="button" onClick={() => onAcknowledge(pendingLog.id)}>{i18n.ui("flow.continue")}</button>
      {debugMode && <small>DEBUG · {pendingEvent.id} · {pendingLog.status}</small>}
    </section>}

    {!pendingEvent && events.length > 0 && <section className="vn-flow-choices" aria-label={i18n.ui("flow.choicePrompt")}>
      <div className="vn-choice-context"><span>{i18n.ui("flow.choiceContext")}</span><strong>{i18n.ui("flow.choicePrompt")}</strong></div>
      <div className="vn-flow-option-list">
        {events.map((event, index) => {
          const presentation = eventPresentation(i18n, event, session.mode);
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
    </section>}
  </main>;
}

function RhythmGauge({ session, debugMode, i18n }: { session: PlayerSession; debugMode: boolean; i18n: GameLocalizer }) {
  const value = readPushPullState(session.state);
  const marker = (value.position + 100) / 2;
  const target = value.target === "pull" ? 34 : value.target === "push" ? 66 : 50;
  return <div className="vn-rhythm" aria-label={debugMode ? pushPullPositionLabel(value.position, session.mode) : i18n.ui("rhythm.status")}>
    <div className="vn-rhythm-labels"><span>{i18n.ui("rhythm.approach")}</span><span>{i18n.ui("rhythm.space")}</span></div>
    <div className="vn-rhythm-track">
      <i className="optimal" />
      <i className="checkpoint left" /><i className="checkpoint right" />
      <i className="target" style={{ left: `${target}%`, opacity: debugMode && value.target !== "none" ? 1 : 0 }} />
      <b style={{ left: `${marker}%` }} />
    </div>
    {debugMode && <small>DEBUG · {i18n.ui("rhythm.next", { target: pushPullTargetLabel(value.target, session.mode) })}</small>}
  </div>;
}

function GameHud({ session, debugMode, onMode, onMenu, i18n }: { session: PlayerSession; debugMode: boolean; onMode: () => void; onMenu: () => void; i18n: GameLocalizer }) {
  const scene = runtime.scenes[session.sceneId];
  const route = runtime.routes[session.routeId];
  const heroine = session.state.visible.heroines[route?.heroine];
  const rhythm = readPushPullState(session.state);
  const reality = session.mode === "reality";
  const isCommonScene = scene?.id.startsWith("common.") ?? false;
  return <header className="vn-game-hud">
    <div className="vn-day">
      <span>DAY {String(session.state.progress.time.day).padStart(2, "0")}</span>
      <strong>{slotLabel(i18n, session.state.progress.time.slot)}</strong>
      <small>{scene ? sceneTitle(i18n, scene.id) : ""}</small>
    </div>
    {debugMode && !isCommonScene && <div className="vn-stats">
      <div><span>{i18n.ui(reality ? "hud.control" : "hud.initiative")}</span><strong>{heroine?.initiative ?? 0}</strong><small>/ 100</small><i className="vn-initiative-line"><b style={{ width: `${heroine?.initiative ?? 0}%` }} /></i></div>
      {rhythm.combo > 0 && <div className={rhythm.combo >= 3 ? "hot" : ""}><span>{i18n.ui(reality ? "hud.controlCombo" : "hud.combo")}</span><strong>×{rhythm.combo}</strong></div>}
    </div>}
    <button type="button" className="vn-mode-button" onClick={onMode}><span>{i18n.ui(reality ? "hud.original" : "hud.story")}</span><small>{i18n.ui(reality ? "hud.reality" : "hud.subjective")}</small></button>
    <button type="button" className="vn-menu-button" onClick={onMenu} aria-label={i18n.ui("hud.gameMenu")}>☰</button>
    {debugMode && <div className="vn-debug-badge">DEBUG</div>}
  </header>;
}

function Stage({ session, node, settings, i18n }: { session: PlayerSession; node?: StoryNode; settings: PlayerSettings; i18n: GameLocalizer }) {
  const resolver = useMemo(() => new VisualResolver(runtime), []);
  const stage = resolver.resolveStage(runtime.scenes[session.sceneId], session.nodeId, session.mode, node);
  const background = assetUrl(stage.background?.asset);
  const visibleCharacters = speakingCharacters(stage.characters);
  return <div className="vn-stage">
    {background && <img className="vn-stage-bg" src={background} alt="" />}
    <div className="vn-stage-light" />
    <div className="vn-cast" style={{
      left: `${settings.characterX}vw`,
      bottom: `${14 - settings.characterY}vh`,
      "--vn-character-scale": settings.characterScale / 100,
    } as CSSProperties}>
      {visibleCharacters.map((character, index) => <figure
        className={`vn-character ${character.position} ${character.speaker ? "speaking" : ""}`}
        key={`${character.character}:${character.expression || "default"}`}
        style={{ "--breath-delay": `${index * -1.1}s` } as CSSProperties}
      >
        <img src={assetUrl(character.asset)} alt={i18n.characterName(character.character)} />
      </figure>)}
    </div>
    {node?.kind === "choice" && <div className="vn-choice-vignette" />}
  </div>;
}

function DebugPanel({
  settings,
  canStepBack,
  onSettings,
  onStepBack,
  i18n,
}: {
  settings: PlayerSettings;
  canStepBack: boolean;
  onSettings: (settings: PlayerSettings) => void;
  onStepBack: () => void;
  i18n: GameLocalizer;
}) {
  return <aside className="vn-debug-panel" aria-label={i18n.ui("debug.panel")}>
    <header><span>DEBUG MODE</span><button type="button" disabled={!canStepBack} onClick={onStepBack}>{i18n.ui("debug.previous")}</button></header>
    <label><span>{i18n.ui("debug.positionX")}</span><input type="range" min="-24" max="24" value={settings.characterX} onChange={(event) => onSettings({ ...settings, characterX: Number(event.target.value) })} /><output>{settings.characterX}</output></label>
    <label><span>{i18n.ui("debug.positionY")}</span><input type="range" min="-8" max="24" value={settings.characterY} onChange={(event) => onSettings({ ...settings, characterY: Number(event.target.value) })} /><output>{settings.characterY}</output></label>
    <label><span>{i18n.ui("debug.scale")}</span><input type="range" min="75" max="135" value={settings.characterScale} onChange={(event) => onSettings({ ...settings, characterScale: Number(event.target.value) })} /><output>{settings.characterScale}%</output></label>
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

function SettingsPanel({ value, onChange, i18n }: { value: PlayerSettings; onChange: (value: PlayerSettings) => void; i18n: GameLocalizer }) {
  return <div className="vn-settings">
    <fieldset className="vn-locale-setting">
      <legend>{i18n.ui("locale.label")}</legend>
      <div>{gameLocales(runtime).map((locale) => <button type="button" className={value.locale === locale ? "active" : ""} onClick={() => onChange({ ...value, locale })} key={locale}>{i18n.localeName(locale)}</button>)}</div>
    </fieldset>
    <label><span><strong>{i18n.ui("settings.textSpeed")}</strong><small>{i18n.ui("settings.textSpeedHint")}</small></span><input type="range" min="8" max="55" value={value.textSpeed} onChange={(event) => onChange({ ...value, textSpeed: Number(event.target.value) })} /><output>{value.textSpeed}</output></label>
    <label><span><strong>{i18n.ui("settings.autoDelay")}</strong><small>{i18n.ui("settings.autoDelayHint")}</small></span><input type="range" min="600" max="3500" step="100" value={value.autoDelay} onChange={(event) => onChange({ ...value, autoDelay: Number(event.target.value) })} /><output>{(value.autoDelay / 1000).toFixed(1)}s</output></label>
    <label className="vn-switch"><span><strong>{i18n.ui("settings.reducedMotion")}</strong><small>{i18n.ui("settings.reducedMotionHint")}</small></span><input type="checkbox" checked={value.reducedMotion} onChange={(event) => onChange({ ...value, reducedMotion: event.target.checked })} /><i /></label>
    <label className="vn-switch"><span><strong>{i18n.ui("settings.debugMode")}</strong><small>{i18n.ui("settings.debugModeHint")}</small></span><input type="checkbox" checked={value.debugMode} onChange={(event) => onChange({ ...value, debugMode: event.target.checked })} /><i /></label>
    <button type="button" className="vn-fullscreen" onClick={() => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()}>{i18n.ui("settings.fullscreen")}</button>
  </div>;
}

export default function WebGame() {
  const [screen, setScreen] = useState<Screen>("title");
  const [session, setSession] = useState<PlayerSession>();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [settings, setSettings] = useState(() =>
    readSettings(runtime.localization.supported_locales, runtime.localization.default_locale));
  const [autosave, setAutosave] = useState(() => readAutosave(runtime));
  const [auto, setAuto] = useState(false);
  const [skip, setSkip] = useState(false);
  const [uiHidden, setUiHidden] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [visibleCharacters, setVisibleCharacters] = useState(0);
  const [feedbackVisible, setFeedbackVisible] = useState(false);
  const [toast, setToast] = useState("");
  const [debugHistory, setDebugHistory] = useState<PlayerSession[]>([]);
  const [acknowledgedLogs, setAcknowledgedLogs] = useState<Set<string>>(() => new Set());
  const [dayTransition, setDayTransition] = useState<{ from: number; to: number; next: PlayerSession }>();
  const toastTimer = useRef<number | undefined>(undefined);
  const i18n = useMemo(() => new GameLocalizer(runtime, settings.locale), [settings.locale]);
  const rawNode = session ? currentNode(runtime, session) : undefined;
  const resolvedDialogue = session && rawNode && (rawNode.kind === "dual_dialogue" || rawNode.kind === "dual_narration")
    ? resolveDialogueNode(runtime, session.state, rawNode)
    : undefined;
  const node = resolvedDialogue?.node || rawNode;
  const layer = session ? nodeLayer(node, session.mode) : undefined;
  const fullText = session && node && layer?.line
    ? i18n.story(dialogueKey(session.sceneId, node.id, resolvedDialogue?.variantId, session.mode, "line"), layer.line)
    : "";

  const notify = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 1800);
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
  }, []);

  const startCampaign = (mode: ViewMode) => {
    const profile = readProfile();
    const next = createCampaignSession(runtime, mode, {
      cleared_routes: profile.clearedRoutes,
      unlocked_modes: profile.unlockedModes,
      memories: profile.memories,
    });
    loadSession(next);
    saveAutosave(next);
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
  }, [debugHistory, saveAutosave, settings.debugMode]);

  const changeMode = useCallback(() => {
    if (!session) return;
    const truthUnlocked = session.state.progress.unlocked_modes.includes("truth_view");
    if (session.mode === "perceived" && !truthUnlocked) {
      notify(i18n.ui("unlock.notice"));
      return;
    }
    updateSession(setViewMode(session, session.mode === "perceived" ? "reality" : "perceived"));
  }, [i18n, notify, session, updateSession]);

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
    updateSession(next, true);
    window.setTimeout(() => setFeedbackVisible(true), settings.reducedMotion ? 0 : 650);
  }, [session, settings.reducedMotion, updateSession]);

  const chooseTimelineEvent = (eventId: string) => {
    if (!session) return;
    updateSession(startTimelineEvent(runtime, session, eventId), true);
  };

  const moveToNextMoment = (remember = true) => {
    if (!session) return;
    moveSession(advanceTimeline(runtime, session), remember);
  };

  useEffect(() => {
    document.title = i18n.ui("app.title");
    document.documentElement.lang = i18n.locale;
  }, [i18n]);

  useEffect(() => {
    const showAll = settings.reducedMotion || !fullText;
    setVisibleCharacters(showAll ? fullText.length : 0);
    setRevealed(showAll);
  }, [fullText, session?.nodeId, settings.reducedMotion]);

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
    const pending = visibleTimelineLogs(logs, acknowledgedLogs, session.mode === "reality");
    if (pending.length || availableTimelineEvents(runtime, session).length) return;
    const timer = window.setTimeout(() => {
      moveSession(advanceTimeline(runtime, session));
    }, settings.reducedMotion ? 0 : 90);
    return () => window.clearTimeout(timer);
  }, [acknowledgedLogs, dayTransition, moveSession, overlay, session, settings.reducedMotion]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (overlay) setOverlay(null);
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
        const resolved = sourceNode && (sourceNode.kind === "dual_dialogue" || sourceNode.kind === "dual_narration")
          ? resolveDialogueNode(runtime, session.state, sourceNode, entry.variantId)
          : undefined;
        const resolvedLayer = resolved?.node[session.mode];
        const sourceText = entry.kind === "choice" && entry.optionId
          ? sourceNode?.options?.find((option) => option.id === entry.optionId)?.label || entry.optionId
          : resolvedLayer?.line || entry.nodeId;
        const text = entry.kind === "choice" && entry.optionId
          ? i18n.story(`scenes.${entry.sceneId}.nodes.${entry.nodeId}.options.${entry.optionId}.label`, sourceText)
          : i18n.story(dialogueKey(entry.sceneId, entry.nodeId, resolved?.variantId || entry.variantId, session.mode, "line"), sourceText);
        const backlogSpeakerId = resolved ? effectiveSpeaker(resolved.node, session.mode) : entry.speakerId;
        const speakerName = backlogSpeakerId
          ? i18n.characterName(backlogSpeakerId)
          : entry.kind === "choice" ? i18n.ui("dialogue.choice") : "";
        return <article className={entry.kind} key={entry.id}>{speakerName && <span>{speakerName}</span>}<p>{text}</p></article>;
      })}
        {!session.backlog.length && <p className="vn-empty">{i18n.ui("backlog.empty")}</p>}</div>
    </Modal>}
    {overlay === "save" && <Modal title={i18n.ui("save.title")} onClose={() => setOverlay(null)} i18n={i18n} wide><SaveGrid mode="save" session={session} onLoad={loadSession} onSaved={() => notify(i18n.ui("save.done"))} i18n={i18n} /></Modal>}
    {overlay === "load" && <Modal title={i18n.ui("load.title")} onClose={() => setOverlay(null)} i18n={i18n} wide><SaveGrid mode="load" onLoad={loadSession} onSaved={() => undefined} i18n={i18n} /></Modal>}
    {overlay === "settings" && <Modal title={i18n.ui("settings.title")} onClose={() => setOverlay(null)} i18n={i18n}><SettingsPanel value={settings} onChange={setSettings} i18n={i18n} /></Modal>}
    {overlay === "menu" && <Modal title={i18n.ui("menu.game")} onClose={() => setOverlay(null)} i18n={i18n}>
      <div className="vn-pause-menu">
        <button type="button" onClick={() => setOverlay(null)}>{i18n.ui("menu.resume")}</button>
        <button type="button" onClick={() => setOverlay("backlog")}>{i18n.ui("menu.backlog")}</button>
        <button type="button" onClick={() => setOverlay("save")}>{i18n.ui("save.title")}</button>
        <button type="button" onClick={() => setOverlay("load")}>{i18n.ui("load.title")}</button>
        <button type="button" onClick={() => setOverlay("settings")}>{i18n.ui("settings.title")}</button>
        <button type="button" className="danger" onClick={() => { setOverlay(null); setScreen("title"); setSession(undefined); }}>{i18n.ui("menu.title")}</button>
      </div>
    </Modal>}
  </> : null;

  if (screen === "title") {
    return <div className={settings.reducedMotion ? "vn-reduced-motion" : ""}>
      <TitleScreen autosave={autosave} onContinue={() => autosave && loadSession(autosave.session)} onNewGame={() => setScreen("new-game")} onLoad={() => setOverlay("load")} onSettings={() => setOverlay("settings")} i18n={i18n} onLocale={(locale) => setSettings((value) => ({ ...value, locale }))} />
      {overlay === "load" && <Modal title={i18n.ui("load.title")} onClose={() => setOverlay(null)} i18n={i18n} wide><SaveGrid mode="load" onLoad={loadSession} onSaved={() => undefined} i18n={i18n} /></Modal>}
      {overlay === "settings" && <Modal title={i18n.ui("settings.title")} onClose={() => setOverlay(null)} i18n={i18n}><SettingsPanel value={settings} onChange={setSettings} i18n={i18n} /></Modal>}
    </div>;
  }

  if (screen === "new-game") return <div className={settings.reducedMotion ? "vn-reduced-motion" : ""}>
    <NewGameScreen onStart={startCampaign} onAnother={() => notify(i18n.ui("mode.survivor.notice"))} onBack={() => setScreen("title")} i18n={i18n} />
    {toast && <div className="vn-toast">{toast}</div>}
  </div>;
  if (!session) return <TitleScreen autosave={autosave} onContinue={() => autosave && loadSession(autosave.session)} onNewGame={() => setScreen("new-game")} onLoad={() => setOverlay("load")} onSettings={() => setOverlay("settings")} i18n={i18n} onLocale={(locale) => setSettings((value) => ({ ...value, locale }))} />;

  if (dayTransition) {
    return <div className={settings.reducedMotion ? "vn-reduced-motion" : ""}>
      <DayTransition from={dayTransition.from} to={dayTransition.to} i18n={i18n} />
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
        onMode={changeMode}
        onMenu={() => setOverlay("menu")}
        i18n={i18n}
      />
      {toast && <div className="vn-toast">{toast}</div>}
      {overlays}
    </div>;
  }

  if (session.phase === "complete") {
    const truthUnlocked = session.state.progress.unlocked_modes.includes("truth_view");
    const route = runtime.routes[session.routeId];
    return <main className={`vn-ending-screen ${session.mode}`}>
      <div className="vn-ending-record"><span>{i18n.ui("ending.label")}</span><h1>{route ? i18n.story(`routes.${route.id}.title`, route.title) : i18n.ui("ending.defaultTitle")}</h1><p>{i18n.ui(session.endingId === "campaign.complete" ? "ending.incomplete" : "ending.complete")}</p>
        <div className="vn-ending-meta"><span>{i18n.ui("ending.day", { day: session.state.progress.time.day })}</span><span>{i18n.ui("ending.events", { count: session.state.progress.events.seen.length })}</span><span>{i18n.ui("ending.choices", { count: session.choices.length })}</span></div>
        {truthUnlocked && <section><small>{i18n.ui("ending.newMode")}</small><strong>{i18n.ui("ending.unlocked")}</strong><p>{i18n.ui("ending.unlockedCopy")}</p></section>}
        <div className="vn-ending-actions"><button type="button" onClick={() => setScreen("new-game")}>{i18n.ui("ending.restart")}</button><button type="button" onClick={() => { setScreen("title"); setSession(undefined); }}>{i18n.ui("ending.toTitle")}</button></div>
      </div>
    </main>;
  }

  if (!node) {
    const recovered = prepareTimeSlot(runtime, { ...session, phase: "timeline" });
    return <div className="vn-runtime-error"><h1>{i18n.ui("error.heading")}</h1><button type="button" onClick={() => updateSession(recovered)}>{i18n.ui("error.recover")}</button></div>;
  }

  const speaker = i18n.characterName(effectiveSpeaker(node, session.mode));
  const displayedText = revealed ? fullText : fullText.slice(0, visibleCharacters);
  const options = availableOptions(runtime, session);
  const rhythm = readPushPullState(session.state);
  const feedback = session.lastFeedback;
  const triggerSummary = node.kind === "choice" ? choiceTriggerSummary(session, i18n) : undefined;
  const choiceStimulus = node.kind === "choice"
    ? i18n.story(`scenes.${session.sceneId}.nodes.${node.id}.stimulus`, node.stimulus || triggerSummary?.line || "")
    : "";
  const isCommonScene = runtime.scenes[session.sceneId]?.id.startsWith("common.") ?? false;
  const clickStage = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest("button, input, .vn-debug-panel")) return;
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
    <button type="button" onClick={() => setOverlay("backlog")}>{i18n.ui("menu.backlog")}</button>
    <button type="button" className={auto ? "active" : ""} onClick={() => { setAuto((value) => !value); setSkip(false); }}>{i18n.ui("menu.auto")}</button>
    <button type="button" className={skip ? "active" : ""} onClick={() => { setSkip((value) => !value); setAuto(false); }}>{i18n.ui("menu.skip")}</button>
    <button type="button" onClick={() => setOverlay("save")}>{i18n.ui("menu.save")}</button>
    <button type="button" onClick={() => setOverlay("load")}>{i18n.ui("menu.load")}</button>
    <button type="button" onClick={() => setOverlay("settings")}>{i18n.ui("menu.settings")}</button>
    <button type="button" onClick={() => setUiHidden(true)}>{i18n.ui("menu.hide")}</button>
  </div>;

  return <main
    className={`vn-game ${session.mode} ${settings.reducedMotion ? "vn-reduced-motion" : ""} ${uiHidden ? "ui-hidden" : ""}`}
    onClick={clickStage}
    onContextMenu={(event) => { event.preventDefault(); setUiHidden((value) => !value); }}
    onWheel={(event) => { if (event.deltaY < -20 && !overlay) setOverlay("backlog"); }}
  >
    <Stage session={session} node={node} settings={settings} i18n={i18n} />
    <GameHud session={session} debugMode={settings.debugMode} onMode={changeMode} onMenu={() => setOverlay("menu")} i18n={i18n} />
    {!isCommonScene && <RhythmGauge session={session} debugMode={settings.debugMode} i18n={i18n} />}
    {settings.debugMode && <DebugPanel settings={settings} canStepBack={debugHistory.length > 0} onSettings={setSettings} onStepBack={stepBack} i18n={i18n} />}

    {node.kind === "choice" && !uiHidden && <section className="vn-choices" aria-label={i18n.story(`scenes.${session.sceneId}.nodes.${node.id}.prompt`, node.prompt || "")} onKeyDown={choiceKeyDown}>
      <div className="vn-choice-context"><span>{triggerSummary?.speaker || i18n.ui("flow.choiceContext")}</span><strong>{choiceStimulus}</strong></div>
      <p>{i18n.story(`scenes.${session.sceneId}.nodes.${node.id}.prompt`, node.prompt || "")}</p>
      {options.map((option, index) => {
        const debugEffect = choiceDebugEffect(option);
        const effectKey = debugEffect.action === "approach"
          ? "debug.effectApproach"
          : debugEffect.action === "space" ? "debug.effectSpace" : "debug.effectLiteral";
        return <button type="button" onClick={() => choose(option.id)} key={option.id}>
          <span>{String(index + 1).padStart(2, "0")}</span><strong>{i18n.story(`scenes.${session.sceneId}.nodes.${node.id}.options.${option.id}.label`, option.label)}</strong>
          {settings.debugMode && <em>DEBUG · {i18n.ui(effectKey)} {debugEffect.intensity}</em>}
        </button>;
      })}
      {quickMenu}
    </section>}

    {!uiHidden && node.kind !== "choice" && <section className="vn-dialogue">
      {speaker && <div className="vn-nameplate">{speaker}</div>}
      <p className="vn-line">{displayedText}<i className={revealed ? "done" : ""} /></p>
      {settings.debugMode && feedback && feedbackVisible && <div className={`vn-feedback ${feedback.kind}`}>
        <strong>{feedback.kind === "turn" ? i18n.ui("feedback.turn") : feedback.kind === "score" ? `${i18n.ui("hud.combo")} ×${feedback.combo}` : i18n.ui(feedback.kind === "literal" ? "feedback.literal" : "feedback.break")}</strong>
        {feedback.gain > 0 && <span>{i18n.ui(session.mode === "reality" ? "feedback.controlGain" : "feedback.gain", { gain: feedback.gain })}</span>}
        <small>{pushPullPositionLabel(rhythm.position, session.mode)}</small>
      </div>}
      {quickMenu}
    </section>}

    {uiHidden && <button type="button" className="vn-show-ui" onClick={() => setUiHidden(false)}>{i18n.ui("menu.show")}</button>}
    {toast && <div className="vn-toast">{toast}</div>}
    {overlays}
  </main>;
}
