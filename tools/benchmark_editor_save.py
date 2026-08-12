#!/usr/bin/env python3
"""Measure cold/warm authoritative saves through the persistent editor worker."""

from __future__ import annotations

import copy
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from story_harness import StoryProject


ROOT = Path(__file__).resolve().parents[1]


def request(worker: subprocess.Popen[str], command: str, payload: dict) -> tuple[dict, float, int]:
    assert worker.stdin is not None and worker.stdout is not None
    started = time.perf_counter()
    worker.stdin.write(json.dumps({"command": command, "payload": payload}, ensure_ascii=False) + "\n")
    worker.stdin.flush()
    line = worker.stdout.readline()
    elapsed_ms = (time.perf_counter() - started) * 1000
    if not line:
        raise RuntimeError("editor worker exited before returning a benchmark response")
    response = json.loads(line)
    if not response.get("ok"):
        raise RuntimeError(response.get("error", "editor worker benchmark failed"))
    return response["result"], elapsed_ms, len(line.encode("utf-8"))


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="love-office-save-benchmark-") as temporary:
        root = Path(temporary)
        shutil.copytree(ROOT / "story", root / "story")
        shutil.copytree(ROOT / "build", root / "build")
        project = StoryProject(root / "story")
        character_id = sorted(project.characters)[0]
        source = project.characters[character_id]
        target = Path(source["_source"])
        document = copy.deepcopy(dict(source))
        document.pop("_source", None)
        original_summary = str(document.get("summary", ""))

        worker = subprocess.Popen(
            [sys.executable, str(ROOT / "tools" / "story_editor_bridge.py"), "serve", "--root", str(root)],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        try:
            loaded, load_ms, _ = request(worker, "load", {})
            document["summary"] = f"{original_summary} [benchmark]"
            first, first_ms, first_bytes = request(worker, "save-document", {
                "kind": "characters",
                "document": document,
                "revision": loaded["documents"]["characters"][character_id]["revision"],
            })
            document["summary"] = original_summary
            warm, warm_ms, warm_bytes = request(worker, "save-document", {
                "kind": "characters",
                "document": document,
                "revision": first["document"]["revision"],
            })
        finally:
            if worker.stdin is not None:
                worker.stdin.close()
            worker.wait(timeout=10)

        print(json.dumps({
            "document": f"characters:{character_id}",
            "project_load_ms": round(load_ms, 2),
            "first_save_ms": round(first_ms, 2),
            "warm_ms": round(warm_ms, 2),
            "first_response_bytes": first_bytes,
            "warm_response_bytes": warm_bytes,
            "first_patch_operations": len(first.get("runtimePatch", {}).get("operations", [])),
            "warm_patch_operations": len(warm.get("runtimePatch", {}).get("operations", [])),
        }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
