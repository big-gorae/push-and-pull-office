#!/usr/bin/env python3
"""Story authoring harness for Love Office.

Commands:
  validate  Validate references, state contracts, dual-layer fields, and reachability.
  build     Compile YAML sources into a runtime-friendly JSON bundle.
  timeline  Inspect event availability at a date and time slot.
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
        self.campaigns = self._load_kind("campaigns")
        self.characters = self._load_kind("characters")
        self.events = self._load_kind("events")
        self.locales = self._load_kind("locales")
        self.visuals = self._load_kind("visuals")
        self.threads = self._load_kind("threads")
        self.meta = self._load_kind("meta")
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
                if spec.get("stat_from_path"):
                    stat = self.manifest.get("stats", {}).get(path)
                    if stat:
                        result.update(stat)
                return result
        return None

    def validate(self) -> List[Issue]:
        issues: List[Issue] = []
        self._validate_manifest(issues)
        self._validate_campaigns(issues)
        self._validate_characters(issues)
        self._validate_events(issues)
        self._validate_locales(issues)
        self._validate_visuals(issues)
        self._validate_threads(issues)
        self._validate_meta(issues)
        self._validate_routes(issues)
        self._validate_scenes(issues)
        self._validate_global_graph(issues)
        self._validate_timeline_graph(issues)
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

    def _validate_campaigns(self, issues: List[Issue]) -> None:
        if len(self.campaigns) != 1:
            self._error(issues, "story/campaigns", "exactly one campaign is required")
        valid_slots = self.manifest.get("enums", {}).get("time_slot", [])
        for campaign_id, campaign in self.campaigns.items():
            location = relative_source(campaign.get("_source", campaign_id))
            for key in ("title", "total_days", "slots", "choice_slots", "acts", "lanes"):
                if key not in campaign:
                    self._error(issues, location, f"required key is missing: {key}")
            total_days = campaign.get("total_days")
            if not isinstance(total_days, int) or total_days < 1:
                self._error(issues, location, "total_days must be a positive integer")
                continue
            if campaign.get("slots") != valid_slots:
                self._error(issues, location, "campaign slots must match manifest enums.time_slot order")
            for slot in campaign.get("choice_slots", []):
                if slot not in valid_slots:
                    self._error(issues, location, f"unknown choice slot: {slot}")
            covered: Set[int] = set()
            for index, act in enumerate(campaign.get("acts", [])):
                act_location = f"{location}#acts[{index}]"
                days = act.get("days", [])
                if not isinstance(days, list) or len(days) != 2 or not all(isinstance(day, int) for day in days):
                    self._error(issues, act_location, "days must be [start, end]")
                    continue
                start, end = days
                if start < 1 or end > total_days or start > end:
                    self._error(issues, act_location, "act day range is outside campaign")
                    continue
                for day in range(start, end + 1):
                    if day in covered:
                        self._error(issues, act_location, f"day {day} is covered by more than one act")
                    covered.add(day)
            missing = sorted(set(range(1, total_days + 1)) - covered)
            if missing:
                self._error(issues, location, f"campaign acts do not cover days: {missing}")
            lane_ids = [lane.get("id") for lane in campaign.get("lanes", []) if isinstance(lane, dict)]
            if len(lane_ids) != len(set(lane_ids)):
                self._error(issues, location, "campaign lane ids must be unique")

    def _validate_event_effects(self, issues: List[Issue], location: str, effects: Any) -> None:
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
            if op not in VALID_EFFECT_OPS:
                self._error(issues, item_location, f"invalid effect op: {op}")
            if "value" not in effect:
                self._error(issues, item_location, "effect value is required")
            if op == "add" and spec and spec.get("type") != "integer":
                self._error(issues, item_location, "add can only target integer stats")
            self._validate_conditions(issues, item_location, effect.get("conditions", []), None)

    def _validate_events(self, issues: List[Issue]) -> None:
        campaign = next(iter(self.campaigns.values()), {})
        total_days = campaign.get("total_days", 0)
        valid_slots = set(campaign.get("slots", []))
        valid_lanes = {lane.get("id") for lane in campaign.get("lanes", []) if isinstance(lane, dict)}
        event_types = set(self.manifest.get("enums", {}).get("event_type", []))
        availability_values = set(self.manifest.get("enums", {}).get("event_availability", []))
        completion_values = set(self.manifest.get("enums", {}).get("event_completion", []))
        for event_id, event in self.events.items():
            location = relative_source(event.get("_source", event_id))
            for key in ("title", "type", "lane", "window", "duration", "priority", "availability", "presentation"):
                if key not in event:
                    self._error(issues, location, f"required key is missing: {key}")
            if event.get("type") not in event_types:
                self._error(issues, location, f"unknown event type: {event.get('type')}")
            if event.get("lane") not in valid_lanes:
                self._error(issues, location, f"unknown timeline lane: {event.get('lane')}")
            if event.get("availability") not in availability_values:
                self._error(issues, location, f"unknown availability: {event.get('availability')}")
            if event.get("completion", "return_to_timeline") not in completion_values:
                self._error(issues, location, f"unknown completion: {event.get('completion')}")
            if not isinstance(event.get("duration"), int) or event.get("duration", 0) < 0:
                self._error(issues, location, "duration must be a non-negative integer")
            if not isinstance(event.get("priority"), int):
                self._error(issues, location, "priority must be an integer")

            window = event.get("window", {})
            if not isinstance(window, dict):
                self._error(issues, location, "window must be a mapping")
                continue
            days = window.get("days")
            if not isinstance(days, list) or len(days) != 2 or not all(isinstance(day, int) for day in days):
                self._error(issues, location, "window.days must be [start, end]")
            else:
                start, end = days
                if start < 1 or end > total_days or start > end:
                    self._error(issues, location, "event window is outside the campaign")
                deadline = window.get("deadline_day", end)
                if not isinstance(deadline, int) or deadline < start or deadline > total_days:
                    self._error(issues, location, "deadline_day must be inside the event campaign range")
            slots = window.get("slots")
            if not isinstance(slots, list) or not slots:
                self._error(issues, location, "window.slots must be a non-empty list")
            else:
                for slot in slots:
                    if slot not in valid_slots:
                        self._error(issues, location, f"unknown event slot: {slot}")

            scene_id = event.get("scene")
            if scene_id and scene_id not in self.scenes:
                self._error(issues, location, f"unknown scene: {scene_id}")
            if event.get("type") in {"heroine", "ending"} and not scene_id:
                self._error(issues, location, "heroine and ending events require scene")
            for character_id in event.get("participants", []):
                if character_id not in self.characters:
                    self._error(issues, location, f"unknown participant: {character_id}")
            thread_id = event.get("thread")
            if thread_id and thread_id not in self.threads:
                self._error(issues, location, f"unknown thread: {thread_id}")
            requires = event.get("requires", {})
            if not isinstance(requires, dict):
                self._error(issues, location, "requires must be a mapping")
            else:
                self._validate_conditions(issues, f"{location}#requires", requires.get("conditions", []), None)
                for required_id in requires.get("events", []):
                    if required_id not in self.events:
                        self._error(issues, location, f"unknown required event: {required_id}")
            self._validate_event_effects(issues, f"{location}#on_seen", event.get("on_seen", {}).get("effects", []))
            missed = event.get("on_missed", {})
            self._validate_event_effects(issues, f"{location}#on_missed", missed.get("effects", []))
            trigger_id = missed.get("trigger_event")
            if trigger_id and trigger_id not in self.events:
                self._error(issues, location, f"unknown on_missed trigger event: {trigger_id}")
            presentation = event.get("presentation", {})
            for layer in ("perceived", "reality"):
                if not isinstance(presentation.get(layer), dict) or not presentation[layer].get("title") or not presentation[layer].get("summary"):
                    self._error(issues, location, f"presentation.{layer} requires title and summary")

    def _validate_threads(self, issues: List[Issue]) -> None:
        for thread_id, thread in self.threads.items():
            location = relative_source(thread.get("_source", thread_id))
            for key in ("title", "lane", "events"):
                if key not in thread:
                    self._error(issues, location, f"required key is missing: {key}")
            event_ids = thread.get("events", [])
            if not isinstance(event_ids, list) or not event_ids:
                self._error(issues, location, "thread events must be a non-empty list")
                continue
            if len(event_ids) != len(set(event_ids)):
                self._error(issues, location, "thread event ids must be unique")
            for event_id in event_ids:
                if event_id not in self.events:
                    self._error(issues, location, f"unknown thread event: {event_id}")
                elif self.events[event_id].get("thread") != thread_id:
                    self._error(issues, location, f"event {event_id} does not point back to thread {thread_id}")

    def _validate_meta(self, issues: List[Issue]) -> None:
        for meta_id, meta in self.meta.items():
            location = relative_source(meta.get("_source", meta_id))
            rules = meta.get("unlock_rules")
            if not isinstance(rules, list):
                self._error(issues, location, "unlock_rules must be a list")
                continue
            for index, rule in enumerate(rules):
                rule_location = f"{location}#unlock_rules[{index}]"
                if not self.id_is_valid(rule.get("id")):
                    self._error(issues, rule_location, "unlock rule requires a valid id")
                if not rule.get("mode") or not rule.get("reward"):
                    self._error(issues, rule_location, "unlock rule requires mode and reward")
                self._validate_conditions(issues, rule_location, rule.get("conditions", []), None)
            for index, teaser in enumerate(meta.get("mode_teasers", [])):
                teaser_location = f"{location}#mode_teasers[{index}]"
                if not self.id_is_valid(teaser.get("id")):
                    self._error(issues, teaser_location, "mode teaser requires a valid id")
                self._validate_conditions(issues, teaser_location, teaser.get("conditions", []), None)
                reveals = teaser.get("reveals")
                if not isinstance(reveals, list) or not reveals:
                    self._error(issues, teaser_location, "mode teaser requires non-empty reveals")
                else:
                    for reveal in reveals:
                        if not reveal.get("mode") or not reveal.get("title") or not reveal.get("teaser"):
                            self._error(issues, teaser_location, "each teaser reveal requires mode, title and teaser")

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

    def _validate_locales(self, issues: List[Issue]) -> None:
        project = self.manifest.get("project", {})
        supported = project.get("supported_languages", [])
        default = project.get("default_language")
        if not isinstance(supported, list) or not supported:
            self._error(issues, "story/manifest.yaml#project", "supported_languages must be a non-empty list")
            return
        if default not in supported:
            self._error(issues, "story/manifest.yaml#project", "default_language must be supported")
        if set(supported) != set(self.locales):
            self._error(
                issues,
                "story/locales",
                f"locale files must exactly match supported_languages: expected {sorted(supported)}, got {sorted(self.locales)}",
            )
        for locale_id, locale in self.locales.items():
            location = relative_source(locale.get("_source", locale_id))
            if not re.fullmatch(r"^[a-z][a-z0-9_-]*$", locale_id):
                self._error(issues, location, f"invalid locale id: {locale_id}")
            if not locale.get("name"):
                self._error(issues, location, "locale name is required")
            fallback = locale.get("fallback")
            if fallback is not None and fallback not in self.locales:
                self._error(issues, location, f"unknown locale fallback: {fallback}")
            strings = locale.get("strings")
            if not isinstance(strings, dict):
                self._error(issues, location, "strings must be a mapping")
                continue
            for key, value in strings.items():
                if not isinstance(key, str) or not key:
                    self._error(issues, location, "translation keys must be non-empty strings")
                if not isinstance(value, str) or not value:
                    self._error(issues, f"{location}#strings.{key}", "translation value must be a non-empty string")

        for locale_id in self.locales:
            seen: Set[str] = set()
            current: Optional[str] = locale_id
            while current is not None:
                if current in seen:
                    self._error(issues, "story/locales", f"cyclic locale fallback: {locale_id}")
                    break
                seen.add(current)
                current = self.locales.get(current, {}).get("fallback")

    def resolve_visuals(self) -> Dict[str, Dict[str, Any]]:
        resolved: Dict[str, Dict[str, Any]] = {}
        visiting: Set[str] = set()

        def resolve(visual_id: str) -> Dict[str, Any]:
            if visual_id in resolved:
                return resolved[visual_id]
            if visual_id in visiting:
                raise RuntimeError(f"cyclic visual inheritance: {visual_id}")
            visual = self.visuals.get(visual_id)
            if visual is None:
                raise RuntimeError(f"unknown visual parent: {visual_id}")
            visiting.add(visual_id)
            parent_id = visual.get("extends")
            base = resolve(parent_id) if isinstance(parent_id, str) else {}
            merged = deep_merge(base, clean_source(visual))
            merged["id"] = visual_id
            if visual.get("kind") in {"background", "character"} and "abstract" not in visual:
                merged["abstract"] = False
            visiting.remove(visual_id)
            resolved[visual_id] = merged
            return merged

        for visual_id in self.visuals:
            resolve(visual_id)
        return resolved

    def _validate_visuals(self, issues: List[Issue]) -> None:
        valid_kinds = set(self.manifest.get("enums", {}).get("visual_kind", []))
        valid_strategies = set(self.manifest.get("enums", {}).get("render_strategy", []))
        try:
            resolved = self.resolve_visuals()
        except RuntimeError as error:
            self._error(issues, "story/visuals", str(error))
            return

        character_visuals: Dict[str, List[str]] = {}
        for visual_id, source in self.visuals.items():
            location = relative_source(source.get("_source", visual_id))
            if not self.id_is_valid(visual_id):
                self._error(issues, location, f"invalid visual id: {visual_id}")
            if source.get("kind") not in valid_kinds:
                self._error(issues, location, f"unknown visual kind: {source.get('kind')}")
            parent_id = source.get("extends")
            if parent_id and parent_id not in self.visuals:
                self._error(issues, location, f"unknown visual parent: {parent_id}")
            visual = resolved[visual_id]
            strategy = visual.get("render_strategy")
            if strategy not in valid_strategies:
                self._error(issues, location, f"unknown render_strategy: {strategy}")
            if visual.get("abstract"):
                continue
            if visual.get("kind") == "background":
                variants = visual.get("variants")
                if not isinstance(variants, dict) or not variants:
                    self._error(issues, location, "background requires variants")
                    continue
                for variant_id, variant in variants.items():
                    variant_location = f"{location}#variants.{variant_id}"
                    asset = variant.get("asset") if isinstance(variant, dict) else None
                    if not isinstance(asset, str) or not (PROJECT_ROOT / asset).is_file():
                        self._error(issues, variant_location, f"background asset does not exist: {asset}")
                    match = variant.get("match", {}) if isinstance(variant, dict) else {}
                    if not any(match.get(key) for key in ("locations", "times", "atmospheres", "modes")):
                        self._error(issues, variant_location, "background variant needs at least one match dimension")
            elif visual.get("kind") == "character":
                character_id = visual.get("character")
                if character_id not in self.characters:
                    self._error(issues, location, f"unknown character visual target: {character_id}")
                    continue
                character_visuals.setdefault(character_id, []).append(visual_id)
                asset = visual.get("fallback_asset")
                if not isinstance(asset, str) or not (PROJECT_ROOT / asset).is_file():
                    self._error(issues, location, f"character fallback asset does not exist: {asset}")
                outfits = visual.get("outfits", {})
                poses = visual.get("poses", {})
                if visual.get("default_outfit") not in outfits:
                    self._error(issues, location, "default_outfit is not declared in outfits")
                if visual.get("default_pose") not in poses:
                    self._error(issues, location, "default_pose is not declared in poses")
                expressions = self.characters.get(character_id, {}).get("expressions", {})
                for expression_id in visual.get("expression_assets", {}):
                    if expression_id not in expressions:
                        self._error(issues, location, f"unknown expression asset binding: {expression_id}")

        for character_id in self.characters:
            matches = character_visuals.get(character_id, [])
            if len(matches) != 1:
                self._error(issues, "story/visuals", f"character {character_id} requires exactly one concrete visual, got {matches}")

        for scene_id, scene in self.scenes.items():
            for node in scene.get("nodes", []):
                node_id = node.get("id")
                for mode in ("perceived", "reality"):
                    background = resolve_scene_background(resolved, scene, node_id, mode)
                    if background is None:
                        location = relative_source(scene.get("_source", scene_id))
                        self._error(issues, f"{location}#nodes.{node_id}", f"no background resolves in {mode} mode")

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
            flags = node.get("presentation_flags", [])
            valid_flags = set(self.manifest.get("enums", {}).get("presentation_flag", []))
            for flag in flags:
                if flag not in valid_flags:
                    self._error(issues, location, f"unknown presentation flag: {flag}")
            if perceived.get("line") != reality.get("line") and "auditory_distortion" not in flags:
                self._error(issues, location, "spoken lines must match unless auditory_distortion is explicit")
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

    def _validate_timeline_graph(self, issues: List[Issue]) -> None:
        visiting: Set[str] = set()
        visited: Set[str] = set()

        def visit(event_id: str, chain: List[str]) -> None:
            if event_id in visiting:
                self._error(issues, "story/events", f"cyclic event dependency: {' -> '.join(chain + [event_id])}")
                return
            if event_id in visited or event_id not in self.events:
                return
            visiting.add(event_id)
            event = self.events[event_id]
            for required_id in event.get("requires", {}).get("events", []):
                visit(required_id, chain + [event_id])
            visiting.remove(event_id)
            visited.add(event_id)

        for event_id in self.events:
            visit(event_id, [])

        occupied: Dict[Tuple[str, int, str], Tuple[str, str | None]] = {}
        for event_id, event in self.events.items():
            window = event.get("window", {})
            days = window.get("days", [])
            slots = window.get("slots", [])
            if len(days) != 2 or days[0] != days[1] or event.get("availability") == "player":
                continue
            for slot in slots:
                key = (event.get("lane"), days[0], slot)
                previous = occupied.get(key)
                group = event.get("exclusive_group")
                if previous and previous[1] != group:
                    location = relative_source(event.get("_source", event_id))
                    self._error(issues, location, f"automatic timeline collision with {previous[0]} at day {days[0]} {slot}")
                else:
                    occupied[key] = (event_id, group)

        referenced_scenes = {event.get("scene") for event in self.events.values() if event.get("scene")}
        for scene_id, scene in self.scenes.items():
            if scene_id not in referenced_scenes:
                location = relative_source(scene.get("_source", scene_id))
                self._error(issues, location, "scene is not scheduled by any timeline event")

    def build_bundle(self) -> Dict[str, Any]:
        source_paths = [self.manifest_path]
        for collection in (
            self.campaigns,
            self.characters,
            self.events,
            self.locales,
            self.visuals,
            self.threads,
            self.meta,
            self.routes,
            self.scenes,
        ):
            source_paths.extend(Path(item["_source"]) for item in collection.values())
        digest = hashlib.sha256()
        project_root = self.story_root.parent
        for path in sorted(source_paths):
            digest.update(str(path.relative_to(project_root)).encode("utf-8"))
            digest.update(path.read_bytes())

        characters = {item_id: clean_source(data) for item_id, data in self.characters.items()}
        campaigns = {item_id: clean_source(data) for item_id, data in self.campaigns.items()}
        events = {item_id: clean_source(data) for item_id, data in self.events.items()}
        visuals = self.resolve_visuals()
        threads = {item_id: clean_source(data) for item_id, data in self.threads.items()}
        meta = {item_id: clean_source(data) for item_id, data in self.meta.items()}
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
            "localization": self.localization_bundle(),
            "campaigns": campaigns,
            "characters": characters,
            "events": events,
            "visuals": visuals,
            "threads": threads,
            "meta": meta,
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
        visual_scene = {
            mode: resolve_scene_stage(self.resolve_visuals(), clean_source(scene), scene.get("start_node"), mode)
            for mode in ("perceived", "reality")
        }
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
            "localization": self.localization_bundle(),
            "visual_scene": visual_scene,
            "linked_scenes": linked_scenes,
            "open_questions": [],
        }

    def localization_bundle(self) -> Dict[str, Any]:
        source_strings = collect_localizable_strings(self)
        raw_catalogs = {
            locale_id: clean_source(locale).get("strings", {})
            for locale_id, locale in self.locales.items()
        }
        default_locale = self.manifest.get("project", {}).get("default_language", "ko")
        supported = self.manifest.get("project", {}).get("supported_languages", [default_locale])
        catalogs: Dict[str, Dict[str, str]] = {}
        coverage: Dict[str, Dict[str, Any]] = {}

        def resolved_strings(locale_id: str, visiting: Optional[Set[str]] = None) -> Dict[str, str]:
            if locale_id in catalogs:
                return catalogs[locale_id]
            chain = set(visiting or set())
            if locale_id in chain:
                return {}
            chain.add(locale_id)
            locale = self.locales.get(locale_id, {})
            fallback = locale.get("fallback")
            base = resolved_strings(fallback, chain) if isinstance(fallback, str) else dict(source_strings)
            base.update(raw_catalogs.get(locale_id, {}))
            catalogs[locale_id] = base
            return base

        total = len(source_strings)
        for locale_id in supported:
            resolved_strings(locale_id)
            translated = sum(1 for key in source_strings if key in raw_catalogs.get(locale_id, {}))
            coverage[locale_id] = {
                "translated": translated,
                "total": total,
                "ratio": round(translated / total, 4) if total else 1.0,
                "missing": [key for key in source_strings if key not in raw_catalogs.get(locale_id, {})],
            }
        return {
            "default_locale": default_locale,
            "supported_locales": supported,
            "locale_names": {locale_id: self.locales.get(locale_id, {}).get("name", locale_id) for locale_id in supported},
            "locales": {locale_id: clean_source(locale) for locale_id, locale in self.locales.items()},
            "source_strings": source_strings,
            "catalogs": catalogs,
            "coverage": coverage,
        }


def deep_merge(base: Mapping[str, Any], override: Mapping[str, Any]) -> Dict[str, Any]:
    """Merge an inherited visual object without mutating either source."""
    result = copy.deepcopy(dict(base))
    for key, value in override.items():
        if isinstance(result.get(key), dict) and isinstance(value, Mapping):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def scene_node(scene: Mapping[str, Any], node_id: Optional[str]) -> Optional[Mapping[str, Any]]:
    nodes = scene.get("nodes", {})
    if isinstance(nodes, Mapping):
        value = nodes.get(node_id)
        return value if isinstance(value, Mapping) else None
    if isinstance(nodes, list):
        return next((node for node in nodes if isinstance(node, Mapping) and node.get("id") == node_id), None)
    return None


def resolve_scene_background(
    visuals: Mapping[str, Mapping[str, Any]],
    scene: Mapping[str, Any],
    node_id: Optional[str],
    mode: str,
) -> Optional[Dict[str, Any]]:
    node = scene_node(scene, node_id)
    layer = node.get(mode, {}) if isinstance(node, Mapping) else {}
    dimensions = {
        "locations": scene.get("location"),
        "times": scene.get("time"),
        "atmospheres": layer.get("atmosphere") if isinstance(layer, Mapping) else None,
        "modes": mode,
    }
    candidates: List[Dict[str, Any]] = []
    for visual_id, visual in visuals.items():
        if visual.get("kind") != "background" or visual.get("abstract"):
            continue
        for variant_id, variant in visual.get("variants", {}).items():
            if not isinstance(variant, Mapping):
                continue
            match = variant.get("match", {})
            if not isinstance(match, Mapping):
                continue
            score = int(variant.get("priority", 0))
            matched: List[str] = []
            rejected = False
            for key, actual in dimensions.items():
                expected = match.get(key)
                if expected:
                    if actual not in expected:
                        rejected = True
                        break
                    matched.append(f"{key}:{actual}")
                    score += 5
            if rejected:
                continue
            candidates.append({
                "visual_id": visual_id,
                "variant_id": variant_id,
                "asset": variant.get("asset"),
                "title_key": visual.get("title_key"),
                "defaults": copy.deepcopy(visual.get("defaults", {})),
                "score": score,
                "matched": matched,
            })
    if not candidates:
        return None
    return sorted(candidates, key=lambda item: (-item["score"], item["visual_id"], item["variant_id"]))[0]


def resolve_scene_stage(
    visuals: Mapping[str, Mapping[str, Any]],
    scene: Mapping[str, Any],
    node_id: Optional[str],
    mode: str,
) -> Dict[str, Any]:
    background = resolve_scene_background(visuals, scene, node_id, mode)
    node = scene_node(scene, node_id)
    layer = node.get(mode, {}) if isinstance(node, Mapping) else {}
    speaker = node.get("speaker") if isinstance(node, Mapping) else None
    cast = list(scene.get("cast", []))
    position_sets = {
        1: ["center"],
        2: ["left", "right"],
        3: ["far_left", "center", "far_right"],
    }
    positions = position_sets.get(len(cast), ["far_left", "left", "right", "far_right"])
    characters = []
    for index, character_id in enumerate(cast):
        visual = next(
            (
                item for item in visuals.values()
                if item.get("kind") == "character" and not item.get("abstract") and item.get("character") == character_id
            ),
            None,
        )
        if visual is None:
            continue
        expression_id = layer.get("expression") if character_id == speaker and isinstance(layer, Mapping) else None
        expression_assets = visual.get("expression_assets", {})
        characters.append({
            "visual_id": visual.get("id"),
            "character": character_id,
            "asset": expression_assets.get(expression_id, visual.get("fallback_asset")),
            "expression": expression_id,
            "outfit": visual.get("default_outfit"),
            "pose": visual.get("default_pose"),
            "position": positions[min(index, len(positions) - 1)],
            "speaker": character_id == speaker,
            "render_strategy": visual.get("render_strategy"),
        })
    return {"background": background, "characters": characters, "mode": mode, "node": node_id}


def collect_localizable_strings(project: StoryProject) -> Dict[str, str]:
    """Create stable translation keys while keeping Korean YAML as authoring source."""
    strings: Dict[str, str] = {}

    def add(key: str, value: Any) -> None:
        if isinstance(value, str) and value:
            strings[key] = value

    for campaign_id, campaign in project.campaigns.items():
        base = f"campaign.{campaign_id}"
        add(f"{base}.title", campaign.get("title"))
        for act in campaign.get("acts", []):
            act_id = act.get("id", act.get("number"))
            add(f"{base}.acts.{act_id}.title", act.get("title"))
            add(f"{base}.acts.{act_id}.purpose", act.get("purpose"))
        for lane in campaign.get("lanes", []):
            add(f"{base}.lanes.{lane.get('id')}.title", lane.get("title"))
    for character_id, character in project.characters.items():
        base = f"characters.{character_id}"
        for field in ("display_name", "role", "summary"):
            add(f"{base}.{field}", character.get(field))
        for expression_id, expression in character.get("expressions", {}).items():
            add(f"{base}.expressions.{expression_id}.description", expression.get("description"))
    for event_id, event in project.events.items():
        base = f"events.{event_id}"
        add(f"{base}.title", event.get("title"))
        for mode in ("perceived", "reality"):
            presentation = event.get("presentation", {}).get(mode, {})
            add(f"{base}.presentation.{mode}.title", presentation.get("title"))
            add(f"{base}.presentation.{mode}.summary", presentation.get("summary"))
    for thread_id, thread in project.threads.items():
        add(f"threads.{thread_id}.title", thread.get("title"))
    for route_id, route in project.routes.items():
        base = f"routes.{route_id}"
        add(f"{base}.title", route.get("title"))
        add(f"{base}.summary", route.get("summary"))
        for ending in route.get("endings", []):
            add(f"{base}.endings.{ending.get('scene')}.outcome", ending.get("outcome"))
    for scene_id, scene in project.scenes.items():
        base = f"scenes.{scene_id}"
        add(f"{base}.title", scene.get("title"))
        add(f"{base}.purpose", scene.get("purpose"))
        for node in scene.get("nodes", []):
            node_base = f"{base}.nodes.{node.get('id')}"
            add(f"{node_base}.prompt", node.get("prompt"))
            for mode in ("perceived", "reality"):
                layer = node.get(mode, {})
                add(f"{node_base}.{mode}.line", layer.get("line"))
                add(f"{node_base}.{mode}.protagonist_interpretation", layer.get("protagonist_interpretation"))
                add(f"{node_base}.{mode}.inner_thought", layer.get("inner_thought"))
            for option in node.get("options", []):
                option_base = f"{node_base}.options.{option.get('id')}"
                for field in ("label", "interpretation", "action"):
                    add(f"{option_base}.{field}", option.get(field))
    for meta_id, meta in project.meta.items():
        for teaser in meta.get("mode_teasers", []):
            for reveal in teaser.get("reveals", []):
                base = f"meta.{meta_id}.teasers.{teaser.get('id')}.{reveal.get('mode')}"
                add(f"{base}.title", reveal.get("title"))
                add(f"{base}.teaser", reveal.get("teaser"))
    return dict(sorted(strings.items()))


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


def campaign_act(campaign: Mapping[str, Any], day: int) -> int:
    for act in campaign.get("acts", []):
        days = act.get("days", [])
        if len(days) == 2 and days[0] <= day <= days[1]:
            return int(act.get("number", 1))
    return 1


class TimelineScheduler:
    """Deterministic event availability and offscreen progression for authoring/runtime."""

    def __init__(self, project: StoryProject, state: Optional[Dict[str, Any]] = None):
        self.project = project
        self.campaign = clean_source(next(iter(project.campaigns.values())))
        self.state = copy.deepcopy(state if state is not None else project.initial_state())
        self.trace: List[Dict[str, Any]] = []

    def _event_lists(self) -> Tuple[List[str], List[str], List[str]]:
        progress = self.state.setdefault("progress", {})
        events = progress.setdefault("events", {})
        return (
            events.setdefault("seen", []),
            events.setdefault("missed", []),
            events.setdefault("expired", []),
        )

    def inspect_event(self, event_id: str, day: int, slot: str) -> Dict[str, Any]:
        event = self.project.events[event_id]
        seen, missed, expired = self._event_lists()
        window = event.get("window", {})
        days = window.get("days", [1, 1])
        deadline = window.get("deadline_day", days[1])
        reasons: List[str] = []
        if event_id in seen:
            return {"event": event_id, "status": "seen", "reasons": [], "eligible": False}
        if event_id in missed or event_id in expired or day > deadline:
            return {"event": event_id, "status": "missed", "reasons": [f"마감 {deadline}일 경과"], "eligible": False}
        if day < days[0]:
            return {"event": event_id, "status": "upcoming", "reasons": [f"{days[0]}일부터 가능"], "eligible": False}
        if day > days[1]:
            return {"event": event_id, "status": "missed", "reasons": [f"발생 기간 {days[0]}~{days[1]}일 종료"], "eligible": False}
        if slot not in window.get("slots", []):
            reasons.append("현재 시간대가 아님")
        requires = event.get("requires", {})
        for required_id in requires.get("events", []):
            if required_id not in seen:
                reasons.append(f"선행 사건 미완료: {required_id}")
        for condition in requires.get("conditions", []):
            if not condition_matches(self.state, condition):
                current = get_path(self.state, condition.get("path", ""), None)
                reasons.append(
                    f"조건 불충족: {condition.get('path')} {condition.get('op')} "
                    f"{condition.get('value')!r} (현재 {current!r})"
                )
        if reasons:
            return {"event": event_id, "status": "blocked", "reasons": reasons, "eligible": False}
        return {"event": event_id, "status": "eligible", "reasons": [], "eligible": True}

    def inspect(self, day: int, slot: str) -> List[Dict[str, Any]]:
        if day < 1 or day > self.campaign.get("total_days", 0):
            raise RuntimeError(f"day is outside campaign: {day}")
        if slot not in self.campaign.get("slots", []):
            raise RuntimeError(f"unknown time slot: {slot}")
        result = []
        for event_id, event in self.project.events.items():
            item = self.inspect_event(event_id, day, slot)
            item["priority"] = event.get("priority", 0)
            item["availability"] = event.get("availability")
            item["lane"] = event.get("lane")
            result.append(item)
        order = {"eligible": 0, "blocked": 1, "upcoming": 2, "seen": 3, "missed": 4}
        return sorted(result, key=lambda item: (order.get(item["status"], 9), -item["priority"], item["event"]))

    def apply_event(self, event_id: str, day: int, slot: str, automatic: bool = False) -> Dict[str, Any]:
        verdict = self.inspect_event(event_id, day, slot)
        if not verdict["eligible"]:
            raise RuntimeError(f"event is not eligible: {event_id}: {', '.join(verdict['reasons'])}")
        event = self.project.events[event_id]
        before = copy.deepcopy(self.state)
        for effect in event.get("on_seen", {}).get("effects", []):
            apply_effect(self.project, self.state, effect)
        seen, _, _ = self._event_lists()
        if event_id not in seen:
            seen.append(event_id)
        self._set_time(day, slot)
        entry = {
            "type": "event",
            "event": event_id,
            "day": day,
            "slot": slot,
            "automatic": automatic,
            "scene": event.get("scene"),
            "state_diff": state_diff(before, self.state),
        }
        self.trace.append(entry)
        return entry

    def process_missed(self, day: int) -> List[Dict[str, Any]]:
        processed = []
        seen, missed, expired = self._event_lists()
        for event_id, event in self.project.events.items():
            if event_id in seen or event_id in missed:
                continue
            window = event.get("window", {})
            deadline = window.get("deadline_day", window.get("days", [day, day])[1])
            if day <= deadline:
                continue
            before = copy.deepcopy(self.state)
            for effect in event.get("on_missed", {}).get("effects", []):
                apply_effect(self.project, self.state, effect)
            missed.append(event_id)
            expired.append(event_id)
            entry = {
                "type": "missed",
                "event": event_id,
                "day": day,
                "trigger_event": event.get("on_missed", {}).get("trigger_event"),
                "state_diff": state_diff(before, self.state),
            }
            self.trace.append(entry)
            processed.append(entry)
        return processed

    def process_automatic(self, day: int, slot: str) -> List[Dict[str, Any]]:
        self.process_missed(day)
        eligible = [
            item for item in self.inspect(day, slot)
            if item["eligible"] and item["availability"] in {"automatic", "hidden"}
        ]
        applied = []
        occupied_lanes: Set[str] = set()
        for item in eligible:
            event = self.project.events[item["event"]]
            group = event.get("exclusive_group")
            lane_key = f"{item['lane']}:{group or ''}"
            if lane_key in occupied_lanes:
                continue
            applied.append(self.apply_event(item["event"], day, slot, automatic=True))
            occupied_lanes.add(lane_key)
        return applied

    def _set_time(self, day: int, slot: str) -> None:
        set_path(self.state, "progress.time.day", day)
        set_path(self.state, "progress.time.slot", slot)
        set_path(self.state, "progress.time.act", campaign_act(self.campaign, day))


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
    print(
        f"Validated {len(project.campaigns)} campaign, {len(project.events)} events, "
        f"{len(project.threads)} threads, {len(project.characters)} characters, "
        f"{len(project.locales)} locales, {len(project.visuals)} visuals, "
        f"{len(project.routes)} routes, {len(project.scenes)} scenes: "
        f"{len(errors)} errors, {len(warnings)} warnings"
    )
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


def command_timeline(project: StoryProject, args: argparse.Namespace) -> int:
    state = parse_state_overrides(args.state, project.initial_state())
    scheduler = TimelineScheduler(project, state)
    if args.process_automatic:
        scheduler.process_automatic(args.day, args.slot)
    result = {
        "day": args.day,
        "slot": args.slot,
        "act": campaign_act(scheduler.campaign, args.day),
        "events": scheduler.inspect(args.day, args.slot),
        "trace": scheduler.trace,
        "state": scheduler.state,
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"DAY {args.day} · {args.slot} · ACT {result['act']}")
        for item in result["events"]:
            if item["status"] in {"eligible", "blocked"}:
                reasons = f" — {'; '.join(item['reasons'])}" if item["reasons"] else ""
                print(f"  {item['status'].upper():8} {item['event']} [{item['lane']}] p{item['priority']}{reasons}")
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

    timeline_parser = subparsers.add_parser("timeline", help="inspect scheduled events at a day and slot")
    timeline_parser.add_argument("--day", type=int, required=True)
    timeline_parser.add_argument("--slot", required=True)
    timeline_parser.add_argument("--state", action="append", default=[], help="PATH=JSON")
    timeline_parser.add_argument("--process-automatic", action="store_true")
    timeline_parser.add_argument("--json", action="store_true")
    timeline_parser.set_defaults(func=command_timeline)

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
