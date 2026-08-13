import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtworkPosition, Layer, Scene, StoryNode } from "../types";
import {
  deleteSceneDraft,
  deviceId,
  queueSceneChange,
  readDrafts,
  readCatalog,
  readSceneDrafts,
  sceneDraftId,
  writeCatalog,
  writeSceneDraft,
} from "./storage";
import { bundledCatalog, isMacSyncBridge, MOBILE_PROJECT_ID, sceneHash, synchronize } from "./sync";
import {
  addNodeAfter,
  allowsProtagonistArtwork,
  changeDialogueKind,
  cloneScene,
  copyNodeAfter,
  MOBILE_NODE_LABELS,
  moveNode,
  nodePreview,
  removeNode,
} from "./scene";
import {
  CURRENT_BUILD_ID,
  fetchLatestBuildId,
  installBuildWorker,
  reloadUrlForBuild,
  shortBuildId,
} from "./appUpdate";
import type {
  MobileArtworkOption,
  MobileBackgroundOption,
  MobileCatalogSnapshot,
  MobileSpeakerOption,
  StoredSceneDraft,
} from "./types";
import "./mobile-authoring.css";

type InstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Picker =
  | { kind: "artwork"; position: ArtworkPosition }
  | { kind: "background" };

type PersistChain = Map<string, Promise<void>>;

const STATUS_COPY: Record<StoredSceneDraft["status"], string> = {
  editing: "이 폰에 초안 저장",
  queued: "업로드 대기",
  pending: "Mac 반영 대기",
  applied: "반영 완료",
  conflict: "겹친 수정 확인",
  rejected: "검증 확인 필요",
};

const POSITIONS: Array<{ id: ArtworkPosition; label: string }> = [
  { id: "left", label: "왼쪽" },
  { id: "center", label: "가운데" },
  { id: "right", label: "오른쪽" },
];

function effectiveSpeaker(node: StoryNode): string | undefined {
  return node.speaker;
}

function sceneSearchText(scene: Scene, scheduleTitle: string): string {
  return [scene.title, scene.id, scene.purpose, scheduleTitle].join(" ").toLocaleLowerCase();
}

function SceneStatus({ draft }: { draft?: StoredSceneDraft }) {
  return draft ? <span className={`scene-status ${draft.status}`}>{STATUS_COPY[draft.status]}</span> : null;
}

