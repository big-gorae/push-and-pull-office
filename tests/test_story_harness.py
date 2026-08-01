import copy
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import yaml


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from story_harness import (  # noqa: E402
    Simulator,
    StoryProject,
    TimelineScheduler,
    apply_effect,
    break_push_pull_flow,
    can_enter_scene,
    choose_transition,
    command_new_scene,
    condition_matches,
    derive_emotion,
    effective_speaker,
    explore_route,
    localization_report,
    push_pull_state,
    resolve_scene_background,
    resolve_scene_stage,
    resolve_push_pull,
    resolve_dialogue_variant,
    reproducible_generated_at,
    set_path,
)


class StoryHarnessTests(unittest.TestCase):
    def setUp(self):
        self.project = StoryProject(ROOT / "story")

    def test_project_validates_without_errors_or_warnings(self):
        issues = self.project.validate()
        self.assertEqual([], issues)

    def test_build_metadata_is_reproducible_by_default(self):
        self.assertEqual("1970-01-01T00:00:00+00:00", reproducible_generated_at())
        self.assertEqual(self.project.build_bundle(), self.project.build_bundle())

    def test_approved_player_copy_is_a_hard_contract(self):
        original = self.project.ui["strings"]["mode.truth.copyUnlocked"]
        try:
            self.project.ui["strings"]["mode.truth.copyUnlocked"] = "다른 설명"
            issues = self.project.validate()
            self.assertTrue(any("approved player copy" in issue.message for issue in issues))
        finally:
            self.project.ui["strings"]["mode.truth.copyUnlocked"] = original

    def test_explorer_covers_every_route_choice_option(self):
        results = {route_id: explore_route(self.project, route_id) for route_id in self.project.routes}
        self.assertGreaterEqual(results["seo_a"]["choice_options"], 10)
        self.assertGreaterEqual(results["min_kyung"]["choice_options"], 6)
        self.assertTrue(results["seo_a"]["endings"])
        self.assertTrue(results["min_kyung"]["endings"])

    def test_explorer_rejects_an_unreachable_choice_option(self):
        scene = self.project.scenes["seo_a.email_request"]
        option = scene["nodes"][2]["options"][0]
        original = copy.deepcopy(option["conditions"])
        try:
            option["conditions"] = [{
                "path": "hidden.heroines.yoon_seo_a.suspicion",
                "op": "gt",
                "value": 100,
            }]
            with self.assertRaisesRegex(RuntimeError, "unreachable choice options"):
                explore_route(self.project, "seo_a")
        finally:
            option["conditions"] = original

    def test_condition_fixture_matches_typescript_contract(self):
        fixture = json.loads((ROOT / "tests/fixtures/condition-conformance.json").read_text(encoding="utf-8"))
        for case in fixture["cases"]:
            with self.subTest(case=case["id"]):
                self.assertEqual(case["expected"], condition_matches(case["state"], case["condition"]))

    def test_shared_entry_fixture_covers_scene_transition_and_event(self):
        fixture = json.loads((ROOT / "tests/fixtures/condition-conformance.json").read_text(encoding="utf-8"))
        target_id, fallback_id = list(self.project.scenes)[:2]
        event_id = next(iter(self.project.events))
        original_target = copy.deepcopy(self.project.scenes[target_id])
        original_fallback = copy.deepcopy(self.project.scenes[fallback_id])
        original_event = copy.deepcopy(self.project.events[event_id])
        try:
            for case in fixture["entry_cases"]:
                with self.subTest(case=case["id"]):
                    self.project.scenes[target_id]["entry_conditions"] = [copy.deepcopy(case["condition"])]
                    self.project.scenes[fallback_id]["entry_conditions"] = []
                    event = self.project.events[event_id]
                    event["scene"] = target_id
                    event["window"] = {"days": [1, 3], "deadline_day": 3, "slots": ["morning"]}
                    event["requires"] = {"events": [], "conditions": []}
                    state = self.project.initial_state()
                    set_path(state, case["state_patch"]["path"], case["state_patch"]["value"])
                    decision = can_enter_scene(self.project, state, target_id)
                    self.assertEqual(case["expected_allowed"], decision["allowed"])
                    transition = choose_transition(state, [
                        {"conditions": [], "scene": target_id},
                        {"default": True, "scene": fallback_id},
                    ], self.project)
                    expected_scene = target_id if case["expected_transition"] == "target" else fallback_id
                    self.assertEqual(expected_scene, transition["scene"])
                    verdict = TimelineScheduler(self.project, state).inspect_event(
                        event_id,
                        case["state_patch"]["value"],
                        "morning",
                    )
                    self.assertEqual(case["expected_event_eligible"], verdict["eligible"])
        finally:
            self.project.scenes[target_id] = original_target
            self.project.scenes[fallback_id] = original_fallback
            self.project.events[event_id] = original_event

    def test_locale_orphans_and_placeholder_mismatches_are_errors(self):
        english = self.project.locales["en"]["strings"]
        english["orphan.test"] = "orphan"
        english["deadline.days"] = "No variable"
        issues = self.project.validate()
        self.assertTrue(any("orphan translation key" in issue.message for issue in issues))
        self.assertTrue(any("placeholder mismatch" in issue.message for issue in issues))

    def test_duplicate_yaml_mapping_key_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "duplicate.yaml"
            path.write_text("id: sample\nstrings:\n  key: one\n  key: two\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "duplicate key"):
                StoryProject._load_yaml(path)

    def test_localization_source_collision_is_a_validation_error(self):
        key = "campaign.main.title"
        self.project.ui["strings"][key] = "충돌 원문"
        try:
            issues = self.project.validate()
            self.assertTrue(any("localization key collision" in issue.message for issue in issues))
        finally:
            del self.project.ui["strings"][key]

    def test_release_profile_and_report_include_scene_coverage(self):
        issues = self.project.validate("release")
        self.assertTrue(any(issue.severity == "warning" and "translation uses fallback" in issue.message for issue in issues))
        bundle = self.project.build_bundle()
        report = localization_report(bundle, issues, "release")
        self.assertEqual("release", report["profile"])
        self.assertIn("seo_a.email_request", report["scene_coverage"])
        self.assertIn("en", report["scene_coverage"]["seo_a.email_request"])

    def test_dialogue_variant_uses_derived_emotion_and_validates_default(self):
        scene = self.project.scenes["seo_a.email_request"]
        node = scene["nodes"][0]
        original_perceived = node.pop("perceived")
        original_reality = node.pop("reality")
        node["variants"] = [
            {
                "id": "guarded",
                "priority": 100,
                "conditions": [{
                    "path": "derived.characters.yoon_seo_a.emotion",
                    "op": "eq",
                    "value": "fear",
                }],
                "perceived": copy.deepcopy(original_perceived),
                "reality": copy.deepcopy(original_reality),
            },
            {
                "id": "default",
                "default": True,
                "perceived": copy.deepcopy(original_perceived),
                "reality": copy.deepcopy(original_reality),
            },
        ]
        scene["state_contract"]["reads"].append("derived.characters.yoon_seo_a.emotion")
        try:
            issues = []
            self.project._validate_scenes(issues)
            self.assertEqual([], issues)
            state = self.project.initial_state()
            self.assertEqual("default", resolve_dialogue_variant(self.project, state, node)[0])
            state["hidden"]["heroines"]["yoon_seo_a"]["suspicion"] = 70
            self.assertEqual("guarded", resolve_dialogue_variant(self.project, state, node)[0])
            node["variants"][1]["default"] = False
            issues = []
            self.project._validate_scenes(issues)
            self.assertTrue(any("exactly one default" in issue.message for issue in issues))
        finally:
            node.pop("variants")
            node["perceived"] = original_perceived
            node["reality"] = original_reality
            scene["state_contract"]["reads"].remove("derived.characters.yoon_seo_a.emotion")

    def test_reality_expression_fallback_priority_preserves_perceived_layer(self):
        character = self.project.characters["yoon_seo_a"]
        original_rules = character["emotion_rules"]
        node = {
            "id": "expression",
            "kind": "dual_dialogue",
            "speaker": "yoon_seo_a",
            "perceived": {"line": "p", "expression": "subjective_shy"},
            "reality": {"line": "r"},
            "next": "done",
        }
        try:
            character["emotion_rules"] = []
            _, resolved = resolve_dialogue_variant(self.project, self.project.initial_state(), node)
            self.assertEqual("actual_social_smile", resolved["reality"]["expression"])
            self.assertEqual("subjective_shy", resolved["perceived"]["expression"])
            node["reality"]["expression"] = "actual_relief"
            _, explicit = resolve_dialogue_variant(self.project, self.project.initial_state(), node)
            self.assertEqual("actual_relief", explicit["reality"]["expression"])
        finally:
            character["emotion_rules"] = original_rules

    def test_missing_reality_layer_is_rejected(self):
        scene = self.project.scenes["seo_a.email_request"]
        original = copy.deepcopy(scene["nodes"][0]["reality"])
        try:
            del scene["nodes"][0]["reality"]
            issues = self.project.validate()
            self.assertTrue(any("reality layer is required" in issue.message for issue in issues))
        finally:
            scene["nodes"][0]["reality"] = original

    def test_legacy_embedded_thought_fields_are_rejected(self):
        node = self.project.scenes["seo_a.email_request"]["nodes"][0]
        try:
            node["perceived"]["protagonist_interpretation"] = "legacy"
            node["reality"]["inner_thought"] = "legacy"
            issues = []
            self.project._validate_scenes(issues)
            messages = [issue.message for issue in issues]
            self.assertTrue(any("legacy perceived.protagonist_interpretation is forbidden" in message for message in messages))
            self.assertTrue(any("legacy reality.inner_thought is forbidden" in message for message in messages))
        finally:
            node["perceived"].pop("protagonist_interpretation", None)
            node["reality"].pop("inner_thought", None)

    def test_inner_voice_uses_layer_speakers_and_conditional_parentheses(self):
        scene = self.project.scenes["seo_a.email_request"]
        node = next(item for item in scene["nodes"] if item["id"] == "request_inner")
        original = copy.deepcopy(node)
        try:
            self.assertEqual("han_do_yoon", effective_speaker(node, "perceived"))
            self.assertEqual("yoon_seo_a", effective_speaker(node, "reality"))

            del node["speakers"]["reality"]
            issues = []
            self.project._validate_scenes(issues)
            self.assertTrue(any("speakers.reality is required" in issue.message for issue in issues))

            node.clear()
            node.update(copy.deepcopy(original))
            node["perceived"]["line"] = "괄호가 없는 속말"
            issues = []
            self.project._validate_scenes(issues)
            self.assertTrue(any("with a speaker must be parenthesized" in issue.message for issue in issues))

            node.clear()
            node.update(copy.deepcopy(original))
            node["speakers"]["reality"] = None
            node["reality"]["line"] = "(이름표 없는 권위적 서술)"
            issues = []
            self.project._validate_scenes(issues)
            self.assertTrue(any("speakerless inner_voice reality narration must not be parenthesized" in issue.message for issue in issues))
        finally:
            node.clear()
            node.update(original)

    def test_regular_dialogue_cannot_use_layer_speakers(self):
        scene = self.project.scenes["seo_a.email_request"]
        node = scene["nodes"][0]
        original = copy.deepcopy(node)
        try:
            node.pop("speaker")
            node["speakers"] = {"perceived": "yoon_seo_a", "reality": "yoon_seo_a"}
            issues = []
            self.project._validate_scenes(issues)
            self.assertTrue(any("regular dual_dialogue must use a single speaker" in issue.message for issue in issues))
        finally:
            node.clear()
            node.update(original)

    def test_text_only_speaker_is_valid_only_as_a_declared_meeting_participant(self):
        scene = self.project.scenes["common.day_01_company_meeting"]
        node = next(item for item in scene["nodes"] if item["id"] == "jeong_da_eun_opening")
        issues = []
        self.project._validate_scenes(issues)
        self.assertFalse(any("member.jeong_da_eun" in issue.message for issue in issues))

        original_participants = list(scene["world_context"]["participants"])
        try:
            scene["world_context"]["participants"].remove("member.jeong_da_eun")
            issues = []
            self.project._validate_scene_world_contexts(issues)
            self.assertTrue(any("world member speaker is not a declared participant: member.jeong_da_eun" in issue.message for issue in issues))

            node["speaker"] = "member.han_do_yoon"
            issues = []
            self.project._validate_scenes(issues)
            self.assertTrue(any("illustrated world member speaker must use story_character id" in issue.message for issue in issues))
        finally:
            node["speaker"] = "member.jeong_da_eun"
            scene["world_context"]["participants"] = original_participants

    def test_choice_requires_stimulus_and_hides_explicit_direction_words(self):
        scene = self.project.scenes["seo_a.email_request"]
        node = next(item for item in scene["nodes"] if item["kind"] == "choice")
        original = copy.deepcopy(node)
        try:
            node["stimulus"] = ""
            node["prompt"] = "이번에는 밀당으로 갈까?"
            node["options"][0]["label"] = "PUSH"
            issues = []
            self.project._validate_scenes(issues)
            messages = [issue.message for issue in issues]
            self.assertTrue(any("choice stimulus is required" in message for message in messages))
            self.assertTrue(any("choice prompt" in message and "push/pull" in message for message in messages))
            self.assertTrue(any("choice label" in message and "push/pull" in message for message in messages))
        finally:
            node.clear()
            node.update(original)

    def test_new_scene_scaffold_uses_separate_inner_voice_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "draft.yaml"
            command_new_scene(
                self.project,
                SimpleNamespace(
                    route="seo_a",
                    id="seo_a.contract_draft",
                    title="계약 초안",
                    chapter=1,
                    sequence=99,
                    out=str(output),
                    force=False,
                ),
            )
            document = yaml.safe_load(output.read_text(encoding="utf-8"))
            serialized = json.dumps(document, ensure_ascii=False)
            self.assertNotIn("protagonist_interpretation", serialized)
            self.assertNotIn("inner_thought", serialized)
            inner = next(node for node in document["nodes"] if node["id"] == "opening_inner")
            self.assertEqual(["inner_voice"], inner["presentation_flags"])
            self.assertEqual("han_do_yoon", inner["speakers"]["perceived"])
            self.assertIsNone(inner["speakers"]["reality"])
            self.assertTrue(inner["perceived"]["line"].startswith("("))
            self.assertFalse(inner["reality"]["line"].startswith("("))

    def test_unmarked_spoken_line_distortion_is_rejected(self):
        scene = self.project.scenes["seo_a.email_request"]
        original = scene["nodes"][0]["perceived"]["line"]
        try:
            scene["nodes"][0]["perceived"]["line"] = "다르게 들린 문장"
            issues = self.project.validate()
            self.assertTrue(any("spoken lines must match" in issue.message for issue in issues))
        finally:
            scene["nodes"][0]["perceived"]["line"] = original

    def test_romance_insert_allows_marked_spoken_line_distortion(self):
        scene = self.project.scenes["seo_a.email_request"]
        node = scene["nodes"][0]
        original_line = node["perceived"]["line"]
        original_flags = node.get("presentation_flags")
        try:
            node["perceived"]["line"] = f"{node['reality']['line']} 다음에 또 뵈어요."
            node["presentation_flags"] = ["romance_insert"]
            issues = self.project.validate()
            self.assertFalse(any("spoken lines must match" in issue.message for issue in issues))
        finally:
            node["perceived"]["line"] = original_line
            if original_flags is None:
                node.pop("presentation_flags", None)
            else:
                node["presentation_flags"] = original_flags

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
        self.assertEqual("story_mode.grooms_face", result["ending"])
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
        self.assertEqual("story_mode.betrayed_man", result["ending"])
        self.assertEqual(0, result["final_state"]["hidden"]["heroines"]["yoon_seo_a"]["evidence_count"])

    def test_all_seven_story_mode_endings_are_reachable(self):
        aggressive = {
            "seo_a.email_request": "pull_harder",
            "seo_a.relief_smile": "interpret_pull",
        }
        restrained = {
            "seo_a.email_request": "take_literally",
            "seo_a.relief_smile": "stop_game",
        }
        reached = {
            Simulator(self.project, "seo_a", aggressive, "first").run()["ending"],
        }

        true_state = self.project.initial_state()
        true_state["progress"]["cleared_routes"] = ["min_kyung"]
        true_state["progress"]["memories"] = ["past_case.date_mismatch"]
        reached.add(Simulator(self.project, "seo_a", aggressive, "first", true_state).run()["ending"])

        branch_choices = [
            {
                "ending.seo_a.ambiguous:immediate_choice": "accept_separation",
                "ending.seo_a.ambiguous:interpretation_choice": "choose_betrayal",
            },
            {
                "ending.seo_a.ambiguous:immediate_choice": "accept_separation",
                "ending.seo_a.ambiguous:interpretation_choice": "choose_romance",
            },
            {
                "ending.seo_a.ambiguous:immediate_choice": "cross_line",
                "ending.seo_a.ambiguous:line_cross_choice": "remain",
            },
            {
                "ending.seo_a.ambiguous:immediate_choice": "cross_line",
                "ending.seo_a.ambiguous:line_cross_choice": "escape",
            },
        ]
        for choices in branch_choices:
            reached.add(Simulator(self.project, "seo_a", {**restrained, **choices}, "first").run()["ending"])

        special_state = self.project.initial_state()
        special_state["progress"]["flags"]["story_mode"]["yoo_jin_intervention"] = True
        reached.add(Simulator(self.project, "seo_a", restrained, "first", special_state).run()["ending"])

        self.assertEqual(
            {
                "story_mode.grooms_face",
                "story_mode.betrayed_man",
                "story_mode.endless_romance",
                "story_mode.caught_in_act",
                "story_mode.last_push",
                "story_mode.unrouteable",
                "story_mode.never_dated",
            },
            reached,
        )

    def test_first_cleared_base_route_unlocks_truth_and_survival_modes(self):
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
                self.assertIn("truth_view", progress["unlocked_modes"])
                self.assertIn("survivor_view", progress["unlocked_modes"])
                self.assertNotIn("collapse", progress["unlocked_modes"])

    def test_every_base_route_has_both_post_ending_unlock_rules(self):
        unlocks = self.project.meta["unlocks"]
        removed = unlocks["unlock_rules"].pop()
        try:
            issues = []
            self.project._validate_meta(issues)
            self.assertTrue(any("must unlock survivor_view" in issue.message for issue in issues))
        finally:
            unlocks["unlock_rules"].append(removed)

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

    def test_push_pull_moves_gradually_scores_and_flips_target(self):
        state = self.project.initial_state()
        config = {"action": "approach", "intensity": 12, "base_score": 4}
        first = resolve_push_pull(self.project, state, "yoon_seo_a", config)
        second = resolve_push_pull(self.project, state, "yoon_seo_a", config)
        third = resolve_push_pull(self.project, state, "yoon_seo_a", config)
        self.assertEqual([-12, -24, -36], [first["position"], second["position"], third["position"]])
        self.assertEqual([1, 2, 3], [first["combo"], second["combo"], third["combo"]])
        self.assertEqual([4, 8, 18], [first["gain"], second["gain"], third["gain"]])
        self.assertTrue(third["reached_checkpoint"])
        self.assertEqual("push", third["target"])
        self.assertEqual(80, state["visible"]["heroines"]["yoon_seo_a"]["initiative"])

        reverse = resolve_push_pull(
            self.project,
            state,
            "yoon_seo_a",
            {"action": "space", "intensity": 12, "base_score": 4},
        )
        self.assertEqual(-24, reverse["position"])
        self.assertEqual(4, reverse["combo"])
        self.assertEqual(16, reverse["gain"])

    def test_push_pull_wrong_direction_outside_and_literal_do_not_score(self):
        state = self.project.initial_state()
        state["progress"]["flags"]["push_pull"] = {
            "combo": 3,
            "position": -24,
            "target": "pull",
            "last_action": "approach",
            "heroine": "yoon_seo_a",
        }
        wrong = resolve_push_pull(
            self.project,
            state,
            "yoon_seo_a",
            {"action": "space", "intensity": 12, "base_score": 4},
        )
        self.assertEqual("wrong", wrong["kind"])
        self.assertEqual(0, wrong["combo"])
        self.assertEqual(0, wrong["gain"])

        state["progress"]["flags"]["push_pull"].update({"position": 52, "target": "pull", "combo": 2})
        outside = resolve_push_pull(
            self.project,
            state,
            "yoon_seo_a",
            {"action": "space", "intensity": 12, "base_score": 4},
        )
        self.assertEqual("outside", outside["kind"])
        self.assertEqual(64, outside["position"])
        self.assertEqual(0, outside["gain"])

        literal = resolve_push_pull(
            self.project,
            state,
            "yoon_seo_a",
            {"action": "literal", "intensity": 12, "base_score": 4},
        )
        self.assertEqual("literal", literal["kind"])
        self.assertEqual(52, literal["position"])
        self.assertEqual("none", literal["target"])

    def test_high_combo_adds_hidden_pattern_consequences(self):
        state = self.project.initial_state()
        state["progress"]["flags"]["push_pull"] = {
            "combo": 4,
            "position": 24,
            "target": "push",
            "last_action": "space",
            "heroine": "yoon_seo_a",
        }
        result = resolve_push_pull(
            self.project,
            state,
            "yoon_seo_a",
            {"action": "space", "intensity": 12, "base_score": 4},
        )
        self.assertEqual("turn", result["kind"])
        self.assertEqual(5, result["combo"])
        self.assertEqual({"suspicion": 7, "dislike": 4, "evidence_count": 1}, result["hidden_delta"])
        hidden = state["hidden"]["heroines"]["yoon_seo_a"]
        self.assertEqual(7, hidden["suspicion"])
        self.assertEqual(4, hidden["dislike"])
        self.assertEqual(1, hidden["evidence_count"])

    def test_combo_break_keeps_position_and_clears_target(self):
        state = self.project.initial_state()
        state["progress"]["flags"]["push_pull"].update({
            "combo": 4,
            "position": -24,
            "target": "push",
            "last_action": "space",
            "heroine": "yoon_seo_a",
        })
        break_push_pull_flow(state)
        rhythm = push_pull_state(state)
        self.assertEqual(-24, rhythm["position"])
        self.assertEqual(0, rhythm["combo"])
        self.assertEqual("none", rhythm["target"])
        self.assertEqual("", rhythm["heroine"])

    def test_runtime_build_indexes_nodes(self):
        bundle = self.project.build_bundle()
        scene = bundle["scenes"]["seo_a.email_request"]
        self.assertIsInstance(scene["nodes"], dict)
        self.assertEqual("request", scene["node_order"][0])
        self.assertIn("source_sha256", bundle)

    def test_runtime_build_contains_time_first_collections(self):
        bundle = self.project.build_bundle()
        self.assertEqual(17, bundle["campaigns"]["main"]["total_days"])
        base_lanes = {lane["id"] for lane in bundle["campaigns"]["main"]["lanes"]}
        self.assertIn("kang_yoo_jin", base_lanes)
        self.assertIn("kang_yoo_jin", bundle["initial_state"]["visible"]["heroines"])
        self.assertIn("kang_yoo_jin", bundle["initial_state"]["hidden"]["heroines"])
        self.assertEqual(0, bundle["initial_state"]["hidden"]["heroines"]["yoon_seo_a"]["suspicion"])
        self.assertEqual(0, bundle["initial_state"]["hidden"]["heroines"]["cha_min_kyung"]["suspicion"])
        self.assertIn(
            "kang_yoo_jin",
            bundle["events"]["anchor.day_01_company_meeting"]["participants"],
        )
        self.assertEqual(24, len(bundle["events"]))
        parent_pressure = bundle["events"]["anchor.day_01_parent_pressure"]
        self.assertEqual([1, 1], parent_pressure["window"]["days"])
        self.assertEqual(["after_work"], parent_pressure["window"]["slots"])
        self.assertEqual(
            ["anchor.day_01_company_meeting"],
            parent_pressure["requires"]["events"],
        )
        second_weekend_encounter = bundle["events"]["anchor.day_05_weekend_reflection"]
        self.assertEqual(["afternoon"], second_weekend_encounter["window"]["slots"])
        self.assertEqual(
            ["anchor.day_04_weekend_encounter"],
            second_weekend_encounter["requires"]["events"],
        )
        self.assertEqual([7, 8], bundle["events"]["seo_a.email_request"]["window"]["days"])
        self.assertEqual([7, 8], bundle["events"]["min_kyung.explicit_boundary"]["window"]["days"])
        self.assertEqual([9, 10], bundle["events"]["seo_a.relief_smile"]["window"]["days"])
        self.assertEqual([9, 10], bundle["events"]["min_kyung.witness_meeting"]["window"]["days"])
        self.assertEqual({"seo_a", "min_kyung"}, set(bundle["threads"]))
        self.assertIn("unlocks", bundle["meta"])
        reveals = bundle["meta"]["unlocks"]["mode_teasers"][0]["reveals"]
        self.assertEqual(["truth_view", "survivor_view"], [reveal["mode"] for reveal in reveals])
        survival = bundle["meta"]["unlocks"]["survival_mode"]
        self.assertEqual("confirmed", survival["status"])
        self.assertEqual("undecided", survival["playable_character"]["status"])
        self.assertEqual("parallel_world", survival["continuity"]["type"])
        self.assertFalse(survival["continuity"]["same_core_events_required"])
        self.assertTrue(survival["continuity"]["preserve_base_outcome"])
        self.assertTrue(survival["antagonist_stance"]["starts_aggressive"])
        self.assertFalse(survival["antagonist_stance"]["player_induced"])
        self.assertFalse(survival["player_strategy"]["direct_violence_baiting_allowed"])
        self.assertEqual(5, len(survival["endings"]))
        story_mode = bundle["meta"]["story_mode"]
        self.assertEqual("스토리 모드", story_mode["display_name"])
        self.assertEqual(17, story_mode["ending_day"])
        self.assertEqual(7, len(story_mode["endings"]))
        self.assertTrue(story_mode["report_trigger"]["report_after_actual_visit"])
        self.assertEqual("later_termination", story_mode["police_and_company_order"][-1])

    def test_runtime_build_contains_indexed_world_bible(self):
        world = self.project.build_bundle()["world"]
        self.assertEqual("다원리빙", world["entities"]["company.dawon_living"]["name"])
        self.assertIn("project.harudam_spring_campaign", world["by_kind"]["project"])
        self.assertEqual(
            "member.yoon_seo_a",
            world["story_character_members"]["yoon_seo_a"],
        )
        self.assertNotIn("_source", world["entities"]["member.oh_se_jin"])

    def test_world_bible_rejects_unknown_team_and_inconsistent_membership(self):
        member = self.project.world["member.yoon_seo_a"]
        original_team = member["team"]
        try:
            member["team"] = "team.unknown"
            issues = []
            self.project._validate_world(issues)
            self.assertTrue(any("unknown team reference" in issue.message for issue in issues))
            self.assertTrue(any("declares team" in issue.message for issue in issues))
        finally:
            member["team"] = original_team

    def test_world_bible_rejects_unknown_company_role_and_member_references(self):
        cases = [
            ("role.manager", "company", "company.unknown", "unknown company reference"),
            ("member.yoon_seo_a", "role", "role.unknown", "unknown role reference"),
            ("team.product_planning", "lead_member", "member.unknown", "unknown member reference"),
        ]
        for entity_id, field, invalid_value, expected in cases:
            with self.subTest(field=field):
                entity = self.project.world[entity_id]
                original = entity[field]
                try:
                    entity[field] = invalid_value
                    issues = []
                    self.project._validate_world(issues)
                    self.assertTrue(any(expected in issue.message for issue in issues))
                finally:
                    entity[field] = original

    def test_world_bible_rejects_invalid_reporting_line(self):
        member = self.project.world["member.yoon_seo_a"]
        original_manager = member["manager"]
        try:
            member["manager"] = "member.moon_ji_hye"
            issues = []
            self.project._validate_world(issues)
            self.assertTrue(any("outside member team" in issue.message for issue in issues))
        finally:
            member["manager"] = original_manager

    def test_world_bible_rejects_text_only_route_heroine_misuse(self):
        member = self.project.world["member.yoon_seo_a"]
        original = copy.deepcopy(member)
        try:
            member["presentation"] = "text_only"
            issues = []
            self.project._validate_world(issues)
            messages = [issue.message for issue in issues]
            self.assertTrue(any("text_only member must not declare story_character" in message for message in messages))
            self.assertTrue(any("text_only member cannot be route_eligible" in message for message in messages))
        finally:
            member.clear()
            member.update(original)

    def test_duplicate_world_entity_id_is_rejected_during_load(self):
        with tempfile.TemporaryDirectory() as directory:
            story_root = Path(directory) / "story"
            shutil.copytree(ROOT / "story", story_root)
            duplicate = story_root / "world" / "members" / "duplicate_han.yaml"
            duplicate.write_text(
                (story_root / "world" / "members" / "han_do_yoon.yaml").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "duplicate world id member.han_do_yoon"):
                StoryProject(story_root)

    def test_world_meeting_rejects_heroine_only_or_understaffed_cast(self):
        scene = self.project.scenes["common.day_01_company_meeting"]
        original = copy.deepcopy(scene.get("world_context"))
        scene["world_context"] = {
            "company": "company.dawon_living",
            "project": "project.harudam_spring_campaign",
            "interaction": "meeting.cross_function_kickoff",
            "participants": [
                "member.han_do_yoon",
                "member.yoon_seo_a",
                "member.cha_min_kyung",
                "member.kang_yoo_jin",
            ],
        }
        try:
            issues = []
            self.project._validate_scene_world_contexts(issues)
            messages = [issue.message for issue in issues]
            self.assertTrue(any("at least 6 participants" in message for message in messages))
            self.assertTrue(any("text_only supporting coworkers" in message for message in messages))
            self.assertTrue(any("missing required project responsibilities" in message for message in messages))
        finally:
            if original is None:
                scene.pop("world_context", None)
            else:
                scene["world_context"] = original

    def test_day_one_context_exposes_only_bounded_relevant_world(self):
        scene = self.project.scenes["common.day_01_company_meeting"]
        original = copy.deepcopy(scene.get("world_context"))
        scene["world_context"] = {
            "company": "company.dawon_living",
            "project": "project.harudam_spring_campaign",
            "interaction": "meeting.cross_function_kickoff",
            "participants": [
                "member.han_do_yoon",
                "member.yoon_seo_a",
                "member.cha_min_kyung",
                "member.kang_yoo_jin",
                "member.oh_se_jin",
                "member.jeong_da_eun",
                "member.moon_ji_hye",
            ],
        }
        try:
            context = self.project.context_package("common.day_01_company_meeting")
            world = context["world_context"]
            self.assertEqual(
                "하루담 봄 리빙 캠페인",
                world["projects"]["project.harudam_spring_campaign"]["name"],
            )
            self.assertEqual(7, len(world["participants"]))
            self.assertIn("member.oh_se_jin", world["participants"])
            self.assertNotIn("member.shin_hye_rim", world["participants"])
            self.assertNotIn("team.people_operations", world["teams"])
        finally:
            if original is None:
                scene.pop("world_context", None)
            else:
                scene["world_context"] = original

    def test_runtime_build_contains_localization_with_fallback_and_coverage(self):
        localization = self.project.build_bundle()["localization"]
        self.assertEqual(["ko", "en"], localization["supported_locales"])
        self.assertEqual("Send It by Email", localization["catalogs"]["en"]["scenes.seo_a.email_request.title"])
        name_key = "characters.yoon_seo_a.display_name"
        self.assertEqual("윤서아", localization["catalogs"]["ko"][name_key])
        self.assertEqual("Yoon Seo-a", localization["catalogs"]["en"][name_key])
        fallback_key = "scenes.seo_a.relief_smile.title"
        self.assertEqual(localization["source_strings"][fallback_key], localization["catalogs"]["en"][fallback_key])
        self.assertIn(fallback_key, localization["coverage"]["en"]["missing"])
        visual_key = "visual.character.yoon_seo_a.title"
        self.assertEqual("윤서아 기본 바스트", localization["entries"][visual_key]["source"])
        self.assertEqual("story/visuals/characters/yoon_seo_a.yaml", localization["entries"][visual_key]["sourceDocument"]["path"])
        self.assertEqual("한국어", localization["locale_names"]["ko"]["native_name"])
        self.assertIn("locale.ko.native_name", localization["entries"])
        stimulus_key = "scenes.seo_a.email_request.nodes.interpret.stimulus"
        self.assertIn(stimulus_key, localization["entries"])
        self.assertFalse(any("protagonist_interpretation" in key or "inner_thought" in key for key in localization["entries"]))
        self.assertEqual(
            "오세진",
            localization["entries"]["world.members.member.oh_se_jin.display_name"]["source"],
        )

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
        report = resolve_scene_background(visuals, self.project.scenes["ending.seo_a.report"], "mugshot", "reality")
        empty = resolve_scene_background(visuals, self.project.scenes["ending.seo_a.ambiguous"], "released", "reality")
        self.assertEqual("background.office_open", email["visual_id"])
        self.assertEqual("background.office_corridor", report["visual_id"])
        self.assertEqual("background.office_corridor", empty["visual_id"])

    def test_scene_stage_composes_background_and_character_objects(self):
        scene = self.project.scenes["seo_a.email_request"]
        stage = resolve_scene_stage(self.project.resolve_visuals(), scene, "request", "reality")
        self.assertEqual("background.office_open", stage["background"]["visual_id"])
        self.assertEqual(["yoon_seo_a"], [item["character"] for item in stage["characters"]])
        seo_a = stage["characters"][0]
        self.assertEqual("actual_tense", seo_a["expression"])
        self.assertTrue(seo_a["speaker"])

        perceived_inner = resolve_scene_stage(self.project.resolve_visuals(), scene, "request_inner", "perceived")
        reality_inner = resolve_scene_stage(self.project.resolve_visuals(), scene, "request_inner", "reality")
        self.assertEqual(["han_do_yoon"], [item["character"] for item in perceived_inner["characters"]])
        self.assertEqual(["yoon_seo_a"], [item["character"] for item in reality_inner["characters"]])

    def test_timeline_scheduler_does_not_expose_retired_collapse_events(self):
        scheduler = TimelineScheduler(self.project)
        self.assertNotIn("yoo_jin.fact_check", scheduler.project.events)
        self.assertFalse(any(event.get("thread") == "yoo_jin" for event in scheduler.project.events.values()))

    def test_missed_event_triggers_hidden_offscreen_progression(self):
        scheduler = TimelineScheduler(self.project)
        applied = scheduler.process_automatic(9, "after_work")
        self.assertIn("seo_a.email_request", scheduler.state["progress"]["events"]["missed"])
        self.assertIn("offscreen.seo_a_consults_min_kyung", [item["event"] for item in applied])
        self.assertIn("present.seo_a_first_consult", scheduler.state["progress"]["memories"])

    def test_ending_priority_selects_conditioned_event_in_exclusive_group(self):
        state = self.project.initial_state()
        state["progress"]["events"]["seen"] = [
            "seo_a.email_request",
            "seo_a.relief_smile",
            "anchor.day_17_home_surprise",
        ]
        state["hidden"]["heroines"]["yoon_seo_a"]["evidence_count"] = 2
        state["hidden"]["heroines"]["yoon_seo_a"]["dislike"] = 30
        state["progress"]["flags"]["story_mode"]["target"] = "yoon_seo_a"
        scheduler = TimelineScheduler(self.project, state)
        applied = scheduler.process_automatic(17, "after_work")
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
        self.assertEqual(
            {"perceived": "han_do_yoon", "reality": "yoon_seo_a"},
            context["effective_speakers"]["request_inner"],
        )

    def test_branch_simulation_produces_exact_context_state(self):
        result = Simulator(
            self.project,
            "seo_a",
            {"seo_a.email_request": "pull_harder"},
            "first",
        ).run(stop_before_scene="seo_a.relief_smile")
        self.assertEqual("seo_a.relief_smile", result["stopped_at"])
        request_inner = next(
            event for event in result["trace"]
            if event.get("scene") == "seo_a.email_request" and event.get("node") == "request_inner"
        )
        self.assertEqual(
            {"perceived": "han_do_yoon", "reality": "yoon_seo_a"},
            request_inner["speakers"],
        )
        context = self.project.context_package("seo_a.relief_smile", result["final_state"])
        self.assertEqual(20, context["state_snapshot"]["hidden.heroines.yoon_seo_a.suspicion"])
        self.assertEqual("anxiety", context["derived_emotions"]["yoon_seo_a"]["emotion"])


if __name__ == "__main__":
    unittest.main()
