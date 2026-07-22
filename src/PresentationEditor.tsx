import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LocalizationService, storyTextKey, VisualResolver } from "./presentation";
import type { DocumentActivity, LocaleId, ProjectPayload, ResolvedStage, Runtime, Scene, StoryNode, ValidationIssue, ViewMode, VisualObject } from "./types";

type StageCanvasProps = {
  runtime: Runtime;
  scene: Scene;
  node: StoryNode;
  stage: ResolvedStage;
  locale: LocaleId;
  images: Record<string, string>;
};

export function StageCanvas({ runtime, scene, node, stage, locale, images }: StageCanvasProps) {
  const i18n = useMemo(() => new LocalizationService(runtime, locale), [runtime, locale]);
  const layer = node[stage.mode];
  const speakerId = node.speaker;
  const speakerName = speakerId
    ? i18n.t(`characters.${speakerId}.display_name`, runtime.characters[speakerId]?.display_name || speakerId)
    : "";
  const line = layer?.line
    ? i18n.t(storyTextKey(scene.id, node.id, `${stage.mode}.line`), layer.line)
    : node.prompt
      ? i18n.t(storyTextKey(scene.id, node.id, "prompt"), node.prompt)
      : node.kind === "exit" ? "장면을 떠납니다." : "상태를 계산합니다.";
  const interpretation = stage.mode === "perceived"
    ? layer?.protagonist_interpretation
      ? i18n.t(storyTextKey(scene.id, node.id, "perceived.protagonist_interpretation"), layer.protagonist_interpretation)
      : ""
    : layer?.inner_thought
      ? i18n.t(storyTextKey(scene.id, node.id, "reality.inner_thought"), layer.inner_thought)
      : "";

  return <div className={`stage-canvas ${stage.mode}`} aria-label={`${scene.title} 연출 프리뷰`}>
    {stage.background?.asset && images[stage.background.asset]
      ? <img className="stage-background" src={images[stage.background.asset]} alt="" />
      : <div className="stage-background-placeholder">BACKGROUND</div>}
    <div className="stage-vignette" />
    <div className="stage-cast" aria-label="등장인물 배치">
      {stage.characters.map((character) => <figure
        className={`stage-character ${character.position} ${character.speaker ? "speaking" : ""} ${character.render_strategy}`}
        key={character.character}
      >
        {images[character.asset]
          ? <img src={images[character.asset]} alt={runtime.characters[character.character]?.display_name || character.character} />
          : <div className="image-placeholder">NO IMAGE</div>}
        <figcaption>{runtime.characters[character.character]?.display_name}<small>{character.expression || character.pose}</small></figcaption>
      </figure>)}
    </div>
    <div className="stage-dialogue">
      {speakerName && <strong>{speakerName}</strong>}
      <blockquote>{line}</blockquote>
      {interpretation && <p>{interpretation}</p>}
    </div>
  </div>;
}

function VisualObjectRow({ visual, i18n }: { visual: VisualObject; i18n: LocalizationService }) {
  const title = visual.title_key ? i18n.t(visual.title_key, visual.id) : visual.id;
  return <div className={`visual-object-row ${visual.abstract ? "abstract" : ""}`}>
    <div><strong>{title}</strong><code>{visual.id}</code></div>
    <span>{visual.kind}</span>
    <small>{visual.extends ? `↳ ${visual.extends}` : "root object"}</small>
  </div>;
}

type Props = {
  active: boolean;
  payload: ProjectPayload;
  locale: LocaleId;
  onLocale: (locale: LocaleId) => void;
  mode: ViewMode;
  onMode: (mode: ViewMode) => void;
  onStatus: (status: string) => void;
  onPayload: (payload: ProjectPayload) => void;
  onIssues: (issues: ValidationIssue[]) => void;
  onDocumentActivity: (activity: DocumentActivity) => void;
};

