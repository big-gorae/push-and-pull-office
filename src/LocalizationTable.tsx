import { useEffect, useMemo, useRef, useState } from "react";
import type { LocaleId, LocalizationEntry, Runtime } from "./types";

type TranslationStatus = "all" | "direct" | "fallback" | "missing" | "invalid" | "orphan";
type TranslationScope = "node" | "scene" | "all";

export type LocalizationRow = {
  key: string;
  entry?: LocalizationEntry;
  source: string;
  status: Exclude<TranslationStatus, "all">;
};

export function buildLocalizationRows(runtime: Runtime, locale: LocaleId): LocalizationRow[] {
  const defaultLocale = runtime.localization.default_locale;
  const entries = runtime.localization.entries || {};
  const stored = runtime.localization.locales[locale]?.strings || {};
  const invalid = new Set(runtime.localization.coverage[locale]?.invalid_placeholders || []);
  const normal = Object.values(entries).map((entry) => {
    const direct = locale === defaultLocale || Object.hasOwn(stored, entry.key);
    const resolved = Boolean(runtime.localization.resolved_catalogs?.[locale]?.[entry.key]);
    return {
      key: entry.key,
      entry,
      source: entry.source,
      status: invalid.has(entry.key) ? "invalid" : direct ? "direct" : resolved ? "fallback" : "missing",
    } satisfies LocalizationRow;
  });
  const orphans = Object.keys(stored)
    .filter((key) => !entries[key])
    .map((key) => ({ key, source: "", status: "orphan" as const }));
  return [...normal, ...orphans].sort((left, right) => left.key.localeCompare(right.key));
}

type Props = {
  root: string;
  runtime: Runtime;
  locale: LocaleId;
  sceneId: string;
  nodeId: string;
  saving: boolean;
  revision: string;
  onSave: (strings: Record<string, string>) => Promise<boolean>;
  onNavigate: (entry: LocalizationEntry) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

function csvCell(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function parseCsv(text: string): Array<{ key: string; translation: string }> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\"" && quoted && text[index + 1] === "\"") {
      cell += "\"";
      index += 1;
    } else if (character === "\"") quoted = !quoted;
    else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  const [header, ...data] = rows;
  const keyIndex = header?.indexOf("key") ?? -1;
  const translationIndex = header?.indexOf("translation") ?? -1;
  if (keyIndex < 0 || translationIndex < 0) return [];
  return data
    .filter((values) => values[keyIndex])
    .map((values) => ({ key: values[keyIndex], translation: values[translationIndex] || "" }));
}

function parseXliff(text: string): Array<{ key: string; translation: string }> {
  const documentValue = new DOMParser().parseFromString(text, "application/xml");
  return Array.from(documentValue.querySelectorAll("trans-unit")).flatMap((unit) => {
    const key = unit.getAttribute("id");
    return key ? [{ key, translation: unit.querySelector("target")?.textContent || "" }] : [];
  });
}

