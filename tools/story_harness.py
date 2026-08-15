#!/usr/bin/env python3
"""Story authoring harness for Love Office.

Commands:
  validate  Validate references, state contracts, dual-layer fields, and reachability.
  build     Compile YAML sources into a runtime-friendly JSON bundle.
  timeline  Inspect event availability at a date and time slot.
  night     Inspect or perform one nightly self-development activity.
  simulate  Execute a route with deterministic choices and print a state trace.
  explore   Traverse every reachable choice branch for one or all routes.
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
import math
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Optional, Sequence, Set, Tuple

import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STORY_ROOT = PROJECT_ROOT / "story"
MISSING = object()
NO_DEFAULT = object()
VALID_CONDITION_OPS = {"eq", "ne", "gt", "gte", "lt", "lte", "contains", "not_contains", "exists", "not_exists"}
VALID_EFFECT_OPS = {"set", "add", "append_unique", "remove"}
VALID_PUSH_PULL_ACTIONS = {"approach", "space", "literal"}
VALID_SUPPORT_STYLES = {
    "emotional_validation",
    "factual_clarification",
    "practical_resolution",
    "ask_before_helping",
    "autonomy_return",
    "concise_reassurance",
    "literal_respect",
}
VALID_INTERACTION_CONTEXT_KINDS = {
    "support",
    "coordination",
    "boundary",
    "not_applicable",
}
SELF_DEVELOPMENT_STATE_PREFIX = "visible.protagonist.self_development"
SELF_DEVELOPMENT_PROGRESS_PREFIX = "progress.self_development"
SELF_DEVELOPMENT_STAT_ORDER = ("health", "appearance", "humor", "intelligence")
SELF_DEVELOPMENT_STATS = {"health", "appearance", "humor", "intelligence"}
SELF_DEVELOPMENT_MAX_SCORE_BONUS = 0
SELF_DEVELOPMENT_MAX_HINT_CHARGES = 9
SELF_DEVELOPMENT_BOUNDS = {
    f"{SELF_DEVELOPMENT_STATE_PREFIX}.appeal": (0, 100),
    f"{SELF_DEVELOPMENT_STATE_PREFIX}.fatigue": (0, 6),
    **{
        f"{SELF_DEVELOPMENT_STATE_PREFIX}.stats.{stat}": (0, 5)
        for stat in SELF_DEVELOPMENT_STAT_ORDER
    },
}
PUSH_PULL_LIMIT = 100
PUSH_PULL_OPTIMAL_LIMIT = 56
PUSH_PULL_CHECKPOINT = 32
PUSH_PULL_TURN_BONUS = 6
PUSH_PULL_MAX_COMBO = 5
PLACEHOLDER_PATTERN = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\}\}")
FORBIDDEN_CHOICE_DIRECTION_TERMS = (
    "밀기",
    "당기기",
    "밀당",
    "밀고",
    "당기고",
    "밀어",
    "당겨",
    "밀자",
    "당기자",
)
FORBIDDEN_CHOICE_DIRECTION_ENGLISH = re.compile(r"\b(?:push|pull)\b", re.IGNORECASE)
VISIBLE_INITIATIVE_CONDITION_PATTERN = re.compile(
    r"^visible\.heroines\.[a-z][a-z0-9_]*\.initiative$"
)
APPROVED_UI_STRINGS = {
    "mode.survivor.title": "어나더 스토리",
    "mode.survivor.copy": "새로운 그녀로 새로운 이야기를 만들어 보아요",
}
FORBIDDEN_UI_NARRATIVE_KEYS = {
    "selfDevelopment.intro",
    "selfDevelopment.forcedIntro",
    "analysisHint.lesson.pull",
    "analysisHint.lesson.push",
    "analysisHint.lesson.none",
}
PROTAGONIST_ARTWORK_CHARACTER_ID = "han_do_yoon"
PROTAGONIST_ARTWORK_REVEAL_FLAG = "protagonist_art_reveal"


def is_player_narrative_entry(entry: Mapping[str, Any]) -> bool:
    domain = entry.get("domain")
    field_path = str(entry.get("sourceDocument", {}).get("fieldPath", ""))
    if domain == "system_flow":
        return True
    if domain == "scene":
        return ".analysis_hints." in field_path or field_path.endswith(".line") or any(
            field_path.endswith(suffix)
            for suffix in (".prompt", ".stimulus", ".label", ".interpretation", ".action")
        )
    return domain == "event" and ".presentation." in field_path


def narrative_entry_has_direct_editor_target(entry: Mapping[str, Any]) -> bool:
    document = entry.get("sourceDocument", {})
    kind = document.get("kind")
    field_path = str(document.get("fieldPath", ""))
    if kind == "scene":
        return bool(re.fullmatch(
            r"nodes\.[a-zA-Z0-9_]+(?:\.variants\.[a-zA-Z0-9_]+)?\.line"
            r"|nodes\.[a-zA-Z0-9_]+\.(?:prompt|stimulus)"
            r"|nodes\.[a-zA-Z0-9_]+\.analysis_hints\.(?:pull|push|none)"
            r"|nodes\.[a-zA-Z0-9_]+\.options\.[a-zA-Z0-9_]+\.(?:label|interpretation|action)",
            field_path,
        ))
    if kind == "event":
        return bool(re.fullmatch(r"presentation\.(?:title|summary)", field_path))
    if kind == "system_flow":
        return bool(re.fullmatch(
            r"nodes\.[a-zA-Z0-9_]+(?:\.variants\.[a-zA-Z0-9_]+)?\.line"
            r"|options\.[a-zA-Z0-9_]+\.(?:label|description)",
            field_path,
        ))
    return False


def can_reveal_protagonist_artwork(scene: Mapping[str, Any], node: Optional[Mapping[str, Any]]) -> bool:
    return bool(
        isinstance(node, Mapping)
        and str(scene.get("id", "")).startswith("ending.")
        and node.get("kind") == "narration"
        and PROTAGONIST_ARTWORK_REVEAL_FLAG in node.get("presentation_flags", [])
    )


def reproducible_generated_at() -> str:
    """Return a deterministic timestamp for tracked build artifacts.

    SOURCE_DATE_EPOCH is the standard reproducible-build input. Keeping the
    default at the Unix epoch makes local and CI builds byte-identical even
    when callers do not provide an environment variable.
    """
    raw = os.environ.get("SOURCE_DATE_EPOCH", "0")
    try:
        timestamp = int(raw)
    except ValueError as exc:
        raise RuntimeError("SOURCE_DATE_EPOCH must be an integer") from exc
    return dt.datetime.fromtimestamp(timestamp, tz=dt.timezone.utc).isoformat()


def effective_speaker(node: Mapping[str, Any], mode: Optional[str] = None) -> Optional[str]:
    """Resolve the single nameplate/portrait speaker for a dialogue node."""
    speaker = node.get("speaker")
    return speaker if isinstance(speaker, str) else None


def is_parenthesized_utterance(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    stripped = value.strip()
    return len(stripped) >= 2 and stripped.startswith("(") and stripped.endswith(")")


def contains_explicit_choice_direction(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    return (
        any(term in value for term in FORBIDDEN_CHOICE_DIRECTION_TERMS)
        or FORBIDDEN_CHOICE_DIRECTION_ENGLISH.search(value) is not None
    )


def deep_merge(base: Mapping[str, Any], patch: Mapping[str, Any]) -> Dict[str, Any]:
    """Deeply merge mappings while replacing arrays and scalar values."""
    result = copy.deepcopy(dict(base))
    for key, value in patch.items():
        if isinstance(value, Mapping) and isinstance(result.get(key), Mapping):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


class UniqueKeyLoader(yaml.SafeLoader):
    """YAML loader that rejects duplicate mapping keys instead of silently overwriting."""


def _construct_unique_mapping(loader: UniqueKeyLoader, node: yaml.MappingNode, deep: bool = False) -> Dict[Any, Any]:
    mapping: Dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise yaml.constructor.ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                f"found duplicate key {key!r}",
                key_node.start_mark,
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _construct_unique_mapping,
)


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
        ui_pattern = self.manifest.get("files", {}).get("ui")
        if not isinstance(ui_pattern, str):
            raise RuntimeError("manifest files.ui is required")
        self.ui = self._load_yaml(self.story_root / ui_pattern)
        game_modes_pattern = self.manifest.get("files", {}).get("game_modes")
        if not isinstance(game_modes_pattern, str):
            raise RuntimeError("manifest files.game_modes is required")
        self.game_modes_document = self._load_yaml(self.story_root / game_modes_pattern)
        self.game_modes = self.game_modes_document.get("modes", {})
        self.campaigns = self._load_kind("campaigns")
        self.characters = self._load_kind("characters")
        self.events = self._load_kind("events")
        self.locales = self._load_kind("locales")
        self.visuals = self._load_kind("visuals")
        self.threads = self._load_kind("threads")
        self.meta = self._load_kind("meta")
        self.routes = self._load_kind("routes")
        self.scenes = self._load_kind("scenes")
        self.system_flows = self._load_kind("system_flows")
        self.world = self._load_kind("world")

    def compile_dialogue_node(self, node: Mapping[str, Any]) -> Dict[str, Any]:
        """Return an isolated runtime copy of an explicitly authored dialogue node."""
        return copy.deepcopy(dict(node))

    def compile_scene_dialogue(self, scene: Mapping[str, Any]) -> Dict[str, Any]:
        """Return an isolated runtime copy; runtime-only prose generation is forbidden."""
        return copy.deepcopy(dict(scene))

    @staticmethod
    def _load_yaml(path: Path) -> Dict[str, Any]:
        try:
            with path.open("r", encoding="utf-8") as handle:
                data = yaml.load(handle, Loader=UniqueKeyLoader)
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

    def campaign_initial_state(self, campaign_id: str) -> Dict[str, Any]:
        campaign = self.campaigns.get(campaign_id)
        if campaign is None:
            raise RuntimeError(f"unknown campaign: {campaign_id}")
        patch = campaign.get("initial_state_patch", {})
        if not isinstance(patch, Mapping):
            raise RuntimeError(f"campaign initial_state_patch must be a mapping: {campaign_id}")
        return deep_merge(self.initial_state(), patch)

    def id_is_valid(self, value: Any) -> bool:
        if not isinstance(value, str):
            return False
        return bool(re.fullmatch(self.manifest.get("id_pattern", r"^[a-z][a-z0-9_.]*$"), value))

    def path_spec(self, path: str) -> Optional[Dict[str, Any]]:
        if not isinstance(path, str):
            return None
        if re.fullmatch(r"derived\.characters\.[a-z][a-z0-9_]*\.(rule_id|emotion|behavior|default_expression)", path):
            return {"type": "derived", "read_only": True}
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

    def validate(self, profile: str = "development") -> List[Issue]:
        issues: List[Issue] = []
        self._validate_manifest(issues)
        self._validate_game_modes(issues)
        self._validate_self_development(issues)
        self._validate_system_flows(issues)
        self._validate_gallery(issues)
        self._validate_campaigns(issues)
        self._validate_characters(issues)
        self._validate_events(issues)
        self._validate_locales(issues, profile)
        self._validate_player_ui_contract(issues)
        self._validate_visuals(issues)
        self._validate_threads(issues)
        self._validate_meta(issues)
        self._validate_routes(issues)
        self._validate_world(issues)
        self._validate_scenes(issues)
        self._validate_scene_world_contexts(issues)
        self._validate_global_graph(issues)
        self._validate_timeline_graph(issues)
        return issues

    def _validate_player_ui_contract(self, issues: List[Issue]) -> None:
        strings = self.ui.get("strings", {})
        if not isinstance(strings, Mapping):
            return
        for key, expected in APPROVED_UI_STRINGS.items():
            if strings.get(key) != expected:
                self._error(
                    issues,
                    f"story/ui.yaml#strings.{key}",
                    f"approved player copy must remain {expected!r}",
                )
        for key, value in strings.items():
            if not isinstance(value, str):
                continue
            if "17일" in value or re.search(r"\bACT\s*\d+\b", value, re.IGNORECASE):
                self._error(
                    issues,
                    f"story/ui.yaml#strings.{key}",
                    "player UI must not promote the total day count or visible ACT labels",
                )

    def _error(self, issues: List[Issue], location: str, message: str) -> None:
        issues.append(Issue("error", location, message))

    def _warning(self, issues: List[Issue], location: str, message: str) -> None:
        issues.append(Issue("warning", location, message))

    def _validate_manifest(self, issues: List[Issue]) -> None:
        location = relative_source(self.manifest.get("_source", "manifest.yaml"))
        for key in ("schema_version", "project", "enums", "stats", "initial_state", "self_development", "files", "build"):
            if key not in self.manifest:
                self._error(issues, location, f"required key is missing: {key}")
        state = self.initial_state()
        for path, value in walk_leaves(state):
            spec = self.path_spec(path)
            if spec is None:
                self._error(issues, location, f"initial state path is not declared: {path}")
                continue
            self._validate_value_against_spec(issues, location, path, value, spec)

    def _validate_game_modes(self, issues: List[Issue]) -> None:
        location = relative_source(self.game_modes_document.get("_source", "story/game_modes.yaml"))
        if self.game_modes_document.get("schema_version") != 1:
            self._error(issues, location, "game mode registry schema_version must be 1")
        if self.game_modes_document.get("id") != "game_modes":
            self._error(issues, location, "game mode registry id must be game_modes")
        if not isinstance(self.game_modes, dict):
            self._error(issues, location, "modes must be a mapping")
            return
        required_ids = {"base", "survivor_view"}
        actual_ids = set(self.game_modes)
        if actual_ids != required_ids:
            self._error(
                issues,
                location,
                f"game mode registry must contain exactly {sorted(required_ids)}, got {sorted(actual_ids)}",
            )
        for mode_id, mode in self.game_modes.items():
            mode_location = f"{location}#modes.{mode_id}"
            if not isinstance(mode, dict):
                self._error(issues, mode_location, "mode definition must be a mapping")
                continue
            allowed_keys = {"campaign_id", "planned_campaign_id", "continuity_id", "content_status", "unlock"}
            for key in sorted(set(mode) - allowed_keys):
                self._error(issues, mode_location, f"unknown mode property: {key}")
            for key in ("campaign_id", "continuity_id", "content_status", "unlock"):
                if key not in mode:
                    self._error(issues, mode_location, f"required key is missing: {key}")
            campaign_id = mode.get("campaign_id")
            content_status = mode.get("content_status")
            if content_status not in {"playable", "coming_soon"}:
                self._error(issues, mode_location, f"unknown content_status: {content_status}")
            if content_status == "playable":
                if not isinstance(campaign_id, str) or campaign_id not in self.campaigns:
                    self._error(issues, mode_location, f"playable mode requires a known campaign: {campaign_id}")
            elif campaign_id is not None and campaign_id not in self.campaigns:
                self._error(issues, mode_location, f"unknown campaign: {campaign_id}")
            if not self.id_is_valid(mode.get("continuity_id")):
                self._error(issues, mode_location, "continuity_id must be a valid stable id")
            unlock = mode.get("unlock")
            if not isinstance(unlock, dict):
                self._error(issues, mode_location, "unlock must be a mapping")
            elif unlock.get("always") is True:
                if set(unlock) != {"always"}:
                    self._error(issues, mode_location, "always unlock must not declare other keys")
            else:
                groups = unlock.get("any")
                if not isinstance(groups, list) or not groups:
                    self._error(issues, mode_location, "unlock requires always: true or a non-empty any list")
                else:
                    for index, group in enumerate(groups):
                        group_location = f"{mode_location}.unlock.any[{index}]"
                        if not isinstance(group, dict):
                            self._error(issues, group_location, "unlock group must be a mapping")
                            continue
                        self._validate_conditions(issues, group_location, group.get("conditions", []), None)

        base = self.game_modes.get("base", {})
        survivor = self.game_modes.get("survivor_view", {})
        if base.get("campaign_id") != "main" or base.get("content_status") != "playable":
            self._error(issues, location, "base must remain playable on the stable main campaign")
        if survivor.get("content_status") != "coming_soon" or survivor.get("campaign_id") is not None:
            self._error(issues, location, "survivor_view must remain coming_soon without a campaign until implemented")
        if survivor.get("planned_campaign_id") != "survivor":
            self._error(issues, location, "survivor_view must reserve planned_campaign_id survivor")
        if survivor.get("continuity_id") == base.get("continuity_id"):
            self._error(issues, location, "survivor_view must use a separate continuity")
        approved_post_clear_unlock = {
            "any": [
                {"conditions": [{"path": "progress.cleared_routes", "op": "contains", "value": "seo_a"}]},
                {"conditions": [{"path": "progress.cleared_routes", "op": "contains", "value": "min_kyung"}]},
            ]
        }
        if base.get("unlock") != {"always": True}:
            self._error(issues, location, "base must always be unlocked")
        if survivor.get("unlock") != approved_post_clear_unlock:
            self._error(issues, location, "survivor_view must unlock after either approved main route clear")

    def _validate_self_development(self, issues: List[Issue]) -> None:
        location = f"{relative_source(self.manifest.get('_source', 'manifest.yaml'))}#self_development"
        config = self.manifest.get("self_development")
        if not isinstance(config, dict):
            self._error(issues, location, "self_development must be a mapping")
            return

        stat_specs = self.manifest.get("stats", {})
        for path, (minimum, maximum) in SELF_DEVELOPMENT_BOUNDS.items():
            spec = stat_specs.get(path) if isinstance(stat_specs, dict) else None
            if (
                not isinstance(spec, dict)
                or spec.get("type") != "integer"
                or spec.get("min") != minimum
                or spec.get("max") != maximum
            ):
                self._error(
                    issues,
                    location,
                    f"{path} must keep runtime bounds {minimum}..{maximum}",
                )

        enabled_campaigns = [
            campaign for campaign in self.campaigns.values()
            if campaign.get("systems", {}).get("self_development") is True
        ]
        max_night_day = config.get("max_night_day")
        if (
            not isinstance(max_night_day, int)
            or isinstance(max_night_day, bool)
            or max_night_day < 1
            or any(
                isinstance(campaign.get("total_days"), int)
                and max_night_day > campaign["total_days"]
                for campaign in enabled_campaigns
            )
        ):
            self._error(issues, location, "max_night_day must be inside every campaign that enables self-development")

        activities = config.get("activities")
        activity_ids: Set[str] = set()
        if not isinstance(activities, list) or not activities:
            self._error(issues, location, "activities must be a non-empty list")
        else:
            for index, activity in enumerate(activities):
                activity_location = f"{location}.activities[{index}]"
                if not isinstance(activity, dict):
                    self._error(issues, activity_location, "activity must be a mapping")
                    continue
                activity_id = activity.get("id")
                if not self.id_is_valid(activity_id):
                    self._error(issues, activity_location, f"invalid activity id: {activity_id}")
                elif activity_id in activity_ids:
                    self._error(issues, activity_location, f"duplicate activity id: {activity_id}")
                else:
                    activity_ids.add(activity_id)
                for key in ("appeal_delta", "fatigue_delta", "stat_deltas"):
                    if key not in activity:
                        self._error(issues, activity_location, f"required key is missing: {key}")
                selectable = activity.get("selectable", True)
                if not isinstance(selectable, bool):
                    self._error(issues, activity_location, "selectable must be a boolean")
                for key in ("appeal_delta", "fatigue_delta"):
                    value = activity.get(key)
                    if not isinstance(value, int) or isinstance(value, bool):
                        self._error(issues, activity_location, f"{key} must be an integer")
                fatigue_lte = activity.get("fatigue_lte")
                if fatigue_lte is not None and (
                    not isinstance(fatigue_lte, int) or isinstance(fatigue_lte, bool) or not 0 <= fatigue_lte <= 6
                ):
                    self._error(issues, activity_location, "fatigue_lte must be an integer from 0 to 6")
                fatigue_gte = activity.get("fatigue_gte")
                if fatigue_gte is not None and (
                    not isinstance(fatigue_gte, int) or isinstance(fatigue_gte, bool) or not 0 <= fatigue_gte <= 6
                ):
                    self._error(issues, activity_location, "fatigue_gte must be an integer from 0 to 6")
                hint_charge = activity.get("hint_charge")
                if hint_charge is not None and (
                    not isinstance(hint_charge, int) or isinstance(hint_charge, bool) or not 0 <= hint_charge <= 1
                ):
                    self._error(issues, activity_location, "hint_charge must be 0 or 1")
                stat_deltas = activity.get("stat_deltas")
                if not isinstance(stat_deltas, dict):
                    self._error(issues, activity_location, "stat_deltas must be a mapping")
                else:
                    for stat, delta in stat_deltas.items():
                        if stat not in SELF_DEVELOPMENT_STATS:
                            self._error(issues, activity_location, f"unknown self-development stat: {stat}")
                        if not isinstance(delta, int) or isinstance(delta, bool):
                            self._error(issues, activity_location, f"stat delta must be an integer: {stat}")

            selectable_ids = {
                activity.get("id") for activity in activities
                if isinstance(activity, Mapping) and activity.get("selectable", True) is not False
            }
            if selectable_ids != {"workout", "reading", "ott", "sleep", "dark_psychology"}:
                self._error(
                    issues,
                    location,
                    "selectable night activities must be workout, reading, ott, sleep, and dark_psychology",
                )
            forced = [
                activity for activity in activities
                if isinstance(activity, Mapping) and activity.get("selectable") is False
            ]
            if len(forced) != 1 or forced[0].get("id") != "solo_drinking" or forced[0].get("fatigue_gte") != 5:
                self._error(
                    issues,
                    location,
                    "high fatigue must force solo_drinking at fatigue 5 or above",
                )

        expressions = config.get("expressions")
        if not isinstance(expressions, dict) or not expressions:
            self._error(issues, location, "expressions must be a non-empty mapping")
            return
        for expression_id, expression in expressions.items():
            expression_location = f"{location}.expressions.{expression_id}"
            if not self.id_is_valid(expression_id):
                self._error(issues, expression_location, f"invalid expression id: {expression_id}")
            if not isinstance(expression, dict):
                self._error(issues, expression_location, "expression must be a mapping")
                continue
            unknown_keys = sorted(set(expression) - {"requires", "score_bonus"})
            for key in unknown_keys:
                self._error(issues, expression_location, f"unknown expression key: {key}")
            requires = expression.get("requires")
            if not isinstance(requires, dict) or not requires:
                self._error(issues, expression_location, "expression requires must be a non-empty mapping")
            else:
                unknown_requirements = sorted(
                    set(requires) - {"appeal_gte", "stat", "minimum", "fatigue_lte", "last_activity"}
                )
                for key in unknown_requirements:
                    self._error(issues, expression_location, f"unknown expression requirement: {key}")
                appeal_gte = requires.get("appeal_gte")
                if appeal_gte is not None and (
                    not isinstance(appeal_gte, int) or isinstance(appeal_gte, bool) or not 0 <= appeal_gte <= 100
                ):
                    self._error(issues, expression_location, "appeal_gte must be an integer from 0 to 100")
                stat = requires.get("stat")
                minimum = requires.get("minimum")
                if (stat is None) != (minimum is None):
                    self._error(issues, expression_location, "stat and minimum must be declared together")
                if stat is not None and stat not in SELF_DEVELOPMENT_STATS:
                    self._error(issues, expression_location, f"unknown self-development stat: {stat}")
                if minimum is not None and (
                    not isinstance(minimum, int) or isinstance(minimum, bool) or not 0 <= minimum <= 5
                ):
                    self._error(issues, expression_location, "minimum must be an integer from 0 to 5")
                fatigue_lte = requires.get("fatigue_lte")
                if fatigue_lte is not None and (
                    not isinstance(fatigue_lte, int) or isinstance(fatigue_lte, bool) or not 0 <= fatigue_lte <= 6
                ):
                    self._error(issues, expression_location, "fatigue_lte must be an integer from 0 to 6")
                if "last_activity" in requires:
                    last_activity = requires.get("last_activity")
                    if not isinstance(last_activity, str) or last_activity not in activity_ids:
                        self._error(
                            issues,
                            expression_location,
                            f"last_activity must reference a known self-development activity: {last_activity}",
                        )
            score_bonus = expression.get("score_bonus")
            if (
                not isinstance(score_bonus, int)
                or isinstance(score_bonus, bool)
                or not 0 <= score_bonus <= SELF_DEVELOPMENT_MAX_SCORE_BONUS
            ):
                self._error(
                    issues,
                    expression_location,
                    f"score_bonus must be an integer from 0 to {SELF_DEVELOPMENT_MAX_SCORE_BONUS}",
                )

    def _validate_system_flows(self, issues: List[Issue]) -> None:
        """Require every system-presented narrative line to have one editable YAML owner."""
        required_flows = {"system.night_activity", "system.analysis_hint"}
        if set(self.system_flows) != required_flows:
            self._error(
                issues,
                "story/system_flows",
                f"system flows must be exactly {sorted(required_flows)}, got {sorted(self.system_flows)}",
            )
        for flow_id, flow in self.system_flows.items():
            location = relative_source(flow.get("_source", flow_id))
            if flow.get("schema_version") != 1:
                self._error(issues, location, "system flow schema_version must be 1")
            nodes = flow.get("nodes")
            if not isinstance(nodes, list) or not nodes:
                self._error(issues, location, "system flow nodes must be a non-empty list")
                continue
            node_ids: Set[str] = set()
            for index, node in enumerate(nodes):
                node_location = f"{location}#nodes[{index}]"
                if not isinstance(node, dict):
                    self._error(issues, node_location, "system flow node must be a mapping")
                    continue
                node_id = node.get("id")
                if not self.id_is_valid(node_id) or node_id in node_ids:
                    self._error(issues, node_location, f"invalid or duplicate system node id: {node_id}")
                elif isinstance(node_id, str):
                    node_ids.add(node_id)
                variants = node.get("variants")
                dialogue_units = variants if isinstance(variants, list) else [node]
                if isinstance(variants, list) and not variants:
                    self._error(issues, node_location, "system dialogue variants must not be empty")
                variant_ids: Set[str] = set()
                for unit_index, unit in enumerate(dialogue_units):
                    unit_location = f"{node_location}.variants[{unit_index}]" if isinstance(variants, list) else node_location
                    if not isinstance(unit, dict):
                        self._error(issues, unit_location, "system dialogue unit must be a mapping")
                        continue
                    if isinstance(variants, list):
                        variant_id = unit.get("id")
                        if not self.id_is_valid(variant_id) or variant_id in variant_ids:
                            self._error(issues, unit_location, f"invalid or duplicate system variant id: {variant_id}")
                        elif isinstance(variant_id, str):
                            variant_ids.add(variant_id)
                    line = unit.get("line")
                    if not isinstance(line, str) or not line.strip():
                        self._error(issues, unit_location, "system dialogue requires a non-empty line")

        night = self.system_flows.get("system.night_activity", {})
        night_nodes = {node.get("id"): node for node in night.get("nodes", []) if isinstance(node, dict)}
        if set(night_nodes) != {"intro", "forced_intro", "activity_result"}:
            self._error(issues, "story/system_flows/night_activity.yaml", "night flow requires intro, forced_intro, and activity_result nodes")
        activity_ids = {
            item.get("id") for item in self.manifest.get("self_development", {}).get("activities", [])
            if isinstance(item, Mapping)
        }
        result_variants = {
            item.get("id") for item in night_nodes.get("activity_result", {}).get("variants", [])
            if isinstance(item, Mapping)
        }
        options = night.get("options")
        option_ids = {
            item.get("id") for item in options
            if isinstance(options, list) and isinstance(item, Mapping)
        } if isinstance(options, list) else set()
        if result_variants != activity_ids or option_ids != activity_ids:
            self._error(issues, "story/system_flows/night_activity.yaml", "night result variants and options must cover every activity exactly once")
        for index, option in enumerate(options if isinstance(options, list) else []):
            if not isinstance(option, Mapping):
                continue
            for field in ("label", "description"):
                if not isinstance(option.get(field), str) or not option.get(field, "").strip():
                    self._error(issues, f"story/system_flows/night_activity.yaml#options[{index}]", f"night option requires {field}")

        analysis = self.system_flows.get("system.analysis_hint", {})
        analysis_nodes = {node.get("id"): node for node in analysis.get("nodes", []) if isinstance(node, dict)}
        lesson_variants = {
            item.get("id") for item in analysis_nodes.get("lesson", {}).get("variants", [])
            if isinstance(item, Mapping)
        }
        if set(analysis_nodes) != {"lesson"} or lesson_variants != {"pull", "push", "none"}:
            self._error(issues, "story/system_flows/analysis_hint.yaml", "analysis flow requires lesson variants pull, push, and none")

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

    def _validate_gallery(self, issues: List[Issue]) -> None:
        gallery = self.manifest.get("gallery")
        location = "story/manifest.yaml#gallery"
        if not isinstance(gallery, dict):
            self._error(issues, location, "gallery must be a mapping")
            return
        entries = gallery.get("entries")
        if not isinstance(entries, list) or not entries:
            self._error(issues, location, "gallery.entries must be a non-empty list")
            return
        seen_ids: Set[str] = set()
        seen_memories: Set[str] = set()
        ui_strings = self.ui.get("strings", {})
        for index, entry in enumerate(entries):
            entry_location = f"{location}.entries[{index}]"
            if not isinstance(entry, dict):
                self._error(issues, entry_location, "gallery entry must be a mapping")
                continue
            entry_id = entry.get("id")
            if not self.id_is_valid(entry_id):
                self._error(issues, entry_location, f"invalid gallery entry id: {entry_id}")
            elif entry_id in seen_ids:
                self._error(issues, entry_location, f"duplicate gallery entry id: {entry_id}")
            else:
                seen_ids.add(entry_id)
            memory = entry.get("unlock_memory")
            if not self.id_is_valid(memory):
                self._error(issues, entry_location, f"invalid gallery unlock_memory: {memory}")
            elif memory in seen_memories:
                self._error(issues, entry_location, f"duplicate gallery unlock_memory: {memory}")
            else:
                seen_memories.add(memory)
            for key_name in ("title_key", "description_key"):
                key = entry.get(key_name)
                if not isinstance(key, str) or key not in ui_strings:
                    self._error(issues, entry_location, f"{key_name} must reference a known UI string: {key}")
            asset = entry.get("asset")
            if not isinstance(asset, str) or not asset.startswith("assets/"):
                self._error(issues, entry_location, "gallery asset must be a project-relative assets/ path")
            elif (self.story_root.parent / "assets").exists() and not (self.story_root.parent / asset).is_file():
                self._error(issues, entry_location, f"gallery asset does not exist: {asset}")
            if not isinstance(entry.get("default_unlocked", False), bool):
                self._error(issues, entry_location, "default_unlocked must be boolean")
            stat = entry.get("source_stat")
            minimum = entry.get("source_minimum")
            if (stat is None) != (minimum is None):
                self._error(issues, entry_location, "source_stat and source_minimum must be declared together")
            if stat is not None and stat not in SELF_DEVELOPMENT_STATS:
                self._error(issues, entry_location, f"unknown gallery source_stat: {stat}")
            if minimum is not None and (
                not isinstance(minimum, int) or isinstance(minimum, bool) or not 0 <= minimum <= 5
            ):
                self._error(issues, entry_location, "source_minimum must be an integer from 0 to 5")

    def _validate_campaigns(self, issues: List[Issue]) -> None:
        if not self.campaigns:
            self._error(issues, "story/campaigns", "at least one campaign is required")
        valid_slots = self.manifest.get("enums", {}).get("time_slot", [])
        for campaign_id, campaign in self.campaigns.items():
            location = relative_source(campaign.get("_source", campaign_id))
            for key in ("title", "entry_event_id", "initial_state_patch", "systems", "total_days", "slots", "choice_slots", "acts", "lanes"):
                if key not in campaign:
                    self._error(issues, location, f"required key is missing: {key}")
            if not isinstance(campaign.get("initial_state_patch"), dict):
                self._error(issues, location, "initial_state_patch must be a mapping")
            systems = campaign.get("systems")
            if not isinstance(systems, dict) or not isinstance(systems.get("self_development"), bool):
                self._error(issues, location, "systems.self_development must be a boolean")
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
            try:
                initial_state = self.campaign_initial_state(campaign_id)
            except RuntimeError as exc:
                self._error(issues, location, str(exc))
                initial_state = None
            if initial_state is not None:
                for path, value in walk_leaves(initial_state):
                    spec = self.path_spec(path)
                    if spec is None:
                        self._error(issues, location, f"campaign initial state path is not declared: {path}")
                    else:
                        self._validate_value_against_spec(issues, location, path, value, spec)
            entry_event_id = campaign.get("entry_event_id")
            entry_event = self.events.get(entry_event_id)
            if entry_event is None:
                self._error(issues, location, f"unknown entry_event_id: {entry_event_id}")
            else:
                if entry_event.get("campaign_id") != campaign_id:
                    self._error(issues, location, "entry event must belong to its campaign")
                if entry_event.get("availability") != "automatic":
                    self._error(issues, location, "entry event must be automatic")
                if initial_state is not None:
                    time = initial_state.get("progress", {}).get("time", {})
                    window = entry_event.get("window", {})
                    day = time.get("day")
                    slot = time.get("slot")
                    days = window.get("days", [])
                    if len(days) != 2 or not isinstance(day, int) or not days[0] <= day <= days[1] or slot not in window.get("slots", []):
                        self._error(issues, location, "entry event must be scheduled at the campaign initial time")
                    if entry_event.get("requires", {}).get("events"):
                        self._error(issues, location, "entry event cannot require earlier events")
                    if not conditions_match(initial_state, entry_event.get("requires", {}).get("conditions", [])):
                        self._error(issues, location, "entry event conditions do not match the campaign initial state")
                    scene_id = entry_event.get("scene")
                    if scene_id and not can_enter_scene(self, initial_state, scene_id)["allowed"]:
                        self._error(issues, location, "entry event scene is not reachable from the campaign initial state")

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
        event_types = set(self.manifest.get("enums", {}).get("event_type", []))
        availability_values = set(self.manifest.get("enums", {}).get("event_availability", []))
        completion_values = set(self.manifest.get("enums", {}).get("event_completion", []))
        for event_id, event in self.events.items():
            location = relative_source(event.get("_source", event_id))
            for key in ("campaign_id", "title", "type", "lane", "window", "duration", "priority", "availability", "presentation"):
                if key not in event:
                    self._error(issues, location, f"required key is missing: {key}")
            campaign_id = event.get("campaign_id")
            campaign = self.campaigns.get(campaign_id)
            if campaign is None:
                self._error(issues, location, f"unknown event campaign: {campaign_id}")
                campaign = {}
            total_days = campaign.get("total_days", 0)
            valid_slots = set(campaign.get("slots", []))
            valid_lanes = {lane.get("id") for lane in campaign.get("lanes", []) if isinstance(lane, dict)}
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
            elif scene_id:
                route_id = self.scenes[scene_id].get("route")
                if self.routes.get(route_id, {}).get("campaign_id") != campaign_id:
                    self._error(issues, location, f"event scene belongs to another campaign: {scene_id}")
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
                event_conditions = requires.get("conditions", [])
                self._validate_conditions(
                    issues,
                    f"{location}#requires",
                    event_conditions,
                    None,
                    allow_self_development_stats=True,
                )
                stat_gated = isinstance(event_conditions, list) and any(
                    isinstance(condition, dict)
                    and isinstance(condition.get("path"), str)
                    and condition["path"].startswith(f"{SELF_DEVELOPMENT_STATE_PREFIX}.stats.")
                    for condition in event_conditions
                )
                if stat_gated and event.get("availability") != "player":
                    self._error(issues, location, "self-development stat-gated events must use player availability")
                if stat_gated and event.get("type") not in {"heroine", "company"}:
                    self._error(issues, location, "self-development stats may gate only additive heroine or company events")
                missed = event.get("on_missed", {})
                if stat_gated and (
                    missed.get("effects")
                    or missed.get("trigger_event")
                ):
                    self._error(issues, location, "missing a self-development stat-gated event cannot cause effects or trigger another event")
                if stat_gated:
                    gallery_entries = self.manifest.get("gallery", {}).get("entries", [])
                    gallery_by_memory = {
                        entry.get("unlock_memory"): entry
                        for entry in gallery_entries
                        if isinstance(entry, dict) and isinstance(entry.get("unlock_memory"), str)
                    }
                    awarded_memories = [
                        effect.get("value")
                        for effect in event.get("on_seen", {}).get("effects", [])
                        if isinstance(effect, dict)
                        and effect.get("path") == "progress.memories"
                        and effect.get("op") == "append_unique"
                        and effect.get("value") in gallery_by_memory
                    ]
                    if not awarded_memories:
                        self._error(issues, location, "self-development stat-gated events must award a registered gallery memory")
                    gated_stats = {
                        condition.get("path", "").rsplit(".", 1)[-1]
                        for condition in event_conditions
                        if isinstance(condition, dict)
                        and isinstance(condition.get("path"), str)
                        and condition["path"].startswith(f"{SELF_DEVELOPMENT_STATE_PREFIX}.stats.")
                    }
                    for memory in awarded_memories:
                        source_stat = gallery_by_memory[memory].get("source_stat")
                        if source_stat not in gated_stats:
                            self._error(issues, location, f"gallery memory {memory} does not match the event's gated stat")
                for required_id in requires.get("events", []):
                    if required_id not in self.events:
                        self._error(issues, location, f"unknown required event: {required_id}")
                    elif self.events[required_id].get("campaign_id") != campaign_id:
                        self._error(issues, location, f"required event belongs to another campaign: {required_id}")
            self._validate_event_effects(issues, f"{location}#on_seen", event.get("on_seen", {}).get("effects", []))
            missed = event.get("on_missed", {})
            self._validate_event_effects(issues, f"{location}#on_missed", missed.get("effects", []))
            trigger_id = missed.get("trigger_event")
            if trigger_id and trigger_id not in self.events:
                self._error(issues, location, f"unknown on_missed trigger event: {trigger_id}")
            elif trigger_id and self.events[trigger_id].get("campaign_id") != campaign_id:
                self._error(issues, location, f"on_missed trigger belongs to another campaign: {trigger_id}")
            presentation = event.get("presentation", {})
            if not isinstance(presentation, dict) or not presentation.get("title") or not presentation.get("summary"):
                self._error(issues, location, "presentation requires title and summary")

    def _validate_threads(self, issues: List[Issue]) -> None:
        for thread_id, thread in self.threads.items():
            location = relative_source(thread.get("_source", thread_id))
            for key in ("campaign_id", "title", "lane", "events"):
                if key not in thread:
                    self._error(issues, location, f"required key is missing: {key}")
            campaign_id = thread.get("campaign_id")
            campaign = self.campaigns.get(campaign_id)
            if campaign is None:
                self._error(issues, location, f"unknown thread campaign: {campaign_id}")
            elif thread.get("lane") not in {lane.get("id") for lane in campaign.get("lanes", []) if isinstance(lane, dict)}:
                self._error(issues, location, f"thread lane does not belong to campaign: {thread.get('lane')}")
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
                elif self.events[event_id].get("campaign_id") != campaign_id:
                    self._error(issues, location, f"thread event belongs to another campaign: {event_id}")

    def _validate_meta(self, issues: List[Issue]) -> None:
        for meta_id, meta in self.meta.items():
            location = relative_source(meta.get("_source", meta_id))
            rules = meta.get("unlock_rules")
            if not isinstance(rules, list):
                self._error(issues, location, "unlock_rules must be a list")
                continue
            if rules:
                self._error(issues, location, "unlock_rules is retired; define game mode access in story/game_modes.yaml")
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
                        elif reveal.get("mode") not in self.game_modes:
                            self._error(issues, teaser_location, f"teaser references unknown game mode: {reveal.get('mode')}")
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
            preferences = character.get("interaction_preferences")
            if preferences is not None:
                preferences_location = f"{location}#interaction_preferences"
                if not isinstance(preferences, dict):
                    self._error(issues, preferences_location, "interaction_preferences must be a mapping")
                else:
                    allowed_preference_keys = {
                        "authoring_shorthand",
                        "support_order",
                        "prefers",
                        "resists",
                        "context_overrides",
                    }
                    for key in sorted(set(preferences) - allowed_preference_keys):
                        self._error(issues, preferences_location, f"unknown interaction_preferences key: {key}")
                    for key in ("support_order", "prefers", "resists", "context_overrides"):
                        if key not in preferences:
                            self._error(issues, preferences_location, f"required key is missing: {key}")
                    shorthand = preferences.get("authoring_shorthand")
                    if shorthand is not None and (not isinstance(shorthand, str) or not shorthand):
                        self._error(issues, preferences_location, "authoring_shorthand must be a non-empty string")
                    support_order = preferences.get("support_order")
                    if not isinstance(support_order, list) or len(support_order) < 2:
                        self._error(issues, preferences_location, "support_order must contain at least two styles")
                    else:
                        malformed_styles = [
                            index for index, style in enumerate(support_order)
                            if not isinstance(style, str) or not style
                        ]
                        for style_index in malformed_styles:
                            self._error(
                                issues,
                                f"{preferences_location}.support_order[{style_index}]",
                                "support style must be a non-empty string",
                            )
                        if not malformed_styles:
                            unknown_styles = sorted(set(support_order) - VALID_SUPPORT_STYLES)
                            if unknown_styles:
                                self._error(
                                    issues,
                                    preferences_location,
                                    f"unknown support style: {', '.join(unknown_styles)}",
                                )
                            if len(support_order) != len(set(support_order)):
                                self._error(issues, preferences_location, "support_order styles must be unique")
                    for key in ("prefers", "resists", "context_overrides"):
                        values = preferences.get(key)
                        if not isinstance(values, list):
                            self._error(issues, preferences_location, f"{key} must be a list")
                            continue
                        for value_index, value in enumerate(values):
                            if not isinstance(value, str) or not value:
                                self._error(
                                    issues,
                                    f"{preferences_location}.{key}[{value_index}]",
                                    f"{key} entries must be non-empty strings",
                                )
            expressions = character.get("expressions", {})
            if not isinstance(expressions, dict):
                self._error(issues, location, "expressions must be a mapping")
                continue
            for expression_id, expression in expressions.items():
                exp_location = f"{location}#expressions.{expression_id}"
                if not self.id_is_valid(expression_id):
                    self._error(issues, exp_location, "invalid expression id")
                for key in ("emotion", "description"):
                    if not expression.get(key):
                        self._error(issues, exp_location, f"required key is missing: {key}")
            for index, rule in enumerate(character.get("emotion_rules", [])):
                rule_location = f"{location}#emotion_rules[{index}]"
                expression_id = rule.get("default_expression")
                if expression_id not in expressions:
                    self._error(issues, rule_location, f"unknown default_expression: {expression_id}")
                self._validate_relative_conditions(issues, rule_location, rule.get("conditions", []))
            for index, rule in enumerate(character.get("reporting_rules", [])):
                self._validate_relative_conditions(issues, f"{location}#reporting_rules[{index}]", rule.get("conditions", []))

    def _validate_locales(self, issues: List[Issue], profile: str = "development") -> None:
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
        ui_strings = self.ui.get("strings")
        if self.ui.get("id") != "game_ui":
            self._error(issues, relative_source(self.ui.get("_source", "story/ui.yaml")), "UI document id must be game_ui")
        if not isinstance(ui_strings, dict) or not ui_strings:
            self._error(issues, relative_source(self.ui.get("_source", "story/ui.yaml")), "UI strings must be a non-empty mapping")
        try:
            entries = collect_localizable_entries(self)
        except RuntimeError as error:
            self._error(issues, "story/localization", str(error))
            return
        for key, entry in entries.items():
            if is_player_narrative_entry(entry) and not narrative_entry_has_direct_editor_target(entry):
                document = entry.get("sourceDocument", {})
                self._error(
                    issues,
                    "story/authoring-coverage",
                    f"player narrative has no direct editor target: {key} -> {document.get('kind')}:{document.get('fieldPath')}",
                )
        ui_keys = set(self.ui.get("strings", {}))
        forbidden_ui = sorted(ui_keys & FORBIDDEN_UI_NARRATIVE_KEYS)
        forbidden_ui.extend(sorted(key for key in ui_keys if ".reflection." in key))
        for key in forbidden_ui:
            self._error(issues, "story/authoring-coverage", f"player narrative must not be owned by ui.yaml: {key}")
        if "conversation_topics" in self.manifest.get("self_development", {}):
            self._error(issues, "story/authoring-coverage", "manifest must not own composable player prose")
        quality = self.manifest.get("localization_quality", {})
        profile_rules = quality.get("profiles", {}).get(profile)
        if not isinstance(profile_rules, dict):
            self._error(issues, "story/manifest.yaml#localization_quality", f"unknown localization profile: {profile}")
            profile_rules = {}
        required_accessibility = quality.get("required_accessibility_keys", [])
        for key in required_accessibility:
            if key not in entries or entries[key].get("domain") != "ui":
                self._error(issues, "story/ui.yaml", f"required accessibility UI key is missing: {key}")
        for locale_id, locale in self.locales.items():
            location = relative_source(locale.get("_source", locale_id))
            filename_id = Path(str(locale.get("_source", ""))).stem
            if locale.get("id") != filename_id:
                self._error(issues, location, f"locale id must match filename: expected {filename_id!r}")
            if not re.fullmatch(r"^[a-z][a-z0-9_-]*$", locale_id):
                self._error(issues, location, f"invalid locale id: {locale_id}")
            if not locale.get("name"):
                self._error(issues, location, "locale name is required")
            if not locale.get("native_name"):
                self._error(issues, location, "locale native_name is required")
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
                    continue
                entry = entries.get(key)
                if entry is None:
                    self._error(issues, f"{location}#strings.{key}", "orphan translation key is not registered by any source document")
                    continue
                expected = set(entry["placeholders"])
                actual = placeholders(value)
                if actual != expected:
                    self._error(
                        issues,
                        f"{location}#strings.{key}",
                        f"placeholder mismatch: expected {sorted(expected)}, got {sorted(actual)}",
                    )
                if value == entry["source"] and profile_rules.get("identical_translation") == "warning":
                    self._warning(issues, f"{location}#strings.{key}", "translation is identical to source")
                maximum = entry.get("maxLength")
                if isinstance(maximum, int) and len(value) > maximum and profile_rules.get("maximum_length") == "warning":
                    self._warning(issues, f"{location}#strings.{key}", f"translation exceeds recommended length {maximum}")

        for locale_id in self.locales:
            seen: Set[str] = set()
            current: Optional[str] = locale_id
            while current is not None:
                if current in seen:
                    self._error(issues, "story/locales", f"cyclic locale fallback: {locale_id}")
                    break
                seen.add(current)
                current = self.locales.get(current, {}).get("fallback")

        bundle = self.localization_bundle()
        missing_rule = profile_rules.get("missing_translation")
        for locale_id, coverage in bundle["coverage"].items():
            if locale_id == default:
                continue
            for key in coverage["missing"]:
                if missing_rule == "warning":
                    self._warning(issues, f"story/locales/{locale_id}.yaml", f"translation uses fallback: {key}")
                elif missing_rule == "error":
                    self._error(issues, f"story/locales/{locale_id}.yaml", f"translation uses fallback: {key}")
        required_locales = profile_rules.get("required_locales", {})
        for locale_id, locale_rules in required_locales.items():
            coverage = bundle["coverage"].get(locale_id)
            if coverage is None:
                self._error(issues, "story/manifest.yaml#localization_quality", f"release locale is not supported: {locale_id}")
                continue
            minimum = float(locale_rules.get("minimum_direct_ratio", 0))
            for domain in locale_rules.get("required_domains", []):
                domain_coverage = coverage["by_domain"].get(domain, {"direct": 0, "total": 0})
                ratio = domain_coverage["direct"] / domain_coverage["total"] if domain_coverage["total"] else 1.0
                if ratio < minimum:
                    self._error(
                        issues,
                        f"story/locales/{locale_id}.yaml",
                        f"{domain} direct translation ratio {ratio:.4f} is below release minimum {minimum:.4f}",
                    )

        for visual_id, visual in self.visuals.items():
            title_key = visual.get("title_key")
            if isinstance(title_key, str) and title_key not in entries:
                self._error(
                    issues,
                    relative_source(visual.get("_source", visual_id)),
                    f"visual title_key is not registered: {title_key}",
                )

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
            if not visual.get("title") or not visual.get("title_key"):
                self._error(issues, location, "concrete visual requires title and title_key")
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
                    if not any(match.get(key) for key in ("locations", "times")):
                        self._error(issues, variant_location, "background variant needs at least one match dimension")
            elif visual.get("kind") == "character":
                character_id = visual.get("character")
                if character_id not in self.characters:
                    self._error(issues, location, f"unknown character visual target: {character_id}")
                    continue
                character_visuals.setdefault(character_id, []).append(visual_id)
                artworks = visual.get("artworks")
                if isinstance(artworks, Mapping) and artworks:
                    default_artwork = visual.get("default_artwork")
                    if default_artwork not in artworks:
                        self._error(issues, location, "default_artwork is not declared in artworks")
                    for artwork_id, artwork in artworks.items():
                        artwork_location = f"{location}#artworks.{artwork_id}"
                        if not isinstance(artwork, Mapping):
                            self._error(issues, artwork_location, "character artwork must be a mapping")
                            continue
                        asset = artwork.get("asset")
                        if not isinstance(asset, str) or not (PROJECT_ROOT / asset).is_file():
                            self._error(issues, artwork_location, f"character artwork asset does not exist: {asset}")
                        artwork_expressions = artwork.get("expression_assets", {})
                        if not isinstance(artwork_expressions, Mapping):
                            self._error(issues, artwork_location, "character artwork expression_assets must be a mapping")
                            artwork_expressions = {}
                        for expression_id, expression_asset in artwork_expressions.items():
                            if expression_id not in self.characters.get(character_id, {}).get("expressions", {}):
                                self._error(issues, artwork_location, f"unknown expression asset binding: {expression_id}")
                            if not isinstance(expression_asset, str) or not (PROJECT_ROOT / expression_asset).is_file():
                                self._error(issues, artwork_location, f"character expression asset does not exist: {expression_asset}")
                else:
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
                default_expression = visual.get("default_expression")
                if not isinstance(default_expression, str) or default_expression not in expressions:
                    self._error(issues, location, "default_expression must reference a declared character expression")
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
                variants = node.get("variants") if isinstance(node.get("variants"), list) else [None]
                for variant in variants:
                    candidate = node if variant is None else {**node, **variant}
                    variant_suffix = f".variants.{variant.get('id')}" if variant else ""
                    background = resolve_scene_background(resolved, scene, node_id, candidate)
                    if background is None:
                        location = relative_source(scene.get("_source", scene_id))
                        self._error(issues, f"{location}#nodes.{node_id}{variant_suffix}", "no background resolves")

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

    def _world_ref(
        self,
        issues: List[Issue],
        location: str,
        value: Any,
        expected_kind: str,
        field: str,
    ) -> Optional[Dict[str, Any]]:
        if not isinstance(value, str):
            self._error(issues, location, f"{field} must reference a {expected_kind} id")
            return None
        entity = self.world.get(value)
        if entity is None:
            self._error(issues, location, f"unknown {expected_kind} reference in {field}: {value}")
            return None
        if entity.get("kind") != expected_kind:
            self._error(
                issues,
                location,
                f"{field} must reference kind {expected_kind}, got {entity.get('kind')}: {value}",
            )
            return None
        return entity

    def _validate_unique_world_refs(
        self,
        issues: List[Issue],
        location: str,
        field: str,
        values: Any,
    ) -> List[str]:
        if not isinstance(values, list):
            self._error(issues, location, f"{field} must be a list")
            return []
        refs = [value for value in values if isinstance(value, str)]
        if len(refs) != len(values):
            self._error(issues, location, f"{field} entries must be ids")
        duplicates = sorted({value for value in refs if refs.count(value) > 1})
        for duplicate in duplicates:
            self._error(issues, location, f"duplicate id in {field}: {duplicate}")
        return refs

    def _validate_world(self, issues: List[Issue]) -> None:
        if not self.world:
            self._error(issues, "story/world", "at least one world entity is required")
            return

        valid_kinds = {"company", "role", "team", "member", "project", "meeting"}
        required_by_kind = {
            "company": {"name", "industry", "scale", "team_ids", "operating_facts", "authoring_constraints"},
            "role": {"company", "name", "rank", "people_manager", "can_approve", "can_lead_project", "description"},
            "team": {"company", "name", "function", "lead_member", "member_ids"},
            "member": {
                "company", "name", "display_name", "team", "role", "title", "manager", "employment",
                "presentation", "route_eligible", "responsibilities",
            },
            "project": {
                "company", "name", "project_type", "summary", "owner_team", "participating_teams",
                "sponsor_member", "lead_member", "deliverables", "assignments",
            },
            "meeting": {
                "company", "name", "formality", "minimum_participants", "maximum_participants",
                "minimum_text_only_participants", "required_teams", "required_responsibilities",
                "allowed_unassigned_participants",
            },
        }

        for entity_id, entity in self.world.items():
            location = relative_source(entity.get("_source", entity_id))
            kind = entity.get("kind")
            if not self.id_is_valid(entity_id):
                self._error(issues, location, f"invalid world entity id: {entity_id}")
            if kind not in valid_kinds:
                self._error(issues, location, f"unknown world entity kind: {kind}")
                continue
            if not entity_id.startswith(f"{kind}."):
                self._error(issues, location, f"{kind} id must start with {kind}.: {entity_id}")
            for key in sorted(required_by_kind[kind]):
                if key not in entity:
                    self._error(issues, location, f"required {kind} key is missing: {key}")

        companies = {entity_id: entity for entity_id, entity in self.world.items() if entity.get("kind") == "company"}
        roles = {entity_id: entity for entity_id, entity in self.world.items() if entity.get("kind") == "role"}
        teams = {entity_id: entity for entity_id, entity in self.world.items() if entity.get("kind") == "team"}
        members = {entity_id: entity for entity_id, entity in self.world.items() if entity.get("kind") == "member"}
        projects = {entity_id: entity for entity_id, entity in self.world.items() if entity.get("kind") == "project"}
        meetings = {entity_id: entity for entity_id, entity in self.world.items() if entity.get("kind") == "meeting"}

        for company_id, company in companies.items():
            location = relative_source(company.get("_source", company_id))
            team_ids = self._validate_unique_world_refs(issues, location, "team_ids", company.get("team_ids"))
            for team_id in team_ids:
                team = self._world_ref(issues, location, team_id, "team", "team_ids")
                if team and team.get("company") != company_id:
                    self._error(issues, location, f"team {team_id} belongs to {team.get('company')}, not {company_id}")
            actual_teams = {team_id for team_id, team in teams.items() if team.get("company") == company_id}
            missing_teams = sorted(actual_teams - set(team_ids))
            extra_teams = sorted(set(team_ids) - actual_teams)
            if missing_teams:
                self._error(issues, location, f"company team_ids omits teams: {missing_teams}")
            if extra_teams:
                self._error(issues, location, f"company team_ids includes foreign teams: {extra_teams}")

        for role_id, role in roles.items():
            location = relative_source(role.get("_source", role_id))
            self._world_ref(issues, location, role.get("company"), "company", "company")
            rank = role.get("rank")
            if not isinstance(rank, int) or isinstance(rank, bool) or not 0 <= rank <= 100:
                self._error(issues, location, "role rank must be an integer from 0 to 100")
            for flag in ("people_manager", "can_approve", "can_lead_project"):
                if not isinstance(role.get(flag), bool):
                    self._error(issues, location, f"{flag} must be boolean")

        for team_id, team in teams.items():
            location = relative_source(team.get("_source", team_id))
            company = self._world_ref(issues, location, team.get("company"), "company", "company")
            member_ids = self._validate_unique_world_refs(issues, location, "member_ids", team.get("member_ids"))
            lead = self._world_ref(issues, location, team.get("lead_member"), "member", "lead_member")
            if lead and lead.get("team") != team_id:
                self._error(issues, location, f"lead member {team.get('lead_member')} does not belong to {team_id}")
            if team.get("lead_member") not in member_ids:
                self._error(issues, location, "lead_member must also appear in member_ids")
            if lead:
                lead_role = roles.get(lead.get("role"))
                if not lead_role or lead_role.get("people_manager") is not True:
                    self._error(issues, location, f"lead member {team.get('lead_member')} lacks people-manager authority")
            for member_id in member_ids:
                member = self._world_ref(issues, location, member_id, "member", "member_ids")
                if member and member.get("team") != team_id:
                    self._error(issues, location, f"member {member_id} declares team {member.get('team')}, not {team_id}")
                if company and member and member.get("company") != team.get("company"):
                    self._error(issues, location, f"member {member_id} belongs to a different company")

        story_character_members: Dict[str, str] = {}
        for member_id, member in members.items():
            location = relative_source(member.get("_source", member_id))
            company = self._world_ref(issues, location, member.get("company"), "company", "company")
            team = self._world_ref(issues, location, member.get("team"), "team", "team")
            role = self._world_ref(issues, location, member.get("role"), "role", "role")
            if company and team and team.get("company") != member.get("company"):
                self._error(issues, location, f"team {member.get('team')} belongs to a different company")
            if company and role and role.get("company") != member.get("company"):
                self._error(issues, location, f"role {member.get('role')} belongs to a different company")
            if team and member_id not in team.get("member_ids", []):
                self._error(issues, location, f"member is missing from reciprocal team.member_ids: {member.get('team')}")

            manager_id = member.get("manager")
            if manager_id is not None:
                manager = self._world_ref(issues, location, manager_id, "member", "manager")
                if manager:
                    if manager.get("company") != member.get("company"):
                        self._error(issues, location, f"manager {manager_id} belongs to a different company")
                    if team and member_id != team.get("lead_member") and manager.get("team") != member.get("team"):
                        self._error(issues, location, f"manager {manager_id} is outside member team {member.get('team')}")
                    manager_role = roles.get(manager.get("role"), {})
                    if manager_role.get("people_manager") is not True:
                        self._error(issues, location, f"manager {manager_id} lacks people-manager authority")
                    if role and isinstance(role.get("rank"), int) and manager_role.get("rank", -1) <= role.get("rank"):
                        self._error(issues, location, f"manager {manager_id} must have a higher role rank")

            presentation = member.get("presentation")
            story_character = member.get("story_character")
            route_eligible = member.get("route_eligible")
            if presentation not in {"illustrated", "text_only"}:
                self._error(issues, location, f"invalid member presentation: {presentation}")
            elif presentation == "illustrated":
                if story_character not in self.characters:
                    self._error(issues, location, f"illustrated member requires a known story_character: {story_character}")
                elif story_character in story_character_members:
                    self._error(
                        issues,
                        location,
                        f"story_character {story_character} is already linked by {story_character_members[story_character]}",
                    )
                else:
                    story_character_members[story_character] = member_id
            else:
                if story_character is not None:
                    self._error(issues, location, "text_only member must not declare story_character")
                if route_eligible is not False:
                    self._error(issues, location, "text_only member cannot be route_eligible")
            if not isinstance(route_eligible, bool):
                self._error(issues, location, "route_eligible must be boolean")
            if route_eligible is True and story_character in self.characters:
                if presentation != "illustrated":
                    self._error(issues, location, "route_eligible member must be illustrated")
                if self.characters[story_character].get("narrative_role") != "main_heroine":
                    self._error(issues, location, "route_eligible member must link to a main_heroine")

        for member_id in members:
            location = relative_source(members[member_id].get("_source", member_id))
            chain: List[str] = []
            current: Optional[str] = member_id
            while current is not None and current in members:
                if current in chain:
                    cycle = chain[chain.index(current):] + [current]
                    self._error(issues, location, f"cyclic reporting line: {' -> '.join(cycle)}")
                    break
                chain.append(current)
                current = members[current].get("manager")

        route_heroines = {route.get("heroine") for route in self.routes.values() if route.get("heroine")}
        for heroine_id in sorted(route_heroines):
            member_id = story_character_members.get(heroine_id)
            if not member_id:
                self._error(issues, "story/world", f"route heroine has no illustrated world member: {heroine_id}")
            elif members[member_id].get("route_eligible") is not True:
                location = relative_source(members[member_id].get("_source", member_id))
                self._error(issues, location, f"route heroine member must be route_eligible: {heroine_id}")
        for character_id, member_id in story_character_members.items():
            if members[member_id].get("route_eligible") is True and character_id not in route_heroines:
                location = relative_source(members[member_id].get("_source", member_id))
                self._error(issues, location, f"route_eligible member is not used by any route: {member_id}")

        for project_id, project in projects.items():
            location = relative_source(project.get("_source", project_id))
            self._world_ref(issues, location, project.get("company"), "company", "company")
            owner = self._world_ref(issues, location, project.get("owner_team"), "team", "owner_team")
            participating = self._validate_unique_world_refs(
                issues, location, "participating_teams", project.get("participating_teams")
            )
            for team_id in participating:
                team = self._world_ref(issues, location, team_id, "team", "participating_teams")
                if team and team.get("company") != project.get("company"):
                    self._error(issues, location, f"participating team {team_id} belongs to a different company")
            if project.get("owner_team") not in participating:
                self._error(issues, location, "owner_team must be included in participating_teams")
            if owner and owner.get("company") != project.get("company"):
                self._error(issues, location, "owner_team belongs to a different company")
            sponsor = self._world_ref(issues, location, project.get("sponsor_member"), "member", "sponsor_member")
            lead = self._world_ref(issues, location, project.get("lead_member"), "member", "lead_member")
            for field, member in (("sponsor_member", sponsor), ("lead_member", lead)):
                if member and member.get("company") != project.get("company"):
                    self._error(issues, location, f"{field} belongs to a different company")
            if lead:
                lead_role = roles.get(lead.get("role"), {})
                if lead_role.get("can_lead_project") is not True:
                    self._error(issues, location, f"lead_member {project.get('lead_member')} cannot lead projects")
                if lead.get("team") not in participating:
                    self._error(issues, location, "lead_member team is not a participating team")

            deliverables = project.get("deliverables")
            if not isinstance(deliverables, list) or not deliverables:
                self._error(issues, location, "project deliverables must be a non-empty list")
            else:
                deliverable_ids = [item.get("id") for item in deliverables if isinstance(item, dict)]
                for duplicate in sorted({
                    item for item in deliverable_ids
                    if isinstance(item, str) and deliverable_ids.count(item) > 1
                }):
                    self._error(issues, location, f"duplicate id in deliverables: {duplicate}")
                for index, deliverable in enumerate(deliverables):
                    item_location = f"{location}#deliverables[{index}]"
                    if not isinstance(deliverable, dict):
                        self._error(issues, item_location, "deliverable must be a mapping")
                        continue
                    team = self._world_ref(issues, item_location, deliverable.get("owner_team"), "team", "owner_team")
                    role = self._world_ref(issues, item_location, deliverable.get("approver_role"), "role", "approver_role")
                    if team and team.get("id") not in participating:
                        self._error(issues, item_location, "deliverable owner_team is not a participating team")
                    if role and role.get("company") != project.get("company"):
                        self._error(issues, item_location, "deliverable approver_role belongs to a different company")

            assignments = project.get("assignments")
            if not isinstance(assignments, list) or not assignments:
                self._error(issues, location, "project assignments must be a non-empty list")
            else:
                responsibilities: List[Any] = []
                assigned_members: List[Any] = []
                for index, assignment in enumerate(assignments):
                    item_location = f"{location}#assignments[{index}]"
                    if not isinstance(assignment, dict):
                        self._error(issues, item_location, "assignment must be a mapping")
                        continue
                    responsibility = assignment.get("responsibility")
                    member_id = assignment.get("member")
                    if not isinstance(responsibility, str) or not responsibility:
                        self._error(issues, item_location, "assignment responsibility is required")
                    responsibilities.append(responsibility)
                    assigned_members.append(member_id)
                    member = self._world_ref(issues, item_location, member_id, "member", "member")
                    if member:
                        if member.get("company") != project.get("company"):
                            self._error(issues, item_location, "assigned member belongs to a different company")
                        if member.get("team") not in participating:
                            self._error(issues, item_location, "assigned member team is not a participating team")
                for duplicate in sorted({item for item in responsibilities if responsibilities.count(item) > 1 and item}):
                    self._error(issues, location, f"duplicate project responsibility: {duplicate}")
                for duplicate in sorted({item for item in assigned_members if assigned_members.count(item) > 1 and item}):
                    self._error(issues, location, f"member has duplicate project assignments: {duplicate}")
                if project.get("lead_member") not in assigned_members:
                    self._error(issues, location, "lead_member must have a project assignment")

        for meeting_id, meeting in meetings.items():
            location = relative_source(meeting.get("_source", meeting_id))
            self._world_ref(issues, location, meeting.get("company"), "company", "company")
            minimum = meeting.get("minimum_participants")
            maximum = meeting.get("maximum_participants")
            minimum_text = meeting.get("minimum_text_only_participants")
            if not isinstance(minimum, int) or isinstance(minimum, bool) or minimum < 1:
                self._error(issues, location, "minimum_participants must be a positive integer")
            if not isinstance(maximum, int) or isinstance(maximum, bool) or maximum < 1:
                self._error(issues, location, "maximum_participants must be a positive integer")
            if isinstance(minimum, int) and isinstance(maximum, int) and maximum < minimum:
                self._error(issues, location, "maximum_participants must be at least minimum_participants")
            if not isinstance(minimum_text, int) or isinstance(minimum_text, bool) or minimum_text < 0:
                self._error(issues, location, "minimum_text_only_participants must be a non-negative integer")
            required_teams = self._validate_unique_world_refs(
                issues, location, "required_teams", meeting.get("required_teams")
            )
            for team_id in required_teams:
                team = self._world_ref(issues, location, team_id, "team", "required_teams")
                if team and team.get("company") != meeting.get("company"):
                    self._error(issues, location, f"required team {team_id} belongs to a different company")
            self._validate_unique_world_refs(
                issues, location, "required_responsibilities", meeting.get("required_responsibilities")
            )

    @staticmethod
    def _scene_requires_world_context(scene: Mapping[str, Any]) -> bool:
        if scene.get("world_context") is not None:
            return False
        location = str(scene.get("location", ""))
        if "meeting_room" not in location:
            return False
        searchable = " ".join(str(scene.get(key, "")) for key in ("id", "title", "purpose")).lower()
        formal_hints = ("킥오프", "정기 회의", "승인 회의", "최종 발표", "다부서", "kickoff", "cross_function")
        return len(scene.get("cast", [])) >= 4 or any(hint in searchable for hint in formal_hints)

    def _validate_scene_world_contexts(self, issues: List[Issue]) -> None:
        members = {entity_id: entity for entity_id, entity in self.world.items() if entity.get("kind") == "member"}
        character_members = {
            member.get("story_character"): member_id
            for member_id, member in members.items()
            if member.get("story_character")
        }
        for scene_id, scene in self.scenes.items():
            location = relative_source(scene.get("_source", scene_id))
            context = scene.get("world_context")
            if context is None:
                if self._scene_requires_world_context(scene):
                    self._error(
                        issues,
                        location,
                        "formal or cross-functional meeting requires world_context",
                    )
                continue
            if not isinstance(context, dict):
                self._error(issues, location, "world_context must be a mapping")
                continue
            allowed_keys = {"company", "project", "interaction", "participants"}
            for key in sorted(set(context) - allowed_keys):
                self._error(issues, location, f"unknown world_context key: {key}")
            for key in sorted(allowed_keys - set(context)):
                self._error(issues, location, f"required world_context key is missing: {key}")

            company = self._world_ref(issues, location, context.get("company"), "company", "world_context.company")
            project = self._world_ref(issues, location, context.get("project"), "project", "world_context.project")
            meeting = self._world_ref(issues, location, context.get("interaction"), "meeting", "world_context.interaction")
            participant_ids = self._validate_unique_world_refs(
                issues, location, "world_context.participants", context.get("participants")
            )
            participant_entities: Dict[str, Dict[str, Any]] = {}
            for participant_id in participant_ids:
                member = self._world_ref(
                    issues, location, participant_id, "member", "world_context.participants"
                )
                if member:
                    participant_entities[participant_id] = member

            company_id = context.get("company")
            if project and project.get("company") != company_id:
                self._error(issues, location, "world_context project belongs to a different company")
            if meeting and meeting.get("company") != company_id:
                self._error(issues, location, "world_context interaction belongs to a different company")
            for participant_id, participant in participant_entities.items():
                if participant.get("company") != company_id:
                    self._error(issues, location, f"participant {participant_id} belongs to a different company")

            if project and meeting:
                minimum = meeting.get("minimum_participants", 0)
                maximum = meeting.get("maximum_participants", 10**9)
                if isinstance(minimum, int) and len(participant_ids) < minimum:
                    self._error(issues, location, f"meeting requires at least {minimum} participants")
                if isinstance(maximum, int) and len(participant_ids) > maximum:
                    self._error(issues, location, f"meeting allows at most {maximum} participants")
                text_only_count = sum(
                    participant.get("presentation") == "text_only"
                    for participant in participant_entities.values()
                )
                minimum_text = meeting.get("minimum_text_only_participants", 0)
                if isinstance(minimum_text, int) and text_only_count < minimum_text:
                    self._error(
                        issues,
                        location,
                        f"meeting requires at least {minimum_text} text_only supporting coworkers",
                    )

                represented_teams = {participant.get("team") for participant in participant_entities.values()}
                missing_teams = sorted(set(meeting.get("required_teams", [])) - represented_teams)
                if missing_teams:
                    self._error(issues, location, f"meeting is missing required teams: {missing_teams}")

                assignments = {
                    assignment.get("responsibility"): assignment.get("member")
                    for assignment in project.get("assignments", [])
                    if isinstance(assignment, dict)
                }
                missing_responsibilities = []
                for responsibility in meeting.get("required_responsibilities", []):
                    assigned_member = assignments.get(responsibility)
                    if not assigned_member or assigned_member not in participant_ids:
                        missing_responsibilities.append(responsibility)
                if missing_responsibilities:
                    self._error(
                        issues,
                        location,
                        f"meeting is missing required project responsibilities: {sorted(missing_responsibilities)}",
                    )
                if meeting.get("allowed_unassigned_participants") is False:
                    assigned_members = set(assignments.values())
                    unassigned = sorted(set(participant_ids) - assigned_members)
                    if unassigned:
                        self._error(issues, location, f"meeting has participants not assigned to project: {unassigned}")

            cast = set(scene.get("cast", []))
            for character_id in cast:
                member_id = character_members.get(character_id)
                if member_id and member_id not in participant_ids:
                    self._error(
                        issues,
                        location,
                        f"illustrated cast member is absent from world_context.participants: {character_id}",
                    )
            for participant_id, participant in participant_entities.items():
                story_character = participant.get("story_character")
                if participant.get("presentation") == "illustrated" and story_character not in cast:
                    self._error(
                        issues,
                        location,
                        f"illustrated participant must appear in scene cast: {participant_id}",
                    )
                if participant.get("presentation") == "text_only" and participant_id in cast:
                    self._error(issues, location, f"text_only participant must not appear in illustrated cast: {participant_id}")

            for node in scene.get("nodes", []):
                speakers: Set[Any] = {node.get("speaker")}
                if isinstance(node.get("speakers"), dict):
                    speakers.update(node["speakers"].values())
                for speaker in speakers:
                    if isinstance(speaker, str) and speaker.startswith("member."):
                        if speaker not in participant_ids:
                            self._error(
                                issues,
                                f"{location}#nodes.{node.get('id')}",
                                f"world member speaker is not a declared participant: {speaker}",
                            )
                        elif members.get(speaker, {}).get("presentation") != "text_only":
                            self._error(
                                issues,
                                f"{location}#nodes.{node.get('id')}",
                                f"illustrated world member speaker must use story_character id: {speaker}",
                            )

    def _validate_routes(self, issues: List[Issue]) -> None:
        for route_id, route in self.routes.items():
            location = relative_source(route.get("_source", route_id))
            if not self.id_is_valid(route_id):
                self._error(issues, location, f"invalid route id: {route_id}")
            for key in ("title", "heroine", "campaign_id", "entry_scene", "scene_order", "endings"):
                if key not in route:
                    self._error(issues, location, f"required key is missing: {key}")
            campaign_id = route.get("campaign_id")
            if campaign_id not in self.campaigns:
                self._error(issues, location, f"unknown route campaign: {campaign_id}")
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
        resolved_visuals = self.resolve_visuals()
        for scene_id, scene in self.scenes.items():
            location = relative_source(scene.get("_source", scene_id))
            compiled_scene = self.compile_scene_dialogue(scene)
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
            default_background = scene.get("default_background")
            if default_background is not None:
                background_location = f"{location}#default_background"
                if not isinstance(default_background, Mapping):
                    self._error(issues, background_location, "default_background must be a mapping")
                else:
                    unknown_keys = sorted(set(default_background) - {"visual_id", "variant_id"})
                    for key in unknown_keys:
                        self._error(issues, background_location, f"unknown default_background key: {key}")
                    visual_id = default_background.get("visual_id")
                    variant_id = default_background.get("variant_id")
                    visual = resolved_visuals.get(visual_id) if isinstance(visual_id, str) else None
                    if not isinstance(visual, Mapping) or visual.get("kind") != "background" or visual.get("abstract"):
                        self._error(issues, background_location, f"unknown concrete background visual: {visual_id}")
                    elif not isinstance(variant_id, str) or variant_id not in visual.get("variants", {}):
                        self._error(issues, background_location, f"unknown background variant: {visual_id}.{variant_id}")

            contract = scene.get("state_contract", {})
            reads = set(contract.get("reads", [])) if isinstance(contract, dict) else set()
            writes = set(contract.get("writes", [])) if isinstance(contract, dict) else set()
            if not isinstance(contract, dict):
                self._error(issues, location, "state_contract must be a mapping")
            for path in sorted(reads | writes):
                if self.path_spec(path) is None:
                    self._error(issues, f"{location}#state_contract", f"undeclared state path: {path}")
            for path in sorted(writes):
                if path.startswith("derived."):
                    self._error(issues, f"{location}#state_contract", f"derived state is read-only: {path}")

            self._validate_conditions(issues, f"{location}#entry_conditions", scene.get("entry_conditions", []), reads)
            nodes = compiled_scene.get("nodes", [])
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
            self._validate_choice_interaction_contexts(issues, location, scene, node_map)
            self._validate_self_development_choice_equivalence(issues, location, node_map)
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
        self._validate_node_stage(issues, scene, node, location)
        analysis_hints = node.get("analysis_hints")
        if analysis_hints is not None:
            if kind != "choice":
                self._error(issues, location, "analysis_hints is only allowed on choice nodes")
            elif not isinstance(analysis_hints, dict) or set(analysis_hints) != {"pull", "push", "none"}:
                self._error(issues, location, "choice analysis_hints must contain exactly pull, push, and none")
            elif any(not isinstance(value, str) or not value.strip() for value in analysis_hints.values()):
                self._error(issues, location, "choice analysis_hints values must be non-empty strings")
        if kind == "silent":
            if "speaker" in node:
                self._error(issues, location, "silent node cannot declare a speaker")
            if "variants" in node:
                self._error(issues, location, "silent node cannot declare dialogue variants")
            if node.get("line") != "":
                self._error(issues, location, "silent line must be an explicit empty string")
            if "atmosphere" in node:
                self._error(issues, location, "removed dialogue field is forbidden: atmosphere")
            if not node.get("next"):
                self._error(issues, location, "silent node requires next")
        elif kind in {"dialogue", "narration"}:
            variants = node.get("variants")
            if variants is None:
                self._validate_presentation_node(issues, scene, node, location)
            elif not isinstance(variants, list) or not variants:
                self._error(issues, location, "variants must be a non-empty list")
            else:
                if "line" in node:
                    self._error(issues, location, "dialogue node must use either an inline line or variants, not both")
                variant_ids: Set[str] = set()
                condition_signatures: Dict[str, str] = {}
                defaults = 0
                for index, variant in enumerate(variants):
                    variant_location = f"{location}.variants[{index}]"
                    if not isinstance(variant, dict):
                        self._error(issues, variant_location, "variant must be a mapping")
                        continue
                    variant_id = variant.get("id")
                    if not self.id_is_valid(variant_id):
                        self._error(issues, variant_location, f"invalid variant id: {variant_id}")
                    if variant_id in variant_ids:
                        self._error(issues, variant_location, f"duplicate variant id: {variant_id}")
                    variant_ids.add(variant_id)
                    if variant.get("default") is True:
                        defaults += 1
                        if "self_development" in variant:
                            self._error(issues, variant_location, "default variant cannot require a self-development expression")
                    else:
                        self._validate_conditions(issues, variant_location, variant.get("conditions", []), reads)
                        signature = json.dumps(
                            {
                                "conditions": variant.get("conditions", []),
                                "self_development": variant.get("self_development"),
                            },
                            ensure_ascii=False,
                            sort_keys=True,
                        )
                        if signature in condition_signatures:
                            self._warning(
                                issues,
                                variant_location,
                                f"variant conditions duplicate {condition_signatures[signature]}; this variant may be unreachable",
                            )
                        else:
                            condition_signatures[signature] = str(variant_id)
                    if "self_development" in variant:
                        self._validate_self_development_use(
                            issues,
                            variant_location,
                            variant.get("self_development"),
                            kind="variant",
                            reads=reads,
                        )
                    variant_node = {**node, **variant}
                    self._validate_presentation_node(issues, scene, variant_node, variant_location)
                if defaults != 1:
                    self._error(issues, location, "variants require exactly one default")
            if not node.get("next"):
                self._error(issues, location, "dialogue or narration node requires next")
        elif kind == "choice":
            if not node.get("prompt"):
                self._error(issues, location, "choice prompt is required")
            if not node.get("stimulus"):
                self._error(issues, location, "choice stimulus is required")
            for field in ("prompt",):
                if contains_explicit_choice_direction(node.get(field)):
                    self._error(
                        issues,
                        location,
                        f"player-visible choice {field} must describe concrete words or actions, not explicit push/pull direction",
                    )
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
                if contains_explicit_choice_direction(option.get("label")):
                    self._error(
                        issues,
                        option_location,
                        "player-visible choice label must describe concrete speech or action, not explicit push/pull direction",
                    )
                push_pull = option.get("push_pull")
                if not isinstance(push_pull, dict):
                    self._error(issues, option_location, "push_pull mapping is required")
                else:
                    unknown_push_pull_keys = sorted(set(push_pull) - {"target", "action", "intensity", "base_score"})
                    if unknown_push_pull_keys:
                        self._error(
                            issues,
                            option_location,
                            f"unknown push_pull key: {', '.join(unknown_push_pull_keys)}",
                        )
                    if push_pull.get("action") not in VALID_PUSH_PULL_ACTIONS:
                        self._error(issues, option_location, f"invalid push_pull action: {push_pull.get('action')}")
                    intensity = push_pull.get("intensity")
                    if not isinstance(intensity, int) or not 8 <= intensity <= 16:
                        self._error(issues, option_location, "push_pull intensity must be an integer from 8 to 16")
                    base_score = push_pull.get("base_score")
                    if not isinstance(base_score, int) or not 2 <= base_score <= 5:
                        self._error(issues, option_location, "push_pull base_score must be an integer from 2 to 5")
                    heroine = self.routes.get(scene.get("route"), {}).get("heroine")
                    if "target" in push_pull:
                        push_pull_target = push_pull.get("target")
                        if not self.id_is_valid(push_pull_target):
                            self._error(issues, option_location, "push_pull target must be a valid character id")
                        elif push_pull_target not in self.characters:
                            self._error(issues, option_location, f"unknown push_pull target: {push_pull_target}")
                        elif push_pull_target not in self.manifest.get("initial_state", {}).get("visible", {}).get("heroines", {}):
                            self._error(issues, option_location, f"push_pull target has no heroine state: {push_pull_target}")
                        else:
                            heroine = push_pull_target
                    if (
                        heroine in self.characters
                        and heroine in self.manifest.get("initial_state", {}).get("visible", {}).get("heroines", {})
                        and heroine not in scene.get("cast", [])
                    ):
                        self._error(issues, option_location, f"push_pull target is not in scene cast: {heroine}")
                    interaction = option.get("interaction")
                    if interaction is not None:
                        if not isinstance(interaction, dict):
                            self._error(issues, option_location, "interaction must be a mapping")
                        else:
                            unknown_interaction_keys = sorted(set(interaction) - {"target", "support_styles"})
                            if unknown_interaction_keys:
                                self._error(
                                    issues,
                                    option_location,
                                    f"unknown interaction key: {', '.join(unknown_interaction_keys)}",
                                )
                            target = interaction.get("target")
                            if not self.id_is_valid(target):
                                self._error(issues, option_location, "interaction target must be a valid character id")
                            elif target not in self.characters:
                                self._error(issues, option_location, f"unknown interaction target: {target}")
                            elif target not in scene.get("cast", []):
                                self._error(issues, option_location, f"interaction target is not in scene cast: {target}")
                            elif not isinstance(self.characters[target].get("interaction_preferences"), dict):
                                self._error(issues, option_location, f"interaction target has no interaction_preferences: {target}")
                            support_styles = interaction.get("support_styles")
                            if not isinstance(support_styles, list) or not support_styles:
                                self._error(issues, option_location, "interaction support_styles must be a non-empty list")
                            else:
                                malformed_styles = [
                                    index for index, style in enumerate(support_styles)
                                    if not isinstance(style, str) or not style
                                ]
                                for style_index in malformed_styles:
                                    self._error(
                                        issues,
                                        f"{option_location}#interaction.support_styles[{style_index}]",
                                        "interaction support style must be a non-empty string",
                                    )
                                if not malformed_styles:
                                    unknown_styles = sorted(set(support_styles) - VALID_SUPPORT_STYLES)
                                    if unknown_styles:
                                        self._error(
                                            issues,
                                            option_location,
                                            f"unknown interaction support style: {', '.join(unknown_styles)}",
                                        )
                                    if len(support_styles) != len(set(support_styles)):
                                        self._error(issues, option_location, "interaction support_styles must be unique")
                    system_paths = [
                        "progress.flags.push_pull",
                        f"visible.heroines.{heroine}.initiative",
                        f"hidden.heroines.{heroine}.suspicion",
                        f"hidden.heroines.{heroine}.dislike",
                        f"hidden.heroines.{heroine}.evidence_count",
                    ]
                    if "progress.flags.push_pull" not in reads:
                        self._error(issues, option_location, "push_pull state is not declared in state_contract.reads")
                    for path in system_paths:
                        if path not in writes:
                            self._error(issues, option_location, f"push_pull system path is not declared in state_contract.writes: {path}")
                    forbidden = {
                        f"visible.heroines.{character_id}.initiative"
                        for character_id in self.manifest.get("initial_state", {}).get("visible", {}).get("heroines", {})
                    }
                    for effect in option.get("effects", []):
                        if effect.get("path") in forbidden:
                            self._error(issues, option_location, f"push_pull choice must not manually write initiative: {effect.get('path')}")
                if "self_development" in option:
                    self._validate_self_development_use(
                        issues,
                        option_location,
                        option.get("self_development"),
                        kind="choice",
                        reads=reads,
                    )
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

    def _validate_node_stage(
        self,
        issues: List[Issue],
        scene: Mapping[str, Any],
        node: Mapping[str, Any],
        location: str,
    ) -> None:
        protagonist_reveal = can_reveal_protagonist_artwork(scene, node)
        has_reveal_flag = PROTAGONIST_ARTWORK_REVEAL_FLAG in node.get("presentation_flags", [])
        if has_reveal_flag and not protagonist_reveal:
            self._error(
                issues,
                location,
                "protagonist_art_reveal is allowed only on narration nodes in ending scenes",
            )
        stage = node.get("stage")
        if stage is None:
            if has_reveal_flag:
                self._error(issues, location, "protagonist_art_reveal requires an explicit stage cue")
            return
        if not isinstance(stage, list):
            self._error(issues, location, "stage must be a list")
            return
        visuals = self.resolve_visuals()
        reveal_present = False
        if len(stage) > 3:
            self._error(issues, location, "stage allows at most three character artworks")
        positions: Set[str] = set()
        characters: Set[str] = set()
        for index, cue in enumerate(stage):
            item_location = f"{location}.stage[{index}]"
            if not isinstance(cue, Mapping):
                self._error(issues, item_location, "stage cue must be a mapping")
                continue
            for unknown in sorted(set(cue) - {"position", "character", "visual_id", "artwork"}):
                self._error(issues, item_location, f"unknown stage cue property: {unknown}")
            for required in ("position", "character", "visual_id", "artwork"):
                if not isinstance(cue.get(required), str) or not cue.get(required):
                    self._error(issues, item_location, f"stage cue requires {required}")
            if any(not isinstance(cue.get(required), str) or not cue.get(required)
                   for required in ("position", "character", "visual_id", "artwork")):
                continue
            position = cue.get("position")
            character_id = cue.get("character")
            visual_id = cue.get("visual_id")
            artwork = cue.get("artwork")
            if character_id == PROTAGONIST_ARTWORK_CHARACTER_ID:
                if not protagonist_reveal:
                    self._error(
                        issues,
                        item_location,
                        "Han Do-yoon artwork is reserved for an explicit ending reveal",
                    )
                else:
                    reveal_present = True
            if position not in {"left", "center", "right"}:
                self._error(issues, item_location, f"unknown stage position: {position}")
            elif position in positions:
                self._error(issues, item_location, f"duplicate stage position: {position}")
            else:
                positions.add(position)
            if character_id not in self.characters:
                self._error(issues, item_location, f"unknown stage character: {character_id}")
            elif character_id not in scene.get("cast", []):
                self._error(issues, item_location, f"stage character is not in scene cast: {character_id}")
            elif character_id in characters:
                self._error(issues, item_location, f"duplicate stage character: {character_id}")
            else:
                characters.add(character_id)
            visual = visuals.get(visual_id) if isinstance(visual_id, str) else None
            if not isinstance(visual, Mapping) or visual.get("kind") != "character" or visual.get("abstract"):
                self._error(issues, item_location, f"unknown concrete character visual: {visual_id}")
                continue
            if visual.get("character") != character_id:
                self._error(issues, item_location, "stage visual belongs to a different character")
            if artwork == "default":
                artworks = visual.get("artworks", {})
                if isinstance(artworks, Mapping) and artworks:
                    if visual.get("default_artwork") not in artworks:
                        self._error(issues, item_location, "default artwork is not declared")
                elif not visual.get("fallback_asset"):
                    self._error(issues, item_location, "default artwork requires a fallback asset")
                continue
            artworks = visual.get("artworks", {})
            if isinstance(artworks, Mapping) and artwork in artworks:
                continue
            expression_assets = visual.get("expression_assets", {})
            if not isinstance(expression_assets, Mapping) or artwork not in expression_assets:
                self._error(issues, item_location, f"unknown artwork id for stage visual: {artwork}")
        if protagonist_reveal and not reveal_present:
            self._error(issues, location, "protagonist_art_reveal must explicitly place Han Do-yoon artwork")
    def _validate_choice_interaction_contexts(
        self,
        issues: List[Issue],
        location: str,
        scene: Mapping[str, Any],
        node_map: Mapping[str, Mapping[str, Any]],
    ) -> None:
        """Validate whether and how each choice applies character interaction metadata."""
        for node_id, node in node_map.items():
            node_location = f"{location}#nodes.{node_id}"
            if node.get("kind") != "choice":
                if "interaction_context" in node:
                    self._error(
                        issues,
                        node_location,
                        "interaction_context is only allowed on choice nodes",
                    )
                continue

            context = node.get("interaction_context")
            if not isinstance(context, Mapping):
                self._error(
                    issues,
                    node_location,
                    "choice interaction_context must be a mapping containing exactly kind",
                )
                continue
            if set(context) != {"kind"}:
                self._error(
                    issues,
                    node_location,
                    "choice interaction_context must contain exactly the key: kind",
                )
            context_kind = context.get("kind")
            if (
                not isinstance(context_kind, str)
                or context_kind not in VALID_INTERACTION_CONTEXT_KINDS
            ):
                self._error(
                    issues,
                    node_location,
                    f"invalid interaction_context kind: {context_kind}",
                )
                continue

            options = node.get("options")
            if not isinstance(options, list):
                continue
            option_rows = [
                (index, option)
                for index, option in enumerate(options)
                if isinstance(option, Mapping)
            ]

            if context_kind in {"support", "coordination"}:
                ordered_style_signatures: Set[Tuple[str, ...]] = set()
                for option_index, option in option_rows:
                    option_location = f"{node_location}.options[{option_index}]"
                    interaction = option.get("interaction")
                    if not isinstance(interaction, Mapping):
                        self._error(
                            issues,
                            option_location,
                            f"{context_kind} choice options require interaction metadata",
                        )
                        continue
                    support_styles = interaction.get("support_styles")
                    if (
                        isinstance(support_styles, list)
                        and support_styles
                        and all(isinstance(style, str) and style for style in support_styles)
                    ):
                        ordered_style_signatures.add(tuple(support_styles))
                if len(ordered_style_signatures) < 2:
                    self._error(
                        issues,
                        node_location,
                        f"{context_kind} choices require at least two distinct ordered support style signatures",
                    )
                self._validate_distinct_interaction_responses(
                    issues,
                    node_location,
                    scene,
                    node_map,
                    option_rows,
                )
            elif context_kind == "boundary":
                has_literal_respect = any(
                    isinstance(option.get("interaction"), Mapping)
                    and isinstance(option["interaction"].get("support_styles"), list)
                    and "literal_respect" in option["interaction"]["support_styles"]
                    for _, option in option_rows
                )
                if not has_literal_respect:
                    self._error(
                        issues,
                        node_location,
                        "boundary choices require at least one literal_respect interaction option",
                    )
            elif context_kind == "not_applicable":
                for option_index, option in option_rows:
                    if "interaction" in option:
                        self._error(
                            issues,
                            f"{node_location}.options[{option_index}]",
                            "not_applicable choice options must not declare interaction metadata",
                        )

    def _validate_distinct_interaction_responses(
        self,
        issues: List[Issue],
        location: str,
        scene: Mapping[str, Any],
        node_map: Mapping[str, Mapping[str, Any]],
        option_rows: Sequence[Tuple[int, Mapping[str, Any]]],
    ) -> None:
        """Require different support orders for one target to produce different replies."""
        by_target: Dict[str, List[Tuple[int, Mapping[str, Any], Tuple[str, ...]]]] = {}
        cast = scene.get("cast", [])
        if not isinstance(cast, list):
            cast = []
        for option_index, option in option_rows:
            interaction = option.get("interaction")
            if not isinstance(interaction, Mapping):
                continue
            target = interaction.get("target")
            support_styles = interaction.get("support_styles")
            if (
                not isinstance(target, str)
                or target not in self.characters
                or target not in cast
                or not isinstance(support_styles, list)
                or not support_styles
                or not all(isinstance(style, str) and style for style in support_styles)
            ):
                continue
            by_target.setdefault(target, []).append(
                (option_index, option, tuple(support_styles))
            )

        for target, entries in by_target.items():
            if len({style_signature for _, _, style_signature in entries}) < 2:
                continue
            resolved: List[Tuple[int, Tuple[str, ...], Tuple[str, ...]]] = []
            for option_index, option, style_signature in entries:
                response_signature = self._find_interaction_response_signature(
                    node_map,
                    option.get("next"),
                    target,
                )
                option_location = f"{location}.options[{option_index}]"
                if response_signature is None:
                    self._error(
                        issues,
                        option_location,
                        f"interaction branch must reach a response from target: {target}",
                    )
                    continue
                for previous_index, previous_styles, previous_response in resolved:
                    if previous_styles != style_signature and previous_response == response_signature:
                        self._error(
                            issues,
                            option_location,
                            "different ordered support style signatures for the same target must lead to "
                            f"distinct responses: options[{previous_index}] and options[{option_index}] ({target})",
                        )
                        break
                resolved.append((option_index, style_signature, response_signature))

    @staticmethod
    def _find_interaction_response_signature(
        node_map: Mapping[str, Mapping[str, Any]],
        start: Any,
        target: str,
    ) -> Optional[Tuple[str, ...]]:
        current = start
        visited: Set[str] = set()
        while isinstance(current, str) and current in node_map and current not in visited:
            visited.add(current)
            node = node_map[current]
            kind = node.get("kind")
            if kind == "dialogue" and effective_speaker(node) == target:
                lines: Set[str] = set()
                line = node.get("line")
                if isinstance(line, str) and line:
                    lines.add(line)
                variants = node.get("variants")
                if isinstance(variants, list):
                    for variant in variants:
                        if not isinstance(variant, Mapping):
                            continue
                        line = variant.get("line")
                        if isinstance(line, str) and line:
                            lines.add(line)
                return tuple(sorted(lines)) if lines else None
            if kind in {"effect", "silent"}:
                current = node.get("next")
                continue
            if kind not in {"dialogue", "narration"}:
                return None
            current = node.get("next")
        return None

    def _validate_self_development_use(
        self,
        issues: List[Issue],
        location: str,
        value: Any,
        *,
        kind: str,
        reads: Set[str],
    ) -> None:
        if not isinstance(value, dict):
            self._error(issues, location, "self_development must be a mapping")
            return
        required = {"expression"} if kind == "variant" else {"expression", "equivalent_to", "converges_at"}
        missing = sorted(required - set(value))
        unknown = sorted(set(value) - required)
        for key in missing:
            self._error(issues, location, f"self_development.{key} is required")
        for key in unknown:
            self._error(issues, location, f"unknown self_development key: {key}")
        expression_id = value.get("expression")
        expressions = self.manifest.get("self_development", {}).get("expressions", {})
        if not isinstance(expression_id, str) or expression_id not in expressions:
            self._error(issues, location, f"unknown self-development expression: {expression_id}")
        else:
            expression = expressions[expression_id]
            requires = expression.get("requires", {}) if isinstance(expression, dict) else {}
            required_paths: List[str] = []
            if isinstance(requires, dict):
                if "appeal_gte" in requires:
                    required_paths.append(f"{SELF_DEVELOPMENT_STATE_PREFIX}.appeal")
                if isinstance(requires.get("stat"), str):
                    required_paths.append(f"{SELF_DEVELOPMENT_STATE_PREFIX}.stats.{requires['stat']}")
                if "fatigue_lte" in requires:
                    required_paths.append(f"{SELF_DEVELOPMENT_STATE_PREFIX}.fatigue")
                if "last_activity" in requires:
                    required_paths.append(f"{SELF_DEVELOPMENT_PROGRESS_PREFIX}.last_activity")
            for path in required_paths:
                if path not in reads:
                    self._error(
                        issues,
                        location,
                        f"self-development expression path is not declared in state_contract.reads: {path}",
                    )
        if kind == "choice":
            for key in ("equivalent_to", "converges_at"):
                if not self.id_is_valid(value.get(key)):
                    self._error(issues, location, f"invalid self_development.{key}: {value.get(key)}")

    def _validate_self_development_choice_equivalence(
        self,
        issues: List[Issue],
        location: str,
        node_map: Mapping[str, Mapping[str, Any]],
    ) -> None:
        for node_id, node in node_map.items():
            if node.get("kind") != "choice":
                continue
            options = node.get("options", [])
            option_map = {
                option.get("id"): option
                for option in options
                if isinstance(option, dict) and isinstance(option.get("id"), str)
            }
            for option in options:
                if not isinstance(option, dict) or "self_development" not in option:
                    continue
                option_location = f"{location}#nodes.{node_id}.options.{option.get('id')}"
                use = option.get("self_development")
                if not isinstance(use, dict):
                    continue
                equivalent_id = use.get("equivalent_to")
                equivalent = option_map.get(equivalent_id)
                if equivalent is None:
                    self._error(
                        issues,
                        option_location,
                        f"self_development.equivalent_to must reference an option in the same choice: {equivalent_id}",
                    )
                    continue
                if equivalent is option:
                    self._error(issues, option_location, "self-development option cannot be equivalent to itself")
                    continue
                if "self_development" in equivalent or equivalent.get("conditions", []) != []:
                    self._error(
                        issues,
                        option_location,
                        "self_development.equivalent_to must reference an unconditional base option",
                    )
                if option.get("push_pull") != equivalent.get("push_pull"):
                    self._error(issues, option_location, "self-development option push_pull must match equivalent base option")
                if option.get("effects", []) != equivalent.get("effects", []):
                    self._error(issues, option_location, "self-development option effects must match equivalent base option")

                convergence = use.get("converges_at")
                if convergence not in node_map:
                    self._error(
                        issues,
                        option_location,
                        f"unknown self_development.converges_at node: {convergence}",
                    )
                    continue
                option_next = option.get("next")
                equivalent_next = equivalent.get("next")
                self._validate_self_development_convergence_path(
                    issues,
                    option_location,
                    "self-development branch",
                    option_next,
                    convergence,
                    node_map,
                )
                self._validate_self_development_convergence_path(
                    issues,
                    option_location,
                    "equivalent base branch",
                    equivalent_next,
                    convergence,
                    node_map,
                )

    def _validate_self_development_convergence_path(
        self,
        issues: List[Issue],
        location: str,
        branch_label: str,
        start: Any,
        convergence: str,
        node_map: Mapping[str, Mapping[str, Any]],
    ) -> None:
        """Allow flavor dialogue only until both mechanically equivalent branches rejoin."""
        current = start
        visited: Set[str] = set()
        while current != convergence:
            if not isinstance(current, str) or current not in node_map:
                self._error(
                    issues,
                    location,
                    f"{branch_label} does not reach converges_at: {convergence}; unknown node: {current}",
                )
                return
            if current in visited:
                self._error(
                    issues,
                    location,
                    f"{branch_label} does not reach converges_at: {convergence}; cycle at {current}",
                )
                return
            visited.add(current)
            node = node_map[current]
            kind = node.get("kind")
            if kind not in {"dialogue", "narration", "silent"}:
                self._error(
                    issues,
                    location,
                    f"{branch_label} does not reach converges_at: {convergence}; path must contain only "
                    f"dialogue/narration before convergence; found {current} ({kind})",
                )
                return
            current = node.get("next")

    def _validate_speaker_reference(
        self,
        issues: List[Issue],
        scene: Mapping[str, Any],
        speaker: Any,
        location: str,
        *,
        require_cast: bool = True,
    ) -> Optional[str]:
        """Validate one effective speaker and return its presentation kind."""
        if not isinstance(speaker, str) or not speaker:
            self._error(issues, location, f"unknown speaker: {speaker}")
            return None
        if speaker in self.characters:
            if require_cast and speaker not in scene.get("cast", []):
                self._error(issues, location, f"speaker {speaker} is not in cast")
            return "illustrated"
        member = self.world.get(speaker)
        if member is None or member.get("kind") != "member":
            self._error(issues, location, f"unknown speaker: {speaker}")
            return None
        if member.get("presentation") != "text_only":
            self._error(
                issues,
                location,
                f"illustrated world member speaker must use story_character id: {speaker}",
            )
            return None
        if speaker in scene.get("cast", []):
            self._error(issues, location, f"text_only speaker must not appear in illustrated cast: {speaker}")
        return "text_only"

    def _validate_presentation_node(self, issues: List[Issue], scene: Mapping[str, Any], node: Mapping[str, Any], location: str) -> None:
        for legacy_field in ("perceived", "reality", "speakers", "inner_thought", "protagonist_interpretation", "atmosphere"):
            if legacy_field in node:
                self._error(issues, location, f"removed dialogue field is forbidden: {legacy_field}")
        if not isinstance(node.get("line"), str) or not node.get("line"):
            self._error(issues, location, "line is required")

        raw_flags = node.get("presentation_flags", [])
        if not isinstance(raw_flags, list):
            self._error(issues, location, "presentation_flags must be a list")
            flags: Set[str] = set()
        else:
            flags = {flag for flag in raw_flags if isinstance(flag, str)}
            if len(flags) != len(raw_flags):
                self._error(issues, location, "presentation_flags must contain unique string ids")
        valid_flags = set(self.manifest.get("enums", {}).get("presentation_flag", []))
        for flag in sorted(flags):
            if flag not in valid_flags:
                self._error(issues, location, f"unknown presentation flag: {flag}")

        if node.get("kind") == "narration":
            if "speaker" in node:
                self._error(issues, location, "narration must not declare a speaker")
            return

        if node.get("kind") != "dialogue":
            return
        speaker = effective_speaker(node)
        speaker_kind = self._validate_speaker_reference(issues, scene, speaker, location)
        expression_id = node.get("expression")
        if not expression_id:
            if speaker_kind == "illustrated":
                self._error(issues, location, f"expression is required for illustrated speaker {speaker}")
            return
        if speaker_kind != "illustrated" or speaker not in self.characters:
            self._error(issues, location, "expression requires an illustrated character speaker")
            return
        expressions = self.characters[speaker].get("expressions", {})
        if expression_id not in expressions:
            self._error(issues, location, f"unknown expression {expression_id} for {speaker}")

    def _validate_conditions(
        self,
        issues: List[Issue],
        location: str,
        conditions: Any,
        reads: Optional[Set[str]],
        allow_self_development_stats: bool = False,
    ) -> None:
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
            is_self_development_path = isinstance(path, str) and any(
                path == prefix or path.startswith(f"{prefix}.")
                for prefix in (SELF_DEVELOPMENT_STATE_PREFIX, SELF_DEVELOPMENT_PROGRESS_PREFIX)
            )
            is_allowed_event_stat = (
                allow_self_development_stats
                and isinstance(path, str)
                and path.startswith(f"{SELF_DEVELOPMENT_STATE_PREFIX}.stats.")
                and path in SELF_DEVELOPMENT_BOUNDS
            )
            if is_self_development_path and not is_allowed_event_stat:
                self._error(
                    issues,
                    item_location,
                    "self-development state is forbidden here; only named stats may gate additive player events, and interactions use self_development.expression metadata",
                )
            if isinstance(path, str) and VISIBLE_INITIATIVE_CONDITION_PATTERN.fullmatch(path):
                self._error(
                    issues,
                    item_location,
                    "visible initiative is display-only and forbidden in general conditions",
                )
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
            elif target_key == "scene" and transition.get("default") is True:
                target_scene = self.scenes.get(transition.get("scene"))
                if target_scene and target_scene.get("entry_conditions"):
                    self._error(
                        issues,
                        item_location,
                        "default scene transition cannot target a conditionally enterable scene without an unconditional fallback",
                    )

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

        occupied: Dict[Tuple[str, str, int, str], Tuple[str, str | None]] = {}
        for event_id, event in self.events.items():
            window = event.get("window", {})
            days = window.get("days", [])
            slots = window.get("slots", [])
            if len(days) != 2 or days[0] != days[1] or event.get("availability") == "player":
                continue
            for slot in slots:
                key = (event.get("campaign_id"), event.get("lane"), days[0], slot)
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

    def world_bundle(self) -> Dict[str, Any]:
        entities = {entity_id: clean_source(entity) for entity_id, entity in self.world.items()}
        by_kind: Dict[str, List[str]] = {}
        story_character_members: Dict[str, str] = {}
        for entity_id, entity in self.world.items():
            by_kind.setdefault(str(entity.get("kind")), []).append(entity_id)
            if entity.get("kind") == "member" and entity.get("story_character"):
                story_character_members[entity["story_character"]] = entity_id
        return {
            "entities": entities,
            "by_kind": {kind: sorted(ids) for kind, ids in sorted(by_kind.items())},
            "story_character_members": dict(sorted(story_character_members.items())),
        }

    def bounded_world_context(self, scene: Mapping[str, Any]) -> Dict[str, Any]:
        declared = scene.get("world_context") if isinstance(scene.get("world_context"), dict) else {}
        members = {
            entity_id: entity
            for entity_id, entity in self.world.items()
            if entity.get("kind") == "member"
        }
        character_members = {
            member.get("story_character"): member_id
            for member_id, member in members.items()
            if member.get("story_character")
        }
        participant_ids = list(declared.get("participants", []))
        if not participant_ids:
            participant_ids = [
                character_members[character_id]
                for character_id in scene.get("cast", [])
                if character_id in character_members
            ]
        participant_entities = {
            member_id: clean_source(members[member_id])
            for member_id in participant_ids
            if member_id in members
        }
        team_ids = {
            member.get("team")
            for member in participant_entities.values()
            if member.get("team") in self.world
        }
        project_id = declared.get("project")
        project = self.world.get(project_id, {})
        if project.get("kind") == "project":
            team_ids.update(project.get("participating_teams", []))
        role_ids = {
            member.get("role")
            for member in participant_entities.values()
            if member.get("role") in self.world
        }
        company_ids = {
            member.get("company")
            for member in participant_entities.values()
            if member.get("company") in self.world
        }
        if declared.get("company") in self.world:
            company_ids.add(declared["company"])
        return {
            "declared": copy.deepcopy(declared),
            "companies": {
                entity_id: clean_source(self.world[entity_id])
                for entity_id in sorted(company_ids)
            },
            "projects": {
                project_id: clean_source(project)
                for project_id in [declared.get("project")]
                if project_id in self.world and project.get("kind") == "project"
            },
            "interactions": {
                interaction_id: clean_source(self.world[interaction_id])
                for interaction_id in [declared.get("interaction")]
                if interaction_id in self.world and self.world[interaction_id].get("kind") == "meeting"
            },
            "participants": participant_entities,
            "teams": {
                entity_id: clean_source(self.world[entity_id])
                for entity_id in sorted(team_ids)
                if entity_id in self.world
            },
            "roles": {
                entity_id: clean_source(self.world[entity_id])
                for entity_id in sorted(role_ids)
                if entity_id in self.world
            },
        }

    def build_bundle(self) -> Dict[str, Any]:
        source_paths = [self.manifest_path, Path(self.game_modes_document["_source"])]
        source_paths.append(Path(self.ui["_source"]))
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
            self.system_flows,
            self.world,
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
            compiled = clean_source(self.compile_scene_dialogue(data))
            nodes = compiled.pop("nodes", [])
            compiled["node_order"] = [node["id"] for node in nodes]
            compiled["nodes"] = {node["id"]: node for node in nodes}
            scenes[item_id] = compiled
        system_flows: Dict[str, Dict[str, Any]] = {}
        for item_id, data in self.system_flows.items():
            compiled = clean_source(data)
            nodes = compiled.pop("nodes", [])
            compiled["node_order"] = [node["id"] for node in nodes]
            compiled["nodes"] = {node["id"]: node for node in nodes}
            system_flows[item_id] = compiled
        return {
            "schema_version": self.manifest.get("schema_version"),
            "project": self.manifest.get("project"),
            "generated_at": reproducible_generated_at(),
            "source_sha256": digest.hexdigest(),
            "enums": self.manifest.get("enums"),
            "stats": self.manifest.get("stats"),
            "self_development": copy.deepcopy(self.manifest.get("self_development", {})),
            "gallery": copy.deepcopy(self.manifest.get("gallery", {})),
            "initial_state": self.initial_state(),
            "game_modes": copy.deepcopy(self.game_modes),
            "localization": self.localization_bundle(),
            "campaigns": campaigns,
            "characters": characters,
            "events": events,
            "visuals": visuals,
            "threads": threads,
            "meta": meta,
            "routes": routes,
            "scenes": scenes,
            "system_flows": system_flows,
            "world": self.world_bundle(),
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
        preview_scene = clean_source(scene)
        preview_nodes = []
        selected_variant: Optional[str] = None
        for preview_node in preview_scene.get("nodes", []):
            if preview_node.get("id") == scene.get("start_node"):
                selected_variant, preview_node = resolve_dialogue_variant(self, current_state, preview_node)
            preview_nodes.append(preview_node)
        preview_scene["nodes"] = preview_nodes
        visual_scene = resolve_scene_stage(self.resolve_visuals(), preview_scene, scene.get("start_node"))
        effective_speakers = {
            node.get("id"): effective_speaker(node)
            for node in preview_scene.get("nodes", [])
            if node.get("kind") in {"dialogue", "narration"}
        }
        return {
            "purpose": "Bounded context for an AI agent editing exactly one scene",
            "authoring_rules": rules_path.read_text(encoding="utf-8"),
            "allowed_system": {
                "enums": self.manifest.get("enums"),
                "stats": self.manifest.get("stats"),
                "self_development": copy.deepcopy(self.manifest.get("self_development", {})),
                "condition_ops": sorted(VALID_CONDITION_OPS),
                "effect_ops": sorted(VALID_EFFECT_OPS),
                "interaction_context_kinds": sorted(VALID_INTERACTION_CONTEXT_KINDS),
                "support_styles": sorted(VALID_SUPPORT_STYLES),
            },
            "route": clean_source(route),
            "scene": clean_source(scene),
            "cast": cast,
            "state_snapshot": state_snapshot,
            "derived_emotions": derived_emotions,
            "selected_dialogue_variant": selected_variant,
            "effective_speakers": effective_speakers,
            "localization": self.localization_bundle(),
            "visual_scene": visual_scene,
            "world_context": self.bounded_world_context(scene),
            "linked_scenes": linked_scenes,
            "open_questions": [],
        }

    def localization_bundle(self) -> Dict[str, Any]:
        entries = collect_localizable_entries(self)
        source_strings = {key: entry["source"] for key, entry in entries.items()}
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
            base = dict(resolved_strings(fallback, chain)) if isinstance(fallback, str) else dict(source_strings)
            base.update(raw_catalogs.get(locale_id, {}))
            catalogs[locale_id] = base
            return base

        total = len(source_strings)
        for locale_id in supported:
            resolved_strings(locale_id)
            direct_keys = {key for key in source_strings if key in raw_catalogs.get(locale_id, {})}
            if locale_id == default_locale:
                direct_keys = set(source_strings)
            missing = [key for key in source_strings if key not in direct_keys]
            fallback_used = [key for key in missing if key in catalogs[locale_id]]
            unresolved = [key for key in source_strings if key not in catalogs[locale_id]]
            orphan = sorted(set(raw_catalogs.get(locale_id, {})) - set(source_strings))
            invalid_placeholders = sorted(
                key
                for key in direct_keys
                if key in raw_catalogs.get(locale_id, {})
                and placeholders(raw_catalogs[locale_id][key]) != set(entries[key]["placeholders"])
            )
            by_domain: Dict[str, Dict[str, int]] = {}
            for key, entry in entries.items():
                domain = entry["domain"]
                bucket = by_domain.setdefault(domain, {"direct": 0, "total": 0})
                bucket["total"] += 1
                if key in direct_keys:
                    bucket["direct"] += 1
            translated = len(direct_keys)
            coverage[locale_id] = {
                "direct": translated,
                "resolved": total - len(unresolved),
                "translated": translated,
                "total": total,
                "ratio": round(translated / total, 4) if total else 1.0,
                "fallback_used": fallback_used,
                "missing": missing,
                "unresolved": unresolved,
                "orphan": orphan,
                "invalid_placeholders": invalid_placeholders,
                "by_domain": by_domain,
            }
        return {
            "schema_version": 2,
            "default_locale": default_locale,
            "supported_locales": supported,
            "locale_names": {
                locale_id: {
                    "name": self.locales.get(locale_id, {}).get("name", locale_id),
                    "native_name": self.locales.get(locale_id, {}).get("native_name")
                    or self.locales.get(locale_id, {}).get("name", locale_id),
                }
                for locale_id in supported
            },
            "locales": {locale_id: clean_source(locale) for locale_id, locale in self.locales.items()},
            "entries": entries,
            "source_strings": source_strings,
            "catalogs": catalogs,
            "direct_catalogs": raw_catalogs,
            "resolved_catalogs": catalogs,
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
    node_override: Optional[Mapping[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    fixed = scene.get("default_background")
    if isinstance(fixed, Mapping):
        visual_id = fixed.get("visual_id")
        variant_id = fixed.get("variant_id")
        visual = visuals.get(visual_id) if isinstance(visual_id, str) else None
        variant = visual.get("variants", {}).get(variant_id) if isinstance(visual, Mapping) else None
        if (
            isinstance(visual, Mapping)
            and visual.get("kind") == "background"
            and not visual.get("abstract")
            and isinstance(variant, Mapping)
            and isinstance(variant.get("asset"), str)
        ):
            return {
                "visual_id": visual_id,
                "variant_id": variant_id,
                "asset": variant["asset"],
                "title_key": visual.get("title_key"),
                "defaults": copy.deepcopy(visual.get("defaults", {})),
                "score": sys.maxsize,
                "matched": ["scene-default"],
            }
    dimensions = {
        "locations": scene.get("location"),
        "times": scene.get("time"),
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
) -> Dict[str, Any]:
    background = resolve_scene_background(visuals, scene, node_id)
    node = scene_node(scene, node_id)
    speaker = effective_speaker(node) if isinstance(node, Mapping) else None
    protagonist_reveal = can_reveal_protagonist_artwork(scene, node)
    characters = []
    raw_stage = node.get("stage") if isinstance(node, Mapping) else None
    if isinstance(raw_stage, Sequence) and not isinstance(raw_stage, (str, bytes)):
        cues = raw_stage
        if not isinstance(cues, Sequence) or isinstance(cues, (str, bytes)):
            cues = []
        for cue in cues:
            if not isinstance(cue, Mapping):
                continue
            character_id = cue.get("character")
            if character_id == PROTAGONIST_ARTWORK_CHARACTER_ID and not protagonist_reveal:
                continue
            visual_id = cue.get("visual_id")
            visual = visuals.get(visual_id) if isinstance(visual_id, str) else None
            if not isinstance(visual, Mapping) or visual.get("character") != character_id:
                continue
            artwork = cue.get("artwork")
            artworks = visual.get("artworks", {})
            selected_artwork = None
            if isinstance(artworks, Mapping) and artworks:
                selected_id = visual.get("default_artwork") if artwork == "default" else artwork
                candidate = artworks.get(selected_id)
                if isinstance(candidate, Mapping):
                    selected_artwork = candidate
                    artwork = selected_id
            expression_id = None if selected_artwork is not None or artwork == "default" else artwork
            expression_assets = visual.get("expression_assets", {})
            characters.append({
                "visual_id": visual.get("id"),
                "character": character_id,
                "asset": selected_artwork.get("asset") if selected_artwork is not None else expression_assets.get(expression_id, visual.get("fallback_asset")),
                "expression": expression_id,
                "artwork": artwork,
                "outfit": visual.get("default_outfit"),
                "pose": visual.get("default_pose"),
                "position": cue.get("position"),
                "speaker": character_id == speaker,
                "render_strategy": visual.get("render_strategy"),
            })
        return {"background": background, "characters": characters, "node": node_id}
    return {"background": background, "characters": characters, "node": node_id}


def placeholders(value: str) -> Set[str]:
    return set(PLACEHOLDER_PATTERN.findall(value)) if isinstance(value, str) else set()


def collect_localizable_entries(project: StoryProject) -> Dict[str, Dict[str, Any]]:
    """Create the authoritative localization registry with source and context metadata."""
    entries: Dict[str, Dict[str, Any]] = {}

    def add(
        key: str,
        value: Any,
        *,
        domain: str,
        kind: str,
        item_id: str,
        source: Any,
        field_path: str,
        context: Optional[Mapping[str, str]] = None,
        max_length: Optional[int] = None,
    ) -> None:
        if not isinstance(value, str) or not value:
            return
        entry = {
            "key": key,
            "source": value,
            "domain": domain,
            "sourceDocument": {
                "kind": kind,
                "id": item_id,
                "path": relative_source(source),
                "fieldPath": field_path,
            },
            "context": dict(context or {}),
            "placeholders": sorted(placeholders(value)),
            "multiline": "\n" in value,
        }
        if max_length is not None:
            entry["maxLength"] = max_length
        previous = entries.get(key)
        if previous is not None and (
            previous["source"] != value
            or previous["sourceDocument"] != entry["sourceDocument"]
        ):
            raise RuntimeError(
                f"localization key collision: {key}: "
                f"{previous['sourceDocument']['path']} vs {entry['sourceDocument']['path']}"
            )
        entries[key] = entry

    ui_source = project.ui.get("_source", "story/ui.yaml")
    for key, value in project.ui.get("strings", {}).items():
        add(
            key,
            value,
            domain="ui",
            kind="ui",
            item_id=project.ui.get("id", "game_ui"),
            source=ui_source,
            field_path=f"strings.{key}",
            max_length=160 if key == "app.title" else 100,
        )

    for campaign_id, campaign in project.campaigns.items():
        base = f"campaign.{campaign_id}"
        source = campaign.get("_source", campaign_id)
        add(f"{base}.title", campaign.get("title"), domain="campaign", kind="campaign", item_id=campaign_id, source=source, field_path="title", max_length=100)
        for act in campaign.get("acts", []):
            act_id = act.get("id", act.get("number"))
            add(f"{base}.acts.{act_id}.title", act.get("title"), domain="campaign", kind="campaign", item_id=campaign_id, source=source, field_path=f"acts.{act_id}.title", max_length=100)
            add(f"{base}.acts.{act_id}.purpose", act.get("purpose"), domain="campaign", kind="campaign", item_id=campaign_id, source=source, field_path=f"acts.{act_id}.purpose", max_length=240)
        for lane in campaign.get("lanes", []):
            lane_id = lane.get("id")
            add(f"{base}.lanes.{lane_id}.title", lane.get("title"), domain="campaign", kind="campaign", item_id=campaign_id, source=source, field_path=f"lanes.{lane_id}.title", max_length=80)
    for character_id, character in project.characters.items():
        base = f"characters.{character_id}"
        source = character.get("_source", character_id)
        for field in ("display_name", "role", "summary"):
            add(f"{base}.{field}", character.get(field), domain="character", kind="character", item_id=character_id, source=source, field_path=field, context={"characterId": character_id}, max_length=240)
        for field_id, field in character.get("player_profile", {}).get("fields", {}).items():
            add(
                f"{base}.player_profile.fields.{field_id}.value",
                field.get("value"),
                domain="character",
                kind="character",
                item_id=character_id,
                source=source,
                field_path=f"player_profile.fields.{field_id}.value",
                context={"characterId": character_id, "profileFieldId": field_id},
                max_length=160,
            )
        for expression_id, expression in character.get("expressions", {}).items():
            add(f"{base}.expressions.{expression_id}.description", expression.get("description"), domain="character", kind="character", item_id=character_id, source=source, field_path=f"expressions.{expression_id}.description", context={"characterId": character_id}, max_length=240)
    for member_id, member in project.world.items():
        if member.get("kind") != "member":
            continue
        if member.get("presentation") == "text_only":
            add(
                f"world.members.{member_id}.display_name",
                member.get("display_name"),
                domain="world",
                kind="member",
                item_id=member_id,
                source=member.get("_source", member_id),
                field_path="display_name",
                context={"memberId": member_id, "presentation": "text_only"},
                max_length=80,
            )
        add(
            f"world.members.{member_id}.compendium_summary",
            member.get("compendium_summary"),
            domain="world",
            kind="member",
            item_id=member_id,
            source=member.get("_source", member_id),
            field_path="compendium_summary",
            context={"memberId": member_id, "presentation": member.get("presentation")},
            max_length=180,
        )
    for event_id, event in project.events.items():
        base = f"events.{event_id}"
        source = event.get("_source", event_id)
        context = {"eventId": event_id}
        if event.get("scene"):
            context["sceneId"] = event["scene"]
        add(f"{base}.title", event.get("title"), domain="event", kind="event", item_id=event_id, source=source, field_path="title", context=context, max_length=100)
        presentation = event.get("presentation", {})
        add(f"{base}.presentation.title", presentation.get("title"), domain="event", kind="event", item_id=event_id, source=source, field_path="presentation.title", context=context, max_length=100)
        add(f"{base}.presentation.summary", presentation.get("summary"), domain="event", kind="event", item_id=event_id, source=source, field_path="presentation.summary", context=context, max_length=240)
    for thread_id, thread in project.threads.items():
        add(f"threads.{thread_id}.title", thread.get("title"), domain="thread", kind="thread", item_id=thread_id, source=thread.get("_source", thread_id), field_path="title", max_length=100)
    for route_id, route in project.routes.items():
        base = f"routes.{route_id}"
        source = route.get("_source", route_id)
        add(f"{base}.title", route.get("title"), domain="route", kind="route", item_id=route_id, source=source, field_path="title", max_length=100)
        add(f"{base}.summary", route.get("summary"), domain="route", kind="route", item_id=route_id, source=source, field_path="summary", max_length=240)
        for ending in route.get("endings", []):
            ending_scene = ending.get("scene")
            add(f"{base}.endings.{ending_scene}.outcome", ending.get("outcome"), domain="route", kind="route", item_id=route_id, source=source, field_path=f"endings.{ending_scene}.outcome", context={"sceneId": ending_scene}, max_length=240)
    for scene_id, scene in project.scenes.items():
        base = f"scenes.{scene_id}"
        source = scene.get("_source", scene_id)
        scene = project.compile_scene_dialogue(scene)
        scene_context = {"sceneId": scene_id}
        add(f"{base}.title", scene.get("title"), domain="scene", kind="scene", item_id=scene_id, source=source, field_path="title", context=scene_context, max_length=100)
        add(f"{base}.purpose", scene.get("purpose"), domain="scene", kind="scene", item_id=scene_id, source=source, field_path="purpose", context=scene_context, max_length=240)
        for node in scene.get("nodes", []):
            node_base = f"{base}.nodes.{node.get('id')}"
            node_id = node.get("id")
            node_context = {"sceneId": scene_id, "nodeId": node_id}
            if node.get("speaker"):
                node_context["speakerId"] = node["speaker"]
            add(f"{node_base}.prompt", node.get("prompt"), domain="scene", kind="scene", item_id=scene_id, source=source, field_path=f"nodes.{node_id}.prompt", context=node_context, max_length=160)
            add(f"{node_base}.stimulus", node.get("stimulus"), domain="scene", kind="scene", item_id=scene_id, source=source, field_path=f"nodes.{node_id}.stimulus", context=node_context, max_length=240)
            for direction in ("pull", "push", "none"):
                add(
                    f"{node_base}.analysis_hints.{direction}",
                    node.get("analysis_hints", {}).get(direction),
                    domain="scene",
                    kind="scene",
                    item_id=scene_id,
                    source=source,
                    field_path=f"nodes.{node_id}.analysis_hints.{direction}",
                    context=node_context,
                    max_length=320,
                )
            speaker = effective_speaker(node)
            line_context = dict(node_context)
            if speaker:
                line_context["speakerId"] = speaker
            add(f"{node_base}.line", node.get("line"), domain="scene", kind="scene", item_id=scene_id, source=source, field_path=f"nodes.{node_id}.line", context=line_context, max_length=320)
            for variant in node.get("variants", []):
                variant_id = variant.get("id")
                variant_context = {**node_context, "variantId": variant_id}
                variant_base = f"{node_base}.variants.{variant_id}"
                if speaker:
                    variant_context["speakerId"] = speaker
                add(f"{variant_base}.line", variant.get("line"), domain="scene", kind="scene", item_id=scene_id, source=source, field_path=f"nodes.{node_id}.variants.{variant_id}.line", context=variant_context, max_length=320)
            for option in node.get("options", []):
                option_id = option.get("id")
                option_base = f"{node_base}.options.{option_id}"
                option_context = {**node_context, "optionId": option_id}
                for field in ("label", "interpretation", "action"):
                    add(f"{option_base}.{field}", option.get(field), domain="scene", kind="scene", item_id=scene_id, source=source, field_path=f"nodes.{node_id}.options.{option_id}.{field}", context=option_context, max_length=240)
    for flow_id, flow in project.system_flows.items():
        base = f"system_flows.{flow_id}"
        source = flow.get("_source", flow_id)
        for node in flow.get("nodes", []):
            if not isinstance(node, Mapping):
                continue
            node_id = node.get("id")
            node_base = f"{base}.nodes.{node_id}"
            node_context = {"flowId": flow_id, "nodeId": node_id}
            variants = node.get("variants")
            if isinstance(variants, list):
                for variant in variants:
                    if not isinstance(variant, Mapping):
                        continue
                    variant_id = variant.get("id")
                    variant_base = f"{node_base}.variants.{variant_id}"
                    add(
                        f"{variant_base}.line",
                        variant.get("line"),
                        domain="system_flow",
                        kind="system_flow",
                        item_id=flow_id,
                        source=source,
                        field_path=f"nodes.{node_id}.variants.{variant_id}.line",
                        context={**node_context, "variantId": variant_id},
                        max_length=320,
                    )
            else:
                add(
                    f"{node_base}.line",
                    node.get("line"),
                    domain="system_flow",
                    kind="system_flow",
                    item_id=flow_id,
                    source=source,
                    field_path=f"nodes.{node_id}.line",
                    context=node_context,
                    max_length=320,
                )
        for option in flow.get("options", []):
            if not isinstance(option, Mapping):
                continue
            option_id = option.get("id")
            option_base = f"{base}.options.{option_id}"
            for field in ("label", "description"):
                add(
                    f"{option_base}.{field}",
                    option.get(field),
                    domain="system_flow",
                    kind="system_flow",
                    item_id=flow_id,
                    source=source,
                    field_path=f"options.{option_id}.{field}",
                    context={"flowId": flow_id, "optionId": option_id},
                    max_length=240,
                )
    for meta_id, meta in project.meta.items():
        for teaser in meta.get("mode_teasers", []):
            for reveal in teaser.get("reveals", []):
                base = f"meta.{meta_id}.teasers.{teaser.get('id')}.{reveal.get('mode')}"
                source = meta.get("_source", meta_id)
                add(f"{base}.title", reveal.get("title"), domain="meta", kind="meta", item_id=meta_id, source=source, field_path=f"mode_teasers.{teaser.get('id')}.{reveal.get('mode')}.title")
                add(f"{base}.teaser", reveal.get("teaser"), domain="meta", kind="meta", item_id=meta_id, source=source, field_path=f"mode_teasers.{teaser.get('id')}.{reveal.get('mode')}.teaser")

    for locale_id, locale in project.locales.items():
        source = locale.get("_source", locale_id)
        add(
            f"locale.{locale_id}.name",
            locale.get("name"),
            domain="locale",
            kind="locale",
            item_id=locale_id,
            source=source,
            field_path="name",
            context={},
            max_length=80,
        )
        add(
            f"locale.{locale_id}.native_name",
            locale.get("native_name") or locale.get("name"),
            domain="locale",
            kind="locale",
            item_id=locale_id,
            source=source,
            field_path="native_name",
            context={},
            max_length=80,
        )
    for visual_id, visual in project.visuals.items():
        title_key = visual.get("title_key")
        if isinstance(title_key, str):
            add(
                title_key,
                visual.get("title"),
                domain="visual",
                kind="visual",
                item_id=visual_id,
                source=visual.get("_source", visual_id),
                field_path="title",
                max_length=100,
            )
    return dict(sorted(entries.items()))


def collect_localizable_strings(project: StoryProject) -> Dict[str, str]:
    """Compatibility view of the authoritative localization registry."""
    return {key: entry["source"] for key, entry in collect_localizable_entries(project).items()}


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


def get_path(state: Mapping[str, Any], path: str, default: Any = NO_DEFAULT) -> Any:
    current: Any = state
    for part in path.split("."):
        if not isinstance(current, Mapping) or part not in current:
            if default is NO_DEFAULT:
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


def refresh_game_mode_unlocks(project: StoryProject, state: MutableMapping[str, Any]) -> List[str]:
    """Project the registry's unlock rules into legacy-compatible progress state."""
    unlocked: List[str] = []
    existing = set(get_path(state, "progress.unlocked_modes", []) or [])
    for mode_id, mode in project.game_modes.items():
        unlock = mode.get("unlock", {})
        allowed = mode_id in existing or unlock.get("always") is True or any(
            conditions_match(state, group.get("conditions", []))
            for group in unlock.get("any", [])
        )
        if allowed:
            unlocked.append(mode_id)
    set_path(state, "progress.unlocked_modes", unlocked)
    return unlocked


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


