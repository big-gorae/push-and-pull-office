import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteDraft,
  deviceId,
  draftId,
  queueChange,
  readCatalog,
  readDrafts,
  writeCatalog,
  writeDraft,
} from "./storage";
import { bundledCatalog, isMacSyncBridge, MOBILE_PROJECT_ID, synchronize } from "./sync";
import type { MobileCatalogEntry, MobileCatalogSnapshot, StoredMobileDraft } from "./types";
import "./mobile-authoring.css";

type InstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type ViewFilter = "all" | "changed" | "conflict";
const PAGE_SIZE = 80;

const STATUS_COPY: Record<StoredMobileDraft["status"], string> = {
  editing: "폰에 초안 저장",
  queued: "업로드 대기",
  pending: "Mac 반영 대기",
  applied: "반영 완료",
  conflict: "충돌 확인 필요",
  rejected: "검증 확인 필요",
};

function placeholderNames(value: string): string[] {
  return [...value.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\}\}/g)]
    .map((match) => match[1])
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
}

function layerLabel(entry: MobileCatalogEntry): string {
  if (entry.linkedLocalizationKeys?.length) return "양쪽 공통";
  if (entry.context.layer === "perceived") return "도윤의 인식";
  if (entry.context.layer === "reality") return "실제 상황";
  if (entry.context.optionId) return "선택지";
  return entry.domain === "system_flow" ? "시스템" : "문구";
}

function entrySearchText(entry: MobileCatalogEntry, draft?: StoredMobileDraft): string {
  return [
    entry.documentTitle,
    entry.documentId,
    entry.context.nodeId,
    entry.context.speakerId,
    entry.value,
    draft?.nextValue,
  ].filter(Boolean).join(" ").toLocaleLowerCase();
}

function entryIsLinkedSecondary(entry: MobileCatalogEntry): boolean {
  return entry.context.layer === "reality"
    && Boolean(entry.linkedLocalizationKeys?.some((key) => key.includes(".perceived.line")));
}

