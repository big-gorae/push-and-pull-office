# Love Office Agent Instructions

## Repository GitHub identity

- Use the GitHub account big-gorae exclusively for this repository's commits, pushes, pull requests, and GitHub API or CLI operations.
- Keep the repository-local Git identity set to big-gorae with 293377911+big-gorae@users.noreply.github.com; never fall back to the global binary-ho identity.
- Keep origin pointed at https://github.com/big-gorae/push-and-pull-office.git.
- This checkout stores its project-only GitHub CLI configuration under the common Git directory at `private-gh`. Every agent session and linked worktree must resolve it with `love_office_gh_dir="$(git rev-parse --git-common-dir)/private-gh"` and run GitHub CLI commands as `GH_CONFIG_DIR="$love_office_gh_dir" gh ...`. Do not rely on the global GitHub CLI account.
- Normal `git fetch`, `git pull`, and `git push` commands use the repository-local credential helper already recorded in the common Git config. Do not clear, replace, or bypass that helper. Verify it with `git config --show-origin --get-all credential.helper` when authentication behavior is uncertain.
- Before any remote publication, run `GH_CONFIG_DIR="$love_office_gh_dir" gh auth status` with network access and verify that the active account is big-gorae. A restricted sandbox can make a valid token look invalid because the GitHub API is unreachable; retry with the session's approved network escalation before diagnosing token expiry.
- If the project-only authentication is genuinely missing or expired, authenticate only that directory with `GH_CONFIG_DIR="$love_office_gh_dir" gh auth login -h github.com --git-protocol https --web`. Never switch this repository to another account and never copy tokens into tracked files, shell output, logs, or documentation.
- The project-only authentication is shared by sessions using this same repository's common Git directory, but it is not committed. A fresh clone must perform the project-only login once before publishing.

## Browser identity

- Use only the Chrome profile `big.gorea.king` for NovelAI and every other Chrome automation performed for this repository. The Chrome extension reports this profile's exact metadata name as `big.gorea.king@gmail.com`.
- Before claiming or interacting with any Chrome tab, verify that the connected browser metadata reports the exact profile name `big.gorea.king@gmail.com`.
- If any other Chrome profile is connected, stop immediately. Never navigate, click, type, upload, generate, or otherwise interact with that profile.

## Local launch command mapping

Use these exact Korean commands as user-facing shortcuts. They refer to the named build/surface terms in the project docs; do not collapse them into a generic “debug” request.

- `게임 켜줘`: launch the **Play Build** with `npm run dev`. This is the read-only player surface. Do not open the Tauri editor or enable authoring controls for this command.
- `디버그 모드`: launch or focus the **Authoring Build** with `make tauri-dev`, then ensure the in-game `디버그 모드` setting is enabled. If the Tauri app is already running, keep the current project and toggle the setting instead of starting a second server. Debug Mode is an inspector inside the Authoring Build, not a separate build.
- `대사 편집 모드` or `작가 모드`: launch or focus the **Authoring Build** with `make tauri-dev`, open the selected project, and use `제작 플레이 열기`. This is the writable play surface for dialogue, scene, artwork, background, and asset authoring.
- Authoring Build launch requests are single-instance. Never run `make tauri-dev` again while this repository's Authoring Build is already running; focus and reuse the existing `main` editor window and the existing `authoring-play` window. Do not perform a separate narrated launch-status audit. If the user explicitly asks to restart, terminate all existing Love Office Tauri development instances first, then launch exactly one Authoring Build and reuse its single `authoring-play` window.
- After `make tauri-dev`, never address the editor through Computer Use by the installed bundle ID `com.pushandpulloffice.storyeditor`. The development binary is not reliably registered as that installed app, so Computer Use may launch `src-tauri/target/release/bundle/macos/*.app` and create a second editor. Do not launch or focus the bundled Release app during Authoring Build requests; leave the single development instance running and let its own `main`/`authoring-play` windows provide authoring UI.

Keep the distinction explicit in status messages: **Play Build / 플레이 버전** is read-only, **Authoring Build / 제작 버전** writes approved project files, **제작 플레이** is the in-game authoring screen, and **디버그 모드** only reveals additional inspection controls. A browser `npm run dev` session must never be presented as a writable authoring session.

## Casual `반영` integration workflow