function download(name: string, type: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function LocalizationTable({
  root,
  runtime,
  locale,
  sceneId,
  nodeId,
  saving,
  revision,
  onSave,
  onNavigate,
  onDirtyChange,
}: Props) {
  const defaultLocale = runtime.localization.default_locale;
  const localeDocument = runtime.localization.locales[locale];
  const stored = localeDocument?.strings || {};
  const entries = runtime.localization.entries || {};
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<TranslationScope>("node");
  const [domain, setDomain] = useState("all");
  const [status, setStatus] = useState<TranslationStatus>("all");
  const [importError, setImportError] = useState("");
  const lastAutoSave = useRef("");

  useEffect(() => {
    const next = { ...stored };
    if (locale !== defaultLocale) {
      Object.keys(entries).forEach((key) => {
        const recoveryKey = `love-office-translation-draft:${root}:${locale}:${key}`;
        const recovery = localStorage.getItem(recoveryKey);
        if (!recovery) return;
        try {
          const parsed = JSON.parse(recovery) as { revision: string; text: string };
          if (parsed.revision === revision) next[key] = parsed.text;
          else localStorage.removeItem(recoveryKey);
        } catch {
          localStorage.removeItem(recoveryKey);
        }
      });
    }
    setDrafts(next);
    lastAutoSave.current = "";
  }, [defaultLocale, entries, locale, revision, root, runtime.localization.locales]);

  const dirtyKeys = useMemo(() => {
    const keys = new Set([...Object.keys(stored), ...Object.keys(drafts)]);
    return [...keys].filter((key) => (drafts[key] || "") !== (stored[key] || ""));
  }, [drafts, stored]);

  useEffect(() => {
    onDirtyChange?.(dirtyKeys.length > 0);
  }, [dirtyKeys.length, onDirtyChange]);

  const rows = useMemo(() => buildLocalizationRows(runtime, locale), [locale, runtime]);

  const domains = useMemo(() =>
    ["all", ...new Set(Object.values(entries).map((entry) => entry.domain))], [entries]);

  const visibleRows = rows.filter((row) => {
    const context = row.entry?.context;
    if (scope === "scene" && context?.sceneId !== sceneId) return false;
    if (scope === "node" && (
      context?.sceneId !== sceneId
      || (context.nodeId !== undefined && context.nodeId !== nodeId)
    )) return false;
    if (domain !== "all" && row.entry?.domain !== domain) return false;
    if (status !== "all" && row.status !== status) return false;
    const normalized = query.trim().toLocaleLowerCase();
    return !normalized || [
      row.key,
      row.source,
      drafts[row.key],
      row.entry?.context.speakerId,
      row.entry?.context.layer,
      row.entry?.sourceDocument.path,
    ].filter(Boolean).join("\n").toLocaleLowerCase().includes(normalized);
  });

  const normalizedStrings = (): Record<string, string> => Object.fromEntries(
    Object.entries(drafts).filter(([, value]) => value.trim()),
  );

  const save = async () => {
    if (!dirtyKeys.length || locale === defaultLocale || saving) return;
    const success = await onSave(normalizedStrings());
    if (success) {
      dirtyKeys.forEach((key) =>
        localStorage.removeItem(`love-office-translation-draft:${root}:${locale}:${key}`));
    }
  };

  useEffect(() => {
    if (!dirtyKeys.length || locale === defaultLocale || saving) return;
    dirtyKeys.forEach((key) => {
      localStorage.setItem(
        `love-office-translation-draft:${root}:${locale}:${key}`,
        JSON.stringify({ revision, text: drafts[key] || "" }),
      );
    });
    const signature = JSON.stringify(dirtyKeys.map((key) => [key, drafts[key] || ""]));
    if (signature === lastAutoSave.current) return;
    const timer = window.setTimeout(() => {
      lastAutoSave.current = signature;
      void save();
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [defaultLocale, dirtyKeys, drafts, locale, revision, root, saving]);

  const exportCsv = () => {
    const content = [
      ["key", "domain", "source", "translation", "status"].map(csvCell).join(","),
      ...rows.map((row) => [
        row.key,
        row.entry?.domain || "",
        row.source,
        drafts[row.key] || "",
        row.status,
      ].map(csvCell).join(",")),
    ].join("\n");
    download(`love-office-${locale}.csv`, "text/csv;charset=utf-8", content);
  };

  const exportXliff = () => {
    const escape = (value: string) => value
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;");
    const units = rows.map((row) =>
      `<trans-unit id="${escape(row.key)}"><source>${escape(row.source)}</source><target>${escape(drafts[row.key] || "")}</target></trans-unit>`,
    ).join("");
    download(
      `love-office-${locale}.xlf`,
      "application/xliff+xml;charset=utf-8",
      `<?xml version="1.0" encoding="UTF-8"?><xliff version="1.2"><file source-language="${defaultLocale}" target-language="${locale}"><body>${units}</body></file></xliff>`,
    );
  };

  const importFile = async (file?: File) => {
    if (!file) return;
    const parsed = file.name.endsWith(".csv") ? parseCsv(await file.text()) : parseXliff(await file.text());
    const unknown = parsed.filter((item) => !entries[item.key]).map((item) => item.key);
    if (unknown.length) {
      setImportError(`레지스트리에 없는 키 ${unknown.length}개는 가져오지 않았습니다.`);
    } else setImportError("");
    setDrafts((current) => ({
      ...current,
      ...Object.fromEntries(parsed.filter((item) => entries[item.key]).map((item) => [item.key, item.translation])),
    }));
  };

  return <section className="localization-table">
    <header>
      <div><strong>전체 문자열 표</strong><small>{visibleRows.length} / {rows.length}개 · 변경 {dirtyKeys.length}개</small></div>
      <div className="localization-table-actions">
        <button type="button" onClick={exportCsv}>CSV 내보내기</button>
        <button type="button" onClick={exportXliff}>XLIFF 내보내기</button>
        <label className="file-button">가져오기<input type="file" accept=".csv,.xlf,.xliff" onChange={(event) => void importFile(event.target.files?.[0])} /></label>
        <button type="button" disabled={!dirtyKeys.length || saving || locale === defaultLocale} onClick={() => void save()}>{saving ? "저장 중…" : "전체 저장"}</button>
      </div>
    </header>
    <div className="localization-table-filters">
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="키·원문·번역·화자·출처 검색" />
      <select value={scope} onChange={(event) => setScope(event.target.value as TranslationScope)}>
        <option value="node">현재 노드 문맥</option>
        <option value="scene">현재 장면 문맥</option>
        <option value="all">전체 문맥</option>
      </select>
      <select value={domain} onChange={(event) => setDomain(event.target.value)}>
        {domains.map((value) => <option value={value} key={value}>{value === "all" ? "모든 도메인" : value}</option>)}
      </select>
      <select value={status} onChange={(event) => setStatus(event.target.value as TranslationStatus)}>
        <option value="all">모든 상태</option>
        <option value="direct">직접 번역</option>
        <option value="fallback">원문 대체</option>
        <option value="missing">누락</option>
        <option value="invalid">변수 오류</option>
        <option value="orphan">고아 키</option>
      </select>
    </div>
    {importError && <p className="localization-import-error">{importError}</p>}
    <div className="localization-table-grid" role="table" aria-label="번역 문자열">
      {visibleRows.map((row) => <article className={`localization-row ${row.status}`} role="row" key={row.key}>
        <div className="localization-row-meta">
          <button type="button" disabled={!row.entry?.context.sceneId} onClick={() => row.entry && onNavigate(row.entry)}>
            <code>{row.key}</code>
          </button>
          <span>{row.entry?.domain || "orphan"} · {row.status}</span>
          {row.entry && <small>{row.entry.context.speakerId || "—"} · {row.entry.context.layer || "—"} · {row.entry.sourceDocument.path}</small>}
        </div>
        <label><span>원문</span><textarea readOnly rows={row.entry?.multiline ? 4 : 2} value={row.source} /></label>
        <label><span>번역</span><textarea
          readOnly={locale === defaultLocale}
          rows={row.entry?.multiline ? 4 : 2}
          value={locale === defaultLocale ? row.source : drafts[row.key] || ""}
          placeholder={row.status === "fallback" ? `Fallback: ${runtime.localization.resolved_catalogs?.[locale]?.[row.key] || row.source}` : "번역 입력"}
          onChange={(event) => setDrafts((current) => ({ ...current, [row.key]: event.target.value }))}
        /></label>
      </article>)}
      {!visibleRows.length && <p className="localization-empty">조건에 맞는 문자열이 없습니다.</p>}
    </div>
  </section>;
}
