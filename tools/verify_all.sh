#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

python_bin="python3"
if [[ -x "$project_root/.venv/bin/python" ]]; then
  python_bin="$project_root/.venv/bin/python"
fi

run_story_checks() {
  git diff --check
  SOURCE_DATE_EPOCH=0 "$python_bin" tools/story_harness.py validate
  SOURCE_DATE_EPOCH=0 "$python_bin" -m unittest discover -s tests -v
  SOURCE_DATE_EPOCH=0 "$python_bin" tools/story_harness.py explore
  SOURCE_DATE_EPOCH=0 "$python_bin" tools/story_harness.py build --check
  SOURCE_DATE_EPOCH=0 "$python_bin" tools/story_harness.py night --campaign main --day 1 --activity workout --json >/dev/null
  SOURCE_DATE_EPOCH=0 "$python_bin" tools/story_harness.py timeline --campaign main --day 5 --slot after_work --process-automatic >/dev/null
}

run_player_checks() {
  npm run prompt:validate
  npm run test:prompt-harness
  npm run test:player
  npm run test:prompts
  npm run build:site
}

run_e2e_checks() {
  npx playwright install chromium
  npm run test:e2e
}

case "${1:-all}" in
  story)
    run_story_checks
    ;;
  player)
    run_player_checks
    ;;
  e2e)
    run_e2e_checks
    ;;
  all)
    run_story_checks
    run_player_checks
    run_e2e_checks
    ;;
  *)
    printf 'usage: %s [story|player|e2e|all]\n' "$0" >&2
    exit 2
    ;;
esac
