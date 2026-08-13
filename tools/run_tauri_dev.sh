#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if pgrep -f 'target/debug/push-and-pull-office-editor' >/dev/null 2>&1; then
  echo "Authoring Build is already running; reuse its existing windows."
  exit 0
fi

if lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 1420 is already in use; refusing to start a second development server." >&2
  exit 1
fi

export PATH="$repo_root/.tooling/cargo/bin:$PATH"
export RUSTUP_HOME="$repo_root/.tooling/rustup"
export CARGO_HOME="$repo_root/.tooling/cargo"
exec npm run tauri dev
