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


class StoryTemplateIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.project = StoryProject(ROOT / "story")

    def test_source_macro_compiles_to_stable_existing_runtime_variants(self):
        source_scene = self.project.scenes["common.day_02_practical_meeting"]
        source_node = next(
            node for node in source_scene["nodes"]
            if node["id"] == "day_one_activity_reaction"
        )
        self.assertIn("self_development_template", source_node)
        self.assertNotIn("variants", source_node)

        compiled_scene = self.project.compile_scene_dialogue(source_scene)
        compiled_node = next(
            node for node in compiled_scene["nodes"]
            if node["id"] == "day_one_activity_reaction"
        )
        self.assertNotIn("self_development_template", compiled_node)
        self.assertEqual(
            [
                "after_workout",
                "after_reading",
                "after_ott",
                "after_sleep",
                "after_solo_drinking",
                "default",
            ],
            [variant["id"] for variant in compiled_node["variants"]],
        )
        self.assertIn("self_development_template", source_node)

    def test_last_activity_selects_the_compiled_self_promotion_line(self):
        scene = self.project.scenes["common.day_02_practical_meeting"]
        node = next(
            item for item in scene["nodes"]
            if item["id"] == "day_one_activity_reaction"
        )
        state = copy.deepcopy(self.project.initial_state())
        set_path(state, "progress.self_development.last_activity", "workout")

        variant_id, resolved = resolve_dialogue_variant(self.project, state, node)

        self.assertEqual("after_workout", variant_id)
        self.assertEqual(
            "오늘도 잘 부탁합니다. 요즘 운동을 다시 시작했습니다. "
            "앉아 있는 시간이 길어서 건강부터 챙기려고요. 그럼 참석자표부터 볼까요?",
            resolved["reality"]["line"],
        )
        self.assertEqual("self_promotion", resolved["reality"]["intent"])

    def test_runtime_and_localization_expose_only_ordinary_variants(self):
        bundle = self.project.build_bundle()
        runtime_node = bundle["scenes"]["common.day_02_practical_meeting"]["nodes"][
            "day_one_activity_reaction"
        ]
        self.assertNotIn("self_development_template", runtime_node)
        self.assertIn("variants", runtime_node)
        self.assertNotIn("conversation_topics", bundle["self_development"])

        entries = collect_localizable_entries(self.project)
        key = (
            "scenes.common.day_02_practical_meeting.nodes."
            "day_one_activity_reaction.variants.after_workout.reality.line"
        )
        self.assertEqual(
            "오늘도 잘 부탁합니다. 요즘 운동을 다시 시작했습니다. "
            "앉아 있는 시간이 길어서 건강부터 챙기려고요. 그럼 참석자표부터 볼까요?",
            entries[key]["source"],
        )


if __name__ == "__main__":
    unittest.main()
