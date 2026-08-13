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
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Sequence

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq
from ruamel.yaml.scalarstring import ScalarString

from story_harness import StoryProject, collect_localizable_entries, render_json, write_json


YAML_RT = YAML()
YAML_RT.preserve_quotes = True
YAML_RT.width = 1000
YAML_RT.indent(mapping=2, sequence=4, offset=2)

_PROJECT_CACHE: Dict[Path, tuple[tuple[tuple[str, int, int], ...], StoryProject]] = {}

MOBILE_SYNC_EVENT_ID = re.compile(r"^[a-zA-Z0-9_-]{16,96}$")
MOBILE_SYNC_HASH = re.compile(r"^[a-f0-9]{64}$")
MOBILE_SYNC_MAX_CHANGES = 100


def project_signature(root: Path) -> tuple[tuple[str, int, int], ...]:
    story_root = root.resolve() / "story"
    return tuple((
        str(path.relative_to(story_root)),
        path.stat().st_mtime_ns,
        path.stat().st_size,
    ) for path in sorted(story_root.rglob("*.yaml")))


def cached_story_project(root: Path) -> StoryProject:
    root = root.resolve()
    signature = project_signature(root)
    cached = _PROJECT_CACHE.get(root)
    if cached and cached[0] == signature:
        return cached[1]
    project = StoryProject(root / "story")
    _PROJECT_CACHE[root] = (signature, project)
    return project


def store_cached_project(root: Path, project: StoryProject) -> None:
    root = root.resolve()
    _PROJECT_CACHE[root] = (project_signature(root), project)


