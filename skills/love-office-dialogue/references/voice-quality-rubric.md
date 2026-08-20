# Voice quality rubric

Run this rubric privately on every drafted or applied scene. Evaluate the written scene, not the author's intent.

## Hard gates

Fail the scene until all conditions pass:

- Every required event and participant from the request is present.
- Company, team, role, schedule, project, and meeting claims match story/world/.
- No character violates a declared voice.forbidden rule without an explicit story reason.
- Every speaking character was checked against functionally similar user-approved golden samples and that character's relevant entries in docs/dialogue-voice-rejections.md when the registry exists.
- In Apply or Evolve mode, no newly model-authored line is saved as final dialogue when its speaker has fewer than two functionally similar approved goldens and the user has not approved that exact wording. Only exact user wording, an intentional approved callback, or omission of the unsupported beat may pass.
- No dialogue line merely restates the scene purpose, game system, choice structure, relationship strategy, or authorial intent unless that form is supported by an approved golden sample for the speaker.
- No rejected line or reusable failure pattern returns with superficial synonym changes.
- No line authored by Codex in the current task is treated as a golden sample or voice.reference_lines without explicit user approval of that exact wording.
- Han Do-yoon's unspoken reactions in shared scenes remain ordinary parenthesized dialogue, while his audible monologue at home alone at night remains ordinary dialogue without parentheses.
- A nightly Han Do-yoon monologue that recalls women uses several concrete visual details, exaggerated comparisons, and naive imagined moments instead of compressing the scene into a relationship summary.
- Ordinary scenes do not reveal Han Do-yoon's artwork.
- Apply mode preserves valid graph connections, presentation fields, and registered expressions.

## Generation cycle check

Before scoring, confirm that each speaking character completed all three passes:

1. **Generate**: a provisional semantic version established only the required observation, feeling, speech act, or action.
2. **Delete**: profile conflicts, rejected patterns, outline language, generic abstractions, and unsupported verbal habits were removed.
3. **Rewrite**: the remaining meaning was rebuilt using the character's approved rhythm, vocabulary, reaction order, and current emotional state.

Score only the rewritten result. A polished provisional line is not a valid final line merely because its meaning is correct.

## Voice score

Score each speaking main character from 0 to 2 on each axis:

1. **Golden grounding**: the reaction order and speaking function match relevant user-approved samples without copying their wording. Score 2 when multiple relevant approved samples support the choice, 1 when only one approved sample or the user's current explicit direction supports it, and 0 when no approved evidence supports it or it contradicts available evidence.
2. **Character language**: vocabulary, sentence length, pauses, emphasis, endings, and verbal habits belong to this speaker.
3. **Response logic**: the character notices and answers the kind of information their profile and current state prioritize.
4. **Scene grounding**: the line responds to a concrete present stimulus instead of summarizing design intent, relationship strategy, or generic emotion.
5. **Distinctiveness and variation**: the line remains attributable without a speaker label while avoiding mechanical repetition of catchphrases.

Require at least 8/10 for each main character, with no axis scored 0. Hard-gate failures cannot be offset by a higher total. Rewrite the weakest lines before returning or applying the scene.

When a speaker has fewer than two functionally similar approved golden lines, Draft mode may pass using the user's current explicit direction as limited evidence, but the result must be labeled provisional. Apply and Evolve modes may not save that model-authored candidate as final dialogue. Do not promote it or use it as future evidence until the user approves the exact wording.

## Drift tests

- Swap two characters' labels. If the exchange still works unchanged, differentiate the lines.
- Remove catchphrases and punctuation. If no character identity remains, strengthen response logic and vocabulary.
- Compare with voice.reference_lines. Reject copied syntax that adds no intentional callback.
- Compare with the rejection registry. Reject paraphrases that preserve the same failed function or sentence structure.
- Ask whether the line could appear unchanged in a plot outline, UI explanation, or design document. If yes, rewrite it as a character response.
- Count repeated reactions and self-talk. Remove repetitions that do not change information, tension, or relationship.
- Read the scene once for facts and once only for voice; do not let a lively voice hide a continuity error.

## Improvement evidence

Promote a new rule only when at least one is true:

- the user explicitly says the corrected line is the desired standard;
- the same correction recurs across multiple scenes;
- the correction resolves a clear contradiction in existing voice rules.

Keep one-off situational behavior in the scene rather than turning it into a permanent habit. Rejected examples may be recorded immediately as regression evidence, but broaden their failure reason only as far as the user's feedback supports.
