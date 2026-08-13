import copy
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from story_harness import (  # noqa: E402
    StoryProject,
    collect_localizable_entries,
    resolve_dialogue_variant,
    set_path,
)


class MaterializedSelfDevelopmentDialogueTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.project = StoryProject(ROOT / "story")

    def test_every_callback_is_an_explicit_editable_variant(self):
        expected_ids = [
            "after_workout",
            "after_reading",
            "after_ott",
            "after_sleep",
            "after_dark_psychology",
            "after_solo_drinking",
            "default",
        ]
        callbacks = []
        for scene in self.project.scenes.values():
            for node in scene.get("nodes", []):
                variants = node.get("variants", [])
                if any(
                    isinstance(variant, dict)
                    and isinstance(variant.get("self_development"), dict)
                    and "expression" in variant["self_development"]
                    for variant in variants
                ):
                    callbacks.append(node)
                    self.assertEqual(expected_ids, [variant["id"] for variant in variants])
                    self.assertNotIn("self_development_template", node)
                    for variant in variants:
                        self.assertTrue(variant["line"])
        self.assertEqual(8, len(callbacks))
        self.assertNotIn("conversation_topics", self.project.manifest["self_development"])

    def test_last_activity_selects_the_materialized_line(self):
        scene = self.project.scenes["common.day_02_practical_meeting"]
        node = next(item for item in scene["nodes"] if item["id"] == "day_one_activity_reaction")
        state = copy.deepcopy(self.project.initial_state())
        set_path(state, "progress.self_development.last_activity", "workout")

        variant_id, resolved = resolve_dialogue_variant(self.project, state, node)

        self.assertEqual("after_workout", variant_id)
        self.assertEqual(
            "오늘도 잘 부탁합니다. 요즘 운동을 다시 시작했습니다. "
            "앉아 있는 시간이 길어서 건강부터 챙기려고요. 그럼 참석자표부터 볼까요?",
            resolved["line"],
        )

    def test_all_activity_lines_have_direct_scene_yaml_owners(self):
        entries = collect_localizable_entries(self.project)
        activity_entries = [
            entry for key, entry in entries.items()
            if key.startswith("scenes.")
            and ".variants.after_" in key
            and key.endswith(".line")
        ]
        self.assertEqual(48, len(activity_entries))
        self.assertTrue(all(entry["sourceDocument"]["kind"] == "scene" for entry in activity_entries))
        self.assertTrue(all(".variants." in entry["sourceDocument"]["fieldPath"] for entry in activity_entries))

    def test_runtime_preserves_explicit_variants_without_prose_generation(self):
        bundle = self.project.build_bundle()
        runtime_node = bundle["scenes"]["common.day_02_practical_meeting"]["nodes"]["day_one_activity_reaction"]
        source_node = next(
            node for node in self.project.scenes["common.day_02_practical_meeting"]["nodes"]
            if node["id"] == "day_one_activity_reaction"
        )
        self.assertEqual(source_node["variants"], runtime_node["variants"])


if __name__ == "__main__":
    unittest.main()
