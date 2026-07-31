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
import { resolveDialogueNode } from "../storyLogic";
import type { Runtime, StoryNode, TimelineEvent, TimeSlot, ViewMode } from "../types";
import {
  advanceToNextMoment,
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

const WEEKDAY_KEYS = [
  "weekday.wed",
  "weekday.thu",
  "weekday.fri",
  "weekday.sat",
  "weekday.sun",
  "weekday.mon",
  "weekday.tue",
] as const;

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
  onBack,
  i18n,
}: {
  onStart: (mode: ViewMode) => void;
  onBack: () => void;
  i18n: GameLocalizer;
}) {
  const profile = readProfile();
  const truthUnlocked = profile.unlockedModes.includes("truth_view");
  return <main className="vn-route-screen">
    <header>
      <button type="button" onClick={onBack}>{i18n.ui("newGame.back")}</button>
      <div><span>{i18n.ui("newGame.label")}</span><h1>{i18n.ui("newGame.heading")}</h1><p>{i18n.ui("newGame.copy")}</p></div>
    </header>
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
      <section className="vn-mode-card survivor locked" aria-disabled="true">
        <i>♡</i><span>{i18n.ui("mode.survivor.label")}</span><h2>{i18n.ui("mode.survivor.title")}</h2><strong>{i18n.ui("mode.survivor.strong")}</strong>
        <p>{i18n.ui("mode.survivor.copy")}</p><em>{i18n.ui("mode.coming")}</em>
      </section>
    </div>
  </main>;
}

function deadlineLabel(i18n: GameLocalizer, event: TimelineEvent, day: number): string {
  const remaining = event.window.deadline_day - day;
  if (remaining <= 0) return i18n.ui("deadline.today");
  if (remaining === 1) return i18n.ui("deadline.tomorrow");
  return i18n.ui("deadline.days", { count: remaining });
}

function heroineForEvent(event: TimelineEvent): string | undefined {
  if (event.scene) {
    const route = runtime.routes[runtime.scenes[event.scene]?.route];
    if (route?.heroine) return route.heroine;
  }
  return (event.participants || []).find((id) => Boolean(runtime.initial_state.visible.heroines[id]));
}

function TimelineHud({
  session,
  onMode,
  onMenu,
  i18n,
}: {
  session: PlayerSession;
  onMode: () => void;
  onMenu: () => void;
  i18n: GameLocalizer;
}) {
  const rhythm = readPushPullState(session.state);
  const targetFromStory = session.state.progress.flags.story_mode;
  const targetId = targetFromStory && typeof targetFromStory === "object" && !Array.isArray(targetFromStory)
    ? String((targetFromStory as Record<string, unknown>).target || "")
    : "";
  const heroineId = rhythm.heroine || (targetId !== "none" ? targetId : "");
  const initiative = session.state.visible.heroines[heroineId]?.initiative ?? 0;
  const reality = session.mode === "reality";
  return <header className="vn-timeline-hud">
    <div><span>{i18n.ui(reality ? "hud.original" : "hud.story")}</span><strong>{i18n.ui("app.shortTitle")}</strong></div>
    {heroineId && <div className="vn-timeline-score"><span>{i18n.ui(reality ? "hud.control" : "hud.initiative")}</span><strong>{initiative}</strong><i><b style={{ width: `${initiative}%` }} /></i></div>}
    {rhythm.combo > 0 && <div className="vn-timeline-combo"><span>{i18n.ui(reality ? "hud.controlCombo" : "hud.combo")}</span><strong>×{rhythm.combo}</strong></div>}
    <button type="button" className="vn-mode-button" onClick={onMode}><span>{i18n.ui(reality ? "hud.original" : "hud.story")}</span><small>{i18n.ui(reality ? "hud.reality" : "hud.subjective")}</small></button>
    <button type="button" className="vn-menu-button" onClick={onMenu} aria-label={i18n.ui("hud.gameMenu")}>☰</button>
  </header>;
}

