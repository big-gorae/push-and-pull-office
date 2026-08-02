"""Compile nightly-activity dialogue templates into runtime variants.

This module is intentionally independent from the story harness.  Story YAML can
keep one fallback pair of dialogue layers plus a small authoring template, while
the build boundary expands that source into the ordinary ``variants`` shape the
runtime already understands.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Sequence, Tuple


_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
_SLOT_PATTERN = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")


class SelfDevelopmentDialogueTemplateError(ValueError):
    """Raised when an authoring template cannot be expanded safely."""


@dataclass(frozen=True)
class ConversationTopic:
    """One activity-to-dialogue-variant binding from the manifest."""

    activity_id: str
    variant_id: str
    expression: str
    slots: Mapping[str, Any]
    priority: int


class SelfDevelopmentDialogueCompiler:
    """Expand ``self_development_template`` nodes without mutating source data."""

    def __init__(self, self_development_config: Mapping[str, Any]):
        if not isinstance(self_development_config, Mapping):
            raise SelfDevelopmentDialogueTemplateError(
                "self_development config must be a mapping"
            )
        self._config = copy.deepcopy(dict(self_development_config))

    def compile_node(self, node: Mapping[str, Any]) -> Dict[str, Any]:
        """Return a runtime-ready copy of one dialogue or narration node.

        Nodes without ``self_development_template`` are still copied so callers
        can safely treat compilation as a pure normalization pass.
        """
        if not isinstance(node, Mapping):
            raise SelfDevelopmentDialogueTemplateError("story node must be a mapping")

        compiled = copy.deepcopy(dict(node))
        raw_template = node.get("self_development_template")
        if raw_template is None:
            return compiled

        node_id = str(node.get("id", "<unknown>"))
        if node.get("kind") not in {"dual_dialogue", "dual_narration"}:
            raise SelfDevelopmentDialogueTemplateError(
                f"node {node_id}: self_development_template is only valid on dual dialogue or narration nodes"
            )
        template = self._validate_template(raw_template, node_id)
        if "variants" in node:
            raise SelfDevelopmentDialogueTemplateError(
                f"node {node_id}: self_development_template cannot be combined with variants"
            )

        base_layers: Dict[str, Mapping[str, Any]] = {}
        for layer_name in ("perceived", "reality"):
            base_layer = node.get(layer_name)
            if not isinstance(base_layer, Mapping):
                raise SelfDevelopmentDialogueTemplateError(
                    f"node {node_id}: {layer_name} base layer must be a mapping"
                )
            base_layers[layer_name] = base_layer

        variants: List[Dict[str, Any]] = []
        for topic in self._conversation_topics(node_id):
            variant: Dict[str, Any] = {
                "id": topic.variant_id,
                "priority": topic.priority,
                "self_development": {"expression": topic.expression},
            }
            for layer_name in ("perceived", "reality"):
                layer = copy.deepcopy(dict(base_layers[layer_name]))
                overlay = template.get(layer_name)
                if isinstance(overlay, Mapping):
                    for field_name, field_template in overlay.items():
                        layer[field_name] = self._render_scalar(
                            field_template,
                            topic.slots,
                            node_id=node_id,
                            activity_id=topic.activity_id,
                            layer_name=layer_name,
                            field_name=field_name,
                        )
                variant[layer_name] = layer
            variants.append(variant)

        variants.append(
            {
                "id": "default",
                "default": True,
                "perceived": copy.deepcopy(dict(base_layers["perceived"])),
                "reality": copy.deepcopy(dict(base_layers["reality"])),
            }
        )

        compiled.pop("self_development_template", None)
        compiled.pop("perceived", None)
        compiled.pop("reality", None)
        compiled["variants"] = variants
        return compiled

    def compile_scene(self, scene: Mapping[str, Any]) -> Dict[str, Any]:
        """Return a copy of a scene with every template node expanded."""
        if not isinstance(scene, Mapping):
            raise SelfDevelopmentDialogueTemplateError("story scene must be a mapping")

        compiled = copy.deepcopy(dict(scene))
        nodes = scene.get("nodes")
        if nodes is None:
            return compiled
        if not isinstance(nodes, Sequence) or isinstance(nodes, (str, bytes)):
            raise SelfDevelopmentDialogueTemplateError("scene nodes must be a sequence")
        compiled["nodes"] = [self.compile_node(node) for node in nodes]
        return compiled

    @staticmethod
    def _validate_template(raw_template: Any, node_id: str) -> Mapping[str, Any]:
        if not isinstance(raw_template, Mapping):
            raise SelfDevelopmentDialogueTemplateError(
                f"node {node_id}: self_development_template must be a mapping"
            )
        if raw_template.get("source") != "last_activity":
            raise SelfDevelopmentDialogueTemplateError(
                f"node {node_id}: self_development_template.source must be last_activity"
            )

        allowed_keys = {"source", "perceived", "reality"}
        unknown_keys = sorted(set(raw_template) - allowed_keys)
        if unknown_keys:
            raise SelfDevelopmentDialogueTemplateError(
                f"node {node_id}: unsupported self_development_template fields: "
                f"{', '.join(unknown_keys)}"
            )

        allowed_layer_fields = {
            "perceived": {"atmosphere", "expression", "line"},
            "reality": {"atmosphere", "expression", "line", "intent"},
        }
        present_layers = 0
        for layer_name in ("perceived", "reality"):
            overlay = raw_template.get(layer_name)
            if overlay is None:
                continue
            present_layers += 1
            if not isinstance(overlay, Mapping):
                raise SelfDevelopmentDialogueTemplateError(
                    f"node {node_id}: template {layer_name} layer must be a mapping"
                )
            unknown_fields = sorted(set(overlay) - allowed_layer_fields[layer_name])
            if unknown_fields:
                raise SelfDevelopmentDialogueTemplateError(
                    f"node {node_id}: unsupported template {layer_name} fields: "
                    f"{', '.join(unknown_fields)}"
                )
            if "line" not in overlay:
                raise SelfDevelopmentDialogueTemplateError(
                    f"node {node_id}: template {layer_name} layer requires line"
                )
            for field_name, value in overlay.items():
                if not isinstance(value, str):
                    raise SelfDevelopmentDialogueTemplateError(
                        f"node {node_id}: template {layer_name}.{field_name} must be a string"
                    )
        if present_layers == 0:
            raise SelfDevelopmentDialogueTemplateError(
                f"node {node_id}: self_development_template needs a perceived or reality layer"
            )
        return raw_template

    def _conversation_topics(self, node_id: str) -> Tuple[ConversationTopic, ...]:
        activities = self._config.get("activities")
        if not isinstance(activities, Sequence) or isinstance(activities, (str, bytes)):
            raise SelfDevelopmentDialogueTemplateError(
                f"node {node_id}: self_development.activities must be a sequence"
            )
        raw_topics = self._config.get("conversation_topics")
        if not isinstance(raw_topics, Mapping):
            raise SelfDevelopmentDialogueTemplateError(
                f"node {node_id}: self_development.conversation_topics must be a mapping"
            )

        activity_ids: List[str] = []
        for index, activity in enumerate(activities):
            if not isinstance(activity, Mapping):
                raise SelfDevelopmentDialogueTemplateError(
                    f"node {node_id}: activity at index {index} must be a mapping"
                )
            activity_id = activity.get("id")
            if not isinstance(activity_id, str) or not _ID_PATTERN.fullmatch(activity_id):
                raise SelfDevelopmentDialogueTemplateError(
                    f"node {node_id}: activity at index {index} has an invalid id"
                )
            if activity_id in activity_ids:
                raise SelfDevelopmentDialogueTemplateError(
                    f"node {node_id}: duplicate activity id {activity_id}"
                )
            activity_ids.append(activity_id)

        unknown_topic_ids = sorted(set(raw_topics) - set(activity_ids))
        if unknown_topic_ids:
            raise SelfDevelopmentDialogueTemplateError(
                f"node {node_id}: conversation topics reference unknown activities: "
                f"{', '.join(unknown_topic_ids)}"
            )

        topics: List[ConversationTopic] = []
        for index, activity_id in enumerate(activity_ids):
            raw_topic = raw_topics.get(activity_id)
            if not isinstance(raw_topic, Mapping):
                raise SelfDevelopmentDialogueTemplateError(
                    f"node {node_id}: missing conversation topic for activity {activity_id}"
                )

            expected_variant_id = f"after_{activity_id}"
            variant_id = raw_topic.get("variant_id")
            if variant_id != expected_variant_id:
                raise SelfDevelopmentDialogueTemplateError(
                    f"node {node_id}: conversation topic {activity_id} variant_id must be "
                    f"{expected_variant_id}"
                )
            expression = raw_topic.get("expression")
            if not isinstance(expression, str) or not expression.strip():
                raise SelfDevelopmentDialogueTemplateError(
                    f"node {node_id}: conversation topic {activity_id} needs an expression"
                )
            slots = raw_topic.get("slots")
            if not isinstance(slots, Mapping):
                raise SelfDevelopmentDialogueTemplateError(
                    f"node {node_id}: conversation topic {activity_id} slots must be a mapping"
                )

            topics.append(
                ConversationTopic(
                    activity_id=activity_id,
                    variant_id=variant_id,
                    expression=expression,
                    slots=slots,
                    priority=100 - (index * 10),
                )
            )
        return tuple(topics)

    @staticmethod
    def _render_scalar(
        template: str,
        slots: Mapping[str, Any],
        *,
        node_id: str,
        activity_id: str,
        layer_name: str,
        field_name: str,
    ) -> str:
        referenced_slots = set(_SLOT_PATTERN.findall(template))
        unknown_slots = sorted(referenced_slots - set(slots))
        if unknown_slots:
            raise SelfDevelopmentDialogueTemplateError(
                f"node {node_id} activity {activity_id} {layer_name}.{field_name}: "
                f"unknown template slots: "
                f"{', '.join(unknown_slots)}"
            )

        for slot_name in sorted(referenced_slots):
            value = slots[slot_name]
            if not isinstance(value, str):
                raise SelfDevelopmentDialogueTemplateError(
                    f"node {node_id} activity {activity_id} {layer_name}.{field_name}: "
                    f"referenced slot {slot_name} must be a string"
                )
            if not value.strip():
                raise SelfDevelopmentDialogueTemplateError(
                    f"node {node_id} activity {activity_id} {layer_name}.{field_name}: "
                    f"referenced slot {slot_name} must not be empty"
                )

        rendered = _SLOT_PATTERN.sub(lambda match: slots[match.group(1)], template)
        if "{{" in rendered or "}}" in rendered:
            raise SelfDevelopmentDialogueTemplateError(
                f"node {node_id} activity {activity_id} {layer_name}.{field_name}: "
                "malformed template slot"
            )
        return rendered


def compile_dialogue_node(
    node: Mapping[str, Any],
    self_development_config: Mapping[str, Any],
) -> Dict[str, Any]:
    """Functional entry point for compiling one node."""
    return SelfDevelopmentDialogueCompiler(self_development_config).compile_node(node)


def compile_scene(
    scene: Mapping[str, Any],
    self_development_config: Mapping[str, Any],
) -> Dict[str, Any]:
    """Functional entry point for compiling every node in one scene."""
    return SelfDevelopmentDialogueCompiler(self_development_config).compile_scene(scene)
