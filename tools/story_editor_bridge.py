#!/usr/bin/env python3
"""JSON bridge used by the Tauri story editor.

The bridge keeps the existing story harness authoritative while adding
round-trip YAML updates, revision conflict detection, and atomic writes.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Sequence

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq

from story_harness import StoryProject, write_json


YAML_RT = YAML()
YAML_RT.preserve_quotes = True
YAML_RT.width = 1000
YAML_RT.indent(mapping=2, sequence=4, offset=2)


def revision(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def issue_json(issue: Any, replace_root: Path | None = None, real_root: Path | None = None) -> Dict[str, str]:
    location = issue.location
    if replace_root and real_root:
        location = location.replace(str(replace_root), str(real_root))
    return {"severity": issue.severity, "location": location, "message": issue.message}


def document_index(root: Path, project: StoryProject) -> Dict[str, Dict[str, Dict[str, str]]]:
    result: Dict[str, Dict[str, Dict[str, str]]] = {}
    for kind, values in (
        ("characters", project.characters),
        ("routes", project.routes),
        ("scenes", project.scenes),
    ):
        result[kind] = {}
        for item_id, value in values.items():
            path = Path(value["_source"])
            result[kind][item_id] = {
                "path": str(path.relative_to(root)),
                "revision": revision(path),
                "source": path.read_text(encoding="utf-8"),
            }
    return result


def runtime_output_path(root: Path, project: StoryProject) -> Path:
    configured = project.manifest.get("build", {}).get("runtime_output")
    if configured != "build/story-runtime.json":
        raise RuntimeError("manifest build.runtime_output must be build/story-runtime.json")
    output = (root / configured).resolve()
    allowed = (root / "build" / "story-runtime.json").resolve()
    if output != allowed:
        raise RuntimeError("runtime output escaped the project build directory")
    return output


def load_project(root: Path) -> Dict[str, Any]:
    root = root.resolve()
    project = StoryProject(root / "story")
    issues = project.validate()
    bundle = project.build_bundle()
    if not any(issue.severity == "error" for issue in issues):
        write_json(runtime_output_path(root, project), bundle)
    return {
        "root": str(root),
        "runtime": bundle,
        "documents": document_index(root, project),
        "issues": [issue_json(issue) for issue in issues],
    }


def walk_conditions(value: Any) -> Iterable[str]:
    if isinstance(value, Mapping):
        if value.get("op") in {"set", "add", "append_unique", "remove"}:
            yield from walk_conditions(value.get("conditions", []))
            return
        if isinstance(value.get("path"), str) and isinstance(value.get("op"), str):
            yield value["path"]
        for child in value.values():
            yield from walk_conditions(child)
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        for child in value:
            yield from walk_conditions(child)


def walk_effects(value: Any) -> Iterable[str]:
    if isinstance(value, Mapping):
        if isinstance(value.get("path"), str) and value.get("op") in {"set", "add", "append_unique", "remove"}:
            yield value["path"]
        for child in value.values():
            yield from walk_effects(child)
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        for child in value:
            yield from walk_effects(child)


def unique(values: Iterable[str]) -> List[str]:
    seen = set()
    result = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def derive_state_contract(scene: MutableMapping[str, Any]) -> None:
    reads = unique(walk_conditions({
        "entry_conditions": scene.get("entry_conditions", []),
        "nodes": scene.get("nodes", []),
    }))
    writes = unique(walk_effects(scene.get("nodes", [])))
    scene["state_contract"] = {"reads": reads, "writes": writes}


def prepare_scene(raw_scene: Mapping[str, Any]) -> Dict[str, Any]:
    scene = copy.deepcopy(dict(raw_scene))
    scene.pop("_source", None)
    node_order = scene.pop("node_order", None)
    nodes = scene.get("nodes")
    if isinstance(nodes, Mapping):
        order = node_order if isinstance(node_order, list) else list(nodes)
        scene["nodes"] = [copy.deepcopy(nodes[node_id]) for node_id in order if node_id in nodes]
    derive_state_contract(scene)
    return scene


def merge_round_trip(existing: Any, updated: Any, key: str | None = None) -> Any:
    if isinstance(existing, MutableMapping) and isinstance(updated, Mapping):
        for old_key in list(existing.keys()):
            if old_key not in updated:
                del existing[old_key]
        for new_key, new_value in updated.items():
            if new_key in existing:
                existing[new_key] = merge_round_trip(existing[new_key], new_value, str(new_key))
            else:
                existing[new_key] = copy.deepcopy(new_value)
        return existing

    if isinstance(existing, list) and isinstance(updated, list):
        merge_by_id = key in {"nodes", "options"} and all(
            isinstance(item, Mapping) and isinstance(item.get("id"), str) for item in updated
        )
        if merge_by_id:
            old_by_id = {
                item.get("id"): item
                for item in existing
                if isinstance(item, MutableMapping) and isinstance(item.get("id"), str)
            }
            replacement = CommentedSeq()
            for item in updated:
                old = old_by_id.get(item["id"])
                replacement.append(merge_round_trip(old, item, key) if old is not None else copy.deepcopy(item))
            return replacement
        replacement = CommentedSeq()
        replacement.extend(copy.deepcopy(updated))
        return replacement

    return copy.deepcopy(updated)


def yaml_text_for_scene(target: Path, scene: Mapping[str, Any]) -> str:
    with target.open("r", encoding="utf-8") as handle:
        current = YAML_RT.load(handle)
    if not isinstance(current, CommentedMap):
        raise RuntimeError(f"YAML root must be a mapping: {target}")
    merged = merge_round_trip(current, prepare_scene(scene))
    from io import StringIO

    buffer = StringIO()
    YAML_RT.dump(merged, buffer)
    return buffer.getvalue()


def validate_candidate(root: Path, relative_path: Path, yaml_text: str) -> List[Dict[str, str]]:
    root = root.resolve()
    with tempfile.TemporaryDirectory(prefix="love-office-story-") as raw_temp:
        temp_root = Path(raw_temp)
        temp_story = temp_root / "story"
        shutil.copytree(root / "story", temp_story)
        candidate = temp_root / relative_path
        candidate.parent.mkdir(parents=True, exist_ok=True)
        candidate.write_text(yaml_text, encoding="utf-8")
        project = StoryProject(temp_story)
        issues = project.validate()
        return [issue_json(issue, temp_root, root) for issue in issues]


def find_scene_path(root: Path, scene_id: str) -> Path:
    root = root.resolve()
    project = StoryProject(root / "story")
    scene = project.scenes.get(scene_id)
    if scene is None:
        raise RuntimeError(f"unknown scene: {scene_id}")
    path = Path(scene["_source"]).resolve()
    story_root = (root / "story").resolve()
    if story_root not in path.parents:
        raise RuntimeError("scene path escaped story root")
    return path


def validate_scene(root: Path, payload: Mapping[str, Any]) -> Dict[str, Any]:
    root = root.resolve()
    scene = payload.get("scene")
    if not isinstance(scene, Mapping) or not isinstance(scene.get("id"), str):
        raise RuntimeError("scene payload is invalid")
    target = find_scene_path(root, scene["id"])
    yaml_text = yaml_text_for_scene(target, scene)
    relative = target.relative_to(root)
    issues = validate_candidate(root, relative, yaml_text)
    return {
        "issues": issues,
        "source": yaml_text,
        "state_contract": prepare_scene(scene)["state_contract"],
    }


def save_scene(root: Path, payload: Mapping[str, Any]) -> Dict[str, Any]:
    root = root.resolve()
    scene = payload.get("scene")
    expected_revision = payload.get("revision")
    if not isinstance(scene, Mapping) or not isinstance(scene.get("id"), str):
        raise RuntimeError("scene payload is invalid")
    if not isinstance(expected_revision, str):
        raise RuntimeError("revision is required")

    target = find_scene_path(root, scene["id"])
    current_revision = revision(target)
    if current_revision != expected_revision:
        raise RuntimeError("REVISION_CONFLICT: source file changed outside the editor")

    yaml_text = yaml_text_for_scene(target, scene)
    issues = validate_candidate(root, target.relative_to(root), yaml_text)
    errors = [issue for issue in issues if issue["severity"] == "error"]
    if errors:
        return {"saved": False, "issues": issues, "source": yaml_text}

    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(yaml_text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, target)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)

    project = StoryProject(root / "story")
    bundle = project.build_bundle()
    write_json(runtime_output_path(root, project), bundle)
    updated_document = document_index(root, project)["scenes"][scene["id"]]
    return {
        "saved": True,
        "issues": [issue_json(issue) for issue in project.validate()],
        "runtime": bundle,
        "document": updated_document,
    }


def validate_project(root: Path) -> Dict[str, Any]:
    root = root.resolve()
    project = StoryProject(root / "story")
    return {"issues": [issue_json(issue) for issue in project.validate()]}


def build_runtime(root: Path) -> Dict[str, Any]:
    root = root.resolve()
    project = StoryProject(root / "story")
    issues = project.validate()
    errors = [issue for issue in issues if issue.severity == "error"]
    if errors:
        return {"built": False, "issues": [issue_json(issue) for issue in issues]}
    bundle = project.build_bundle()
    write_json(runtime_output_path(root, project), bundle)
    return {"built": True, "issues": [issue_json(issue) for issue in issues], "runtime": bundle}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["load", "validate", "validate-scene", "save-scene", "build"])
    parser.add_argument("--root", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()
    if not (root / "story" / "manifest.yaml").is_file():
        raise RuntimeError("selected folder is not a story project")

    payload: Dict[str, Any] = {}
    if args.command in {"validate-scene", "save-scene"}:
        payload = json.load(sys.stdin)

    if args.command == "load":
        result = load_project(root)
    elif args.command == "validate":
        result = validate_project(root)
    elif args.command == "validate-scene":
        result = validate_scene(root, payload)
    elif args.command == "save-scene":
        result = save_scene(root, payload)
    else:
        result = build_runtime(root)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
