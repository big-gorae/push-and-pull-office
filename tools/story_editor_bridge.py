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
import re
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
        ("campaigns", project.campaigns),
        ("characters", project.characters),
        ("events", project.events),
        ("locales", project.locales),
        ("visuals", project.visuals),
        ("threads", project.threads),
        ("meta", project.meta),
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


def push_pull_heroine(scene: Mapping[str, Any]) -> str | None:
    candidates = []
    contract = scene.get("state_contract", {})
    if isinstance(contract, Mapping):
        candidates.extend(contract.get("writes", []))
    candidates.extend(walk_effects(scene.get("nodes", [])))
    for path in candidates:
        match = re.match(r"^(?:visible|hidden)\.heroines\.([a-z][a-z0-9_]*)\.", str(path))
        if match:
            return match.group(1)
    return None


def derive_state_contract(scene: MutableMapping[str, Any]) -> None:
    reads = unique(walk_conditions({
        "entry_conditions": scene.get("entry_conditions", []),
        "nodes": scene.get("nodes", []),
    }))
    writes = unique(walk_effects(scene.get("nodes", [])))
    uses_push_pull = any(
        isinstance(option, Mapping) and isinstance(option.get("push_pull"), Mapping)
        for node in scene.get("nodes", [])
        if isinstance(node, Mapping)
        for option in node.get("options", [])
    )
    heroine = push_pull_heroine(scene) if uses_push_pull else None
    if heroine:
        reads = unique([*reads, "progress.flags.push_pull"])
        writes = unique([
            *writes,
            "progress.flags.push_pull",
            f"visible.heroines.{heroine}.initiative",
            f"hidden.heroines.{heroine}.suspicion",
            f"hidden.heroines.{heroine}.dislike",
            f"hidden.heroines.{heroine}.evidence_count",
        ])
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


def yaml_text_for_document(target: Path, document: Mapping[str, Any]) -> str:
    with target.open("r", encoding="utf-8") as handle:
        current = YAML_RT.load(handle)
    if not isinstance(current, CommentedMap):
        raise RuntimeError(f"YAML root must be a mapping: {target}")
    updated = copy.deepcopy(dict(document))
    updated.pop("_source", None)
    merged = merge_round_trip(current, updated)
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


def validate_candidates(root: Path, candidates: Mapping[Path, str]) -> List[Dict[str, str]]:
    root = root.resolve()
    with tempfile.TemporaryDirectory(prefix="love-office-story-") as raw_temp:
        temp_root = Path(raw_temp)
        temp_story = temp_root / "story"
        shutil.copytree(root / "story", temp_story)
        for relative_path, yaml_text in candidates.items():
            candidate = temp_root / relative_path
            candidate.parent.mkdir(parents=True, exist_ok=True)
            candidate.write_text(yaml_text, encoding="utf-8")
        project = StoryProject(temp_story)
        return [issue_json(issue, temp_root, root) for issue in project.validate()]


def atomic_write_text(target: Path, text: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, target)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def clean_document(value: Mapping[str, Any]) -> Dict[str, Any]:
    result = copy.deepcopy(dict(value))
    result.pop("_source", None)
    return result


def validate_new_id(new_id: Any) -> str:
    if not isinstance(new_id, str) or not re.fullmatch(r"[a-z][a-z0-9_.]*", new_id):
        raise RuntimeError("새 ID는 영문 소문자로 시작하고 소문자·숫자·밑줄·점만 사용할 수 있습니다")
    return new_id


def duplicate_target(source: Path, new_id: str) -> Path:
    filename = f"{new_id.rsplit('.', 1)[-1]}.yaml"
    target = source.parent / filename
    story_root = next((parent for parent in source.parents if parent.name == "story"), None)
    if story_root is None or story_root not in target.resolve().parents:
        raise RuntimeError("복제 파일 위치가 story 폴더를 벗어났습니다")
    if target.exists():
        raise RuntimeError(f"같은 위치에 파일이 이미 있습니다: {target.name}")
    return target


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


def find_document_path(root: Path, kind: str, document_id: str) -> Path:
    allowed = {"campaigns", "characters", "events", "locales", "visuals", "threads", "meta", "routes"}
    if kind not in allowed:
        raise RuntimeError(f"unsupported editable document kind: {kind}")
    project = StoryProject(root.resolve() / "story")
    collection = getattr(project, kind)
    document = collection.get(document_id)
    if document is None:
        raise RuntimeError(f"unknown {kind} document: {document_id}")
    path = Path(document["_source"]).resolve()
    story_root = (root.resolve() / "story").resolve()
    if story_root not in path.parents:
        raise RuntimeError("document path escaped story root")
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