function TimelineScreen({
  session,
  onSelect,
  onAdvance,
  onMode,
  onMenu,
  i18n,
}: {
  session: PlayerSession;
  onSelect: (eventId: string) => void;
  onAdvance: () => void;
  onMode: () => void;
  onMenu: () => void;
  i18n: GameLocalizer;
}) {
  const campaign = runtime.campaigns[session.campaignId] || Object.values(runtime.campaigns)[0];
  const { day, slot } = session.state.progress.time;
  const act = campaign?.acts.find((candidate) => day >= candidate.days[0] && day <= candidate.days[1]);
  const events = availableTimelineEvents(runtime, session);
  const rhythm = readPushPullState(session.state);
  const logs = session.timelineLog
    .filter((entry) => entry.day === day && entry.slot === slot)
    .filter((entry) => session.mode === "reality" || entry.availability !== "hidden")
    .map((entry) => ({ entry, event: runtime.events[entry.eventId] }))
    .filter((item) => Boolean(item.event));
  const weekday = i18n.ui(WEEKDAY_KEYS[(day - 1) % WEEKDAY_KEYS.length]);
  const timelineBackground = assetUrl(slot === "morning"
    ? "assets/backgrounds/office-pantry-morning.png"
    : slot === "lunch"
      ? "assets/backgrounds/glass-meeting-room-afternoon.png"
      : "assets/backgrounds/open-office-late-afternoon.png");
  return <main className={`vn-timeline ${session.mode}`} style={{ "--timeline-bg": `url("${timelineBackground}")` } as CSSProperties}>
    <TimelineHud session={session} onMode={onMode} onMenu={onMenu} i18n={i18n} />
    <div className="vn-timeline-shade" />
    <section className="vn-calendar-panel">
      <div className="vn-date-block"><span>DAY</span><strong>{String(day).padStart(2, "0")}</strong><div><b>{weekday}</b><small>{slotLabel(i18n, slot)}</small></div></div>
      <div className="vn-act-copy"><span>ACT {act?.number || 1} · {act ? i18n.story(`campaign.${campaign.id}.acts.${act.id}.title`, act.title) : ""}</span><h1>{campaign ? i18n.story(`campaign.${campaign.id}.title`, campaign.title) : ""}</h1><p>{act ? i18n.story(`campaign.${campaign.id}.acts.${act.id}.purpose`, act.purpose) : ""}</p></div>
      <div className="vn-day-track" aria-label={i18n.ui("timeline.dayProgress", { day })}>
        {Array.from({ length: campaign?.total_days || 17 }, (_, index) => <i className={index + 1 < day ? "past" : index + 1 === day ? "current" : ""} key={index} />)}
      </div>
    </section>

    <section className="vn-time-events" aria-live="polite">
      <header><span>{i18n.ui(session.mode === "reality" ? "timeline.actual" : "timeline.todayScenes")}</span><strong>{slotLabel(i18n, slot)}</strong></header>
      <div className="vn-event-log">
        {logs.map(({ entry, event }) => {
          const presentation = eventPresentation(i18n, event, session.mode);
          return <article className={`${entry.status} ${event.availability}`} key={entry.id}>
            <span>{i18n.ui(entry.status === "missed" ? "timeline.pastChance" : event.availability === "hidden" ? "timeline.hiddenNow" : "timeline.record")}</span>
            <h2>{presentation.title}</h2><p>{presentation.summary}</p>
          </article>;
        })}
        {!logs.length && <article className="quiet"><span>{i18n.ui("timeline.quiet")}</span><h2>{i18n.ui("timeline.quietTitle")}</h2><p>{i18n.ui(session.mode === "reality" ? "timeline.quietReality" : "timeline.quietStory")}</p></article>}
      </div>
    </section>

    <section className="vn-event-choices">
      <div className="vn-event-heading"><div><span>{i18n.ui("timeline.available")}</span><h2>{i18n.ui(events.length ? "timeline.choose" : "timeline.schedule")}</h2></div><small>{i18n.ui(events.length ? "timeline.chooseHelp" : "timeline.scheduleHelp")}</small></div>
      <div className="vn-event-card-grid">
        {events.map((event, index) => {
          const presentation = eventPresentation(i18n, event, session.mode);
          const heroineId = heroineForEvent(event);
          const willBreak = rhythm.combo > 0 && rhythm.heroine && heroineId && rhythm.heroine !== heroineId;
          return <button type="button" className={`vn-event-card ${willBreak ? "will-break" : ""}`} onClick={() => onSelect(event.id)} key={event.id}>
            <span>0{index + 1}</span><div><small>{deadlineLabel(i18n, event, day)}</small><strong>{presentation.title}</strong><p>{presentation.summary}</p></div><i>♥</i>
          </button>;
        })}
        <button type="button" className="vn-pass-time" onClick={onAdvance}><span>{i18n.ui("timeline.time")}</span><div><strong>{i18n.ui(events.length ? "timeline.pass" : "timeline.next")}</strong><small>{slot === "after_work" ? i18n.ui("timeline.finishDay") : i18n.ui("timeline.moveNext", { slot: slotLabel(i18n, campaign?.slots[(campaign?.slots.indexOf(slot) ?? 0) + 1] || "morning") })}</small></div><i>→</i></button>
      </div>
      {rhythm.combo > 0 && events.some((event) => {
        const heroineId = heroineForEvent(event);
        return Boolean(rhythm.heroine && heroineId && rhythm.heroine !== heroineId);
      }) && <p className="vn-combo-preview">{i18n.ui("timeline.comboPreview", { combo: rhythm.combo })}</p>}
    </section>
  </main>;
}