def revision(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def value_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def json_value_hash(value: Any) -> str:
    serialized = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return value_hash(serialized)


def text_placeholders(value: str) -> List[str]:
    return sorted(set(re.findall(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\}\}", value)))


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
        ("system_flows", project.system_flows),
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


EDITABLE_COLLECTIONS = (
    "campaigns",
    "characters",
    "events",
    "locales",
    "visuals",
    "threads",
    "meta",
    "routes",
    "scenes",
    "system_flows",
)


def document_meta(root: Path, document: Mapping[str, Any]) -> Dict[str, str]:
    path = Path(str(document["_source"])).resolve()
    return {
        "path": str(path.relative_to(root)),
        "revision": revision(path),
        "source": path.read_text(encoding="utf-8"),
    }


def document_updates(root: Path, project: StoryProject, relative_paths: Iterable[str]) -> Dict[str, Dict[str, Dict[str, str]]]:
    selected = {str(Path(path)) for path in relative_paths}
    updates: Dict[str, Dict[str, Dict[str, str]]] = {}
    for kind in EDITABLE_COLLECTIONS:
        collection = getattr(project, kind)
        for item_id, document in collection.items():
            relative = str(Path(document["_source"]).resolve().relative_to(root))
            if relative in selected:
                updates.setdefault(kind, {})[item_id] = document_meta(root, document)
    return updates


def project_with_candidates(
    root: Path,
    candidates: Mapping[Path, str],
    project: StoryProject | None = None,
) -> StoryProject:
    root = root.resolve()
    source_project = project or cached_story_project(root)
    candidate_project = copy.copy(source_project)
    for kind in EDITABLE_COLLECTIONS:
        setattr(candidate_project, kind, dict(getattr(source_project, kind)))
    source_owners: Dict[Path, tuple[str, str]] = {}
    for kind in EDITABLE_COLLECTIONS:
        for item_id, document in getattr(candidate_project, kind).items():
            source_owners[Path(document["_source"]).resolve()] = (kind, item_id)

    for relative_path, yaml_text in candidates.items():
        target = (root / relative_path).resolve()
        document = YAML_RT.load(yaml_text)
        if not isinstance(document, MutableMapping):
            raise RuntimeError(f"YAML root must be a mapping: {target}")
        document["_source"] = str(target)
        if target == Path(candidate_project.ui["_source"]).resolve():
            candidate_project.ui = document
            continue
        if target == Path(candidate_project.game_modes_document["_source"]).resolve():
            candidate_project.game_modes_document = document
            candidate_project.game_modes = document.get("modes", {})
            continue
        owner = source_owners.get(target)
        if owner is None:
            relative_story_path = target.relative_to(root / "story")
            owner_kind = next((kind for kind in EDITABLE_COLLECTIONS
                if relative_story_path.match(str(candidate_project.manifest.get("files", {}).get(kind, "<none>")))), None)
            next_id = document.get("id")
            if owner_kind is None or not isinstance(next_id, str):
                raise RuntimeError(f"candidate source is not an editable story document: {relative_path}")
            getattr(candidate_project, owner_kind)[next_id] = document
            continue
        kind, previous_id = owner
        collection = getattr(candidate_project, kind)
        next_id = document.get("id")
        if not isinstance(next_id, str):
            next_id = previous_id
        if next_id != previous_id:
            del collection[previous_id]
        collection[next_id] = document
    return candidate_project


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
    project = cached_story_project(root)
    issues = project.validate()
    output = runtime_output_path(root, project)
    if any(issue.severity == "error" for issue in issues):
        try:
            bundle = json.loads(output.read_text(encoding="utf-8")) if output.is_file() else {}
        except (OSError, json.JSONDecodeError):
            bundle = {}
    else:
        bundle = project.build_bundle()
        write_json(output, bundle)
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


def push_pull_heroines(scene: Mapping[str, Any]) -> List[str]:
    heroines = []
    for node in scene.get("nodes", []):
        if not isinstance(node, Mapping):
            continue
        for option in node.get("options", []):
            if not isinstance(option, Mapping):
                continue
            push_pull = option.get("push_pull")
            if isinstance(push_pull, Mapping) and isinstance(push_pull.get("target"), str):
                heroines.append(push_pull["target"])
    candidates = []
    contract = scene.get("state_contract", {})
    if isinstance(contract, Mapping):
        candidates.extend(contract.get("writes", []))
    candidates.extend(walk_effects(scene.get("nodes", [])))
    for path in candidates:
        match = re.match(r"^(?:visible|hidden)\.heroines\.([a-z][a-z0-9_]*)\.", str(path))
        if match:
            heroines.append(match.group(1))
    return unique(heroines)


def self_development_config(target: Path) -> Mapping[str, Any]:
    story_root = next((parent for parent in target.parents if parent.name == "story"), None)
    if story_root is None:
        return {}
    manifest_path = story_root / "manifest.yaml"
    if not manifest_path.is_file():
        return {}
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = YAML_RT.load(handle)
    if not isinstance(manifest, Mapping):
        return {}
    config = manifest.get("self_development", {})
    return config if isinstance(config, Mapping) else {}


def self_development_expressions(target: Path) -> Mapping[str, Any]:
    config = self_development_config(target)
    expressions = config.get("expressions", {})
    return expressions if isinstance(expressions, Mapping) else {}


def derive_state_contract(
    scene: MutableMapping[str, Any],
    expressions: Mapping[str, Any] | None = None,
) -> None:
    reads = unique(walk_conditions({
        "entry_conditions": scene.get("entry_conditions", []),
        "nodes": scene.get("nodes", []),
    }))
    writes = unique(walk_effects(scene.get("nodes", [])))
    expression_ids = []
    for node in scene.get("nodes", []):
        if not isinstance(node, Mapping):
            continue
        for candidate in [*(node.get("variants") or []), *(node.get("options") or [])]:
            if not isinstance(candidate, Mapping):
                continue
            metadata = candidate.get("self_development")
            if isinstance(metadata, Mapping) and isinstance(metadata.get("expression"), str):
                expression_ids.append(metadata["expression"])
    for expression_id in unique(expression_ids):
        expression = (expressions or {}).get(expression_id, {})
        requirement = expression.get("requires", {}) if isinstance(expression, Mapping) else {}
        if not isinstance(requirement, Mapping) or not requirement:
            reads = unique([
                *reads,
                "visible.protagonist.self_development.appeal",
                "visible.protagonist.self_development.fatigue",
                "visible.protagonist.self_development.stats.health",
                "visible.protagonist.self_development.stats.appearance",
                "visible.protagonist.self_development.stats.humor",
                "visible.protagonist.self_development.stats.intelligence",
            ])
            continue
        required_paths = []
        if "appeal_gte" in requirement:
            required_paths.append("visible.protagonist.self_development.appeal")
        if isinstance(requirement.get("stat"), str):
            required_paths.append(
                f"visible.protagonist.self_development.stats.{requirement['stat']}"
            )
        if "fatigue_lte" in requirement:
            required_paths.append("visible.protagonist.self_development.fatigue")
        if "last_activity" in requirement:
            required_paths.append("progress.self_development.last_activity")
        reads = unique([*reads, *required_paths])
    uses_push_pull = any(
        isinstance(option, Mapping) and isinstance(option.get("push_pull"), Mapping)
        for node in scene.get("nodes", [])
        if isinstance(node, Mapping)
        for option in node.get("options", [])
    )
    heroines = push_pull_heroines(scene) if uses_push_pull else []
    if heroines:
        reads = unique([*reads, "progress.flags.push_pull"])
        writes = unique([*writes, "progress.flags.push_pull"])
        for heroine in heroines:
            writes = unique([
                *writes,
                f"visible.heroines.{heroine}.initiative",
                f"hidden.heroines.{heroine}.suspicion",
                f"hidden.heroines.{heroine}.dislike",
                f"hidden.heroines.{heroine}.evidence_count",
            ])
    scene["state_contract"] = {"reads": reads, "writes": writes}


def prepare_scene(
    raw_scene: Mapping[str, Any],
    expressions: Mapping[str, Any] | None = None,
) -> Dict[str, Any]:
    scene = copy.deepcopy(dict(raw_scene))
    scene.pop("_source", None)
    node_order = scene.pop("node_order", None)
    nodes = scene.get("nodes")
    if isinstance(nodes, Mapping):
        order = node_order if isinstance(node_order, list) else list(nodes)
        scene["nodes"] = [copy.deepcopy(nodes[node_id]) for node_id in order if node_id in nodes]
    derive_state_contract(scene, expressions)
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
    prepared = prepare_scene(scene, self_development_expressions(target))
    merged = merge_round_trip(current, prepared)
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
    project = project_with_candidates(root, {relative_path: yaml_text})
    return [issue_json(issue) for issue in project.validate()]


def validate_candidates(root: Path, candidates: Mapping[Path, str]) -> List[Dict[str, str]]:
    root = root.resolve()
    project = project_with_candidates(root, candidates)
    return [issue_json(issue) for issue in project.validate()]


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


def json_patch(before: Any, after: Any, path: str = "") -> List[Dict[str, Any]]:
    if before == after:
        return []
    if isinstance(before, Mapping) and isinstance(after, Mapping):
        operations: List[Dict[str, Any]] = []
        for key in sorted(set(before) - set(after)):
            token = str(key).replace("~", "~0").replace("/", "~1")
            operations.append({"op": "remove", "path": f"{path}/{token}"})
        for key in sorted(after):
            token = str(key).replace("~", "~0").replace("/", "~1")
            child_path = f"{path}/{token}"
            if key not in before:
                operations.append({"op": "add", "path": child_path, "value": after[key]})
            else:
                operations.extend(json_patch(before[key], after[key], child_path))
        return operations
    return [{"op": "replace", "path": path or "/", "value": after}]


def runtime_response(bundle: Mapping[str, Any], patch: Mapping[str, Any] | None) -> Dict[str, Any]:
    return {"runtimePatch": patch} if patch is not None else {"runtime": bundle}


def commit_validated_candidates(
    root: Path,
    candidates: Mapping[Path, str],
    project: StoryProject,
) -> tuple[Dict[str, Any], Dict[str, Any] | None]:
    absolute_candidates = {(root / path).resolve(): text for path, text in candidates.items()}
    backups = {target: target.read_text(encoding="utf-8") for target in absolute_candidates}
    runtime_path = runtime_output_path(root, project)
    runtime_backup = runtime_path.read_text(encoding="utf-8") if runtime_path.exists() else None
    before_bundle = json.loads(runtime_backup) if runtime_backup else None
    try:
        for target, yaml_text in absolute_candidates.items():
            atomic_write_text(target, yaml_text)
        bundle = project.build_bundle()
        atomic_write_text(runtime_path, render_json(bundle))
        patch = None if before_bundle is None else {
            "baseSourceSha256": before_bundle.get("source_sha256"),
            "sourceSha256": bundle.get("source_sha256"),
            "operations": json_patch(before_bundle, bundle),
        }
        store_cached_project(root, project)
        return bundle, patch
    except Exception:
        for target, before in backups.items():
            atomic_write_text(target, before)
        if runtime_backup is None:
            if runtime_path.exists():
                runtime_path.unlink()
        else:
            atomic_write_text(runtime_path, runtime_backup)
        raise


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
    project = cached_story_project(root)
    scene = project.scenes.get(scene_id)
    if scene is None:
        raise RuntimeError(f"unknown scene: {scene_id}")
    path = Path(scene["_source"]).resolve()
    story_root = (root / "story").resolve()
    if story_root not in path.parents:
        raise RuntimeError("scene path escaped story root")
    return path


def find_document_path(root: Path, kind: str, document_id: str) -> Path:
    allowed = {"campaigns", "characters", "events", "locales", "visuals", "threads", "meta", "routes", "system_flows"}
    if kind not in allowed:
        raise RuntimeError(f"unsupported editable document kind: {kind}")
    project = cached_story_project(root)
    collection = getattr(project, kind)
    document = collection.get(document_id)
    if document is None:
        raise RuntimeError(f"unknown {kind} document: {document_id}")
    path = Path(document["_source"]).resolve()
    story_root = (root.resolve() / "story").resolve()
    if story_root not in path.parents:
        raise RuntimeError("document path escaped story root")
    return path


STORY_TEXT_FIELD_PATTERNS = {
    "scene": (
        re.compile(r"^nodes\.[a-zA-Z0-9_]+\.line$"),
        re.compile(r"^nodes\.[a-zA-Z0-9_]+\.variants\.[a-zA-Z0-9_]+\.line$"),
        re.compile(r"^nodes\.[a-zA-Z0-9_]+\.(?:prompt|stimulus)$"),
        re.compile(r"^nodes\.[a-zA-Z0-9_]+\.analysis_hints\.(?:pull|push|none)$"),
        re.compile(r"^nodes\.[a-zA-Z0-9_]+\.options\.[a-zA-Z0-9_]+\.(?:label|interpretation|action)$"),
    ),
    "event": (
        re.compile(r"^title$"),
        re.compile(r"^presentation\.(?:title|summary)$"),
    ),
    "ui": (re.compile(r"^strings\..+$"),),
    "system_flow": (
        re.compile(r"^nodes\.[a-zA-Z0-9_]+\.line$"),
        re.compile(r"^nodes\.[a-zA-Z0-9_]+\.variants\.[a-zA-Z0-9_]+\.line$"),
        re.compile(r"^options\.[a-zA-Z0-9_]+\.(?:label|description)$"),
    ),
}


def editable_story_text_field(kind: str, field_path: str) -> bool:
    return any(pattern.fullmatch(field_path) for pattern in STORY_TEXT_FIELD_PATTERNS.get(kind, ()))


def source_path_for_entry(root: Path, project: StoryProject, entry: Mapping[str, Any]) -> Path:
    document = entry.get("sourceDocument", {})
    kind = document.get("kind")
    item_id = document.get("id")
    if kind == "scene" and item_id in project.scenes:
        target = Path(project.scenes[item_id]["_source"])
    elif kind == "event" and item_id in project.events:
        target = Path(project.events[item_id]["_source"])
    elif kind == "ui" and item_id == project.ui.get("id", "game_ui"):
        target = Path(project.ui["_source"])
    elif kind == "system_flow" and item_id in project.system_flows:
        target = Path(project.system_flows[item_id]["_source"])
    else:
        raw_path = document.get("path")
        if not isinstance(raw_path, str):
            raise RuntimeError("FIELD_NOT_EDITABLE: source document has no path")
        requested = Path(raw_path)
        target = requested if requested.is_absolute() else root / requested
    target = target.resolve()
    story_root = (root / "story").resolve()
    if target != story_root and story_root not in target.parents:
        raise RuntimeError("FIELD_NOT_EDITABLE: source path escaped story root")
    if not target.is_file():
        raise RuntimeError("FIELD_NOT_EDITABLE: source file does not exist")
    return target


def sequence_item(sequence: Any, item_id: str, field_name: str) -> MutableMapping[str, Any]:
    if not isinstance(sequence, Sequence) or isinstance(sequence, (str, bytes)):
        raise RuntimeError(f"FIELD_NOT_EDITABLE: {field_name} is not a sequence")
    for item in sequence:
        if isinstance(item, MutableMapping) and str(item.get("id")) == item_id:
            return item
    raise RuntimeError(f"FIELD_NOT_EDITABLE: unknown {field_name} id: {item_id}")


def resolve_yaml_text_field(
    document: MutableMapping[str, Any],
    field_path: str,
    *,
    allow_missing_string: bool = False,
) -> tuple[MutableMapping[str, Any], str]:
    if field_path.startswith("strings."):
        strings = document.get("strings")
        key = field_path.removeprefix("strings.")
        if not isinstance(strings, MutableMapping) or (key not in strings and not allow_missing_string):
            raise RuntimeError(f"FIELD_NOT_EDITABLE: unknown UI string: {key}")
        return strings, key

    parts = field_path.split(".")
    current: Any = document
    index = 0
    while index < len(parts) - 1:
        part = parts[index]
        if not isinstance(current, MutableMapping) or part not in current:
            raise RuntimeError(f"FIELD_NOT_EDITABLE: unknown field path: {field_path}")
        child = current[part]
        if part in {"nodes", "variants", "options"}:
            index += 1
            if index >= len(parts):
                raise RuntimeError(f"FIELD_NOT_EDITABLE: missing {part} id")
            current = sequence_item(child, parts[index], part)
        else:
            current = child
        index += 1
    if not isinstance(current, MutableMapping) or parts[-1] not in current:
        raise RuntimeError(f"FIELD_NOT_EDITABLE: unknown field path: {field_path}")
    if not isinstance(current[parts[-1]], str):
        raise RuntimeError(f"FIELD_NOT_EDITABLE: target field is not text: {field_path}")
    return current, parts[-1]


def yaml_source_locator(target: Path, field_path: str, *, allow_missing_string: bool = False) -> Dict[str, Any]:
    with target.open("r", encoding="utf-8") as handle:
        document = YAML_RT.load(handle)
    if not isinstance(document, MutableMapping):
        raise RuntimeError(f"FIELD_NOT_EDITABLE: YAML root is not a mapping: {target}")
    parent, field = resolve_yaml_text_field(
        document,
        field_path,
        allow_missing_string=allow_missing_string,
    )
    line = None
    column = None
    try:
        position = parent.lc.key(field) if field in parent else document.lc.key("strings")
        if position is not None:
            line, column = position[0] + 1, position[1] + 1
    except (AttributeError, KeyError, TypeError):
        pass
    return {"fieldPath": field_path, "line": line, "column": column}


def story_text_owner(
    root: Path,
    localization_key: str,
    locale: str | None = None,
    project: StoryProject | None = None,
) -> Dict[str, Any]:
    root = root.resolve()
    project = project or cached_story_project(root)
    entry = collect_localizable_entries(project).get(localization_key)
    if entry is None:
        raise RuntimeError(f"UNKNOWN_STORY_TEXT: {localization_key}")
    project_settings = project.manifest.get("project", {})
    default_locale = project_settings.get("default_language", "ko")
    supported_locales = project_settings.get("supported_languages", [default_locale])
    selected_locale = locale or default_locale
    if selected_locale not in supported_locales:
        raise RuntimeError(f"UNKNOWN_LOCALE: {selected_locale}")

    if selected_locale != default_locale:
        locale_document = project.locales.get(selected_locale)
        if not locale_document:
            raise RuntimeError(f"UNKNOWN_LOCALE: {selected_locale}")
        strings = locale_document.get("strings", {})
        if not isinstance(strings, Mapping):
            raise RuntimeError(f"FIELD_NOT_EDITABLE: locale strings are invalid: {selected_locale}")
        target = Path(locale_document["_source"]).resolve()
        field_path = f"strings.{localization_key}"
        translation_exists = localization_key in strings
        current_value = str(strings.get(localization_key, entry["source"]))
        source = {
            "label": f"{selected_locale} 번역 YAML",
            "relativePath": str(target.relative_to(root)),
            **yaml_source_locator(target, field_path, allow_missing_string=True),
            "editable": True,
            "currentValue": current_value,
            "currentValueHash": value_hash(current_value),
            "revision": revision(target),
            "placeholders": entry.get("placeholders", []),
        }
        return {
            "key": localization_key,
            "kind": "direct_yaml",
            "documentKind": "locale",
            "documentId": selected_locale,
            "locale": selected_locale,
            "isTranslation": True,
            "translationExists": translation_exists,
            "sourceValue": entry["source"],
            "relativePath": str(target.relative_to(root)),
            "fieldPath": field_path,
            "revision": revision(target),
            "currentValue": current_value,
            "currentValueHash": value_hash(current_value),
            "editable": True,
            "sources": [source],
            "maxLength": entry.get("maxLength"),
            "placeholders": entry.get("placeholders", []),
        }

    document = entry["sourceDocument"]
    kind = str(document.get("kind"))
    field_path = str(document.get("fieldPath"))
    target = source_path_for_entry(root, project, entry)
    source = {
        "label": "원본 YAML",
        "relativePath": str(target.relative_to(root)),
        **yaml_source_locator(target, field_path),
    }
    if not editable_story_text_field(kind, field_path):
        return {
            "key": localization_key,
            "kind": "generated",
            "editable": False,
            "reason": "FIELD_NOT_EDITABLE",
            "locale": selected_locale,
            "currentValue": entry["source"],
            "sources": [source],
        }

    with target.open("r", encoding="utf-8") as handle:
        raw_document = YAML_RT.load(handle)
    if not isinstance(raw_document, MutableMapping):
        raise RuntimeError("FIELD_NOT_EDITABLE: YAML root is not a mapping")
    parent, field = resolve_yaml_text_field(raw_document, field_path)
    current_value = str(parent[field])
    return {
        "key": localization_key,
        "kind": "direct_yaml",
        "documentKind": kind,
        "documentId": document.get("id"),
        "locale": selected_locale,
        "isTranslation": False,
        "translationExists": True,
        "relativePath": str(target.relative_to(root)),
        "fieldPath": field_path,
        "revision": revision(target),
        "currentValue": current_value,
        "currentValueHash": value_hash(current_value),
        "editable": True,
        "sources": [source],
        "maxLength": entry.get("maxLength"),
        "placeholders": entry.get("placeholders", []),
    }


def mobile_scene_workspace(root: Path, project: StoryProject) -> Dict[str, Any]:
    bundle = project.build_bundle()
    campaigns = bundle.get("campaigns", {})
    runtime_scenes = bundle.get("scenes", {})
    grouped: Dict[int, List[Dict[str, Any]]] = {}
    seen: set[tuple[int, str]] = set()

    def event_sort_key(event: Mapping[str, Any]) -> tuple[Any, ...]:
        window = event.get("window", {}) if isinstance(event.get("window"), Mapping) else {}
        days = window.get("days", [999, 999])
        slots = window.get("slots", [])
        campaign = campaigns.get(event.get("campaign_id"), {})
        campaign_slots = campaign.get("slots", []) if isinstance(campaign, Mapping) else []
        slot = slots[0] if isinstance(slots, Sequence) and slots else ""
        return (
            days[0] if isinstance(days, Sequence) and days else 999,
            campaign_slots.index(slot) if slot in campaign_slots else 999,
            event.get("sequence", 999),
            -int(event.get("priority", 0)),
        )

    for event in sorted(bundle.get("events", {}).values(), key=event_sort_key):
        if not isinstance(event, Mapping):
            continue
        scene_id = event.get("scene")
        window = event.get("window")
        if not isinstance(scene_id, str) or scene_id not in runtime_scenes or not isinstance(window, Mapping):
            continue
        days = window.get("days")
        slots = window.get("slots")
        if not isinstance(days, Sequence) or len(days) != 2 or not isinstance(slots, Sequence):
            continue
        day = int(days[0])
        identity = (day, scene_id)
        if identity in seen:
            continue
        seen.add(identity)
        grouped.setdefault(day, []).append({
            "sceneId": scene_id,
            "eventId": str(event.get("id", "")),
            "eventTitle": str(event.get("title", scene_id)),
            "slot": " · ".join(str(slot) for slot in slots),
            "endDay": int(days[1]),
        })

    total_days = max([1, *[
        int(campaign.get("total_days", 1))
        for campaign in campaigns.values() if isinstance(campaign, Mapping)
    ]])
    world_entities = bundle.get("world", {}).get("entities", {}) \
        if isinstance(bundle.get("world"), Mapping) else {}
    characters = bundle.get("characters", {})
    scene_records: Dict[str, Dict[str, Any]] = {}
    for scene_id, scene in runtime_scenes.items():
        if not isinstance(scene, Mapping):
            continue
        illustrated = [{
            "id": character_id,
            "label": str(characters.get(character_id, {}).get("display_name", character_id)),
            "illustrated": True,
            "expressions": [{
                "id": str(expression_id),
                "label": str(expression.get("description", expression_id)),
            } for expression_id, expression in characters.get(character_id, {}).get("expressions", {}).items()
            if isinstance(expression, Mapping)],
        } for character_id in scene.get("cast", []) if isinstance(character_id, str)]
        participants = scene.get("world_context", {}).get("participants", []) \
            if isinstance(scene.get("world_context"), Mapping) else []
        supporting = [{
            "id": member_id,
            "label": str(world_entities.get(member_id, {}).get("display_name", member_id)),
            "illustrated": False,
        } for member_id in participants
        if isinstance(member_id, str) and world_entities.get(member_id, {}).get("presentation") == "text_only"]
        speakers = []
        speaker_ids: set[str] = set()
        for speaker in [*illustrated, *supporting]:
            if speaker["id"] in speaker_ids:
                continue
            speaker_ids.add(speaker["id"])
            speakers.append(speaker)
        source = project.scenes.get(scene_id)
        source_path = Path(str(source["_source"])).resolve() if isinstance(source, Mapping) else None
        scene_value = copy.deepcopy(dict(scene))
        scene_records[scene_id] = {
            "revision": revision(source_path) if source_path else bundle.get("source_sha256", ""),
            "sceneHash": json_value_hash(scene_value),
            "scene": scene_value,
            "speakers": speakers,
        }

    artworks: List[Dict[str, Any]] = []
    backgrounds: List[Dict[str, Any]] = []
    for visual in bundle.get("visuals", {}).values():
        if not isinstance(visual, Mapping) or visual.get("abstract"):
            continue
        if visual.get("kind") == "character" and isinstance(visual.get("character"), str):
            character_id = str(visual["character"])
            character_label = str(characters.get(character_id, {}).get("display_name", character_id))
            visual_artworks = visual.get("artworks", {})
            if isinstance(visual_artworks, Mapping) and visual_artworks:
                for artwork_id, artwork in visual_artworks.items():
                    if not isinstance(artwork, Mapping):
                        continue
                    artworks.append({
                        "id": str(artwork_id),
                        "visualId": str(visual.get("id", "")),
                        "characterId": character_id,
                        "characterLabel": character_label,
                        "label": str(artwork.get("label", str(artwork_id).replace("_", " "))),
                        "asset": artwork.get("asset"),
                    })
            elif isinstance(visual.get("fallback_asset"), str):
                artworks.append({
                    "id": "default",
                    "visualId": str(visual.get("id", "")),
                    "characterId": character_id,
                    "characterLabel": character_label,
                    "label": "기본 원화",
                    "asset": visual.get("fallback_asset"),
                })
        if visual.get("kind") == "background" and isinstance(visual.get("variants"), Mapping):
            for variant_id, variant in visual["variants"].items():
                if not isinstance(variant, Mapping):
                    continue
                match = variant.get("match", {}) if isinstance(variant.get("match"), Mapping) else {}
                details = [
                    str(value)
                    for dimension in ("locations", "times")
                    for value in (match.get(dimension, []) if isinstance(match.get(dimension), Sequence) else [])
                ]
                backgrounds.append({
                    "visualId": str(visual.get("id", "")),
                    "variantId": str(variant_id),
                    "title": str(visual.get("title", visual.get("id", ""))),
                    "details": " · ".join(details) or str(variant_id),
                    "asset": variant.get("asset"),
                })

    return {
        "schemaVersion": 1,
        "days": [{"day": day, "scenes": grouped.get(day, [])} for day in range(1, total_days + 1)],
        "scenes": scene_records,
        "artworks": artworks,
        "backgrounds": sorted(backgrounds, key=lambda item: (item["title"], item["variantId"])),
    }


def mobile_sync_snapshot(root: Path) -> Dict[str, Any]:
    """Return the narrow, path-free text catalog exposed to the mobile PWA.

    The catalog deliberately contains stable localization keys rather than source
    paths.  A remote WebView can therefore request text synchronization without
    receiving a general-purpose view of the local filesystem.
    """

    root = root.resolve()
    project = cached_story_project(root)
    settings = project.manifest.get("project", {})
    project_id = str(settings.get("id", "love-office"))
    default_locale = str(settings.get("default_language", "ko"))
    entries: List[Dict[str, Any]] = []
    localizable = collect_localizable_entries(project)

    for key, entry in sorted(localizable.items()):
        document = entry.get("sourceDocument", {})
        kind = str(document.get("kind", ""))
        field_path = str(document.get("fieldPath", ""))
        if kind not in {"scene", "system_flow"} or not editable_story_text_field(kind, field_path):
            continue
        current_value = str(entry.get("source", ""))
        if not current_value.strip():
            continue
        context = entry.get("context") if isinstance(entry.get("context"), Mapping) else {}
        document_id = str(document.get("id", ""))
        source_document = project.scenes.get(document_id) if kind == "scene" else project.system_flows.get(document_id)
        title = str(source_document.get("title", document_id)) if isinstance(source_document, Mapping) else document_id
        entries.append({
            "localizationKey": key,
            "locale": default_locale,
            "value": current_value,
            "valueHash": value_hash(current_value),
            "domain": kind,
            "documentId": document_id,
            "documentTitle": title,
            "context": dict(context),
            "maxLength": entry.get("maxLength"),
            "placeholders": list(entry.get("placeholders", [])),
            "multiline": bool(entry.get("multiline", False)),
            "linkedLocalizationKeys": [],
        })

    workspace = mobile_scene_workspace(root, project)
    generation_source = "\n".join(
        f"{entry['localizationKey']}\0{entry['valueHash']}" for entry in entries
    ) + "\n" + json.dumps(workspace, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return {
        "schemaVersion": 2,
        "projectId": project_id,
        "projectTitle": str(settings.get("title", project_id)),
        "defaultLocale": default_locale,
        "generation": value_hash(generation_source),
        "entries": entries,
        "workspace": workspace,
    }


_MOBILE_MISSING = object()


class MobileSceneConflict(RuntimeError):
    pass


def merge_mobile_scene(base: Any, edited: Any, current: Any, path: str = "scene") -> Any:
    """Three-way merge a mobile scene edit onto the current authoritative scene."""
    if edited == base:
        return copy.deepcopy(current)
    if current == base or current == edited:
        return copy.deepcopy(edited)
    if isinstance(base, Mapping) and isinstance(edited, Mapping) and isinstance(current, Mapping):
        merged: Dict[str, Any] = {}
        for key in set(base) | set(edited) | set(current):
            base_value = base.get(key, _MOBILE_MISSING)
            edited_value = edited.get(key, _MOBILE_MISSING)
            current_value = current.get(key, _MOBILE_MISSING)
            child_path = f"{path}.{key}"
            if edited_value is _MOBILE_MISSING:
                if current_value is _MOBILE_MISSING or current_value == base_value:
                    continue
                raise MobileSceneConflict(child_path)
            if base_value is _MOBILE_MISSING:
                if current_value is _MOBILE_MISSING or current_value == edited_value:
                    merged[key] = copy.deepcopy(edited_value)
                    continue
                raise MobileSceneConflict(child_path)
            if current_value is _MOBILE_MISSING:
                if edited_value == base_value:
                    continue
                raise MobileSceneConflict(child_path)
            merged[key] = merge_mobile_scene(base_value, edited_value, current_value, child_path)
        return merged
    # Lists are atomic because their ordering has story-graph meaning.
    raise MobileSceneConflict(path)


def apply_mobile_scene_changes(
    root: Path,
    raw_changes: Sequence[Any],
    project_id: str,
) -> List[Dict[str, Any]]:
    receipts: List[Dict[str, Any]] = []
    if len(raw_changes) > 10:
        raise RuntimeError("mobile scene sync accepts 1-10 changes")
    for raw in raw_changes:
        if not isinstance(raw, Mapping):
            raise RuntimeError("mobile scene sync change is invalid")
        event_id = raw.get("eventId")
        scene_id = raw.get("sceneId")
        change_project_id = raw.get("projectId")
        base_hash = raw.get("baseSceneHash")
        next_hash = raw.get("nextSceneHash")
        base_scene = raw.get("baseScene")
        next_scene = raw.get("nextScene")
        if not all(isinstance(value, str) for value in (
            event_id, scene_id, change_project_id, base_hash, next_hash,
        )) or not isinstance(base_scene, Mapping) or not isinstance(next_scene, Mapping):
            raise RuntimeError("mobile scene sync change fields are invalid")
        if not MOBILE_SYNC_EVENT_ID.fullmatch(event_id):
            raise RuntimeError("mobile scene sync event id is invalid")
        if change_project_id != project_id or base_scene.get("id") != scene_id or next_scene.get("id") != scene_id:
            receipts.append({"eventId": event_id, "status": "rejected", "reason": "PROJECT_OR_SCENE_MISMATCH"})
            continue
        if not MOBILE_SYNC_HASH.fullmatch(base_hash) or not MOBILE_SYNC_HASH.fullmatch(next_hash) \
                or json_value_hash(base_scene) != base_hash or json_value_hash(next_scene) != next_hash:
            receipts.append({"eventId": event_id, "status": "rejected", "reason": "INVALID_SCENE_HASH"})
            continue

        project = cached_story_project(root)
        runtime_scene = project.build_bundle().get("scenes", {}).get(scene_id)
        source_scene = project.scenes.get(scene_id)
        if not isinstance(runtime_scene, Mapping) or not isinstance(source_scene, Mapping):
            receipts.append({"eventId": event_id, "status": "rejected", "reason": "UNKNOWN_SCENE"})
            continue
        current_scene = copy.deepcopy(dict(runtime_scene))
        current_hash = json_value_hash(current_scene)
        if current_hash == next_hash:
            receipts.append({
                "eventId": event_id,
                "status": "applied",
                "currentScene": current_scene,
                "currentSceneHash": current_hash,
                "idempotent": True,
            })
            continue
        try:
            merged = merge_mobile_scene(base_scene, next_scene, current_scene)
        except MobileSceneConflict as conflict:
            receipts.append({
                "eventId": event_id,
                "status": "conflict",
                "reason": f"SCENE_CONFLICT:{conflict}",
                "currentScene": current_scene,
                "currentSceneHash": current_hash,
            })
            continue

        target = Path(str(source_scene["_source"])).resolve()
        result = save_scene(root, {"scene": merged, "revision": revision(target)})
        if not result.get("saved"):
            errors = [
                str(issue.get("message", "")) for issue in result.get("issues", [])
                if isinstance(issue, Mapping) and issue.get("severity") == "error"
            ][:5]
            receipts.append({
                "eventId": event_id,
                "status": "rejected",
                "reason": "VALIDATION_FAILED" + (f": {' / '.join(errors)}" if errors else ""),
                "currentScene": current_scene,
                "currentSceneHash": current_hash,
            })
            continue
        saved_scene = cached_story_project(root).build_bundle().get("scenes", {}).get(scene_id, merged)
        receipts.append({
            "eventId": event_id,
            "status": "applied",
            "currentScene": saved_scene,
            "currentSceneHash": json_value_hash(saved_scene),
        })
    return receipts


def apply_mobile_sync_changes(root: Path, payload: Mapping[str, Any]) -> Dict[str, Any]:
    """Apply mobile events using field-level CAS and the normal safe save path."""

    root = root.resolve()
    raw_changes = payload.get("changes", [])
    raw_scene_changes = payload.get("sceneChanges", [])
    if not isinstance(raw_changes, Sequence) or isinstance(raw_changes, (str, bytes)):
        raise RuntimeError("mobile sync changes must be a list")
    if not isinstance(raw_scene_changes, Sequence) or isinstance(raw_scene_changes, (str, bytes)):
        raise RuntimeError("mobile scene sync changes must be a list")
    if not raw_changes and not raw_scene_changes:
        raise RuntimeError("mobile sync payload has no changes")
    if len(raw_changes) > MOBILE_SYNC_MAX_CHANGES:
        raise RuntimeError(f"mobile sync accepts 1-{MOBILE_SYNC_MAX_CHANGES} text changes")

    snapshot = mobile_sync_snapshot(root)
    project_id = snapshot["projectId"]
    default_locale = snapshot["defaultLocale"]
    receipts: List[Dict[str, Any]] = []
    prepared_groups: List[tuple[str, List[Dict[str, Any]]]] = []
    seen_keys: set[tuple[str, str]] = set()
    snapshot_entries = {
        str(entry["localizationKey"]): entry for entry in snapshot["entries"]
    }

    for raw in raw_changes:
        if not isinstance(raw, Mapping):
            raise RuntimeError("mobile sync change is invalid")
        event_id = raw.get("eventId")
        change_project_id = raw.get("projectId")
        localization_key = raw.get("localizationKey")
        locale = raw.get("locale")
        base_value = raw.get("baseValue")
        base_value_hash = raw.get("baseValueHash")
        next_value = raw.get("nextValue")
        if not all(isinstance(value, str) for value in (
            event_id, change_project_id, localization_key, locale,
            base_value, base_value_hash, next_value,
        )):
            raise RuntimeError("mobile sync change fields are invalid")
        if not MOBILE_SYNC_EVENT_ID.fullmatch(event_id):
            raise RuntimeError("mobile sync event id is invalid")
        if change_project_id != project_id or locale != default_locale:
            receipts.append({
                "eventId": event_id,
                "status": "rejected",
                "reason": "PROJECT_OR_LOCALE_MISMATCH",
            })
            continue
        if not MOBILE_SYNC_HASH.fullmatch(base_value_hash) or value_hash(base_value) != base_value_hash:
            receipts.append({
                "eventId": event_id,
                "status": "rejected",
                "reason": "INVALID_BASE_HASH",
            })
            continue
        catalog_entry = snapshot_entries.get(localization_key)
        if not catalog_entry:
            receipts.append({
                "eventId": event_id,
                "status": "rejected",
                "reason": "UNKNOWN_STORY_TEXT",
            })
            continue
        target_keys = [
            localization_key,
            *[
                str(key) for key in catalog_entry.get("linkedLocalizationKeys", [])
                if isinstance(key, str) and key != localization_key
            ],
        ]
        identities = [(key, locale) for key in target_keys]
        if any(identity in seen_keys for identity in identities):
            receipts.append({
                "eventId": event_id,
                "status": "rejected",
                "reason": "DUPLICATE_KEY_IN_BATCH",
            })
            continue
        seen_keys.update(identities)

        try:
            owners = [story_text_owner(root, key, locale) for key in target_keys]
        except RuntimeError as error:
            receipts.append({
                "eventId": event_id,
                "status": "rejected",
                "reason": str(error).split(":", 1)[0],
            })
            continue
        if any(not owner.get("editable") or owner.get("kind") != "direct_yaml" for owner in owners):
            receipts.append({
                "eventId": event_id,
                "status": "rejected",
                "reason": "FIELD_NOT_EDITABLE",
            })
            continue
        owner = owners[0]
        current_value = str(owner["currentValue"])
        current_hash = str(owner["currentValueHash"])
        next_hash = value_hash(next_value)
        owner_hashes = [str(candidate["currentValueHash"]) for candidate in owners]
        if all(owner_hash == next_hash for owner_hash in owner_hashes):
            receipts.append({
                "eventId": event_id,
                "status": "applied",
                "currentValue": current_value,
                "currentValueHash": current_hash,
                "idempotent": True,
            })
            continue
        if any(owner_hash not in {base_value_hash, next_hash} for owner_hash in owner_hashes):
            conflicting_owner = next(
                candidate for candidate in owners
                if str(candidate["currentValueHash"]) not in {base_value_hash, next_hash}
            )
            receipts.append({
                "eventId": event_id,
                "status": "conflict",
                "reason": "VALUE_CONFLICT",
                "currentValue": str(conflicting_owner["currentValue"]),
                "currentValueHash": str(conflicting_owner["currentValueHash"]),
            })
            continue
        if not next_value.strip():
            receipts.append({
                "eventId": event_id,
                "status": "rejected",
                "reason": "TEXT_EMPTY",
            })
            continue
        if any(text_placeholders(next_value) != sorted(candidate.get("placeholders", [])) for candidate in owners):
            receipts.append({
                "eventId": event_id,
                "status": "rejected",
                "reason": "PLACEHOLDER_MISMATCH",
            })
            continue
        max_lengths = [candidate.get("maxLength") for candidate in owners]
        if any(isinstance(max_length, int) and len(next_value) > max_length for max_length in max_lengths):
            receipts.append({
                "eventId": event_id,
                "status": "rejected",
                "reason": "TEXT_TOO_LONG",
            })
            continue
        group = [{
            "localization_key": target_key,
            "locale": locale,
            # Rebase a matching field hash onto the current file revision. This
            # avoids false conflicts when another field in the same YAML changed.
            "expected_revision": candidate["revision"],
            "expected_value_hash": candidate["currentValueHash"],
            "next_value": next_value,
        } for target_key, candidate in zip(target_keys, owners)]
        prepared_groups.append((event_id, group))

    prepared = [edit for _, group in prepared_groups for edit in group]
    if prepared:
        result = save_story_text(root, {"edits": prepared})
        if result.get("saved"):
            updated_by_key = {
                str(owner.get("key")): owner for owner in result.get("owners", [])
                if isinstance(owner, Mapping)
            }
            for event_id, group in prepared_groups:
                edit = group[0]
                owner = updated_by_key.get(edit["localization_key"], {})
                receipts.append({
                    "eventId": event_id,
                    "status": "applied",
                    "currentValue": owner.get("currentValue", edit["next_value"]),
                    "currentValueHash": owner.get("currentValueHash", value_hash(edit["next_value"])),
                })
        else:
            issue_messages = [
                str(issue.get("message", "")) for issue in result.get("issues", [])
                if isinstance(issue, Mapping) and issue.get("severity") == "error"
            ][:5]
            for event_id, _ in prepared_groups:
                receipts.append({
                    "eventId": event_id,
                    "status": "rejected",
                    "reason": str(result.get("errorCode", "VALIDATION_FAILED")),
                    "details": issue_messages,
                })

    scene_receipts = apply_mobile_scene_changes(root, raw_scene_changes, project_id) if raw_scene_changes else []
    return {
        "receipts": receipts,
        "sceneReceipts": scene_receipts,
        "snapshot": mobile_sync_snapshot(root),
    }


def save_story_text(root: Path, payload: Mapping[str, Any]) -> Dict[str, Any]:
    root = root.resolve()
    raw_edits = payload.get("edits")
    edits = raw_edits if isinstance(raw_edits, Sequence) and not isinstance(raw_edits, (str, bytes)) else [payload]
    if not edits:
        raise RuntimeError("story text payload has no edits")
    project = cached_story_project(root)
    prepared: List[Dict[str, Any]] = []
    seen_fields: set[tuple[str, str]] = set()
    owner_requests: List[tuple[str, str | None]] = []
    for edit in edits:
        if not isinstance(edit, Mapping):
            raise RuntimeError("story text payload is invalid")
        localization_key = edit.get("localization_key")
        locale = edit.get("locale")
        expected_revision = edit.get("expected_revision")
        expected_value_hash = edit.get("expected_value_hash")
        next_value = edit.get("next_value")
        delete = edit.get("delete") is True
        if not all(isinstance(value, str) for value in (localization_key, expected_revision, expected_value_hash)):
            raise RuntimeError("story text payload is invalid")
        if locale is not None and not isinstance(locale, str):
            raise RuntimeError("story text payload has an invalid locale")
        if not delete and (not isinstance(next_value, str) or not next_value.strip()):
            raise RuntimeError("VALIDATION_FAILED: text must not be empty")
        owner = story_text_owner(root, localization_key, locale, project)
        source_relative_path = edit.get("source_relative_path")
        source_field_path = edit.get("source_field_path")
        source_edit = source_relative_path is not None or source_field_path is not None
        if source_edit:
            if not isinstance(source_relative_path, str) or not isinstance(source_field_path, str):
                raise RuntimeError("story text source edit is invalid")
            source = next((candidate for candidate in owner.get("sources", [])
                if candidate.get("relativePath") == source_relative_path
                and candidate.get("fieldPath") == source_field_path), None)
            if not source or not source.get("editable"):
                raise RuntimeError("FIELD_NOT_EDITABLE: source is not owned by this story text")
            relative_path = source_relative_path
            field_path = source_field_path
            current_value = source.get("currentValue")
            current_revision = source.get("revision")
            current_value_hash = source.get("currentValueHash")
            placeholders = source.get("placeholders", [])
            max_length = source.get("maxLength")
            field_exists = True
            if delete:
                raise RuntimeError("FIELD_NOT_EDITABLE: source fields cannot be deleted")
        else:
            if not owner.get("editable") or owner.get("kind") != "direct_yaml":
                raise RuntimeError(f"{owner.get('reason', 'FIELD_NOT_EDITABLE')}: text has no single editable source")
            relative_path = owner["relativePath"]
            field_path = owner["fieldPath"]
            current_value = owner["currentValue"]
            current_revision = owner["revision"]
            current_value_hash = owner["currentValueHash"]
            placeholders = owner.get("placeholders", [])
            max_length = owner.get("maxLength")
            field_exists = bool(owner.get("translationExists", True))
            if delete and (owner.get("documentKind") != "locale" or not field_exists):
                raise RuntimeError("FIELD_NOT_EDITABLE: only an existing translation may be removed")

        if current_revision != expected_revision:
            raise RuntimeError("REVISION_CONFLICT: source file changed outside the game")
        if current_value_hash != expected_value_hash:
            raise RuntimeError("VALUE_CONFLICT: source text changed outside the game")
        if not delete and text_placeholders(next_value) != sorted(placeholders):
            raise RuntimeError("VALIDATION_FAILED: placeholders must be preserved")
        if not delete and isinstance(max_length, int) and len(next_value) > max_length:
            raise RuntimeError(f"VALIDATION_FAILED: text exceeds {max_length} characters")
        identity = (relative_path, field_path)
        if identity in seen_fields:
            raise RuntimeError(f"VALIDATION_FAILED: duplicate text edit: {relative_path} · {field_path}")
        seen_fields.add(identity)
        prepared.append({
            "localizationKey": localization_key,
            "locale": locale,
            "owner": owner,
            "relativePath": relative_path,
            "fieldPath": field_path,
            "beforeValue": current_value,
            "beforeExists": field_exists,
            "nextValue": None if delete else next_value,
            "delete": delete,
            "allowMissingString": owner.get("documentKind") == "locale" and not field_exists,
            "sourceEdit": source_edit,
        })
        request_identity = (localization_key, locale)
        if request_identity not in owner_requests:
            owner_requests.append(request_identity)

    from io import StringIO

    documents: Dict[str, MutableMapping[str, Any]] = {}
    for relative_path in sorted({edit["relativePath"] for edit in prepared}):
        target = (root / relative_path).resolve()
        story_root = (root / "story").resolve()
        if story_root not in target.parents or not target.is_file():
            raise RuntimeError("FIELD_NOT_EDITABLE: source path escaped story root")
        with target.open("r", encoding="utf-8") as handle:
            document = YAML_RT.load(handle)
        if not isinstance(document, MutableMapping):
            raise RuntimeError("FIELD_NOT_EDITABLE: YAML root is not a mapping")
        documents[relative_path] = document

    for edit in prepared:
        document = documents[edit["relativePath"]]
        parent, field = resolve_yaml_text_field(
            document,
            edit["fieldPath"],
            allow_missing_string=edit["allowMissingString"],
        )
        if edit["delete"]:
            del parent[field]
            continue
        current = parent.get(field)
        next_value = edit["nextValue"]
        parent[field] = type(current)(next_value) if isinstance(current, ScalarString) else next_value

    candidates: Dict[Path, str] = {}
    for relative_path, document in documents.items():
        buffer = StringIO()
        YAML_RT.dump(document, buffer)
        candidates[Path(relative_path)] = buffer.getvalue()
    candidate_project = project_with_candidates(root, candidates, project)
    project_issues = candidate_project.validate()
    issues = [issue_json(issue) for issue in project_issues]
    if any(issue["severity"] == "error" for issue in issues):
        return {
            "saved": False,
            "errorCode": "VALIDATION_FAILED",
            "issues": issues,
            "owners": [story_text_owner(root, key, locale, project) for key, locale in owner_requests],
        }

    if any(issue.severity == "error" for issue in project_issues):
        raise RuntimeError("VALIDATION_FAILED: saved story did not validate")
    bundle, runtime_patch = commit_validated_candidates(root, candidates, candidate_project)
    written_paths = [str(path) for path in candidates]
    updated_owners = [story_text_owner(root, key, locale, candidate_project) for key, locale in owner_requests]
    return {
        "saved": True,
        "issues": [issue_json(issue) for issue in project_issues],
        **runtime_response(bundle, runtime_patch),
        "documentUpdates": document_updates(root, candidate_project, written_paths),
        "owner": updated_owners[0],
        "owners": updated_owners,
        "changes": [{
            "localizationKey": edit["localizationKey"],
            "locale": edit["locale"],
            "relativePath": edit["relativePath"],
            "fieldPath": edit["fieldPath"],
            "beforeValue": edit["beforeValue"],
            "beforeExists": edit["beforeExists"],
            "afterValue": edit["nextValue"],
            "afterExists": not edit["delete"],
            "sourceEdit": edit["sourceEdit"],
        } for edit in prepared],
    }


def validate_scene(root: Path, payload: Mapping[str, Any]) -> Dict[str, Any]:
    root = root.resolve()
    scene = payload.get("scene")
    if not isinstance(scene, Mapping) or not isinstance(scene.get("id"), str):
        raise RuntimeError("scene payload is invalid")
    project = cached_story_project(root)
    source_scene = project.scenes.get(scene["id"])
    if source_scene is None:
        raise RuntimeError(f"unknown scene: {scene['id']}")
    target = Path(source_scene["_source"]).resolve()
    yaml_text = yaml_text_for_scene(target, scene)
    relative = target.relative_to(root)
    candidate_project = project_with_candidates(root, {relative: yaml_text}, project)
    issues = [issue_json(issue) for issue in candidate_project.validate()]
    return {
        "issues": issues,
        "source": yaml_text,
        "state_contract": prepare_scene(
            scene,
            self_development_expressions(target),
        )["state_contract"],
    }


def save_scene(root: Path, payload: Mapping[str, Any]) -> Dict[str, Any]:
    root = root.resolve()
    scene = payload.get("scene")
    expected_revision = payload.get("revision")
    if not isinstance(scene, Mapping) or not isinstance(scene.get("id"), str):
        raise RuntimeError("scene payload is invalid")
    if not isinstance(expected_revision, str):
        raise RuntimeError("revision is required")

    project = cached_story_project(root)
    source_scene = project.scenes.get(scene["id"])
    if source_scene is None:
        raise RuntimeError(f"unknown scene: {scene['id']}")
    target = Path(source_scene["_source"]).resolve()
    current_revision = revision(target)
    if current_revision != expected_revision:
        raise RuntimeError("REVISION_CONFLICT: source file changed outside the editor")

    yaml_text = yaml_text_for_scene(target, scene)
    relative = target.relative_to(root)
    candidate_project = project_with_candidates(root, {relative: yaml_text}, project)
    project_issues = candidate_project.validate()
    issues = [issue_json(issue) for issue in project_issues]
    errors = [issue for issue in project_issues if issue.severity == "error"]
    if errors:
        return {"saved": False, "issues": issues, "source": yaml_text}

    bundle, runtime_patch = commit_validated_candidates(root, {relative: yaml_text}, candidate_project)
    updated_document = document_meta(root, candidate_project.scenes[scene["id"]])
    return {
        "saved": True,
        "issues": issues,
        **runtime_response(bundle, runtime_patch),
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
    if kind not in EDITABLE_COLLECTIONS:
        raise RuntimeError(f"unsupported editable document kind: {kind}")
    project = cached_story_project(root)
    source_document = getattr(project, kind).get(document["id"])
    if source_document is None:
        raise RuntimeError(f"unknown {kind} document: {document['id']}")
    target = Path(source_document["_source"]).resolve()
    if revision(target) != expected_revision:
        raise RuntimeError("REVISION_CONFLICT: source file changed outside the editor")
    yaml_text = yaml_text_for_document(target, document)
    relative = target.relative_to(root)
    candidate_project = project_with_candidates(root, {relative: yaml_text}, project)
    project_issues = candidate_project.validate()
    issues = [issue_json(issue) for issue in project_issues]
    errors = [issue for issue in project_issues if issue.severity == "error"]
    if errors:
        return {"saved": False, "issues": issues, "source": yaml_text}

    bundle, runtime_patch = commit_validated_candidates(root, {relative: yaml_text}, candidate_project)
    updated_document = document_meta(root, getattr(candidate_project, kind)[document["id"]])
    return {
        "saved": True,
        "issues": issues,
        **runtime_response(bundle, runtime_patch),
        "document": updated_document,
    }


def commit_new_documents(root: Path, candidates: Mapping[Path, str]) -> tuple[StoryProject, Dict[str, Any]]:
    backups = {target: target.read_text(encoding="utf-8") if target.exists() else None for target in candidates}
    try:
        for target, yaml_text in candidates.items():
            atomic_write_text(target, yaml_text)
        project = cached_story_project(root)
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

    project = cached_story_project(root)
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
    presentation = event.get("presentation")
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

    project = cached_story_project(root)
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
    presentation = event.get("presentation")
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
    project = cached_story_project(root)
    return {"issues": [issue_json(issue) for issue in project.validate()]}


def build_runtime(root: Path) -> Dict[str, Any]:
    root = root.resolve()
    project = cached_story_project(root)
    issues = project.validate()
    errors = [issue for issue in issues if issue.severity == "error"]
    if errors:
        return {"built": False, "issues": [issue_json(issue) for issue in issues]}
    bundle = project.build_bundle()
    write_json(runtime_output_path(root, project), bundle)
    return {"built": True, "issues": [issue_json(issue) for issue in issues], "runtime": bundle}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["load", "validate", "validate-scene", "save-scene", "save-document", "duplicate-scene", "duplicate-event", "text-owner", "save-text", "sync-snapshot", "apply-sync", "build", "serve"])
    parser.add_argument("--root", required=True)
    return parser.parse_args()


def execute_command(root: Path, command: str, payload: Mapping[str, Any] | None = None) -> Dict[str, Any]:
    payload = payload or {}
    if command == "load":
        result = load_project(root)
    elif command == "validate":
        result = validate_project(root)
    elif command == "validate-scene":
        result = validate_scene(root, payload)
    elif command == "save-scene":
        result = save_scene(root, payload)
    elif command == "save-document":
        result = save_document(root, payload)
    elif command == "duplicate-scene":
        result = duplicate_scene(root, payload)
    elif command == "duplicate-event":
        result = duplicate_event(root, payload)
    elif command == "text-owner":
        localization_key = payload.get("localization_key")
        locale = payload.get("locale")
        if not isinstance(localization_key, str):
            raise RuntimeError("localization_key is required")
        if locale is not None and not isinstance(locale, str):
            raise RuntimeError("locale must be a string")
        result = story_text_owner(root, localization_key, locale)
    elif command == "save-text":
        result = save_story_text(root, payload)
    elif command == "sync-snapshot":
        result = mobile_sync_snapshot(root)
    elif command == "apply-sync":
        result = apply_mobile_sync_changes(root, payload)
    elif command == "build":
        result = build_runtime(root)
    else:
        raise RuntimeError(f"알 수 없는 스토리 명령입니다: {command}")
    return result


def serve(root: Path) -> int:
    """Serve newline-delimited requests so the editor can reuse the parsed project.

    Each response is isolated: validation or revision failures are returned to the
    caller without terminating the worker, while the next request can continue.
    """
    for raw_line in sys.stdin:
        try:
            request = json.loads(raw_line)
            if not isinstance(request, Mapping):
                raise RuntimeError("스토리 워커 요청은 JSON 객체여야 합니다")
            command = request.get("command")
            payload = request.get("payload")
            if not isinstance(command, str):
                raise RuntimeError("스토리 워커 command가 필요합니다")
            if payload is not None and not isinstance(payload, Mapping):
                raise RuntimeError("스토리 워커 payload는 JSON 객체여야 합니다")
            response = {"ok": True, "result": execute_command(root, command, payload)}
        except Exception as exc:
            response = {"ok": False, "error": str(exc)}
        print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()
    if not (root / "story" / "manifest.yaml").is_file():
        raise RuntimeError("selected folder is not a story project")

    if args.command == "serve":
        return serve(root)

    payload: Dict[str, Any] = {}
    if args.command in {"validate-scene", "save-scene", "save-document", "duplicate-scene", "duplicate-event", "text-owner", "save-text", "apply-sync"}:
        payload = json.load(sys.stdin)
    result = execute_command(root, args.command, payload)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