def _bounded_number(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        return fallback
    return max(minimum, min(maximum, int(value)))


def self_development_expression_matches(
    project: StoryProject,
    state: Mapping[str, Any],
    expression_id: Any,
) -> bool:
    expressions = project.manifest.get("self_development", {}).get("expressions", {})
    expression = expressions.get(expression_id) if isinstance(expressions, Mapping) else None
    if not isinstance(expression, Mapping):
        return False
    requires = expression.get("requires", {})
    if not isinstance(requires, Mapping):
        return False
    profile = get_path(state, SELF_DEVELOPMENT_STATE_PREFIX, {})
    if not isinstance(profile, Mapping):
        return False
    appeal_gte = requires.get("appeal_gte")
    if appeal_gte is not None:
        appeal = _number_value(profile.get("appeal"))
        threshold = _number_value(appeal_gte)
        if appeal is None or threshold is None or appeal < threshold:
            return False
    stat = requires.get("stat")
    minimum = requires.get("minimum")
    if stat is not None:
        stats = profile.get("stats", {})
        actual = _number_value(stats.get(stat)) if isinstance(stats, Mapping) else None
        threshold = _number_value(minimum)
        if actual is None or threshold is None or actual < threshold:
            return False
    fatigue_lte = requires.get("fatigue_lte")
    if fatigue_lte is not None:
        fatigue = _number_value(profile.get("fatigue"))
        threshold = _number_value(fatigue_lte)
        if fatigue is None or threshold is None or fatigue > threshold:
            return False
    if "last_activity" in requires:
        expected_activity = requires.get("last_activity")
        actual_activity = get_path(state, f"{SELF_DEVELOPMENT_PROGRESS_PREFIX}.last_activity", MISSING)
        if not isinstance(expected_activity, str) or actual_activity != expected_activity:
            return False
    return True


def _number_value(value: Any) -> Optional[float]:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        return None
    return float(value)


def self_development_use_matches(
    project: StoryProject,
    state: Mapping[str, Any],
    value: Any,
) -> bool:
    if value is None:
        return True
    if not isinstance(value, Mapping):
        return False
    return self_development_expression_matches(project, state, value.get("expression"))


def self_development_score_bonus(
    project: StoryProject,
    state: Mapping[str, Any],
    value: Any,
) -> int:
    if not self_development_use_matches(project, state, value) or not isinstance(value, Mapping):
        return 0
    expressions = project.manifest.get("self_development", {}).get("expressions", {})
    expression = expressions.get(value.get("expression"), {}) if isinstance(expressions, Mapping) else {}
    raw_bonus = expression.get("score_bonus") if isinstance(expression, Mapping) else 0
    return _bounded_number(raw_bonus, 0, 0, SELF_DEVELOPMENT_MAX_SCORE_BONUS)


def choice_option_enabled(project: StoryProject, state: Mapping[str, Any], option: Mapping[str, Any]) -> bool:
    return conditions_match(state, option.get("conditions", [])) and self_development_use_matches(
        project,
        state,
        option.get("self_development"),
    )


class SelfDevelopmentError(RuntimeError):
    """Typed harness failure matching the player self-development domain."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class NightPhaseError(RuntimeError):
    """Typed nightly lifecycle failure matching the player coordinator."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class SelfDevelopmentService:
    """Manifest-driven Python mirror of the player self-development service."""

    def __init__(self, project: StoryProject):
        self.project = project
        raw_config = project.manifest.get("self_development", {})
        self.config = raw_config if isinstance(raw_config, Mapping) else {}
        configured_max_day = _number_value(self.config.get("max_night_day"))
        self.max_night_day = max(0, int(configured_max_day)) if configured_max_day is not None else 16
        self.activities: Dict[str, Dict[str, Any]] = {}
        for activity in self.config.get("activities", []):
            if not isinstance(activity, Mapping) or not isinstance(activity.get("id"), str):
                continue
            activity_id = activity["id"]
            if activity_id in self.activities:
                raise SelfDevelopmentError(
                    "duplicate_activity",
                    f"duplicate self-development activity: {activity_id}",
                )
            self.activities[activity_id] = copy.deepcopy(dict(activity))
        initial_state = project.initial_state()
        initial_profile = get_path(initial_state, SELF_DEVELOPMENT_STATE_PREFIX, {})
        self.initial_profile = self._hydrate_profile(initial_profile, {
            "appeal": 30,
            "stats": {stat: 0 for stat in SELF_DEVELOPMENT_STAT_ORDER},
            "fatigue": 1,
        })
        initial_progress = get_path(initial_state, SELF_DEVELOPMENT_PROGRESS_PREFIX, {})
        self.initial_progress = self._hydrate_progress(initial_progress, {
            "completed_days": [],
            "activity_history": [],
            "last_activity": "",
            "hint_charges": 0,
        })

    def _stat_bounds(self, path: str, default_minimum: int, default_maximum: int) -> Tuple[int, int]:
        if path in SELF_DEVELOPMENT_BOUNDS:
            return SELF_DEVELOPMENT_BOUNDS[path]
        spec = self.project.path_spec(path) or {}
        minimum = spec.get("min", default_minimum)
        maximum = spec.get("max", default_maximum)
        return int(minimum), int(maximum)

    def _safe_integer(self, value: Any, fallback: int, minimum: int, maximum: int) -> int:
        return _bounded_number(value, fallback, minimum, maximum)

    def _hydrate_profile(self, value: Any, fallback: Mapping[str, Any]) -> Dict[str, Any]:
        source = value if isinstance(value, Mapping) else {}
        fallback_stats = fallback.get("stats", {}) if isinstance(fallback.get("stats"), Mapping) else {}
        source_stats = source.get("stats", {}) if isinstance(source.get("stats"), Mapping) else {}
        appeal_min, appeal_max = self._stat_bounds(
            f"{SELF_DEVELOPMENT_STATE_PREFIX}.appeal", 0, 100
        )
        fatigue_min, fatigue_max = self._stat_bounds(
            f"{SELF_DEVELOPMENT_STATE_PREFIX}.fatigue", 0, 6
        )
        stats = {}
        for stat in SELF_DEVELOPMENT_STAT_ORDER:
            stat_min, stat_max = self._stat_bounds(
                f"{SELF_DEVELOPMENT_STATE_PREFIX}.stats.{stat}", 0, 5
            )
            stats[stat] = self._safe_integer(
                source_stats.get(stat),
                int(fallback_stats.get(stat, 0)),
                stat_min,
                stat_max,
            )
        return {
            "appeal": self._safe_integer(
                source.get("appeal"), int(fallback.get("appeal", 30)), appeal_min, appeal_max
            ),
            "stats": stats,
            "fatigue": self._safe_integer(
                source.get("fatigue"), int(fallback.get("fatigue", 1)), fatigue_min, fatigue_max
            ),
        }

    def _hydrate_progress(self, value: Any, fallback: Mapping[str, Any]) -> Dict[str, Any]:
        source = value if isinstance(value, Mapping) else {}
        raw_days = source.get("completed_days", fallback.get("completed_days", []))
        raw_history = source.get("activity_history", fallback.get("activity_history", []))
        days = raw_days if isinstance(raw_days, list) else fallback.get("completed_days", [])
        history = raw_history if isinstance(raw_history, list) else fallback.get("activity_history", [])
        return {
            "completed_days": sorted({
                day for day in days
                if isinstance(day, int) and not isinstance(day, bool) and day >= 1
            }),
            "activity_history": [item for item in history if isinstance(item, str)],
            "last_activity": source.get("last_activity")
            if isinstance(source.get("last_activity"), str)
            else str(fallback.get("last_activity", "")),
            "hint_charges": self._safe_integer(
                source.get("hint_charges"),
                int(fallback.get("hint_charges", 0)),
                0,
                SELF_DEVELOPMENT_MAX_HINT_CHARGES,
            ),
        }

    def hydrate(self, state: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
        profile = self._hydrate_profile(
            get_path(state, SELF_DEVELOPMENT_STATE_PREFIX, {}),
            self.initial_profile,
        )
        progress = self._hydrate_progress(
            get_path(state, SELF_DEVELOPMENT_PROGRESS_PREFIX, {}),
            self.initial_progress,
        )
        set_path(state, SELF_DEVELOPMENT_STATE_PREFIX, profile)
        set_path(state, SELF_DEVELOPMENT_PROGRESS_PREFIX, progress)
        return state

    def profile(self, state: MutableMapping[str, Any]) -> Dict[str, Any]:
        self.hydrate(state)
        return copy.deepcopy(get_path(state, SELF_DEVELOPMENT_STATE_PREFIX, self.initial_profile))

    def progress(self, state: MutableMapping[str, Any]) -> Dict[str, Any]:
        self.hydrate(state)
        return copy.deepcopy(get_path(state, SELF_DEVELOPMENT_PROGRESS_PREFIX, self.initial_progress))

    def activity_options(self, state: MutableMapping[str, Any]) -> List[Dict[str, Any]]:
        self.hydrate(state)
        profile = self.profile(state)
        progress = self.progress(state)
        day = get_path(state, "progress.time.day", None)
        slot = get_path(state, "progress.time.slot", None)
        _, fatigue_max = self._stat_bounds(f"{SELF_DEVELOPMENT_STATE_PREFIX}.fatigue", 0, 6)
        result = []
        for activity in self.activities.values():
            if activity.get("selectable", True) is False:
                continue
            reason = None
            if slot != "after_work":
                reason = "not_after_work"
            elif not isinstance(day, int) or isinstance(day, bool) or day < 1 or day > self.max_night_day:
                reason = "outside_night_window"
            elif day in progress["completed_days"]:
                reason = "already_completed"
            else:
                fatigue_lte = activity.get("fatigue_lte")
                if fatigue_lte is not None and (
                    not isinstance(fatigue_lte, int)
                    or isinstance(fatigue_lte, bool)
                    or profile["fatigue"] > fatigue_lte
                ):
                    reason = "fatigue_limit"
                fatigue_gte = activity.get("fatigue_gte")
                if reason is None and fatigue_gte is not None and (
                    not isinstance(fatigue_gte, int)
                    or isinstance(fatigue_gte, bool)
                    or profile["fatigue"] < fatigue_gte
                ):
                    reason = "fatigue_minimum"
                fatigue_delta = activity.get("fatigue_delta", 0)
                if reason is None and isinstance(fatigue_delta, int) and fatigue_delta > 0:
                    if profile["fatigue"] + fatigue_delta > fatigue_max:
                        reason = "fatigue_overflow"
            result.append({
                "activity": copy.deepcopy(activity),
                "available": reason is None,
                **({"reason": reason} if reason else {}),
            })
        return result

    def forced_activity(self, state: MutableMapping[str, Any]) -> Optional[Dict[str, Any]]:
        self.hydrate(state)
        profile = self.profile(state)
        for activity in self.activities.values():
            if activity.get("selectable", True) is not False:
                continue
            fatigue_gte = activity.get("fatigue_gte")
            fatigue_lte = activity.get("fatigue_lte")
            if not isinstance(fatigue_gte, int) or isinstance(fatigue_gte, bool):
                continue
            if profile["fatigue"] < fatigue_gte:
                continue
            if isinstance(fatigue_lte, int) and not isinstance(fatigue_lte, bool) and profile["fatigue"] > fatigue_lte:
                continue
            return copy.deepcopy(activity)
        return None

    def perform_activity(
        self,
        state: MutableMapping[str, Any],
        activity_id: str,
        day: int,
    ) -> Dict[str, Any]:
        self.hydrate(state)
        if not isinstance(day, int) or isinstance(day, bool) or day < 1 or day > self.max_night_day:
            raise SelfDevelopmentError("invalid_day", f"night activity is unavailable on day {day}")
        current_day = get_path(state, "progress.time.day", None)
        if day != current_day:
            raise SelfDevelopmentError(
                "day_mismatch",
                f"night activity day {day} does not match current day {current_day}",
            )
        activity = self.activities.get(activity_id)
        if activity is None:
            raise SelfDevelopmentError("unknown_activity", f"unknown self-development activity: {activity_id}")
        progress = self.progress(state)
        slot = get_path(state, "progress.time.slot", None)
        option = next(
            (item for item in self.activity_options(state) if item["activity"]["id"] == activity_id),
            None,
        )
        forced = self.forced_activity(state)
        if slot != "after_work":
            code = "not_after_work"
        elif day in progress["completed_days"]:
            code = "already_completed"
        elif activity.get("selectable", True) is False:
            code = None if forced and forced.get("id") == activity_id else "fatigue_minimum"
        else:
            code = None if option and option["available"] else option.get("reason", "outside_night_window") if option else "outside_night_window"
        if code:
            raise SelfDevelopmentError(
                code,
                f"self-development activity {activity_id} is unavailable: {code}",
            )

        state_before = copy.deepcopy(state)
        before = self.profile(state)
        after = copy.deepcopy(before)
        appeal_min, appeal_max = self._stat_bounds(
            f"{SELF_DEVELOPMENT_STATE_PREFIX}.appeal", 0, 100
        )
        fatigue_min, fatigue_max = self._stat_bounds(
            f"{SELF_DEVELOPMENT_STATE_PREFIX}.fatigue", 0, 6
        )
        after["appeal"] = self._safe_integer(
            before["appeal"] + int(activity.get("appeal_delta", 0)),
            before["appeal"],
            appeal_min,
            appeal_max,
        )
        after["fatigue"] = self._safe_integer(
            before["fatigue"] + int(activity.get("fatigue_delta", 0)),
            before["fatigue"],
            fatigue_min,
            fatigue_max,
        )
        stat_deltas = {}
        for stat, delta in activity.get("stat_deltas", {}).items():
            stat_min, stat_max = self._stat_bounds(
                f"{SELF_DEVELOPMENT_STATE_PREFIX}.stats.{stat}", 0, 5
            )
            after["stats"][stat] = self._safe_integer(
                before["stats"][stat] + int(delta),
                before["stats"][stat],
                stat_min,
                stat_max,
            )
            stat_deltas[stat] = after["stats"][stat] - before["stats"][stat]

        progress = self.progress(state)
        progress["completed_days"] = sorted({*progress["completed_days"], day})
        progress["activity_history"].append(activity_id)
        progress["last_activity"] = activity_id
        previous_hint_charges = progress["hint_charges"]
        progress["hint_charges"] = self._safe_integer(
            previous_hint_charges + int(activity.get("hint_charge", 0)),
            previous_hint_charges,
            0,
            SELF_DEVELOPMENT_MAX_HINT_CHARGES,
        )
        set_path(state, SELF_DEVELOPMENT_STATE_PREFIX, after)
        set_path(state, SELF_DEVELOPMENT_PROGRESS_PREFIX, progress)
        return {
            "type": "self_development",
            "day": day,
            "activity": activity_id,
            "appeal_delta": after["appeal"] - before["appeal"],
            "fatigue_delta": after["fatigue"] - before["fatigue"],
            "hint_charge_delta": progress["hint_charges"] - previous_hint_charges,
            "stat_deltas": stat_deltas,
            "before": before,
            "after": copy.deepcopy(after),
            "state_diff": state_diff(state_before, state),
        }


class NightPhaseCoordinator:
    """Night selection/result/finish lifecycle for harness simulations."""

    def __init__(self, service: SelfDevelopmentService):
        self.service = service

    def should_start(self, state: MutableMapping[str, Any]) -> bool:
        self.service.hydrate(state)
        day = get_path(state, "progress.time.day", None)
        slot = get_path(state, "progress.time.slot", None)
        progress = self.service.progress(state)
        return (
            slot == "after_work"
            and isinstance(day, int)
            and not isinstance(day, bool)
            and 1 <= day <= self.service.max_night_day
            and day not in progress["completed_days"]
            and (
                self.service.forced_activity(state) is not None
                or any(option["available"] for option in self.service.activity_options(state))
            )
        )

    def start(self, state: MutableMapping[str, Any]) -> Dict[str, Any]:
        if not self.should_start(state):
            raise NightPhaseError("not_available", "night phase is unavailable in the current state")
        forced = self.service.forced_activity(state)
        return {
            "status": "intro",
            "day": get_path(state, "progress.time.day", None),
            "profile": self.service.profile(state),
            **({"forced_activity_id": forced["id"]} if forced else {}),
        }

    def continue_intro(
        self,
        state: MutableMapping[str, Any],
        phase: Mapping[str, Any],
    ) -> Dict[str, Any]:
        if not self.should_start(state) or phase.get("day") != get_path(state, "progress.time.day", None):
            raise NightPhaseError("not_available", "night phase is unavailable in the current state")
        forced = self.service.forced_activity(state)
        if phase.get("forced_activity_id") and forced and phase["forced_activity_id"] == forced["id"]:
            return self._choose_forced(state, forced["id"])
        return {
            "status": "selecting",
            "day": get_path(state, "progress.time.day", None),
            "profile": self.service.profile(state),
            "options": self.service.activity_options(state),
        }

    def choose(self, state: MutableMapping[str, Any], activity_id: str) -> Dict[str, Any]:
        if not self.should_start(state):
            raise NightPhaseError("not_available", "night phase is unavailable in the current state")
        day = get_path(state, "progress.time.day", None)
        option = next(
            (item for item in self.service.activity_options(state) if item["activity"]["id"] == activity_id),
            None,
        )
        if not option or not option["available"]:
            raise NightPhaseError("not_available", "selected night activity is unavailable")
        result = self.service.perform_activity(state, activity_id, day)
        return {
            "status": "result",
            "day": day,
            "profile": copy.deepcopy(result["after"]),
            "result": result,
        }

    def _choose_forced(self, state: MutableMapping[str, Any], activity_id: str) -> Dict[str, Any]:
        day = get_path(state, "progress.time.day", None)
        result = self.service.perform_activity(state, activity_id, day)
        return {
            "status": "result",
            "day": day,
            "profile": copy.deepcopy(result["after"]),
            "result": result,
        }

    def finish(self, state: MutableMapping[str, Any]) -> Dict[str, Any]:
        self.service.hydrate(state)
        day = get_path(state, "progress.time.day", None)
        progress = self.service.progress(state)
        if day not in progress["completed_days"]:
            raise NightPhaseError(
                "activity_not_completed",
                f"a night activity has not been completed for day {day}",
            )
        return {
            "status": "finished",
            "day": day,
            "profile": self.service.profile(state),
            "activity": progress["last_activity"],
        }


def push_pull_state(state: Mapping[str, Any]) -> Dict[str, Any]:
    raw = get_path(state, "progress.flags.push_pull", {})
    if not isinstance(raw, Mapping):
        raw = {}
    target = raw.get("target") if raw.get("target") in {"pull", "push", "none"} else "none"
    last_action = raw.get("last_action") if raw.get("last_action") in VALID_PUSH_PULL_ACTIONS | {"none"} else "none"
    return {
        "combo": _bounded_number(raw.get("combo"), 0, 0, PUSH_PULL_MAX_COMBO),
        "position": _bounded_number(raw.get("position"), 0, -PUSH_PULL_LIMIT, PUSH_PULL_LIMIT),
        "target": target,
        "last_action": last_action,
        "heroine": raw.get("heroine") if isinstance(raw.get("heroine"), str) else "",
    }


def break_push_pull_flow(state: MutableMapping[str, Any], keep_position: bool = True) -> None:
    current = push_pull_state(state)
    current.update({
        "combo": 0,
        "position": current["position"] if keep_position else 0,
        "target": "none",
        "last_action": "none",
        "heroine": "",
    })
    set_path(state, "progress.flags.push_pull", current)


def _apply_pattern_effects(
    project: StoryProject,
    state: MutableMapping[str, Any],
    heroine: str,
    combo: int,
    reached_checkpoint: bool,
) -> Dict[str, int]:
    delta = {"suspicion": 0, "dislike": 0, "evidence_count": 0}
    if combo < 3:
        return delta
    if combo == 3:
        delta["suspicion"] = 3
    elif combo == 4:
        delta["suspicion"] = 5
        delta["dislike"] = 2
    else:
        delta["suspicion"] = 7
        delta["dislike"] = 4
        if reached_checkpoint:
            delta["evidence_count"] = 1
    for stat, amount in delta.items():
        if amount:
            apply_effect(project, state, {
                "path": f"hidden.heroines.{heroine}.{stat}",
                "op": "add",
                "value": amount,
            })
    return delta


def resolve_push_pull(
    project: StoryProject,
    state: MutableMapping[str, Any],
    heroine: str,
    config: Mapping[str, Any],
    visible_score_bonus: int = 0,
) -> Dict[str, Any]:
    current = push_pull_state(state)
    heroine_changed = bool(current["heroine"] and current["heroine"] != heroine)
    action = config.get("action")
    if action not in VALID_PUSH_PULL_ACTIONS:
        raise ValueError(f"unsupported push_pull action: {action}")
    intensity = _bounded_number(config.get("intensity"), 12, 8, 16)
    base_score = _bounded_number(config.get("base_score"), 4, 2, 5)
    previous_position = current["position"]
    initiative_path = f"visible.heroines.{heroine}.initiative"
    previous_initiative = int(get_path(state, initiative_path, 0))
    combo = 0 if heroine_changed else current["combo"]
    target = "none" if heroine_changed else current["target"]
    position = previous_position
    base_gain = 0
    bonus_gain = 0
    gain = 0
    reached_checkpoint = False

    if action == "literal":
        if position < 0:
            position = min(0, position + intensity)
        elif position > 0:
            position = max(0, position - intensity)
        combo = 0
        target = "none"
        kind = "literal"
    else:
        direction = "pull" if action == "approach" else "push"
        if target == "none":
            target = direction
        movement = -intensity if direction == "pull" else intensity
        position = max(-PUSH_PULL_LIMIT, min(PUSH_PULL_LIMIT, position + movement))
        previous_inside = abs(previous_position) <= PUSH_PULL_OPTIMAL_LIMIT
        inside = abs(position) <= PUSH_PULL_OPTIMAL_LIMIT
        moving_toward_target = position < previous_position if target == "pull" else position > previous_position
        reached_checkpoint = (
            previous_position > -PUSH_PULL_CHECKPOINT and position <= -PUSH_PULL_CHECKPOINT
            if target == "pull"
            else previous_position < PUSH_PULL_CHECKPOINT and position >= PUSH_PULL_CHECKPOINT
        )
        if previous_inside and inside and moving_toward_target:
            combo = min(PUSH_PULL_MAX_COMBO, combo + 1)
            base_gain = base_score * combo
            kind = "score"
            if reached_checkpoint:
                base_gain += PUSH_PULL_TURN_BONUS
                target = "push" if target == "pull" else "pull"
                kind = "turn"
            bonus_gain = _bounded_number(
                visible_score_bonus,
                0,
                0,
                SELF_DEVELOPMENT_MAX_SCORE_BONUS,
            )
            gain = base_gain + bonus_gain
            apply_effect(project, state, {"path": initiative_path, "op": "add", "value": gain})
        else:
            combo = 0
            kind = "wrong" if inside else "outside"
            if not inside:
                target = "push" if position < -PUSH_PULL_OPTIMAL_LIMIT else "pull"

    hidden_delta = (
        _apply_pattern_effects(project, state, heroine, combo, reached_checkpoint)
        if kind in {"score", "turn"}
        else {"suspicion": 0, "dislike": 0, "evidence_count": 0}
    )
    next_state = {
        "combo": combo,
        "position": position,
        "target": target,
        "last_action": action,
        "heroine": heroine,
    }
    set_path(state, "progress.flags.push_pull", next_state)
    return {
        "kind": kind,
        "action": action,
        "previous_position": previous_position,
        "position": position,
        "previous_initiative": previous_initiative,
        "initiative": int(get_path(state, initiative_path, previous_initiative)),
        "combo": combo,
        "base_gain": base_gain,
        "bonus_gain": bonus_gain,
        "gain": gain,
        "target": target,
        "reached_checkpoint": reached_checkpoint,
        "inside_optimal_range": abs(position) <= PUSH_PULL_OPTIMAL_LIMIT,
        "heroine_changed": heroine_changed,
        "hidden_delta": hidden_delta,
    }


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
                "rule_id": rule.get("id"),
                "emotion": rule.get("emotion"),
                "behavior": rule.get("behavior"),
                "expression": rule.get("default_expression"),
                "default_expression": rule.get("default_expression"),
            }
    return None


def evaluation_state(project: StoryProject, state: Mapping[str, Any]) -> Dict[str, Any]:
    result = copy.deepcopy(dict(state))
    characters: Dict[str, Dict[str, Any]] = {}
    for character_id, character in project.characters.items():
        emotion = derive_emotion(character, state) or {}
        characters[character_id] = {
            "rule_id": emotion.get("rule_id"),
            "emotion": emotion.get("emotion"),
            "behavior": emotion.get("behavior"),
            "default_expression": emotion.get("default_expression"),
        }
    result["derived"] = {"characters": characters}
    return result


def resolve_dialogue_variant(
    project: StoryProject,
    state: Mapping[str, Any],
    node: Mapping[str, Any],
) -> Tuple[str, Mapping[str, Any]]:
    node = project.compile_dialogue_node(node)
    variants = node.get("variants")
    if not isinstance(variants, list) or not variants:
        selected_id = "default"
        resolved = copy.deepcopy(dict(node))
    else:
        context = evaluation_state(project, state)
        ordered = sorted(
            enumerate(variants),
            key=lambda item: (-int(item[1].get("priority", 0)), item[0]),
        )
        selected = next(
            (
                variant
                for _, variant in ordered
                if variant.get("default") is not True
                and conditions_match(context, variant.get("conditions", []))
                and self_development_use_matches(project, state, variant.get("self_development"))
            ),
            None,
        )
        selected = selected or next((variant for _, variant in ordered if variant.get("default") is True), ordered[0][1])
        resolved = dict(node)
        for key in ("expression", "line"):
            if key in selected:
                resolved[key] = copy.deepcopy(selected[key])
        selected_id = str(selected.get("id"))
    context = evaluation_state(project, state)
    speaker = effective_speaker(resolved)
    if speaker and not resolved.get("expression"):
        expression = context.get("derived", {}).get("characters", {}).get(speaker, {}).get("default_expression")
        if not expression:
            visual = next(
                (
                    item for item in project.visuals.values()
                    if item.get("kind") == "character" and not item.get("abstract") and item.get("character") == speaker
                ),
                {},
            )
            expression = visual.get("default_expression")
        if expression:
            resolved["expression"] = expression
    return selected_id, resolved


def campaign_act(campaign: Mapping[str, Any], day: int) -> int:
    for act in campaign.get("acts", []):
        days = act.get("days", [])
        if len(days) == 2 and days[0] <= day <= days[1]:
            return int(act.get("number", 1))
    return 1


def can_enter_scene(project: StoryProject, state: Mapping[str, Any], scene_id: str) -> Dict[str, Any]:
    scene = project.scenes.get(scene_id)
    if scene is None:
        return {"scene": scene_id, "allowed": False, "trace": [], "error": "unknown scene"}
    context = evaluation_state(project, state)
    trace = []
    for condition in scene.get("entry_conditions", []):
        actual = get_path(context, condition.get("path", ""), MISSING)
        trace.append({
            "condition": copy.deepcopy(condition),
            "actual": None if actual is MISSING else actual,
            "met": condition_matches(context, condition),
        })
    return {"scene": scene_id, "allowed": all(item["met"] for item in trace), "trace": trace}


class TimelineScheduler:
    """Deterministic event availability and offscreen progression for authoring/runtime."""

    def __init__(self, project: StoryProject, campaign_id: str, state: Optional[Dict[str, Any]] = None):
        self.project = project
        if campaign_id not in project.campaigns:
            raise RuntimeError(f"unknown campaign: {campaign_id}")
        self.campaign_id = campaign_id
        self.campaign = clean_source(project.campaigns[campaign_id])
        self.state = copy.deepcopy(state if state is not None else project.campaign_initial_state(campaign_id))
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
        if event.get("campaign_id") != self.campaign_id:
            return {"event": event_id, "status": "foreign", "reasons": ["다른 캠페인 사건"], "eligible": False}
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
        context = evaluation_state(self.project, self.state)
        for condition in requires.get("conditions", []):
            if not condition_matches(context, condition):
                current = get_path(context, condition.get("path", ""), None)
                reasons.append(
                    f"조건 불충족: {condition.get('path')} {condition.get('op')} "
                    f"{condition.get('value')!r} (현재 {current!r})"
                )
        scene_id = event.get("scene")
        entry_decision = can_enter_scene(self.project, self.state, scene_id) if scene_id else None
        for item in entry_decision["trace"] if entry_decision else []:
            if not item["met"]:
                condition = item["condition"]
                reasons.append(
                    f"장면 진입 조건 불충족: {condition.get('path')} {condition.get('op')} "
                    f"{condition.get('value')!r} (현재 {item['actual']!r})"
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
            if event.get("campaign_id") != self.campaign_id:
                continue
            item = self.inspect_event(event_id, day, slot)
            item["priority"] = event.get("priority", 0)
            item["availability"] = event.get("availability")
            item["lane"] = event.get("lane")
            result.append(item)
        order = {"eligible": 0, "blocked": 1, "upcoming": 2, "seen": 3, "missed": 4, "foreign": 5}
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
            if event.get("campaign_id") != self.campaign_id:
                continue
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
        if processed:
            break_push_pull_flow(self.state)
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
        self.state = copy.deepcopy(
            state if state is not None else project.campaign_initial_state(self.route["campaign_id"])
        )
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
                entry_decision = can_enter_scene(self.project, self.state, scene_id)
                if not entry_decision["allowed"]:
                    raise RuntimeError(
                        f"entry conditions failed: {scene_id}: "
                        f"{json.dumps(entry_decision['trace'], ensure_ascii=False)}"
                    )
                node_id = scene["start_node"]
                self.trace.append({"type": "scene", "scene": scene_id, "title": scene.get("title")})
            node_map = {node["id"]: node for node in scene["nodes"]}
            node = node_map[node_id]
            kind = node["kind"]
            if kind == "silent":
                self.trace.append({
                    "type": "silent",
                    "scene": scene_id,
                    "node": node_id,
                })
                node_id = node["next"]
            elif kind in {"dialogue", "narration"}:
                variant_id, resolved_node = resolve_dialogue_variant(self.project, self.state, node)
                self.trace.append({
                    "type": kind,
                    "scene": scene_id,
                    "node": node_id,
                    "speaker": effective_speaker(resolved_node),
                    "variant": variant_id,
                    "line": resolved_node["line"],
                })
                node_id = node["next"]
            elif kind == "choice":
                enabled = [option for option in node["options"] if choice_option_enabled(self.project, self.state, option)]
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
                score_bonus = self_development_score_bonus(
                    self.project,
                    self.state,
                    selected.get("self_development"),
                )
                applied = []
                for effect in selected.get("effects", []):
                    if apply_effect(self.project, self.state, effect):
                        applied.append(effect)
                push_pull_result = resolve_push_pull(
                    self.project,
                    self.state,
                    selected.get("push_pull", {}).get("target", self.route["heroine"]),
                    selected["push_pull"],
                    score_bonus,
                )
                self.trace.append({
                    "type": "choice",
                    "scene": scene_id,
                    "node": node_id,
                    "option": selected["id"],
                    "label": selected["label"],
                    "action": selected["action"],
                    "push_pull": push_pull_result,
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
                transition = choose_transition(
                    self.state,
                    node["transitions"],
                    project=self.project,
                )
                if transition.get("ending") is True:
                    ending_id = transition["ending_id"]
                    refresh_game_mode_unlocks(self.project, self.state)
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


def maximum_self_development_state(project: StoryProject, state: Mapping[str, Any]) -> Dict[str, Any]:
    result = copy.deepcopy(dict(state))
    stats = project.manifest.get("stats", {})
    appeal_path = f"{SELF_DEVELOPMENT_STATE_PREFIX}.appeal"
    fatigue_path = f"{SELF_DEVELOPMENT_STATE_PREFIX}.fatigue"
    appeal_spec = stats.get(appeal_path, {}) if isinstance(stats, Mapping) else {}
    fatigue_spec = stats.get(fatigue_path, {}) if isinstance(stats, Mapping) else {}
    set_path(result, appeal_path, int(appeal_spec.get("max", 100)))
    set_path(result, fatigue_path, int(fatigue_spec.get("min", 0)))
    for stat in sorted(SELF_DEVELOPMENT_STATS):
        path = f"{SELF_DEVELOPMENT_STATE_PREFIX}.stats.{stat}"
        spec = stats.get(path, {}) if isinstance(stats, Mapping) else {}
        set_path(result, path, int(spec.get("max", 5)))
    return result


def explore_route(
    project: StoryProject,
    route_id: str,
    state: Optional[Dict[str, Any]] = None,
    max_states: int = 100_000,
) -> Dict[str, Any]:
    """Explore every reachable choice branch for one route.

    The explorer follows runtime transition precedence exactly while forking at
    each enabled player choice. A canonical state fingerprint prevents loops
    from hiding behind different paths and keeps the traversal deterministic.
    """
    if route_id not in project.routes:
        raise RuntimeError(f"unknown route: {route_id}")
    route = project.routes[route_id]
    initial_state = copy.deepcopy(
        state if state is not None else project.campaign_initial_state(route["campaign_id"])
    )
    if not conditions_match(initial_state, route.get("unlock_conditions", [])):
        raise RuntimeError(f"route is locked for current state: {route_id}")

    profiles = [initial_state, maximum_self_development_state(project, initial_state)]
    queue: List[Tuple[str, Optional[str], Dict[str, Any], Tuple[str, ...]]] = []
    profile_fingerprints: Set[str] = set()
    for profile in profiles:
        fingerprint = json.dumps(profile, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if fingerprint in profile_fingerprints:
            continue
        profile_fingerprints.add(fingerprint)
        queue.append((route["entry_scene"], None, profile, ()))
    visited: Set[Tuple[str, str, str]] = set()
    covered_options: Set[str] = set()
    reached_endings: Set[str] = set()
    completed_paths = 0

    while queue:
        scene_id, node_id, current_state, path = queue.pop()
        scene = project.scenes.get(scene_id)
        if scene is None:
            raise RuntimeError(f"unknown scene during exploration: {scene_id}")
        if node_id is None:
            entry_decision = can_enter_scene(project, current_state, scene_id)
            if not entry_decision["allowed"]:
                raise RuntimeError(
                    f"entry conditions failed during exploration: {scene_id}: "
                    f"{json.dumps(entry_decision['trace'], ensure_ascii=False)}"
                )
            node_id = scene["start_node"]

        state_key = json.dumps(current_state, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        visit_key = (scene_id, node_id, state_key)
        if visit_key in visited:
            continue
        visited.add(visit_key)
        if len(visited) > max_states:
            raise RuntimeError(f"route exploration exceeded {max_states} unique states: {route_id}")

        node_map = {node["id"]: node for node in scene["nodes"]}
        node = node_map.get(node_id)
        if node is None:
            raise RuntimeError(f"unknown node during exploration: {scene_id}:{node_id}")
        kind = node["kind"]

        if kind in {"dialogue", "narration", "silent"}:
            queue.append((scene_id, node["next"], current_state, path))
        elif kind == "choice":
            enabled = [
                option for option in node["options"]
                if choice_option_enabled(project, current_state, option)
            ]
            if not enabled:
                raise RuntimeError(f"no enabled option during exploration: {scene_id}:{node_id}")
            for option in enabled:
                next_state = copy.deepcopy(current_state)
                score_bonus = self_development_score_bonus(
                    project,
                    current_state,
                    option.get("self_development"),
                )
                for effect in option.get("effects", []):
                    apply_effect(project, next_state, effect)
                resolve_push_pull(
                    project,
                    next_state,
                    option.get("push_pull", {}).get("target", route["heroine"]),
                    option["push_pull"],
                    score_bonus,
                )
                option_key = f"{scene_id}:{node_id}={option['id']}"
                covered_options.add(option_key)
                queue.append((scene_id, option["next"], next_state, (*path, option_key)))
        elif kind == "state_gate":
            transition = choose_transition(current_state, node["transitions"])
            queue.append((scene_id, transition["node"], current_state, path))
        elif kind == "effect":
            next_state = copy.deepcopy(current_state)
            for effect in node.get("effects", []):
                apply_effect(project, next_state, effect)
            queue.append((scene_id, node["next"], next_state, path))
        elif kind == "exit":
            transition = choose_transition(current_state, node["transitions"], project=project)
            if transition.get("ending") is True:
                reached_endings.add(transition["ending_id"])
                completed_paths += 1
            else:
                queue.append((transition["scene"], None, current_state, path))
        else:
            raise RuntimeError(f"unsupported node kind during exploration: {kind}")

    expected_options = {
        f"{scene_id}:{node['id']}={option['id']}"
        for scene_id, scene in project.scenes.items()
        if scene.get("route") == route_id
        for node in scene.get("nodes", [])
        if node.get("kind") == "choice"
        for option in node.get("options", [])
    }
    missing_options = sorted(expected_options - covered_options)
    if missing_options:
        raise RuntimeError(
            f"route exploration found unreachable choice options for {route_id}: "
            f"{', '.join(missing_options)}"
        )
    if not reached_endings:
        raise RuntimeError(f"route exploration reached no ending: {route_id}")
    return {
        "route": route_id,
        "states": len(visited),
        "choice_options": len(covered_options),
        "completed_paths": completed_paths,
        "endings": sorted(reached_endings),
    }


def choose_transition(
    state: Mapping[str, Any],
    transitions: Sequence[Mapping[str, Any]],
    project: Optional[StoryProject] = None,
) -> Mapping[str, Any]:
    for transition in transitions:
        if transition.get("default") is not True and not conditions_match(state, transition.get("conditions", [])):
            continue
        scene_id = transition.get("scene")
        if project and scene_id:
            if not can_enter_scene(project, state, scene_id)["allowed"]:
                continue
        return transition
    raise RuntimeError("scene-entry-rejected: no transition and target entry conditions matched")


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
        elif event_type in {"dialogue", "narration"}:
            speaker = f" [{event['speaker']}]" if event.get("speaker") else ""
            print(f"  {event_type}{speaker}")
            print(f"    {event['line']}")
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


def render_json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_json(data), encoding="utf-8")


def localization_types_source(bundle: Mapping[str, Any]) -> str:
    entries = bundle["localization"]["entries"]
    all_keys = sorted(entries)
    ui_keys = [key for key in all_keys if entries[key]["domain"] == "ui"]
    lines = [
        "/* Generated by tools/story_harness.py build. Do not edit. */",
        f"export const LOCALIZATION_KEYS = {json.dumps(all_keys, ensure_ascii=False, indent=2)} as const;",
        "export type LocalizationKey = (typeof LOCALIZATION_KEYS)[number];",
        "",
        f"export const UI_MESSAGE_KEYS = {json.dumps(ui_keys, ensure_ascii=False, indent=2)} as const;",
        "export type UiMessageKey = (typeof UI_MESSAGE_KEYS)[number];",
        "",
    ]
    return "\n".join(lines)


def write_localization_types(bundle: Mapping[str, Any]) -> None:
    path = PROJECT_ROOT / "src/generated/localizationKeys.ts"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(localization_types_source(bundle), encoding="utf-8")


def localization_report(bundle: Mapping[str, Any], issues: Sequence[Issue], profile: str) -> Dict[str, Any]:
    localization = bundle["localization"]
    entries = localization["entries"]
    scene_ids = sorted({
        entry.get("context", {}).get("sceneId")
        for entry in entries.values()
        if entry.get("context", {}).get("sceneId")
    })
    scene_coverage: Dict[str, Dict[str, Dict[str, int]]] = {}
    narrative_entries = {
        key: entry for key, entry in entries.items()
        if is_player_narrative_entry(entry)
    }
    editable_narrative = {
        key: entry for key, entry in narrative_entries.items()
        if narrative_entry_has_direct_editor_target(entry)
    }
    for scene_id in scene_ids:
        scene_keys = [
            key for key, entry in entries.items()
            if entry.get("context", {}).get("sceneId") == scene_id
        ]
        scene_coverage[scene_id] = {}
        for locale_id in localization["supported_locales"]:
            direct = localization["direct_catalogs"].get(locale_id, {})
            resolved = localization["resolved_catalogs"].get(locale_id, {})
            direct_count = len(scene_keys) if locale_id == localization["default_locale"] else sum(key in direct for key in scene_keys)
            resolved_count = sum(key in resolved for key in scene_keys)
            scene_coverage[scene_id][locale_id] = {
                "total": len(scene_keys),
                "direct": direct_count,
                "fallback": max(0, resolved_count - direct_count),
                "missing": len(scene_keys) - resolved_count,
            }
    return {
        "schema_version": 2,
        "generated_at": bundle["generated_at"],
        "source_sha256": bundle["source_sha256"],
        "profile": profile,
        "default_locale": localization["default_locale"],
        "supported_locales": localization["supported_locales"],
        "total_entries": len(entries),
        "coverage": localization["coverage"],
        "scene_coverage": scene_coverage,
        "authoring_coverage": {
            "narrative_text_units": len(narrative_entries),
            "editable_units": len(editable_narrative),
            "missing_editor_target": sorted(set(narrative_entries) - set(editable_narrative)),
            "generated_only": 0,
            "multiple_source_owners": 0,
            "narrative_text_in_ui_yaml": 0,
            "narrative_text_in_manifest": 0,
        },
        "issues": [
            {"severity": issue.severity, "location": issue.location, "message": issue.message}
            for issue in issues
            if "locale" in issue.location or "localization" in issue.location or "translation" in issue.message
        ],
    }


def generated_build_outputs(
    project: StoryProject,
    bundle: Mapping[str, Any],
    issues: Sequence[Issue],
    profile: str,
) -> Dict[Path, str]:
    return {
        PROJECT_ROOT / project.manifest["build"]["runtime_output"]: render_json(bundle),
        PROJECT_ROOT / "build/localization-report.json": render_json(localization_report(bundle, issues, profile)),
        PROJECT_ROOT / "src/generated/localizationKeys.ts": localization_types_source(bundle),
    }


def command_validate(project: StoryProject, args: argparse.Namespace) -> int:
    issues = project.validate(args.profile)
    for issue in issues:
        print(issue.render())
    errors = [issue for issue in issues if issue.severity == "error"]
    warnings = [issue for issue in issues if issue.severity == "warning"]
    print(
        f"Validated {len(project.campaigns)} campaign, {len(project.events)} events, "
        f"{len(project.threads)} threads, {len(project.characters)} characters, "
        f"{len(project.locales)} locales, {len(project.visuals)} visuals, "
        f"{len(project.world)} world entities, {len(project.routes)} routes, "
        f"{len(project.scenes)} scenes: "
        f"{len(errors)} errors, {len(warnings)} warnings"
    )
    if not errors:
        bundle = project.build_bundle()
        write_json(PROJECT_ROOT / "build/localization-report.json", localization_report(bundle, issues, args.profile))
    return 1 if errors else 0


def command_build(project: StoryProject, args: argparse.Namespace) -> int:
    issues = project.validate(args.profile)
    errors = [issue for issue in issues if issue.severity == "error"]
    if errors:
        for issue in issues:
            print(issue.render(), file=sys.stderr)
        print("Build aborted because validation failed.", file=sys.stderr)
        return 1
    bundle = project.build_bundle()
    if args.check:
        if args.out:
            raise RuntimeError("build --check cannot be combined with --out")
        stale = []
        for path, expected in generated_build_outputs(project, bundle, issues, args.profile).items():
            actual = path.read_text(encoding="utf-8") if path.exists() else None
            if actual != expected:
                stale.append(str(path.relative_to(PROJECT_ROOT)))
        if stale:
            print(
                "Generated build artifacts are stale: " + ", ".join(stale),
                file=sys.stderr,
            )
            print("Run: python3 tools/story_harness.py build", file=sys.stderr)
            return 1
        print("Generated build artifacts match the story sources.")
        return 0

    output = Path(args.out) if args.out else PROJECT_ROOT / project.manifest["build"]["runtime_output"]
    write_json(output, bundle)
    if not args.out:
        write_localization_types(bundle)
        write_json(PROJECT_ROOT / "build/localization-report.json", localization_report(bundle, issues, args.profile))
    print(f"Built runtime story: {output}")
    if not args.out:
        print(f"Built localization report: {PROJECT_ROOT / 'build/localization-report.json'}")
    return 0


def command_simulate(project: StoryProject, args: argparse.Namespace) -> int:
    if args.route not in project.routes:
        raise RuntimeError(f"unknown route: {args.route}")
    campaign_id = project.routes[args.route]["campaign_id"]
    state = parse_state_overrides(args.state, project.campaign_initial_state(campaign_id))
    simulator = Simulator(project, args.route, parse_choice_overrides(args.choose), args.strategy, state)
    result = simulator.run(max_steps=args.max_steps)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_simulation(result)
    return 0


def command_explore(project: StoryProject, args: argparse.Namespace) -> int:
    route_ids = [args.route] if args.route else sorted(project.routes)
    results = [explore_route(project, route_id, max_states=args.max_states) for route_id in route_ids]
    if args.json:
        print(json.dumps({"routes": results}, ensure_ascii=False, indent=2))
    else:
        for result in results:
            print(
                f"EXPLORED {result['route']}: {result['states']} states, "
                f"{result['choice_options']} choice options, "
                f"{result['completed_paths']} completed paths, "
                f"{len(result['endings'])} endings"
            )
    return 0


def command_night(project: StoryProject, args: argparse.Namespace) -> int:
    campaign = project.campaigns.get(args.campaign)
    if campaign is None:
        raise RuntimeError(f"unknown campaign: {args.campaign}")
    if campaign.get("systems", {}).get("self_development") is not True:
        raise RuntimeError(f"self-development is disabled for campaign: {args.campaign}")
    state = parse_state_overrides(args.state, project.campaign_initial_state(args.campaign))
    set_path(state, "progress.time.day", args.day)
    set_path(state, "progress.time.slot", "after_work")
    set_path(state, "progress.time.act", campaign_act(campaign, args.day))

    service = SelfDevelopmentService(project)
    coordinator = NightPhaseCoordinator(service)
    profile_before = service.profile(state)
    options = service.activity_options(state)
    available_before = coordinator.should_start(state)
    status = "intro" if available_before else "unavailable"
    result = None
    finished = None
    phase = None

    if available_before:
        intro = coordinator.start(state)
        phase = coordinator.continue_intro(state, intro)
        status = phase["status"]
        if status == "result":
            result = phase["result"]
            finished = coordinator.finish(state)
            status = finished["status"]

    if args.activity and status == "selecting":
        if not available_before:
            raise NightPhaseError(
                "not_available",
                f"night phase is unavailable on day {args.day}",
            )
        selected = coordinator.choose(state, args.activity)
        result = selected["result"]
        finished = coordinator.finish(state)
        status = finished["status"]

    payload = {
        "day": args.day,
        "slot": "after_work",
        "act": get_path(state, "progress.time.act", None),
        "available_before": available_before,
        "available": coordinator.should_start(state),
        "status": status,
        "profile_before": profile_before,
        "options": options,
        "result": result,
        "profile": service.profile(state),
        "progress": service.progress(state),
        "state": state,
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    profile = payload["profile_before"]
    stats = " ".join(f"{stat}={profile['stats'][stat]}" for stat in SELF_DEVELOPMENT_STAT_ORDER)
    print(f"DAY {args.day} · NIGHT · ACT {payload['act']} · {status.upper()}")
    print(f"PROFILE appeal={profile['appeal']} fatigue={profile['fatigue']} {stats}")
    for option in options:
        marker = "AVAILABLE" if option["available"] else "BLOCKED"
        reason = f" ({option['reason']})" if option.get("reason") else ""
        print(f"  {marker:9} {option['activity']['id']}{reason}")
    if result:
        deltas = [
            f"appeal={result['appeal_delta']:+d}",
            f"fatigue={result['fatigue_delta']:+d}",
            *(f"{stat}={delta:+d}" for stat, delta in result["stat_deltas"].items()),
        ]
        print(f"PERFORMED {result['activity']}: {' '.join(deltas)}")
        after = payload["profile"]
        after_stats = " ".join(
            f"{stat}={after['stats'][stat]}" for stat in SELF_DEVELOPMENT_STAT_ORDER
        )
        print(f"PROFILE appeal={after['appeal']} fatigue={after['fatigue']} {after_stats}")
    return 0


def command_timeline(project: StoryProject, args: argparse.Namespace) -> int:
    state = parse_state_overrides(args.state, project.campaign_initial_state(args.campaign))
    scheduler = TimelineScheduler(project, args.campaign, state)
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
    scene = project.scenes.get(args.scene)
    if scene is None:
        raise RuntimeError(f"unknown scene: {args.scene}")
    route = project.routes.get(args.from_route or scene.get("route"))
    if route is None:
        raise RuntimeError(f"cannot resolve campaign for scene: {args.scene}")
    state = parse_state_overrides(args.state, project.campaign_initial_state(route["campaign_id"]))
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
                "kind": "narration",
                "line": "TODO",
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
    validate_parser.add_argument("--profile", default="development")
    validate_parser.set_defaults(func=command_validate)

    build_parser_ = subparsers.add_parser("build", help="compile runtime JSON")
    build_parser_.add_argument("--out")
    build_parser_.add_argument("--profile", default="development")
    build_parser_.add_argument("--check", action="store_true", help="fail when tracked generated outputs are stale")
    build_parser_.set_defaults(func=command_build)

    simulate_parser = subparsers.add_parser("simulate", help="simulate a route")
    simulate_parser.add_argument("--route", required=True)
    simulate_parser.add_argument("--choose", action="append", default=[], help="SCENE[:NODE]=OPTION")
    simulate_parser.add_argument("--state", action="append", default=[], help="PATH=JSON")
    simulate_parser.add_argument("--strategy", choices=["first", "last"], default="first")
    simulate_parser.add_argument("--max-steps", type=int, default=500)
    simulate_parser.add_argument("--json", action="store_true")
    simulate_parser.set_defaults(func=command_simulate)

    explore_parser = subparsers.add_parser("explore", help="explore every reachable choice branch")
    explore_parser.add_argument("--route")
    explore_parser.add_argument("--max-states", type=int, default=100_000)
    explore_parser.add_argument("--json", action="store_true")
    explore_parser.set_defaults(func=command_explore)

    night_parser = subparsers.add_parser(
        "night",
        help="inspect or perform a nightly self-development activity",
    )
    night_parser.add_argument("--campaign", required=True)
    night_parser.add_argument("--day", type=int, required=True)
    night_parser.add_argument("--activity")
    night_parser.add_argument("--state", action="append", default=[], help="PATH=JSON")
    night_parser.add_argument("--json", action="store_true")
    night_parser.set_defaults(func=command_night)

    timeline_parser = subparsers.add_parser("timeline", help="inspect scheduled events at a day and slot")
    timeline_parser.add_argument("--campaign", required=True)
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
