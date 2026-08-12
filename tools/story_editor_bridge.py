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
from ruamel.yaml.scalarstring import ScalarString

from story_harness import StoryProject, collect_localizable_entries, render_json, write_json


YAML_RT = YAML()
YAML_RT.preserve_quotes = True
YAML_RT.width = 1000
YAML_RT.indent(mapping=2, sequence=4, offset=2)


def revision(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def value_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


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
    allowed = {"campaigns", "characters", "events", "locales", "visuals", "threads", "meta", "routes", "system_flows"}
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


STORY_TEXT_FIELD_PATTERNS = {
    "scene": (
        re.compile(r"^nodes\.[a-zA-Z0-9_]+\.(?:perceived|reality)\.line$"),
        re.compile(r"^nodes\.[a-zA-Z0-9_]+\.variants\.[a-zA-Z0-9_]+\.(?:perceived|reality)\.line$"),
        re.compile(r"^nodes\.[a-zA-Z0-9_]+\.(?:prompt|stimulus)$"),
        re.compile(r"^nodes\.[a-zA-Z0-9_]+\.analysis_hints\.(?:pull|push|none)$"),
        re.compile(r"^nodes\.[a-zA-Z0-9_]+\.options\.[a-zA-Z0-9_]+\.(?:label|interpretation|action)$"),
    ),
    "event": (
        re.compile(r"^title$"),
        re.compile(r"^presentation\.(?:perceived|reality)\.(?:title|summary)$"),
    ),
    "ui": (re.compile(r"^strings\..+$"),),
    "system_flow": (
        re.compile(r"^nodes\.[a-zA-Z0-9_]+\.(?:perceived|reality)\.line$"),
        re.compile(r"^nodes\.[a-zA-Z0-9_]+\.variants\.[a-zA-Z0-9_]+\.(?:perceived|reality)\.line$"),
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


def story_text_owner(root: Path, localization_key: str, locale: str | None = None) -> Dict[str, Any]:
    root = root.resolve()
    project = StoryProject(root / "story")
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


def save_story_text(root: Path, payload: Mapping[str, Any]) -> Dict[str, Any]:
    root = root.resolve()
    raw_edits = payload.get("edits")
    edits = raw_edits if isinstance(raw_edits, Sequence) and not isinstance(raw_edits, (str, bytes)) else [payload]
    if not edits:
        raise RuntimeError("story text payload has no edits")
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
        owner = story_text_owner(root, localization_key, locale)
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
    before_text: Dict[str, str] = {}
    for relative_path in sorted({edit["relativePath"] for edit in prepared}):
        target = (root / relative_path).resolve()
        story_root = (root / "story").resolve()
        if story_root not in target.parents or not target.is_file():
            raise RuntimeError("FIELD_NOT_EDITABLE: source path escaped story root")
        before_text[relative_path] = target.read_text(encoding="utf-8")
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
    issues = validate_candidates(root, candidates)
    if any(issue["severity"] == "error" for issue in issues):
        return {
            "saved": False,
            "errorCode": "VALIDATION_FAILED",
            "issues": issues,
            "owners": [story_text_owner(root, key, locale) for key, locale in owner_requests],
        }

    written_paths: List[str] = []
    try:
        for relative_path, yaml_text in sorted((str(path), text) for path, text in candidates.items()):
            atomic_write_text(root / relative_path, yaml_text)
            written_paths.append(relative_path)
        project = StoryProject(root / "story")
        project_issues = project.validate()
        if any(issue.severity == "error" for issue in project_issues):
            raise RuntimeError("VALIDATION_FAILED: saved story did not validate")
        bundle = project.build_bundle()
        atomic_write_text(runtime_output_path(root, project), render_json(bundle))
    except Exception:
        for relative_path in written_paths:
            atomic_write_text(root / relative_path, before_text[relative_path])
        raise
    updated_owners = [story_text_owner(root, key, locale) for key, locale in owner_requests]
    return {
        "saved": True,
        "issues": [issue_json(issue) for issue in project_issues],
        "runtime": bundle,
        "documents": document_index(root, project),
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
    target = find_scene_path(root, scene["id"])
    yaml_text = yaml_text_for_scene(target, scene)
    relative = target.relative_to(root)
    issues = validate_candidate(root, relative, yaml_text)
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
    parser.add_argument("command", choices=["load", "validate", "validate-scene", "save-scene", "save-document", "duplicate-scene", "duplicate-event", "text-owner", "save-text", "build"])
    parser.add_argument("--root", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()
    if not (root / "story" / "manifest.yaml").is_file():
        raise RuntimeError("selected folder is not a story project")

    payload: Dict[str, Any] = {}
    if args.command in {"validate-scene", "save-scene", "save-document", "duplicate-scene", "duplicate-event", "text-owner", "save-text"}:
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
    elif args.command == "text-owner":
        localization_key = payload.get("localization_key")
        locale = payload.get("locale")
        if not isinstance(localization_key, str):
            raise RuntimeError("localization_key is required")
        if locale is not None and not isinstance(locale, str):
            raise RuntimeError("locale must be a string")
        result = story_text_owner(root, localization_key, locale)
    elif args.command == "save-text":
        result = save_story_text(root, payload)
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
