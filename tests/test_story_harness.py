import copy
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from story_harness import Simulator, StoryProject, apply_effect, derive_emotion  # noqa: E402


class StoryHarnessTests(unittest.TestCase):
    def setUp(self):
        self.project = StoryProject(ROOT / "story")

    def test_project_validates_without_errors_or_warnings(self):
        issues = self.project.validate()
        self.assertEqual([], issues)

    def test_missing_reality_layer_is_rejected(self):
        scene = self.project.scenes["seo_a.email_request"]
        original = copy.deepcopy(scene["nodes"][0]["reality"])
        try:
            del scene["nodes"][0]["reality"]
            issues = self.project.validate()
            self.assertTrue(any("reality layer is required" in issue.message for issue in issues))
        finally:
            scene["nodes"][0]["reality"] = original

    def test_state_contract_rejects_implicit_write(self):
        scene = self.project.scenes["seo_a.email_request"]
        path = "hidden.heroines.yoon_seo_a.dislike"
        scene["state_contract"]["writes"].remove(path)
        issues = self.project.validate()
        self.assertTrue(any("not declared in state_contract.writes" in issue.message for issue in issues))

    def test_invalid_expression_layer_is_rejected(self):
        scene = self.project.scenes["seo_a.email_request"]
        original = scene["nodes"][0]["reality"]["expression"]
        try:
            scene["nodes"][0]["reality"]["expression"] = "subjective_shy"
            issues = self.project.validate()
            self.assertTrue(any("belongs to perceived, not reality" in issue.message for issue in issues))
        finally:
            scene["nodes"][0]["reality"]["expression"] = original

    def test_aggressive_seo_a_choices_reach_report_ending(self):
        result = Simulator(
            self.project,
            "seo_a",
            {
                "seo_a.email_request": "pull_harder",
                "seo_a.relief_smile": "interpret_pull",
            },
            "first",
        ).run()
        self.assertEqual("seo_a.report", result["ending"])
        stats = result["final_state"]["hidden"]["heroines"]["yoon_seo_a"]
        self.assertEqual(2, stats["evidence_count"])
        self.assertGreaterEqual(stats["dislike"], 25)

    def test_literal_seo_a_choices_reach_ambiguous_ending(self):
        result = Simulator(
            self.project,
            "seo_a",
            {
                "seo_a.email_request": "take_literally",
                "seo_a.relief_smile": "stop_game",
            },
            "first",
        ).run()
        self.assertEqual("seo_a.ambiguous", result["ending"])
        self.assertEqual(0, result["final_state"]["hidden"]["heroines"]["yoon_seo_a"]["evidence_count"])

    def test_two_routes_unlock_collapse_mode(self):
        seo_result = Simulator(
            self.project,
            "seo_a",
            {
                "seo_a.email_request": "take_literally",
                "seo_a.relief_smile": "stop_game",
            },
            "first",
        ).run()
        min_result = Simulator(
            self.project,
            "min_kyung",
            {
                "min_kyung.explicit_boundary": "accept_boundary",
                "min_kyung.witness_meeting": "work_only",
            },
            "first",
            seo_result["final_state"],
        ).run()
        self.assertIn("seo_a", min_result["final_state"]["progress"]["cleared_routes"])
        self.assertIn("min_kyung", min_result["final_state"]["progress"]["cleared_routes"])
        self.assertIn("collapse", min_result["final_state"]["progress"]["unlocked_modes"])

    def test_yoo_jin_route_is_locked_without_prior_clears(self):
        with self.assertRaisesRegex(RuntimeError, "route is locked"):
            Simulator(self.project, "yoo_jin", {}, "first").run()

    def test_yoo_jin_route_can_reach_both_endings(self):
        unlocked = self.project.initial_state()
        unlocked["progress"]["cleared_routes"] = ["seo_a", "min_kyung"]
        dark = Simulator(
            self.project,
            "yoo_jin",
            {
                "yoo_jin.fact_check": "strategic_retreat",
                "yoo_jin.formal_record": "intermittent_pressure",
            },
            "first",
            unlocked,
        ).run()
        self.assertEqual("yoo_jin.her_collapse", dark["ending"])

        truth = Simulator(
            self.project,
            "yoo_jin",
            {
                "yoo_jin.fact_check": "reinterpret_correction",
                "yoo_jin.formal_record": "challenge_record",
            },
            "first",
            unlocked,
        ).run()
        self.assertEqual("yoo_jin.narrative_collapse", truth["ending"])

    def test_emotion_is_derived_from_hidden_stats(self):
        state = self.project.initial_state()
        state["hidden"]["heroines"]["yoon_seo_a"]["suspicion"] = 70
        emotion = derive_emotion(self.project.characters["yoon_seo_a"], state)
        self.assertEqual("fear", emotion["emotion"])
        self.assertEqual("actual_tense", emotion["expression"])

    def test_numeric_effect_is_clamped_to_manifest_range(self):
        state = self.project.initial_state()
        apply_effect(
            self.project,
            state,
            {
                "path": "visible.heroines.yoon_seo_a.affection",
                "op": "add",
                "value": 500,
            },
        )
        self.assertEqual(100, state["visible"]["heroines"]["yoon_seo_a"]["affection"])

    def test_runtime_build_indexes_nodes(self):
        bundle = self.project.build_bundle()
        scene = bundle["scenes"]["seo_a.email_request"]
        self.assertIsInstance(scene["nodes"], dict)
        self.assertEqual("request", scene["node_order"][0])
        self.assertIn("source_sha256", bundle)

    def test_ai_context_is_bounded_and_contains_both_layers(self):
        context = self.project.context_package("seo_a.email_request")
        self.assertEqual("seo_a.email_request", context["scene"]["id"])
        self.assertEqual({"han_do_yoon", "yoon_seo_a"}, set(context["cast"]))
        self.assertNotIn("cha_min_kyung", context["cast"])
        first_node = context["scene"]["nodes"][0]
        self.assertIn("perceived", first_node)
        self.assertIn("reality", first_node)
        self.assertIn("authoring_rules", context)

    def test_branch_simulation_produces_exact_context_state(self):
        result = Simulator(
            self.project,
            "seo_a",
            {"seo_a.email_request": "pull_harder"},
            "first",
        ).run(stop_before_scene="seo_a.relief_smile")
        self.assertEqual("seo_a.relief_smile", result["stopped_at"])
        context = self.project.context_package("seo_a.relief_smile", result["final_state"])
        self.assertEqual(25, context["state_snapshot"]["hidden.heroines.yoon_seo_a.suspicion"])
        self.assertEqual("anxiety", context["derived_emotions"]["yoon_seo_a"]["emotion"])


if __name__ == "__main__":
    unittest.main()
