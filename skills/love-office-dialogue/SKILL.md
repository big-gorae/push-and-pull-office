---
name: love-office-dialogue
description: Write, revise, review, apply, or evolve Korean visual-novel dialogue for the Love Office repository while preserving the approved character voices, story context, world facts, and artwork policy. Use when the user invokes $love-office-dialogue or asks for 러브오피스 대사, 회의씬·일상씬 원고, 캐릭터 말투 유지, 대사 검수·수정, 장면 YAML 적용, 원화 배치, 말투 기준 추가, or future improvements to the dialogue-authoring standard.
---

# Love Office Dialogue

Use repository truth instead of conversation memory. Keep the workflow stable while letting the approved dialogue and character profiles evolve.

## Start safely

1. Resolve the current Git repository root. Require story/ and tools/story_harness.py, plus at least one valid baseline referenced by a character's voice.baseline_reference. If they are absent, stop and ask the user to open the Love Office repository.
2. Run python3 <this-skill-directory>/scripts/preflight.py from the repository root. Fix or report failed source references before drafting.
3. Read the repository's AGENTS.md. Treat it as authoritative for editing, validation, publishing, artwork, and player-experience rules.
4. Select one operating mode from the user's wording:
   - **Draft**: write, rewrite, continue, or review dialogue without changing files. Use this by default.
   - **Apply**: edit a scene only when the user explicitly asks to put the text into a file or scene, such as “장면에 적용해”, “YAML에 넣어”, or “기존 씬을 교체해”.
   - **Evolve**: update the reusable voice standard when the user approves, corrects, or asks to preserve a new speaking pattern.
5. Do not treat phrases such as “이 기준을 적용해서 써줘” as permission to edit files. That remains Draft mode unless repository mutation is explicit.

## Load only authoritative context

Always read:

- every participating character's story/characters/<id>.yaml;
- every declared voice.baseline_reference in those profiles;
- the participating characters' entries in docs/dialogue-voice-rejections.md when that file exists;
- the target scene when it already exists;
- the relevant company, team, role, member, project, and meeting facts exposed by story/world/.

For an existing scene, build bounded context before writing:

~~~bash
python3 tools/story_harness.py context \
  --scene <scene_id> \
  --from-route <route_id> \
  --choose <previous_scene>=<option_id>
~~~

Omit branch arguments only for a true route entry. Use the context output to identify the preceding event, active state, participants, and world facts. Do not load unrelated routes or scenes.

For Apply or Evolve mode, read story/AI_AUTHORING_RULES.md and story/SPEC.md completely before editing story files.

Use this precedence:

1. Follow the user's current creative intent for the scene.
2. Keep factual claims consistent with story/world/; when the user requests a world change, update world truth rather than silently contradicting it.
3. Preserve branch state and events established by bounded context.
4. Reproduce each character's current voice rules and declared golden samples.
5. Use existing scene prose only when the user has not asked to replace or ignore it.

## Compose without voice drift

Plan the scene privately as beats: entrance, information change, reaction, relationship beat, exit. Then run the following cycle separately for every speaking character before writing the final script.

1. **Generate**: when available, select two to four functionally similar user-approved golden lines and make a provisional semantic version that contains only what the character must notice, feel, say, or do. Do not copy the golden wording. If fewer than two approved lines exist, use every available approved line plus the user's current explicit direction; do not invent missing evidence or treat the new draft as an approved voice standard.
2. **Delete**: remove expressions that conflict with the character profile, the selected golden samples, or that character's recorded rejection cases. Delete outline language, system explanations, balanced summary sentences, generic relationship abstractions, and prose that merely restates the scene purpose when those patterns are not supported by the character's approved voice.
3. **Rewrite**: rebuild the line in the character's approved vocabulary, rhythm, sentence endings, hesitation, reaction order, and current emotional state. The rewritten line must sound character-specific even without its speaker label.
4. **Score**: read references/voice-quality-rubric.md and score the rewritten result. A line that fails a hard gate is discarded regardless of score. Rewrite until every speaking main character passes the required score.

Keep provisional semantic versions, deletion notes, comparison samples, and scores private unless the user explicitly asks to see them. Return or apply only the rewritten dialogue.