export default function MobileAuthoringApp() {
  const macBridge = isMacSyncBridge();
  const [catalog, setCatalog] = useState<MobileCatalogSnapshot>();
  const [drafts, setDrafts] = useState<StoredMobileDraft[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ViewFilter>("all");
  const [selectedKey, setSelectedKey] = useState<string>();
  const [editValue, setEditValue] = useState("");
  const [online, setOnline] = useState(() => navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState("오프라인 저장소를 준비하는 중…");
  const [lastSyncedAt, setLastSyncedAt] = useState<Date>();
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent>();
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const editHydrated = useRef(false);
  const hydratedSelection = useRef<string | undefined>(undefined);
  const hydratedValue = useRef("");
  const editBase = useRef<{ value: string; hash: string } | undefined>(undefined);
  const pinnedSelectedEntry = useRef<MobileCatalogEntry | undefined>(undefined);
  const syncingRef = useRef(false);

  const draftMap = useMemo(() => new Map(drafts.map((draft) => [draft.localizationKey, draft])), [drafts]);
  const entryMap = useMemo(() => new Map(catalog?.entries.map((entry) => [entry.localizationKey, entry]) || []), [catalog]);
  const currentSelectedEntry = selectedKey ? entryMap.get(selectedKey) : undefined;
  if (currentSelectedEntry) pinnedSelectedEntry.current = currentSelectedEntry;
  const selectedEntry = selectedKey ? currentSelectedEntry || pinnedSelectedEntry.current : undefined;
  const selectedDraft = selectedKey ? draftMap.get(selectedKey) : undefined;

  const refreshLocal = useCallback(async (nextCatalog?: MobileCatalogSnapshot) => {
    const resolvedCatalog = nextCatalog || await readCatalog(MOBILE_PROJECT_ID);
    if (resolvedCatalog) setCatalog(resolvedCatalog);
    setDrafts(await readDrafts(MOBILE_PROJECT_ID));
  }, []);

  const syncNow = useCallback(async (quiet = false) => {
    if (!navigator.onLine || syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    if (!quiet) setStatus(macBridge ? "Mac 원문과 휴대폰 변경을 맞추는 중…" : "변경 내용을 동기화하는 중…");
    try {
      const next = await synchronize();
      await refreshLocal(next);
      setOnline(true);
      setLastSyncedAt(new Date());
      setStatus(macBridge ? "Mac 원문과 동기화되었습니다." : "모든 변경이 안전하게 보관되었습니다.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof TypeError || /failed to fetch|network|internet disconnected/i.test(message)) {
        setOnline(false);
        setStatus("오프라인 · 작성 내용은 이 폰에 보관됩니다.");
      } else {
        setStatus(`동기화 대기 · ${message}`);
      }
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [macBridge, refreshLocal]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let snapshot = await readCatalog(MOBILE_PROJECT_ID);
      if (!snapshot) {
        snapshot = await bundledCatalog();
        await writeCatalog(snapshot);
      }
      if (cancelled) return;
      await refreshLocal(snapshot);
      setStatus(navigator.onLine ? "온라인 · 최신 내용을 확인합니다." : "오프라인 · 이 폰에 안전하게 저장합니다.");
      if (navigator.onLine) void syncNow(true);
    })();
    return () => { cancelled = true; };
  }, [refreshLocal, syncNow]);

  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "manifest";
    link.href = "/authoring.webmanifest";
    document.head.append(link);
    const appleIcon = document.createElement("link");
    appleIcon.rel = "apple-touch-icon";
    appleIcon.href = "/icons/authoring-192.png";
    document.head.append(appleIcon);
    const theme = document.createElement("meta");
    theme.name = "theme-color";
    theme.content = "#fff9f7";
    document.head.append(theme);
    const title = document.title;
    document.title = "밀당 오피스 · 모바일 대사 편집";
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/authoring-sw.js", { scope: "/author/" })
        .then(async (registration) => {
          const readyRegistration = await navigator.serviceWorker.ready;
          const urls = performance.getEntriesByType("resource")
            .map((entry) => new URL(entry.name, window.location.href))
            .filter((url) => url.origin === window.location.origin && !url.pathname.startsWith("/api/"))
            .map((url) => url.href);
          (readyRegistration.active || registration.active)?.postMessage({ type: "CACHE_ASSETS", urls });
        })
        .catch(() => undefined);
    }
    const onInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onInstall);
    return () => {
      link.remove();
      appleIcon.remove();
      theme.remove();
      document.title = title;
      window.removeEventListener("beforeinstallprompt", onInstall);
    };
  }, []);

  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      void syncNow();
    };
    const onOffline = () => {
      setOnline(false);
      setStatus("오프라인 · 작성 내용은 이 폰에 보관됩니다.");
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible" && navigator.onLine) void syncNow(true);
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(() => {
      if (navigator.onLine && document.visibilityState === "visible") void syncNow(true);
    }, macBridge ? 20_000 : 60_000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
    };
  }, [macBridge, syncNow]);

  useEffect(() => {
    if (!selectedEntry) {
      editHydrated.current = false;
      hydratedSelection.current = undefined;
      editBase.current = undefined;
      return;
    }
    const selection = `${selectedEntry.localizationKey}\u0000${selectedDraft?.eventId || ""}`;
    const nextValue = selectedDraft?.nextValue ?? selectedEntry.value;
    if (hydratedSelection.current === selection && editValue !== hydratedValue.current) return;
    editHydrated.current = false;
    hydratedSelection.current = selection;
    hydratedValue.current = nextValue;
    editBase.current = selectedDraft
      ? { value: selectedDraft.baseValue, hash: selectedDraft.baseValueHash }
      : { value: selectedEntry.value, hash: selectedEntry.valueHash };
    setEditValue(nextValue);
    queueMicrotask(() => { editHydrated.current = true; });
  }, [selectedEntry?.localizationKey, selectedEntry?.valueHash, selectedDraft?.eventId]);

  useEffect(() => {
    if (!selectedEntry || !editHydrated.current) return;
    const timer = window.setTimeout(() => {
      const currentDraft = draftMap.get(selectedEntry.localizationKey);
      if (currentDraft?.nextValue === editValue) return;
      if (editValue === selectedEntry.value && !currentDraft?.eventId) {
        if (currentDraft) void deleteDraft(currentDraft).then(() => refreshLocal());
        return;
      }
      const now = new Date().toISOString();
      void writeDraft({
        id: draftId(MOBILE_PROJECT_ID, selectedEntry.localizationKey, selectedEntry.locale),
        projectId: MOBILE_PROJECT_ID,
        localizationKey: selectedEntry.localizationKey,
        locale: selectedEntry.locale,
        baseValue: currentDraft?.baseValue ?? editBase.current?.value ?? selectedEntry.value,
        baseValueHash: currentDraft?.baseValueHash ?? editBase.current?.hash ?? selectedEntry.valueHash,
        nextValue: editValue,
        eventId: currentDraft?.eventId,
        status: currentDraft?.eventId && editValue === currentDraft.nextValue ? currentDraft.status : "editing",
        reason: currentDraft?.reason,
        currentValue: currentDraft?.currentValue,
        currentValueHash: currentDraft?.currentValueHash,
        updatedAt: now,
      }).then(() => refreshLocal());
    }, 220);
    return () => window.clearTimeout(timer);
  }, [draftMap, editValue, refreshLocal, selectedEntry]);

  const visibleEntries = useMemo(() => {
    if (!catalog) return [];
    const needle = query.trim().toLocaleLowerCase();
    return catalog.entries.filter((entry) => {
      if (entryIsLinkedSecondary(entry)) return false;
      const draft = draftMap.get(entry.localizationKey);
      if (filter === "changed" && !draft) return false;
      if (filter === "conflict" && draft?.status !== "conflict" && draft?.status !== "rejected") return false;
      return !needle || entrySearchText(entry, draft).includes(needle);
    });
  }, [catalog, draftMap, filter, query]);
  const displayedEntries = visibleEntries.slice(0, visibleLimit);

  useEffect(() => {
    setVisibleLimit(PAGE_SIZE);
  }, [filter, query]);

  const queueSelected = async (baseOverride?: { value: string; hash: string }) => {
    if (!selectedEntry || !editValue.trim()) return;
    const placeholders = placeholderNames(editValue);
    if (JSON.stringify(placeholders) !== JSON.stringify([...selectedEntry.placeholders].sort())) {
      setStatus("저장하지 못했습니다 · {{변수}}를 원문과 똑같이 유지해 주세요.");
      return;
    }
    if (selectedEntry.maxLength && editValue.length > selectedEntry.maxLength) {
      setStatus(`저장하지 못했습니다 · ${selectedEntry.maxLength}자 이내로 작성해 주세요.`);
      return;
    }
    const id = await deviceId();
    const currentDraft = draftMap.get(selectedEntry.localizationKey);
    const createdAt = new Date().toISOString();
    await queueChange({
      eventId: crypto.randomUUID(),
      projectId: MOBILE_PROJECT_ID,
      localizationKey: selectedEntry.localizationKey,
      locale: selectedEntry.locale,
      baseValue: baseOverride?.value ?? currentDraft?.baseValue ?? editBase.current?.value ?? selectedEntry.value,
      baseValueHash: baseOverride?.hash ?? currentDraft?.baseValueHash ?? editBase.current?.hash ?? selectedEntry.valueHash,
      nextValue: editValue.trim(),
      deviceId: id,
      clientCreatedAt: createdAt,
    });
    await refreshLocal();
    setStatus(online ? "변경을 저장했습니다 · Mac 반영 대기열로 보냅니다." : "변경을 폰에 저장했습니다 · 연결되면 자동으로 보냅니다.");
    if (online) void syncNow(true);
  };

  const discardSelected = async () => {
    if (!selectedDraft) return;
    await deleteDraft(selectedDraft);
    await refreshLocal();
    setEditValue(selectedEntry?.value || "");
    if (selectedEntry) {
      hydratedValue.current = selectedEntry.value;
      editBase.current = { value: selectedEntry.value, hash: selectedEntry.valueHash };
    }
    setStatus("휴대폰 초안을 버리고 현재 원문으로 돌아왔습니다.");
  };

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(undefined);
  };

  const pendingCount = drafts.filter((draft) => ["queued", "pending"].includes(draft.status)).length;
  const conflictCount = drafts.filter((draft) => ["conflict", "rejected"].includes(draft.status)).length;

  if (!catalog) {
    return <main className="mobile-authoring-loading"><span /><p>대사 보관함을 여는 중…</p></main>;
  }

  return <main className="mobile-authoring-shell">
    <header className="mobile-authoring-header">
      <div>
        <p>LOVE OFFICE · AUTHORING</p>
        <h1>대사 보관함</h1>
      </div>
      <button type="button" className={`connection-pill ${online ? "online" : "offline"}`} onClick={() => void syncNow()} disabled={!online || syncing}>
        <i />{syncing ? "맞추는 중" : online ? "온라인" : "오프라인"}
      </button>
    </header>

    <section className="sync-summary" aria-live="polite">
      <div className="sync-summary-main">
        <span className={macBridge ? "mac" : "phone"}>{macBridge ? "MAC BRIDGE" : "THIS PHONE"}</span>
        <strong>{status}</strong>
        <small>{lastSyncedAt ? `마지막 확인 ${lastSyncedAt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}` : "입력하는 즉시 이 기기에 보관됩니다."}</small>
      </div>
      <div className="sync-counts">
        <span><b>{pendingCount}</b> 반영 대기</span>
        <span className={conflictCount ? "attention" : ""}><b>{conflictCount}</b> 확인 필요</span>
      </div>
      {installPrompt && !macBridge && <button type="button" className="install-button" onClick={() => void install()}>홈 화면에 설치</button>}
    </section>

    <section className="mobile-authoring-tools">
      <label>
        <span>대사 검색</span>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="장면, 인물, 문장으로 찾기" />
      </label>
      <nav aria-label="대사 필터">
        <button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>전체</button>
        <button type="button" className={filter === "changed" ? "active" : ""} onClick={() => setFilter("changed")}>내 수정 {drafts.length}</button>
        <button type="button" className={filter === "conflict" ? "active" : ""} onClick={() => setFilter("conflict")}>확인 {conflictCount}</button>
      </nav>
    </section>

    <section className="dialogue-list" aria-label="대사 목록">
      <p className="result-count">{visibleEntries.length.toLocaleString("ko-KR")}개 대사</p>
      {displayedEntries.map((entry) => {
        const draft = draftMap.get(entry.localizationKey);
        return <button type="button" className={`dialogue-card ${draft?.status || ""}`} key={entry.localizationKey} onClick={() => {
          pinnedSelectedEntry.current = entry;
          setSelectedKey(entry.localizationKey);
        }}>
          <span className="dialogue-card-meta"><b>{entry.documentTitle}</b><i>{layerLabel(entry)}</i></span>
          <strong>{entry.context.speakerId || (entry.context.layer ? "내레이션" : "시스템")}</strong>
          <p>{draft?.nextValue || entry.value}</p>
          <span className="dialogue-card-footer">
            <small>{entry.context.nodeId || entry.context.optionId || entry.documentId}</small>
            {draft && <em>{STATUS_COPY[draft.status]}</em>}
          </span>
        </button>;
      })}
      {displayedEntries.length < visibleEntries.length && <button type="button" className="load-more" onClick={() => setVisibleLimit((value) => value + PAGE_SIZE)}>
        다음 {Math.min(PAGE_SIZE, visibleEntries.length - displayedEntries.length)}개 보기
      </button>}
      {!visibleEntries.length && <div className="dialogue-empty"><strong>조건에 맞는 대사가 없습니다.</strong><p>검색어나 필터를 바꿔 보세요.</p></div>}
    </section>

    {selectedEntry && <div className="editor-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) setSelectedKey(undefined);
    }}>
      <section className="mobile-dialogue-editor" role="dialog" aria-modal="true" aria-label="대사 편집">
        <header>
          <button type="button" onClick={() => setSelectedKey(undefined)} aria-label="편집 닫기">←</button>
          <div><strong>{selectedEntry.documentTitle}</strong><span>{layerLabel(selectedEntry)} · {selectedEntry.context.nodeId || selectedEntry.context.optionId}</span></div>
          {selectedDraft && <em className={selectedDraft.status}>{STATUS_COPY[selectedDraft.status]}</em>}
        </header>
        <div className="editor-source">
          <span>현재 기준 문장</span>
          <p>{selectedDraft?.baseValue || selectedEntry.value}</p>
        </div>
        <label className="editor-input">
          <span>수정할 문장</span>
          <textarea value={editValue} onChange={(event) => setEditValue(event.target.value)} rows={6} autoFocus />
          <small className={selectedEntry.maxLength && editValue.length > selectedEntry.maxLength ? "over" : ""}>{editValue.length}{selectedEntry.maxLength ? ` / ${selectedEntry.maxLength}` : ""}자</small>
        </label>
        {selectedDraft?.status === "conflict" && <div className="conflict-panel">
          <strong>Mac에서도 이 대사가 바뀌었습니다.</strong>
          <p>{selectedDraft.currentValue || "현재 Mac 문장을 불러오지 못했습니다."}</p>
          {selectedDraft.currentValue && selectedDraft.currentValueHash && <button type="button" onClick={() => void queueSelected({ value: selectedDraft.currentValue!, hash: selectedDraft.currentValueHash! })}>Mac 문장을 기준으로 내 문장 다시 보내기</button>}
        </div>}
        {selectedDraft?.status === "rejected" && <div className="conflict-panel rejected"><strong>스토리 검증을 통과하지 못했습니다.</strong><p>{selectedDraft.reason || "문장 형식을 확인해 주세요."}</p></div>}
        <footer>
          {selectedDraft && <button type="button" className="discard" onClick={() => void discardSelected()}>초안 버리기</button>}
          <button type="button" className="save-change" onClick={() => void queueSelected()} disabled={!editValue.trim() || editValue.trim() === (selectedDraft?.baseValue || selectedEntry.value)}>{online ? "저장하고 동기화" : "폰에 저장"}</button>
        </footer>
      </section>
    </div>}
  </main>;
}
