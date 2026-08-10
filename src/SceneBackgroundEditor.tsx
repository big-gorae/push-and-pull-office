import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { VisualResolver } from "./presentation";
import type { Runtime, Scene, SceneBackgroundCue } from "./types";

type BackgroundOption = SceneBackgroundCue & {
  asset: string;
  title: string;
  details: string;
};

function backgroundOptions(runtime: Runtime): BackgroundOption[] {
  return Object.values(runtime.visuals)
    .filter((visual) => visual.kind === "background" && !visual.abstract)
    .flatMap((visual) => Object.entries(visual.variants || {}).map(([variantId, variant]) => ({
      visual_id: visual.id,
      variant_id: variantId,
      asset: variant.asset,
      title: visual.title || visual.id,
      details: [
        ...(variant.match?.locations || []),
        ...(variant.match?.times || []),
        ...(variant.match?.atmospheres || []),
      ].join(" · ") || variantId,
    })))
    .sort((left, right) => left.title.localeCompare(right.title, "ko") || left.variant_id.localeCompare(right.variant_id));
}

function BackgroundThumbnail({ root, path, alt }: { root: string; path?: string; alt: string }) {
  const [source, setSource] = useState("");
  useEffect(() => {
    let active = true;
    setSource("");
    if (!path) return () => { active = false; };
    void invoke<string>("read_asset", { root, relativePath: path })
      .then((value) => { if (active) setSource(value); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [path, root]);
  return source
    ? <img src={source} alt={alt} />
    : <span className="background-thumbnail-placeholder">NO IMAGE</span>;
}

export default function SceneBackgroundEditor({
  root,
  runtime,
  scene,
  onChange,
}: {
  root: string;
  runtime: Runtime;
  scene: Scene;
  onChange: (background?: SceneBackgroundCue) => void;
}) {
  const [open, setOpen] = useState(false);
  const options = useMemo(() => backgroundOptions(runtime), [runtime]);
  const selected = scene.default_background
    ? options.find((option) => option.visual_id === scene.default_background?.visual_id
      && option.variant_id === scene.default_background?.variant_id)
    : undefined;
  const automatic = useMemo(() => {
    const node = scene.nodes[scene.start_node];
    return new VisualResolver(runtime).resolveBackground(scene, node, "perceived");
  }, [runtime, scene]);
  const preview = selected || (automatic ? {
    visual_id: automatic.visual_id,
    variant_id: automatic.variant_id,
    asset: automatic.asset,
    title: runtime.visuals[automatic.visual_id]?.title || automatic.visual_id,
    details: "장소·시간·분위기로 자동 선택",
  } : undefined);

  const choose = (option?: BackgroundOption) => {
    onChange(option ? { visual_id: option.visual_id, variant_id: option.variant_id } : undefined);
    setOpen(false);
  };

  return <section className="scene-background-editor">
    <header>
      <div><strong>씬 기본 배경</strong><small>이 씬 전체에서 기본으로 사용할 배경입니다.</small></div>
      <span className={scene.default_background ? "fixed" : "auto"}>{scene.default_background ? "직접 선택" : "자동 선택"}</span>
    </header>
    <button type="button" className="scene-background-current" onClick={() => setOpen(true)}>
      <BackgroundThumbnail root={root} path={preview?.asset} alt={preview?.title || "씬 배경"} />
      <span><strong>{preview?.title || "선택 가능한 배경 없음"}</strong><small>{preview ? `${preview.variant_id} · ${preview.details}` : "비주얼 설정에서 배경을 등록해 주세요."}</small></span>
      <b>배경 선택</b>
    </button>
    {open && <div className="background-picker-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) setOpen(false);
    }}>
      <section className="background-picker" role="dialog" aria-modal="true" aria-label="씬 기본 배경 선택">
        <header><div><p className="eyebrow">SCENE BACKGROUND</p><h2>씬 기본 배경 선택</h2></div><button type="button" aria-label="닫기" onClick={() => setOpen(false)}>×</button></header>
        <div className="background-picker-grid">
          <button type="button" className={!scene.default_background ? "background-picker-card selected auto" : "background-picker-card auto"} onClick={() => choose(undefined)}>
            <span>AUTO</span><strong>자동 선택</strong><small>장소·시간·분위기 규칙 사용</small>
          </button>
          {options.map((option) => <button
            type="button"
            className={selected?.visual_id === option.visual_id && selected.variant_id === option.variant_id ? "background-picker-card selected" : "background-picker-card"}
            onClick={() => choose(option)}
            key={`${option.visual_id}:${option.variant_id}`}
          >
            <BackgroundThumbnail root={root} path={option.asset} alt={option.title} />
            <strong>{option.title}</strong>
            <small>{option.variant_id} · {option.details}</small>
          </button>)}
        </div>
      </section>
    </div>}
  </section>;
}