function RhythmGauge({ session, i18n }: { session: PlayerSession; i18n: GameLocalizer }) {
  const value = readPushPullState(session.state);
  const marker = (value.position + 100) / 2;
  const target = value.target === "pull" ? 34 : value.target === "push" ? 66 : 50;
  const reality = session.mode === "reality";
  return <div className="vn-rhythm" aria-label={pushPullPositionLabel(value.position, session.mode)}>
    <div className="vn-rhythm-labels"><span>{i18n.ui(reality ? "rhythm.approach" : "rhythm.pull")}</span><b>{pushPullPositionLabel(value.position, session.mode)}</b><span>{i18n.ui(reality ? "rhythm.space" : "rhythm.push")}</span></div>
    <div className="vn-rhythm-track">
      <i className="optimal" />
      <i className="checkpoint left" /><i className="checkpoint right" />
      <i className="target" style={{ left: `${target}%`, opacity: value.target === "none" ? 0 : 1 }} />
      <b style={{ left: `${marker}%` }} />
    </div>
    <small>{i18n.ui("rhythm.next", { target: pushPullTargetLabel(value.target, session.mode) })}</small>
  </div>;
}

function GameHud({ session, onMode, onMenu, i18n }: { session: PlayerSession; onMode: () => void; onMenu: () => void; i18n: GameLocalizer }) {
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
    {!isCommonScene && <div className="vn-stats">
      <div><span>{i18n.ui(reality ? "hud.control" : "hud.initiative")}</span><strong>{heroine?.initiative ?? 0}</strong><small>/ 100</small><i className="vn-initiative-line"><b style={{ width: `${heroine?.initiative ?? 0}%` }} /></i></div>
      {rhythm.combo > 0 && <div className={rhythm.combo >= 3 ? "hot" : ""}><span>{i18n.ui(reality ? "hud.controlCombo" : "hud.combo")}</span><strong>×{rhythm.combo}</strong></div>}
    </div>}
    <button type="button" className="vn-mode-button" onClick={onMode}><span>{i18n.ui(reality ? "hud.original" : "hud.story")}</span><small>{i18n.ui(reality ? "hud.reality" : "hud.subjective")}</small></button>
    <button type="button" className="vn-menu-button" onClick={onMenu} aria-label={i18n.ui("hud.gameMenu")}>☰</button>
    {!isCommonScene && <RhythmGauge session={session} i18n={i18n} />}
  </header>;
}

