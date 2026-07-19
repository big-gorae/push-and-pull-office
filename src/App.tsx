import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  applyEffect,
  chooseTransition,
  clone,
  conditionsMatch,
  deriveEmotion,
  deriveStateContract,
  getPath,
  makeNode,
  parseEditorValue,
  resolveStart,
  statePaths,
} from "./storyLogic";
import type {
  Character,
  ChoiceOption,
  Condition,
  DecisionTrace,
  Effect,
  JsonValue,
  Layer,
  NodeKind,
  ProjectPayload,
  Runtime,
  RuntimeState,
  Scene,
  StoryNode,
  Transition,
  ValidationIssue,
  ViewMode,
} from "./types";

const NODE_LABELS: Record<NodeKind, string> = {
  dual_dialogue: "이중 대사",
  dual_narration: "이중 내레이션",
  choice: "선택지",
  state_gate: "수치 분기",
  effect: "상태 효과",
  exit: "장면 이탈",
};

const STATE_LABELS: Record<string, string> = { push: "밀기", pull: "당기기", neutral: "중립" };

type HistoryState = { past: Scene[]; future: Scene[] };

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={wide ? "field field-wide" : "field"}><span>{label}</span>{children}</label>;
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} />;
}

function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={3} {...props} />;
}

function IconText({ children }: { children: ReactNode }) {
  return <span aria-hidden="true" className="icon-text">{children}</span>;
}

