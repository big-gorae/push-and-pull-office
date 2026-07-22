import { useEffect, useMemo, useRef, useState } from "react";

export type QuickOpenItem = {
  id: string;
  kind: "scene" | "event" | "character" | "campaign" | "route" | "thread" | "meta" | "visual";
  title: string;
  context: string;
  path: string;
  search: string;
};

type Props = {
  items: QuickOpenItem[];
  onClose: () => void;
  onPick: (item: QuickOpenItem) => void;
};

export default function QuickOpen({ items, onClose, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => {
    const normalized = query.toLocaleLowerCase().trim();
    const words = normalized.split(/\s+/).filter(Boolean);
    if (!words.length) return items.slice(0, 18);
    const rank = (item: QuickOpenItem) => {
      const title = item.title.toLocaleLowerCase();
      const context = item.context.toLocaleLowerCase();
      if (title === normalized) return 0;
      if (title.startsWith(normalized)) return 1;
      if (title.includes(normalized)) return 2;
      if (context.includes(normalized)) return 3;
      return 4;
    };
    return items
      .filter((item) => words.every((word) => item.search.includes(word)))
      .sort((left, right) => rank(left) - rank(right))
      .slice(0, 24);
  }, [items, query]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setActiveIndex(0), [query]);

  const choose = (index: number) => {
    const item = filtered[index];
    if (item) onPick(item);
  };

  return <div className="quick-open-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="quick-open" role="dialog" aria-modal="true" aria-label="스토리 문서 빠른 열기">
      <div className="quick-open-input">
        <span aria-hidden="true">⌕</span>
        <input
          ref={inputRef}
          value={query}
          placeholder="장면, 사건, 인물, 루트, 비주얼 검색…"
          aria-label="스토리 문서 검색"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((value) => Math.min(filtered.length - 1, value + 1));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((value) => Math.max(0, value - 1));
            }
            if (event.key === "Enter") {
              event.preventDefault();
              choose(activeIndex);
            }
          }}
        />
        <kbd>esc</kbd>
      </div>
      <div className="quick-open-results" role="listbox">
        {filtered.map((item, index) => <button
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={index === activeIndex ? "quick-open-result active" : "quick-open-result"}
          key={`${item.kind}:${item.id}`}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => onPick(item)}
        >
          <span className={`quick-kind ${item.kind}`}>{item.kind === "scene" ? "장면" : item.kind === "event" ? "사건" : item.kind === "character" ? "인물" : item.kind === "campaign" ? "시간" : item.kind === "route" ? "루트" : item.kind === "thread" ? "연결" : item.kind === "meta" ? "해금" : "자산"}</span>
          <span><strong>{item.title}</strong><small>{item.context}</small></span>
          <code>{item.path}</code>
        </button>)}
        {!filtered.length && <div className="quick-open-empty">일치하는 스토리 문서가 없습니다.</div>}
      </div>
      <footer><span><kbd>↑</kbd><kbd>↓</kbd> 이동</span><span><kbd>↵</kbd> 열기</span><span>해당 편집 화면으로 바로 이동합니다</span></footer>
    </section>
  </div>;
}