function Stage({ session, node, i18n }: { session: PlayerSession; node?: StoryNode; i18n: GameLocalizer }) {
  const resolver = useMemo(() => new VisualResolver(runtime), []);
  const stage = resolver.resolveStage(runtime.scenes[session.sceneId], session.nodeId, session.mode, node);
  const background = assetUrl(stage.background?.asset);
  const visibleCharacters = stage.characters.filter((character) => character.character !== "han_do_yoon");
  return <div className="vn-stage">
    {background && <img className="vn-stage-bg" src={background} alt="" />}
    <div className="vn-stage-light" />
    <div className="vn-cast">
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

  const updateSession = useCallback((next: PlayerSession) => {
    setSession(next);
    saveAutosave(next);
  }, [saveAutosave]);

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
    updateSession(advanceSession(runtime, session));
  }, [fullText.length, node?.kind, overlay, revealed, session, uiHidden, updateSession]);

  const choose = useCallback((optionId: string) => {
    if (!session || session.phase !== "scene") return;
    const next = selectOption(runtime, session, optionId);
    setFeedbackVisible(false);
    updateSession(next);
    window.setTimeout(() => setFeedbackVisible(true), settings.reducedMotion ? 0 : 650);
  }, [session, settings.reducedMotion, updateSession]);

  const chooseTimelineEvent = (eventId: string) => {
    if (!session) return;
    updateSession(startTimelineEvent(runtime, session, eventId));
  };

  const moveToNextMoment = () => {
    if (!session) return;
    updateSession(advanceToNextMoment(runtime, session));
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
        updateSession(advanceSession(runtime, session));
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [auto, fullText.length, node?.kind, overlay, revealed, session, settings.autoDelay, settings.textSpeed, skip, uiHidden, updateSession]);

  useEffect(() => {
    if (skip && session && session.phase === "scene" && !nodeRead(session)) setSkip(false);
  }, [session?.nodeId, session?.phase, skip]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (overlay) setOverlay(null);
        else if (screen === "game" && session?.phase === "scene") setUiHidden((value) => !value);
        return;
      }
      if (screen !== "game" || overlay || !session) return;
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
  }, [advance, choose, node?.kind, overlay, screen, session]);

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
        const sourceInterpretation = session.mode === "reality"
          ? resolvedLayer?.inner_thought
          : resolvedLayer?.protagonist_interpretation;
        const text = entry.kind === "choice" && entry.optionId
          ? i18n.story(`scenes.${entry.sceneId}.nodes.${entry.nodeId}.options.${entry.optionId}.label`, sourceText)
          : i18n.story(dialogueKey(entry.sceneId, entry.nodeId, resolved?.variantId || entry.variantId, session.mode, "line"), sourceText);
        const interpretation = sourceInterpretation
          ? i18n.story(
            dialogueKey(entry.sceneId, entry.nodeId, resolved?.variantId || entry.variantId, session.mode, session.mode === "reality" ? "inner_thought" : "protagonist_interpretation"),
            sourceInterpretation,
          )
          : undefined;
        const speakerName = entry.speakerId
          ? i18n.characterName(entry.speakerId)
          : entry.kind === "choice" ? i18n.ui("dialogue.choice") : i18n.ui("dialogue.narration");
        return <article className={entry.kind} key={entry.id}><span>{speakerName}</span><p>{text}</p>{interpretation && <small>{interpretation}</small>}</article>;
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

  if (screen === "new-game") return <NewGameScreen onStart={startCampaign} onBack={() => setScreen("title")} i18n={i18n} />;
  if (!session) return <TitleScreen autosave={autosave} onContinue={() => autosave && loadSession(autosave.session)} onNewGame={() => setScreen("new-game")} onLoad={() => setOverlay("load")} onSettings={() => setOverlay("settings")} i18n={i18n} onLocale={(locale) => setSettings((value) => ({ ...value, locale }))} />;

  if (session.phase === "timeline") {
    return <div className={settings.reducedMotion ? "vn-reduced-motion" : ""}>
      <TimelineScreen session={session} onSelect={chooseTimelineEvent} onAdvance={moveToNextMoment} onMode={changeMode} onMenu={() => setOverlay("menu")} i18n={i18n} />
      <nav className="vn-timeline-quick" aria-label={i18n.ui("menu.game")}>
        <button type="button" onClick={() => setOverlay("backlog")}>{i18n.ui("menu.backlog")}</button><button type="button" onClick={() => setOverlay("save")}>{i18n.ui("menu.save")}</button><button type="button" onClick={() => setOverlay("load")}>{i18n.ui("menu.load")}</button><button type="button" onClick={() => setOverlay("settings")}>{i18n.ui("menu.settings")}</button>
      </nav>
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

  const speaker = i18n.characterName(node.speaker);
  const interpretationSource = session.mode === "perceived" ? layer?.protagonist_interpretation : layer?.inner_thought;
  const interpretation = interpretationSource
    ? i18n.story(
      dialogueKey(session.sceneId, node.id, resolvedDialogue?.variantId, session.mode, session.mode === "perceived" ? "protagonist_interpretation" : "inner_thought"),
      interpretationSource,
    )
    : undefined;
  const displayedText = revealed ? fullText : fullText.slice(0, visibleCharacters);
  const options = availableOptions(runtime, session);
  const rhythm = readPushPullState(session.state);
  const feedback = session.lastFeedback;
  const clickStage = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest("button, input")) return;
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

  return <main
    className={`vn-game ${session.mode} ${settings.reducedMotion ? "vn-reduced-motion" : ""} ${uiHidden ? "ui-hidden" : ""}`}
    onClick={clickStage}
    onContextMenu={(event) => { event.preventDefault(); setUiHidden((value) => !value); }}
    onWheel={(event) => { if (event.deltaY < -20 && !overlay) setOverlay("backlog"); }}
  >
    <Stage session={session} node={node} i18n={i18n} />
    <GameHud session={session} onMode={changeMode} onMenu={() => setOverlay("menu")} i18n={i18n} />

    {node.kind === "choice" && !uiHidden && <section className="vn-choices" aria-label={i18n.story(`scenes.${session.sceneId}.nodes.${node.id}.prompt`, node.prompt || "")} onKeyDown={choiceKeyDown}>
      <p>{i18n.story(`scenes.${session.sceneId}.nodes.${node.id}.prompt`, node.prompt || "")}</p>
      {options.map((option, index) => <button type="button" onClick={() => choose(option.id)} key={option.id}>
        <span>{String(index + 1).padStart(2, "0")}</span><strong>{i18n.story(`scenes.${session.sceneId}.nodes.${node.id}.options.${option.id}.label`, option.label)}</strong><i>♥</i>
      </button>)}
    </section>}

    {!uiHidden && <section className={`vn-dialogue ${node.kind === "choice" ? "waiting" : ""}`}>
      <div className="vn-nameplate">{speaker || i18n.ui(node.kind === "dual_narration" ? "dialogue.narration" : "dialogue.choice")}</div>
      {node.kind === "choice" ? <div className="vn-choice-prompt"><span>{i18n.ui("dialogue.choiceLabel")}</span><strong>{i18n.story(`scenes.${session.sceneId}.nodes.${node.id}.prompt`, node.prompt || "")}</strong></div>
        : <><p className="vn-line">{displayedText}<i className={revealed ? "done" : ""} /></p>
          {interpretation && <p className="vn-interpretation"><span>{i18n.ui(session.mode === "perceived" ? "dialogue.interpretation" : "dialogue.reality", { name: i18n.characterName("han_do_yoon") })}</span>{interpretation}</p>}</>}
      {feedback && feedbackVisible && <div className={`vn-feedback ${feedback.kind}`}>
        <strong>{feedback.kind === "turn" ? i18n.ui("feedback.turn") : feedback.kind === "score" ? `${i18n.ui("hud.combo")} ×${feedback.combo}` : i18n.ui(feedback.kind === "literal" ? "feedback.literal" : "feedback.break")}</strong>
        {feedback.gain > 0 && <span>{i18n.ui(session.mode === "reality" ? "feedback.controlGain" : "feedback.gain", { gain: feedback.gain })}</span>}
        <small>{pushPullPositionLabel(rhythm.position, session.mode)}</small>
      </div>}
      <div className="vn-quick-menu">
        <button type="button" onClick={() => setOverlay("backlog")}>{i18n.ui("menu.backlog")}</button>
        <button type="button" className={auto ? "active" : ""} onClick={() => { setAuto((value) => !value); setSkip(false); }}>{i18n.ui("menu.auto")}</button>
        <button type="button" className={skip ? "active" : ""} onClick={() => { setSkip((value) => !value); setAuto(false); }}>{i18n.ui("menu.skip")}</button>
        <button type="button" onClick={() => setOverlay("save")}>{i18n.ui("menu.save")}</button>
        <button type="button" onClick={() => setOverlay("load")}>{i18n.ui("menu.load")}</button>
        <button type="button" onClick={() => setOverlay("settings")}>{i18n.ui("menu.settings")}</button>
        <button type="button" onClick={() => setUiHidden(true)}>{i18n.ui("menu.hide")}</button>
      </div>
    </section>}

    {uiHidden && <button type="button" className="vn-show-ui" onClick={() => setUiHidden(false)}>{i18n.ui("menu.show")}</button>}
    {toast && <div className="vn-toast">{toast}</div>}
    {overlays}
  </main>;
}
