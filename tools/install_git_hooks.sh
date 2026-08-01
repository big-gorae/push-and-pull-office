#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! git -C "$project_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

git -C "$project_root" config core.hooksPath .githooks
