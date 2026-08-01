import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import LocalizationTable from "./LocalizationTable";
import { LocalizationService, storyTextKey, VisualResolver } from "./presentation";
import { canEnterScene, clone, effectiveSpeaker, resolveDialogueNode, setPath } from "./storyLogic";
import type {
  DocumentActivity,
  LocaleId,
  ProjectPayload,
  ResolvedStage,
  Runtime,
  RuntimeState,
  Scene,
  StoryNode,
  ValidationIssue,
  ViewMode,
  VisualObject,
} from "./types";

type StageCanvasProps = {
  runtime: Runtime;
  scene: Scene;
  node: StoryNode;
  stage: ResolvedStage;
  locale: LocaleId;
  variantId?: string;
  images: Record<string, string>;
};

export function StageCanvas({ runtime, scene, node, stage, locale, variantId, images }: StageCanvasProps) {
  const i18n = useMemo(() => new LocalizationService(runtime, locale), [runtime, locale]);
  const layer = node[stage.mode];
  const variantPath = variantId && variantId !== "default" ? `variants.${variantId}.` : "";
  const speaker = effectiveSpeaker(node, stage.mode);
  const speakerName = speaker
    ? i18n.t(
      runtime.characters[speaker] ? `characters.${speaker}.display_name` : `world.${speaker}.display_name`,
      runtime.characters[speaker]?.display_name || runtime.world?.entities[speaker]?.display_name || speaker,
    )
    : "";
  const line = layer?.line
    ? i18n.t(storyTextKey(scene.id, node.id, `${variantPath}${stage.mode}.line`), layer.line)
    : node.prompt
      ? i18n.t(storyTextKey(scene.id, node.id, "prompt"), node.prompt)
      : node.kind === "exit" ? "장면을 떠납니다." : "상태를 계산합니다.";
  return <div className={`stage-canvas ${stage.mode}`} aria-label={`${scene.title} 연출 프리뷰`}>
    {stage.background?.asset && images[stage.background.asset]
      ? <img className="stage-background" src={images[stage.background.asset]} alt="" />
      : <div className="stage-background-placeholder">BACKGROUND</div>}
    <div className="stage-vignette" />
    <div className="stage-cast" aria-label="등장인물 배치">
      {stage.characters.filter((character) => character.speaker).map((character) => <figure
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
    </div>
  </div>;
}

function VisualObjectRow({ visual, i18n }: { visual: VisualObject; i18n: LocalizationService }) {
  const title = visual.title_key ? i18n.t(visual.title_key, visual.title || visual.id) : visual.title || visual.id;
  return <div className={`visual-object-row ${visual.abstract ? "abstract" : ""}`}>
    <div><strong>{title}</strong><code>{visual.id}</code></div>
    <span>{visual.kind}</span>
    <small>{visual.extends ? `↳ ${visual.extends}` : "root object"}</small>
  </div>;
}

function StatePreviewControls({
  runtime,
  scene,
  state,
  onState,
}: {
  runtime: Runtime;
  scene: Scene;
  state: RuntimeState;
  onState: (state: RuntimeState) => void;
}) {
  const route = runtime.routes[scene.route];
  const characterId = route?.heroine || scene.cast.find((id) => state.hidden.heroines[id]);
  const hidden = characterId ? state.hidden.heroines[characterId] : undefined;
  if (!characterId || !hidden) return null;
  const character = runtime.characters[characterId];
  return <section className="variant-state-controls">
    <header><strong>상황별 대사 테스트 상태</strong><span>{character?.display_name || characterId}</span></header>
    {(["suspicion", "dislike", "evidence_count"] as const).map((stat) => {
      const maximum = stat === "evidence_count" ? 10 : 100;
      return <label key={stat}>
        <span>{stat}</span>
        <input type="range" min={0} max={maximum} value={hidden[stat]} onChange={(event) => {
          const next = clone(state);
          setPath(next, `hidden.heroines.${characterId}.${stat}`, Number(event.target.value));
          onState(next);
        }} />
        <output>{hidden[stat]}</output>
      </label>;
    })}
    <button type="button" onClick={() => onState(clone(runtime.initial_state))}>초기 상태로 복원</button>
  </section>;
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

export default function PresentationEditor({
  payload,
  locale,
  onLocale,
  mode,
  onMode,
  onStatus,
  onPayload,
  onIssues,
  onDocumentActivity,
}: Props) {
  const runtime = payload.runtime;
  const scenes = Object.values(runtime.scenes);
  const [sceneId, setSceneId] = useState(scenes[0]?.id || "");
  const scene = runtime.scenes[sceneId] || scenes[0];
  const [nodeId, setNodeId] = useState(scene?.start_node || "");
  const [previewState, setPreviewState] = useState<RuntimeState>(() => clone(runtime.initial_state));
  const [images, setImages] = useState<Record<string, string>>({});
  const [savingTranslation, setSavingTranslation] = useState(false);
  const [translationDirty, setTranslationDirty] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [savedAt, setSavedAt] = useState<number>();
  const resolver = useMemo(() => new VisualResolver(runtime), [runtime]);
  const i18n = useMemo(() => new LocalizationService(runtime, locale), [runtime, locale]);
  const rawNode = scene?.nodes[nodeId] || scene?.nodes[scene?.start_node];
  const resolvedDialogue = rawNode && (rawNode.kind === "dual_dialogue" || rawNode.kind === "dual_narration")
    ? resolveDialogueNode(runtime, previewState, rawNode)
    : undefined;
  const node = resolvedDialogue?.node || rawNode;
  const stage = scene && node ? resolver.resolveStage(scene, node.id, mode, node) : undefined;
  const coverage = i18n.coverage();
  const entryDecision = scene ? canEnterScene(runtime, previewState, scene.id) : undefined;
  const localeLabel = runtime.localization.locale_names[locale]?.native_name || locale;
  const defaultLocaleLabel = runtime.localization.locale_names[runtime.localization.default_locale]?.native_name
    || runtime.localization.default_locale;

  useEffect(() => {
    if (scene && !scene.nodes[nodeId]) setNodeId(scene.start_node);
  }, [nodeId, scene]);

  useEffect(() => {
    setPreviewState(clone(runtime.initial_state));
  }, [runtime]);

  useEffect(() => {
    if (!stage) return;
    const assets = [
      stage.background?.asset,
      ...stage.characters.map((character) => character.asset),
    ].filter((value): value is string => Boolean(value));
    assets.forEach((asset) => {
      if (images[asset]) return;
      invoke<string>("read_asset", { root: payload.root, relativePath: asset })
        .then((data) => setImages((current) => ({ ...current, [asset]: data })))
        .catch((error) => onStatus(`연출 자산을 읽지 못했습니다: ${String(error)}`));
    });
  }, [images, onStatus, payload.root, stage]);

  const saveTranslations = useCallback(async (strings: Record<string, string>): Promise<boolean> => {
    const localeDocument = runtime.localization.locales[locale];
    const metadata = payload.documents.locales[locale];
    if (!localeDocument || !metadata || locale === runtime.localization.default_locale) return false;
    setSavingTranslation(true);
    setSaveError(false);
    onStatus(`${localeLabel} 번역 전체를 검증하고 저장하는 중…`);
    try {
      const result = await invoke<{
        saved: boolean;
        issues: ValidationIssue[];
        runtime?: Runtime;
        document?: ProjectPayload["documents"]["locales"][string];
      }>("save_document", {
        root: payload.root,
        kind: "locales",
        document: { ...localeDocument, strings },
        revision: metadata.revision,
      });
      onIssues(result.issues);
      if (!result.saved || !result.runtime || !result.document) {
        setSaveError(true);
        onStatus("번역 전체 검증에 실패해 기존 locale 파일과 런타임을 유지했습니다.");
        return false;
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
      onStatus(`${localeLabel} 번역 파일과 런타임 카탈로그를 한 번에 저장했습니다.`);
      return true;
    } catch (error) {
      setSaveError(true);
      onStatus(`번역 저장 실패: ${String(error)}`);
      return false;
    } finally {
      setSavingTranslation(false);
    }
  }, [locale, localeLabel, onIssues, onPayload, onStatus, payload, runtime]);

  useEffect(() => {
    if (!scene) return;
    const isTranslation = locale !== runtime.localization.default_locale;
    onDocumentActivity({
      phase: savingTranslation ? "saving" : saveError ? "error" : translationDirty ? "dirty" : "saved",
      label: isTranslation ? `${localeLabel} 번역` : scene.title,
      path: isTranslation ? payload.documents.locales[locale]?.path || "" : payload.documents.scenes[scene.id]?.path || "",
      detail: savingTranslation ? "locale 파일 단위 트랜잭션 저장 중"
        : saveError ? "저장 실패 · 마지막 정상 파일과 런타임 보존됨"
          : translationDirty ? "여러 행 변경 · 자동 저장 대기" : isTranslation ? "번역 YAML + 런타임 동기화됨" : "기본 언어 원문 보기",
      savedAt,
    });
  }, [
    locale,
    localeLabel,
    onDocumentActivity,
    payload.documents.locales,
    payload.documents.scenes,
    runtime.localization.default_locale,
    saveError,
    savedAt,
    savingTranslation,
    scene,
    translationDirty,
  ]);

  if (!scene || !node || !stage) return <div className="presentation-empty">연출 가능한 장면이 없습니다.</div>;

  const backgrounds = Object.values(runtime.visuals).filter((visual) => visual.kind.includes("background"));
  const characters = Object.values(runtime.visuals).filter((visual) => visual.kind.includes("character"));

  return <div className="presentation-shell">
    <section className="presentation-main">
      <div className="presentation-toolbar">
        <div><p className="eyebrow">PRESENTATION DOMAIN</p><h2>연출·번역</h2><p>상태·문맥·variant와 번역을 실제 게임과 같은 판정기로 확인합니다.</p></div>
        <div className="presentation-controls">
          <label><span>언어</span><select value={locale} onChange={(event) => onLocale(event.target.value)}>
            {runtime.localization.supported_locales.map((id) =>
              <option value={id} key={id}>{runtime.localization.locale_names[id]?.native_name || id}</option>)}
          </select></label>
          <div className="segmented">
            <button type="button" className={mode === "perceived" ? "active" : ""} onClick={() => onMode("perceived")}>주인공 인식</button>
            <button type="button" className={mode === "reality" ? "active" : ""} onClick={() => onMode("reality")}>실제</button>
          </div>
        </div>
      </div>
      <div className="presentation-selector">
        <label><span>장면</span><select value={scene.id} onChange={(event) => {
          const next = runtime.scenes[event.target.value];
          setSceneId(next.id);
          setNodeId(next.start_node);
        }}>{scenes.map((item) => <option value={item.id} key={item.id}>{i18n.t(`scenes.${item.id}.title`, item.title)}</option>)}</select></label>
        <label><span>노드</span><select value={node.id} onChange={(event) => setNodeId(event.target.value)}>
          {scene.node_order.map((id) => <option value={id} key={id}>{id} · {scene.nodes[id].kind}</option>)}
        </select></label>
      </div>
      <StageCanvas
        runtime={runtime}
        scene={scene}
        node={node}
        stage={stage}
        locale={locale}
        variantId={resolvedDialogue?.variantId}
        images={images}
      />
      <div className="resolution-trace">
        <strong>장면 진입 판정</strong>
        <code>{entryDecision?.allowed ? "allowed" : "blocked"}</code>
        <span>{entryDecision?.trace.map((item) => `${item.condition.path}:${item.met ? "충족" : `불충족(${String(item.actual)})`}`).join(" · ") || "조건 없음"}</span>
        <small>player·simulator 공통 의미</small>
      </div>
      <div className="resolution-trace">
        <strong>배경 판정</strong>
        <code>{stage.background?.visual_id}.{stage.background?.variant_id}</code>
        <span>{stage.background?.matched.join(" · ") || "기본 규칙"}</span>
        <small>우선순위 점수 {stage.background?.score}</small>
      </div>
      {resolvedDialogue && <div className="resolution-trace">
        <strong>상황별 대사 판정</strong>
        <code>{resolvedDialogue.variantId}</code>
        <span>{resolvedDialogue.trace.map((item) => `${item.variantId}:${item.chosen ? "선택" : item.met ? "충족" : "불충족"}`).join(" · ")}</span>
        <small>현재 테스트 상태 기준</small>
      </div>}
      <StatePreviewControls runtime={runtime} scene={scene} state={previewState} onState={setPreviewState} />
    </section>

    <aside className="presentation-inspector">
      <section className="coverage-panel">
        <p className="eyebrow">LOCALIZATION</p>
        <h3>{localeLabel}</h3>
        <div className="coverage-meter"><span style={{ width: `${Math.max(2, (coverage?.ratio || 0) * 100)}%` }} /></div>
        <strong>{coverage?.direct ?? coverage?.translated ?? 0} / {coverage?.total || 0} 직접 번역</strong>
        <small>없는 문장은 {defaultLocaleLabel} 원문으로 대체되지만 번역 완료율에는 포함되지 않습니다.</small>
        <details><summary>원문 대체 키 {coverage?.fallback_used?.length || 0}개</summary>
          <div className="missing-keys">{coverage?.fallback_used?.slice(0, 40).map((key) => <code key={key}>{key}</code>)}</div>
        </details>
      </section>
      <section className="visual-hierarchy">
        <p className="eyebrow">OBJECT HIERARCHY</p><h3>배경 객체</h3>
        {backgrounds.map((visual) => <VisualObjectRow visual={visual} i18n={i18n} key={visual.id} />)}
        <h3>캐릭터 객체</h3>
        {characters.map((visual) => <VisualObjectRow visual={visual} i18n={i18n} key={visual.id} />)}
      </section>
    </aside>

    <div className="presentation-localization-workspace">
      <LocalizationTable
        root={payload.root}
        runtime={runtime}
        locale={locale}
        sceneId={scene.id}
        nodeId={node.id}
        saving={savingTranslation}
        revision={payload.documents.locales[locale]?.revision || ""}
        onSave={saveTranslations}
        onDirtyChange={setTranslationDirty}
        onNavigate={(entry) => {
          const targetScene = entry.context.sceneId;
          if (!targetScene || !runtime.scenes[targetScene]) return;
          setSceneId(targetScene);
          setNodeId(entry.context.nodeId && runtime.scenes[targetScene].nodes[entry.context.nodeId]
            ? entry.context.nodeId
            : runtime.scenes[targetScene].start_node);
        }}
      />
    </div>
  </div>;
}