- Reproduce rhythm, vocabulary, sentence length, hesitation, reaction order, and humor mechanisms from golden samples.
- Do not copy signature lines merely to sound consistent. Reuse a line only for an intentional callback.
- Make lines attributable without speaker names. If two characters could swap lines without changing the scene, strengthen their distinct response logic.
- Let character knowledge, role, confidence, and emotional safety determine what they say before adding verbal tics.
- Keep Han Do-yoon's spoken dialogue natural and his parenthesized self-talk like the innocent boy protagonist of a Japanese anime: concrete stimulus, immediate emotion, naive evaluation, and an optional quick self-correction. Do not make him calmly summarize relationship strategy, scene design, or control over another person unless a future user-approved golden explicitly establishes that wording.
- Store Han Do-yoon's parenthesized self-talk as ordinary dialogue, never as a removed thought field.
- When Han Do-yoon is home alone at night, treat his monologue as words he actually says aloud: store it as ordinary dialogue without parentheses. Parentheses remain for unspoken reactions in shared scenes or when another person is present.
- In those nightly monologues, do not compress the women he remembers into a short relationship summary. Let him dwell for several lines on concrete visible details, exaggerated comparisons, and naive fantasies of touching, walking with, or spending time with them, following the approved first-night samples. This is a recurring nightly voice rule, not permission to invent new physical facts that contradict character profiles.
- When the dark psychology instructor appears, ground every new line in the approved `강사님 첫 등장 골든`. Preserve his advertising-style callout, self-answering showmanship, elongated tildes and exclamations, inflated credentials, and abrupt certainty; delete calm manual prose before scoring.
- Keep text-only coworkers factual and present when the meeting policy requires them.
- Treat every model-authored line as provisional. Never promote a line to a golden sample or voice.reference_lines in the same task that generated it unless the user explicitly approves that exact line.

## Draft mode

Return a clean script by default:

~~~text
[행동 또는 장면 전환]
한도윤: 대사
한도윤: (속으로 하는 말)
윤서아: 대사
~~~

- Focus on dialogue and minimal action cues.
- Do not add explanations, scores, design intent, IDs, or implementation fields unless requested.
- Preserve any length, required event, cast, or ending condition in the request.
- When a material choice is missing, make the least disruptive assumption and state it in one short sentence before the script.

## Apply mode

1. Build bounded context before editing.
2. Preserve stable scene, node, route, event, and localization IDs where the replacement still represents the same narrative unit.
3. Put one authoritative line and one set of presentation fields on every beat.
4. Use explicit stage cues for visible characters. Use registered existing artwork and valid expressions.
5. Never place Han Do-yoon's artwork in an ordinary scene. Preserve the ending-only reveal contract.
6. Keep formal meetings consistent with world_context and full participant policy.
7. Rebuild generated story artifacts through the repository workflow.
8. Run npm run verify.
9. Inspect the final diff for lost world facts, removed stable contracts, accidental unrelated changes, and voice drift.
10. Follow AGENTS.md exactly if the user also asks to publish, “반영”, or “전부 반영”.

## Evolve mode

Treat user-edited or explicitly approved dialogue as new evidence, not as an automatic replacement for every prior rule.

1. Preserve the approved wording except for confirmed typos, broken markup, and world-bible corrections.
2. Add full approved scene samples to an appropriate docs/dialogue-voice-baseline-*.md file. Only user-authored lines or exact lines explicitly approved by the user qualify as golden samples.
3. When the user rejects a line, record its original wording, context, rejection reason, and reusable failure pattern in docs/dialogue-voice-rejections.md. Do not turn one rejection into a universal ban for unrelated characters or contexts.
4. Update character voice.register, habits, and forbidden only when the correction demonstrates a reusable pattern.
5. Keep voice.reference_lines small and representative. Prefer 3–8 lines per character, each with a distinct context.
6. Never promote a Codex-authored line to a golden sample or voice.reference_lines in the same task that created it without explicit approval of that exact wording.
7. Point voice.baseline_reference at repository documents; never duplicate full golden scripts inside this skill.
8. Change this skill only when the authoring process or evaluation method changes. Change repository voice files when a character's style changes.
9. Validate schemas and run the story validation required by AGENTS.md.
10. Summarize which reusable rule changed so the user can confirm or revise it later.

This separation is the extension mechanism: approved content evolves in docs/ and story/characters/, evaluation evolves in references/voice-quality-rubric.md, and the reusable workflow evolves in this file.
