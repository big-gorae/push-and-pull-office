---
name: love-office-authoring-mode
description: Start or focus the Love Office Authoring Build and open its in-game authoring play window when the user asks for 작가모드, 작가 모드, 대사 편집 모드, or 제작 플레이.
---

# Love Office Authoring Mode

Use this skill only for the Love Office repository's writable authoring surface.

## Route the request

- `작가모드 켜줘`, `작가 모드`, `대사 편집 모드`, and `제작 플레이 열기` mean: start or focus the **Authoring Build**, load the current project, and open the in-game authoring play window.
- `게임 켜줘` means the read-only Play Build and is not handled by this skill.
- `디버그 모드` still uses the Authoring Build, but also requires enabling the in-game Debug Mode setting; do not enable it for an ordinary 작가모드 request.

## Launch procedure

1. Resolve the repository root and confirm `story/manifest.yaml` exists. Stop if the request is not being handled from the Love Office repository.
2. Run the repository launcher from the root:

   ```bash
   make tauri-dev
   ```

   The current target delegates to `tools/run_tauri_dev.sh`, which reuses an existing `target/debug/push-and-pull-office-editor` and rejects an unrelated listener on `127.0.0.1:1420`. Do not run a second `make tauri-dev` when an Authoring Build is already running.
3. If the Make target is unavailable, use `tools/run_tauri_dev.sh`; use raw `npm run tauri dev` only as a fallback. Do not change ports to work around a conflict.
4. When the editor window is available, confirm the current project loaded from the repository root. Open the play window with `▶ 게임에서 대사 편집` (or the equivalent `제작 플레이 열기` label), reusing the existing `authoring-play` window if present.
5. If the local server fails with a sandbox `EPERM` port-binding error, retry the same launch command with the environment's required escalation. Do not change ports or start another instance to work around it.

## UI and safety boundaries

- Use the `computer-use` skill for native UI interaction when needed.
- After `make tauri-dev`, never target the installed release bundle ID `com.pushandpulloffice.storyeditor`; the development binary is not reliably registered and doing so can launch a second editor. Leave the single development instance running and use its own `main` and `authoring-play` windows.
- Never terminate an existing editor or kill a port owner automatically. Report the PID and ask for direction if an unrelated process owns port 1420.
- Do not run `npm run dev` for this request, modify story files, or run the full verification suite merely to launch the editor.

## Completion report

Report whether the Authoring Build was reused or started, whether the project was loaded, and whether the authoring play window was opened. If the development window cannot be exposed to UI control, say so plainly while leaving the single Authoring Build running; do not claim that the play window was opened without verification.
