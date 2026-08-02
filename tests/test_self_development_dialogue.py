import copy
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from self_development_dialogue import (  # noqa: E402
    SelfDevelopmentDialogueCompiler,
    SelfDevelopmentDialogueTemplateError,
    compile_dialogue_node,
    compile_scene,
)


ACTIVITY_IDS = ("workout", "grooming", "ott", "reels", "sleep")


def make_config():
    # Deliberately reverse topic insertion order: manifest activities own the
    # deterministic runtime order.
    topics = {}
    for activity_id in reversed(ACTIVITY_IDS):
        topics[activity_id] = {
            "variant_id": f"after_{activity_id}",
            "expression": f"feedback.last_{activity_id}",
            "slots": {
                "opener": f"{activity_id} 이야기를 먼저 꺼냈다.",
                "pitch": f"{activity_id}도 자기관리라고 말했다.",
                "unused_for_this_scene": "다른 장면 템플릿에서 쓰는 문장",
            },
        }
    return {
        "activities": [{"id": activity_id} for activity_id in ACTIVITY_IDS],
        "conversation_topics": topics,
    }


def make_node():
    return {
        "id": "activity_callback",
        "kind": "dual_dialogue",
        "speaker": "han_do_yoon",
        "perceived": {
            "atmosphere": "warm_romance",
            "expression": "subjective_confident",
            "line": "오늘은 업무 이야기부터 하지.",
        },
        "reality": {
            "atmosphere": "procedural",
            "expression": "actual_neutral",
            "line": "회의 안건부터 확인하겠습니다.",
            "intent": "work_only",
        },
        "self_development_template": {
            "source": "last_activity",
            "perceived": {
                "atmosphere": "warm_self_promotion",
                "line": "{{ opener }} {{pitch}}",
            },
            "reality": {
                "line": "{{opener}}",
                "intent": "self_promotion",
            },
        },
        "next": "activity_response",
    }


class SelfDevelopmentDialogueCompilerTests(unittest.TestCase):
    def test_expands_manifest_activity_order_to_stable_runtime_variants(self):
        compiled = compile_dialogue_node(make_node(), make_config())

        self.assertNotIn("self_development_template", compiled)
        self.assertNotIn("perceived", compiled)
        self.assertNotIn("reality", compiled)
        self.assertEqual(
            [*(f"after_{activity_id}" for activity_id in ACTIVITY_IDS), "default"],
            [variant["id"] for variant in compiled["variants"]],
        )

        workout = compiled["variants"][0]
        self.assertEqual(100, workout["priority"])
        self.assertEqual(
            {"expression": "feedback.last_workout"},
            workout["self_development"],
        )
        self.assertEqual(
            "workout 이야기를 먼저 꺼냈다. workout도 자기관리라고 말했다.",
            workout["perceived"]["line"],
        )
        self.assertEqual("self_promotion", workout["reality"]["intent"])
        self.assertEqual("procedural", workout["reality"]["atmosphere"])
        self.assertEqual("warm_self_promotion", workout["perceived"]["atmosphere"])
        self.assertEqual("subjective_confident", workout["perceived"]["expression"])

        default = compiled["variants"][-1]
        self.assertEqual(
            {
                "id": "default",
                "default": True,
                "perceived": make_node()["perceived"],
                "reality": make_node()["reality"],
            },
            default,
        )

    def test_scene_compilation_and_compiler_are_pure(self):
        config = make_config()
        scene = {
            "id": "common.template_test",
            "nodes": [make_node(), {"id": "exit", "kind": "exit", "transitions": []}],
        }
        original_scene = copy.deepcopy(scene)
        original_config = copy.deepcopy(config)

        compiler = SelfDevelopmentDialogueCompiler(config)
        compiled = compiler.compile_scene(scene)
        functional = compile_scene(scene, config)

        self.assertEqual(compiled, functional)
        self.assertEqual(original_scene, scene)
        self.assertEqual(original_config, config)
        self.assertIsNot(compiled, scene)
        self.assertIsNot(compiled["nodes"][1], scene["nodes"][1])

        compiled["nodes"][0]["variants"][0]["perceived"]["line"] = "changed"
        self.assertEqual(original_scene, scene)
        self.assertEqual(original_config, config)

    def test_unknown_template_slot_is_rejected_but_unused_slots_are_allowed(self):
        node = make_node()
        node["self_development_template"]["reality"]["line"] = "{{not_registered}}"

        with self.assertRaisesRegex(
            SelfDevelopmentDialogueTemplateError,
            "unknown template slots: not_registered",
        ):
            compile_dialogue_node(node, make_config())

        # The normal fixture contains unused_for_this_scene and compiles.
        compile_dialogue_node(make_node(), make_config())

    def test_missing_or_empty_referenced_slots_are_rejected(self):
        missing_slots = make_config()
        del missing_slots["conversation_topics"]["workout"]["slots"]
        with self.assertRaisesRegex(
            SelfDevelopmentDialogueTemplateError,
            "workout slots must be a mapping",
        ):
            compile_dialogue_node(make_node(), missing_slots)

        empty_slot = make_config()
        empty_slot["conversation_topics"]["workout"]["slots"]["opener"] = "  "
        with self.assertRaisesRegex(
            SelfDevelopmentDialogueTemplateError,
            "referenced slot opener must not be empty",
        ):
            compile_dialogue_node(make_node(), empty_slot)

    def test_invalid_variant_id_and_malformed_slot_are_rejected(self):
        invalid_variant = make_config()
        invalid_variant["conversation_topics"]["workout"]["variant_id"] = "workout"
        with self.assertRaisesRegex(
            SelfDevelopmentDialogueTemplateError,
            "variant_id must be after_workout",
        ):
            compile_dialogue_node(make_node(), invalid_variant)

        malformed = make_node()
        malformed["self_development_template"]["perceived"]["line"] = "{{ opener"
        with self.assertRaisesRegex(
            SelfDevelopmentDialogueTemplateError,
            "malformed template slot",
        ):
            compile_dialogue_node(malformed, make_config())

    def test_template_layers_can_override_allowed_scalars_but_not_speakers(self):
        node = make_node()
        node["self_development_template"]["reality"]["speaker"] = "yoon_seo_a"

        with self.assertRaisesRegex(
            SelfDevelopmentDialogueTemplateError,
            "unsupported template reality fields: speaker",
        ):
            compile_dialogue_node(node, make_config())

    def test_template_is_rejected_on_non_dialogue_nodes(self):
        node = make_node()
        node["kind"] = "choice"

        with self.assertRaisesRegex(
            SelfDevelopmentDialogueTemplateError,
            "only valid on dual dialogue or narration nodes",
        ):
            compile_dialogue_node(node, make_config())

    def test_one_layer_overlay_leaves_the_other_activity_layer_unchanged(self):
        node = make_node()
        del node["self_development_template"]["perceived"]

        compiled = compile_dialogue_node(node, make_config())

        workout = compiled["variants"][0]
        self.assertEqual(node["perceived"], workout["perceived"])
        self.assertEqual("self_promotion", workout["reality"]["intent"])


if __name__ == "__main__":
    unittest.main()