function valueText(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function conditionOperators(type: "number" | "enum" | "array") {
  if (type === "number") return [
    ["eq", "같다"], ["ne", "다르다"], ["gt", "초과"], ["gte", "이상"], ["lt", "미만"], ["lte", "이하"],
  ];
  if (type === "array") return [["contains", "포함"], ["not_contains", "미포함"]];
  return [["eq", "같다"], ["ne", "다르다"]];
}

function ConditionEditor({
  runtime,
  conditions,
  onChange,
  compact = false,
}: {
  runtime: Runtime;
  conditions: Condition[];
  onChange: (conditions: Condition[]) => void;
  compact?: boolean;
}) {
  const paths = useMemo(() => statePaths(runtime), [runtime]);

  const update = (index: number, patch: Partial<Condition>) => {
    const next = clone(conditions);
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };

  const add = () => {
    const first = paths[0];
    onChange([...conditions, { path: first.value, op: "gte", value: 0 }]);
  };

  return <div className={compact ? "rule-list compact" : "rule-list"}>
    {conditions.map((condition, index) => {
      const path = paths.find((item) => item.value === condition.path) || paths[0];
      const operators = conditionOperators(path.type);
      return <div className="rule-row" key={`${condition.path}-${index}`}>
        <select
          aria-label="판정 수치"
          value={condition.path}
          onChange={(event) => {
            const selected = paths.find((item) => item.value === event.target.value) || paths[0];
            update(index, {
              path: selected.value,
              op: conditionOperators(selected.type)[0][0],
              value: selected.type === "number" ? 0 : "",
            });
          }}
        >
          {paths.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
        </select>
        <select aria-label="비교 방법" value={condition.op} onChange={(event) => update(index, { op: event.target.value })}>
          {operators.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select>
        {path.type === "enum" ? <select
          aria-label="비교 값"
          value={String(condition.value || "neutral")}
          onChange={(event) => update(index, { value: event.target.value })}
        >
          {runtime.enums.perceived_state.map((value) => <option value={value} key={value}>{STATE_LABELS[value] || value}</option>)}
        </select> : <input
          aria-label="비교 값"
          type={path.type === "number" ? "number" : "text"}
          value={valueText(condition.value)}
          onChange={(event) => update(index, { value: parseEditorValue(event.target.value, path.type) })}
        />}
        <button type="button" className="icon-button danger" aria-label="조건 삭제" onClick={() => onChange(conditions.filter((_, itemIndex) => itemIndex !== index))}>×</button>
      </div>;
    })}
    <button type="button" className="add-row-button" onClick={add}><IconText>＋</IconText> 조건 추가</button>
  </div>;
}

function EffectEditor({ runtime, effects, onChange }: { runtime: Runtime; effects: Effect[]; onChange: (effects: Effect[]) => void }) {
  const paths = useMemo(() => statePaths(runtime), [runtime]);

  const update = (index: number, patch: Partial<Effect>) => {
    const next = clone(effects);
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };

  const add = () => {
    const first = paths[0];
    onChange([...effects, { path: first.value, op: "add", value: 0 }]);
  };

  return <div className="rule-list">
    {effects.map((effect, index) => {
      const path = paths.find((item) => item.value === effect.path) || paths[0];
      const operations = path.type === "number" ? [["add", "더하기"], ["set", "교체"]]
        : path.type === "array" ? [["append_unique", "항목 추가"], ["remove", "항목 제거"]]
          : [["set", "교체"]];
      return <div className="effect-block" key={`${effect.path}-${index}`}>
        <div className="rule-row">
          <select
            aria-label="변경할 수치"
            value={effect.path}
            onChange={(event) => {
              const selected = paths.find((item) => item.value === event.target.value) || paths[0];
              update(index, {
                path: selected.value,
                op: selected.type === "number" ? "add" : selected.type === "array" ? "append_unique" : "set",
                value: selected.type === "number" ? 0 : "",
              });
            }}
          >
            {paths.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
          </select>
          <select aria-label="변경 방식" value={effect.op} onChange={(event) => update(index, { op: event.target.value })}>
            {operations.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
          {path.type === "enum" ? <select
            aria-label="변경 값"
            value={String(effect.value || "neutral")}
            onChange={(event) => update(index, { value: event.target.value })}
          >
            {runtime.enums.perceived_state.map((value) => <option value={value} key={value}>{STATE_LABELS[value] || value}</option>)}
          </select> : <input
            aria-label="변경 값"
            type={path.type === "number" ? "number" : "text"}
            value={valueText(effect.value)}
            onChange={(event) => update(index, { value: parseEditorValue(event.target.value, path.type) })}
          />}
          <button type="button" className="icon-button danger" aria-label="효과 삭제" onClick={() => onChange(effects.filter((_, itemIndex) => itemIndex !== index))}>×</button>
        </div>
        <details className="nested-conditions">
          <summary>이 효과만의 조건 {effect.conditions?.length ? `(${effect.conditions.length})` : ""}</summary>
          <ConditionEditor runtime={runtime} compact conditions={effect.conditions || []} onChange={(conditions) => update(index, { conditions })} />
        </details>
      </div>;
    })}
    <button type="button" className="add-row-button" onClick={add}><IconText>＋</IconText> 수치 효과 추가</button>
  </div>;
}

function LayerEditor({
  title,
  layer,
  mode,
  runtime,
  speaker,
  narration,
  onChange,
}: {
  title: string;
  layer: Layer;
  mode: ViewMode;
  runtime: Runtime;
  speaker?: string;
  narration?: boolean;
  onChange: (layer: Layer) => void;
}) {
  const character = speaker ? runtime.characters[speaker] : undefined;
  const expressions = Object.entries(character?.expressions || {}).filter(([, value]) => value.layer === mode);
  const update = (patch: Partial<Layer>) => onChange({ ...layer, ...patch });
  return <fieldset className={`layer-editor ${mode}`}>
    <legend>{title}</legend>
    <div className="form-grid">
      <Field label="분위기">
        <select value={layer.atmosphere || ""} onChange={(event) => update({ atmosphere: event.target.value })}>
          {runtime.enums.atmosphere.map((value) => <option value={value} key={value}>{value}</option>)}
        </select>
      </Field>
      {!narration && <Field label="표정">
        <select value={layer.expression || ""} onChange={(event) => update({ expression: event.target.value })}>
          <option value="">표정 선택</option>
          {expressions.map(([id, value]) => <option value={id} key={id}>{id} · {value.description}</option>)}
        </select>
      </Field>}
      <Field label="화면 대사" wide><TextArea value={layer.line || ""} onChange={(event) => update({ line: event.target.value })} /></Field>
      {mode === "perceived" ? <Field label="주인공의 해석" wide>
        <TextArea value={layer.protagonist_interpretation || ""} onChange={(event) => update({ protagonist_interpretation: event.target.value })} />
      </Field> : <>
        <Field label="속마음" wide><TextArea value={layer.inner_thought || ""} onChange={(event) => update({ inner_thought: event.target.value })} /></Field>
        <Field label="실제 의도">
          <select value={layer.intent || "work_only"} onChange={(event) => update({ intent: event.target.value })}>
            {runtime.enums.intent.map((value) => <option value={value} key={value}>{value}</option>)}
          </select>
        </Field>
      </>}
    </div>
  </fieldset>;
}

function ChoiceEditor({ runtime, scene, node, onChange }: { runtime: Runtime; scene: Scene; node: StoryNode; onChange: (node: StoryNode) => void }) {
  const options = node.options || [];
  const updateOption = (index: number, patch: Partial<ChoiceOption>) => {
    const next = clone(options);
    next[index] = { ...next[index], ...patch };
    onChange({ ...node, options: next });
  };
  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= options.length) return;
    const next = clone(options);
    [next[index], next[target]] = [next[target], next[index]];
    onChange({ ...node, options: next });
  };
  const add = () => {
    let counter = options.length + 1;
    while (options.some((option) => option.id === `option_${counter}`)) counter += 1;
    onChange({ ...node, options: [...options, {
      id: `option_${counter}`,
      label: "새 선택지",
      interpretation: "",
      action: "",
      conditions: [],
      effects: [],
      next: scene.node_order.find((id) => id !== node.id) || "",
    }] });
  };
  return <>
    <Field label="선택 질문" wide><TextArea value={node.prompt || ""} onChange={(event) => onChange({ ...node, prompt: event.target.value })} /></Field>
    <div className="option-list">
      {options.map((option, index) => <section className="option-editor" key={option.id}>
        <div className="option-heading">
          <strong>선택지 {index + 1}</strong>
          <div className="inline-actions">
            <button type="button" className="icon-button" aria-label="위로" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
            <button type="button" className="icon-button" aria-label="아래로" disabled={index === options.length - 1} onClick={() => move(index, 1)}>↓</button>
            <button type="button" className="icon-button danger" aria-label="선택지 삭제" onClick={() => onChange({ ...node, options: options.filter((_, itemIndex) => itemIndex !== index) })}>×</button>
          </div>
        </div>
        <div className="form-grid">
          <Field label="ID"><TextInput value={option.id} onChange={(event) => updateOption(index, { id: event.target.value })} /></Field>
          <Field label="다음 노드"><select value={option.next} onChange={(event) => updateOption(index, { next: event.target.value })}>{scene.node_order.map((id) => <option value={id} key={id}>{id}</option>)}</select></Field>
          <Field label="플레이어 문구" wide><TextInput value={option.label} onChange={(event) => updateOption(index, { label: event.target.value })} /></Field>
          <Field label="주인공 해석" wide><TextArea value={option.interpretation} onChange={(event) => updateOption(index, { interpretation: event.target.value })} /></Field>
          <Field label="실제로 하는 행동" wide><TextArea value={option.action} onChange={(event) => updateOption(index, { action: event.target.value })} /></Field>
        </div>
        <details>
          <summary>표시 조건 ({option.conditions.length})</summary>
          <ConditionEditor runtime={runtime} conditions={option.conditions} onChange={(conditions) => updateOption(index, { conditions })} />
        </details>
        <details open>
          <summary>수치 효과 ({option.effects.length})</summary>
          <EffectEditor runtime={runtime} effects={option.effects} onChange={(effects) => updateOption(index, { effects })} />
        </details>
      </section>)}
    </div>
    <button type="button" className="add-card-button" onClick={add}><IconText>＋</IconText> 선택지 추가</button>
  </>;
}

function TransitionEditor({
  runtime,
  scene,
  transitions,
  target,
  onChange,
}: {
  runtime: Runtime;
  scene: Scene;
  transitions: Transition[];
  target: "node" | "scene";
  onChange: (transitions: Transition[]) => void;
}) {
  const update = (index: number, patch: Partial<Transition>) => {
    const next = clone(transitions);
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };
  const move = (index: number, offset: number) => {
    const destination = index + offset;
    if (destination < 0 || destination >= transitions.length || transitions[destination].default) return;
    const next = clone(transitions);
    [next[index], next[destination]] = [next[destination], next[index]];
    onChange(next);
  };
  const add = () => {
    const defaultIndex = transitions.findIndex((transition) => transition.default);
    const entry: Transition = { conditions: [], [target]: target === "node" ? scene.node_order[0] : scene.id };
    const next = clone(transitions);
    next.splice(defaultIndex >= 0 ? defaultIndex : next.length, 0, entry);
    if (!next.some((transition) => transition.default)) next.push({ default: true, [target]: target === "node" ? scene.node_order[0] : scene.id });
    onChange(next);
  };
  const destinations = target === "node" ? scene.node_order : Object.keys(runtime.scenes);

  return <div className="transition-list">
    {transitions.map((transition, index) => <section className={transition.default ? "transition-row default" : "transition-row"} key={index}>
      <div className="transition-heading">
        <strong>{transition.default ? "기본 분기" : `${index + 1}순위 분기`}</strong>
        {!transition.default && <div className="inline-actions">
          <button type="button" className="icon-button" aria-label="분기를 위로" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
          <button type="button" className="icon-button" aria-label="분기를 아래로" disabled={index + 1 >= transitions.length || transitions[index + 1].default} onClick={() => move(index, 1)}>↓</button>
          <button type="button" className="icon-button danger" aria-label="분기 삭제" onClick={() => onChange(transitions.filter((_, itemIndex) => itemIndex !== index))}>×</button>
        </div>}
      </div>
      {!transition.default && <ConditionEditor runtime={runtime} compact conditions={transition.conditions || []} onChange={(conditions) => update(index, { conditions })} />}
      {target === "scene" && <Field label="목적지 종류">
        <select
          value={transition.ending ? "ending" : "scene"}
          onChange={(event) => update(index, event.target.value === "ending"
            ? { ending: true, ending_id: transition.ending_id || "draft.ending", scene: undefined }
            : { ending: undefined, ending_id: undefined, scene: scene.id })}
        >
          <option value="scene">다른 장면</option>
          <option value="ending">엔딩 완료</option>
        </select>
      </Field>}
      {transition.ending ? <Field label="엔딩 ID"><TextInput value={transition.ending_id || ""} onChange={(event) => update(index, { ending_id: event.target.value })} /></Field>
        : <Field label={target === "node" ? "이동할 노드" : "이동할 장면"}>
          <select value={String(transition[target] || "")} onChange={(event) => update(index, { [target]: event.target.value })}>
            {destinations.map((id) => <option value={id} key={id}>{id}{target === "scene" ? ` · ${runtime.scenes[id]?.title || ""}` : ""}</option>)}
          </select>
        </Field>}
    </section>)}
    <button type="button" className="add-row-button" onClick={add}><IconText>＋</IconText> 조건 분기 추가</button>
  </div>;
}

function NodeEditor({
  runtime,
  scene,
  node,
  onChange,
}: {
  runtime: Runtime;
  scene: Scene;
  node: StoryNode;
  onChange: (node: StoryNode) => void;
}) {
  const commonNext = node.kind === "dual_dialogue" || node.kind === "dual_narration" || node.kind === "effect";
  return <div className="node-editor">
    <div className="form-grid compact-grid">
      <Field label="노드 ID"><TextInput value={node.id} readOnly /></Field>
      <Field label="노드 종류"><select value={node.kind} disabled>{Object.entries(NODE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field>
      {commonNext && <Field label="다음 노드"><select value={node.next || ""} onChange={(event) => onChange({ ...node, next: event.target.value })}><option value="">선택</option>{scene.node_order.filter((id) => id !== node.id).map((id) => <option value={id} key={id}>{id}</option>)}</select></Field>}
      {(node.kind === "dual_dialogue" || node.kind === "dual_narration") && <Field label="연출 플래그"><TextInput placeholder="ui_glitch, original_text_lock" value={(node.presentation_flags || []).join(", ")} onChange={(event) => onChange({ ...node, presentation_flags: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} /></Field>}
    </div>

    {node.kind === "dual_dialogue" && <>
      <Field label="화자"><select value={node.speaker || ""} onChange={(event) => onChange({ ...node, speaker: event.target.value })}>{scene.cast.map((id) => <option value={id} key={id}>{runtime.characters[id]?.display_name || id}</option>)}</select></Field>
      <div className="dual-layer-grid">
        <LayerEditor title="주인공이 보는 장면" layer={node.perceived || {}} mode="perceived" runtime={runtime} speaker={node.speaker} onChange={(perceived) => onChange({ ...node, perceived })} />
        <LayerEditor title="실제 장면" layer={node.reality || {}} mode="reality" runtime={runtime} speaker={node.speaker} onChange={(reality) => onChange({ ...node, reality })} />
      </div>
    </>}

    {node.kind === "dual_narration" && <div className="dual-layer-grid">
      <LayerEditor title="주인공이 보는 서술" narration layer={node.perceived || {}} mode="perceived" runtime={runtime} onChange={(perceived) => onChange({ ...node, perceived })} />
      <LayerEditor title="실제 서술" narration layer={node.reality || {}} mode="reality" runtime={runtime} onChange={(reality) => onChange({ ...node, reality })} />
    </div>}

    {node.kind === "choice" && <ChoiceEditor runtime={runtime} scene={scene} node={node} onChange={onChange} />}
    {node.kind === "state_gate" && <TransitionEditor runtime={runtime} scene={scene} transitions={node.transitions || []} target="node" onChange={(transitions) => onChange({ ...node, transitions })} />}
    {node.kind === "effect" && <EffectEditor runtime={runtime} effects={node.effects || []} onChange={(effects) => onChange({ ...node, effects })} />}
    {node.kind === "exit" && <TransitionEditor runtime={runtime} scene={scene} transitions={node.transitions || []} target="scene" onChange={(transitions) => onChange({ ...node, transitions })} />}
  </div>;
}

function StateSlider({ label, value, max = 100, onChange }: { label: string; value: number; max?: number; onChange: (value: number) => void }) {
  return <label className="state-slider"><span>{label}<output>{value}</output></span><input type="range" min="0" max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function Preview({
  runtime,
  scene,
  selectedNodeId,
  mode,
  onMode,
  state,
  initialState,
  onState,
  image,
}: {
  runtime: Runtime;
  scene: Scene;
  selectedNodeId: string;
  mode: ViewMode;
  onMode: (mode: ViewMode) => void;
  state: RuntimeState;
  initialState: RuntimeState;
  onState: (state: RuntimeState) => void;
  image?: string;
}) {
  const route = runtime.routes[scene.route];
  const heroine = route.heroine;
  const visible = state.visible.heroines[heroine];
  const hidden = state.hidden.heroines[heroine];
  const emotion = deriveEmotion(runtime.characters[heroine], hidden);
  const selected = scene.nodes[selectedNodeId];
  const automatic = selected?.kind === "state_gate" ? chooseTransition(state, selected.transitions) : undefined;
  const displayNode = automatic?.chosen?.node ? scene.nodes[automatic.chosen.node] : selected;
  const layer = displayNode?.[mode] as Layer | undefined;
  const exitDecision = displayNode?.kind === "exit" ? chooseTransition(state, displayNode.transitions) : undefined;
  const availableOptions = displayNode?.kind === "choice" ? (displayNode.options || []).filter((option) => conditionsMatch(state, option.conditions)) : [];

  const updateHeroine = (section: "visible" | "hidden", key: string, value: number | string) => {
    const next = clone(state);
    if (section === "visible") (next.visible.heroines[heroine] as unknown as Record<string, number | string>)[key] = value;
    else (next.hidden.heroines[heroine] as unknown as Record<string, number>)[key] = Number(value);
    onState(next);
  };

  const simulateChoice = (option: ChoiceOption) => {
    const next = clone(state);
    option.effects.forEach((effect) => applyEffect(runtime, next, effect));
    onState(next);
  };

  const speaker = displayNode?.speaker || heroine;
  const character = runtime.characters[speaker] || runtime.characters[heroine];
  const expression = layer?.expression || emotion?.default_expression || "narration";

  return <aside className="preview-panel">
    <div className="panel-heading">
      <div><p className="eyebrow">LIVE PREVIEW</p><h2>게임 화면</h2></div>
      <div className="segmented"><button type="button" className={mode === "perceived" ? "active" : ""} onClick={() => onMode("perceived")}>본편</button><button type="button" className={mode === "reality" ? "active truth" : ""} onClick={() => onMode("reality")}>실제</button></div>
    </div>

    <div className={`mini-game ${mode}`}>
      <div className="mini-portrait">{image ? <img src={image} alt={`${character.display_name} 콘셉트 아트`} /> : <div className="image-placeholder">NO IMAGE</div>}<div className="portrait-label"><strong>{character.display_name}</strong><span>{expression}</span></div></div>
      <div className="mini-dialogue">
        <div className="hud-row">
          {(mode === "perceived" ? [`호감 ${visible.affection}`, `주도권 ${visible.initiative}`, STATE_LABELS[visible.perceived_state]] : [`의심 ${hidden.suspicion}`, `비호감 ${hidden.dislike}`, `증거 ${hidden.evidence_count}`]).map((label) => <span key={label}>{label}</span>)}
        </div>
        <div className="dialogue-copy">
          <small>{layer?.atmosphere || NODE_LABELS[displayNode?.kind || "effect"]}</small>
          <blockquote>{layer?.line || (displayNode?.kind === "choice" ? displayNode.prompt : displayNode?.kind === "exit" ? "장면을 떠납니다." : "판정 노드")}</blockquote>
          <p>{mode === "perceived" ? layer?.protagonist_interpretation : [layer?.inner_thought, layer?.intent].filter(Boolean).join(" · ")}</p>
        </div>
      </div>
    </div>

    {availableOptions.length > 0 && <div className="preview-choices">{availableOptions.map((option) => <button type="button" key={option.id} onClick={() => simulateChoice(option)}><strong>{option.label}</strong><small>효과 적용해 보기</small></button>)}</div>}

    <div className="test-state">
      <div className="state-section-heading"><div className="state-section-label">테스트 상태 · {runtime.characters[heroine].display_name}</div><button type="button" onClick={() => onState(clone(initialState))}>수치 초기화</button></div>
      <StateSlider label="호감도" value={visible.affection} onChange={(value) => updateHeroine("visible", "affection", value)} />
      <StateSlider label="주도권" value={visible.initiative} onChange={(value) => updateHeroine("visible", "initiative", value)} />
      <label className="state-select"><span>현재 해석</span><select value={visible.perceived_state} onChange={(event) => updateHeroine("visible", "perceived_state", event.target.value)}>{runtime.enums.perceived_state.map((value) => <option value={value} key={value}>{STATE_LABELS[value]}</option>)}</select></label>
      <StateSlider label="의심도" value={hidden.suspicion} onChange={(value) => updateHeroine("hidden", "suspicion", value)} />
      <StateSlider label="비호감" value={hidden.dislike} onChange={(value) => updateHeroine("hidden", "dislike", value)} />
      <StateSlider label="물리적 증거" value={hidden.evidence_count} max={10} onChange={(value) => updateHeroine("hidden", "evidence_count", value)} />
      <div className="emotion-chip"><strong>{emotion?.emotion || "미정"}</strong><span>{emotion?.behavior || "행동 규칙 없음"}</span></div>
    </div>

    {(automatic || exitDecision) && <DecisionPanel trace={(automatic || exitDecision)!.trace} state={state} />}
  </aside>;
}

function DecisionPanel({ trace, state }: { trace: DecisionTrace[]; state: RuntimeState }) {
  return <div className="decision-panel"><strong>현재 분기 판정</strong>{trace.map((item, index) => <div className={item.chosen ? "decision chosen" : "decision"} key={index}>
    <span>{item.chosen ? "●" : item.met ? "○" : "×"} {item.transition.default ? "기본 분기" : `${index + 1}순위`}</span>
    <small>{item.transition.node || item.transition.scene || item.transition.ending_id || "목적지 없음"}</small>
    {!item.transition.default && <em>{(item.transition.conditions || []).map((condition) => `${condition.path.split(".").pop()} ${condition.op} ${String(condition.value)} (현재 ${String(getPath(state, condition.path))})`).join(" / ")}</em>}
  </div>)}</div>;
}

export default function App() {
  const bootStarted = useRef(false);
  const [payload, setPayload] = useState<ProjectPayload | null>(null);
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [draft, setDraft] = useState<Scene | null>(null);
  const [revision, setRevision] = useState("");
  const [dirty, setDirty] = useState(false);
  const [history, setHistory] = useState<HistoryState>({ past: [], future: [] });
  const [mode, setMode] = useState<ViewMode>("perceived");
  const [testState, setTestState] = useState<RuntimeState | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [status, setStatus] = useState("에디터 준비 중…");
  const [busy, setBusy] = useState(false);
  const [editorTab, setEditorTab] = useState<"scene" | "node" | "source">("node");
  const [newNodeId, setNewNodeId] = useState("");
  const [newNodeKind, setNewNodeKind] = useState<NodeKind>("dual_dialogue");
  const [imageCache, setImageCache] = useState<Record<string, string>>({});

  const runtime = payload?.runtime;
  const root = payload?.root;
  const currentRoute = draft && runtime ? runtime.routes[draft.route] : undefined;
  const heroineId = currentRoute?.heroine;
  const selectedNode = draft?.nodes[selectedNodeId];

  const loadScene = useCallback((project: ProjectPayload, sceneId: string, force = false) => {
    if (!force && dirty && !window.confirm("저장하지 않은 변경을 버리고 다른 장면을 열까요?")) return;
    const sourceScene = project.runtime.scenes[sceneId];
    if (!sourceScene) return;
    let next = clone(sourceScene);
    let recoveredDraft = false;
    const meta = project.documents.scenes[sceneId];
    const key = `love-office-draft:${project.root}:${sceneId}`;
    const stored = localStorage.getItem(key);
    if (stored) {
      try {
        const recovered = JSON.parse(stored) as { revision: string; scene: Scene };
        if (recovered.revision === meta.revision && JSON.stringify(recovered.scene) !== JSON.stringify(sourceScene)) {
          if (window.confirm(`저장하지 않은 '${sourceScene.title}' 초안이 있습니다. 복구할까요?`)) {
            next = recovered.scene;
            recoveredDraft = true;
            setDirty(true);
            setStatus("저장하지 않은 초안을 복구했습니다.");
          } else {
            localStorage.removeItem(key);
            setDirty(false);
          }
        } else {
          localStorage.removeItem(key);
          setDirty(false);
        }
      } catch {
        localStorage.removeItem(key);
        setDirty(false);
      }
    } else setDirty(false);
    setSelectedSceneId(sceneId);
    setDraft(next);
    setRevision(meta.revision);
    setSelectedNodeId(next.start_node);
    setHistory({ past: [], future: [] });
    setTestState((current) => force ? clone(project.runtime.initial_state) : current || clone(project.runtime.initial_state));
    setEditorTab("node");
    return recoveredDraft;
  }, [dirty]);

  const loadProject = useCallback(async (projectRoot: string) => {
    setBusy(true);
    setStatus("프로젝트를 검증하고 불러오는 중…");
    try {
      const project = await invoke<ProjectPayload>("load_project", { root: projectRoot });
      setPayload(project);
      setIssues(project.issues);
      const firstRoute = Object.values(project.runtime.routes)[0];
      const recoveredDraft = loadScene(project, firstRoute.entry_scene, true);
      if (!recoveredDraft) setStatus(`${Object.keys(project.runtime.scenes).length}개 장면을 불러왔습니다.`);
    } catch (error) {
      setStatus(`프로젝트를 열 수 없습니다: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [loadScene]);

  useEffect(() => {
    if (bootStarted.current) return;
    bootStarted.current = true;
    invoke<string | null>("default_project_root")
      .then((projectRoot) => projectRoot ? loadProject(projectRoot) : setStatus("스토리 프로젝트 폴더를 여세요."))
      .catch(() => setStatus("Tauri 앱에서 실행해 주세요."));
  }, [loadProject]);

  useEffect(() => {
    if (!dirty || !draft || !root || !revision) return;
    const timer = window.setTimeout(() => {
      localStorage.setItem(`love-office-draft:${root}:${draft.id}`, JSON.stringify({ revision, scene: draft }));
      setStatus("초안을 로컬에 자동 저장했습니다.");
    }, 500);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, revision, root]);

  useEffect(() => {
    if (!runtime || !root || !heroineId) return;
    const speakerId = selectedNode?.speaker || heroineId;
    const art = runtime.characters[speakerId]?.visual?.concept_art || runtime.characters[heroineId]?.visual?.concept_art;
    if (!art || imageCache[art]) return;
    invoke<string>("read_asset", { root, relativePath: art })
      .then((data) => setImageCache((current) => ({ ...current, [art]: data })))
      .catch(() => undefined);
  }, [heroineId, imageCache, root, runtime, selectedNode]);

  const currentImage = useMemo(() => {
    if (!runtime || !heroineId) return undefined;
    const speakerId = selectedNode?.speaker || heroineId;
    const art = runtime.characters[speakerId]?.visual?.concept_art || runtime.characters[heroineId]?.visual?.concept_art;
    return art ? imageCache[art] : undefined;
  }, [heroineId, imageCache, runtime, selectedNode]);

  const updateDraft = (updater: (scene: Scene) => void) => {
    setDraft((current) => {
      if (!current) return current;
      const next = clone(current);
      updater(next);
      next.state_contract = deriveStateContract(next);
      setHistory((value) => ({ past: [...value.past, clone(current)].slice(-100), future: [] }));
      setDirty(true);
      return next;
    });
  };

  const updateNode = (node: StoryNode) => updateDraft((scene) => { scene.nodes[node.id] = node; });

  const undo = () => {
    if (!draft || history.past.length === 0) return;
    const previous = history.past[history.past.length - 1];
    setHistory({ past: history.past.slice(0, -1), future: [clone(draft), ...history.future].slice(0, 100) });
    setDraft(previous);
    setDirty(true);
  };

  const redo = () => {
    if (!draft || history.future.length === 0) return;
    const next = history.future[0];
    setHistory({ past: [...history.past, clone(draft)].slice(-100), future: history.future.slice(1) });
    setDraft(next);
    setDirty(true);
  };

  const selectProject = async () => {
    if (dirty && !window.confirm("저장하지 않은 변경을 버리고 다른 프로젝트를 열까요?")) return;
    const result = await open({ directory: true, multiple: false, title: "스토리 프로젝트 폴더 선택" });
    if (typeof result === "string") await loadProject(result);
  };

  const validate = async () => {
    if (!root) return;
    setBusy(true);
    try {
      if (draft) {
        const result = await invoke<{ issues: ValidationIssue[]; state_contract: Scene["state_contract"] }>("validate_scene", { root, scene: draft });
        setIssues(result.issues);
        setDraft((current) => current ? { ...current, state_contract: result.state_contract } : current);
        setStatus(result.issues.length ? `${result.issues.length}개 검증 항목이 있습니다.` : "현재 초안에 오류가 없습니다.");
      } else {
        const result = await invoke<{ issues: ValidationIssue[] }>("validate_project", { root });
        setIssues(result.issues);
      }
    } catch (error) {
      setStatus(`검증 실패: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!root || !draft || !payload) return;
    setBusy(true);
    setStatus("전체 프로젝트를 검증하고 안전하게 저장하는 중…");
    try {
      const result = await invoke<{
        saved: boolean;
        issues: ValidationIssue[];
        runtime?: Runtime;
        document?: ProjectPayload["documents"]["scenes"][string];
      }>("save_scene", { root, scene: draft, revision });
      setIssues(result.issues);
      if (!result.saved || !result.runtime || !result.document) {
        setStatus("오류가 있어 원본에는 저장하지 않았습니다.");
        return;
      }
      const nextProject = clone(payload);
      nextProject.runtime = result.runtime;
      nextProject.documents.scenes[draft.id] = result.document;
      setPayload(nextProject);
      setRevision(result.document.revision);
      setDraft(clone(result.runtime.scenes[draft.id]));
      setDirty(false);
      setHistory({ past: [], future: [] });
      localStorage.removeItem(`love-office-draft:${root}:${draft.id}`);
      setStatus("YAML과 런타임을 저장했습니다.");
    } catch (error) {
      const message = String(error);
      setStatus(message.includes("REVISION_CONFLICT") ? "외부에서 파일이 변경되었습니다. 프로젝트를 다시 불러온 뒤 비교하세요." : `저장 실패: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const build = async () => {
    if (!root || dirty) {
      setStatus(dirty ? "먼저 현재 초안을 소스에 저장하세요." : "프로젝트가 열리지 않았습니다.");
      return;
    }
    setBusy(true);
    try {
      const result = await invoke<{ built: boolean; issues: ValidationIssue[]; runtime?: Runtime }>("build_runtime", { root });
      setIssues(result.issues);
      if (result.built && result.runtime && payload) {
        setPayload({ ...payload, runtime: result.runtime });
        setStatus("story-runtime.json을 다시 빌드했습니다.");
      } else setStatus("검증 오류로 빌드하지 않았습니다.");
    } catch (error) {
      setStatus(`빌드 실패: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const addNode = () => {
    if (!draft || !heroineId || !newNodeId.trim()) return;
    const id = newNodeId.trim();
    if (!/^[a-z][a-z0-9_]*$/.test(id)) {
      setStatus("노드 ID는 영문 소문자, 숫자와 밑줄만 사용할 수 있습니다.");
      return;
    }
    if (draft.nodes[id]) {
      setStatus("같은 노드 ID가 이미 있습니다.");
      return;
    }
    updateDraft((scene) => {
      scene.nodes[id] = makeNode(newNodeKind, id, heroineId);
      scene.node_order.push(id);
    });
    setSelectedNodeId(id);
    setNewNodeId("");
  };

  const deleteNode = () => {
    if (!draft || !selectedNodeId) return;
    if (draft.node_order.length <= 1) return;
    if (!window.confirm(`${selectedNodeId} 노드를 삭제할까요? 연결 참조는 검증 오류로 표시됩니다.`)) return;
    const index = draft.node_order.indexOf(selectedNodeId);
    updateDraft((scene) => {
      delete scene.nodes[selectedNodeId];
      scene.node_order = scene.node_order.filter((id) => id !== selectedNodeId);
      if (scene.start_node === selectedNodeId) scene.start_node = scene.node_order[0];
    });
    setSelectedNodeId(draft.node_order[Math.max(0, index - 1)]);
  };

  const moveNode = (offset: number) => {
    if (!draft) return;
    const index = draft.node_order.indexOf(selectedNodeId);
    const target = index + offset;
    if (target < 0 || target >= draft.node_order.length) return;
    updateDraft((scene) => {
      [scene.node_order[index], scene.node_order[target]] = [scene.node_order[target], scene.node_order[index]];
    });
  };

  const selectIssue = (issue: ValidationIssue) => {
    if (!payload) return;
    const sceneId = Object.keys(payload.runtime.scenes).find((id) => issue.location.includes(id));
    if (sceneId && sceneId !== selectedSceneId) loadScene(payload, sceneId);
    const targetScene = payload.runtime.scenes[sceneId || selectedSceneId];
    const node = targetScene?.node_order.find((id) => issue.location.includes(`#${id}`) || issue.location.includes(`nodes[${targetScene.node_order.indexOf(id)}]`));
    if (node) setSelectedNodeId(node);
  };

  if (!payload || !runtime || !draft || !testState) {
    return <main className="empty-shell">
      <div className="empty-card">
        <p className="eyebrow">PUSH &amp; PULL OFFICE</p>
        <h1>스토리 에디터</h1>
        <p>{status}</p>
        <button type="button" className="primary-button" onClick={selectProject} disabled={busy}>프로젝트 폴더 열기</button>
      </div>
    </main>;
  }

  const contract = deriveStateContract(draft);
  const errorCount = issues.filter((issue) => issue.severity === "error").length;

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><p className="eyebrow">PUSH &amp; PULL OFFICE</p><h1>스토리 에디터</h1></div>
      <div className="project-status"><strong>{runtime.project.title}</strong><span className={dirty ? "dirty" : ""}>{dirty ? "● 저장 안 됨" : "✓ 저장됨"}</span><span className={errorCount ? "error" : ""}>{errorCount} 오류</span></div>
      <div className="top-actions">
        <button type="button" onClick={selectProject} disabled={busy}>프로젝트 열기</button>
        <button type="button" onClick={undo} disabled={!history.past.length || busy}>실행 취소</button>
        <button type="button" onClick={redo} disabled={!history.future.length || busy}>다시 실행</button>
        <button type="button" onClick={validate} disabled={busy}>검증</button>
        <button type="button" onClick={build} disabled={busy || dirty}>런타임 빌드</button>
        <button type="button" className="primary-button" onClick={save} disabled={busy || !dirty}>소스 저장</button>
      </div>
    </header>

    <div className="status-line" role="status"><span>{busy ? "처리 중 · " : ""}{status}</span><code>{root}</code></div>

    <div className="editor-layout">
      <nav className="explorer" aria-label="스토리 탐색기">
        <div className="panel-heading"><div><p className="eyebrow">STORY</p><h2>루트와 장면</h2></div></div>
        <div className="route-tree">{Object.values(runtime.routes).map((route) => {
          const sceneIds = [...route.scene_order, ...route.endings.map((ending) => ending.scene)];
          return <section key={route.id} className={route.id === draft.route ? "route-group active" : "route-group"}>
            <h3>{route.title}<small>{runtime.characters[route.heroine]?.display_name}</small></h3>
            {sceneIds.map((id) => <button type="button" className={id === selectedSceneId ? "scene-link active" : "scene-link"} key={id} onClick={() => loadScene(payload, id)}>
              <span>{runtime.scenes[id]?.title || id}</span><small>{runtime.scenes[id]?.node_order.length || 0}</small>
            </button>)}
          </section>;
        })}</div>
      </nav>

      <section className="editor-panel">
        <div className="editor-title">
          <div><p className="eyebrow">{draft.id}</p><h2>{draft.title}</h2><p>{draft.purpose}</p></div>
          <div className="contract-summary"><span>읽기 {contract.reads.length}</span><span>쓰기 {contract.writes.length}</span></div>
        </div>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={editorTab === "scene"} className={editorTab === "scene" ? "active" : ""} onClick={() => setEditorTab("scene")}>장면</button>
          <button type="button" role="tab" aria-selected={editorTab === "node"} className={editorTab === "node" ? "active" : ""} onClick={() => setEditorTab("node")}>노드</button>
          <button type="button" role="tab" aria-selected={editorTab === "source"} className={editorTab === "source" ? "active" : ""} onClick={() => setEditorTab("source")}>원본 YAML</button>
        </div>

        {editorTab === "scene" && <div className="scroll-area scene-form">
          <div className="form-grid">
            <Field label="장면 제목"><TextInput value={draft.title} onChange={(event) => updateDraft((scene) => { scene.title = event.target.value; })} /></Field>
            <Field label="시작 노드"><select value={draft.start_node} onChange={(event) => updateDraft((scene) => { scene.start_node = event.target.value; })}>{draft.node_order.map((id) => <option value={id} key={id}>{id}</option>)}</select></Field>
            <Field label="장면 목적" wide><TextArea value={draft.purpose} onChange={(event) => updateDraft((scene) => { scene.purpose = event.target.value; })} /></Field>
            <Field label="장소"><TextInput value={draft.location || ""} onChange={(event) => updateDraft((scene) => { scene.location = event.target.value; })} /></Field>
            <Field label="시간"><TextInput value={draft.time || ""} onChange={(event) => updateDraft((scene) => { scene.time = event.target.value; })} /></Field>
            <Field label="챕터"><TextInput type="number" min="0" value={draft.chapter || 0} onChange={(event) => updateDraft((scene) => { scene.chapter = Number(event.target.value); })} /></Field>
            <Field label="정렬 순서"><TextInput type="number" min="0" value={draft.sequence || 0} onChange={(event) => updateDraft((scene) => { scene.sequence = Number(event.target.value); })} /></Field>
          </div>
          <fieldset className="cast-editor"><legend>출연 인물</legend>{Object.values(runtime.characters).map((character) => <label className="check-row" key={character.id}><input type="checkbox" checked={draft.cast.includes(character.id)} onChange={(event) => updateDraft((scene) => { scene.cast = event.target.checked ? [...scene.cast, character.id] : scene.cast.filter((id) => id !== character.id); })} /><span>{character.display_name}</span><small>{character.id}</small></label>)}</fieldset>
          <fieldset className="entry-condition-editor"><legend>장면 진입 조건</legend><ConditionEditor runtime={runtime} conditions={draft.entry_conditions || []} onChange={(conditions) => updateDraft((scene) => { scene.entry_conditions = conditions; })} /></fieldset>
          <fieldset className="contract-editor"><legend>자동 계산된 상태 계약</legend><div><strong>읽는 수치</strong>{contract.reads.map((path) => <code key={path}>{path}</code>)}</div><div><strong>바꾸는 수치</strong>{contract.writes.map((path) => <code key={path}>{path}</code>)}</div></fieldset>
        </div>}

        {editorTab === "node" && <div className="node-workspace">
          <div className="node-flow-toolbar">
            <div className="node-flow" role="list">{draft.node_order.map((id) => <button type="button" role="listitem" className={id === selectedNodeId ? "node-pill active" : "node-pill"} key={id} onClick={() => setSelectedNodeId(id)}><span>{id}</span><small>{NODE_LABELS[draft.nodes[id].kind]}</small></button>)}</div>
            <div className="node-actions"><button type="button" aria-label="노드를 앞으로" onClick={() => moveNode(-1)}>←</button><button type="button" aria-label="노드를 뒤로" onClick={() => moveNode(1)}>→</button><button type="button" className="danger" onClick={deleteNode}>노드 삭제</button></div>
          </div>
          <div className="new-node-row"><input placeholder="새 노드 ID" value={newNodeId} onChange={(event) => setNewNodeId(event.target.value)} /><select value={newNodeKind} onChange={(event) => setNewNodeKind(event.target.value as NodeKind)}>{Object.entries(NODE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><button type="button" onClick={addNode}>노드 추가</button></div>
          <div className="scroll-area">{selectedNode ? <NodeEditor runtime={runtime} scene={draft} node={selectedNode} onChange={updateNode} /> : <p>노드를 선택하세요.</p>}</div>
        </div>}

        {editorTab === "source" && <div className="scroll-area source-view"><div className="source-notice">원본은 읽기 전용입니다. 구조화된 폼에서 저장하면 주석과 키 순서를 보존해 갱신합니다.</div><pre><code>{payload.documents.scenes[draft.id]?.source}</code></pre></div>}
      </section>

      <Preview runtime={runtime} scene={draft} selectedNodeId={selectedNodeId} mode={mode} onMode={setMode} state={testState} initialState={runtime.initial_state} onState={setTestState} image={currentImage} />
    </div>

    <section className="validation-drawer">
      <div className="validation-heading"><div><p className="eyebrow">VALIDATION</p><h2>검증 결과</h2></div><span>{issues.length ? `${issues.length}개 항목` : "오류 없음"}</span></div>
      {issues.length === 0 ? <p className="validation-empty">현재 프로젝트에서 오류나 경고를 찾지 못했습니다.</p> : <div className="issue-list">{issues.map((issue, index) => <button type="button" className={`issue ${issue.severity}`} key={`${issue.location}-${index}`} onClick={() => selectIssue(issue)}><strong>{issue.severity.toUpperCase()}</strong><span>{issue.message}</span><small>{issue.location}</small></button>)}</div>}
    </section>
  </main>;
}
