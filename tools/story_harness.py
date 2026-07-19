#!/usr/bin/env python3
"""Story authoring harness for Love Office.

Commands:
  validate  Validate references, state contracts, dual-layer fields, and reachability.
  build     Compile YAML sources into a runtime-friendly JSON bundle.
  simulate  Execute a route with deterministic choices and print a state trace.
  context   Produce a bounded AI context package for one scene.
  new-scene Create a schema-compliant scene scaffold.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import glob
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Optional, Sequence, Set, Tuple

import yaml


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STORY_ROOT = PROJECT_ROOT / "story"
MISSING = object()
VALID_CONDITION_OPS = {"eq", "ne", "gt", "gte", "lt", "lte", "contains", "not_contains", "exists", "not_exists"}
VALID_EFFECT_OPS = {"set", "add", "append_unique", "remove"}


@dataclass(frozen=True)
class Issue:
    severity: str
    location: str
    message: str

    def render(self) -> str:
        return f"{self.severity.upper():7} {self.location}: {self.message}"


class StoryProject:
    def __init__(self, story_root: Path):
        self.story_root = story_root.resolve()
        self.manifest_path = self.story_root / "manifest.yaml"
        self.manifest = self._load_yaml(self.manifest_path)
        self.characters = self._load_kind("characters")
        self.routes = self._load_kind("routes")
        self.scenes = self._load_kind("scenes")

    @staticmethod
    def _load_yaml(path: Path) -> Dict[str, Any]:
        try:
            with path.open("r", encoding="utf-8") as handle:
                data = yaml.safe_load(handle)
        except FileNotFoundError as exc:
            raise RuntimeError(f"missing YAML file: {path}") from exc
        except yaml.YAMLError as exc:
            raise RuntimeError(f"invalid YAML in {path}: {exc}") from exc
        if not isinstance(data, dict):
            raise RuntimeError(f"YAML root must be a mapping: {path}")
        data["_source"] = str(path)
        return data

    def _load_kind(self, kind: str) -> Dict[str, Dict[str, Any]]:
        pattern = self.manifest.get("files", {}).get(kind)
        if not pattern:
            raise RuntimeError(f"manifest files.{kind} is required")
        result: Dict[str, Dict[str, Any]] = {}
        absolute_pattern = str(self.story_root / pattern)
        for raw_path in sorted(glob.glob(absolute_pattern, recursive=True)):
            path = Path(raw_path)
            data = self._load_yaml(path)
            item_id = data.get("id")
            if not isinstance(item_id, str):
                item_id = f"<missing:{path.name}>"
            if item_id in result:
                previous = result[item_id].get("_source", "unknown")
                raise RuntimeError(f"duplicate {kind} id {item_id}: {previous}, {path}")
            result[item_id] = data
        return result

    def initial_state(self) -> Dict[str, Any]:
        return copy.deepcopy(self.manifest.get("initial_state", {}))

    def id_is_valid(self, value: Any) -> bool:
        if not isinstance(value, str):
            return False
        return bool(re.fullmatch(self.manifest.get("id_pattern", r"^[a-z][a-z0-9_.]*$"), value))

    def path_spec(self, path: str) -> Optional[Dict[str, Any]]:
        if not isinstance(path, str):
            return None
        for spec in self.manifest.get("state_path_patterns", []):
            if re.fullmatch(spec.get("pattern", ""), path):
                result = dict(spec)
                if spec.get("stat_from_suffix"):
                    suffix = path.rsplit(".", 1)[-1]
                    prefix = "visible" if path.startswith("visible.") else "hidden"
                    stat = self.manifest.get("stats", {}).get(f"{prefix}.{suffix}")
                    if stat:
                        result.update(stat)
                return result
        return None

    def validate(self) -> List[Issue]:
        issues: List[Issue] = []
        self._validate_manifest(issues)
        self._validate_characters(issues)
        self._validate_routes(issues)
        self._validate_scenes(issues)
        self._validate_global_graph(issues)
        return issues

    def _error(self, issues: List[Issue], location: str, message: str) -> None:
        issues.append(Issue("error", location, message))

    def _warning(self, issues: List[Issue], location: str, message: str) -> None:
        issues.append(Issue("warning", location, message))

    def _validate_manifest(self, issues: List[Issue]) -> None:
        location = relative_source(self.manifest.get("_source", "manifest.yaml"))
        for key in ("schema_version", "project", "enums", "stats", "initial_state", "files", "build"):
            if key not in self.manifest:
                self._error(issues, location, f"required key is missing: {key}")
        state = self.initial_state()
        for path, value in walk_leaves(state):
            spec = self.path_spec(path)
            if spec is None:
                self._error(issues, location, f"initial state path is not declared: {path}")
                continue
            self._validate_value_against_spec(issues, location, path, value, spec)

    def _validate_value_against_spec(self, issues: List[Issue], location: str, path: str, value: Any, spec: Mapping[str, Any]) -> None:
        value_type = spec.get("type")
        if value_type == "integer" and (not isinstance(value, int) or isinstance(value, bool)):
            self._error(issues, location, f"{path} must be an integer")
            return
        if value_type == "array" and not isinstance(value, list):
            self._error(issues, location, f"{path} must be an array")
            return
        if value_type == "enum" and value not in spec.get("values", []):
            self._error(issues, location, f"{path} must be one of {spec.get('values', [])}, got {value!r}")
            return
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if "min" in spec and value < spec["min"]:
                self._error(issues, location, f"{path} is below minimum {spec['min']}")
            if "max" in spec and value > spec["max"]:
                self._error(issues, location, f"{path} is above maximum {spec['max']}")

    def _validate_characters(self, issues: List[Issue]) -> None:
        for character_id, character in self.characters.items():
            location = relative_source(character.get("_source", character_id))
            if not self.id_is_valid(character_id):
                self._error(issues, location, f"invalid character id: {character_id}")
            for key in ("display_name", "age", "role", "narrative_role", "summary", "expressions"):
                if key not in character:
                    self._error(issues, location, f"required key is missing: {key}")
            if not isinstance(character.get("age"), int) or character.get("age", 0) < 18:
                self._error(issues, location, "age must identify an adult character")
            concept_art = character.get("visual", {}).get("concept_art")
            if not concept_art:
                self._warning(issues, location, "visual.concept_art is not set")
            elif not (PROJECT_ROOT / concept_art).is_file():
                self._error(issues, location, f"concept art file does not exist: {concept_art}")
            expressions = character.get("expressions", {})
            if not isinstance(expressions, dict):
                self._error(issues, location, "expressions must be a mapping")
                continue
            for expression_id, expression in expressions.items():
                exp_location = f"{location}#expressions.{expression_id}"
                if not self.id_is_valid(expression_id):
                    self._error(issues, exp_location, "invalid expression id")
                if expression.get("layer") not in {"perceived", "reality"}:
                    self._error(issues, exp_location, "layer must be perceived or reality")
                for key in ("emotion", "description"):
                    if not expression.get(key):
                        self._error(issues, exp_location, f"required key is missing: {key}")
            for index, rule in enumerate(character.get("emotion_rules", [])):
                rule_location = f"{location}#emotion_rules[{index}]"
                expression_id = rule.get("default_expression")
                if expression_id not in expressions:
                    self._error(issues, rule_location, f"unknown default_expression: {expression_id}")
                elif expressions[expression_id].get("layer") != "reality":
                    self._error(issues, rule_location, "emotion default_expression must use reality layer")
                self._validate_relative_conditions(issues, rule_location, rule.get("conditions", []))
            for index, rule in enumerate(character.get("reporting_rules", [])):
                self._validate_relative_conditions(issues, f"{location}#reporting_rules[{index}]", rule.get("conditions", []))

    def _validate_relative_conditions(self, issues: List[Issue], location: str, conditions: Any) -> None:
        if not isinstance(conditions, list):
            self._error(issues, location, "conditions must be a list")
            return
        allowed_stats = {"suspicion", "dislike", "evidence_count"}
        for index, condition in enumerate(conditions):
            item_location = f"{location}.conditions[{index}]"
            if condition.get("stat") not in allowed_stats:
                self._error(issues, item_location, f"unknown relative stat: {condition.get('stat')}")
            if condition.get("op") not in VALID_CONDITION_OPS:
                self._error(issues, item_location, f"invalid condition op: {condition.get('op')}")

    def _validate_routes(self, issues: List[Issue]) -> None:
        for route_id, route in self.routes.items():
            location = relative_source(route.get("_source", route_id))
            if not self.id_is_valid(route_id):
                self._error(issues, location, f"invalid route id: {route_id}")
            for key in ("title", "heroine", "mode", "entry_scene", "scene_order", "endings"):
                if key not in route:
                    self._error(issues, location, f"required key is missing: {key}")
            if route.get("heroine") not in self.characters:
                self._error(issues, location, f"unknown heroine: {route.get('heroine')}")
            if route.get("entry_scene") not in self.scenes:
                self._error(issues, location, f"unknown entry_scene: {route.get('entry_scene')}")
            self._validate_conditions(issues, f"{location}#unlock_conditions", route.get("unlock_conditions", []), None)
            declared_scenes = list(route.get("scene_order", []))
            ending_scenes = [ending.get("scene") for ending in route.get("endings", []) if isinstance(ending, dict)]
            for scene_id in declared_scenes + ending_scenes:
                if scene_id not in self.scenes:
                    self._error(issues, location, f"unknown scene reference: {scene_id}")
                elif self.scenes[scene_id].get("route") != route_id:
                    self._error(issues, location, f"scene {scene_id} belongs to route {self.scenes[scene_id].get('route')}, not {route_id}")
            if len(ending_scenes) != len(set(ending_scenes)):
                self._error(issues, location, "duplicate ending scene")

    def _validate_scenes(self, issues: List[Issue]) -> None:
        valid_kinds = set(self.manifest.get("enums", {}).get("node_kind", []))
        for scene_id, scene in self.scenes.items():
            location = relative_source(scene.get("_source", scene_id))
            if not self.id_is_valid(scene_id):
                self._error(issues, location, f"invalid scene id: {scene_id}")
            for key in ("title", "route", "purpose", "cast", "state_contract", "start_node", "nodes"):
                if key not in scene:
                    self._error(issues, location, f"required key is missing: {key}")
            if scene.get("route") not in self.routes:
                self._error(issues, location, f"unknown route: {scene.get('route')}")
            for character_id in scene.get("cast", []):
                if character_id not in self.characters:
                    self._error(issues, location, f"unknown cast member: {character_id}")

            contract = scene.get("state_contract", {})
            reads = set(contract.get("reads", [])) if isinstance(contract, dict) else set()
            writes = set(contract.get("writes", [])) if isinstance(contract, dict) else set()
            if not isinstance(contract, dict):
                self._error(issues, location, "state_contract must be a mapping")
            for path in sorted(reads | writes):
                if self.path_spec(path) is None:
                    self._error(issues, f"{location}#state_contract", f"undeclared state path: {path}")

            self._validate_conditions(issues, f"{location}#entry_conditions", scene.get("entry_conditions", []), reads)
            nodes = scene.get("nodes", [])
            if not isinstance(nodes, list) or not nodes:
                self._error(issues, location, "nodes must be a non-empty list")
                continue
            node_map: Dict[str, Dict[str, Any]] = {}
            for index, node in enumerate(nodes):
                node_location = f"{location}#nodes[{index}]"
                node_id = node.get("id")
                if not self.id_is_valid(node_id):
                    self._error(issues, node_location, f"invalid node id: {node_id}")
                    continue
                if node_id in node_map:
                    self._error(issues, node_location, f"duplicate node id: {node_id}")
                node_map[node_id] = node
                kind = node.get("kind")
                if kind not in valid_kinds:
                    self._error(issues, node_location, f"invalid node kind: {kind}")
                    continue
                self._validate_node(issues, scene, node, node_location, reads, writes)

            start_node = scene.get("start_node")
            if start_node not in node_map:
                self._error(issues, location, f"unknown start_node: {start_node}")
            self._validate_local_links(issues, location, node_map)
            if start_node in node_map:
                reachable = local_reachable(node_map, start_node)
                for unreachable in sorted(set(node_map) - reachable):
                    self._warning(issues, location, f"unreachable local node: {unreachable}")

    def _validate_node(
        self,
        issues: List[Issue],
        scene: Mapping[str, Any],
        node: Mapping[str, Any],
        location: str,
        reads: Set[str],
        writes: Set[str],
    ) -> None:
        kind = node.get("kind")
        if kind in {"dual_dialogue", "dual_narration"}:
            self._validate_dual_node(issues, scene, node, location)
            if not node.get("next"):
                self._error(issues, location, "dual node requires next")
        elif kind == "choice":
            options = node.get("options")
            if not isinstance(options, list) or not options:
                self._error(issues, location, "choice requires non-empty options")
                return
            option_ids: Set[str] = set()
            for index, option in enumerate(options):
                option_location = f"{location}.options[{index}]"
                option_id = option.get("id")
                if not self.id_is_valid(option_id):
                    self._error(issues, option_location, f"invalid option id: {option_id}")
                if option_id in option_ids:
                    self._error(issues, option_location, f"duplicate option id: {option_id}")
                option_ids.add(option_id)
                for key in ("label", "interpretation", "action", "next"):
                    if not option.get(key):
                        self._error(issues, option_location, f"required key is missing: {key}")
                self._validate_conditions(issues, option_location, option.get("conditions", []), reads)
                self._validate_effects(issues, option_location, option.get("effects", []), reads, writes)
        elif kind == "state_gate":
            self._validate_transitions(issues, location, node.get("transitions"), reads, target_key="node")
        elif kind == "effect":
            self._validate_effects(issues, location, node.get("effects", []), reads, writes)
            if not node.get("next"):
                self._error(issues, location, "effect node requires next")
        elif kind == "exit":
            self._validate_transitions(issues, location, node.get("transitions"), reads, target_key="scene", allow_ending=True)

    def _validate_dual_node(self, issues: List[Issue], scene: Mapping[str, Any], node: Mapping[str, Any], location: str) -> None:
        perceived = node.get("perceived")
        reality = node.get("reality")
        if not isinstance(perceived, dict):
            self._error(issues, location, "perceived layer is required")
            return
        if not isinstance(reality, dict):
            self._error(issues, location, "reality layer is required")
            return
        for key in ("atmosphere", "line", "protagonist_interpretation"):
            if not perceived.get(key):
                self._error(issues, location, f"perceived.{key} is required")
        for key in ("atmosphere", "line", "inner_thought", "intent"):
            if not reality.get(key):
                self._error(issues, location, f"reality.{key} is required")
        atmospheres = set(self.manifest.get("enums", {}).get("atmosphere", []))
        intents = set(self.manifest.get("enums", {}).get("intent", []))
        if perceived.get("atmosphere") not in atmospheres:
            self._error(issues, location, f"unknown perceived atmosphere: {perceived.get('atmosphere')}")
        if reality.get("atmosphere") not in atmospheres:
            self._error(issues, location, f"unknown reality atmosphere: {reality.get('atmosphere')}")
        if reality.get("intent") not in intents:
            self._error(issues, location, f"unknown reality intent: {reality.get('intent')}")

        if node.get("kind") == "dual_dialogue":
            speaker = node.get("speaker")
            if speaker not in self.characters:
                self._error(issues, location, f"unknown speaker: {speaker}")
                return
            if speaker not in scene.get("cast", []):
                self._error(issues, location, f"speaker {speaker} is not in cast")
            expressions = self.characters[speaker].get("expressions", {})
            for layer_name, layer in (("perceived", perceived), ("reality", reality)):
                expression_id = layer.get("expression")
                if expression_id not in expressions:
                    self._error(issues, location, f"unknown {layer_name} expression {expression_id} for {speaker}")
                elif expressions[expression_id].get("layer") != layer_name:
                    self._error(issues, location, f"expression {expression_id} belongs to {expressions[expression_id].get('layer')}, not {layer_name}")

    def _validate_conditions(self, issues: List[Issue], location: str, conditions: Any, reads: Optional[Set[str]]) -> None:
        if not isinstance(conditions, list):
            self._error(issues, location, "conditions must be a list")
            return
        for index, condition in enumerate(conditions):
            item_location = f"{location}.conditions[{index}]"
            if not isinstance(condition, dict):
                self._error(issues, item_location, "condition must be a mapping")
                continue
            path = condition.get("path")
            op = condition.get("op")
            if self.path_spec(path) is None:
                self._error(issues, item_location, f"unknown state path: {path}")
            if reads is not None and path not in reads:
                self._error(issues, item_location, f"condition path is not declared in state_contract.reads: {path}")
            if op not in VALID_CONDITION_OPS:
                self._error(issues, item_location, f"invalid condition op: {op}")
            if op not in {"exists", "not_exists"} and "value" not in condition:
                self._error(issues, item_location, "condition value is required")

    def _validate_effects(self, issues: List[Issue], location: str, effects: Any, reads: Set[str], writes: Set[str]) -> None:
        if not isinstance(effects, list):
            self._error(issues, location, "effects must be a list")
            return
        for index, effect in enumerate(effects):
            item_location = f"{location}.effects[{index}]"
            if not isinstance(effect, dict):
                self._error(issues, item_location, "effect must be a mapping")
                continue
            path = effect.get("path")
            op = effect.get("op")
            spec = self.path_spec(path)
            if spec is None:
                self._error(issues, item_location, f"unknown state path: {path}")
            if path not in writes:
                self._error(issues, item_location, f"effect path is not declared in state_contract.writes: {path}")
            if op not in VALID_EFFECT_OPS:
                self._error(issues, item_location, f"invalid effect op: {op}")
            if "value" not in effect:
                self._error(issues, item_location, "effect value is required")
            if op == "add" and spec and spec.get("type") != "integer":
                self._error(issues, item_location, "add can only target integer stats")
            effect_conditions = effect.get("conditions", [])
            self._validate_conditions(issues, item_location, effect_conditions, reads)

    def _validate_transitions(
        self,
        issues: List[Issue],
        location: str,
        transitions: Any,
        reads: Set[str],
        target_key: str,
        allow_ending: bool = False,
    ) -> None:
        if not isinstance(transitions, list) or not transitions:
            self._error(issues, location, "transitions must be a non-empty list")
            return
        defaults = [index for index, transition in enumerate(transitions) if transition.get("default") is True]
        if len(defaults) != 1:
            self._error(issues, location, "transitions require exactly one default")
        elif defaults[0] != len(transitions) - 1:
            self._error(issues, location, "default transition must be last")
        for index, transition in enumerate(transitions):
            item_location = f"{location}.transitions[{index}]"
            if transition.get("default") is not True:
                self._validate_conditions(issues, item_location, transition.get("conditions", []), reads)
            if allow_ending and transition.get("ending") is True:
                if not transition.get("ending_id"):
                    self._error(issues, item_location, "ending transition requires ending_id")
            elif not transition.get(target_key):
                self._error(issues, item_location, f"transition requires {target_key}")

    def _validate_local_links(self, issues: List[Issue], location: str, node_map: Mapping[str, Mapping[str, Any]]) -> None:
        for node_id, node in node_map.items():
            targets = local_targets(node)
            for target in targets:
                if target not in node_map:
                    self._error(issues, f"{location}#nodes.{node_id}", f"unknown local node target: {target}")
            if node.get("kind") == "exit":
                for transition in node.get("transitions", []):
                    scene_id = transition.get("scene")
                    if scene_id and scene_id not in self.scenes:
                        self._error(issues, f"{location}#nodes.{node_id}", f"unknown scene target: {scene_id}")

    def _validate_global_graph(self, issues: List[Issue]) -> None:
        for route_id, route in self.routes.items():
            entry = route.get("entry_scene")
            if entry not in self.scenes:
                continue
            reachable = scene_reachable(self.scenes, entry)
            expected_endings = {ending.get("scene") for ending in route.get("endings", [])}
            missing = expected_endings - reachable
            location = relative_source(route.get("_source", route_id))
            for scene_id in sorted(missing):
                self._error(issues, location, f"ending is not reachable from entry_scene: {scene_id}")
            declared = set(route.get("scene_order", [])) | expected_endings
            extras = {scene_id for scene_id in reachable if self.scenes.get(scene_id, {}).get("route") == route_id} - declared
            for scene_id in sorted(extras):
                self._warning(issues, location, f"reachable scene is not listed in route metadata: {scene_id}")

    def build_bundle(self) -> Dict[str, Any]:
        source_paths = [self.manifest_path]
        for collection in (self.characters, self.routes, self.scenes):
            source_paths.extend(Path(item["_source"]) for item in collection.values())
        digest = hashlib.sha256()
        project_root = self.story_root.parent
        for path in sorted(source_paths):
            digest.update(str(path.relative_to(project_root)).encode("utf-8"))
            digest.update(path.read_bytes())

        characters = {item_id: clean_source(data) for item_id, data in self.characters.items()}
        routes = {item_id: clean_source(data) for item_id, data in self.routes.items()}
        scenes: Dict[str, Dict[str, Any]] = {}
        for item_id, data in self.scenes.items():
            compiled = clean_source(data)
            nodes = compiled.pop("nodes", [])
            compiled["node_order"] = [node["id"] for node in nodes]
            compiled["nodes"] = {node["id"]: node for node in nodes}
            scenes[item_id] = compiled
        return {
            "schema_version": self.manifest.get("schema_version"),
            "project": self.manifest.get("project"),
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "source_sha256": digest.hexdigest(),
            "enums": self.manifest.get("enums"),
            "stats": self.manifest.get("stats"),
            "initial_state": self.initial_state(),
            "characters": characters,
            "routes": routes,
            "scenes": scenes,
        }

    def context_package(self, scene_id: str, state: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if scene_id not in self.scenes:
            raise RuntimeError(f"unknown scene: {scene_id}")
        scene = self.scenes[scene_id]
        route = self.routes[scene["route"]]
        current_state = copy.deepcopy(state if state is not None else self.initial_state())
        contract_paths = unique_list(scene.get("state_contract", {}).get("reads", []) + scene.get("state_contract", {}).get("writes", []))
        state_snapshot = {path: get_path(current_state, path, None) for path in contract_paths}
        cast = {character_id: clean_source(self.characters[character_id]) for character_id in scene.get("cast", [])}
        linked_ids = sorted(scene_targets(scene))
        linked_scenes = {
            linked_id: {
                "title": self.scenes[linked_id].get("title"),
                "purpose": self.scenes[linked_id].get("purpose"),
                "route": self.scenes[linked_id].get("route"),
            }
            for linked_id in linked_ids
            if linked_id in self.scenes
        }
        derived_emotions = {}
        for character_id in scene.get("cast", []):
            if character_id in current_state.get("hidden", {}).get("heroines", {}):
                derived_emotions[character_id] = derive_emotion(self.characters[character_id], current_state)
        rules_path = self.story_root / "AI_AUTHORING_RULES.md"
        return {
            "purpose": "Bounded context for an AI agent editing exactly one scene",
            "authoring_rules": rules_path.read_text(encoding="utf-8"),
            "allowed_system": {
                "enums": self.manifest.get("enums"),
                "stats": self.manifest.get("stats"),
                "condition_ops": sorted(VALID_CONDITION_OPS),
                "effect_ops": sorted(VALID_EFFECT_OPS),
            },
            "route": clean_source(route),
            "scene": clean_source(scene),
            "cast": cast,
            "state_snapshot": state_snapshot,
            "derived_emotions": derived_emotions,
            "linked_scenes": linked_scenes,
            "open_questions": [],
        }


def clean_source(data: Mapping[str, Any]) -> Dict[str, Any]:
    return {key: copy.deepcopy(value) for key, value in data.items() if key != "_source"}


def relative_source(path: Any) -> str:
    try:
        return str(Path(str(path)).resolve().relative_to(PROJECT_ROOT))
    except (ValueError, OSError):
        return str(path)


def walk_leaves(data: Any, prefix: str = "") -> Iterable[Tuple[str, Any]]:
    if isinstance(data, dict):
        if not data and prefix:
            yield prefix, data
        for key, value in data.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            yield from walk_leaves(value, path)
    else:
        yield prefix, data


def get_path(state: Mapping[str, Any], path: str, default: Any = MISSING) -> Any:
    current: Any = state
    for part in path.split("."):
        if not isinstance(current, Mapping) or part not in current:
            if default is MISSING:
                raise KeyError(path)
            return default
        current = current[part]
    return current


def set_path(state: MutableMapping[str, Any], path: str, value: Any) -> None:
    parts = path.split(".")
    current: MutableMapping[str, Any] = state
    for part in parts[:-1]:
        child = current.get(part)
        if not isinstance(child, MutableMapping):
            child = {}
            current[part] = child
        current = child
    current[parts[-1]] = value


def condition_matches(state: Mapping[str, Any], condition: Mapping[str, Any]) -> bool:
    path = condition["path"]
    op = condition["op"]
    actual = get_path(state, path, MISSING)
    expected = condition.get("value")
    if op == "exists":
        return actual is not MISSING
    if op == "not_exists":
        return actual is MISSING
    if actual is MISSING:
        return False
    if op == "eq":
        return actual == expected
    if op == "ne":
        return actual != expected
    if op == "gt":
        return actual > expected
    if op == "gte":
        return actual >= expected
    if op == "lt":
        return actual < expected
    if op == "lte":
        return actual <= expected
    if op == "contains":
        return expected in actual
    if op == "not_contains":
        return expected not in actual
    raise ValueError(f"unsupported condition op: {op}")


def conditions_match(state: Mapping[str, Any], conditions: Sequence[Mapping[str, Any]]) -> bool:
    return all(condition_matches(state, condition) for condition in conditions)


def apply_effect(project: StoryProject, state: MutableMapping[str, Any], effect: Mapping[str, Any]) -> bool:
    if not conditions_match(state, effect.get("conditions", [])):
        return False
    path = effect["path"]
    op = effect["op"]
    value = copy.deepcopy(effect.get("value"))
    current = get_path(state, path, MISSING)
    if op == "set":
        new_value = value
    elif op == "add":
        if current is MISSING:
            current = 0
        new_value = current + value
        spec = project.path_spec(path) or {}
        if "min" in spec:
            new_value = max(spec["min"], new_value)
        if "max" in spec:
            new_value = min(spec["max"], new_value)
    elif op == "append_unique":
        if current is MISSING:
            current = []
        new_value = list(current)
        if value not in new_value:
            new_value.append(value)
    elif op == "remove":
        if isinstance(current, list):
            new_value = [item for item in current if item != value]
        elif isinstance(current, dict):
            new_value = dict(current)
            new_value.pop(str(value), None)
        else:
            new_value = current
    else:
        raise ValueError(f"unsupported effect op: {op}")
    set_path(state, path, new_value)
    return True


def local_targets(node: Mapping[str, Any]) -> Set[str]:
    targets: Set[str] = set()
    if node.get("next"):
        targets.add(node["next"])
    if node.get("kind") == "choice":
        targets.update(option.get("next") for option in node.get("options", []) if option.get("next"))
    if node.get("kind") == "state_gate":
        targets.update(transition.get("node") for transition in node.get("transitions", []) if transition.get("node"))
    return targets


def local_reachable(node_map: Mapping[str, Mapping[str, Any]], start: str) -> Set[str]:
    visited: Set[str] = set()
    stack = [start]
    while stack:
        node_id = stack.pop()
        if node_id in visited or node_id not in node_map:
            continue
        visited.add(node_id)
        stack.extend(local_targets(node_map[node_id]) - visited)
    return visited


def scene_targets(scene: Mapping[str, Any]) -> Set[str]:
    targets: Set[str] = set()
    for node in scene.get("nodes", []):
        if node.get("kind") == "exit":
            targets.update(transition.get("scene") for transition in node.get("transitions", []) if transition.get("scene"))
    return targets


def scene_reachable(scenes: Mapping[str, Mapping[str, Any]], entry: str) -> Set[str]:
    visited: Set[str] = set()
    stack = [entry]
    while stack:
        scene_id = stack.pop()
        if scene_id in visited or scene_id not in scenes:
            continue
        visited.add(scene_id)
        stack.extend(scene_targets(scenes[scene_id]) - visited)
    return visited


def unique_list(values: Iterable[str]) -> List[str]:
    result: List[str] = []
    for value in values:
        if value not in result:
            result.append(value)
    return result


def derive_emotion(character: Mapping[str, Any], state: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    character_id = character.get("id")
    stats = state.get("hidden", {}).get("heroines", {}).get(character_id)
    if not isinstance(stats, dict):
        return None
    rules = sorted(character.get("emotion_rules", []), key=lambda item: item.get("priority", 0), reverse=True)
    for rule in rules:
        matches = True
        for condition in rule.get("conditions", []):
            actual = stats.get(condition.get("stat"), MISSING)
            absolute = {"path": "value", "op": condition.get("op"), "value": condition.get("value")}
            matches = matches and condition_matches({"value": actual}, absolute)
        if matches:
            return {
                "rule": rule.get("id"),
                "emotion": rule.get("emotion"),
                "behavior": rule.get("behavior"),
                "expression": rule.get("default_expression"),
            }
    return None


class Simulator:
    def __init__(
        self,
        project: StoryProject,
        route_id: str,
        choices: Mapping[str, str],
        strategy: str,
        state: Optional[Dict[str, Any]] = None,
    ):
        self.project = project
        self.route_id = route_id
        self.route = project.routes[route_id]
        self.choices = dict(choices)
        self.strategy = strategy
        self.state = copy.deepcopy(state if state is not None else project.initial_state())
        self.trace: List[Dict[str, Any]] = []

    def run(self, max_steps: int = 500, stop_before_scene: Optional[str] = None) -> Dict[str, Any]:
        if not conditions_match(self.state, self.route.get("unlock_conditions", [])):
            raise RuntimeError(f"route is locked for current state: {self.route_id}")
        scene_id = self.route["entry_scene"]
        node_id: Optional[str] = None
        steps = 0
        ending_id: Optional[str] = None
        while steps < max_steps:
            steps += 1
            scene = self.project.scenes.get(scene_id)
            if scene is None:
                raise RuntimeError(f"unknown scene during simulation: {scene_id}")
            if node_id is None:
                if stop_before_scene == scene_id:
                    return {
                        "route": self.route_id,
                        "ending": None,
                        "stopped_at": scene_id,
                        "trace": self.trace,
                        "final_state": self.state,
                    }
                if not conditions_match(self.state, scene.get("entry_conditions", [])):
                    raise RuntimeError(f"entry conditions failed: {scene_id}")
                node_id = scene["start_node"]
                self.trace.append({"type": "scene", "scene": scene_id, "title": scene.get("title")})
            node_map = {node["id"]: node for node in scene["nodes"]}
            node = node_map[node_id]
            kind = node["kind"]
            if kind in {"dual_dialogue", "dual_narration"}:
                self.trace.append({
                    "type": kind,
                    "scene": scene_id,
                    "node": node_id,
                    "speaker": node.get("speaker"),
                    "perceived": node["perceived"]["line"],
                    "reality": node["reality"]["line"],
                })
                node_id = node["next"]
            elif kind == "choice":
                enabled = [option for option in node["options"] if conditions_match(self.state, option.get("conditions", []))]
                if not enabled:
                    raise RuntimeError(f"no enabled option: {scene_id}:{node_id}")
                key_specific = f"{scene_id}:{node_id}"
                selected_id = self.choices.get(key_specific, self.choices.get(scene_id))
                if selected_id:
                    matches = [option for option in enabled if option["id"] == selected_id]
                    if not matches:
                        raise RuntimeError(f"choice {selected_id} is not enabled at {key_specific}")
                    selected = matches[0]
                else:
                    selected = enabled[0] if self.strategy == "first" else enabled[-1]
                before = copy.deepcopy(self.state)
                applied = []
                for effect in selected.get("effects", []):
                    if apply_effect(self.project, self.state, effect):
                        applied.append(effect)
                self.trace.append({
                    "type": "choice",
                    "scene": scene_id,
                    "node": node_id,
                    "option": selected["id"],
                    "label": selected["label"],
                    "action": selected["action"],
                    "effects": applied,
                    "state_diff": state_diff(before, self.state),
                })
                node_id = selected["next"]
            elif kind == "state_gate":
                transition = choose_transition(self.state, node["transitions"])
                self.trace.append({"type": "state_gate", "scene": scene_id, "node": node_id, "selected": transition.get("node")})
                node_id = transition["node"]
            elif kind == "effect":
                before = copy.deepcopy(self.state)
                applied = []
                for effect in node.get("effects", []):
                    if apply_effect(self.project, self.state, effect):
                        applied.append(effect)
                self.trace.append({
                    "type": "effect",
                    "scene": scene_id,
                    "node": node_id,
                    "effects": applied,
                    "state_diff": state_diff(before, self.state),
                })
                node_id = node["next"]
            elif kind == "exit":
                transition = choose_transition(self.state, node["transitions"])
                if transition.get("ending") is True:
                    ending_id = transition["ending_id"]
                    self.trace.append({"type": "ending", "scene": scene_id, "ending": ending_id})
                    break
                next_scene = transition["scene"]
                self.trace.append({"type": "transition", "scene": scene_id, "next_scene": next_scene})
                scene_id = next_scene
                node_id = None
            else:
                raise RuntimeError(f"unsupported node kind during simulation: {kind}")
        else:
            raise RuntimeError(f"simulation exceeded {max_steps} steps")
        return {"route": self.route_id, "ending": ending_id, "stopped_at": None, "trace": self.trace, "final_state": self.state}


def choose_transition(state: Mapping[str, Any], transitions: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
    for transition in transitions:
        if transition.get("default") is True or conditions_match(state, transition.get("conditions", [])):
            return transition
    raise RuntimeError("no transition matched")


def state_diff(before: Mapping[str, Any], after: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    before_values = dict(walk_leaves(before))
    after_values = dict(walk_leaves(after))
    result = {}
    for path in sorted(set(before_values) | set(after_values)):
        old = before_values.get(path, MISSING)
        new = after_values.get(path, MISSING)
        if old != new:
            result[path] = {
                "before": None if old is MISSING else old,
                "after": None if new is MISSING else new,
            }
    return result


def parse_choice_overrides(values: Sequence[str]) -> Dict[str, str]:
    result = {}
    for value in values:
        if "=" not in value:
            raise RuntimeError(f"invalid --choose value, expected KEY=OPTION: {value}")
        key, option = value.split("=", 1)
        result[key.strip()] = option.strip()
    return result


def parse_state_overrides(values: Sequence[str], state: Dict[str, Any]) -> Dict[str, Any]:
    for value in values:
        if "=" not in value:
            raise RuntimeError(f"invalid --state value, expected PATH=JSON: {value}")
        path, raw = value.split("=", 1)
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = raw
        set_path(state, path.strip(), parsed)
    return state


def print_simulation(result: Mapping[str, Any]) -> None:
    for event in result["trace"]:
        event_type = event["type"]
        if event_type == "scene":
            print(f"\nSCENE {event['scene']} — {event['title']}")
        elif event_type in {"dual_dialogue", "dual_narration"}:
            speaker = f" [{event['speaker']}]" if event.get("speaker") else ""
            print(f"  {event_type}{speaker}")
            print(f"    perceived: {event['perceived']}")
            print(f"    reality:   {event['reality']}")
        elif event_type == "choice":
            print(f"  CHOICE {event['option']}: {event['label']}")
            print(f"    action: {event['action']}")
            for path, change in event["state_diff"].items():
                print(f"    {path}: {change['before']!r} -> {change['after']!r}")
        elif event_type == "state_gate":
            print(f"  GATE -> {event['selected']}")
        elif event_type == "effect":
            for path, change in event["state_diff"].items():
                print(f"  EFFECT {path}: {change['before']!r} -> {change['after']!r}")
        elif event_type == "transition":
            print(f"  -> {event['next_scene']}")
        elif event_type == "ending":
            print(f"\nENDING {event['ending']}")
    print("\nFINAL STATE")
    print(yaml.safe_dump(result["final_state"], allow_unicode=True, sort_keys=False).rstrip())


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def command_validate(project: StoryProject, args: argparse.Namespace) -> int:
    issues = project.validate()
    for issue in issues:
        print(issue.render())
    errors = [issue for issue in issues if issue.severity == "error"]
    warnings = [issue for issue in issues if issue.severity == "warning"]
    print(f"Validated {len(project.characters)} characters, {len(project.routes)} routes, {len(project.scenes)} scenes: {len(errors)} errors, {len(warnings)} warnings")
    return 1 if errors else 0


def command_build(project: StoryProject, args: argparse.Namespace) -> int:
    issues = project.validate()
    errors = [issue for issue in issues if issue.severity == "error"]
    if errors:
        for issue in issues:
            print(issue.render(), file=sys.stderr)
        print("Build aborted because validation failed.", file=sys.stderr)
        return 1
    output = Path(args.out) if args.out else PROJECT_ROOT / project.manifest["build"]["runtime_output"]
    write_json(output, project.build_bundle())
    print(f"Built runtime story: {output}")
    return 0


def command_simulate(project: StoryProject, args: argparse.Namespace) -> int:
    if args.route not in project.routes:
        raise RuntimeError(f"unknown route: {args.route}")
    state = parse_state_overrides(args.state, project.initial_state())
    simulator = Simulator(project, args.route, parse_choice_overrides(args.choose), args.strategy, state)
    result = simulator.run(max_steps=args.max_steps)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_simulation(result)
    return 0


def command_context(project: StoryProject, args: argparse.Namespace) -> int:
    state = parse_state_overrides(args.state, project.initial_state())
    branch_trace = []
    if args.from_route:
        if args.from_route not in project.routes:
            raise RuntimeError(f"unknown route: {args.from_route}")
        result = Simulator(
            project,
            args.from_route,
            parse_choice_overrides(args.choose),
            args.strategy,
            state,
        ).run(stop_before_scene=args.scene)
        if result.get("stopped_at") != args.scene:
            raise RuntimeError(f"scene {args.scene} was not reached from route {args.from_route} with the selected branch")
        state = result["final_state"]
        branch_trace = result["trace"]
    package = project.context_package(args.scene, state)
    package["branch_trace"] = branch_trace
    output = Path(args.out) if args.out else PROJECT_ROOT / project.manifest["build"]["context_output"]
    if args.format == "yaml":
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(yaml.safe_dump(package, allow_unicode=True, sort_keys=False), encoding="utf-8")
    else:
        write_json(output, package)
    print(f"Built AI context: {output}")
    return 0


def command_new_scene(project: StoryProject, args: argparse.Namespace) -> int:
    if args.route not in project.routes:
        raise RuntimeError(f"unknown route: {args.route}")
    if not project.id_is_valid(args.id):
        raise RuntimeError(f"invalid scene id: {args.id}")
    heroine = project.routes[args.route]["heroine"]
    data = {
        "schema_version": 1,
        "id": args.id,
        "title": args.title,
        "route": args.route,
        "chapter": args.chapter,
        "sequence": args.sequence,
        "location": "office",
        "time": "day",
        "purpose": "TODO: 장면 목적을 한 문장으로 작성한다.",
        "cast": ["han_do_yoon", heroine],
        "entry_conditions": [],
        "state_contract": {"reads": [], "writes": []},
        "start_node": "opening",
        "nodes": [
            {
                "id": "opening",
                "kind": "dual_narration",
                "perceived": {
                    "atmosphere": "warm_romance",
                    "line": "TODO",
                    "protagonist_interpretation": "TODO",
                },
                "reality": {
                    "atmosphere": "cold_office",
                    "line": "TODO",
                    "inner_thought": "TODO",
                    "intent": "work_only",
                },
                "next": "leave",
            },
            {
                "id": "leave",
                "kind": "exit",
                "transitions": [{"default": True, "ending": True, "ending_id": f"draft.{args.id}"}],
            },
        ],
    }
    if args.out:
        output = Path(args.out)
    else:
        route_dir = project.story_root / "scenes" / args.route
        output = route_dir / f"{args.id.rsplit('.', 1)[-1]}.yaml"
    if output.exists() and not args.force:
        raise RuntimeError(f"refusing to overwrite existing file: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")
    print(f"Created scene scaffold: {output}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--story-root", default=str(DEFAULT_STORY_ROOT), help="story source directory")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate_parser = subparsers.add_parser("validate", help="validate all story sources")
    validate_parser.set_defaults(func=command_validate)

    build_parser_ = subparsers.add_parser("build", help="compile runtime JSON")
    build_parser_.add_argument("--out")
    build_parser_.set_defaults(func=command_build)

    simulate_parser = subparsers.add_parser("simulate", help="simulate a route")
    simulate_parser.add_argument("--route", required=True)
    simulate_parser.add_argument("--choose", action="append", default=[], help="SCENE[:NODE]=OPTION")
    simulate_parser.add_argument("--state", action="append", default=[], help="PATH=JSON")
    simulate_parser.add_argument("--strategy", choices=["first", "last"], default="first")
    simulate_parser.add_argument("--max-steps", type=int, default=500)
    simulate_parser.add_argument("--json", action="store_true")
    simulate_parser.set_defaults(func=command_simulate)

    context_parser = subparsers.add_parser("context", help="build bounded AI context")
    context_parser.add_argument("--scene", required=True)
    context_parser.add_argument("--state", action="append", default=[], help="PATH=JSON")
    context_parser.add_argument("--from-route", help="simulate this route to the target scene before building context")
    context_parser.add_argument("--choose", action="append", default=[], help="SCENE[:NODE]=OPTION used with --from-route")
    context_parser.add_argument("--strategy", choices=["first", "last"], default="first")
    context_parser.add_argument("--out")
    context_parser.add_argument("--format", choices=["json", "yaml"], default="json")
    context_parser.set_defaults(func=command_context)

    new_scene_parser = subparsers.add_parser("new-scene", help="create a scene scaffold")
    new_scene_parser.add_argument("--id", required=True)
    new_scene_parser.add_argument("--route", required=True)
    new_scene_parser.add_argument("--title", required=True)
    new_scene_parser.add_argument("--chapter", type=int, default=1)
    new_scene_parser.add_argument("--sequence", type=int, default=10)
    new_scene_parser.add_argument("--out")
    new_scene_parser.add_argument("--force", action="store_true")
    new_scene_parser.set_defaults(func=command_new_scene)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        project = StoryProject(Path(args.story_root))
        return args.func(project, args)
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
