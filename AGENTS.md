# Love Office Agent Instructions

## `전부 반영` publishing workflow

- When the user says `전부 반영`, treat it as explicit authorization to stage and commit the completed in-scope changes, integrate the latest remote `main`, and push directly to `main` without asking for additional approval.
- Before pushing, inspect the local diff and fetch the current `origin/main` so the scope and intent of both the local work and incoming commits are understood.
- Commit the intended local work if necessary, then run `git pull --no-rebase origin main` before the push. Resolve merge conflicts by preserving the intent of both the latest `main` commits and the commit being published; never solve a conflict by silently dropping either side.
- After integration, rerun the relevant validation and tests. Push only when the merged result is valid and includes both sets of intended behavior.
- Do not include unrelated user changes merely because `전부 반영` was invoked. If a conflict is genuinely ambiguous and both intentions cannot safely be preserved, stop and explain the conflict instead of guessing or discarding work.

## Story source of truth

- Narrative intent and reviews live in `docs/`.
- Machine-readable story truth lives in `story/`.
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
   python3 tools/story_harness.py validate
   python3 -m unittest discover -s tests -v
   python3 tools/story_harness.py build
   python3 tools/story_harness.py timeline --day 5 --slot after_work --process-automatic
   ```

4. Simulate every changed branch, not only the default option.

## Story invariants

- Every dialogue or narration beat must contain both `perceived` and `reality` layers.
- `perceived` is Han Do-yoon's interpretation; `reality` is authoritative.
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
- Never add detailed, reproducible instructions for committing or concealing abuse.
