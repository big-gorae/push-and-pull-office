import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { loadPromptCatalog } from "./promptCatalog";
import { composePrompt } from "./promptComposer";
import "./prompt-builder.css";

type CopyTarget = "combined" | "uc" | "base" | "character";

type CopyFeedback = {
  target?: CopyTarget;
  message: string;
  failed?: boolean;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function copyFallback(value: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

async function writeClipboard(value: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  if (!copyFallback(value)) throw new Error("Clipboard API를 사용할 수 없습니다.");
}

function ChoiceCard({
  name,
  value,
  checked,
  title,
  description,
  mark,
  accent,
  kind = "character",
  onChange,
}: {
  name: string;
  value: string;
  checked: boolean;
  title: string;
  description?: string;
  mark?: string;
  accent?: string;
  kind?: "character" | "situation" | "segment";
  onChange: (value: string) => void;
}) {
  const style = accent ? { "--prompt-card-accent": accent } as CSSProperties : undefined;
  return <label className="prompt-choice-card" style={style}>
    <input type="radio" name={name} value={value} checked={checked} onChange={() => onChange(value)} />
    <span className="prompt-choice-surface">
      {kind === "character" && <span className="prompt-character-mark" aria-hidden="true">{mark || title.slice(0, 1)}</span>}
      {kind === "situation" && mark && <span className="prompt-situation-index" aria-hidden="true">{mark}</span>}
      <span className={kind === "situation" ? "prompt-situation-copy" : "prompt-character-copy"}>
        <strong>{title}</strong>
        {description && <small>{description}</small>}
      </span>
    </span>
  </label>;
}

function PromptOutput({
  target,
  title,
  hint,
  value,
  primary = false,
  uc = false,
  feedback,
  onCopy,
}: {
  target: CopyTarget;
  title: string;
  hint: string;
  value: string;
  primary?: boolean;
  uc?: boolean;
  feedback: CopyFeedback;
  onCopy: (target: CopyTarget, title: string, value: string) => void;
}) {
  const copied = feedback.target === target && !feedback.failed;
  const id = `prompt-output-${target}`;
  return <section className={`prompt-output-card ${primary ? "primary" : ""}`}>
    <header>
      <span className="prompt-output-title"><strong>{title}</strong><small>{hint}</small></span>
      <button
        type="button"
        className={`prompt-copy-button ${primary ? "" : "secondary"} ${copied ? "copied" : ""}`}
        disabled={!value}
        onClick={() => onCopy(target, title, value)}
        aria-label={`${title} 복사`}
      >{copied ? "복사됨 ✓" : "복사"}</button>
    </header>
    <textarea
      id={id}
      className={`prompt-output-text ${uc ? "uc" : ""}`}
      value={value}
      readOnly
      spellCheck={false}
      aria-label={title}
      onFocus={(event) => event.currentTarget.select()}
    />
    <div className="prompt-output-meta"><span>{value.length.toLocaleString("ko-KR")}자</span><span>클릭하면 전체 선택</span></div>
  </section>;
}

export default function PromptBuilder() {
  const catalogResult = useMemo(() => {
    try {
      return { catalog: loadPromptCatalog(), error: "" };
    } catch (error) {
      return { catalog: undefined, error: errorMessage(error) };
    }
  }, []);
  const catalog = catalogResult.catalog;
  const initialCharacter = catalog?.characters[0];
  const initialVariant = initialCharacter?.variants.find((variant) => variant.id === initialCharacter.defaultVariantId)
    || initialCharacter?.variants[0];

  const [characterId, setCharacterId] = useState(initialCharacter?.id || "");
  const [variantId, setVariantId] = useState(initialVariant?.id || "");
  const [situationId, setSituationId] = useState(initialVariant?.defaultSituationId || initialVariant?.situations[0]?.id || "");
  const [extraPrompt, setExtraPrompt] = useState("");
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>({ message: "" });
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
  }, []);

  useEffect(() => {
    const previousTitle = document.title;
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const previousThemeColor = themeColor?.content;
    document.title = "Love Office · NovelAI 프롬프트 빌더";
    if (themeColor) themeColor.content = "#0d1015";
    return () => {
      document.title = previousTitle;
      if (themeColor && previousThemeColor) themeColor.content = previousThemeColor;
    };
  }, []);

  const character = catalog?.characters.find((item) => item.id === characterId) || catalog?.characters[0];
  const variant = character?.variants.find((item) => item.id === variantId) || character?.variants[0];
  const situations = variant?.situations || [];
  const variantVisible = Boolean(character && character.variants.length > 1);
  const situationStep = variantVisible ? 3 : 2;

  const composedResult = useMemo(() => {
    if (!catalog || !character || !variant || !situationId) return { prompt: undefined, error: "" };
    try {
      return {
        prompt: composePrompt(catalog, {
          characterId: character.id,
          variantId: variant.id,
          situationId,
          extraPrompt,
        }),
        error: "",
      };
    } catch (error) {
      return { prompt: undefined, error: errorMessage(error) };
    }
  }, [catalog, character, extraPrompt, situationId, variant]);

  if (!catalog) {
    return <main className="prompt-app"><section className="prompt-error" role="alert">
      <h1>프롬프트 설정을 불러오지 못했습니다.</h1>
      <p>{catalogResult.error || "설정 파일을 확인해주세요."}</p>
    </section></main>;
  }

  const chooseCharacter = (nextId: string) => {
    const nextCharacter = catalog.characters.find((item) => item.id === nextId);
    const nextVariant = nextCharacter?.variants.find((item) => item.id === nextCharacter.defaultVariantId)
      || nextCharacter?.variants[0];
    setCharacterId(nextId);
    setVariantId(nextVariant?.id || "");
    setSituationId(nextVariant?.defaultSituationId || nextVariant?.situations[0]?.id || "");
  };

  const chooseVariant = (nextId: string) => {
    const nextVariant = character?.variants.find((item) => item.id === nextId);
    setVariantId(nextId);
    setSituationId(nextVariant?.defaultSituationId || nextVariant?.situations[0]?.id || "");
  };

  const copy = async (target: CopyTarget, title: string, value: string) => {
    if (!value) return;
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    try {
      await writeClipboard(value);
      setCopyFeedback({ target, message: `${title}를 복사했습니다.` });
    } catch {
      setCopyFeedback({ target, message: "복사하지 못했습니다. 텍스트를 직접 선택해주세요.", failed: true });
    }
    copyTimer.current = window.setTimeout(() => setCopyFeedback({ message: "" }), 2200);
  };

  const prompt = composedResult.prompt;
  const settings = catalog.settings;
  const qualityLabel = typeof settings.qualityTags === "boolean"
    ? `Quality Tags ${settings.qualityTags ? "ON" : "OFF"}`
    : `Quality Tags ${settings.qualityTags}`;

  return <main className="prompt-app">
    <header className="prompt-page-header">
      <div><p className="prompt-eyebrow">LOVE OFFICE · NOVELAI</p><h1>캐릭터 프롬프트 빌더</h1></div>
      <p>캐릭터와 상황을 고른 뒤, 오른쪽 두 칸을 NovelAI에 순서대로 붙여넣으세요.</p>
    </header>

    <section className="prompt-settings-bar" aria-label="NovelAI 권장 설정">
      <strong>먼저 NovelAI 설정</strong>
      <span className="prompt-settings-chip accent">{settings.model}</span>
      <span className="prompt-settings-chip">작화 · {catalog.styleTags.join(" + ")}</span>
      <span className="prompt-settings-chip">{qualityLabel}</span>
      <span className="prompt-settings-chip">UC preset · {settings.ucPreset}</span>
      <span className="prompt-settings-note">생성 버튼 없이 선택 즉시 프롬프트가 바뀝니다.</span>
    </section>

    <div className="prompt-workbench">
      <section className="prompt-panel prompt-selection-panel" aria-labelledby="prompt-selection-title">
        <header className="prompt-panel-heading"><div><p className="prompt-eyebrow">SELECT</p><h2 id="prompt-selection-title">무엇을 만들까요?</h2><p>한 항목씩만 선택해 충돌 태그를 막습니다.</p></div></header>

        <fieldset className="prompt-selector-group">
          <legend><span className="prompt-step">1</span>캐릭터</legend>
          <div className="prompt-character-grid">
            {catalog.characters.map((item) => <ChoiceCard
              key={item.id}
              name="prompt-character"
              value={item.id}
              checked={item.id === character?.id}
              title={item.displayName}
              description={[item.age ? `${item.age}세` : "", item.role].filter(Boolean).join(" · ")}
              accent={item.accent}
              onChange={chooseCharacter}
            />)}
          </div>
        </fieldset>

        {variantVisible && <fieldset className="prompt-selector-group">
          <legend><span className="prompt-step">2</span>모습<span className="prompt-field-hint">서로 섞이지 않습니다</span></legend>
          <div className="prompt-segmented">
            {character!.variants.map((item) => <ChoiceCard
              key={item.id}
              name="prompt-variant"
              value={item.id}
              checked={item.id === variant?.id}
              title={item.label}
              description={item.description}
              kind="segment"
              onChange={chooseVariant}
            />)}
          </div>
        </fieldset>}

        <fieldset className="prompt-selector-group">
          <legend><span className="prompt-step">{situationStep}</span>상황<span className="prompt-field-hint">표정 + 행동</span></legend>
          {situations.length ? <div className="prompt-situation-grid">
            {situations.map((item, index) => <ChoiceCard
              key={item.id}
              name="prompt-situation"
              value={item.id}
              checked={item.id === situationId}
              title={item.label}
              description={item.description}
              mark={String(index + 1).padStart(2, "0")}
              kind="situation"
              onChange={setSituationId}
            />)}
          </div> : <p className="prompt-empty">사용할 수 있는 상황이 없습니다.</p>}
        </fieldset>

        <div className="prompt-extra-field">
          <label className="prompt-field-label" htmlFor="prompt-extra-tags">추가 태그 <span className="prompt-field-hint">선택</span></label>
          <textarea
            id="prompt-extra-tags"
            rows={2}
            value={extraPrompt}
            onChange={(event) => setExtraPrompt(event.target.value)}
            placeholder="예: holding a coffee cup, morning"
            spellCheck={false}
            aria-describedby="prompt-extra-help"
          />
          <small id="prompt-extra-help">기본 태그는 건드리지 않고 이 내용만 Prompt 마지막에 붙입니다.</small>
        </div>
      </section>

      <section className="prompt-panel prompt-output-panel" aria-labelledby="prompt-output-title">
        <header className="prompt-panel-heading">
          <div><p className="prompt-eyebrow">COPY &amp; PASTE</p><h2 id="prompt-output-title">완성된 프롬프트</h2><p>NovelAI의 Prompt와 Undesired Content에 각각 붙여넣으세요.</p></div>
          <span className={`prompt-copy-status ${copyFeedback.failed ? "error" : ""}`} role="status" aria-live="polite">{copyFeedback.message}</span>
        </header>

        {composedResult.error && <div className="prompt-error" role="alert"><p>{composedResult.error}</p></div>}
        {!composedResult.error && prompt && <div className="prompt-output-stack">
          <PromptOutput
            target="combined"
            title="① Prompt"
            hint="NovelAI 메인 Prompt 칸"
            value={prompt.combined}
            primary
            feedback={copyFeedback}
            onCopy={copy}
          />
          <PromptOutput
            target="uc"
            title="② UC 추가 태그"
            hint={`${settings.ucPreset} preset을 선택한 뒤 추가`}
            value={prompt.uc}
            uc
            feedback={copyFeedback}
            onCopy={copy}
          />

          <details className="prompt-advanced">
            <summary>고급 입력 · Base와 Character를 따로 복사</summary>
            <div className="prompt-advanced-body">
              <PromptOutput
                target="base"
                title="Base Prompt"
                hint="NovelAI 메인 Prompt 칸"
                value={prompt.base}
                feedback={copyFeedback}
                onCopy={copy}
              />
              <PromptOutput
                target="character"
                title="Character Prompt"
                hint="+ Add Character 칸"
                value={prompt.character}
                feedback={copyFeedback}
                onCopy={copy}
              />
            </div>
          </details>
        </div>}
      </section>
    </div>
  </main>;
}