export default function PresentationEditor({ active, payload, locale, onLocale, mode, onMode, onStatus, onPayload, onIssues, onDocumentActivity }: Props) {
  const runtime = payload.runtime;
  const scenes = Object.values(runtime.scenes);
  const [sceneId, setSceneId] = useState(scenes[0]?.id || "");
  const scene = runtime.scenes[sceneId] || scenes[0];
  const [nodeId, setNodeId] = useState(scene?.start_node || "");
  const [images, setImages] = useState<Record<string, string>>({});
  const [translationDraft, setTranslationDraft] = useState("");
  const [savingTranslation, setSavingTranslation] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [savedAt, setSavedAt] = useState<number>();
  const lastAutoSaveAttempt = useRef("");
  const resolver = useMemo(() => new VisualResolver(runtime), [runtime]);
  const i18n = useMemo(() => new LocalizationService(runtime, locale), [runtime, locale]);
  const node = scene?.nodes[nodeId] || scene?.nodes[scene?.start_node];
  const stage = scene && node ? resolver.resolveStage(scene, node.id, mode) : undefined;
  const coverage = i18n.coverage();
  const layer = node?.[mode];
  const translationKey = node && scene
    ? layer?.line
      ? storyTextKey(scene.id, node.id, `${mode}.line`)
      : node.prompt
        ? storyTextKey(scene.id, node.id, "prompt")
        : `scenes.${scene.id}.title`
    : "";
  const sourceText = runtime.localization.source_strings[translationKey] || "";
  const storedTranslation = runtime.localization.locales[locale]?.strings[translationKey] || "";
  const translationDirty = locale !== runtime.localization.default_locale && translationDraft !== storedTranslation;
  const translationRevision = payload.documents.locales[locale]?.revision || "";
  const translationDraftKey = `love-office-translation-draft:${payload.root}:${locale}:${translationKey}`;

  useEffect(() => {
    let next = storedTranslation;
    const stored = localStorage.getItem(translationDraftKey);
    if (stored && locale !== runtime.localization.default_locale) {
      try {
        const recovery = JSON.parse(stored) as { revision: string; text: string };
        if (recovery.revision === translationRevision && recovery.text !== storedTranslation
          && window.confirm("저장되지 않은 번역 초안이 있습니다. 복구할까요?")) {
          next = recovery.text;
          onStatus("종료 전 보관된 번역 초안을 복구했습니다. 자동 저장을 다시 시도합니다.");
        } else localStorage.removeItem(translationDraftKey);
      } catch {
        localStorage.removeItem(translationDraftKey);
      }
    }
    setTranslationDraft(next);
    setSaveError(false);
  }, [locale, runtime.localization.locales, translationDraftKey, translationKey, translationRevision]);

  useEffect(() => {
    if (scene && !scene.nodes[nodeId]) setNodeId(scene.start_node);
  }, [nodeId, scene]);

  useEffect(() => {
    const assets = [
      stage?.background?.asset,
      ...(stage?.characters.map((character) => character.asset) || []),
    ].filter((value): value is string => Boolean(value));
    assets.forEach((asset) => {
      if (images[asset]) return;
      invoke<string>("read_asset", { root: payload.root, relativePath: asset })
        .then((data) => setImages((current) => ({ ...current, [asset]: data })))
        .catch((error) => onStatus(`연출 자산을 읽지 못했습니다: ${String(error)}`));
    });
  }, [images, onStatus, payload.root, stage]);

  const saveTranslation = useCallback(async () => {
    const localeDocument = runtime.localization.locales[locale];
    const metadata = payload.documents.locales[locale];
    if (!localeDocument || !metadata || !translationKey || locale === runtime.localization.default_locale) return;
    setSavingTranslation(true);
    setSaveError(false);
    onStatus(`${runtime.localization.locale_names[locale]} 번역을 검증하고 저장하는 중…`);
    try {
      const document = {
        ...localeDocument,
        strings: { ...localeDocument.strings, [translationKey]: translationDraft },
      };
      const result = await invoke<{
        saved: boolean;
        issues: ValidationIssue[];
        runtime?: Runtime;
        document?: ProjectPayload["documents"]["locales"][string];
      }>("save_document", {
        root: payload.root,
        kind: "locales",
        document,
        revision: metadata.revision,
      });
      onIssues(result.issues);
      if (!result.saved || !result.runtime || !result.document) {
        onStatus("번역에 오류가 있어 저장하지 않았습니다.");
        setSaveError(true);
        return;
      }
      onPayload({
        ...payload,
        runtime: result.runtime,
        documents: {
          ...payload.documents,
          locales: { ...payload.documents.locales, [locale]: result.document },
        },
      });
      setSavedAt(Date.now());
      localStorage.removeItem(translationDraftKey);
      onStatus(`${runtime.localization.locale_names[locale]} 번역과 런타임 카탈로그를 저장했습니다.`);
    } catch (error) {
      setSaveError(true);
      onStatus(`번역 저장 실패: ${String(error)}`);
    } finally {
      setSavingTranslation(false);
    }
  }, [locale, onIssues, onPayload, onStatus, payload, runtime, translationDraft, translationDraftKey, translationKey]);

  useEffect(() => {
    if (!scene) return;
    const isTranslation = locale !== runtime.localization.default_locale;
    onDocumentActivity({
      phase: savingTranslation ? "saving" : saveError ? "error" : translationDirty ? "dirty" : "saved",
      label: isTranslation ? `${runtime.localization.locale_names[locale]} 번역` : scene.title,
      path: isTranslation ? payload.documents.locales[locale]?.path || "" : payload.documents.scenes[scene.id]?.path || "",
      detail: savingTranslation ? "번역을 검증하고 디스크에 기록 중"
        : saveError ? "저장 실패 · 마지막 정상 파일은 보존됨"
          : translationDirty ? "자동 저장 대기" : isTranslation ? "번역 YAML + 런타임 동기화됨" : "기본 언어는 장면·대사에서 편집",
      savedAt,
    });
  }, [locale, onDocumentActivity, payload.documents.locales, payload.documents.scenes, runtime.localization, saveError, savedAt, savingTranslation, scene, translationDirty]);

  useEffect(() => {
    if (locale === runtime.localization.default_locale || !translationKey) return;
    if (!translationDirty) {
      localStorage.removeItem(translationDraftKey);
      return;
    }
    const timer = window.setTimeout(() => {
      localStorage.setItem(translationDraftKey, JSON.stringify({ revision: translationRevision, text: translationDraft }));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [locale, runtime.localization.default_locale, translationDirty, translationDraft, translationDraftKey, translationKey, translationRevision]);

  useEffect(() => {
    const preserveDraft = () => {
      if (translationDirty) {
        localStorage.setItem(translationDraftKey, JSON.stringify({ revision: translationRevision, text: translationDraft }));
      }
    };
    window.addEventListener("beforeunload", preserveDraft);
    return () => window.removeEventListener("beforeunload", preserveDraft);
  }, [translationDirty, translationDraft, translationDraftKey, translationRevision]);

  useEffect(() => {
    if (!translationDirty || savingTranslation) return;
    const signature = `${locale}:${translationKey}:${translationDraft}`;
    if (signature === lastAutoSaveAttempt.current) return;
    const timer = window.setTimeout(() => {
      lastAutoSaveAttempt.current = signature;
      void saveTranslation();
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [locale, saveTranslation, savingTranslation, translationDraft, translationDirty, translationKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!active || !(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "s") return;
      event.preventDefault();
      if (translationDirty && !savingTranslation) void saveTranslation();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, saveTranslation, savingTranslation, translationDirty]);

  const preserveCurrentTranslationDraft = () => {
    if (translationDirty) {
      localStorage.setItem(translationDraftKey, JSON.stringify({ revision: translationRevision, text: translationDraft }));
    }
  };

  if (!scene || !node || !stage) return <div className="presentation-empty">연출 가능한 장면이 없습니다.</div>;

  const backgrounds = Object.values(runtime.visuals).filter((visual) => visual.kind.includes("background"));
  const characters = Object.values(runtime.visuals).filter((visual) => visual.kind.includes("character"));

  return <div className="presentation-shell">
    <section className="presentation-main">
      <div className="presentation-toolbar">
        <div><p className="eyebrow">PRESENTATION DOMAIN</p><h2>연출·번역</h2><p>시간·장소·분위기와 인물 객체를 조합해 실제 게임 화면을 확인합니다.</p></div>
        <div className="presentation-controls">
          <label><span>언어</span><select value={locale} onChange={(event) => { preserveCurrentTranslationDraft(); onLocale(event.target.value); }}>{runtime.localization.supported_locales.map((id) => <option value={id} key={id}>{runtime.localization.locale_names[id]}</option>)}</select></label>
          <div className="segmented"><button type="button" className={mode === "perceived" ? "active" : ""} onClick={() => { preserveCurrentTranslationDraft(); onMode("perceived"); }}>주인공 인식</button><button type="button" className={mode === "reality" ? "active" : ""} onClick={() => { preserveCurrentTranslationDraft(); onMode("reality"); }}>실제</button></div>
        </div>
      </div>
      <div className="presentation-selector">
        <label><span>장면</span><select value={scene.id} onChange={(event) => { preserveCurrentTranslationDraft(); const next = runtime.scenes[event.target.value]; setSceneId(next.id); setNodeId(next.start_node); }}>{scenes.map((item) => <option value={item.id} key={item.id}>{i18n.t(`scenes.${item.id}.title`, item.title)}</option>)}</select></label>
        <label><span>노드</span><select value={node.id} onChange={(event) => { preserveCurrentTranslationDraft(); setNodeId(event.target.value); }}>{scene.node_order.map((id) => <option value={id} key={id}>{id} · {scene.nodes[id].kind}</option>)}</select></label>
      </div>
      <StageCanvas runtime={runtime} scene={scene} node={node} stage={stage} locale={locale} images={images} />
      <div className="resolution-trace">
        <strong>배경 판정</strong>
        <code>{stage.background?.visual_id}.{stage.background?.variant_id}</code>
        <span>{stage.background?.matched.join(" · ") || "기본 규칙"}</span>
        <small>우선순위 점수 {stage.background?.score}</small>
      </div>
    </section>

    <aside className="presentation-inspector">
      <section className="coverage-panel">
        <p className="eyebrow">LOCALIZATION</p>
        <h3>{runtime.localization.locale_names[locale]}</h3>
        <div className="coverage-meter"><span style={{ width: `${Math.max(2, (coverage?.ratio || 0) * 100)}%` }} /></div>
        <strong>{coverage?.translated || 0} / {coverage?.total || 0} 직접 번역</strong>
        <small>없는 문장은 {runtime.localization.locale_names[runtime.localization.default_locale]} 원문으로 안전하게 대체됩니다.</small>
        <details><summary>미번역 키 {coverage?.missing.length || 0}개</summary><div className="missing-keys">{coverage?.missing.slice(0, 40).map((key) => <code key={key}>{key}</code>)}</div></details>
        <div className="translation-editor">
          <strong>현재 문장 번역</strong>
          <code>{translationKey}</code>
          <small>원문 · {sourceText}</small>
          {locale === runtime.localization.default_locale
            ? <p>기본 언어는 장면·대사 화면에서 수정합니다.</p>
            : <>
              <textarea rows={4} value={translationDraft} placeholder="번역을 입력하세요" onChange={(event) => setTranslationDraft(event.target.value)} />
              <small>{translationDirty ? "입력을 멈추면 자동 저장됩니다." : "디스크와 동기화됨"}</small>
              <button type="button" className="primary-button" disabled={!translationDirty || savingTranslation} onClick={saveTranslation}>지금 저장 ⌘S</button>
            </>}
        </div>
      </section>
      <section className="visual-hierarchy">
        <p className="eyebrow">OBJECT HIERARCHY</p><h3>배경 객체</h3>
        {backgrounds.map((visual) => <VisualObjectRow visual={visual} i18n={i18n} key={visual.id} />)}
        <h3>캐릭터 객체</h3>
        {characters.map((visual) => <VisualObjectRow visual={visual} i18n={i18n} key={visual.id} />)}
      </section>
    </aside>
  </div>;
}
