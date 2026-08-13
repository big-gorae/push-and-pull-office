(() => {
  const els = {
    status: document.querySelector('#runtime-status'),
    route: document.querySelector('#route-select'),
    scene: document.querySelector('#scene-select'),
    reset: document.querySelector('#reset-state'),
    initiative: document.querySelector('#initiative-input'),
    initiativeOutput: document.querySelector('#initiative-output'),
    suspicion: document.querySelector('#suspicion-input'),
    suspicionOutput: document.querySelector('#suspicion-output'),
    dislike: document.querySelector('#dislike-input'),
    dislikeOutput: document.querySelector('#dislike-output'),
    evidence: document.querySelector('#evidence-input'),
    evidenceOutput: document.querySelector('#evidence-output'),
    emotion: document.querySelector('#emotion-result'),
    location: document.querySelector('#scene-location'),
    title: document.querySelector('#preview-title'),
    purpose: document.querySelector('#scene-purpose'),
    nodeKind: document.querySelector('#node-kind'),
    preview: document.querySelector('#game-preview'),
    image: document.querySelector('#character-image'),
    speaker: document.querySelector('#speaker-name'),
    expression: document.querySelector('#expression-name'),
    tools: document.querySelector('#visible-tools'),
    line: document.querySelector('#dialogue-line'),
    interpretation: document.querySelector('#interpretation'),
    flags: document.querySelector('#presentation-flags'),
    choices: document.querySelector('#choice-area'),
    next: document.querySelector('#next-node'),
    stepStatus: document.querySelector('#step-status'),
    flow: document.querySelector('#node-flow'),
    branchSummary: document.querySelector('#branch-summary'),
    conditions: document.querySelector('#condition-list')
  };

  let runtime;
  let state;
  let routeId;
  let sceneId;
  let nodeId;
  let heroineId;
  let lastDecision = null;

  const imageByCharacter = {
    yoon_seo_a: '../assets/concept-art/yoon-seo-a.png',
    cha_min_kyung: '../assets/concept-art/cha-min-kyung.png',
    kang_yoo_jin: '../assets/concept-art/kang-yoo-jin.png',
    han_do_yoon: '../assets/concept-art/han-do-yoon.png',
    im_soo_yeon: '../assets/concept-art/im-soo-yeon.png'
  };

  const kindNames = {
    dialogue: '대사',
    narration: '내레이션',
    silent: '무대사',
    choice: '선택지',
    state_gate: '수치 분기',
    effect: '상태 반영',
    exit: '장면 이탈'
  };

  const operationNames = { eq: '=', gte: '≥', lte: '≤', gt: '>', lt: '<', contains: '포함' };

  const clone = value => JSON.parse(JSON.stringify(value));

  function getPath(path) {
    return path.split('.').reduce((value, key) => value == null ? undefined : value[key], state);
  }

  function setPath(path, value) {
    const parts = path.split('.');
    const key = parts.pop();
    const target = parts.reduce((value, part) => value[part], state);
    target[key] = value;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function conditionMet(condition) {
    const current = getPath(condition.path);
    switch (condition.op) {
      case 'eq': return current === condition.value;
      case 'gte': return current >= condition.value;
      case 'lte': return current <= condition.value;
      case 'gt': return current > condition.value;
      case 'lt': return current < condition.value;
      case 'contains': return Array.isArray(current) && current.includes(condition.value);
      default: return false;
    }
  }

  function allConditionsMet(conditions = []) {
    return conditions.every(conditionMet);
  }

  function effectConditionsMet(effect) {
    return allConditionsMet(effect.conditions || []);
  }

  function applyEffect(effect) {
    if (!effectConditionsMet(effect)) return;
    const current = getPath(effect.path);
    if (effect.op === 'add') {
      const definitionKey = effect.path.includes('.initiative')
          ? 'visible.initiative'
          : effect.path.includes('.suspicion')
            ? 'hidden.suspicion'
            : effect.path.includes('.dislike')
              ? 'hidden.dislike'
              : 'hidden.evidence_count';
      const definition = runtime.stats[definitionKey];
      setPath(effect.path, clamp(current + effect.value, definition.min, definition.max));
    } else if (effect.op === 'set') {
      setPath(effect.path, effect.value);
    } else if (effect.op === 'append_unique') {
      if (!current.includes(effect.value)) current.push(effect.value);
    }
  }

  function selectedRoute() {
    return runtime.routes[routeId];
  }

  function selectedScene() {
    return runtime.scenes[sceneId];
  }

  function selectedNode() {
    return selectedScene().nodes[nodeId];
  }

  function heroineState() {
    return {
      visible: state.visible.heroines[heroineId],
      hidden: state.hidden.heroines[heroineId]
    };
  }

  function characterName(id) {
    return runtime.characters[id]?.display_name || '내레이션';
  }

  function decideTransition(transitions) {
    const evaluated = transitions.map(transition => ({
      transition,
      met: transition.default === true || allConditionsMet(transition.conditions || [])
    }));
    const chosen = evaluated.find(item => item.met);
    lastDecision = { evaluated, chosen };
    return chosen?.transition;
  }

  function enterNode(targetNodeId, applyAutomaticEffects = true) {
    const scene = selectedScene();
    let target = targetNodeId;
    let guard = 0;
    lastDecision = null;

    while (guard < 20) {
      guard += 1;
      const node = scene.nodes[target];
      if (!node) break;

      if (node.kind === 'state_gate') {
        const transition = decideTransition(node.transitions);
        target = transition?.node;
        continue;
      }

      if (node.kind === 'effect' && applyAutomaticEffects) {
        node.effects.forEach(applyEffect);
        target = node.next;
        continue;
      }

      nodeId = target;
      render();
      return;
    }

    nodeId = targetNodeId;
    render();
  }

  function endingSceneIds(route) {
    return (route.endings || []).map(ending => ending.scene);
  }

  function populateRoutes() {
    els.route.replaceChildren();
    Object.values(runtime.routes).forEach(route => {
      const option = document.createElement('option');
      option.value = route.id;
      option.textContent = route.title;
      els.route.appendChild(option);
    });
    routeId = Object.keys(runtime.routes)[0];
    els.route.value = routeId;
  }

  function populateScenes(preferredScene) {
    const route = selectedRoute();
    els.scene.replaceChildren();

    const mainGroup = document.createElement('optgroup');
    mainGroup.label = '본편 장면';
    route.scene_order.forEach(id => mainGroup.appendChild(sceneOption(id)));
    els.scene.appendChild(mainGroup);

    const endings = endingSceneIds(route);
    if (endings.length) {
      const endingGroup = document.createElement('optgroup');
      endingGroup.label = '엔딩';
      endings.forEach(id => endingGroup.appendChild(sceneOption(id)));
      els.scene.appendChild(endingGroup);
    }

    sceneId = preferredScene && runtime.scenes[preferredScene] ? preferredScene : route.entry_scene;
    els.scene.value = sceneId;
  }

  function sceneOption(id) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = runtime.scenes[id].title;
    return option;
  }

  function loadScene(id, fromInitialState = false) {
    sceneId = id;
    const route = selectedRoute();
    heroineId = route.heroine;
    if (fromInitialState) state = clone(runtime.initial_state);
    syncStateControls();
    enterNode(selectedScene().start_node);
  }

  function syncStateControls() {
    const values = heroineState();
    els.initiative.value = values.visible.initiative;
    els.initiativeOutput.value = values.visible.initiative;
    els.suspicion.value = values.hidden.suspicion;
    els.suspicionOutput.value = values.hidden.suspicion;
    els.dislike.value = values.hidden.dislike;
    els.dislikeOutput.value = values.hidden.dislike;
    els.evidence.value = values.hidden.evidence_count;
    els.evidenceOutput.value = values.hidden.evidence_count;
  }

  function updateStateFromControls() {
    const values = heroineState();
    values.visible.initiative = Number(els.initiative.value);
    values.hidden.suspicion = Number(els.suspicion.value);
    values.hidden.dislike = Number(els.dislike.value);
    values.hidden.evidence_count = Number(els.evidence.value);
    syncStateControls();
    enterNode(selectedScene().start_node, false);
  }

  function activeEmotionRule() {
    const character = runtime.characters[heroineId];
    const hidden = heroineState().hidden;
    const rules = [...(character.emotion_rules || [])].sort((a, b) => b.priority - a.priority);
    return rules.find(rule => (rule.conditions || []).every(condition => {
      const current = hidden[condition.stat];
      return condition.op === 'gte' ? current >= condition.value
        : condition.op === 'lte' ? current <= condition.value
          : condition.op === 'eq' ? current === condition.value
            : false;
    }));
  }

  function renderEmotion() {
    const rule = activeEmotionRule();
    if (!rule) {
      els.emotion.textContent = '감정 규칙 없음';
      return;
    }
    els.emotion.innerHTML = '<strong>실제 감정: ' + rule.emotion + '</strong><br>'
      + '행동: ' + rule.behavior + '<br>'
      + '기본 표정: ' + rule.default_expression;
  }

  function renderTools(node) {
    const values = heroineState();
    const rule = activeEmotionRule();
    const labels = [
      '주도권 ' + values.visible.initiative,
      '의심 ' + values.hidden.suspicion,
      '비호감 ' + values.hidden.dislike,
      '증거 ' + values.hidden.evidence_count,
      '감정 ' + (rule?.emotion || '미정')
    ];
    els.tools.replaceChildren();
    labels.forEach(label => {
      const chip = document.createElement('span');
      chip.className = 'tool-chip';
      chip.textContent = label;
      els.tools.appendChild(chip);
    });

    els.flags.replaceChildren();
    (node.presentation_flags || []).forEach(flag => {
      const chip = document.createElement('span');
      chip.className = 'flag-chip';
      chip.textContent = flag;
      els.flags.appendChild(chip);
    });
  }

  function renderDialogue(node) {
    const speakerId = node.speaker || heroineId;
    const speaker = runtime.characters[speakerId];
    const expressionId = node.expression || activeEmotionRule()?.default_expression || 'narration';
    const expression = speaker?.expressions?.[expressionId];

    els.speaker.textContent = node.kind === 'narration' ? '내레이션' : characterName(speakerId);
    els.expression.textContent = expressionId + (expression?.description ? ' · ' + expression.description : '');
    els.image.src = imageByCharacter[speakerId] || imageByCharacter[heroineId];
    els.image.alt = characterName(speakerId) + ' 콘셉트 아트';
    els.line.textContent = node.line || '표시할 대사가 없습니다.';
    els.interpretation.textContent = '장면 원문';
  }

  function effectLabel(effect) {
    const shortPath = effect.path.split('.').pop();
    if (effect.op === 'add') return shortPath + ' ' + (effect.value >= 0 ? '+' : '') + effect.value;
    if (effect.op === 'set') return shortPath + ' → ' + effect.value;
    return shortPath + ' +' + effect.value;
  }

  function renderChoice(node) {
    els.choices.replaceChildren();
    node.options.forEach(option => {
      const allowed = allConditionsMet(option.conditions || []);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'choice-card';
      button.disabled = !allowed;

      const title = document.createElement('strong');
      title.textContent = option.label;
      const detail = document.createElement('small');
      detail.textContent = allowed ? option.action : '현재 수치에서는 잠긴 선택지';
      const effects = document.createElement('span');
      effects.className = 'effect-list';
      option.effects.forEach(effect => {
        const chip = document.createElement('span');
        chip.className = 'effect-chip';
        chip.textContent = effectLabel(effect);
        effects.appendChild(chip);
      });

      button.append(title, detail, effects);
      button.addEventListener('click', () => {
        option.effects.forEach(applyEffect);
        syncStateControls();
        enterNode(option.next);
      });
      els.choices.appendChild(button);
    });
  }

  function renderNonDialogue(node) {
    const route = selectedRoute();
    els.speaker.textContent = characterName(heroineId);
    els.expression.textContent = activeEmotionRule()?.default_expression || 'state';
    els.image.src = imageByCharacter[heroineId];
    els.image.alt = characterName(heroineId) + ' 콘셉트 아트';
    if (node.kind === 'choice') {
      els.line.textContent = node.prompt;
      els.interpretation.textContent = '선택하면 효과를 적용하고 다음 노드로 이동합니다.';
    } else if (node.kind === 'exit') {
      const transition = decideTransition(node.transitions);
      const target = transition?.scene;
      els.line.textContent = target ? '다음 장면: ' + runtime.scenes[target].title : '루트 종료';
      els.interpretation.textContent = target ? target : route.id;
    } else {
      els.line.textContent = kindNames[node.kind] || node.kind;
      els.interpretation.textContent = '현재 상태를 계산하는 노드입니다.';
    }
  }

  function renderFlow(scene, node) {
    els.flow.replaceChildren();
    scene.node_order.forEach(id => {
      const flowNode = scene.nodes[id];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'node-step' + (id === node.id ? ' active' : '');
      button.setAttribute('aria-pressed', id === node.id ? 'true' : 'false');
      const name = document.createElement('span');
      name.textContent = id;
      const kind = document.createElement('small');
      kind.textContent = kindNames[flowNode.kind] || flowNode.kind;
      button.append(name, kind);
      button.addEventListener('click', () => enterNode(id, false));
      els.flow.appendChild(button);
    });
  }

  function readablePath(path) {
    const names = {
      initiative: '주도권',
      suspicion: '의심도', dislike: '비호감', evidence_count: '증거',
      cleared_routes: '클리어 루트', unlocked_modes: '해금 모드'
    };
    return names[path.split('.').pop()] || path;
  }

  function renderDecision() {
    els.conditions.replaceChildren();
    if (!lastDecision) {
      els.branchSummary.textContent = '수치 분기 없음';
      return;
    }

    const destination = lastDecision.chosen?.transition.node || lastDecision.chosen?.transition.scene || '없음';
    els.branchSummary.textContent = '현재 판정 → ' + destination;

    lastDecision.evaluated.forEach((item, index) => {
      const conditions = item.transition.conditions || [];
      if (item.transition.default) {
        const row = document.createElement('div');
        row.className = 'condition-row' + (item.met ? ' met' : '');
        row.innerHTML = '<strong>' + (item.met ? '●' : '○') + ' 기본 분기</strong>앞 조건이 모두 실패할 때 선택';
        els.conditions.appendChild(row);
        return;
      }

      conditions.forEach(condition => {
        const row = document.createElement('div');
        const met = conditionMet(condition);
        row.className = 'condition-row' + (met ? ' met' : '');
        const current = getPath(condition.path);
        row.innerHTML = '<strong>' + (met ? '● 충족' : '○ 미충족') + ' · 분기 ' + (index + 1) + '</strong>'
          + readablePath(condition.path) + ' ' + (operationNames[condition.op] || condition.op) + ' ' + condition.value
          + ' <span>(현재 ' + current + ')</span>';
        els.conditions.appendChild(row);
      });
    });
  }

  function render() {
    const scene = selectedScene();
    const node = selectedNode();
    if (!scene || !node) return;

    els.location.textContent = scene.location + ' · ' + scene.time;
    els.title.textContent = scene.title;
    els.purpose.textContent = scene.purpose;
    els.nodeKind.textContent = kindNames[node.kind] || node.kind;
    els.stepStatus.textContent = node.id + ' · ' + scene.id;

    renderEmotion();
    renderTools(node);
    els.choices.replaceChildren();

    if (node.kind === 'dialogue' || node.kind === 'narration' || node.kind === 'silent') {
      renderDialogue(node);
    } else {
      renderNonDialogue(node);
    }

    if (node.kind === 'choice') renderChoice(node);

    els.next.hidden = node.kind === 'choice';
    els.next.textContent = node.kind === 'exit' ? '다음 장면 열기' : '다음 노드';
    els.next.disabled = node.kind !== 'exit' && !node.next;

    renderFlow(scene, node);
    renderDecision();
  }

  function advance() {
    const node = selectedNode();
    if (node.kind === 'exit') {
      const transition = decideTransition(node.transitions);
      if (transition?.scene) {
        const targetScene = runtime.scenes[transition.scene];
        sceneId = transition.scene;
        els.scene.value = sceneId;
        if (!targetScene) return;
        loadScene(sceneId);
      }
      return;
    }
    if (node.next) enterNode(node.next);
  }

  function bindEvents() {
    els.route.addEventListener('change', () => {
      routeId = els.route.value;
      populateScenes();
      loadScene(sceneId, true);
    });
    els.scene.addEventListener('change', () => loadScene(els.scene.value));
    els.reset.addEventListener('click', () => loadScene(sceneId, true));
    els.next.addEventListener('click', advance);

    [els.initiative, els.suspicion, els.dislike, els.evidence]
      .forEach(input => input.addEventListener('input', updateStateFromControls));
  }

  async function boot() {
    try {
      const response = await fetch('../build/story-runtime.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('runtime HTTP ' + response.status);
      runtime = await response.json();
      state = clone(runtime.initial_state);
      populateRoutes();
      populateScenes();
      bindEvents();
      loadScene(sceneId);
      els.status.textContent = Object.keys(runtime.scenes).length + '개 장면 · ' + runtime.generated_at.slice(0, 10) + ' 빌드';
    } catch (error) {
      els.status.textContent = '데이터 로드 실패';
      els.status.classList.add('error-message');
      els.line.textContent = 'make story-editor로 실행했는지 확인하세요.';
      els.interpretation.textContent = error.message;
    }
  }

  boot();
})();