- Treat casual Korean instructions such as `반영해`, `반영`, or `적용해` as a request to integrate the requested work against the current repository state, not merely to edit files in isolation.
- Keep review and validation proportional to the actual change. For documentation, generated-image records, and similarly low-risk changes, inspect the intended diff once, run only a small relevant check such as `git diff --check` or file-integrity validation, and publish without expanding the task into a full repository audit.
- Do not repeat checks that already established the same fact, run `npm run verify` or the full E2E suite for an unrelated low-risk change, or narrate a lengthy launch/auth/history audit unless the affected scope or an observed failure specifically requires it.
- Before considering that work complete, inspect recent local commits and fetch the latest `origin/main`. Confirm that the CI run triggered by the current `origin/main` commit completed successfully; do not push another commit onto `main` while that preceding main CI is pending or failing.
- Compare the requested commit range with `origin/main` and explicitly inspect overlapping files and reverted/deleted lines. Verify that the new commits do not erase, revert, or bypass the intent of the immediately preceding main commits. Resolve overlaps by preserving both intents; if that cannot be done safely, stop and explain the conflict instead of silently dropping either side.
- Run validation appropriate to the affected scope, require the update to be a fast-forward of the latest `origin/main`, and push the verified commit directly to `origin/main`. Do not create a pull request, automation-branch publishing flow, or auto-merge flow for casual `반영` or `적용`. If repository protection rejects the direct push, stop and report the protection failure; do not create a PR unless the user separately asks for one.
- Do not report `반영` or `적용` as complete while the work exists only on a feature or automation branch. Confirm that `origin/main` resolves to the pushed commit.
- Casual `반영` or `적용` does not deploy. Only `전부 반영` adds deployment of the resulting verified `main` commit unless the user separately requests deployment.

## `전부 반영` publishing workflow

- When the user says `전부 반영`, perform the full casual `반영` workflow by pushing directly to `origin/main`, then deploy the resulting `main` commit without asking for additional approval.
- Before the direct main push, apply the same preceding-main CI, conflict, intent-preservation, fast-forward, and validation gates above.
- Run `npm run verify` locally before publishing. After the direct push, wait for the new `main` CI to pass and deploy only that exact verified SHA.
- Do not include unrelated user changes merely because `전부 반영` was invoked. If a conflict is genuinely ambiguous and both intentions cannot safely be preserved, stop and explain the conflict instead of guessing or discarding work.

## Image prompt authoring workflow

- Unless the user explicitly requests a different setting for the current task, generate every character artwork on a perfectly uniform pure white (`#FFFFFF`) background. Character-art prompts must exclude scenery, gradients, textures, floor planes, cast shadows, contact shadows, and background objects so the white background remains clean and flat.
- Unless the user explicitly instructs otherwise for the current task, NovelAI generation is limited to the standard single-image generation control: keep the image count at `1` and use only `Generate 1 Image` when the Opus UI shows a cost of `0 Anlas`. Do not use 2–4 image batches, Enhance, Upscale, Director Tools transformations, or any other generation action that charges Anlas. Before every generation, verify both `Generate 1 Image` and `0 Anlas`; if either condition is not visible, stop without generating and report it to the user.
- Before adding or changing an unfamiliar visual concept in any NovelAI `*Tags` field, search that one concept with `npm run prompt:harness -- search "<Korean or English concept>"`. Prefer the exact English tag returned by the configured Danbooru tag tool when its description and category match the intended visual meaning.
- A tag already present in `prompt-config/novelai-v45/tag-registry.json` does not need to be searched again when it is only being reused unchanged. NovelAI special tags documented by NovelAI may use the `novelai_official` source; other newly accepted tags normally use `danbooru_tag_tool`.
- Never send a full prompt, character profile, story text, or comma-separated tag list to the external search API. Search one short visual concept at a time. The harness rejects prompt-shaped queries for this reason.
- Do not select a tag merely because its spelling looks similar. Read the returned Korean name, description, category, and usage count. If no semantically correct tag exists, put a concise English sentence in the matching `*Instructions` field instead of inventing a tag.
- Add a newly accepted tag to `tag-registry.json` with its real source before using it in character or defaults JSON. Do not weaken the registry or add a fake source merely to pass validation.
- After any image-prompt change, run `npm run prompt:validate`, `npm run test:prompt-harness`, and `npm run test:prompts`.

## Story source of truth

- Narrative intent and reviews live in `docs/`.
- Machine-readable story truth lives in `story/`.
- Company, team, role, employee, project, and meeting truth lives in `story/world/`. Never invent an office fact in a scene that conflicts with this world bible.
- Do not treat `build/` as an authoring source. It is generated output.
- Before editing story YAML, read `story/AI_AUTHORING_RULES.md` and `story/SPEC.md`.

## Required workflow for story changes

1. Build a bounded context for the exact target scene. Include the prior branch when the scene is not a route entry.

   ```bash
   python3 tools/story_harness.py context \
     --scene <scene_id> \
     --from-route <route_id> \
     --choose <previous_scene>=<option_id>
   ```

2. Edit character, route, or scene YAML. Preserve stable IDs.
3. Run all gates:

   ```bash
   npm run verify
   ```

4. `story_harness.py explore` must cover every route choice option, not only a default strategy.

## Story invariants