def save_document(root: Path, payload: Mapping[str, Any]) -> Dict[str, Any]:
    root = root.resolve()
    kind = payload.get("kind")
    document = payload.get("document")
    expected_revision = payload.get("revision")
    if not isinstance(kind, str) or not isinstance(document, Mapping) or not isinstance(document.get("id"), str):
        raise RuntimeError("document payload is invalid")
    if not isinstance(expected_revision, str):
        raise RuntimeError("revision is required")
    target = find_document_path(root, kind, document["id"])
    if revision(target) != expected_revision:
        raise RuntimeError("REVISION_CONFLICT: source file changed outside the editor")
    yaml_text = yaml_text_for_document(target, document)
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
    updated_document = document_index(root, project)[kind][document["id"]]
    return {
        "saved": True,
        "issues": [issue_json(issue) for issue in project.validate()],
        "runtime": bundle,
        "document": updated_document,
    }


def commit_new_documents(root: Path, candidates: Mapping[Path, str]) -> tuple[StoryProject, Dict[str, Any]]:
    backups = {target: target.read_text(encoding="utf-8") if target.exists() else None for target in candidates}
    try:
        for target, yaml_text in candidates.items():
            atomic_write_text(target, yaml_text)
        project = StoryProject(root / "story")
        issues = project.validate()
        errors = [issue for issue in issues if issue.severity == "error"]
        if errors:
            raise RuntimeError("복제 직후 전체 검증에 실패했습니다")
        bundle = project.build_bundle()
        write_json(runtime_output_path(root, project), bundle)
        return project, bundle
    except Exception:
        for target, backup in backups.items():
            if backup is None:
                if target.exists():
                    target.unlink()
            else:
                atomic_write_text(target, backup)
        raise


def duplicate_scene(root: Path, payload: Mapping[str, Any]) -> Dict[str, Any]:
    root = root.resolve()
    source_id = payload.get("source_id")
    new_id = validate_new_id(payload.get("new_id"))
    title = payload.get("title")
    if not isinstance(source_id, str) or not isinstance(title, str) or not title.strip():
        raise RuntimeError("복제할 장면과 새 제목이 필요합니다")

    project = StoryProject(root / "story")
    if new_id in project.scenes:
        raise RuntimeError(f"이미 존재하는 장면 ID입니다: {new_id}")
    source = project.scenes.get(source_id)
    if source is None:
        raise RuntimeError(f"알 수 없는 장면입니다: {source_id}")
    source_path = Path(source["_source"]).resolve()
    target = duplicate_target(source_path, new_id)

    runtime_scene = copy.deepcopy(project.build_bundle()["scenes"][source_id])
    runtime_scene["id"] = new_id
    runtime_scene["title"] = title.strip()
    if isinstance(runtime_scene.get("sequence"), int):
        runtime_scene["sequence"] += 1

    route_id = runtime_scene.get("route")
    route_source = project.routes.get(route_id)
    if route_source is None:
        raise RuntimeError(f"장면의 루트를 찾을 수 없습니다: {route_id}")
    route = clean_document(route_source)
    order = list(route.get("scene_order", []))
    endings = list(route.get("endings", []))
    ending_index = next((index for index, ending in enumerate(endings) if ending.get("scene") == source_id), None)
    if ending_index is not None:
        copied_ending = copy.deepcopy(endings[ending_index])
        copied_ending["scene"] = new_id
        endings.insert(ending_index + 1, copied_ending)
        route["endings"] = endings
    elif source_id in order:
        order.insert(order.index(source_id) + 1, new_id)
    else:
        order.append(new_id)
    route["scene_order"] = order
    route_path = Path(route_source["_source"]).resolve()

    source_event_id, source_event = next(
        ((event_id, event) for event_id, event in project.events.items() if event.get("scene") == source_id),
        (None, None),
    )
    if source_event_id is None or source_event is None:
        raise RuntimeError("복제할 장면에 연결된 시간 이벤트가 없습니다")
    new_event_id = new_id
    if new_event_id in project.events:
        raise RuntimeError(f"장면과 함께 만들 사건 ID가 이미 존재합니다: {new_event_id}")
    source_event_path = Path(source_event["_source"]).resolve()
    event_target = duplicate_target(source_event_path, new_event_id)
    event = clean_document(source_event)
    event["id"] = new_event_id
    event["title"] = f"{title.strip()} 사건"
    event["scene"] = new_id
    if isinstance(event.get("sequence"), int):
        event["sequence"] += 1
    for mode in ("perceived", "reality"):
        presentation = event.get("presentation", {}).get(mode)
        if isinstance(presentation, MutableMapping):
            presentation["title"] = f"{presentation.get('title', title).rstrip()} 복사본"

    candidates = {
        target: yaml_text_for_scene(source_path, runtime_scene),
        event_target: yaml_text_for_document(source_event_path, event),
        route_path: yaml_text_for_document(route_path, route),
    }
    thread_id = event.get("thread")
    if isinstance(thread_id, str):
        thread_source = project.threads.get(thread_id)
        if thread_source is None:
            raise RuntimeError(f"사건의 스레드를 찾을 수 없습니다: {thread_id}")
        thread = clean_document(thread_source)
        event_ids = list(thread.get("events", []))
        if source_event_id in event_ids:
            event_ids.insert(event_ids.index(source_event_id) + 1, new_event_id)
        else:
            event_ids.append(new_event_id)
        thread["events"] = event_ids
        thread_path = Path(thread_source["_source"]).resolve()
        candidates[thread_path] = yaml_text_for_document(thread_path, thread)
    relative_candidates = {path.relative_to(root): text for path, text in candidates.items()}
    issues = validate_candidates(root, relative_candidates)
    if any(issue["severity"] == "error" for issue in issues):
        return {"created": False, "issues": issues}

    updated_project, bundle = commit_new_documents(root, candidates)
    documents = document_index(root, updated_project)
    result: Dict[str, Any] = {
        "created": True,
        "issues": [issue_json(issue) for issue in updated_project.validate()],
        "runtime": bundle,
        "scene": documents["scenes"][new_id],
        "event": documents["events"][new_event_id],
        "route": documents["routes"][route_id],
    }
    if isinstance(thread_id, str):
        result["thread"] = documents["threads"][thread_id]
    return result


