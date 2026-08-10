import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { characterArtworkOptions, VisualResolver, type CharacterArtworkOption } from "./presentation";
import type { ArtworkPosition, Runtime, Scene, StageCharacterCue, StoryNode, ViewMode } from "./types";

const POSITIONS: Array<{ id: ArtworkPosition; label: string }> = [
  { id: "left", label: "왼쪽" },
  { id: "center", label: "가운데" },
  { id: "right", label: "오른쪽" },
];

function AssetThumbnail({ root, path, alt }: { root: string; path?: string; alt: string }) {
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
  return source ? <img src={source} alt={alt} /> : <span className="artwork-thumbnail-placeholder">NO IMAGE</span>;
}

function cueOption(runtime: Runtime, cue: StageCharacterCue | undefined): CharacterArtworkOption | undefined {
  if (!cue) return undefined;
  return characterArtworkOptions(runtime, cue.character).find((option) =>
    option.visual_id === cue.visual_id && option.id === cue.artwork);
}

function automaticCues(runtime: Runtime, scene: Scene, node: StoryNode, mode: ViewMode): StageCharacterCue[] {
  const stage = new VisualResolver(runtime).resolveStage(scene, node.id, mode, node);
  return stage.characters.flatMap((character): StageCharacterCue[] => {
    const option = characterArtworkOptions(runtime, character.character).find((candidate) =>
      candidate.visual_id === character.visual_id
      && candidate.id === (character.artwork || character.expression || "default"));
    return option ? [{
      position: character.position === "left" || character.position === "right" ? character.position : "center",
      character: character.character,
      visual_id: option.visual_id,
      artwork: option.id,
    }] : [];
  });
}

type ArtworkPickerProps = {
  root: string;
  runtime: Runtime;
  scene: Scene;
  position: ArtworkPosition;
  mode: ViewMode;
  current?: StageCharacterCue;
  onPick: (option?: CharacterArtworkOption) => void;
  onClose: () => void;
};

function ArtworkPicker({ root, runtime, scene, position, mode, current, onPick, onClose }: ArtworkPickerProps) {
  const characters = useMemo(() => scene.cast
    .map((id) => runtime.characters[id])
    .filter((character) => character && characterArtworkOptions(runtime, character.id, mode).length), [mode, runtime, scene.cast]);
  const [characterId, setCharacterId] = useState(current?.character || characters[0]?.id || "");
  const options = characterId ? characterArtworkOptions(runtime, characterId, mode) : [];

  return <div className="artwork-picker-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="artwork-picker" role="dialog" aria-modal="true" aria-label={`${position} 원화 선택`}>
      <header>
        <div><p className="eyebrow">CHARACTER ARTWORK</p><h2>{POSITIONS.find((item) => item.id === position)?.label} 원화 선택</h2></div>
        <button type="button" aria-label="닫기" onClick={onClose}>×</button>
      </header>
      <nav className="artwork-character-tabs" aria-label="캐릭터별 원화 디렉토리">
        {characters.map((character) => <button type="button" className={character.id === characterId ? "active" : ""} onClick={() => setCharacterId(character.id)} key={character.id}>
          {character.display_name}<small>{characterArtworkOptions(runtime, character.id, mode).length}개</small>
        </button>)}
      </nav>
      <div className="artwork-picker-grid">
        <button type="button" className="artwork-picker-card off" onClick={() => onPick(undefined)}>
          <span>OFF</span><strong>이 위치 비우기</strong><small>아무 원화도 표시하지 않음</small>
        </button>
        {options.map((option) => <button type="button" className={current?.visual_id === option.visual_id && current.artwork === option.id ? "artwork-picker-card selected" : "artwork-picker-card"} onClick={() => onPick(option)} key={`${option.visual_id}:${option.id}`}>
          <AssetThumbnail root={root} path={option.asset} alt={option.label} />
          <strong>{option.label}</strong>
          <small>{runtime.characters[option.character]?.display_name}</small>
        </button>)}
      </div>
      {characters.length === 0 && <p className="artwork-picker-empty">이 장면의 출연 인물에 등록된 원화가 없습니다. 장면 탭에서 출연 인물을 먼저 추가해 주세요.</p>}
    </section>
  </div>;
}

