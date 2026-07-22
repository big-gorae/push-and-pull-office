import { useEffect, useMemo, useRef, useState } from "react";

export function suggestedCopyId(sourceId: string, existingIds: string[]) {
  const occupied = new Set(existingIds);
  let candidate = `${sourceId}_copy`;
  let index = 2;
  while (occupied.has(candidate)) candidate = `${sourceId}_copy_${index++}`;
  return candidate;
}

type Props = {
  kind: "scene" | "event";
  sourceId: string;
  sourceTitle: string;
  existingIds: string[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (newId: string, title: string) => void;
};

export default function DuplicateDialog({ kind, sourceId, sourceTitle, existingIds, busy, onCancel, onSubmit }: Props) {
  const suggestedId = useMemo(() => suggestedCopyId(sourceId, existingIds), [existingIds, sourceId]);
  const [newId, setNewId] = useState(suggestedId);
  const [title, setTitle] = useState(`${sourceTitle} 복사본`);
  const inputRef = useRef<HTMLInputElement>(null);
  const validId = /^[a-z][a-z0-9_.]*$/.test(newId) && !existingIds.includes(newId);
  const valid = validId && Boolean(title.trim());
  const basename = newId.includes(".") ? newId.slice(newId.lastIndexOf(".") + 1) : newId;

  useEffect(() => inputRef.current?.select(), []);

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (!busy && event.target === event.currentTarget) onCancel();
  }}>
    <form className="duplicate-dialog" role="dialog" aria-modal="true" aria-label={`${kind === "scene" ? "장면" : "사건"} 복제`} onSubmit={(event) => {
      event.preventDefault();
      if (valid && !busy) onSubmit(newId, title.trim());
    }}>
      <header><div><p className="eyebrow">SAFE DUPLICATE</p><h2>{kind === "scene" ? "장면과 일정 함께 복제" : "시간 사건 복제"}</h2></div><button type="button" className="icon-button" aria-label="닫기" onClick={onCancel} disabled={busy}>×</button></header>
      <p className="duplicate-source"><span>원본</span><strong>{sourceTitle}</strong><code>{sourceId}</code></p>
      <label className="field"><span>새 제목</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="field"><span>새 ID</span><input ref={inputRef} value={newId} spellCheck={false} onChange={(event) => setNewId(event.target.value.toLocaleLowerCase().replace(/\s+/g, "_"))} /></label>
      {!validId && <p className="field-error">영문 소문자로 시작하고 소문자·숫자·밑줄·점만 사용해야 하며 기존 ID와 달라야 합니다.</p>}
      <div className="duplicate-destination"><span>생성될 파일</span><code>원본과 같은 폴더/{basename || "new_document"}.yaml</code><small>{kind === "scene" ? "장면 YAML + 연결 시간 사건 YAML + 루트·스레드 순서를 한 번에 갱신합니다." : "사건 YAML + 소속 스레드 순서를 한 번에 갱신합니다."}</small></div>
      <div className="duplicate-safety"><strong>안전 저장</strong><span>전체 프로젝트를 먼저 복사 검증하고, 모두 성공할 때만 실제 파일을 만듭니다. 실패하면 생성 파일과 참조 변경을 되돌립니다.</span></div>
      <footer><button type="button" onClick={onCancel} disabled={busy}>취소</button><button type="submit" className="primary-button" disabled={!valid || busy}>{busy ? "검증하고 만드는 중…" : `${kind === "scene" ? "장면" : "사건"} 복제`}</button></footer>
    </form>
  </div>;
}
