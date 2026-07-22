import copy
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from story_harness import (  # noqa: E402
    Simulator,
    StoryProject,
    TimelineScheduler,
    apply_effect,
    derive_emotion,
    resolve_scene_background,
    resolve_scene_stage,
)


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

    def test_unmarked_spoken_line_distortion_is_rejected(self):
        scene = self.project.scenes["seo_a.email_request"]
        original = scene["nodes"][0]["perceived"]["line"]
        try:
            scene["nodes"][0]["perceived"]["line"] = "다르게 들린 문장"
            issues = self.project.validate()
            self.assertTrue(any("spoken lines must match" in issue.message for issue in issues))
        finally:
            scene["nodes"][0]["perceived"]["line"] = original

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

    def test_first_cleared_base_route_unlocks_survival_mode(self):
        cases = {
            "seo_a": {
                "seo_a.email_request": "take_literally",
                "seo_a.relief_smile": "stop_game",
            },
            "min_kyung": {
                "min_kyung.explicit_boundary": "accept_boundary",
                "min_kyung.witness_meeting": "work_only",
            },
        }
        for route_id, choices in cases.items():
            with self.subTest(route=route_id):
                result = Simulator(self.project, route_id, choices, "first").run()
                progress = result["final_state"]["progress"]
                self.assertEqual([route_id], progress["cleared_routes"])
                self.assertIn("survivor_view", progress["unlocked_modes"])
                self.assertNotIn("collapse", progress["unlocked_modes"])

    def test_retired_collapse_route_is_absent(self):
        self.assertNotIn("yoo_jin", self.project.routes)
        self.assertFalse(any(route.get("mode") == "collapse" for route in self.project.routes.values()))

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

    def test_runtime_build_contains_time_first_collections(self):
        bundle = self.project.build_bundle()
        self.assertEqual(15, bundle["campaigns"]["main"]["total_days"])
        self.assertEqual(19, len(bundle["events"]))
        self.assertEqual({"seo_a", "min_kyung"}, set(bundle["threads"]))
        self.assertIn("unlocks", bundle["meta"])
        reveals = bundle["meta"]["unlocks"]["mode_teasers"][0]["reveals"]
        self.assertEqual(["survivor_view"], [reveal["mode"] for reveal in reveals])
        survival = bundle["meta"]["unlocks"]["survival_mode"]
        self.assertEqual("confirmed", survival["status"])
        self.assertEqual("undecided", survival["playable_character"]["status"])
        self.assertTrue(survival["timeline_replay"]["same_days"])
        self.assertTrue(survival["antagonist_stance"]["starts_aggressive"])
        self.assertFalse(survival["antagonist_stance"]["player_induced"])
        self.assertFalse(survival["player_strategy"]["direct_violence_baiting_allowed"])
        self.assertEqual(5, len(survival["endings"]))

    def test_runtime_build_contains_localization_with_fallback_and_coverage(self):
        localization = self.project.build_bundle()["localization"]
        self.assertEqual(["ko", "en"], localization["supported_locales"])
        self.assertEqual("Send It by Email", localization["catalogs"]["en"]["scenes.seo_a.email_request.title"])
        fallback_key = "scenes.seo_a.relief_smile.title"
        self.assertEqual(localization["source_strings"][fallback_key], localization["catalogs"]["en"][fallback_key])
        self.assertIn(fallback_key, localization["coverage"]["en"]["missing"])

    def test_visual_inheritance_resolves_shared_character_defaults(self):
        visuals = self.project.resolve_visuals()
        seo_a = visuals["character.yoon_seo_a"]
        self.assertFalse(seo_a["abstract"])
        self.assertEqual("flat_portrait", seo_a["render_strategy"])
        self.assertEqual("bottom", seo_a["defaults"]["anchor"])
        self.assertIn("office", seo_a["outfits"])

    def test_scene_background_changes_by_location_and_time(self):
        visuals = self.project.resolve_visuals()
        email = resolve_scene_background(visuals, self.project.scenes["seo_a.email_request"], "request", "perceived")
        report = resolve_scene_background(visuals, self.project.scenes["ending.seo_a.report"], "statement", "reality")
        empty = resolve_scene_background(visuals, self.project.scenes["ending.seo_a.ambiguous"], "aftermath", "reality")
        self.assertEqual("background.office_open", email["visual_id"])
        self.assertEqual("background.meeting_room", report["visual_id"])
        self.assertEqual("background.office_open", empty["visual_id"])

    def test_scene_stage_composes_background_and_character_objects(self):
        scene = self.project.scenes["seo_a.email_request"]
        stage = resolve_scene_stage(self.project.resolve_visuals(), scene, "request", "reality")
        self.assertEqual("background.office_open", stage["background"]["visual_id"])
        self.assertEqual({"han_do_yoon", "yoon_seo_a"}, {item["character"] for item in stage["characters"]})
        seo_a = next(item for item in stage["characters"] if item["character"] == "yoon_seo_a")
        self.assertEqual("actual_tense", seo_a["expression"])
        self.assertTrue(seo_a["speaker"])

    def test_timeline_scheduler_does_not_expose_retired_collapse_events(self):
        scheduler = TimelineScheduler(self.project)
        self.assertNotIn("yoo_jin.fact_check", scheduler.project.events)
        self.assertFalse(any(event.get("thread") == "yoo_jin" for event in scheduler.project.events.values()))

    def test_missed_event_triggers_hidden_offscreen_progression(self):
        scheduler = TimelineScheduler(self.project)
        applied = scheduler.process_automatic(5, "after_work")
        self.assertIn("seo_a.email_request", scheduler.state["progress"]["events"]["missed"])
        self.assertIn("offscreen.seo_a_consults_min_kyung", [item["event"] for item in applied])
        self.assertIn("present.seo_a_first_consult", scheduler.state["progress"]["memories"])

    def test_ending_priority_selects_conditioned_event_in_exclusive_group(self):
        state = self.project.initial_state()
        state["progress"]["events"]["seen"] = ["seo_a.email_request", "seo_a.relief_smile"]
        state["hidden"]["heroines"]["yoon_seo_a"]["evidence_count"] = 2
        state["hidden"]["heroines"]["yoon_seo_a"]["dislike"] = 30
        scheduler = TimelineScheduler(self.project, state)
        applied = scheduler.process_automatic(15, "after_work")
        event_ids = [item["event"] for item in applied]
        self.assertIn("seo_a.ending_report", event_ids)
        self.assertNotIn("seo_a.ending_ambiguous", event_ids)

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