export default function ArtworkStageEditor({
  root,
  runtime,
  scene,
  node,
  mode,
  onMode,
  onChange,
}: {
  root: string;
  runtime: Runtime;
  scene: Scene;
  node: StoryNode;
  mode: ViewMode;
  onMode: (mode: ViewMode) => void;
  onChange: (node: StoryNode) => void;
}) {
  const [pickerPosition, setPickerPosition] = useState<ArtworkPosition | null>(null);
  const manual = Boolean(node.stage && Object.prototype.hasOwnProperty.call(node.stage, mode));
  const cues = manual ? node.stage?.[mode] || [] : automaticCues(runtime, scene, node, mode);

  const setCues = (next: StageCharacterCue[]) => onChange({
    ...node,
    stage: { ...(node.stage || {}), [mode]: next },
  });
  const resetAutomatic = () => {
    const stage = { ...(node.stage || {}) };
    delete stage[mode];
    onChange({ ...node, stage: Object.keys(stage).length ? stage : undefined });
  };
  const choose = (position: ArtworkPosition, option?: CharacterArtworkOption) => {
    const base = manual ? [...cues] : automaticCues(runtime, scene, node, mode);
    const withoutPosition = base.filter((cue) => cue.position !== position);
    const withoutDuplicate = option
      ? withoutPosition.filter((cue) => cue.character !== option.character)
      : withoutPosition;
    setCues(option ? [...withoutDuplicate, {
      position,
      character: option.character,
      visual_id: option.visual_id,
      artwork: option.id,
    }] : withoutDuplicate);
    setPickerPosition(null);
  };

  return <section className="artwork-stage-editor">
    <header>
      <div><strong>화면 원화</strong><small>화자와 별개로 한 위치에 한 명씩, 최대 3명</small></div>
      <div className="artwork-stage-mode">
        <button type="button" className={mode === "perceived" ? "active" : ""} onClick={() => onMode("perceived")}>스토리 모드</button>
        <button type="button" className={mode === "reality" ? "active" : ""} onClick={() => onMode("reality")}>속마음 모드</button>
      </div>
    </header>
    <div className="artwork-stage-toolbar">
      <span className={manual ? "manual" : "auto"}>{manual ? "직접 배치" : "화자 자동 표시"}</span>
      <button type="button" onClick={resetAutomatic} disabled={!manual}>화자 자동</button>
      <button type="button" onClick={() => setCues([])}>원화 모두 끄기</button>
    </div>
    <div className="artwork-stage-slots">
      {POSITIONS.map(({ id, label }) => {
        const cue = cues.find((item) => item.position === id);
        const option = cueOption(runtime, cue);
        return <button type="button" className={cue ? "artwork-stage-slot filled" : "artwork-stage-slot"} onClick={() => setPickerPosition(id)} key={id}>
          <span>{label}</span>
          {cue && option ? <>
            <AssetThumbnail root={root} path={option.asset} alt={option.label} />
            <strong>{runtime.characters[cue.character]?.display_name || cue.character}</strong>
            <small>{option.label}</small>
          </> : <><b>＋</b><strong>원화 선택</strong><small>{manual ? "OFF" : id === "center" && cues.length ? "자동 배치" : "비어 있음"}</small></>}
        </button>;
      })}
    </div>
    {pickerPosition && <ArtworkPicker
      root={root}
      runtime={runtime}
      scene={scene}
      position={pickerPosition}
      mode={mode}
      current={cues.find((cue) => cue.position === pickerPosition)}
      onPick={(option) => choose(pickerPosition, option)}
      onClose={() => setPickerPosition(null)}
    />}
  </section>;
}