- Every dialogue or narration beat must contain both `perceived` and `reality` layers.
- `perceived` is Han Do-yoon's interpretation; `reality` is authoritative.
- Never use the legacy `protagonist_interpretation` or `inner_thought` layer fields. Any inner thought is its own `dual_dialogue` node with `presentation_flags: [inner_voice]`, explicit per-layer `speakers`, and a naturally spoken line enclosed in parentheses. A layer with an explicit null speaker is authoritative narration and stays unparenthesized.
- Narration has no visible speaker label. An explicit null layer speaker is narration, not a character named “나레이션”.
- State reads and writes must be declared in `state_contract`.
- State changes belong only in `effects`.
- Visible affection is Han Do-yoon's confidence, not a heroine's love.
- A decrease in suspicion never implies an automatic decrease in dislike.
- Expressions must be declared on the speaking character before use.
- New scenes must be connected to a route and reachable from its entry.
- Every scene must be scheduled by at least one timeline event.
- Flexible events use a day window and deadline; do not duplicate the same event into daily files.
- Missed events may advance the world through `on_missed` and hidden offscreen events.
- Keep Korean story YAML as the default-language source; add translations only through stable keys in `story/locales/`.
- Do not put asset paths in scenes. Resolve backgrounds from location, time, atmosphere, and view mode through `story/visuals/`.
- Every character has one concrete visual object extending a character archetype; outfit, pose, and expression are composed rather than copied into scenes.
- Every scene node must resolve a background in both perceived and reality modes.
- Formal or cross-functional workplace meetings must declare `world_context` with company, project, meeting type, and every actual participant as `member.*` references. The illustrated `cast` is not a substitute for the full participant list.
- Keep non-illustrated supporting coworkers as `presentation: text_only` world members. They may attend and speak, but must never be placed in the illustrated `cast` or used as a route heroine.
- Meeting casts must satisfy the selected meeting policy's headcount, participating teams, project responsibilities, and minimum text-only coworker requirements. Do not compose a normal office meeting only from romance-route characters.
- When adding or changing a company, team, role, member, project, or meeting, preserve reciprocal team membership and acyclic, upward reporting lines and run the world validator through `story_harness.py validate`.
- Never add detailed, reproducible instructions for committing or concealing abuse.

## Player experience invariants

- 한도윤의 원화는 후반 반전을 위한 보존 자산이다. 원화 파일, `character.han_do_yoon` 비주얼 정의와 NovelAI 프롬프트 프로필은 삭제하지 않는다.
- 한도윤이 화자이거나 장면 `cast`에 포함되어 있어도 평상시 수동 `stage`, 제작 미리보기와 플레이 화면에는 그의 원화를 노출하지 않는다. 평상시에는 배경과 다른 인물만 표시한다.
- 한도윤 원화 공개는 `ending.*` 장면의 `dual_narration` 노드가 `presentation_flags: [protagonist_art_reveal]`를 명시하고 `perceived`와 `reality` 양쪽 `stage`에 `character.han_do_yoon`을 직접 배치한 후반 반전 장면에서만 허용한다. 사용자 지시 없이 공개 시점을 앞당기거나 예외를 추가하지 않는다.
- The new-game screen contains only the three mode cards. `속마음 모드` and `어나더 스토리` both unlock after the first ending; keep their approved descriptions in `story/ui.yaml`.
- Do not infer character artwork from `cast` or the current speaker at runtime. Every visible character must come from an explicit layer `stage` cue stored in scene YAML. In the editor, a newly added dialogue starts without a speaker; selecting a non-Han-Do-yoon illustrated speaker writes that character as the explicit centered default in both layers. Selecting Han Do-yoon never creates ordinary stage cues. Keep character X/Y/scale adjustable in Debug Mode, and keep previous-dialogue navigation available there.
- Do not restore the removed interpretation/thought sub-panels, a `나레이션` nameplate, a timeline/calendar selection screen, visible ACT labels, or copy/effects that promote the campaign's day count.
- Between ordinary moments, present event summaries and selections as dialogue-style in-game beats. Use the cinematic day-change overlay only when the day number changes.
- Every choice node has a neutral `stimulus` summary. Player-facing prompts and labels describe concrete words, actions, or nuanced interpretations; they never reveal `push`, `pull`, `밀기`, `당기기`, or `밀당`. Direction and numeric effects are Debug Mode only.
- Keep the push-pull bar high-contrast above the lower-right dialogue area, use the shared wider optimal range, and do not display “적정 범위 안” copy.
- Put spacing, typography, radii, control sizes, and nameplate/button alignment in the central player design tokens instead of one-off component values.

## Player-facing UX writing

- Keep system phases inside the visual-novel dialogue flow whenever the player can understand them through situation, dialogue, choices, and immediate feedback. Do not replace an ordinary story moment with a separate dashboard or explanatory card page.
- Rich scene dialogue is welcome, but permanent UI copy must be minimal. Add headings, subtitles, descriptions, badges, and help text only when the player cannot make the current decision without them.
- Do not explain authorial intent, thematic meaning, future callbacks, or why a system matters in player-facing copy. Let later dialogue and changed choices reveal the relationship.
- When a choice needs numeric context, show the compact current state at the decision point and keep option text to the concrete action plus concise mechanical deltas.
- Night activity begins with Han Do-yoon arriving home and speaking to himself in the ordinary dialogue presentation. After the line, offer exactly `workout`, `reading`, `ott`, and `sleep`; high fatigue replaces the choice with the forced `solo_drinking` beat.
