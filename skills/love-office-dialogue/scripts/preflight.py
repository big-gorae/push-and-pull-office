#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path


CORE_PATHS = (
    "AGENTS.md",
    "story/AI_AUTHORING_RULES.md",
    "story/SPEC.md",
    "story/characters",
    "story/world",
    "tools/story_harness.py",
)


def repository_root(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        check=True,
        capture_output=True,
        text=True,
    )
    return Path(result.stdout.strip()).resolve()


def declared_baselines(character_file: Path) -> list[str]:
    text = character_file.read_text(encoding="utf-8")
    return [
        match.strip().strip('"').strip("'")
        for match in re.findall(r"^\s*baseline_reference:\s*([^#\n]+)", text, flags=re.MULTILINE)
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate Love Office dialogue-authoring sources.")
    parser.add_argument("--root", help="Love Office repository root; defaults to the current Git root.")
    args = parser.parse_args()

    try:
        root = repository_root(args.root)
    except (subprocess.CalledProcessError, FileNotFoundError) as error:
        print(json.dumps({"ok": False, "error": f"repository root unavailable: {error}"}, ensure_ascii=False))
        return 1

    missing = [relative for relative in CORE_PATHS if not (root / relative).exists()]
    profiles: list[dict[str, object]] = []
    broken_references: list[dict[str, str]] = []
    character_dir = root / "story/characters"

    if character_dir.is_dir():
        for character_file in sorted(character_dir.glob("*.yaml")):
            references = declared_baselines(character_file)
            if not references:
                continue
            profiles.append({"character": character_file.stem, "baseline_references": references})
            for reference in references:
                if not (root / reference).is_file():
                    broken_references.append({"character": character_file.stem, "reference": reference})

    result = {
        "ok": not missing and not broken_references and bool(profiles),
        "root": str(root),
        "voice_profiles": profiles,
        "missing_core_paths": missing,
        "broken_baseline_references": broken_references,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
