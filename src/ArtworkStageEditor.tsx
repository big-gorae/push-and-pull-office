import { useMemo, useState } from "react";
import { useAssetPreview } from "./assetPreview";
import { characterArtworkOptions, type CharacterArtworkOption } from "./presentation";
import type { ArtworkPosition, Runtime, Scene, StageCharacterCue, StoryNode } from "./types";
import { canRevealProtagonistArtwork, isProtagonistArtwork } from "./protagonistArtworkPolicy";

const POSITIONS: Array<{ id: ArtworkPosition; label: string }> = [
  { id: "left", label: "왼쪽" },
  { id: "center", label: "가운데" },
  { id: "right", label: "오른쪽" },
];

function AssetThumbnail({ root, path, alt }: { root: string; path?: string; alt: string }) {
  const source = useAssetPreview(root, path);
  return source ? <img src={source} alt={alt} /> : <span className="artwork-thumbnail-placeholder">NO IMAGE</span>;
}

function cueOption(runtime: Runtime, cue: StageCharacterCue | undefined): CharacterArtworkOption | undefined {
  if (!cue) return undefined;
  return characterArtworkOptions(runtime, cue.character).find((option) =>
    option.visual_id === cue.visual_id && option.id === cue.artwork);
}

type ArtworkPickerProps = {
  root: string;
  runtime: Runtime;
  scene: Scene;
  position: ArtworkPosition;
  allowProtagonistArtwork: boolean;
  current?: StageCharacterCue;
  onPick: (option?: CharacterArtworkOption) => void;
  onClose: () => void;
};

function ArtworkPicker({ root, runtime, scene, position, allowProtagonistArtwork, current, onPick, onClose }: ArtworkPickerProps) {
  const characters = useMemo(() => scene.cast
    .map((id) => runtime.characters[id])
    .filter((character) => character && (allowProtagonistArtwork || !isProtagonistArtwork(character.id)))
    .filter((character) => character && characterArtworkOptions(runtime, character.id).length), [allowProtagonistArtwork, runtime, scene.cast]);
  const [characterId, setCharacterId] = useState(current?.character || characters[0]?.id || "");
  const options = characterId && (allowProtagonistArtwork || !isProtagonistArtwork(characterId))
    ? characterArtworkOptions(runtime, characterId)
    : [];

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
          {character.display_name}<small>{characterArtworkOptions(runtime, character.id).length}개</small>
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
  onChange,
}: {
  root: string;
  runtime: Runtime;
  scene: Scene;
  node: StoryNode;
  onChange: (node: StoryNode) => void;
}) {
  const [pickerPosition, setPickerPosition] = useState<ArtworkPosition | null>(null);
  const allowProtagonistArtwork = canRevealProtagonistArtwork(scene, node);
  const manual = node.stage !== undefined;
  const cues = node.stage || [];

  const setCues = (next: StageCharacterCue[]) => onChange({
    ...node,
    stage: next,
  });
  const choose = (position: ArtworkPosition, option?: CharacterArtworkOption) => {
    const withoutPosition = cues.filter((cue) => cue.position !== position);
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
    </header>
    {!allowProtagonistArtwork && scene.cast.includes("han_do_yoon") && <p className="artwork-stage-policy-note">서정우 원화는 후반 반전 공개 노드에서만 선택할 수 있습니다.</p>}
    <div className="artwork-stage-toolbar">
      <span className={manual ? "manual" : "auto"}>{manual ? "명시적 배치" : "원화 미지정"}</span>
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
          </> : <><b>＋</b><strong>원화 선택</strong><small>{manual ? "OFF" : "비어 있음"}</small></>}
        </button>;
      })}
    </div>
    {pickerPosition && <ArtworkPicker
      root={root}
      runtime={runtime}
      scene={scene}
      position={pickerPosition}
      allowProtagonistArtwork={allowProtagonistArtwork}
      current={cues.find((cue) => cue.position === pickerPosition)}
      onPick={(option) => choose(pickerPosition, option)}
      onClose={() => setPickerPosition(null)}
    />}
  </section>;
}
