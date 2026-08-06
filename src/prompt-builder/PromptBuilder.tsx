import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { loadPromptCatalog } from "./promptCatalog";
import {
  composePrompt,
  renderPromptSections,
  splitPromptText,
  unregisteredPromptTags,
} from "./promptComposer";
import "./prompt-builder.css";

type CopyTarget = string;

type CopyFeedback = {
  target?: CopyTarget;
  message: string;
  failed?: boolean;
};

const conceptArtImages = import.meta.glob(
  ["../../assets/concept-art/*", "../../assets/hud/*"],
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;

const sdInpaintMasks: Record<string, { title: string; areas: string; preserve: string }> = {
  sd_happy: {
    title: "웃는 표정 마스크",
    areas: "양쪽 눈·눈썹, 입, 볼 안쪽 홍조 영역만 칠합니다.",
    preserve: "머리카락, 귀, 얼굴 외곽, 턱선, 종이 테두리와 배경은 칠하지 않습니다.",
  },
  sd_pout: {
    title: "삐진 표정 마스크",
    areas: "양쪽 눈·눈썹, 입, 볼 안쪽만 칠합니다. 볼 바깥 윤곽까지 닿지 않게 합니다.",
    preserve: "얼굴 폭과 턱선이 바뀌지 않도록 외곽선·머리카락·종이 테두리는 반드시 마스크 밖에 둡니다.",
  },
  sd_awkward: {
    title: "난감한 표정 마스크",
    areas: "양쪽 눈·눈썹과 입을 칠하고, 땀방울용으로 머리 오른쪽 위 빈 배경에 작은 별도 영역을 칠합니다.",
    preserve: "두 마스크 사이의 머리카락, 얼굴 외곽, 턱선과 종이 테두리는 칠하지 않습니다.",
  },
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
  const [extraTags, setExtraTags] = useState("");
  const [extraInstructions, setExtraInstructions] = useState("");
  const [extraUcTags, setExtraUcTags] = useState("");
  const [extraUcInstructions, setExtraUcInstructions] = useState("");
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [compareTags, setCompareTags] = useState("");
  const [compareInstructions, setCompareInstructions] = useState("");
  const [seed, setSeed] = useState(() => String(Math.floor(Math.random() * 4_294_967_295)));
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
  const referenceImages = character
    ? [
        ...(character.conceptArt ? [{
          id: "main-lobby",
          label: "메인 로비 원화",
          path: character.conceptArt,
        }] : []),
        ...character.referenceImages,
      ].flatMap((image) => {
        const url = conceptArtImages[`../../${image.path}`];
        return url ? [{ ...image, url }] : [];
      })
    : [];
  const situations = variant?.situations || [];
  const variantVisible = Boolean(character && character.variants.length > 1);
  const situationStep = variantVisible ? 3 : 2;
  const extraTagItems = useMemo(() => splitPromptText(extraTags), [extraTags]);
  const unknownExtraTags = useMemo(
    () => catalog ? unregisteredPromptTags(catalog, extraTagItems) : [],
    [catalog, extraTagItems],
  );

  const composedResult = useMemo(() => {
    if (!catalog || !character || !variant || !situationId) return { prompt: undefined, error: "" };
    try {
      return {
        prompt: composePrompt(catalog, {
          characterId: character.id,
          variantId: variant.id,
          situationId,
          extraTags,
          extraInstructions,
          extraUcTags,
          extraUcInstructions,
        }),
        error: "",
      };
    } catch (error) {
      return { prompt: undefined, error: errorMessage(error) };
    }
  }, [catalog, character, extraInstructions, extraTags, extraUcInstructions, extraUcTags, situationId, variant]);

  const comparisonResult = useMemo(() => {
    if (!compareEnabled || !catalog || !character || !variant || !situationId) {
      return { prompt: undefined, error: "" };
    }
    try {
      return {
        prompt: composePrompt(catalog, {
          characterId: character.id,
          variantId: variant.id,
          situationId,
          extraTags: [...splitPromptText(extraTags), ...splitPromptText(compareTags)],
          extraInstructions: [extraInstructions, compareInstructions]
            .flatMap((value) => value.split(/\r?\n/))
            .filter(Boolean),
          extraUcTags,
          extraUcInstructions,
        }),
        error: "",
      };
    } catch (error) {
      return { prompt: undefined, error: errorMessage(error) };
    }
  }, [
    catalog,
    character,
    compareEnabled,
    compareInstructions,
    compareTags,
    extraInstructions,
    extraTags,
    extraUcInstructions,
    extraUcTags,
    situationId,
    variant,
  ]);

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
  const inpaintTasks = variant?.inpaintTasks || [];
  const sdInpaintMask = sdInpaintMasks[situationId];
  const sdReferenceImage = referenceImages.find((image) => image.id === "sd-paper-face");
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
      <span className="prompt-settings-chip">작화 · 검증 태그 + 분리된 자연어</span>
      <span className="prompt-settings-chip">{qualityLabel}</span>
      <span className="prompt-settings-chip">UC preset · {settings.ucPreset}</span>
      <span className="prompt-settings-chip">Steps · {settings.steps}</span>
      <span className="prompt-settings-chip">Sampler · {settings.samplers.join(" / ")}</span>
      <span className="prompt-settings-chip">Variety · {settings.variety ? "ON" : "OFF"}</span>
      <span className="prompt-settings-chip">Noise · {settings.noiseSchedule}</span>
      <span className="prompt-settings-chip">Guidance Rescale · {settings.promptGuidanceRescale}</span>
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

        {referenceImages.length > 0 && character && <aside className="prompt-reference-card">
          <div className="prompt-reference-gallery">
            {referenceImages.map((image) => <a
              key={image.id}
              className="prompt-reference-item"
              href={image.url}
              download={`${character.id}-${image.id}.png`}
            >
              <img src={image.url} alt={`${character.displayName} ${image.label}`} />
              <span>{image.label}</span>
            </a>)}
          </div>
          <div className="prompt-reference-copy">
            <strong>얼굴·작화 참고 원화</strong>
            <p>일반 생성은 Precise Reference의 <b>Character &amp; Style Reference</b>로 사용합니다. SD 표정은 확정 SD 원화를 <b>Base Img → Inpaint Image</b>로 열어 표정 부위만 수정하세요.</p>
          </div>
        </aside>}

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
          <label className="prompt-field-label" htmlFor="prompt-extra-tags">추가 검증 태그 <span className="prompt-field-hint">선택</span></label>
          <textarea
            id="prompt-extra-tags"
            rows={2}
            value={extraTags}
            onChange={(event) => setExtraTags(event.target.value)}
            placeholder="예: holding, book, smile"
            spellCheck={false}
            aria-invalid={unknownExtraTags.length > 0}
            aria-describedby="prompt-extra-help"
          />
          <small id="prompt-extra-help">
            <a href="https://danbooru-tag.mephistopheles.moe/" target="_blank" rel="noreferrer">단부루 태그툴</a>이나 NovelAI 공식 태그로 검증된 항목만 입력합니다.
          </small>
          {unknownExtraTags.length > 0 && <p className="prompt-field-error" role="alert">
            미등록 태그: {unknownExtraTags.join(", ")} · 태그가 없다면 아래 자연어 지시로 옮기세요.
          </p>}

          <label className="prompt-field-label prompt-subfield-label" htmlFor="prompt-extra-instructions">태그로 표현 못 하는 세부 지시 <span className="prompt-field-hint">선택</span></label>
          <textarea
            id="prompt-extra-instructions"
            rows={3}
            value={extraInstructions}
            onChange={(event) => setExtraInstructions(event.target.value)}
            placeholder="예: Hold the cup close to her chest while preserving her face."
            spellCheck={false}
          />
          <small>한 줄에 한 문장으로 적으면 대문자 시작·마침표 형식으로 Prompt 끝에 분리해 붙입니다.</small>
        </div>

        <details className="prompt-author-tools">
          <summary>선택 도구 · UC 추가 / 동일 시드 A/B 비교</summary>
          <div className="prompt-author-tools-body">
            <div className="prompt-tool-grid">
              <label>UC 검증 태그<textarea rows={2} value={extraUcTags} onChange={(event) => setExtraUcTags(event.target.value)} placeholder="예: text, signature" spellCheck={false} /></label>
              <label>UC 자연어 지시<textarea rows={2} value={extraUcInstructions} onChange={(event) => setExtraUcInstructions(event.target.value)} placeholder="예: Misplaced accessories or distorted fingers." spellCheck={false} /></label>
            </div>
            <label className="prompt-compare-toggle">
              <input type="checkbox" checked={compareEnabled} onChange={(event) => setCompareEnabled(event.target.checked)} />
              <span><strong>동일 시드 A/B 비교</strong><small>A는 현재 Prompt, B에는 바꿀 한 블록만 추가합니다.</small></span>
            </label>
            {compareEnabled && <div className="prompt-compare-fields">
              <label>NovelAI Seed<div className="prompt-seed-row"><input inputMode="numeric" value={seed} onChange={(event) => setSeed(event.target.value.replace(/\D/g, ""))} /><button type="button" onClick={() => setSeed(String(Math.floor(Math.random() * 4_294_967_295)))}>새 시드</button></div></label>
              <label>B에서만 추가할 검증 태그<textarea rows={2} value={compareTags} onChange={(event) => setCompareTags(event.target.value)} placeholder="한 번에 한 태그 묶음만" spellCheck={false} /></label>
              <label>B에서만 추가할 자연어 지시<textarea rows={2} value={compareInstructions} onChange={(event) => setCompareInstructions(event.target.value)} placeholder="한 번에 한 문장만" spellCheck={false} /></label>
            </div>}
          </div>
        </details>
      </section>

      <section className="prompt-panel prompt-output-panel" aria-labelledby="prompt-output-title">
        <header className="prompt-panel-heading">
          <div><p className="prompt-eyebrow">COPY &amp; PASTE</p><h2 id="prompt-output-title">완성된 프롬프트</h2><p>NovelAI의 Prompt와 Undesired Content에 각각 붙여넣으세요.</p></div>
          <span className={`prompt-copy-status ${copyFeedback.failed ? "error" : ""}`} role="status" aria-live="polite">{copyFeedback.message}</span>
        </header>

        {composedResult.error && <div className="prompt-error" role="alert"><p>{composedResult.error}</p></div>}
        {!composedResult.error && prompt && <div className="prompt-output-stack">
          {sdInpaintMask && sdReferenceImage && <section className="prompt-sd-inpaint-workflow" aria-labelledby="prompt-sd-inpaint-title">
            <header>
              <div><p className="prompt-eyebrow">CONSISTENT SD INPAINT</p><h3 id="prompt-sd-inpaint-title">확정 기본 SD에서 표정만 바꾸기</h3></div>
              <span>Text-to-Image 재생성 금지</span>
            </header>
            <div className="prompt-sd-inpaint-reference">
              <img src={sdReferenceImage.url} alt={`${character?.displayName || "캐릭터"} 확정 기본 SD 원화`} />
              <div><strong>{character?.displayName} 확정 기본 SD 원화</strong><p>항상 이 원화에서 직접 시작합니다. 웃음 결과를 다시 삐짐의 원본으로 쓰는 식의 연쇄 편집은 하지 않습니다.</p><a href={sdReferenceImage.url} download={`${character?.id || "character"}-sd-base.png`}>원화 파일 열기</a></div>
            </div>
            <ol className="prompt-sd-inpaint-steps">
              <li><b>Base Img</b>에 위 원화를 넣고 <b>Inpaint Image</b>를 누릅니다.</li>
              <li><b>{sdInpaintMask.title}</b>: {sdInpaintMask.areas} {sdInpaintMask.preserve}</li>
              <li><b>Save &amp; Close</b> 후 아래 ① Prompt와 ② UC를 원본 내용 대신 그대로 넣습니다.</li>
              <li><b>Generate 1 Image · 0 Anlas</b>를 확인하고 한 장씩 생성합니다. 결과가 마음에 들지 않아도 다음 표정은 다시 기본 SD 원화에서 시작합니다.</li>
            </ol>
            <div className="prompt-sd-inpaint-warning"><strong>일관성 잠금</strong><span>마스크 밖의 헤어 실루엣·눈 크기 기준·얼굴 폭·턱선·피부색·흰 종이 테두리는 변경 대상이 아닙니다.</span></div>
          </section>}

          <aside className="prompt-provenance-card" aria-label="프롬프트 출처 검사 결과">
            <div><strong>출처 검사 통과</strong><span>긍정 {prompt.audit.positiveTagItems.length}개 · UC {prompt.audit.undesiredTagItems.length}개 검증 태그</span></div>
            <div className="prompt-source-links">
              {catalog.tagRegistry.sources.map((source) => <a key={source.id} href={source.url} target="_blank" rel="noreferrer" title={source.description}>{source.label} · {source.checkedAt}</a>)}
            </div>
            <p>자연어 지시 {prompt.audit.positiveInstructions.length + prompt.audit.undesiredInstructions.length}개는 태그와 분리되어 있습니다.</p>
          </aside>
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

          {compareEnabled && <section className="prompt-comparison-card">
            <header><div><strong>동일 시드 A/B</strong><small>NovelAI Seed에 <b>{seed || "값 입력 필요"}</b>를 A와 B 모두 동일하게 사용</small></div><span>설정도 전부 동일하게 유지</span></header>
            {comparisonResult.error && <p className="prompt-field-error" role="alert">{comparisonResult.error}</p>}
            {comparisonResult.prompt && <PromptOutput
              target="combined-b"
              title="B Prompt"
              hint="A에서 한 블록만 바꾼 비교본"
              value={comparisonResult.prompt.combined}
              feedback={copyFeedback}
              onCopy={copy}
            />}
          </section>}

          <details className="prompt-inpaint-guide" open={inpaintTasks.length > 0}>
            <summary>작은 디테일·손·액세서리는 Inpaint로 한 부위씩 수정</summary>
            <div className="prompt-inpaint-body">
              <p>전체 Prompt를 계속 복잡하게 만들지 말고, 마음에 드는 결과를 고른 뒤 문제 부위 하나만 마스킹하세요. 작은 부위는 Focused Inpainting을 쓰고, 주변이 새어 들어오면 마스크를 조금 넓힙니다.</p>
              {inpaintTasks.map((task) => <PromptOutput
                key={task.id}
                target={`inpaint-${task.id}`}
                title={task.label}
                hint={task.description}
                value={renderPromptSections(task.tags, task.instructions)}
                feedback={copyFeedback}
                onCopy={copy}
              />)}
            </div>
          </details>

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