def duplicate_event(root: Path, payload: Mapping[str, Any]) -> Dict[str, Any]:
    root = root.resolve()
    source_id = payload.get("source_id")
    new_id = validate_new_id(payload.get("new_id"))
    title = payload.get("title")
    if not isinstance(source_id, str) or not isinstance(title, str) or not title.strip():
        raise RuntimeError("복제할 사건과 새 제목이 필요합니다")

    project = StoryProject(root / "story")
    if new_id in project.events:
        raise RuntimeError(f"이미 존재하는 사건 ID입니다: {new_id}")
    source = project.events.get(source_id)
    if source is None:
        raise RuntimeError(f"알 수 없는 사건입니다: {source_id}")
    source_path = Path(source["_source"]).resolve()
    target = duplicate_target(source_path, new_id)
    event = clean_document(source)
    event["id"] = new_id
    event["title"] = title.strip()
    if isinstance(event.get("sequence"), int):
        event["sequence"] += 1
    for mode in ("perceived", "reality"):
        presentation = event.get("presentation", {}).get(mode)
        if isinstance(presentation, MutableMapping):
            presentation["title"] = f"{presentation.get('title', title).rstrip()} 복사본"

    candidates: Dict[Path, str] = {target: yaml_text_for_document(source_path, event)}
    thread_id = event.get("thread")
    thread_path: Path | None = None
    if isinstance(thread_id, str):
        thread_source = project.threads.get(thread_id)
        if thread_source is None:
            raise RuntimeError(f"사건의 스레드를 찾을 수 없습니다: {thread_id}")
        thread = clean_document(thread_source)
        event_ids = list(thread.get("events", []))
        if source_id in event_ids:
            event_ids.insert(event_ids.index(source_id) + 1, new_id)
        else:
            event_ids.append(new_id)
        thread["events"] = event_ids
        thread_path = Path(thread_source["_source"]).resolve()
        candidates[thread_path] = yaml_text_for_document(thread_path, thread)

    relative_candidates = {path.relative_to(root): text for path, text in candidates.items()}
    issues = validate_candidates(root, relative_candidates)
    if any(issue["severity"] == "error" for issue in issues):
        return {"created": False, "issues": issues}

    updated_project, bundle = commit_new_documents(root, candidates)
    documents = document_index(root, updated_project)
    result: Dict[str, Any] = {
        "created": True,
        "issues": [issue_json(issue) for issue in updated_project.validate()],
        "runtime": bundle,
        "event": documents["events"][new_id],
    }
    if isinstance(thread_id, str) and thread_path is not None:
        result["thread"] = documents["threads"][thread_id]
    return result


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
    parser.add_argument("command", choices=["load", "validate", "validate-scene", "save-scene", "save-document", "duplicate-scene", "duplicate-event", "build"])
    parser.add_argument("--root", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()
    if not (root / "story" / "manifest.yaml").is_file():
        raise RuntimeError("selected folder is not a story project")

    payload: Dict[str, Any] = {}
    if args.command in {"validate-scene", "save-scene", "save-document", "duplicate-scene", "duplicate-event"}:
        payload = json.load(sys.stdin)

    if args.command == "load":
        result = load_project(root)
    elif args.command == "validate":
        result = validate_project(root)
    elif args.command == "validate-scene":
        result = validate_scene(root, payload)
    elif args.command == "save-scene":
        result = save_scene(root, payload)
    elif args.command == "save-document":
        result = save_document(root, payload)
    elif args.command == "duplicate-scene":
        result = duplicate_scene(root, payload)
    elif args.command == "duplicate-event":
        result = duplicate_event(root, payload)
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