function LayerFields({
  layer,
  speaker,
  onChange,
}: {
  layer: Layer;
  speaker?: MobileSpeakerOption;
  onChange: (layer: Layer) => void;
}) {
  const expressions = speaker?.expressions || [];
  return <div className="mobile-layer-fields">
    <label className="mobile-field wide">
      <span>대사</span>
      <textarea aria-label="대사" rows={5} value={layer.line || ""} onChange={(event) => onChange({ ...layer, line: event.target.value })} />
    </label>
    {speaker && <label className="mobile-field"><span>표정</span><select value={layer.expression || ""} onChange={(event) => onChange({ ...layer, expression: event.target.value || undefined })}>
      <option value="">기본 표정</option>{expressions.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
    </select></label>}
  </div>;
}

function ArtworkPicker({
  scene,
  node,
  options,
  selection,
  onPick,
  onClose,
}: {
  scene: Scene;
  node: StoryNode;
  options: MobileArtworkOption[];
  selection: Extract<Picker, { kind: "artwork" }>;
  onPick: (option?: MobileArtworkOption) => void;
  onClose: () => void;
}) {
  const [character, setCharacter] = useState("");
  const allowed = options.filter((option) => scene.cast.includes(option.characterId))
    .filter((option) => option.characterId !== "han_do_yoon" || allowsProtagonistArtwork(scene, node));
  const characters = [...new Map(allowed.map((option) => [option.characterId, option.characterLabel])).entries()];
  const activeCharacter = character || characters[0]?.[0] || "";
  const visible = allowed.filter((option) => option.characterId === activeCharacter);
  return <div className="mobile-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="mobile-picker" role="dialog" aria-modal="true" aria-label={`${selection.position} 원화 선택`}>
      <header><div><small>CHARACTER ARTWORK</small><h2>{POSITIONS.find((item) => item.id === selection.position)?.label} 원화 변경</h2></div><button type="button" aria-label="원화 선택 닫기" onClick={onClose}>×</button></header>
      <nav>{characters.map(([id, label]) => <button type="button" className={id === activeCharacter ? "active" : ""} onClick={() => setCharacter(id)} key={id}>{label}</button>)}</nav>
      <div className="picker-grid">
        <button type="button" className="picker-card off" onClick={() => onPick(undefined)}><i>OFF</i><strong>이 위치 비우기</strong><small>원화를 표시하지 않음</small></button>
        {visible.map((option) => <button type="button" className="picker-card" onClick={() => onPick(option)} key={`${option.visualId}:${option.id}`}><i>{option.characterLabel.slice(0, 1)}</i><strong>{option.label}</strong><small>{option.characterLabel}</small></button>)}
      </div>
      {!visible.length && <p className="picker-empty">이 장면에서 선택할 수 있는 원화가 없습니다.</p>}
    </section>
  </div>;
}

function BackgroundPicker({ options, current, onPick, onClose }: {
  options: MobileBackgroundOption[];
  current?: Scene["default_background"];
  onPick: (option?: MobileBackgroundOption) => void;
  onClose: () => void;
}) {
  return <div className="mobile-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="mobile-picker background" role="dialog" aria-modal="true" aria-label="씬 기본 배경 선택">
      <header><div><small>SCENE BACKGROUND</small><h2>씬 기본 배경 변경</h2></div><button type="button" aria-label="배경 선택 닫기" onClick={onClose}>×</button></header>
      <div className="picker-grid">
        <button type="button" className={!current ? "picker-card selected" : "picker-card"} onClick={() => onPick(undefined)}><i>AUTO</i><strong>자동 선택</strong><small>장소·시간 규칙</small></button>
        {options.map((option) => <button type="button" className={current?.visual_id === option.visualId && current.variant_id === option.variantId ? "picker-card selected" : "picker-card"} onClick={() => onPick(option)} key={`${option.visualId}:${option.variantId}`}><i>BG</i><strong>{option.title}</strong><small>{option.variantId} · {option.details}</small></button>)}
      </div>
    </section>
  </div>;
}

export default function MobileAuthoringApp() {
  const macBridge = isMacSyncBridge();
  const [catalog, setCatalog] = useState<MobileCatalogSnapshot>();
  const [drafts, setDrafts] = useState<StoredSceneDraft[]>([]);
  const [legacyDraftCount, setLegacyDraftCount] = useState(0);
  const [selectedSceneId, setSelectedSceneId] = useState<string>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updatingApp, setUpdatingApp] = useState(false);
  const [latestBuildId, setLatestBuildId] = useState<string>();
  const [status, setStatus] = useState("오프라인 작업공간을 준비하는 중…");
  const [lastSyncedAt, setLastSyncedAt] = useState<Date>();
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent>();
  const [navOpen, setNavOpen] = useState(false);
  const [nodeQuery, setNodeQuery] = useState("");
  const [sceneQuery, setSceneQuery] = useState("");
  const [reordering, setReordering] = useState(false);
  const [nodeMenu, setNodeMenu] = useState<string>();
  const [mobileEditorOpen, setMobileEditorOpen] = useState(false);
  const [editorMenuOpen, setEditorMenuOpen] = useState(false);
  const [picker, setPicker] = useState<Picker>();
  const [addKind, setAddKind] = useState<"dialogue" | "narration">("dialogue");
  const [clipboard, setClipboard] = useState<StoryNode>();
  const syncingRef = useRef(false);
  const persistChains = useRef<PersistChain>(new Map());
  const listScrollPosition = useRef(0);
  const editorWasOpen = useRef(false);

  const workspace = catalog?.workspace;
  const draftMap = useMemo(() => new Map(drafts.map((draft) => [draft.sceneId, draft])), [drafts]);
  const selectedRecord = selectedSceneId ? workspace?.scenes[selectedSceneId] : undefined;
  const selectedDraft = selectedSceneId ? draftMap.get(selectedSceneId) : undefined;
  const scene = selectedDraft?.nextScene || selectedRecord?.scene;
  const node = selectedNodeId && scene ? scene.nodes[selectedNodeId] : undefined;

  const refreshLocal = useCallback(async (nextCatalog?: MobileCatalogSnapshot) => {
    const resolved = nextCatalog || await readCatalog(MOBILE_PROJECT_ID);
    if (resolved?.workspace) setCatalog(resolved);
    setDrafts(await readSceneDrafts(MOBILE_PROJECT_ID));
    setLegacyDraftCount((await readDrafts(MOBILE_PROJECT_ID)).length);
  }, []);

  const syncNow = useCallback(async (quiet = false) => {
    if (!navigator.onLine || syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    if (!quiet) setStatus(macBridge ? "Mac 원문과 휴대폰 장면을 맞추는 중…" : "변경 내용을 안전하게 동기화하는 중…");
    try {
      const next = await synchronize();
      await refreshLocal(next);
      setOnline(true);
      setLastSyncedAt(new Date());
      setStatus(macBridge ? "Mac 원문과 장면을 동기화했습니다." : "모든 장면 초안이 안전하게 보관되었습니다.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof TypeError || /failed to fetch|network|internet disconnected/i.test(message)) {
        setOnline(false);
        setStatus("오프라인 · 편집 내용은 이 폰에 보관됩니다.");
      } else {
        setStatus(`동기화 대기 · ${message}`);
      }
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [macBridge, refreshLocal]);

  const checkForUpdate = useCallback(async (announce = false) => {
    if (!navigator.onLine) {
      if (announce) setStatus("최신 버전 확인에는 인터넷 연결이 필요합니다.");
      return undefined;
    }
    setCheckingUpdate(true);
    try {
      const nextBuildId = await fetchLatestBuildId();
      setLatestBuildId(nextBuildId);
      if (announce) setStatus(nextBuildId === CURRENT_BUILD_ID ? "이미 최신 버전입니다." : "새 버전을 불러올 수 있습니다.");
      return nextBuildId;
    } catch {
      if (announce) setStatus("최신 버전을 확인하지 못했습니다. 연결 후 다시 시도해 주세요.");
      return undefined;
    } finally {
      setCheckingUpdate(false);
    }
  }, []);

  const applyLatestBuild = useCallback(async () => {
    if (!navigator.onLine || updatingApp) {
      if (!navigator.onLine) setStatus("최신 버전을 불러오려면 인터넷에 연결해 주세요.");
      return;
    }
    setUpdatingApp(true);
    setStatus("휴대폰 초안을 보존하고 최신 버전을 준비하는 중…");
    try {
      await Promise.all([...persistChains.current.values()]);
      const nextBuildId = await fetchLatestBuildId();
      if (nextBuildId === CURRENT_BUILD_ID) {
        setLatestBuildId(nextBuildId);
        setStatus("이미 최신 버전입니다.");
        setUpdatingApp(false);
        return;
      }
      await installBuildWorker(nextBuildId);
      window.location.replace(reloadUrlForBuild(window.location.href, nextBuildId));
    } catch {
      setStatus("새 버전을 불러오지 못했습니다. 초안은 이 폰에 그대로 보관되어 있습니다.");
      setUpdatingApp(false);
    }
  }, [updatingApp]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let snapshot = await readCatalog(MOBILE_PROJECT_ID);
      if (!snapshot?.workspace) {
        snapshot = await bundledCatalog();
        await writeCatalog(snapshot);
      }
      if (cancelled) return;
      await refreshLocal(snapshot);
      setStatus(navigator.onLine ? "온라인 · 최신 장면을 확인합니다." : "오프라인 · 이 폰에 안전하게 저장합니다.");
      if (navigator.onLine) void syncNow(true);
    })();
    return () => { cancelled = true; };
  }, [refreshLocal, syncNow]);

  useEffect(() => {
    if (!workspace || selectedSceneId) return;
    const first = workspace.days.flatMap((day) => day.scenes)[0]?.sceneId || Object.keys(workspace.scenes)[0];
    setSelectedSceneId(first);
  }, [selectedSceneId, workspace]);

  useEffect(() => {
    if (!scene) return;
    if (!selectedNodeId || !scene.nodes[selectedNodeId]) setSelectedNodeId(scene.start_node || scene.node_order[0]);
  }, [scene?.id, scene?.node_order, selectedNodeId]);

  useEffect(() => {
    const manifest = document.createElement("link");
    manifest.rel = "manifest";
    manifest.href = "/authoring.webmanifest";
    const theme = document.createElement("meta");
    theme.name = "theme-color";
    theme.content = "#f6f0e7";
    document.head.append(manifest, theme);
    const originalTitle = document.title;
    document.title = "office";
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register(`/authoring-sw.js?v=${encodeURIComponent(CURRENT_BUILD_ID)}`, { scope: "/", updateViaCache: "none" })
      .then(async (registration) => {
        const ready = await navigator.serviceWorker.ready;
        const urls = performance.getEntriesByType("resource")
          .map((entry) => new URL(entry.name, window.location.href))
          .filter((url) => url.origin === window.location.origin && !url.pathname.startsWith("/api/"))
          .map((url) => url.href);
        (ready.active || registration.active)?.postMessage({ type: "CACHE_ASSETS", urls });
      })
      .catch(() => undefined);
    const onInstall = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPromptEvent); };
    window.addEventListener("beforeinstallprompt", onInstall);
    return () => { manifest.remove(); theme.remove(); document.title = originalTitle; window.removeEventListener("beforeinstallprompt", onInstall); };
  }, []);

  useEffect(() => {
    if (macBridge) return;
    const check = () => document.visibilityState === "visible" && navigator.onLine && void checkForUpdate(false);
    const initial = window.setTimeout(check, 2_000);
    const timer = window.setInterval(check, 5 * 60_000);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [checkForUpdate, macBridge]);

  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      void syncNow();
      if (!macBridge) void checkForUpdate(false);
    };
    const onOffline = () => { setOnline(false); setStatus("오프라인 · 편집 내용은 이 폰에 보관됩니다."); };
    const onVisibility = () => document.visibilityState === "visible" && navigator.onLine && void syncNow(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(() => navigator.onLine && document.visibilityState === "visible" && void syncNow(true), macBridge ? 20_000 : 60_000);
    return () => { window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); document.removeEventListener("visibilitychange", onVisibility); window.clearInterval(timer); };
  }, [checkForUpdate, macBridge, syncNow]);

  useEffect(() => {
    const isPhoneLayout = window.matchMedia("(max-width: 899px)").matches;
    if (!isPhoneLayout) {
      editorWasOpen.current = mobileEditorOpen;
      return;
    }
    if (mobileEditorOpen && !editorWasOpen.current) {
      window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" }));
    } else if (!mobileEditorOpen && editorWasOpen.current) {
      const top = listScrollPosition.current;
      window.requestAnimationFrame(() => {
        window.scrollTo({ top, behavior: "auto" });
        window.requestAnimationFrame(() => window.scrollTo({ top, behavior: "auto" }));
      });
    }
    editorWasOpen.current = mobileEditorOpen;
  }, [mobileEditorOpen]);

  useEffect(() => {
    if (!picker) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [picker]);

  const persistDraft = useCallback((draft: StoredSceneDraft, previous?: StoredSceneDraft) => {
    const prior = persistChains.current.get(draft.sceneId) || Promise.resolve();
    const next = prior.then(async () => {
      if (previous?.eventId) await deleteSceneDraft(previous);
      await writeSceneDraft(draft);
    });
    persistChains.current.set(draft.sceneId, next.catch(() => undefined));
  }, []);

  const commitScene = useCallback((nextScene: Scene) => {
    if (!selectedSceneId || !selectedRecord) return;
    const previous = draftMap.get(selectedSceneId);
    const draft: StoredSceneDraft = {
      id: sceneDraftId(MOBILE_PROJECT_ID, selectedSceneId),
      projectId: MOBILE_PROJECT_ID,
      sceneId: selectedSceneId,
      baseSceneHash: previous?.baseSceneHash || selectedRecord.sceneHash,
      baseScene: previous?.baseScene || cloneScene(selectedRecord.scene),
      nextScene,
      status: "editing",
      updatedAt: new Date().toISOString(),
    };
    setDrafts((current) => [...current.filter((item) => item.sceneId !== selectedSceneId), draft]);
    persistDraft(draft, previous);
    setStatus("입력 내용이 이 폰에 자동 저장되었습니다.");
  }, [draftMap, persistDraft, selectedRecord, selectedSceneId]);

  const mutateScene = useCallback((mutate: (next: Scene) => void) => {
    if (!scene) return;
    const next = cloneScene(scene);
    mutate(next);
    commitScene(next);
  }, [commitScene, scene]);

  const updateNode = (nextNode: StoryNode) => mutateScene((next) => { next.nodes[nextNode.id] = nextNode; });

  const queueSelectedScene = async () => {
    if (!selectedDraft) return;
    await (persistChains.current.get(selectedDraft.sceneId) || Promise.resolve());
    const createdAt = new Date().toISOString();
    await queueSceneChange({
      eventId: crypto.randomUUID(),
      projectId: MOBILE_PROJECT_ID,
      sceneId: selectedDraft.sceneId,
      baseSceneHash: selectedDraft.baseSceneHash,
      nextSceneHash: await sceneHash(selectedDraft.nextScene),
      baseScene: selectedDraft.baseScene,
      nextScene: selectedDraft.nextScene,
      deviceId: await deviceId(),
      clientCreatedAt: createdAt,
    });
    await refreshLocal();
    setStatus(online ? "장면 변경을 저장했습니다 · Mac 반영 대기열로 보냅니다." : "장면 변경을 폰에 저장했습니다 · 연결되면 자동으로 보냅니다.");
    if (online) void syncNow(true);
  };

  const discardScene = async () => {
    if (!selectedDraft) return;
    await deleteSceneDraft(selectedDraft);
    await refreshLocal();
    setStatus("이 장면의 휴대폰 초안을 버리고 현재 원문으로 돌아왔습니다.");
  };

  const scheduled = workspace?.days.flatMap((day) => day.scenes.map((entry) => ({ ...entry, day: day.day }))) || [];
  const filteredDays = workspace?.days.map((day) => ({
    ...day,
    scenes: day.scenes.filter((entry) => {
      const target = workspace.scenes[entry.sceneId]?.scene;
      return target && (!sceneQuery.trim() || sceneSearchText(target, entry.eventTitle).includes(sceneQuery.trim().toLocaleLowerCase()));
    }),
  })).filter((day) => day.scenes.length) || [];
  const visibleNodeIds = scene?.node_order.filter((id) => !nodeQuery.trim() || nodePreview(scene.nodes[id]).toLocaleLowerCase().includes(nodeQuery.trim().toLocaleLowerCase())) || [];
  const pendingCount = drafts.filter((draft) => ["queued", "pending"].includes(draft.status)).length + legacyDraftCount;
  const attentionCount = drafts.filter((draft) => ["conflict", "rejected"].includes(draft.status)).length;
  const updateAvailable = Boolean(latestBuildId && latestBuildId !== CURRENT_BUILD_ID);

  if (!catalog || !workspace) return <main className="mobile-authoring-loading"><span /><p>장면 편집기를 여는 중…</p></main>;

  const chooseSpeaker = (speakerId: string) => {
    if (!node) return;
    const speaker = selectedRecord?.speakers.find((item) => item.id === speakerId);
    let nextNode: StoryNode = { ...node, speaker: speakerId || undefined };
    if (speaker?.illustrated && speakerId !== "han_do_yoon") {
      const artwork = workspace.artworks.find((item) => item.characterId === speakerId);
      if (artwork) {
        const cue = { position: "center" as const, character: speakerId, visual_id: artwork.visualId, artwork: artwork.id };
        nextNode = {
          ...nextNode,
          stage: nextNode.stage === undefined ? [cue] : nextNode.stage,
        };
      }
    }
    updateNode(nextNode);
  };

  const selectArtwork = (option?: MobileArtworkOption) => {
    if (!picker || picker.kind !== "artwork" || !node) return;
    const cues = [...(node.stage || [])].filter((cue) => cue.position !== picker.position);
    const deduplicated = option ? cues.filter((cue) => cue.character !== option.characterId) : cues;
    if (option) deduplicated.push({ position: picker.position, character: option.characterId, visual_id: option.visualId, artwork: option.id });
    updateNode({ ...node, stage: deduplicated });
    setPicker(undefined);
  };

  const openMobileNodeEditor = (nodeId: string) => {
    if (window.matchMedia("(max-width: 899px)").matches) listScrollPosition.current = window.scrollY;
    setSelectedNodeId(nodeId);
    setNodeMenu(undefined);
    setMobileEditorOpen(true);
  };

  return <main className={mobileEditorOpen ? "mobile-authoring-shell editing-node" : "mobile-authoring-shell"}>
    <header className="mobile-authoring-header">
      <button type="button" className="scene-nav-trigger" onClick={() => setNavOpen(true)} aria-label="날짜별 장면 열기">☰</button>
      <div><p>LOVE OFFICE · MOBILE AUTHORING</p><h1>대사 장면 편집기</h1></div>
      <button type="button" className={`connection-pill ${online ? "online" : "offline"}`} onClick={() => void syncNow()} disabled={!online || syncing}><i />{syncing ? "맞추는 중" : online ? "온라인" : "오프라인"}</button>
    </header>

    <section className="sync-summary" aria-live="polite">
      <div><strong>{status}</strong><small>{lastSyncedAt ? `마지막 확인 ${lastSyncedAt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}` : "입력하는 즉시 이 기기에 보관됩니다."}</small></div>
      <span><b>{pendingCount}</b> 반영 대기</span><span className={attentionCount ? "attention" : ""}><b>{attentionCount}</b> 확인</span>
      {installPrompt && !macBridge && <button type="button" onClick={() => void installPrompt.prompt().then(() => installPrompt.userChoice).then(() => setInstallPrompt(undefined))}>홈 화면에 설치</button>}
    </section>

    {updateAvailable && <section className="mobile-update-banner" aria-live="polite">
      <div><strong>새 버전이 있습니다.</strong><small>휴대폰 초안과 이미지 캐시는 그대로 유지됩니다.</small></div>
      <button type="button" onClick={() => void applyLatestBuild()} disabled={updatingApp}>{updatingApp ? "준비 중…" : "최신 버전 불러오기"}</button>
    </section>}

    <div className="mobile-scene-layout">
      {navOpen && <button type="button" className="scene-nav-scrim" aria-label="장면 목록 닫기" onClick={() => setNavOpen(false)} />}
      <aside className={navOpen ? "mobile-scene-nav open" : "mobile-scene-nav"}>
        <header><div><small>STORY FLOW</small><h2>날짜별 장면</h2></div><button type="button" aria-label="장면 목록 닫기" onClick={() => setNavOpen(false)}>×</button></header>
        <label><span>장면 찾기</span><input type="search" value={sceneQuery} onChange={(event) => setSceneQuery(event.target.value)} placeholder="장면 제목으로 검색" /></label>
        <div className="mobile-day-tree">{filteredDays.map((day) => <section key={day.day}><h3>{day.day}일차 <small>{day.scenes.length}개</small></h3>{day.scenes.map((entry) => {
          const target = workspace.scenes[entry.sceneId]?.scene;
          const targetDraft = draftMap.get(entry.sceneId);
          return <button type="button" className={entry.sceneId === selectedSceneId ? "active" : ""} key={`${entry.eventId}:${entry.sceneId}`} onClick={() => { setSelectedSceneId(entry.sceneId); setSelectedNodeId(undefined); setNavOpen(false); setNodeMenu(undefined); setMobileEditorOpen(false); }}><span><strong>{target?.title || entry.eventTitle}</strong><small>{entry.slot}{entry.endDay !== day.day ? ` · ${day.day}~${entry.endDay}일` : ""}</small></span><em>{targetDraft ? "●" : target?.node_order.length || 0}</em></button>})}</section>)}</div>
        <footer className="mobile-version-panel"><button type="button" onClick={() => void checkForUpdate(true)} disabled={!online || checkingUpdate || updatingApp}>{checkingUpdate ? "확인 중…" : "최신 버전 확인"}</button><small>현재 {shortBuildId()}</small></footer>
      </aside>

      <section className="mobile-scene-workspace">
        {scene && selectedRecord ? <>
          <header className="scene-heading">
            <div><button type="button" className="mobile-scene-shortcut" onClick={() => setNavOpen(true)}>{scheduled.find((entry) => entry.sceneId === scene.id)?.day || "–"}일차 · 장면 바꾸기</button><h2>{scene.title}</h2><p>{scene.purpose}</p></div>
            <SceneStatus draft={selectedDraft} />
          </header>
          <div className="scene-toolbar">
            <button type="button" onClick={() => setPicker({ kind: "background" })}><span>씬 배경</span><strong>{scene.default_background ? workspace.backgrounds.find((item) => item.visualId === scene.default_background?.visual_id && item.variantId === scene.default_background?.variant_id)?.title || "직접 선택" : "자동 선택"}</strong></button>
            <button type="button" className={reordering ? "active" : ""} onClick={() => setReordering((value) => !value)}>↕ {reordering ? "순서 편집 끝내기" : "순서 편집"}</button>
          </div>
          <div className="mobile-node-layout">
            <aside className="mobile-node-sequence">
              <label><span>이 장면 대사 검색</span><input type="search" value={nodeQuery} onChange={(event) => setNodeQuery(event.target.value)} placeholder="문장으로 찾기" /></label>
              <div className="add-node-bar"><select aria-label="추가할 종류" value={addKind} onChange={(event) => setAddKind(event.target.value as typeof addKind)}><option value="dialogue">대사</option><option value="narration">나레이션</option></select><button type="button" onClick={() => mutateScene((next) => { const id = addNodeAfter(next, selectedNodeId || next.node_order.at(-1) || "", addKind, selectedRecord.speakers[0]?.id); openMobileNodeEditor(id); })}>＋ 현재 다음에 추가</button></div>
              <div className="mobile-node-list">{visibleNodeIds.map((id) => {
                const item = scene.nodes[id];
                const index = scene.node_order.indexOf(id);
                return <article className={id === selectedNodeId ? "mobile-node-card active" : "mobile-node-card"} key={id}>
                  <button type="button" className="node-card-main" onClick={() => openMobileNodeEditor(id)}><b>{index + 1}</b><span><strong>{nodePreview(item)}</strong><small>{MOBILE_NODE_LABELS[item.kind] || item.kind}</small></span></button>
                  {reordering ? <div className="node-order-actions"><button type="button" disabled={index === 0} onClick={() => mutateScene((next) => { moveNode(next, id, -1); })}>↑ 위로</button><button type="button" disabled={index === scene.node_order.length - 1} onClick={() => mutateScene((next) => { moveNode(next, id, 1); })}>↓ 아래로</button></div> : <button type="button" className="node-more" aria-label={`${index + 1}번 대사 편집 메뉴`} onClick={() => setNodeMenu(nodeMenu === id ? undefined : id)}>•••</button>}
                  {nodeMenu === id && <div className="node-popover"><button type="button" onClick={() => { setClipboard(structuredClone(item)); setNodeMenu(undefined); setStatus("대사를 복사했습니다. 원하는 위치에서 붙여넣으세요."); }}>복사</button><button type="button" disabled={!clipboard} onClick={() => { if (!clipboard) return; mutateScene((next) => { const copied = copyNodeAfter(next, clipboard, id); openMobileNodeEditor(copied); }); setNodeMenu(undefined); }}>다음에 붙여넣기</button><button type="button" className="danger" onClick={() => { if (!window.confirm("이 대사를 삭제하고 연결을 다음 화면으로 복구할까요?")) return; mutateScene((next) => { const replacement = removeNode(next, id); if (replacement) setSelectedNodeId(replacement); }); setNodeMenu(undefined); }}>삭제</button></div>}
                </article>;
              })}</div>
            </aside>

            <section className={mobileEditorOpen ? "mobile-node-editor open" : "mobile-node-editor"}>{node ? <>
              <header>
                <button type="button" className="node-editor-back" onClick={() => { setMobileEditorOpen(false); setEditorMenuOpen(false); }} aria-label="대사 목록으로 돌아가기">←</button>
                <div className="node-editor-title"><small>{scene.node_order.indexOf(node.id) + 1} / {scene.node_order.length}</small><h3>{nodePreview(node)}</h3><SceneStatus draft={selectedDraft} /></div>
                <div className="node-editor-actions"><button type="button" disabled={scene.node_order.indexOf(node.id) === 0} onClick={() => setSelectedNodeId(scene.node_order[scene.node_order.indexOf(node.id) - 1])} aria-label="이전 대사">‹</button><button type="button" disabled={scene.node_order.indexOf(node.id) === scene.node_order.length - 1} onClick={() => setSelectedNodeId(scene.node_order[scene.node_order.indexOf(node.id) + 1])} aria-label="다음 대사">›</button><button type="button" onClick={() => setEditorMenuOpen((value) => !value)} aria-label="현재 대사 편집 메뉴">•••</button></div>
                {editorMenuOpen && <div className="editor-node-popover"><button type="button" onClick={() => { setClipboard(structuredClone(node)); setEditorMenuOpen(false); setStatus("대사를 복사했습니다."); }}>복사</button><button type="button" disabled={!clipboard} onClick={() => { if (!clipboard) return; mutateScene((next) => { const copied = copyNodeAfter(next, clipboard, node.id); setSelectedNodeId(copied); }); setEditorMenuOpen(false); }}>다음에 붙여넣기</button><button type="button" className="danger" onClick={() => { if (!window.confirm("이 대사를 삭제하고 연결을 다음 화면으로 복구할까요?")) return; mutateScene((next) => { const replacement = removeNode(next, node.id); if (replacement) setSelectedNodeId(replacement); }); setEditorMenuOpen(false); }}>삭제</button></div>}
              </header>
              <div className="node-core-fields">
                <label className="mobile-field"><span>종류</span><select aria-label="대사 또는 나레이션" value={node.kind} disabled={!(["dialogue", "narration"]).includes(node.kind)} onChange={(event) => updateNode(changeDialogueKind(node, event.target.value as "dialogue" | "narration", selectedRecord.speakers[0]?.id))}><option value="dialogue">대사</option><option value="narration">나레이션</option>{!(["dialogue", "narration"]).includes(node.kind) && <option value={node.kind}>{MOBILE_NODE_LABELS[node.kind]}</option>}</select></label>
                {["dialogue", "narration", "silent", "effect"].includes(node.kind) && <label className="mobile-field"><span>다음 대사</span><select value={node.next || ""} onChange={(event) => updateNode({ ...node, next: event.target.value })}><option value="">연결 없음</option>{scene.node_order.filter((id) => id !== node.id).map((id) => <option value={id} key={id}>{scene.node_order.indexOf(id) + 1}. {nodePreview(scene.nodes[id]).slice(0, 45)}</option>)}</select></label>}
              </div>

              <section className="mobile-artwork-stage">
                <header><div><strong>화면 원화</strong><small>현재 대사에 표시</small></div><button type="button" onClick={() => updateNode({ ...node, stage: [] })}>모두 끄기</button></header>
                <div>{POSITIONS.map((position) => {
                  const cue = node.stage?.find((item) => item.position === position.id);
                  const art = cue && workspace.artworks.find((item) => item.visualId === cue.visual_id && item.id === cue.artwork);
                  return <button type="button" className={cue ? "filled" : ""} onClick={() => setPicker({ kind: "artwork", position: position.id })} key={position.id}><small>{position.label}</small><i>{art ? art.characterLabel.slice(0, 1) : "+"}</i><strong>{art?.characterLabel || "원화 선택"}</strong><span>{art?.label || "비어 있음"}</span></button>;
                })}</div>
              </section>

              {(node.kind === "dialogue" || node.kind === "narration") && <>
                {node.kind === "dialogue" && <label className="mobile-field speaker-field"><span>화자</span><select value={node.speaker || ""} onChange={(event) => chooseSpeaker(event.target.value)}><option value="">화자 선택</option>{selectedRecord.speakers.map((item) => <option value={item.id} key={item.id}>{item.label}{item.illustrated ? "" : " · 텍스트"}</option>)}</select></label>}
                {!node.variants ? <LayerFields
                  layer={node}
                  speaker={selectedRecord.speakers.find((item) => item.id === effectiveSpeaker(node))}
                  onChange={(layer) => updateNode({ ...node, expression: layer.expression, line: layer.line || "" })}
                /> : <div className="variant-list">{node.variants.map((variant, index) => <label className="mobile-field wide" key={`${variant.id}:${index}`}><span>{variant.default ? "기본 대사" : variant.id}</span><textarea rows={4} value={variant.line || ""} onChange={(event) => { const variants = structuredClone(node.variants!); variants[index].line = event.target.value; updateNode({ ...node, variants }); }} /></label>)}</div>}
              </>}

              {node.kind === "silent" && <p className="advanced-node-note">이 화면은 대사창 없이 배경과 선택한 원화만 표시합니다.</p>}

              {node.kind === "choice" && <div className="choice-mobile-editor"><label className="mobile-field wide"><span>선택 상황</span><textarea value={node.stimulus || ""} onChange={(event) => updateNode({ ...node, stimulus: event.target.value })} /></label>{(node.options || []).map((option, index) => <fieldset key={option.id}><legend>선택지 {index + 1}</legend><label className="mobile-field"><span>표시 문구</span><input value={option.label} onChange={(event) => { const options = structuredClone(node.options!); options[index].label = event.target.value; updateNode({ ...node, options }); }} /></label><label className="mobile-field"><span>행동</span><input value={option.action} onChange={(event) => { const options = structuredClone(node.options!); options[index].action = event.target.value; updateNode({ ...node, options }); }} /></label><label className="mobile-field wide"><span>해석</span><textarea value={option.interpretation} onChange={(event) => { const options = structuredClone(node.options!); options[index].interpretation = event.target.value; updateNode({ ...node, options }); }} /></label></fieldset>)}</div>}

              {!(["dialogue", "narration", "silent", "choice"]).includes(node.kind) && <div className="advanced-node-note"><strong>{MOBILE_NODE_LABELS[node.kind] || node.kind}</strong><p>이 노드의 수치·분기 세부 설정은 PC 제작 버전에서 편집하세요. 모바일에서는 순서·복사·삭제와 다음 연결을 안전하게 관리할 수 있습니다.</p></div>}
            </> : <p className="node-empty">왼쪽에서 대사를 선택하세요.</p>}</section>
          </div>
          <footer className="mobile-save-bar">
            <div>{selectedDraft ? <><strong>{STATUS_COPY[selectedDraft.status]}</strong><small>{selectedDraft.status === "editing" ? "저장 버튼을 누르면 반영 대기열에 들어갑니다." : "인터넷 연결 후 Mac에서 검증하여 반영합니다."}</small></> : <><strong>변경 없음</strong><small>대사, 순서, 원화 또는 배경을 수정해 보세요.</small></>}</div>
            {selectedDraft && <button type="button" className="discard" onClick={() => void discardScene()}>초안 버리기</button>}
            <button type="button" className="save" disabled={!selectedDraft || ["queued", "pending"].includes(selectedDraft.status)} onClick={() => void queueSelectedScene()}>{online ? "장면 저장·동기화" : "폰에 장면 저장"}</button>
          </footer>
          {selectedDraft?.status === "conflict" && <section className="scene-conflict"><strong>Mac에서도 같은 부분이 수정되었습니다.</strong><p>{selectedDraft.reason || "겹친 필드를 확인해 주세요."}</p><button type="button" onClick={() => void discardScene()}>Mac 최신 장면으로 돌아가기</button></section>}
          {selectedDraft?.status === "rejected" && <section className="scene-conflict rejected"><strong>스토리 검증을 통과하지 못했습니다.</strong><p>{selectedDraft.reason}</p></section>}
        </> : <div className="scene-empty"><strong>장면을 선택하세요.</strong><button type="button" onClick={() => setNavOpen(true)}>날짜별 장면 열기</button></div>}
      </section>
    </div>

    {picker?.kind === "artwork" && scene && node && <ArtworkPicker scene={scene} node={node} options={workspace.artworks} selection={picker} onPick={selectArtwork} onClose={() => setPicker(undefined)} />}
    {picker?.kind === "background" && scene && <BackgroundPicker options={workspace.backgrounds} current={scene.default_background} onClose={() => setPicker(undefined)} onPick={(option) => { mutateScene((next) => { next.default_background = option ? { visual_id: option.visualId, variant_id: option.variantId } : undefined; }); setPicker(undefined); }} />}
  </main>;
}
