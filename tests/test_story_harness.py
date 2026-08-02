import copy
import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace

import yaml


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from story_harness import (  # noqa: E402
    NightPhaseCoordinator,
    NightPhaseError,
    SelfDevelopmentError,
    SelfDevelopmentService,
    Simulator,
    StoryProject,
    TimelineScheduler,
    apply_effect,
    break_push_pull_flow,
    can_enter_scene,
    choose_transition,
    command_night,
    command_new_scene,
    condition_matches,
    derive_emotion,
    effective_speaker,
    explore_route,
    localization_report,
    maximum_self_development_state,
    push_pull_state,
    resolve_scene_background,
    resolve_scene_stage,
    resolve_push_pull,
    resolve_dialogue_variant,
    reproducible_generated_at,
    set_path,
    self_development_expression_matches,
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
        for route_id, result in results.items():
            expected = sum(
                len(node.get("options", []))
                for scene in self.project.scenes.values()
                if scene.get("route") == route_id
                for node in scene.get("nodes", [])
                if node.get("kind") == "choice"
            )
            self.assertEqual(expected, result["choice_options"])
        self.assertTrue(results["seo_a"]["endings"])
        self.assertTrue(results["min_kyung"]["endings"])

    def test_explorer_rejects_an_unreachable_choice_option(self):
        scene = self.project.scenes["seo_a.email_request"]
        choice = next(node for node in scene["nodes"] if node["id"] == "interpret")
        option = next(item for item in choice["options"] if item["id"] == "match_push")
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
        node = next(item for item in scene["nodes"] if item["id"] == "request")
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

    def test_self_development_variant_uses_expression_requirement(self):
        node = next(
            item for item in self.project.scenes["seo_a.email_request"]["nodes"]
            if item["id"] == "appearance_observation"
        )
        base_state = self.project.initial_state()
        self.assertEqual("default", resolve_dialogue_variant(self.project, base_state, node)[0])
        self.assertFalse(
            self_development_expression_matches(self.project, base_state, "stamina.change_notice")
        )

        maximum_state = maximum_self_development_state(self.project, base_state)
        self.assertTrue(
            self_development_expression_matches(self.project, maximum_state, "stamina.change_notice")
        )
        self.assertEqual("noticed_change", resolve_dialogue_variant(self.project, maximum_state, node)[0])

    def test_self_development_registry_validates_requirements_and_score_bonus(self):
        expression = self.project.manifest["self_development"]["expressions"]["stamina.workout_answer"]
        original = copy.deepcopy(expression)
        try:
            expression["requires"] = {"stat": "unknown", "fatigue_lte": 7}
            expression["score_bonus"] = 4
            issues = []
            self.project._validate_self_development(issues)
            messages = [issue.message for issue in issues]
            self.assertTrue(any("stat and minimum must be declared together" in message for message in messages))
            self.assertTrue(any("unknown self-development stat" in message for message in messages))
            self.assertTrue(any("fatigue_lte must be an integer from 0 to 6" in message for message in messages))
            self.assertTrue(any("score_bonus must be an integer from 0 to 3" in message for message in messages))
        finally:
            expression.clear()
            expression.update(original)

    def test_self_development_registry_rejects_unknown_last_activity(self):
        expression = self.project.manifest["self_development"]["expressions"]["feedback.last_workout"]
        original = copy.deepcopy(expression)
        try:
            expression["requires"] = {"last_activity": "unknown_activity"}
            issues = []
            self.project._validate_self_development(issues)
            self.assertTrue(any(
                "last_activity must reference a known self-development activity" in issue.message
                for issue in issues
            ))
        finally:
            expression.clear()
            expression.update(original)

    def test_self_development_last_activity_requirement_reads_progress_state(self):
        state = self.project.initial_state()
        self.assertFalse(
            self_development_expression_matches(self.project, state, "feedback.last_workout")
        )
        set_path(state, "progress.self_development.last_activity", "workout")
        self.assertTrue(
            self_development_expression_matches(self.project, state, "feedback.last_workout")
        )
        set_path(state, "progress.self_development.last_activity", "grooming")
        self.assertFalse(
            self_development_expression_matches(self.project, state, "feedback.last_workout")
        )

    def test_week_one_daily_callbacks_recover_each_previous_night_activity_without_bonus(self):
        activity_variants = {
            "workout": "after_workout",
            "grooming": "after_grooming",
            "ott": "after_ott",
            "reels": "after_reels",
            "sleep": "after_sleep",
        }
        callback_nodes = (
            ("common.day_02_practical_meeting", "day_one_activity_reaction"),
            ("common.day_03_business_trip_or_cafe", "activity_callback"),
            ("common.day_04_weekend_encounter", "activity_callback"),
            ("common.day_05_weekend_reflection", "activity_callback"),
        )
        activities = {
            activity["id"]: activity
            for activity in self.project.manifest["self_development"]["activities"]
        }

        for activity_id, expected_variant in activity_variants.items():
            self.assertEqual({"perceived", "reality"}, set(activities[activity_id]["reflection_keys"]))
            expression = self.project.manifest["self_development"]["expressions"][
                f"feedback.last_{activity_id}"
            ]
            self.assertEqual(0, expression["score_bonus"])

            state = self.project.initial_state()
            set_path(state, "progress.self_development.last_activity", activity_id)
            for scene_id, node_id in callback_nodes:
                node = next(
                    item for item in self.project.scenes[scene_id]["nodes"]
                    if item["id"] == node_id
                )
                self.assertEqual(
                    expected_variant,
                    resolve_dialogue_variant(self.project, state, node)[0],
                )

        empty_state = self.project.initial_state()
        for scene_id, node_id in callback_nodes:
            node = next(
                item for item in self.project.scenes[scene_id]["nodes"]
                if item["id"] == node_id
            )
            self.assertEqual("default", resolve_dialogue_variant(self.project, empty_state, node)[0])

    def test_self_development_last_activity_requires_state_contract_read(self):
        path = "progress.self_development.last_activity"
        use = {"expression": "feedback.last_workout"}
        issues = []
        self.project._validate_self_development_use(
            issues,
            "test",
            use,
            kind="variant",
            reads=set(),
        )
        self.assertTrue(any(
            path in issue.message and "state_contract.reads" in issue.message
            for issue in issues
        ))

        issues = []
        self.project._validate_self_development_use(
            issues,
            "test",
            use,
            kind="variant",
            reads={path},
        )
        self.assertEqual([], issues)

    def test_self_development_bounds_must_match_player_runtime(self):
        path = "visible.protagonist.self_development.appeal"
        spec = self.project.manifest["stats"][path]
        original = copy.deepcopy(spec)
        try:
            spec["max"] = 101
            issues = []
            self.project._validate_self_development(issues)
            self.assertTrue(any(
                f"{path} must keep runtime bounds 0..100" in issue.message
                for issue in issues
            ))
        finally:
            spec.clear()
            spec.update(original)

    def test_general_conditions_cannot_read_self_development_state(self):
        issues = []
        self.project._validate_conditions(
            issues,
            "test",
            [{
                "path": "visible.protagonist.self_development.stats.stamina",
                "op": "gte",
                "value": 2,
            }],
            {"visible.protagonist.self_development.stats.stamina"},
        )
        self.assertTrue(any("forbidden in general conditions" in issue.message for issue in issues))

    def test_general_conditions_cannot_read_self_development_progress(self):
        path = "progress.self_development.last_activity"
        issues = []
        self.project._validate_conditions(
            issues,
            "test",
            [{"path": path, "op": "eq", "value": "workout"}],
            {path},
        )
        self.assertTrue(any("forbidden in general conditions" in issue.message for issue in issues))

    def test_general_conditions_cannot_read_display_only_initiative(self):
        path = "visible.heroines.yoon_seo_a.initiative"
        issues = []
        self.project._validate_conditions(
            issues,
            "test",
            [{"path": path, "op": "gte", "value": 60}],
            {path},
        )
        self.assertTrue(any(
            "visible initiative is display-only and forbidden in general conditions" in issue.message
            for issue in issues
        ))

    def test_self_development_choice_requires_equivalent_mechanics_and_convergence(self):
        scene = self.project.scenes["seo_a.email_request"]
        node = next(item for item in scene["nodes"] if item["id"] == "interpret")
        option = next(item for item in node["options"] if item["id"] == "mention_workout_and_step_back")
        original = copy.deepcopy(option)
        try:
            issues = []
            self.project._validate_scenes(issues)
            self.assertEqual([], issues)

            option["push_pull"]["intensity"] = 8
            option["effects"][0]["value"] = -2
            option["self_development"]["converges_at"] = "appearance_observation"
            issues = []
            self.project._validate_scenes(issues)
            messages = [issue.message for issue in issues]
            self.assertTrue(any("push_pull must match" in message for message in messages))
            self.assertTrue(any("effects must match" in message for message in messages))
            self.assertTrue(any("does not reach converges_at" in message for message in messages))
        finally:
            option.clear()
            option.update(original)

    def test_self_development_branch_allows_only_presentation_nodes_before_convergence(self):
        scene = self.project.scenes["seo_a.email_request"]
        promotion = next(item for item in scene["nodes"] if item["id"] == "workout_self_promotion")
        original_next = promotion["next"]
        injected_ids = {"workout_extra_effect", "workout_branch_gate"}
        candidates = [
            {
                "id": "workout_extra_effect",
                "kind": "effect",
                "effects": [{
                    "path": "hidden.heroines.yoon_seo_a.suspicion",
                    "op": "add",
                    "value": 50,
                }],
                "next": "after_choice",
            },
            {
                "id": "workout_branch_gate",
                "kind": "state_gate",
                "transitions": [{"default": True, "node": "after_choice"}],
            },
        ]
        try:
            for candidate in candidates:
                with self.subTest(kind=candidate["kind"]):
                    scene["nodes"].append(candidate)
                    promotion["next"] = candidate["id"]
                    issues = []
                    self.project._validate_scenes(issues)
                    self.assertTrue(any(
                        "self-development branch does not reach converges_at" in issue.message
                        and "path must contain only dialogue/narration" in issue.message
                        and f"({candidate['kind']})" in issue.message
                        for issue in issues
                    ))
                    scene["nodes"].pop()
        finally:
            promotion["next"] = original_next
            scene["nodes"][:] = [item for item in scene["nodes"] if item.get("id") not in injected_ids]

    def test_self_development_convergence_rejects_cycles_and_base_side_effects(self):
        scene = self.project.scenes["seo_a.email_request"]
        choice = next(item for item in scene["nodes"] if item["id"] == "interpret")
        promoted = next(item for item in choice["options"] if item["id"] == "mention_workout_and_step_back")
        base = next(item for item in choice["options"] if item["id"] == "match_push")
        promotion = next(item for item in scene["nodes"] if item["id"] == "workout_self_promotion")
        original_promotion_next = promotion["next"]
        original_base_next = base["next"]
        try:
            promotion["next"] = "workout_self_promotion"
            issues = []
            self.project._validate_scenes(issues)
            self.assertTrue(any(
                "self-development branch does not reach converges_at: after_choice; "
                "cycle at workout_self_promotion" in issue.message
                for issue in issues
            ))

            promotion["next"] = original_promotion_next
            scene["nodes"].append({
                "id": "base_extra_effect",
                "kind": "effect",
                "effects": [{
                    "path": "hidden.heroines.yoon_seo_a.dislike",
                    "op": "add",
                    "value": 50,
                }],
                "next": promoted["self_development"]["converges_at"],
            })
            base["next"] = "base_extra_effect"
            issues = []
            self.project._validate_scenes(issues)
            self.assertTrue(any(
                "equivalent base branch does not reach converges_at" in issue.message
                and "path must contain only dialogue/narration" in issue.message
                and "base_extra_effect (effect)" in issue.message
                for issue in issues
            ))
        finally:
            promotion["next"] = original_promotion_next
            base["next"] = original_base_next
            scene["nodes"][:] = [item for item in scene["nodes"] if item.get("id") != "base_extra_effect"]

    def test_self_development_metadata_rejects_unknown_expression(self):
        scene = self.project.scenes["seo_a.email_request"]
        node = next(item for item in scene["nodes"] if item["id"] == "appearance_observation")
        use = node["variants"][0]["self_development"]
        original = use["expression"]
        try:
            use["expression"] = "stamina.unknown"
            issues = []
            self.project._validate_scenes(issues)
            self.assertTrue(any("unknown self-development expression" in issue.message for issue in issues))
        finally:
            use["expression"] = original

    def test_self_development_service_hydrates_and_clamps_legacy_state(self):
        service = SelfDevelopmentService(self.project)
        state = self.project.initial_state()
        del state["visible"]["protagonist"]["self_development"]
        del state["progress"]["self_development"]
        service.hydrate(state)
        self.assertEqual(
            {
                "appeal": 30,
                "stats": {"stamina": 0, "appearance": 0, "humor": 0, "taste": 0},
                "fatigue": 1,
            },
            service.profile(state),
        )
        self.assertEqual(
            {"completed_days": [], "activity_history": [], "last_activity": ""},
            service.progress(state),
        )

        state["visible"]["protagonist"]["self_development"] = {
            "appeal": 500,
            "stats": {"stamina": -2, "appearance": 9, "humor": 2.9, "taste": float("nan")},
            "fatigue": float("inf"),
        }
        state["progress"]["self_development"] = {
            "completed_days": [2, 1, 2, True, 0],
            "activity_history": ["workout", 7],
            "last_activity": None,
        }
        service.hydrate(state)
        self.assertEqual(
            {
                "appeal": 100,
                "stats": {"stamina": 0, "appearance": 5, "humor": 2, "taste": 0},
                "fatigue": 1,
            },
            service.profile(state),
        )
        self.assertEqual(
            {"completed_days": [1, 2], "activity_history": ["workout"], "last_activity": ""},
            service.progress(state),
        )

    def test_night_phase_runs_selection_result_and_finish_once_per_day(self):
        state = self.project.initial_state()
        set_path(state, "progress.time.day", 1)
        set_path(state, "progress.time.slot", "after_work")
        service = SelfDevelopmentService(self.project)
        coordinator = NightPhaseCoordinator(service)

        selecting = coordinator.start(state)
        self.assertEqual("selecting", selecting["status"])
        self.assertEqual(5, len(selecting["options"]))
        self.assertTrue(all(option["available"] for option in selecting["options"]))
        with self.assertRaises(NightPhaseError) as unfinished:
            coordinator.finish(state)
        self.assertEqual("activity_not_completed", unfinished.exception.code)

        selected = coordinator.choose(state, "workout")
        self.assertEqual("result", selected["status"])
        self.assertEqual(3, selected["result"]["appeal_delta"])
        self.assertEqual(2, selected["result"]["fatigue_delta"])
        self.assertEqual({"stamina": 2, "appearance": 1}, selected["result"]["stat_deltas"])
        self.assertEqual(
            {
                "appeal": 33,
                "stats": {"stamina": 2, "appearance": 1, "humor": 0, "taste": 0},
                "fatigue": 3,
            },
            selected["profile"],
        )
        self.assertTrue(
            self_development_expression_matches(self.project, state, "stamina.workout_answer")
        )

        finished = coordinator.finish(state)
        self.assertEqual("finished", finished["status"])
        self.assertEqual("workout", finished["activity"])
        self.assertEqual(
            {"completed_days": [1], "activity_history": ["workout"], "last_activity": "workout"},
            service.progress(state),
        )
        self.assertFalse(coordinator.should_start(state))
        with self.assertRaises(SelfDevelopmentError) as repeated:
            service.perform_activity(state, "workout", 1)
        self.assertEqual("already_completed", repeated.exception.code)

    def test_night_activity_options_report_time_and_fatigue_reasons(self):
        service = SelfDevelopmentService(self.project)
        state = self.project.initial_state()
        morning = service.activity_options(state)
        self.assertEqual({"not_after_work"}, {option.get("reason") for option in morning})

        set_path(state, "progress.time.slot", "after_work")
        set_path(state, "progress.time.day", 16)
        self.assertTrue(NightPhaseCoordinator(service).should_start(state))
        set_path(state, "progress.time.day", 17)
        outside = service.activity_options(state)
        self.assertEqual({"outside_night_window"}, {option.get("reason") for option in outside})

        set_path(state, "progress.time.day", 1)
        set_path(state, "visible.protagonist.self_development.fatigue", 5)
        options = {item["activity"]["id"]: item for item in service.activity_options(state)}
        self.assertEqual("fatigue_limit", options["workout"]["reason"])
        self.assertTrue(options["grooming"]["available"])
        self.assertTrue(options["sleep"]["available"])

        service.activities["workout"]["fatigue_lte"] = 5
        overflow = {item["activity"]["id"]: item for item in service.activity_options(state)}
        self.assertEqual("fatigue_overflow", overflow["workout"]["reason"])

    def test_self_development_result_reports_actual_clamped_deltas(self):
        service = SelfDevelopmentService(self.project)
        state = self.project.initial_state()
        set_path(state, "progress.time.slot", "after_work")
        set_path(state, "visible.protagonist.self_development.appeal", 99)
        set_path(state, "visible.protagonist.self_development.fatigue", 4)
        set_path(state, "visible.protagonist.self_development.stats.stamina", 4)
        set_path(state, "visible.protagonist.self_development.stats.appearance", 5)
        result = service.perform_activity(state, "workout", 1)
        self.assertEqual(1, result["appeal_delta"])
        self.assertEqual(2, result["fatigue_delta"])
        self.assertEqual({"stamina": 1, "appearance": 0}, result["stat_deltas"])
        self.assertEqual(100, result["after"]["appeal"])
        self.assertEqual(6, result["after"]["fatigue"])

    def test_night_command_previews_and_applies_activity_as_json(self):
        output = io.StringIO()
        with redirect_stdout(output):
            exit_code = command_night(
                self.project,
                SimpleNamespace(day=1, activity="workout", state=[], json=True),
            )
        payload = json.loads(output.getvalue())
        self.assertEqual(0, exit_code)
        self.assertTrue(payload["available_before"])
        self.assertFalse(payload["available"])
        self.assertEqual("finished", payload["status"])
        self.assertEqual("workout", payload["result"]["activity"])
        self.assertEqual([1], payload["progress"]["completed_days"])
        self.assertEqual(33, payload["profile"]["appeal"])

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
        node = next(item for item in scene["nodes"] if item["id"] == "request")
        original = copy.deepcopy(node["reality"])
        try:
            del node["reality"]
            issues = self.project.validate()
            self.assertTrue(any("reality layer is required" in issue.message for issue in issues))
        finally:
            node["reality"] = original

    def test_legacy_embedded_thought_fields_are_rejected(self):
        node = next(
            item for item in self.project.scenes["seo_a.email_request"]["nodes"]
            if item["id"] == "request"
        )
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
        node = next(item for item in scene["nodes"] if item["id"] == "request")
        original = node["perceived"]["line"]
        try:
            node["perceived"]["line"] = "다르게 들린 문장"
            issues = self.project.validate()
            self.assertTrue(any("spoken lines must match" in issue.message for issue in issues))
        finally:
            node["perceived"]["line"] = original

    def test_romance_insert_allows_marked_spoken_line_distortion(self):
        scene = self.project.scenes["seo_a.email_request"]
        node = next(item for item in scene["nodes"] if item["id"] == "request")
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

    def test_choice_interaction_rejects_unknown_target_and_support_style(self):
        scene = self.project.scenes["common.day_02_practical_meeting"]
        choice = next(node for node in scene["nodes"] if node["id"] == "recovery_choice")
        option = next(item for item in choice["options"] if item["id"] == "define_and_fix")
        original = copy.deepcopy(option["interaction"])
        try:
            option["interaction"] = {
                "target": "unknown_character",
                "support_styles": ["instant_romance"],
            }
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("unknown interaction target" in message for message in messages))
            self.assertTrue(any("unknown interaction support style" in message for message in messages))
        finally:
            option["interaction"] = original

    def test_choice_interaction_accepts_a_non_route_cast_character(self):
        scene = self.project.scenes["common.day_02_practical_meeting"]
        choice = next(node for node in scene["nodes"] if node["id"] == "recovery_choice")
        option = next(item for item in choice["options"] if item["id"] == "define_and_fix")
        original = copy.deepcopy(option["interaction"])
        try:
            option["interaction"] = {
                "target": "kang_yoo_jin",
                "support_styles": ["factual_clarification", "literal_respect"],
            }
            self.assertEqual([], self.project.validate())
        finally:
            option["interaction"] = original

    def test_choice_interaction_reports_malformed_support_style_without_crashing(self):
        scene = self.project.scenes["common.day_02_practical_meeting"]
        choice = next(node for node in scene["nodes"] if node["id"] == "recovery_choice")
        option = next(item for item in choice["options"] if item["id"] == "define_and_fix")
        original = copy.deepcopy(option["interaction"])
        try:
            option["interaction"] = {
                "target": "cha_min_kyung",
                "support_styles": [{"invalid": True}],
            }
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("support style must be a non-empty string" in message for message in messages))
        finally:
            option["interaction"] = original

    def test_choice_targets_report_malformed_values_without_crashing(self):
        scene = self.project.scenes["common.day_02_practical_meeting"]
        choice = next(node for node in scene["nodes"] if node["id"] == "recovery_choice")
        option = next(item for item in choice["options"] if item["id"] == "define_and_fix")
        original_push_pull = copy.deepcopy(option["push_pull"])
        original_interaction = copy.deepcopy(option["interaction"])
        try:
            option["push_pull"]["target"] = {"invalid": True}
            option["interaction"]["target"] = ["cha_min_kyung"]
            messages = [issue.message for issue in self.project.validate()]
            self.assertIn("push_pull target must be a valid character id", messages)
            self.assertIn("interaction target must be a valid character id", messages)

            option["push_pull"]["target"] = None
            option["interaction"]["target"] = None
            messages = [issue.message for issue in self.project.validate()]
            self.assertIn("push_pull target must be a valid character id", messages)
            self.assertIn("interaction target must be a valid character id", messages)
        finally:
            option["push_pull"] = original_push_pull
            option["interaction"] = original_interaction

    def test_push_pull_target_requires_known_cast_heroine_and_declared_state_paths(self):
        scene = self.project.scenes["common.day_02_practical_meeting"]
        choice = next(node for node in scene["nodes"] if node["id"] == "recovery_choice")
        option = next(item for item in choice["options"] if item["id"] == "define_and_fix")
        original_target = option["push_pull"]["target"]
        try:
            option["push_pull"]["target"] = "unknown_character"
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("unknown push_pull target" in message for message in messages))

            option["push_pull"]["target"] = "im_soo_yeon"
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("push_pull target has no heroine state" in message for message in messages))

            option["push_pull"]["target"] = "cha_min_kyung"
            scene["cast"].remove("cha_min_kyung")
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("push_pull target is not in scene cast" in message for message in messages))
            scene["cast"].append("cha_min_kyung")

            path = "visible.heroines.cha_min_kyung.initiative"
            scene["state_contract"]["writes"].remove(path)
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any(path in message and "state_contract.writes" in message for message in messages))
            scene["state_contract"]["writes"].append(path)

            option["effects"].append({
                "path": "visible.heroines.yoon_seo_a.initiative",
                "op": "add",
                "value": 1,
            })
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any(
                "push_pull choice must not manually write compatibility stat" in message
                and "visible.heroines.yoon_seo_a.initiative" in message
                for message in messages
            ))
            option["effects"].pop()
        finally:
            option["push_pull"]["target"] = original_target
            option["effects"] = [
                effect for effect in option["effects"]
                if effect.get("path") != "visible.heroines.yoon_seo_a.initiative"
            ]
            if "cha_min_kyung" not in scene["cast"]:
                scene["cast"].append("cha_min_kyung")
            path = "visible.heroines.cha_min_kyung.initiative"
            if path not in scene["state_contract"]["writes"]:
                scene["state_contract"]["writes"].append(path)

    def test_interaction_target_requires_cast_preferences_and_unique_styles(self):
        scene = self.project.scenes["common.day_02_practical_meeting"]
        choice = next(node for node in scene["nodes"] if node["id"] == "recovery_choice")
        option = next(item for item in choice["options"] if item["id"] == "define_and_fix")
        original = copy.deepcopy(option["interaction"])
        try:
            option["interaction"]["target"] = "im_soo_yeon"
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("interaction target is not in scene cast" in message for message in messages))

            option["interaction"]["target"] = "han_do_yoon"
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("interaction target has no interaction_preferences" in message for message in messages))

            option["interaction"] = {
                "target": "cha_min_kyung",
                "support_styles": ["factual_clarification", "factual_clarification"],
            }
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("interaction support_styles must be unique" in message for message in messages))
        finally:
            option["interaction"] = original

    def test_character_interaction_preferences_reject_unknown_and_duplicate_styles(self):
        character = self.project.characters["yoon_seo_a"]
        original = copy.deepcopy(character["interaction_preferences"])
        try:
            character["interaction_preferences"]["support_order"] = ["not_a_style", "not_a_style"]
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("unknown support style" in message for message in messages))
            self.assertTrue(any("support_order styles must be unique" in message for message in messages))
        finally:
            character["interaction_preferences"] = original

    def test_invalid_expression_layer_is_rejected(self):
        scene = self.project.scenes["seo_a.email_request"]
        node = next(item for item in scene["nodes"] if item["id"] == "request")
        original = node["reality"]["expression"]
        try:
            node["reality"]["expression"] = "subjective_shy"
            issues = self.project.validate()
            self.assertTrue(any("belongs to perceived, not reality" in issue.message for issue in issues))
        finally:
            node["reality"]["expression"] = original

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

    def test_common_scene_push_pull_target_updates_min_kyung_only(self):
        result = Simulator(
            self.project,
            "seo_a",
            {"common.day_02_practical_meeting": "define_and_fix"},
            "first",
        ).run(stop_before_scene="seo_a.email_request")
        self.assertEqual("seo_a.email_request", result["stopped_at"])
        final_state = result["final_state"]
        self.assertEqual(50, final_state["visible"]["heroines"]["yoon_seo_a"]["initiative"])
        self.assertEqual(54, final_state["visible"]["heroines"]["cha_min_kyung"]["initiative"])
        self.assertEqual("cha_min_kyung", push_pull_state(final_state)["heroine"])
        self.assertEqual("none", final_state["progress"]["flags"]["story_mode"]["target"])
        self.assertEqual("factual_resolution", final_state["progress"]["flags"]["story_mode"]["day_02_response"])

    def test_interaction_metadata_does_not_change_push_pull_or_hidden_state(self):
        scene = self.project.scenes["common.day_02_practical_meeting"]
        choice = next(node for node in scene["nodes"] if node["id"] == "recovery_choice")
        option = next(item for item in choice["options"] if item["id"] == "define_and_fix")
        original = copy.deepcopy(option["interaction"])
        with_interaction = Simulator(
            self.project,
            "seo_a",
            {"common.day_02_practical_meeting": "define_and_fix"},
            "first",
        ).run(stop_before_scene="seo_a.email_request")
        try:
            option.pop("interaction")
            without_interaction = Simulator(
                self.project,
                "seo_a",
                {"common.day_02_practical_meeting": "define_and_fix"},
                "first",
            ).run(stop_before_scene="seo_a.email_request")
        finally:
            option["interaction"] = original

        self.assertEqual(with_interaction["final_state"], without_interaction["final_state"])
        with_choice = next(item for item in with_interaction["trace"] if item.get("type") == "choice")
        without_choice = next(item for item in without_interaction["trace"] if item.get("type") == "choice")
        self.assertEqual(with_choice["push_pull"], without_choice["push_pull"])

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

    def test_push_pull_applies_bounded_visible_bonus_only_when_scoring(self):
        state = self.project.initial_state()
        config = {"action": "approach", "intensity": 12, "base_score": 4}
        scored = resolve_push_pull(
            self.project,
            state,
            "yoon_seo_a",
            config,
            visible_score_bonus=2,
        )
        self.assertEqual(4, scored["base_gain"])
        self.assertEqual(2, scored["bonus_gain"])
        self.assertEqual(6, scored["gain"])
        self.assertEqual(56, state["visible"]["heroines"]["yoon_seo_a"]["initiative"])
        self.assertEqual(
            {"suspicion": 0, "dislike": 0, "evidence_count": 0},
            scored["hidden_delta"],
        )

        state["progress"]["flags"]["push_pull"].update({
            "combo": 1,
            "position": -12,
            "target": "pull",
            "last_action": "approach",
            "heroine": "yoon_seo_a",
        })
        wrong = resolve_push_pull(
            self.project,
            state,
            "yoon_seo_a",
            {"action": "space", "intensity": 12, "base_score": 4},
            visible_score_bonus=99,
        )
        self.assertEqual(0, wrong["base_gain"])
        self.assertEqual(0, wrong["bonus_gain"])
        self.assertEqual(0, wrong["gain"])

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
        self.assertEqual("appearance_observation", scene["node_order"][0])
        self.assertIn("source_sha256", bundle)
        self.assertEqual(16, bundle["self_development"]["max_night_day"])
        self.assertIn("stamina.workout_answer", bundle["self_development"]["expressions"])

        preferences = bundle["characters"]["cha_min_kyung"]["interaction_preferences"]
        self.assertEqual("factual_clarification", preferences["support_order"][0])
        shared_choice = bundle["scenes"]["common.day_02_practical_meeting"]["nodes"]["recovery_choice"]
        factual = next(option for option in shared_choice["options"] if option["id"] == "define_and_fix")
        self.assertEqual(
            {
                "target": "cha_min_kyung",
                "support_styles": ["factual_clarification", "practical_resolution"],
            },
            factual["interaction"],
        )
        self.assertEqual("cha_min_kyung", factual["push_pull"]["target"])

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
        self.assertEqual("오세진", world["entities"]["member.oh_se_jin"]["name"])
        self.assertEqual("오차장", world["entities"]["member.oh_se_jin"]["display_name"])
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
            ("team.sales_planning", "lead_member", "member.unknown", "unknown member reference"),
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
            "오차장",
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
        self.assertIn("perceived", first_node["variants"][0])
        self.assertIn("reality", first_node["variants"][0])
        self.assertIn("authoring_rules", context)
        self.assertIn("literal_respect", context["allowed_system"]["support_styles"])
        self.assertEqual(
            ["emotional_validation", "ask_before_helping", "autonomy_return", "practical_resolution"],
            context["cast"]["yoon_seo_a"]["interaction_preferences"]["support_order"],
        )
        self.assertEqual(
            {"perceived": "han_do_yoon", "reality": "yoon_seo_a"},
            context["effective_speakers"]["request_inner"],
        )

        shared_context = self.project.context_package("common.day_02_practical_meeting")
        recovery = next(node for node in shared_context["scene"]["nodes"] if node["id"] == "recovery_choice")
        factual = next(option for option in recovery["options"] if option["id"] == "define_and_fix")
        self.assertEqual("cha_min_kyung", factual["interaction"]["target"])
        self.assertEqual("cha_min_kyung", factual["push_pull"]["target"])

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
