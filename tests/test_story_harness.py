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
        original = self.project.ui["strings"]["mode.survivor.copy"]
        try:
            self.project.ui["strings"]["mode.survivor.copy"] = "다른 설명"
            issues = self.project.validate()
            self.assertTrue(any("approved player copy" in issue.message for issue in issues))
        finally:
            self.project.ui["strings"]["mode.survivor.copy"] = original

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
                    verdict = TimelineScheduler(self.project, event["campaign_id"], state).inspect_event(
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
        original_line = node.pop("line")
        original_expression = node.pop("expression")
        node["variants"] = [
            {
                "id": "guarded",
                "priority": 100,
                "conditions": [{
                    "path": "derived.characters.yoon_seo_a.emotion",
                    "op": "eq",
                    "value": "fear",
                }],
                "line": original_line,
                "expression": original_expression,
            },
            {
                "id": "default",
                "default": True,
                "line": original_line,
                "expression": original_expression,
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
            node["line"] = original_line
            node["expression"] = original_expression
            scene["state_contract"]["reads"].remove("derived.characters.yoon_seo_a.emotion")

    def test_self_development_profile_unlocks_expression_without_overnight_body_notice(self):
        node = next(
            item for item in self.project.scenes["seo_a.email_request"]["nodes"]
            if item["id"] == "appearance_observation"
        )
        base_state = self.project.initial_state()
        self.assertEqual("default", resolve_dialogue_variant(self.project, base_state, node)[0])
        self.assertNotIn("variants", node)
        self.assertNotIn("살이", node["line"])
        self.assertFalse(
            self_development_expression_matches(self.project, base_state, "health.workout_answer")
        )

        maximum_state = maximum_self_development_state(self.project, base_state)
        self.assertTrue(
            self_development_expression_matches(self.project, maximum_state, "health.workout_answer")
        )
        self.assertEqual("default", resolve_dialogue_variant(self.project, maximum_state, node)[0])

    def test_self_development_registry_validates_requirements_and_score_bonus(self):
        expression = self.project.manifest["self_development"]["expressions"]["health.workout_answer"]
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
            self.assertTrue(any("score_bonus must be an integer from 0 to 0" in message for message in messages))
        finally:
            expression.clear()
            expression.update(original)

    def test_named_stats_can_gate_only_additive_player_events(self):
        event = self.project.events["seo_a.relief_smile"]
        original = copy.deepcopy(event)
        try:
            event["requires"]["conditions"] = [{
                "path": "visible.protagonist.self_development.stats.intelligence",
                "op": "gte",
                "value": 3,
            }]
            event["on_seen"]["effects"] = [{
                "path": "progress.memories",
                "op": "append_unique",
                "value": "cg.stat.intelligence.min_kyung",
            }]
            issues = []
            self.project._validate_events(issues)
            self.assertEqual([], issues)

            event["availability"] = "automatic"
            issues = []
            self.project._validate_events(issues)
            self.assertTrue(any(
                "self-development stat-gated events must use player availability" in issue.message
                for issue in issues
            ))

            event["availability"] = "player"
            event["requires"]["conditions"][0]["path"] = "visible.protagonist.self_development.fatigue"
            issues = []
            self.project._validate_events(issues)
            self.assertTrue(any(
                "only named stats may gate additive player events" in issue.message
                for issue in issues
            ))

            event["requires"]["conditions"][0]["path"] = "visible.protagonist.self_development.stats.intelligence"
            event["on_seen"]["effects"] = []
            issues = []
            self.project._validate_events(issues)
            self.assertTrue(any(
                "must award a registered gallery memory" in issue.message
                for issue in issues
            ))
        finally:
            event.clear()
            event.update(original)

    def test_gallery_registry_assets_and_unlock_memories_are_valid(self):
        issues = []
        self.project._validate_gallery(issues)
        self.assertEqual([], issues)
        entries = self.project.manifest["gallery"]["entries"]
        self.assertEqual(5, len(entries))
        self.assertTrue(entries[0]["default_unlocked"])
        self.assertEqual(
            {"health", "appearance", "humor", "intelligence"},
            {entry["source_stat"] for entry in entries if entry.get("source_stat")},
        )

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
        set_path(state, "progress.self_development.last_activity", "reading")
        self.assertFalse(
            self_development_expression_matches(self.project, state, "feedback.last_workout")
        )

    def test_week_one_daily_callbacks_recover_each_previous_night_activity_without_bonus(self):
        activity_variants = {
            "workout": "after_workout",
            "reading": "after_reading",
            "ott": "after_ott",
            "sleep": "after_sleep",
            "dark_psychology": "after_dark_psychology",
            "solo_drinking": "after_solo_drinking",
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

    def test_week_one_dark_psychology_lessons_open_the_next_day_callbacks(self):
        expected_lessons = {
            1: (
                "anchor.day_01_dark_psychology_lesson",
                "common.day_01_dark_psychology_lesson",
                "progress.flags.dark_psychology.chapter_2_read",
                "2. 여자의 마음을 쥐고 흔드는 밀고 당기기 다크 법칙",
                "오늘 밤은 이 장을 읽어 봅시다~!",
            ),
            2: (
                "anchor.day_02_dark_psychology_lesson",
                "common.day_02_dark_psychology_lesson",
                "progress.flags.dark_psychology.chapter_4_2_read",
                "4.2 MBTI로 여성 심리 장악하기",
                "이 장을 읽어 보시라~!",
            ),
            5: (
                "anchor.day_05_dark_psychology_lesson",
                "common.day_05_dark_psychology_lesson",
                "progress.flags.dark_psychology.chapter_1_2_read",
                "1.2 당신에게 호감이 있는 여성이 절대 숨길 수 없는 시그널",
                "이 장을 읽어 보시라~!",
            ),
        }

        for day, (event_id, scene_id, flag_path, chapter_title, recommendation) in expected_lessons.items():
            event = self.project.events[event_id]
            scene = self.project.scenes[scene_id]
            self.assertEqual([day, day], event["window"]["days"])
            self.assertEqual(["after_work"], event["window"]["slots"])
            self.assertEqual(scene_id, event["scene"])
            self.assertIn("dark_psychology_instructor", scene["cast"])
            self.assertIn(flag_path, scene["state_contract"]["writes"])
            spoken_lines = [
                node.get("line", "")
                for node in scene["nodes"]
                if node.get("kind") == "dialogue"
            ]
            self.assertEqual(chapter_title, scene["title"])
            chapter_name = chapter_title.split(" ", 1)[1]
            self.assertTrue(any(chapter_name in line for line in spoken_lines))
            self.assertTrue(any(recommendation in line for line in spoken_lines))
            self.assertGreaterEqual(
                sum(node.get("speaker") == "dark_psychology_instructor" for node in scene["nodes"]),
                2,
            )

        day_one_lines = [
            node.get("line", "")
            for node in self.project.scenes["common.day_01_dark_psychology_lesson"]["nodes"]
            if node.get("kind") == "dialogue"
        ]
        for rejected_line in (
            "(서아 씨와 민경 씨…… 조금 더 알아보고 싶은데, 어디서부터 시작해야 하지?)",
            "밀고 당기기를 시작하고 싶은 당신! 2. 여자의 마음을 쥐고 흔드는 밀고 당기기 다크 법칙, 이 장을 읽어 보시라~!",
            "외모를 칭찬하고 먼저 연락하는 것은 당기기. 답장을 늦추고 갑자기 차갑게 대하는 것은 밀기입니다. 전부 쓸 필요는 없습니다. 상황에 맞는 한 수만 고르십시오.",
            "(좋아. 내일부터 시작해 보자. 먼저 다가갈지, 한발 물러날지 내가 정하는 거야.)",
        ):
            self.assertNotIn(rejected_line, day_one_lines)
        day_one = self.project.scenes["common.day_01_dark_psychology_lesson"]
        day_one_nodes = {node["id"]: node for node in day_one["nodes"]}
        for heroine_id in ("yoon_seo_a", "cha_min_kyung", "kang_yoo_jin"):
            self.assertIn(heroine_id, day_one["cast"])
        for heroine_line in (
            "서아씨는 웃는 모습이 정말 귀여웠어...",
            "민경씨는 차갑지만 미친듯이 아름다웠어..!",
            "유진씨는 햇님처럼 이쁘게 웃었어",
            "유진씨랑 함께한다면 우울증에 걸려 방에만 있는 사람조차 환하게 웃고 말거야",
            "분명 가족들에게 무한한 사랑을 받고 자랐겠지?",
            "모든 학교 남학생들이 몰래 유진씨를 짝사랑했을거야..",
            "남자친구는.. 정말!",
            "맨날 맨날 죽을만큼 행복할거야..",
            "나쁜 놈.. 부럽다..!!!",
        ):
            self.assertIn(heroine_line, day_one_lines)
        for rejected_line in (
            "웃을 때마다 파란 사원증 줄까지 같이 흔들렸지.",
            "말도 행동도 그렇게 정신없는데 어떻게 저렇게 아름다울 수가 있는 거야?",
            "그런 초미녀가 먼저 커피 이야기를 꺼내다니... 오늘은 정말 믿을 수 없는 하루였어.",
        ):
            self.assertNotIn(rejected_line, day_one_lines)

        recall_nodes = {
            "yoon_seo_a": (
                "do_yoon_wonders",
                "seo_a_idol",
                "seo_a_brown",
                "seo_a_pet",
                "seo_a_soft",
                "seo_a_lovely",
                "seo_a_same_team",
            ),
            "cha_min_kyung": (
                "do_yoon_catches_himself",
                "min_kyung_actress",
                "min_kyung_moles",
                "min_kyung_eyes",
                "min_kyung_perfect",
                "min_kyung_walk",
                "min_kyung_boyfriend",
                "min_kyung_lonely",
                "min_kyung_comfort",
            ),
            "kang_yoo_jin": (
                "yoo_jin_bright",
                "yoo_jin_smile_reaches_anyone",
                "yoo_jin_loved_family",
                "yoo_jin_school_crushes",
                "yoo_jin_boyfriend",
                "yoo_jin_boyfriend_happy",
                "yoo_jin_fun",
            ),
        }
        for heroine_id, node_ids in recall_nodes.items():
            for node_id in node_ids:
                self.assertEqual(
                    [{
                        "position": "center",
                        "character": heroine_id,
                        "visual_id": f"character.{heroine_id}",
                        "artwork": "default",
                    }],
                    day_one_nodes[node_id]["stage"],
                )

        self.assertEqual(
            [
                {
                    "position": "left",
                    "character": "yoon_seo_a",
                    "visual_id": "character.yoon_seo_a",
                    "artwork": "default",
                },
                {
                    "position": "center",
                    "character": "cha_min_kyung",
                    "visual_id": "character.cha_min_kyung",
                    "artwork": "default",
                },
                {
                    "position": "right",
                    "character": "kang_yoo_jin",
                    "visual_id": "character.kang_yoo_jin",
                    "artwork": "default",
                },
            ],
            day_one_nodes["do_yoon_hopes"]["stage"],
        )
        for golden_line in (
            "그녀를 떠올리며 잠 못 이루는 당신!",
            "여자의 마음을 쥐고 흔드는 밀당의 다크 심리학!! 알고 싶지 않은가?",
            "네~! 접니다! 10년 동안 여자 92명과 사랑을 나눈..",
            "어둠의 심리학 마스터~~~~~! 워누~Park!",
            "뭐가 그렇게 의심이 많으십니까~!!",
            '제 2장 "여자의 마음을 쥐고 흔드는 밀고 당기기 다크 법칙!" 오늘 밤은 이 장을 읽어 봅시다~!',
        ):
            self.assertIn(golden_line, day_one_lines)
        self.assertEqual("(푸수수수숙!)", day_one_nodes["book_rustles"]["line"])
        for node in day_one["nodes"]:
            if node.get("speaker") == "han_do_yoon":
                self.assertFalse(node["line"].startswith("("), node["id"])

        instructor = self.project.characters["dark_psychology_instructor"]
        self.assertEqual("강사님", instructor["display_name"])
        instructor_reference_lines = {
            item["line"] for item in instructor["voice"]["reference_lines"]
        }
        self.assertIn("그녀를 떠올리며 잠 못 이루는 당신!", instructor_reference_lines)
        self.assertIn("어둠의 심리학 마스터~~~~~! 워누~Park!", instructor_reference_lines)

        day_two = self.project.scenes["common.day_02_practical_meeting"]
        day_three = self.project.scenes["common.day_03_business_trip_or_cafe"]
        day_two_nodes = {node["id"]: node for node in day_two["nodes"]}
        day_three_nodes = {node["id"]: node for node in day_three["nodes"]}
        self.assertEqual("first_lesson_gate", day_two_nodes["seo_a_freezes"]["next"])
        self.assertEqual("instructor_starts_game", day_two_nodes["do_yoon_recalls_first_lesson"]["next"])
        self.assertEqual("mbti_lesson_gate", day_three_nodes["activity_response"]["next"])
        self.assertIn("바로 이겁니다!", day_three_nodes["instructor_confirms_st"]["line"])
        self.assertIn("ST", day_three_nodes["structure_success"]["line"])

        for scene_id, node_id in (
            ("common.day_02_practical_meeting", "day_one_activity_reaction"),
            ("common.day_03_business_trip_or_cafe", "activity_callback"),
            ("common.day_04_weekend_encounter", "activity_callback"),
            ("common.day_05_weekend_reflection", "activity_callback"),
        ):
            node = next(item for item in self.project.scenes[scene_id]["nodes"] if item["id"] == node_id)
            variant = next(item for item in node["variants"] if item["id"] == "after_dark_psychology")
            self.assertNotIn("여성의 마음을 지배하는 어둠의 심리학", variant["line"])

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
                "path": "visible.protagonist.self_development.stats.health",
                "op": "gte",
                "value": 2,
            }],
            {"visible.protagonist.self_development.stats.health"},
        )
        self.assertTrue(any("self-development state is forbidden here" in issue.message for issue in issues))

    def test_general_conditions_cannot_read_self_development_progress(self):
        path = "progress.self_development.last_activity"
        issues = []
        self.project._validate_conditions(
            issues,
            "test",
            [{"path": path, "op": "eq", "value": "workout"}],
            {path},
        )
        self.assertTrue(any("self-development state is forbidden here" in issue.message for issue in issues))

    def test_general_conditions_cannot_read_display_only_affection(self):
        path = "visible.heroines.yoon_seo_a.affection"
        issues = []
        self.project._validate_conditions(
            issues,
            "test",
            [{"path": path, "op": "gte", "value": 60}],
            {path},
        )
        self.assertTrue(any(
            "visible affection is display-only and forbidden in general conditions" in issue.message
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
        node = next(item for item in scene["nodes"] if item["id"] == "interpret")
        option = next(item for item in node["options"] if item["id"] == "mention_workout_and_step_back")
        use = option["self_development"]
        original = use["expression"]
        try:
            use["expression"] = "health.unknown"
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
                "stats": {"health": 0, "appearance": 0, "humor": 0, "intelligence": 0},
                "fatigue": 1,
            },
            service.profile(state),
        )
        self.assertEqual(
            {"completed_days": [], "activity_history": [], "last_activity": "", "hint_charges": 0},
            service.progress(state),
        )

        state["visible"]["protagonist"]["self_development"] = {
            "appeal": 500,
            "stats": {"stamina": 3, "health": -2, "appearance": 9, "humor": 2.9, "intelligence": float("nan")},
            "fatigue": float("inf"),
        }
        state["progress"]["self_development"] = {
            "completed_days": [2, 1, 2, True, 0],
            "activity_history": ["workout", 7],
            "last_activity": None,
            "hint_charges": 99,
        }
        service.hydrate(state)
        self.assertEqual(
            {
                "appeal": 100,
                "stats": {"health": 0, "appearance": 5, "humor": 2, "intelligence": 0},
                "fatigue": 1,
            },
            service.profile(state),
        )
        self.assertEqual(
            {"completed_days": [1, 2], "activity_history": ["workout"], "last_activity": "", "hint_charges": 9},
            service.progress(state),
        )

    def test_night_phase_runs_selection_result_and_finish_once_per_day(self):
        state = self.project.initial_state()
        set_path(state, "progress.time.day", 1)
        set_path(state, "progress.time.slot", "after_work")
        service = SelfDevelopmentService(self.project)
        coordinator = NightPhaseCoordinator(service)

        intro = coordinator.start(state)
        self.assertEqual("intro", intro["status"])
        selecting = coordinator.continue_intro(state, intro)
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
        self.assertEqual({"health": 2, "appearance": 1}, selected["result"]["stat_deltas"])
        self.assertEqual(
            {
                "appeal": 33,
                "stats": {"health": 2, "appearance": 1, "humor": 0, "intelligence": 0},
                "fatigue": 3,
            },
            selected["profile"],
        )
        self.assertTrue(
            self_development_expression_matches(self.project, state, "health.workout_answer")
        )

        finished = coordinator.finish(state)
        self.assertEqual("finished", finished["status"])
        self.assertEqual("workout", finished["activity"])
        self.assertEqual(
            {"completed_days": [1], "activity_history": ["workout"], "last_activity": "workout", "hint_charges": 0},
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
        self.assertTrue(options["reading"]["available"])
        self.assertTrue(options["sleep"]["available"])

        service.activities["workout"]["fatigue_lte"] = 5
        overflow = {item["activity"]["id"]: item for item in service.activity_options(state)}
        self.assertEqual("fatigue_overflow", overflow["workout"]["reason"])

        intro = NightPhaseCoordinator(service).start(state)
        self.assertEqual("solo_drinking", intro["forced_activity_id"])
        forced = NightPhaseCoordinator(service).continue_intro(state, intro)
        self.assertEqual("solo_drinking", forced["result"]["activity"])
        self.assertEqual(-2, forced["result"]["fatigue_delta"])

    def test_self_development_result_reports_actual_clamped_deltas(self):
        service = SelfDevelopmentService(self.project)
        state = self.project.initial_state()
        set_path(state, "progress.time.slot", "after_work")
        set_path(state, "visible.protagonist.self_development.appeal", 99)
        set_path(state, "visible.protagonist.self_development.fatigue", 4)
        set_path(state, "visible.protagonist.self_development.stats.health", 4)
        set_path(state, "visible.protagonist.self_development.stats.appearance", 5)
        result = service.perform_activity(state, "workout", 1)
        self.assertEqual(1, result["appeal_delta"])
        self.assertEqual(2, result["fatigue_delta"])
        self.assertEqual({"health": 1, "appearance": 0}, result["stat_deltas"])
        self.assertEqual(100, result["after"]["appeal"])
        self.assertEqual(6, result["after"]["fatigue"])

    def test_dark_psychology_study_charges_one_hint(self):
        service = SelfDevelopmentService(self.project)
        state = self.project.initial_state()
        set_path(state, "progress.time.slot", "after_work")
        result = service.perform_activity(state, "dark_psychology", 1)
        self.assertEqual(2, result["fatigue_delta"])
        self.assertEqual(1, result["hint_charge_delta"])
        self.assertEqual(1, service.progress(state)["hint_charges"])

    def test_night_command_previews_and_applies_activity_as_json(self):
        output = io.StringIO()
        with redirect_stdout(output):
            exit_code = command_night(
                self.project,
                SimpleNamespace(campaign="main", day=1, activity="workout", state=[], json=True),
            )
        payload = json.loads(output.getvalue())
        self.assertEqual(0, exit_code)
        self.assertTrue(payload["available_before"])
        self.assertFalse(payload["available"])
        self.assertEqual("finished", payload["status"])
        self.assertEqual("workout", payload["result"]["activity"])
        self.assertEqual([1], payload["progress"]["completed_days"])
        self.assertEqual(33, payload["profile"]["appeal"])

    def test_expression_fallback_priority_respects_explicit_expression(self):
        character = self.project.characters["yoon_seo_a"]
        original_rules = character["emotion_rules"]
        node = {
            "id": "expression",
            "kind": "dialogue",
            "speaker": "yoon_seo_a",
            "line": "대사",
            "next": "done",
        }
        try:
            character["emotion_rules"] = []
            _, resolved = resolve_dialogue_variant(self.project, self.project.initial_state(), node)
            self.assertEqual("actual_social_smile", resolved["expression"])
            node["expression"] = "actual_relief"
            _, explicit = resolve_dialogue_variant(self.project, self.project.initial_state(), node)
            self.assertEqual("actual_relief", explicit["expression"])
        finally:
            character["emotion_rules"] = original_rules

    def test_removed_reality_layer_is_rejected(self):
        scene = self.project.scenes["seo_a.email_request"]
        node = next(item for item in scene["nodes"] if item["id"] == "request")
        try:
            node["reality"] = {"line": node["line"]}
            issues = self.project.validate()
            self.assertTrue(any("removed dialogue field is forbidden: reality" in issue.message for issue in issues))
        finally:
            node.pop("reality", None)

    def test_legacy_embedded_thought_fields_are_rejected(self):
        node = next(
            item for item in self.project.scenes["seo_a.email_request"]["nodes"]
            if item["id"] == "request"
        )
        try:
            node["protagonist_interpretation"] = "legacy"
            node["inner_thought"] = "legacy"
            issues = []
            self.project._validate_scenes(issues)
            messages = [issue.message for issue in issues]
            self.assertTrue(any("removed dialogue field is forbidden: protagonist_interpretation" in message for message in messages))
            self.assertTrue(any("removed dialogue field is forbidden: inner_thought" in message for message in messages))
        finally:
            node.pop("protagonist_interpretation", None)
            node.pop("inner_thought", None)

    def test_inner_voice_and_layer_speakers_are_rejected(self):
        scene = self.project.scenes["seo_a.email_request"]
        node = next(item for item in scene["nodes"] if item["id"] == "request")
        original = copy.deepcopy(node)
        try:
            node["presentation_flags"] = ["inner_voice"]
            node["speakers"] = {"perceived": "han_do_yoon", "reality": "yoon_seo_a"}
            issues = []
            self.project._validate_scenes(issues)
            messages = [issue.message for issue in issues]
            self.assertTrue(any("unknown presentation flag: inner_voice" in message for message in messages))
            self.assertTrue(any("removed dialogue field is forbidden: speakers" in message for message in messages))
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
            self.assertTrue(any("removed dialogue field is forbidden: speakers" in issue.message for issue in issues))
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

    def test_choice_analysis_hints_require_all_scoring_directions(self):
        scene = self.project.scenes["common.day_02_practical_meeting"]
        node = next(item for item in scene["nodes"] if item["id"] == "recovery_choice")
        original = copy.deepcopy(node["analysis_hints"])
        try:
            node["analysis_hints"] = {"pull": "계속 대화하십시오.", "push": ""}
            issues = []
            self.project._validate_scenes(issues)
            messages = [issue.message for issue in issues]
            self.assertTrue(any("must contain exactly pull, push, and none" in message for message in messages))

            node["analysis_hints"] = {"pull": "계속 대화하십시오.", "push": "물러나십시오.", "none": ""}
            issues = []
            self.project._validate_scenes(issues)
            self.assertTrue(any("values must be non-empty strings" in issue.message for issue in issues))
        finally:
            node["analysis_hints"] = original

    def test_choice_requires_an_exact_interaction_context_kind(self):
        scene = self.project.scenes["seo_a.email_request"]
        node = next(item for item in scene["nodes"] if item["id"] == "interpret")
        original = copy.deepcopy(node["interaction_context"])
        try:
            node.pop("interaction_context")
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("choice interaction_context must be a mapping" in message for message in messages))

            node["interaction_context"] = {"kind": "romance", "extra": True}
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("must contain exactly the key: kind" in message for message in messages))
            self.assertTrue(any("invalid interaction_context kind" in message for message in messages))
        finally:
            node["interaction_context"] = original

    def test_support_and_coordination_choices_require_interactions_and_distinct_orders(self):
        scene = self.project.scenes["common.day_03_business_trip_or_cafe"]
        node = next(item for item in scene["nodes"] if item["id"] == "response_choice")
        original = copy.deepcopy(node["options"])
        try:
            node["options"][0].pop("interaction")
            for option in node["options"][1:]:
                option["interaction"]["support_styles"] = ["practical_resolution"]
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("coordination choice options require interaction metadata" in message for message in messages))
            self.assertTrue(any("require at least two distinct ordered support style signatures" in message for message in messages))
        finally:
            node["options"] = original

    def test_boundary_and_not_applicable_interaction_contracts_are_enforced(self):
        boundary_scene = self.project.scenes["min_kyung.explicit_boundary"]
        boundary = next(item for item in boundary_scene["nodes"] if item["id"] == "respond")
        boundary_option = next(item for item in boundary["options"] if item["id"] == "accept_boundary")
        original_boundary_interaction = copy.deepcopy(boundary_option["interaction"])
        ending_scene = self.project.scenes["ending.min_kyung.coverup"]
        interpretation = next(item for item in ending_scene["nodes"] if item["id"] == "interpretation_choice")
        original_ending_options = copy.deepcopy(interpretation["options"])
        try:
            boundary_option.pop("interaction")
            interpretation["options"][0]["interaction"] = {
                "target": "cha_min_kyung",
                "support_styles": ["emotional_validation"],
            }
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("boundary choices require at least one literal_respect" in message for message in messages))
            self.assertTrue(any("not_applicable choice options must not declare interaction" in message for message in messages))
        finally:
            boundary_option["interaction"] = original_boundary_interaction
            interpretation["options"] = original_ending_options

    def test_different_interaction_orders_require_distinct_target_responses(self):
        scene = self.project.scenes["common.day_03_business_trip_or_cafe"]
        structure = next(item for item in scene["nodes"] if item["id"] == "structure_response")
        fatigue = next(item for item in scene["nodes"] if item["id"] == "fatigue_response")
        original_line = fatigue["line"]
        try:
            fatigue["line"] = structure["line"]
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("must lead to distinct responses" in message for message in messages))
        finally:
            fatigue["line"] = original_line

    def test_interaction_branch_must_reach_the_declared_target_response(self):
        scene = self.project.scenes["common.day_03_business_trip_or_cafe"]
        node = next(item for item in scene["nodes"] if item["id"] == "post_resolution_choice")
        option = next(item for item in node["options"] if item["id"] == "close_with_facts")
        original_next = option["next"]
        try:
            scene["nodes"].append({
                "id": "interaction_passthrough",
                "kind": "effect",
                "effects": [],
                "next": original_next,
            })
            option["next"] = "interaction_passthrough"
            messages = [issue.message for issue in self.project.validate()]
            self.assertFalse(any("must reach a response from target: cha_min_kyung" in message for message in messages))

            option["next"] = "weekend_clues"
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("must reach a response from target: cha_min_kyung" in message for message in messages))
        finally:
            option["next"] = original_next
            scene["nodes"] = [item for item in scene["nodes"] if item["id"] != "interaction_passthrough"]

    def test_new_scene_scaffold_uses_single_dialogue_contract(self):
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
            opening = next(node for node in document["nodes"] if node["id"] == "opening")
            self.assertEqual("narration", opening["kind"])
            self.assertIn("line", opening)
            self.assertNotIn("perceived", serialized)
            self.assertNotIn("reality", serialized)

    def test_removed_perceived_layer_is_rejected(self):
        scene = self.project.scenes["seo_a.email_request"]
        node = next(item for item in scene["nodes"] if item["id"] == "request")
        try:
            node["perceived"] = {"line": "다르게 들린 문장"}
            issues = self.project.validate()
            self.assertTrue(any("removed dialogue field is forbidden: perceived" in issue.message for issue in issues))
        finally:
            node.pop("perceived", None)

    def test_removed_atmosphere_is_rejected(self):
        scene = self.project.scenes["seo_a.email_request"]
        node = next(item for item in scene["nodes"] if item["id"] == "request")
        try:
            node["atmosphere"] = "cold_office"
            issues = self.project.validate()
            self.assertTrue(any("removed dialogue field is forbidden: atmosphere" in issue.message for issue in issues))
        finally:
            node.pop("atmosphere", None)

    def test_romance_insert_is_rejected(self):
        scene = self.project.scenes["seo_a.email_request"]
        node = next(item for item in scene["nodes"] if item["id"] == "request")
        original_flags = node.get("presentation_flags")
        try:
            node["presentation_flags"] = ["romance_insert"]
            issues = self.project.validate()
            self.assertTrue(any("unknown presentation flag: romance_insert" in issue.message for issue in issues))
        finally:
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

            path = "visible.heroines.cha_min_kyung.affection"
            scene["state_contract"]["writes"].remove(path)
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any(path in message and "state_contract.writes" in message for message in messages))
            scene["state_contract"]["writes"].append(path)

            option["effects"].append({
                "path": "visible.heroines.yoon_seo_a.affection",
                "op": "add",
                "value": 1,
            })
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any(
                "push_pull choice must not manually write affection" in message
                and "visible.heroines.yoon_seo_a.affection" in message
                for message in messages
            ))
            option["effects"].pop()
        finally:
            option["push_pull"]["target"] = original_target
            option["effects"] = [
                effect for effect in option["effects"]
                if effect.get("path") != "visible.heroines.yoon_seo_a.affection"
            ]
            if "cha_min_kyung" not in scene["cast"]:
                scene["cast"].append("cha_min_kyung")
            path = "visible.heroines.cha_min_kyung.affection"
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

    def test_unknown_expression_is_rejected(self):
        scene = self.project.scenes["seo_a.email_request"]
        node = next(item for item in scene["nodes"] if item["id"] == "request")
        original = node["expression"]
        try:
            node["expression"] = "not_a_registered_expression"
            issues = self.project.validate()
            self.assertTrue(any("unknown expression" in issue.message for issue in issues))
        finally:
            node["expression"] = original

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
        ).run(stop_before_scene="common.day_03_business_trip_or_cafe")
        self.assertEqual("common.day_03_business_trip_or_cafe", result["stopped_at"])
        final_state = result["final_state"]
        self.assertEqual(50, final_state["visible"]["heroines"]["yoon_seo_a"]["affection"])
        self.assertEqual(54, final_state["visible"]["heroines"]["cha_min_kyung"]["affection"])
        self.assertEqual("cha_min_kyung", push_pull_state(final_state)["heroine"])
        self.assertEqual("none", final_state["progress"]["flags"]["story_mode"]["target"])
        self.assertEqual("factual_resolution", final_state["progress"]["flags"]["story_mode"]["day_02_response"])

    def test_day_three_min_kyung_mbti_choices_have_distinct_reactions_without_direct_effects(self):
        scene = self.project.scenes["common.day_03_business_trip_or_cafe"]
        choice = next(node for node in scene["nodes"] if node["id"] == "response_choice")
        options = {option["id"]: option for option in choice["options"]}

        self.assertEqual({"kind": "coordination"}, choice["interaction_context"])
        self.assertEqual(
            {
                "structure_issues": ["factual_clarification", "practical_resolution", "autonomy_return"],
                "acknowledge_fatigue": ["emotional_validation"],
                "take_all_issues": ["practical_resolution"],
            },
            {
                option_id: option["interaction"]["support_styles"]
                for option_id, option in options.items()
            },
        )
        for option in options.values():
            self.assertEqual("cha_min_kyung", option["interaction"]["target"])
            self.assertEqual("cha_min_kyung", option["push_pull"]["target"])
            self.assertEqual([], option["effects"])

        response_lines = {
            next(node for node in scene["nodes"] if node["id"] == option["next"])["line"]
            for option in options.values()
        }
        self.assertEqual(3, len(response_lines))

        follow_up = next(node for node in scene["nodes"] if node["id"] == "post_resolution_choice")
        follow_up_options = {option["id"]: option for option in follow_up["options"]}
        self.assertEqual({"kind": "support"}, follow_up["interaction_context"])
        self.assertEqual(
            {
                "acknowledge_after_resolution": ["emotional_validation", "ask_before_helping", "autonomy_return"],
                "close_with_facts": ["factual_clarification"],
                "add_more_work": ["practical_resolution", "concise_reassurance"],
            },
            {
                option_id: option["interaction"]["support_styles"]
                for option_id, option in follow_up_options.items()
            },
        )
        for option in follow_up_options.values():
            self.assertEqual("cha_min_kyung", option["interaction"]["target"])
            self.assertEqual("cha_min_kyung", option["push_pull"]["target"])
            self.assertEqual([], option["effects"])

        follow_up_response_lines = {
            next(node for node in scene["nodes"] if node["id"] == option["next"])["line"]
            for option in follow_up_options.values()
        }
        self.assertEqual(3, len(follow_up_response_lines))
        resolution = next(node for node in scene["nodes"] if node["id"] == "resolution_complete")
        self.assertIn("모두 정리됐다", resolution["line"])
        self.assertIn("숨을 내쉬었다", resolution["line"])

    def test_day_three_common_choice_switches_push_pull_target_to_min_kyung(self):
        result = Simulator(
            self.project,
            "seo_a",
            {
                "common.day_02_practical_meeting": "acknowledge_and_ask",
                "common.day_03_business_trip_or_cafe:response_choice": "structure_issues",
                "common.day_03_business_trip_or_cafe:post_resolution_choice": "acknowledge_after_resolution",
            },
            "first",
        ).run(stop_before_scene="common.day_04_weekend_encounter")
        self.assertEqual("common.day_04_weekend_encounter", result["stopped_at"])

        final_state = result["final_state"]
        self.assertEqual(54, final_state["visible"]["heroines"]["yoon_seo_a"]["affection"])
        self.assertEqual(68, final_state["visible"]["heroines"]["cha_min_kyung"]["affection"])
        self.assertEqual("cha_min_kyung", push_pull_state(final_state)["heroine"])
        day_three_choices = [
            item for item in result["trace"]
            if item.get("type") == "choice" and item.get("scene") == "common.day_03_business_trip_or_cafe"
        ]
        self.assertEqual(
            [("response_choice", "structure_issues"), ("post_resolution_choice", "acknowledge_after_resolution")],
            [(item["node"], item["option"]) for item in day_three_choices],
        )
        self.assertEqual(
            self.project.campaign_initial_state(
                self.project.routes["seo_a"]["campaign_id"]
            )["hidden"]["heroines"]["cha_min_kyung"],
            final_state["hidden"]["heroines"]["cha_min_kyung"],
        )

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

    def test_first_final_selectable_route_clear_unlocks_survival_mode(self):
        result = Simulator(
            self.project,
            "seo_a",
            {
                "seo_a.email_request": "take_literally",
                "seo_a.relief_smile": "stop_game",
            },
            "first",
        ).run()
        progress = result["final_state"]["progress"]
        self.assertEqual(["seo_a"], progress["cleared_routes"])
        self.assertIn("survivor_view", progress["unlocked_modes"])
        self.assertNotIn("collapse", progress["unlocked_modes"])

    def test_min_kyung_route_clears_and_unlocks_survival_mode(self):
        result = Simulator(
            self.project,
            "min_kyung",
            {
                "min_kyung.explicit_boundary": "accept_boundary",
                "min_kyung.witness_meeting": "work_only",
            },
            "first",
        ).run()
        progress = result["final_state"]["progress"]
        self.assertEqual(["min_kyung"], progress["cleared_routes"])
        self.assertIn("survivor_view", progress["unlocked_modes"])

    def test_game_mode_registry_keeps_the_approved_post_clear_unlock(self):
        survivor_unlock = self.project.game_modes["survivor_view"]["unlock"]["any"]
        removed = survivor_unlock.pop()
        try:
            issues = []
            self.project._validate_game_modes(issues)
            self.assertTrue(any("must unlock after either approved main route clear" in issue.message for issue in issues))
        finally:
            survivor_unlock.append(removed)

    def test_yoo_jin_is_declared_as_a_decoy_without_an_implemented_route(self):
        self.assertNotIn("yoo_jin", self.project.routes)
        story_mode = self.project.meta["story_mode"]
        self.assertIn("kang_yoo_jin", story_mode["romance_candidates"])
        self.assertNotIn("kang_yoo_jin", story_mode["final_selectable_heroines"])
        self.assertEqual("kang_yoo_jin", story_mode["decoy_heroine"])
        self.assertEqual({"kang_yoo_jin": 80}, story_mode["affection_caps"])
        self.assertTrue(all(route.get("campaign_id") == "main" for route in self.project.routes.values()))
        self.assertTrue(all("mode" not in route for route in self.project.routes.values()))

    def test_story_mode_requires_one_submaximal_affection_cap_for_the_decoy(self):
        story_mode = self.project.meta["story_mode"]
        original = copy.deepcopy(story_mode["affection_caps"])
        try:
            story_mode["affection_caps"] = {"cha_min_kyung": 80}
            issues = []
            self.project._validate_meta(issues)
            self.assertTrue(any("exactly the decoy heroine" in issue.message for issue in issues))

            story_mode["affection_caps"] = {"kang_yoo_jin": 100}
            issues = []
            self.project._validate_meta(issues)
            self.assertTrue(any("integer from 0 to 99" in issue.message for issue in issues))
        finally:
            story_mode["affection_caps"] = original

    def test_story_mode_rejects_a_decoy_as_final_selectable(self):
        story_mode = self.project.meta["story_mode"]
        original = list(story_mode["final_selectable_heroines"])
        story_mode["final_selectable_heroines"].append("kang_yoo_jin")
        try:
            issues = []
            self.project._validate_meta(issues)
            messages = [issue.message for issue in issues]
            self.assertTrue(any("decoy_heroine must be excluded" in message for message in messages))
        finally:
            story_mode["final_selectable_heroines"] = original

    def test_route_final_selectable_must_match_story_mode_contract(self):
        route = self.project.routes["min_kyung"]
        original = route["final_selectable"]
        route["final_selectable"] = False
        try:
            issues = []
            self.project._validate_meta(issues)
            self.assertTrue(any("final_selectable must match" in issue.message for issue in issues))
        finally:
            route["final_selectable"] = original

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
                "path": "hidden.heroines.yoon_seo_a.suspicion",
                "op": "add",
                "value": 500,
            },
        )
        self.assertEqual(100, state["hidden"]["heroines"]["yoon_seo_a"]["suspicion"])

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
        self.assertEqual(80, state["visible"]["heroines"]["yoon_seo_a"]["affection"])

        reverse = resolve_push_pull(
            self.project,
            state,
            "yoon_seo_a",
            {"action": "space", "intensity": 12, "base_score": 4},
        )
        self.assertEqual(-24, reverse["position"])
        self.assertEqual(4, reverse["combo"])
        self.assertEqual(16, reverse["gain"])

    def test_yoo_jin_affection_stops_at_eighty_while_hidden_consequences_continue(self):
        state = self.project.initial_state()
        state["visible"]["heroines"]["kang_yoo_jin"]["affection"] = 78
        config = {"action": "approach", "intensity": 12, "base_score": 5}

        capped = resolve_push_pull(self.project, state, "kang_yoo_jin", config)
        self.assertEqual(80, capped["affection"])
        self.assertEqual(5, capped["attempted_gain"])
        self.assertEqual(2, capped["gain"])
        self.assertEqual(80, capped["affection_cap"])
        self.assertTrue(capped["capped"])

        state["progress"]["flags"]["push_pull"].update({
            "combo": 4,
            "position": -24,
            "target": "pull",
            "last_action": "approach",
            "heroine": "kang_yoo_jin",
        })
        still_capped = resolve_push_pull(self.project, state, "kang_yoo_jin", config)
        self.assertEqual(80, still_capped["affection"])
        self.assertEqual(0, still_capped["gain"])
        self.assertEqual(
            {"suspicion": 7, "dislike": 4, "evidence_count": 1},
            still_capped["hidden_delta"],
        )

    def test_push_pull_ignores_self_development_score_modifiers(self):
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
        self.assertEqual(0, scored["bonus_gain"])
        self.assertEqual(4, scored["gain"])
        self.assertEqual(54, state["visible"]["heroines"]["yoon_seo_a"]["affection"])
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
        self.assertIn("health.workout_answer", bundle["self_development"]["expressions"])

        preferences = bundle["characters"]["cha_min_kyung"]["interaction_preferences"]
        self.assertEqual("factual_clarification", preferences["support_order"][0])
        shared_choice = bundle["scenes"]["common.day_02_practical_meeting"]["nodes"]["recovery_choice"]
        self.assertEqual({"kind": "support"}, shared_choice["interaction_context"])
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
        self.assertEqual(35, len(bundle["events"]))
        self.assertEqual(
            "anchor.day_01_dream_and_mother_call",
            bundle["campaigns"]["main"]["entry_event_id"],
        )
        dream_and_mother_call = bundle["events"]["anchor.day_01_dream_and_mother_call"]
        self.assertEqual([1, 1], dream_and_mother_call["window"]["days"])
        self.assertEqual(["morning"], dream_and_mother_call["window"]["slots"])
        self.assertEqual(0, dream_and_mother_call["duration"])
        first_encounter = bundle["events"]["anchor.day_01_officetel_first_encounter"]
        self.assertEqual([1, 1], first_encounter["window"]["days"])
        self.assertEqual(["morning"], first_encounter["window"]["slots"])
        self.assertEqual(0, first_encounter["duration"])
        self.assertEqual(
            ["anchor.day_01_dream_and_mother_call"],
            first_encounter["requires"]["events"],
        )
        self.assertEqual(
            ["han_do_yoon", "yoon_seo_a"],
            bundle["scenes"]["common.day_01_officetel_first_encounter"]["cast"],
        )
        self.assertEqual(
            ["anchor.day_01_officetel_first_encounter"],
            bundle["events"]["anchor.day_01_company_meeting"]["requires"]["events"],
        )
        parent_pressure = bundle["events"]["anchor.day_01_parent_pressure"]
        self.assertEqual([1, 1], parent_pressure["window"]["days"])
        self.assertEqual(["afternoon"], parent_pressure["window"]["slots"])
        self.assertEqual(
            ["anchor.day_01_company_meeting"],
            parent_pressure["requires"]["events"],
        )
        seo_a_neighbor = bundle["events"]["anchor.day_01_officetel_seo_a_reveal"]
        self.assertEqual([1, 1], seo_a_neighbor["window"]["days"])
        self.assertEqual(["after_work"], seo_a_neighbor["window"]["slots"])
        self.assertEqual(
            ["anchor.day_01_parent_pressure"],
            seo_a_neighbor["requires"]["events"],
        )
        self.assertEqual(0, seo_a_neighbor["duration"])
        self.assertEqual(
            ["han_do_yoon", "yoon_seo_a"],
            bundle["scenes"]["common.day_01_officetel_seo_a_reveal"]["cast"],
        )
        min_kyung_move_in = bundle["events"]["anchor.day_03_officetel_min_kyung_move_in"]
        self.assertEqual([3, 3], min_kyung_move_in["window"]["days"])
        self.assertEqual(["after_work"], min_kyung_move_in["window"]["slots"])
        self.assertEqual(
            ["anchor.day_03_business_trip_or_cafe"],
            min_kyung_move_in["requires"]["events"],
        )
        self.assertEqual(
            ["han_do_yoon", "cha_min_kyung"],
            bundle["scenes"]["common.day_03_officetel_min_kyung_move_in"]["cast"],
        )
        self.assertEqual(
            ["anchor.day_01_dark_psychology_lesson"],
            bundle["events"]["anchor.day_02_practical_meeting"]["requires"]["events"],
        )
        self.assertEqual(
            ["anchor.day_02_dark_psychology_lesson"],
            bundle["events"]["anchor.day_03_business_trip_or_cafe"]["requires"]["events"],
        )
        self.assertEqual(
            ["anchor.day_03_officetel_min_kyung_move_in"],
            bundle["events"]["anchor.day_04_weekend_encounter"]["requires"]["events"],
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
        self.assertEqual({"base", "survivor_view"}, set(bundle["game_modes"]))
        self.assertEqual("main", bundle["game_modes"]["base"]["campaign_id"])
        self.assertEqual("coming_soon", bundle["game_modes"]["survivor_view"]["content_status"])
        self.assertIsNone(bundle["game_modes"]["survivor_view"]["campaign_id"])
        self.assertIn("unlocks", bundle["meta"])
        reveals = bundle["meta"]["unlocks"]["mode_teasers"][0]["reveals"]
        self.assertEqual(["survivor_view"], [reveal["mode"] for reveal in reveals])
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
                "하루담 봄 홈카페 캠페인",
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
        email = resolve_scene_background(visuals, self.project.scenes["seo_a.email_request"], "request")
        report = resolve_scene_background(visuals, self.project.scenes["ending.seo_a.report"], "mugshot")
        empty = resolve_scene_background(visuals, self.project.scenes["ending.seo_a.ambiguous"], "released")
        self.assertEqual("background.office_open", email["visual_id"])
        self.assertEqual("background.office_corridor", report["visual_id"])
        self.assertEqual("background.office_corridor", empty["visual_id"])

    def test_officetel_scenes_use_their_two_dedicated_backgrounds(self):
        visuals = self.project.resolve_visuals()
        first_encounter_scene = self.project.scenes["common.day_01_officetel_first_encounter"]
        seo_a_scene = self.project.scenes["common.day_01_officetel_seo_a_reveal"]
        min_kyung_scene = self.project.scenes["common.day_03_officetel_min_kyung_move_in"]
        first_encounter_background = resolve_scene_background(
            visuals, first_encounter_scene, "morning_elevator"
        )
        seo_a_background = resolve_scene_background(visuals, seo_a_scene, "home_arrival")
        min_kyung_background = resolve_scene_background(visuals, min_kyung_scene, "knock_at_door")
        self.assertEqual("background.officetel_elevator_lobby", first_encounter_background["visual_id"])
        self.assertEqual("morning", first_encounter_background["variant_id"])
        self.assertEqual("background.officetel_elevator_lobby", seo_a_background["visual_id"])
        self.assertEqual("evening", seo_a_background["variant_id"])
        self.assertEqual("background.officetel_unit_corridor", min_kyung_background["visual_id"])
        self.assertEqual("move_in_evening", min_kyung_background["variant_id"])
        self.assertNotEqual(seo_a_background["asset"], min_kyung_background["asset"])

    def test_scene_default_background_overrides_automatic_matching(self):
        scene = copy.deepcopy(self.project.scenes["seo_a.email_request"])
        scene["default_background"] = {
            "visual_id": "background.empty_office",
            "variant_id": "night",
        }
        background = resolve_scene_background(
            self.project.resolve_visuals(), scene, "request"
        )
        self.assertEqual("background.empty_office", background["visual_id"])
        self.assertEqual("night", background["variant_id"])
        self.assertEqual(["scene-default"], background["matched"])

    def test_scene_default_background_rejects_unknown_variant(self):
        scene = self.project.scenes["seo_a.email_request"]
        original = copy.deepcopy(scene.get("default_background"))
        scene["default_background"] = {
            "visual_id": "background.empty_office",
            "variant_id": "missing",
        }
        try:
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("unknown background variant" in message for message in messages))
        finally:
            if original is None:
                scene.pop("default_background", None)
            else:
                scene["default_background"] = original

    def test_silent_node_is_zero_character_presentable_flow(self):
        scene = self.project.scenes["seo_a.email_request"]
        original_start = scene["start_node"]
        silent = {
            "id": "silent_view_test",
            "kind": "silent",
            "line": "",
            "stage": [],
            "next": original_start,
        }
        scene["nodes"].insert(0, silent)
        scene["start_node"] = silent["id"]
        try:
            self.assertEqual([], self.project.validate())
            stage = resolve_scene_stage(
                self.project.resolve_visuals(), scene, silent["id"]
            )
            self.assertEqual([], stage["characters"])
            self.assertIsNotNone(stage["background"])
        finally:
            scene["start_node"] = original_start
            scene["nodes"] = [node for node in scene["nodes"] if node["id"] != silent["id"]]

    def test_silent_node_rejects_nonempty_dialogue(self):
        scene = self.project.scenes["seo_a.email_request"]
        original_start = scene["start_node"]
        silent = {
            "id": "silent_view_invalid",
            "kind": "silent",
            "line": "not silent",
            "next": original_start,
        }
        scene["nodes"].insert(0, silent)
        scene["start_node"] = silent["id"]
        try:
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("silent line must be an explicit empty string" in message for message in messages))
        finally:
            scene["start_node"] = original_start
            scene["nodes"] = [node for node in scene["nodes"] if node["id"] != silent["id"]]

    def test_scene_stage_composes_background_and_character_objects(self):
        scene = self.project.scenes["seo_a.email_request"]
        stage = resolve_scene_stage(self.project.resolve_visuals(), scene, "request")
        self.assertEqual("background.office_open", stage["background"]["visual_id"])
        self.assertEqual(
            [("yoon_seo_a", "center", True)],
            [(item["character"], item["position"], item["speaker"]) for item in stage["characters"]],
        )
        seo_a = stage["characters"][0]
        self.assertIsNone(seo_a["expression"])
        self.assertTrue(seo_a["speaker"])


    def test_han_do_yoon_artwork_requires_an_explicit_ending_reveal(self):
        scene = self.project.scenes["seo_a.email_request"]
        node = scene["nodes"][0]
        original_stage = copy.deepcopy(node.get("stage"))
        node["stage"] = [{
                "position": "center",
                "character": "han_do_yoon",
                "visual_id": "character.han_do_yoon",
                "artwork": "default",
            }]
        try:
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("reserved for an explicit ending reveal" in message for message in messages))
            stage = resolve_scene_stage(self.project.resolve_visuals(), scene, node["id"])
            self.assertFalse(any(item["character"] == "han_do_yoon" for item in stage["characters"]))
        finally:
            if original_stage is None:
                node.pop("stage", None)
            else:
                node["stage"] = original_stage

    def test_han_do_yoon_artwork_appears_on_the_declared_mugshot_reveal(self):
        scene = self.project.scenes["ending.seo_a.report"]
        stage = resolve_scene_stage(self.project.resolve_visuals(), scene, "mugshot")
        self.assertEqual(
            [("han_do_yoon", "center")],
            [(item["character"], item["position"]) for item in stage["characters"]],
        )

    def test_han_do_yoon_artwork_never_leaks_outside_declared_reveal_nodes(self):
        visuals = self.project.resolve_visuals()
        reveal_count = 0
        for scene in self.project.scenes.values():
            for node in scene["nodes"]:
                is_reveal = (
                    scene["id"].startswith("ending.")
                    and node.get("kind") == "narration"
                    and "protagonist_art_reveal" in node.get("presentation_flags", [])
                )
                stage = resolve_scene_stage(visuals, scene, node["id"])
                has_protagonist_art = any(
                    item["character"] == "han_do_yoon"
                    for item in stage["characters"]
                )
                self.assertEqual(is_reveal, has_protagonist_art, f"{scene['id']}#{node['id']}")
                if is_reveal:
                    reveal_count += 1
        self.assertGreater(reveal_count, 0)

    def test_manual_stage_supports_off_and_three_non_speaker_artworks(self):
        scene = self.project.scenes["common.day_01_company_meeting"]
        node = scene["nodes"][0]
        original = copy.deepcopy(node.get("stage"))
        node["stage"] = [
                {"position": "left", "character": "yoon_seo_a", "visual_id": "character.yoon_seo_a", "artwork": "default"},
                {"position": "center", "character": "cha_min_kyung", "visual_id": "character.cha_min_kyung", "artwork": "default"},
                {"position": "right", "character": "kang_yoo_jin", "visual_id": "character.kang_yoo_jin", "artwork": "default"},
            ]
        try:
            self.assertEqual([], self.project.validate())
            stage = resolve_scene_stage(self.project.resolve_visuals(), scene, node["id"])
            self.assertEqual(
                [("left", "yoon_seo_a"), ("center", "cha_min_kyung"), ("right", "kang_yoo_jin")],
                [(item["position"], item["character"]) for item in stage["characters"]],
            )
        finally:
            if original is None:
                node.pop("stage", None)
            else:
                node["stage"] = original

    def test_manual_stage_rejects_duplicate_positions_and_out_of_cast_characters(self):
        scene = self.project.scenes["seo_a.email_request"]
        node = scene["nodes"][0]
        original = copy.deepcopy(node.get("stage"))
        node["stage"] = [
            {"position": "left", "character": "yoon_seo_a", "visual_id": "character.yoon_seo_a", "artwork": "default"},
            {"position": "left", "character": "cha_min_kyung", "visual_id": "character.cha_min_kyung", "artwork": "default"},
        ]
        try:
            messages = [issue.message for issue in self.project.validate()]
            self.assertTrue(any("duplicate stage position" in message for message in messages))
            self.assertTrue(any("stage character is not in scene cast" in message for message in messages))
        finally:
            if original is None:
                node.pop("stage", None)
            else:
                node["stage"] = original

    def test_character_visual_accepts_multiple_registered_artworks(self):
        source = self.project.visuals["character.yoon_seo_a"]
        original_default = source.get("default_artwork")
        original_artworks = copy.deepcopy(source.get("artworks"))
        scene = self.project.scenes["seo_a.email_request"]
        node = scene["nodes"][0]
        original_stage = copy.deepcopy(node.get("stage"))
        source["default_artwork"] = "office_default"
        source["artworks"] = {
            "office_default": {"asset": source["fallback_asset"], "label": "오피스 기본"},
            "cardigan_smile": {"asset": source["fallback_asset"], "label": "가디건 미소"},
        }
        node["stage"] = [{
            "position": "center",
            "character": "yoon_seo_a",
            "visual_id": "character.yoon_seo_a",
            "artwork": "cardigan_smile",
        }]
        try:
            self.assertEqual([], self.project.validate())
            stage = resolve_scene_stage(self.project.resolve_visuals(), scene, node["id"])
            self.assertEqual("cardigan_smile", stage["characters"][0]["artwork"])
            self.assertEqual(source["fallback_asset"], stage["characters"][0]["asset"])
        finally:
            if original_default is None:
                source.pop("default_artwork", None)
            else:
                source["default_artwork"] = original_default
            if original_artworks is None:
                source.pop("artworks", None)
            else:
                source["artworks"] = original_artworks
            if original_stage is None:
                node.pop("stage", None)
            else:
                node["stage"] = original_stage

    def test_timeline_scheduler_does_not_expose_retired_collapse_events(self):
        scheduler = TimelineScheduler(self.project, "main")
        self.assertNotIn("yoo_jin.fact_check", scheduler.project.events)
        self.assertFalse(any(event.get("thread") == "yoo_jin" for event in scheduler.project.events.values()))

    def test_missed_event_triggers_hidden_offscreen_progression(self):
        scheduler = TimelineScheduler(self.project, "main")
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
        scheduler = TimelineScheduler(self.project, "main", state)
        applied = scheduler.process_automatic(17, "after_work")
        event_ids = [item["event"] for item in applied]
        self.assertIn("seo_a.ending_report", event_ids)
        self.assertNotIn("seo_a.ending_ambiguous", event_ids)

    def test_ai_context_is_bounded_and_contains_single_dialogue_fields(self):
        context = self.project.context_package("seo_a.email_request")
        self.assertEqual("seo_a.email_request", context["scene"]["id"])
        self.assertEqual({"han_do_yoon", "yoon_seo_a"}, set(context["cast"]))
        self.assertNotIn("cha_min_kyung", context["cast"])
        first_node = context["scene"]["nodes"][0]
        self.assertIn("line", first_node)
        self.assertNotIn("perceived", first_node)
        self.assertNotIn("reality", first_node)
        self.assertIn("authoring_rules", context)
        self.assertIn("literal_respect", context["allowed_system"]["support_styles"])
        self.assertEqual(
            ["boundary", "coordination", "not_applicable", "support"],
            context["allowed_system"]["interaction_context_kinds"],
        )
        self.assertEqual(
            ["emotional_validation", "ask_before_helping", "autonomy_return", "practical_resolution"],
            context["cast"]["yoon_seo_a"]["interaction_preferences"]["support_order"],
        )
        self.assertEqual("yoon_seo_a", context["effective_speakers"]["request"])

        shared_context = self.project.context_package("common.day_02_practical_meeting")
        recovery = next(node for node in shared_context["scene"]["nodes"] if node["id"] == "recovery_choice")
        self.assertEqual({"kind": "support"}, recovery["interaction_context"])
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
        self.assertFalse(any(event.get("node") == "request_inner" for event in result["trace"]))
        context = self.project.context_package("seo_a.relief_smile", result["final_state"])
        self.assertEqual(20, context["state_snapshot"]["hidden.heroines.yoon_seo_a.suspicion"])
        self.assertEqual("anxiety", context["derived_emotions"]["yoon_seo_a"]["emotion"])


if __name__ == "__main__":
    unittest.main()
