import copy
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from story_editor_bridge import (  # noqa: E402
    YAML_RT,
    apply_mobile_sync_changes,
    derive_state_contract,
    duplicate_event,
    duplicate_scene,
    json_value_hash,
    load_project,
    mobile_sync_snapshot,
    revision,
    save_document,
    save_scene,
    save_story_text,
    story_text_owner,
    validate_scene,
    value_hash,
    yaml_text_for_scene,
)
from story_harness import StoryProject  # noqa: E402


class StoryEditorBridgeTests(unittest.TestCase):
    def make_project_copy(self) -> tuple[tempfile.TemporaryDirectory, Path]:
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        shutil.copytree(ROOT / "story", root / "story")
        (root / "build").mkdir()
        return temporary, root

    def test_load_project_includes_runtime_documents_and_revisions(self):
        result = load_project(ROOT)
        self.assertEqual(20, len(result["runtime"]["scenes"]))
        self.assertEqual(20, len(result["documents"]["scenes"]))
        self.assertEqual([], result["issues"])
        self.assertEqual(64, len(result["documents"]["scenes"]["seo_a.email_request"]["revision"]))
        self.assertEqual(30, len(result["documents"]["events"]))
        self.assertEqual({"system.night_activity", "system.analysis_hint"}, set(result["documents"]["system_flows"]))
        self.assertIn("common.day_01_company_meeting", result["documents"]["scenes"])
        self.assertIn("common.day_01_parent_pressure", result["documents"]["scenes"])
        self.assertIn("common.day_01_officetel_seo_a_reveal", result["documents"]["scenes"])
        self.assertIn("common.day_02_practical_meeting", result["documents"]["scenes"])
        self.assertIn("common.day_03_business_trip_or_cafe", result["documents"]["scenes"])
        self.assertIn("common.day_03_officetel_min_kyung_move_in", result["documents"]["scenes"])
        self.assertIn("common.day_04_weekend_encounter", result["documents"]["scenes"])
        self.assertIn("common.day_05_weekend_reflection", result["documents"]["scenes"])
        self.assertIn("anchor.day_01_parent_pressure", result["documents"]["events"])
        self.assertIn("anchor.day_01_officetel_seo_a_reveal", result["documents"]["events"])
        self.assertIn("anchor.day_03_officetel_min_kyung_move_in", result["documents"]["events"])
        self.assertIn("main", result["documents"]["campaigns"])
        self.assertEqual({"ko", "en"}, set(result["documents"]["locales"]))
        self.assertIn("background.office_open", result["documents"]["visuals"])

    def test_load_project_rejects_runtime_output_outside_build_directory(self):
        temporary, root = self.make_project_copy()
        try:
            manifest = root / "story" / "manifest.yaml"
            escaped = root.parent / f"{root.name}-escaped.json"
            manifest.write_text(
                manifest.read_text(encoding="utf-8").replace(
                    "runtime_output: build/story-runtime.json",
                    f"runtime_output: ../{escaped.name}",
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(RuntimeError, "build.runtime_output"):
                load_project(root)
            self.assertFalse(escaped.exists())
        finally:
            temporary.cleanup()

    def test_state_contract_is_derived_from_conditions_and_effects(self):
        scene = {
            "entry_conditions": [{"path": "progress.unlocked_modes", "op": "contains", "value": "base"}],
            "nodes": [
                {
                    "kind": "choice",
                    "options": [
                        {
                            "conditions": [{"path": "hidden.heroines.yoon_seo_a.suspicion", "op": "gte", "value": 10}],
                            "effects": [
                                {
                                    "path": "hidden.heroines.yoon_seo_a.dislike",
                                    "op": "add",
                                    "value": 5,
                                    "conditions": [
                                        {
                                            "path": "visible.heroines.yoon_seo_a.affection",
                                            "op": "gte",
                                            "value": 20,
                                        }
                                    ],
                                }
                            ],
                        }
                    ],
                }
            ],
        }
        derive_state_contract(scene)
        self.assertEqual(
            [
                "progress.unlocked_modes",
                "hidden.heroines.yoon_seo_a.suspicion",
                "visible.heroines.yoon_seo_a.affection",
            ],
            scene["state_contract"]["reads"],
        )
        self.assertEqual(["hidden.heroines.yoon_seo_a.dislike"], scene["state_contract"]["writes"])

    def test_state_contract_includes_push_pull_runtime_paths(self):
        scene = {
            "state_contract": {
                "reads": [],
                "writes": ["visible.heroines.yoon_seo_a.initiative"],
            },
            "entry_conditions": [],
            "nodes": [{
                "kind": "choice",
                "options": [{
                    "push_pull": {"action": "approach", "intensity": 12, "base_score": 4},
                    "conditions": [],
                    "effects": [{
                        "path": "hidden.heroines.yoon_seo_a.suspicion",
                        "op": "add",
                        "value": 5,
                    }],
                }],
            }],
        }
        derive_state_contract(scene)
        self.assertEqual(["progress.flags.push_pull"], scene["state_contract"]["reads"])
        self.assertEqual(
            [
                "hidden.heroines.yoon_seo_a.suspicion",
                "progress.flags.push_pull",
                "visible.heroines.yoon_seo_a.initiative",
                "hidden.heroines.yoon_seo_a.dislike",
                "hidden.heroines.yoon_seo_a.evidence_count",
            ],
            scene["state_contract"]["writes"],
        )

    def test_state_contract_includes_every_explicit_push_pull_target(self):
        scene = {
            "state_contract": {
                "reads": [],
                "writes": ["visible.heroines.yoon_seo_a.initiative"],
            },
            "entry_conditions": [],
            "nodes": [{
                "kind": "choice",
                "options": [
                    {
                        "push_pull": {"action": "approach", "intensity": 12, "base_score": 4},
                        "conditions": [],
                        "effects": [],
                    },
                    {
                        "push_pull": {
                            "target": "cha_min_kyung",
                            "action": "approach",
                            "intensity": 12,
                            "base_score": 4,
                        },
                        "conditions": [],
                        "effects": [],
                    },
                ],
            }],
        }
        derive_state_contract(scene)
        writes = scene["state_contract"]["writes"]
        for heroine in ("yoon_seo_a", "cha_min_kyung"):
            self.assertIn(f"visible.heroines.{heroine}.initiative", writes)
            self.assertIn(f"hidden.heroines.{heroine}.suspicion", writes)
            self.assertIn(f"hidden.heroines.{heroine}.dislike", writes)
            self.assertIn(f"hidden.heroines.{heroine}.evidence_count", writes)

    def test_state_contract_includes_expression_registry_requirements(self):
        scene = {
            "entry_conditions": [],
            "nodes": [{
                "kind": "dual_dialogue",
                "variants": [{
                    "self_development": {"expression": "health.answer"},
                }],
            }],
        }
        derive_state_contract(scene, {
            "health.answer": {
                "requires": {
                    "appeal_gte": 32,
                    "stat": "health",
                    "minimum": 2,
                    "fatigue_lte": 4,
                },
            },
        })
        self.assertEqual(
            [
                "visible.protagonist.self_development.appeal",
                "visible.protagonist.self_development.stats.health",
                "visible.protagonist.self_development.fatigue",
            ],
            scene["state_contract"]["reads"],
        )

    def test_state_contract_includes_last_activity_expression_requirement(self):
        scene = {
            "entry_conditions": [],
            "nodes": [{
                "kind": "dual_dialogue",
                "variants": [{
                    "self_development": {"expression": "feedback.last_workout"},
                }],
            }],
        }

        derive_state_contract(scene, {
            "feedback.last_workout": {
                "requires": {"last_activity": "workout"},
            },
        })

        self.assertEqual(
            ["progress.self_development.last_activity"],
            scene["state_contract"]["reads"],
        )

    def test_validate_scene_does_not_modify_source(self):
        temporary, root = self.make_project_copy()
        try:
            project = StoryProject(root / "story")
            scene = project.build_bundle()["scenes"]["seo_a.email_request"]
            path = Path(project.scenes[scene["id"]]["_source"])
            before = path.read_bytes()
            scene["title"] = "검증 전용 제목"
            result = validate_scene(root, {"scene": scene})
            self.assertEqual([], [item for item in result["issues"] if item["severity"] == "error"])
            self.assertEqual(before, path.read_bytes())
        finally:
            temporary.cleanup()

    def test_save_scene_preserves_comments_and_builds_runtime(self):
        temporary, root = self.make_project_copy()
        try:
            project = StoryProject(root / "story")
            scene = copy.deepcopy(project.build_bundle()["scenes"]["seo_a.email_request"])
            path = Path(project.scenes[scene["id"]]["_source"])
            path.write_text("# editor-sentinel\n" + path.read_text(encoding="utf-8"), encoding="utf-8")
            expected = revision(path)
            scene["title"] = "GUI에서 바꾼 제목"

            result = save_scene(root, {"scene": scene, "revision": expected})

            self.assertTrue(result["saved"])
            text = path.read_text(encoding="utf-8")
            self.assertIn("# editor-sentinel", text)
            self.assertIn("GUI에서 바꾼 제목", text)
            self.assertTrue((root / "build" / "story-runtime.json").is_file())
            self.assertEqual([], StoryProject(root / "story").validate())
        finally:
            temporary.cleanup()

    def test_save_scene_round_trips_manual_artwork_stage_to_physical_yaml(self):
        temporary, root = self.make_project_copy()
        try:
            project = StoryProject(root / "story")
            scene = copy.deepcopy(project.build_bundle()["scenes"]["seo_a.email_request"])
            path = Path(project.scenes[scene["id"]]["_source"])
            scene["nodes"]["request"]["stage"] = {
                "perceived": [{
                    "position": "right",
                    "character": "yoon_seo_a",
                    "visual_id": "character.yoon_seo_a",
                    "artwork": "default",
                }],
                "reality": [],
            }

            result = save_scene(root, {"scene": scene, "revision": revision(path)})

            self.assertTrue(result["saved"])
            source = YAML_RT.load(path.read_text(encoding="utf-8"))
            source_node = next(item for item in source["nodes"] if item["id"] == "request")
            self.assertEqual("right", source_node["stage"]["perceived"][0]["position"])
            self.assertEqual("character.yoon_seo_a", source_node["stage"]["perceived"][0]["visual_id"])
            self.assertEqual([], list(source_node["stage"]["reality"]))
            runtime_node = result["runtime"]["scenes"][scene["id"]]["nodes"]["request"]
            self.assertEqual("default", runtime_node["stage"]["perceived"][0]["artwork"])
            self.assertEqual([], runtime_node["stage"]["reality"])
        finally:
            temporary.cleanup()

    def test_save_scene_round_trips_new_dialogue_line_lock_without_changing_legacy_nodes(self):
        temporary, root = self.make_project_copy()
        try:
            project = StoryProject(root / "story")
            scene = copy.deepcopy(project.build_bundle()["scenes"]["seo_a.email_request"])
            path = Path(project.scenes[scene["id"]]["_source"])
            self.assertNotIn("line_layers_locked", scene["nodes"]["request"])
            scene["nodes"]["request"]["line_layers_locked"] = True
            scene["nodes"]["request"]["reality"]["line"] = scene["nodes"]["request"]["perceived"]["line"]

            result = save_scene(root, {"scene": scene, "revision": revision(path)})

            self.assertTrue(result["saved"])
            source = YAML_RT.load(path.read_text(encoding="utf-8"))
            source_node = next(item for item in source["nodes"] if item["id"] == "request")
            self.assertTrue(source_node["line_layers_locked"])
            runtime_node = result["runtime"]["scenes"][scene["id"]]["nodes"]["request"]
            self.assertTrue(runtime_node["line_layers_locked"])
            untouched_id = next(node_id for node_id in scene["node_order"] if node_id != "request")
            untouched = result["runtime"]["scenes"][scene["id"]]["nodes"][untouched_id]
            self.assertNotIn("line_layers_locked", untouched)
        finally:
            temporary.cleanup()

    def test_save_scene_round_trips_default_background_and_silent_node(self):
        temporary, root = self.make_project_copy()
        try:
            project = StoryProject(root / "story")
            scene = copy.deepcopy(project.build_bundle()["scenes"]["seo_a.email_request"])
            path = Path(project.scenes[scene["id"]]["_source"])
            original_start = scene["start_node"]
            scene["default_background"] = {
                "visual_id": "background.empty_office",
                "variant_id": "night",
            }
            scene["nodes"]["silent_view_test"] = {
                "id": "silent_view_test",
                "kind": "silent",
                "perceived": {"atmosphere": "dread", "line": ""},
                "reality": {"atmosphere": "dread", "line": ""},
                "stage": {"perceived": [], "reality": []},
                "next": original_start,
            }
            scene["node_order"] = ["silent_view_test", *scene["node_order"]]
            scene["start_node"] = "silent_view_test"

            result = save_scene(root, {"scene": scene, "revision": revision(path)})

            self.assertTrue(result["saved"])
            source = YAML_RT.load(path.read_text(encoding="utf-8"))
            self.assertEqual("background.empty_office", source["default_background"]["visual_id"])
            self.assertEqual("night", source["default_background"]["variant_id"])
            source_node = next(item for item in source["nodes"] if item["id"] == "silent_view_test")
            self.assertEqual("silent", source_node["kind"])
            self.assertEqual("", source_node["perceived"]["line"])
            self.assertEqual([], list(source_node["stage"]["perceived"]))
            runtime_scene = result["runtime"]["scenes"][scene["id"]]
            self.assertEqual("silent_view_test", runtime_scene["start_node"])
            self.assertEqual("silent", runtime_scene["nodes"]["silent_view_test"]["kind"])
        finally:
            temporary.cleanup()

    def test_save_scene_preserves_interaction_context_target_and_style_order(self):
        temporary, root = self.make_project_copy()
        try:
            project = StoryProject(root / "story")
            scene = copy.deepcopy(project.build_bundle()["scenes"]["common.day_03_business_trip_or_cafe"])
            path = Path(project.scenes[scene["id"]]["_source"])
            choice = scene["nodes"]["post_resolution_choice"]
            option = next(item for item in choice["options"] if item["id"] == "acknowledge_after_resolution")
            expected_styles = ["autonomy_return", "emotional_validation", "ask_before_helping"]
            option["interaction"]["support_styles"] = expected_styles

            result = save_scene(root, {"scene": scene, "revision": revision(path)})

            self.assertTrue(result["saved"])
            source = YAML_RT.load(path.read_text(encoding="utf-8"))
            source_choice = next(item for item in source["nodes"] if item["id"] == "post_resolution_choice")
            source_option = next(item for item in source_choice["options"] if item["id"] == "acknowledge_after_resolution")
            self.assertEqual({"kind": "support"}, dict(source_choice["interaction_context"]))
            self.assertEqual("cha_min_kyung", source_option["interaction"]["target"])
            self.assertEqual(expected_styles, list(source_option["interaction"]["support_styles"]))

            runtime_choice = result["runtime"]["scenes"][scene["id"]]["nodes"]["post_resolution_choice"]
            runtime_option = next(item for item in runtime_choice["options"] if item["id"] == "acknowledge_after_resolution")
            self.assertEqual({"kind": "support"}, runtime_choice["interaction_context"])
            self.assertEqual(expected_styles, runtime_option["interaction"]["support_styles"])
        finally:
            temporary.cleanup()


    def test_save_scene_rejects_stale_revision(self):
        temporary, root = self.make_project_copy()
        try:
            project = StoryProject(root / "story")
            scene = project.build_bundle()["scenes"]["seo_a.email_request"]
            with self.assertRaisesRegex(RuntimeError, "REVISION_CONFLICT"):
                save_scene(root, {"scene": scene, "revision": "0" * 64})
        finally:
            temporary.cleanup()

    def test_story_text_owner_resolves_direct_dialogue_source(self):
        owner = story_text_owner(
            ROOT,
            "scenes.seo_a.email_request.nodes.request.reality.line",
        )

        self.assertTrue(owner["editable"])
        self.assertEqual("direct_yaml", owner["kind"])
        self.assertEqual("story/scenes/seo_a/email_request.yaml", owner["relativePath"])
        self.assertEqual("nodes.request.reality.line", owner["fieldPath"])
        self.assertGreater(owner["sources"][0]["line"], 0)
        self.assertEqual(value_hash(owner["currentValue"]), owner["currentValueHash"])

    def test_system_dialogue_owner_and_save_are_direct_physical_yaml(self):
        temporary, root = self.make_project_copy()
        try:
            key = "system_flows.system.night_activity.nodes.activity_result.variants.workout.reality.line"
            owner = story_text_owner(root, key)
            self.assertTrue(owner["editable"])
            self.assertEqual("direct_yaml", owner["kind"])
            self.assertEqual("story/system_flows/night_activity.yaml", owner["relativePath"])
            self.assertEqual("nodes.activity_result.variants.workout.reality.line", owner["fieldPath"])

            result = save_story_text(root, {"edits": [{
                "localization_key": key,
                "expected_revision": owner["revision"],
                "expected_value_hash": owner["currentValueHash"],
                "next_value": "운동을 마치고 새 문장을 기록했다.",
            }]})

            self.assertTrue(result["saved"])
            self.assertEqual("운동을 마치고 새 문장을 기록했다.", result["owner"]["currentValue"])
            variant = next(
                item for item in result["runtime"]["system_flows"]["system.night_activity"]["nodes"]["activity_result"]["variants"]
                if item["id"] == "workout"
            )
            self.assertEqual("운동을 마치고 새 문장을 기록했다.", variant["reality"]["line"])
            self.assertIn("system_flows", result["documentUpdates"])
        finally:
            temporary.cleanup()


    def test_save_story_text_updates_only_target_scalar_and_runtime(self):
        temporary, root = self.make_project_copy()
        try:
            keys = [
                "scenes.seo_a.email_request.nodes.request.perceived.line",
                "scenes.seo_a.email_request.nodes.request.reality.line",
            ]
            owners = [story_text_owner(root, key) for key in keys]
            target = root / owners[0]["relativePath"]
            target.write_text("# dialogue-edit-sentinel\n" + target.read_text(encoding="utf-8"), encoding="utf-8")
            owners = [story_text_owner(root, key) for key in keys]
            result = save_story_text(root, {
                "edits": [{
                    "localization_key": owner["key"],
                    "expected_revision": owner["revision"],
                    "expected_value_hash": owner["currentValueHash"],
                    "next_value": "수정된 업무 대사입니다.",
                } for owner in owners],
            })

            self.assertTrue(result["saved"])
            self.assertIn("# dialogue-edit-sentinel", target.read_text(encoding="utf-8"))
            self.assertEqual("수정된 업무 대사입니다.", result["owner"]["currentValue"])
            runtime_node = result["runtime"]["scenes"]["seo_a.email_request"]["nodes"]["request"]
            self.assertEqual("수정된 업무 대사입니다.", runtime_node["perceived"]["line"])
            self.assertEqual("수정된 업무 대사입니다.", runtime_node["reality"]["line"])
        finally:
            temporary.cleanup()

    def test_save_story_text_updates_choice_label_without_mechanics(self):
        temporary, root = self.make_project_copy()
        try:
            key = (
                "scenes.seo_a.email_request.nodes.interpret.options."
                "match_push.label"
            )
            owner = story_text_owner(root, key)
            before = StoryProject(root / "story").build_bundle()["scenes"]["seo_a.email_request"]["nodes"]["interpret"]
            result = save_story_text(root, {
                "localization_key": key,
                "expected_revision": owner["revision"],
                "expected_value_hash": owner["currentValueHash"],
                "next_value": "알겠다고 답하고 필요한 자료만 묻는다",
            })

            self.assertTrue(result["saved"])
            after = result["runtime"]["scenes"]["seo_a.email_request"]["nodes"]["interpret"]
            before_option = next(option for option in before["options"] if option["id"] == "match_push")
            after_option = next(option for option in after["options"] if option["id"] == "match_push")
            self.assertEqual("알겠다고 답하고 필요한 자료만 묻는다", after_option["label"])
            self.assertEqual(before_option["effects"], after_option["effects"])
            self.assertEqual(before_option["push_pull"], after_option["push_pull"])
        finally:
            temporary.cleanup()

    def test_save_story_text_rejects_stale_revision_and_value(self):
        temporary, root = self.make_project_copy()
        try:
            key = "scenes.seo_a.email_request.nodes.request.reality.line"
            owner = story_text_owner(root, key)
            with self.assertRaisesRegex(RuntimeError, "REVISION_CONFLICT"):
                save_story_text(root, {
                    "localization_key": key,
                    "expected_revision": "0" * 64,
                    "expected_value_hash": owner["currentValueHash"],
                    "next_value": "저장되면 안 되는 대사",
                })
            with self.assertRaisesRegex(RuntimeError, "VALUE_CONFLICT"):
                save_story_text(root, {
                    "localization_key": key,
                    "expected_revision": owner["revision"],
                    "expected_value_hash": "0" * 64,
                    "next_value": "저장되면 안 되는 대사",
                })
        finally:
            temporary.cleanup()

    def test_save_story_text_preserves_ui_placeholders(self):
        temporary, root = self.make_project_copy()
        try:
            key = "deadline.days"
            owner = story_text_owner(root, key)
            with self.assertRaisesRegex(RuntimeError, "placeholders must be preserved"):
                save_story_text(root, {
                    "localization_key": key,
                    "expected_revision": owner["revision"],
                    "expected_value_hash": owner["currentValueHash"],
                    "next_value": "남은 날짜를 제거한 문구",
                })
        finally:
            temporary.cleanup()

    def test_mobile_sync_snapshot_exposes_only_path_free_editable_dialogue(self):
        snapshot = mobile_sync_snapshot(ROOT)

        self.assertEqual("love_office_story_1", snapshot["projectId"])
        self.assertEqual("ko", snapshot["defaultLocale"])
        self.assertGreater(len(snapshot["entries"]), 100)
        self.assertTrue(all(entry["domain"] in {"scene", "system_flow"} for entry in snapshot["entries"]))
        self.assertTrue(all("relativePath" not in entry and "fieldPath" not in entry for entry in snapshot["entries"]))
        self.assertTrue(all(value_hash(entry["value"]) == entry["valueHash"] for entry in snapshot["entries"]))

    def test_mobile_scene_hash_matches_the_browser_canonical_json_contract(self):
        fixture = {
            "id": "scene.test",
            "node_order": ["a", "b"],
            "nodes": {"a": {"line": "안녕"}, "b": {"locked": True}},
        }
        self.assertEqual(
            "14b38d06fa4be07a96d216959e360fa7e1f05cd4aac68cd21961fa2e85f45f3b",
            json_value_hash(fixture),
        )

    def test_mobile_sync_rebases_unrelated_file_revision_and_applies(self):
        temporary, root = self.make_project_copy()
        try:
            key = "scenes.seo_a.email_request.nodes.request.reality.line"
            owner = story_text_owner(root, key)
            target = root / owner["relativePath"]
            target.write_text("# unrelated revision\n" + target.read_text(encoding="utf-8"), encoding="utf-8")

            result = apply_mobile_sync_changes(root, {"changes": [{
                "eventId": "event_rebase_00000001",
                "projectId": "love_office_story_1",
                "localizationKey": key,
                "locale": "ko",
                "baseValue": owner["currentValue"],
                "baseValueHash": owner["currentValueHash"],
                "nextValue": "모바일에서 안전하게 바꾼 현실 대사입니다.",
            }]})

            self.assertEqual("applied", result["receipts"][0]["status"])
            updated = story_text_owner(root, key)
            self.assertEqual("모바일에서 안전하게 바꾼 현실 대사입니다.", updated["currentValue"])
            paired = story_text_owner(
                root,
                "scenes.seo_a.email_request.nodes.request.perceived.line",
            )
            self.assertEqual(updated["currentValue"], paired["currentValue"])
            self.assertIn("# unrelated revision", target.read_text(encoding="utf-8"))
        finally:
            temporary.cleanup()

    def test_mobile_sync_reports_same_field_conflict_without_overwrite(self):
        temporary, root = self.make_project_copy()
        try:
            key = "scenes.seo_a.email_request.nodes.request.reality.line"
            original = story_text_owner(root, key)
            paired_key = "scenes.seo_a.email_request.nodes.request.perceived.line"
            paired = story_text_owner(root, paired_key)
            local_value = "Mac에서 먼저 수정한 현실 대사입니다."
            saved = save_story_text(root, {"edits": [
                {
                    "localization_key": key,
                    "expected_revision": original["revision"],
                    "expected_value_hash": original["currentValueHash"],
                    "next_value": local_value,
                },
                {
                    "localization_key": paired_key,
                    "expected_revision": paired["revision"],
                    "expected_value_hash": paired["currentValueHash"],
                    "next_value": local_value,
                },
            ]})
            self.assertTrue(saved["saved"])

            result = apply_mobile_sync_changes(root, {"changes": [{
                "eventId": "event_conflict_000001",
                "projectId": "love_office_story_1",
                "localizationKey": key,
                "locale": "ko",
                "baseValue": original["currentValue"],
                "baseValueHash": original["currentValueHash"],
                "nextValue": "휴대폰에서도 따로 수정한 대사입니다.",
            }]})

            receipt = result["receipts"][0]
            self.assertEqual("conflict", receipt["status"])
            self.assertEqual(local_value, receipt["currentValue"])
            self.assertEqual(local_value, story_text_owner(root, key)["currentValue"])
        finally:
            temporary.cleanup()

    def test_mobile_scene_sync_three_way_merges_unrelated_mac_edit(self):
        temporary, root = self.make_project_copy()
        try:
            snapshot = mobile_sync_snapshot(root)
            record = snapshot["workspace"]["scenes"]["seo_a.email_request"]
            base_scene = copy.deepcopy(record["scene"])
            mobile_scene = copy.deepcopy(base_scene)
            mobile_scene["nodes"]["request"]["perceived"]["line"] = "휴대폰에서 고친 요청 대사입니다."
            mobile_scene["nodes"]["request"]["reality"]["line"] = "휴대폰에서 고친 요청 대사입니다."

            mac_scene = copy.deepcopy(base_scene)
            mac_scene["title"] = "Mac에서 바꾼 장면 제목"
            source = StoryProject(root / "story").scenes[mac_scene["id"]]
            saved = save_scene(root, {
                "scene": mac_scene,
                "revision": revision(Path(source["_source"])),
            })
            self.assertTrue(saved["saved"])

            result = apply_mobile_sync_changes(root, {
                "changes": [],
                "sceneChanges": [{
                    "eventId": "scene_merge_event_0001",
                    "projectId": "love_office_story_1",
                    "sceneId": base_scene["id"],
                    "baseSceneHash": json_value_hash(base_scene),
                    "nextSceneHash": json_value_hash(mobile_scene),
                    "baseScene": base_scene,
                    "nextScene": mobile_scene,
                }],
            })

            self.assertEqual("applied", result["sceneReceipts"][0]["status"])
            merged = result["snapshot"]["workspace"]["scenes"][base_scene["id"]]["scene"]
            self.assertEqual("Mac에서 바꾼 장면 제목", merged["title"])
            self.assertEqual("휴대폰에서 고친 요청 대사입니다.", merged["nodes"]["request"]["reality"]["line"])
        finally:
            temporary.cleanup()

    def test_mobile_scene_sync_reports_overlapping_field_conflict(self):
        temporary, root = self.make_project_copy()
        try:
            snapshot = mobile_sync_snapshot(root)
            base_scene = copy.deepcopy(snapshot["workspace"]["scenes"]["seo_a.email_request"]["scene"])
            mobile_scene = copy.deepcopy(base_scene)
            mobile_scene["purpose"] = "휴대폰에서 바꾼 목적"
            mac_scene = copy.deepcopy(base_scene)
            mac_scene["purpose"] = "Mac에서 바꾼 목적"
            source = StoryProject(root / "story").scenes[mac_scene["id"]]
            self.assertTrue(save_scene(root, {
                "scene": mac_scene,
                "revision": revision(Path(source["_source"])),
            })["saved"])

            result = apply_mobile_sync_changes(root, {
                "changes": [],
                "sceneChanges": [{
                    "eventId": "scene_conflict_event_01",
                    "projectId": "love_office_story_1",
                    "sceneId": base_scene["id"],
                    "baseSceneHash": json_value_hash(base_scene),
                    "nextSceneHash": json_value_hash(mobile_scene),
                    "baseScene": base_scene,
                    "nextScene": mobile_scene,
                }],
            })

            receipt = result["sceneReceipts"][0]
            self.assertEqual("conflict", receipt["status"])
            self.assertIn("scene.purpose", receipt["reason"])
            self.assertEqual("Mac에서 바꾼 목적", receipt["currentScene"]["purpose"])
        finally:
            temporary.cleanup()

    def test_save_story_translation_creates_and_undo_removes_locale_scalar(self):
        temporary, root = self.make_project_copy()
        try:
            key = (
                "scenes.common.day_02_practical_meeting.nodes."
                "day_one_activity_reaction.variants.after_workout.reality.line"
            )
            owner = story_text_owner(root, key, "en")
            self.assertFalse(owner["translationExists"])
            result = save_story_text(root, {
                "localization_key": key,
                "locale": "en",
                "expected_revision": owner["revision"],
                "expected_value_hash": owner["currentValueHash"],
                "next_value": "I started working out again. Shall we check the attendee list?",
            })

            self.assertTrue(result["saved"])
            updated = result["owner"]
            self.assertTrue(updated["translationExists"])
            self.assertEqual(
                "I started working out again. Shall we check the attendee list?",
                result["runtime"]["localization"]["direct_catalogs"]["en"][key],
            )
            undo = save_story_text(root, {
                "localization_key": key,
                "locale": "en",
                "expected_revision": updated["revision"],
                "expected_value_hash": updated["currentValueHash"],
                "delete": True,
            })

            self.assertTrue(undo["saved"])
            self.assertFalse(undo["owner"]["translationExists"])
            self.assertIn("runtimePatch", undo)
            persisted_runtime = json.loads((root / "build" / "story-runtime.json").read_text(encoding="utf-8"))
            self.assertNotIn(key, persisted_runtime["localization"]["direct_catalogs"]["en"])
        finally:
            temporary.cleanup()


    def test_save_timeline_event_round_trips_and_rebuilds_runtime(self):
        temporary, root = self.make_project_copy()
        try:
            project = StoryProject(root / "story")
            event = copy.deepcopy(project.events["seo_a.email_request"])
            target = Path(event.pop("_source"))
            event["title"] = "수정된 시간 이벤트"
            result = save_document(root, {
                "kind": "events",
                "document": event,
                "revision": revision(target),
            })
            self.assertTrue(result["saved"])
            self.assertEqual("수정된 시간 이벤트", result["runtime"]["events"]["seo_a.email_request"]["title"])
            self.assertIn("수정된 시간 이벤트", target.read_text(encoding="utf-8"))
            self.assertTrue((root / "build" / "story-runtime.json").is_file())
        finally:
            temporary.cleanup()

    def test_save_locale_round_trips_and_rebuilds_runtime_catalog(self):
        temporary, root = self.make_project_copy()
        try:
            project = StoryProject(root / "story")
            locale = copy.deepcopy(project.locales["en"])
            target = Path(locale.pop("_source"))
            locale["strings"]["scenes.seo_a.email_request.title"] = "Email Only"
            result = save_document(root, {
                "kind": "locales",
                "document": locale,
                "revision": revision(target),
            })
            self.assertTrue(result["saved"])
            self.assertEqual(
                "Email Only",
                result["runtime"]["localization"]["catalogs"]["en"]["scenes.seo_a.email_request.title"],
            )
        finally:
            temporary.cleanup()

    def test_save_locale_commits_multiple_rows_in_one_transaction(self):
        temporary, root = self.make_project_copy()
        try:
            project = StoryProject(root / "story")
            locale = copy.deepcopy(project.locales["en"])
            target = Path(locale.pop("_source"))
            locale["strings"].update({
                "scenes.seo_a.email_request.title": "Email Delivery Only",
                "scenes.seo_a.email_request.nodes.request.perceived.line": "Send it by email and keep your distance.",
                "scenes.seo_a.email_request.nodes.request.reality.line": "Send it by email and keep your distance.",
            })
            result = save_document(root, {
                "kind": "locales",
                "document": locale,
                "revision": revision(target),
            })
            self.assertTrue(result["saved"])
            catalog = result["runtime"]["localization"]["catalogs"]["en"]
            self.assertEqual("Email Delivery Only", catalog["scenes.seo_a.email_request.title"])
            self.assertEqual(
                "Send it by email and keep your distance.",
                catalog["scenes.seo_a.email_request.nodes.request.reality.line"],
            )
        finally:
            temporary.cleanup()

    def test_failed_locale_transaction_preserves_file_and_runtime(self):
        temporary, root = self.make_project_copy()
        try:
            project = StoryProject(root / "story")
            locale = copy.deepcopy(project.locales["en"])
            target = Path(locale.pop("_source"))
            before_file = target.read_text(encoding="utf-8")
            runtime_path = root / "build" / "story-runtime.json"
            locale["strings"]["deadline.days"] = "Deadline has no placeholder"
            result = save_document(root, {
                "kind": "locales",
                "document": locale,
                "revision": revision(target),
            })
            self.assertFalse(result["saved"])
            self.assertTrue(any("placeholder mismatch" in issue["message"] for issue in result["issues"]))
            self.assertEqual(before_file, target.read_text(encoding="utf-8"))
            self.assertFalse(runtime_path.exists())
        finally:
            temporary.cleanup()

    def test_save_character_round_trips_profile_and_rules(self):
        temporary, root = self.make_project_copy()
        try:
            project = StoryProject(root / "story")
            character = copy.deepcopy(project.characters["yoon_seo_a"])
            target = Path(character.pop("_source"))
            character["summary"] = "에디터에서 수정한 인물 요약"
            character["emotion_rules"][0]["priority"] = 35

            result = save_document(root, {
                "kind": "characters",
                "document": character,
                "revision": revision(target),
            })

            self.assertTrue(result["saved"])
            saved = result["runtime"]["characters"]["yoon_seo_a"]
            self.assertEqual("에디터에서 수정한 인물 요약", saved["summary"])
            self.assertEqual(35, saved["emotion_rules"][0]["priority"])
            self.assertIn("에디터에서 수정한 인물 요약", target.read_text(encoding="utf-8"))
        finally:
            temporary.cleanup()

    def test_save_route_round_trips_order_and_unlock_conditions(self):
        temporary, root = self.make_project_copy()
        try:
            project = StoryProject(root / "story")
            route = copy.deepcopy(project.routes["seo_a"])
            target = Path(route.pop("_source"))
            route["summary"] = "에디터에서 수정한 루트 요약"
            route["unlock_conditions"] = [
                {"path": "progress.cleared_routes", "op": "contains", "value": "min_kyung"}
            ]

            result = save_document(root, {
                "kind": "routes",
                "document": route,
                "revision": revision(target),
            })

            self.assertTrue(result["saved"])
            saved = result["runtime"]["routes"]["seo_a"]
            self.assertEqual("에디터에서 수정한 루트 요약", saved["summary"])
            self.assertEqual("min_kyung", saved["unlock_conditions"][0]["value"])
        finally:
            temporary.cleanup()

    def test_save_visual_round_trips_variant_match(self):
        temporary, root = self.make_project_copy()
        try:
            project = StoryProject(root / "story")
            visual = copy.deepcopy(project.visuals["background.office_open"])
            target = Path(visual.pop("_source"))
            visual["variants"]["late_afternoon"]["priority"] = 77
            visual["variants"]["late_afternoon"]["match"]["atmospheres"] = ["awkward"]

            result = save_document(root, {
                "kind": "visuals",
                "document": visual,
                "revision": revision(target),
            })

            self.assertTrue(result["saved"])
            saved = result["runtime"]["visuals"]["background.office_open"]
            self.assertEqual(77, saved["variants"]["late_afternoon"]["priority"])
            self.assertEqual(["awkward"], saved["variants"]["late_afternoon"]["match"]["atmospheres"])
        finally:
            temporary.cleanup()

    def test_save_campaign_round_trips_calendar_title(self):
        temporary, root = self.make_project_copy()
        try:
            project = StoryProject(root / "story")
            campaign = copy.deepcopy(project.campaigns["main"])
            target = Path(campaign.pop("_source"))
            campaign["title"] = "에디터에서 수정한 캠페인"
            campaign["acts"][0]["purpose"] = "수정한 첫 막 목적"

            result = save_document(root, {
                "kind": "campaigns",
                "document": campaign,
                "revision": revision(target),
            })

            self.assertTrue(result["saved"])
            saved = result["runtime"]["campaigns"]["main"]
            self.assertEqual("에디터에서 수정한 캠페인", saved["title"])
            self.assertEqual("수정한 첫 막 목적", saved["acts"][0]["purpose"])
        finally:
            temporary.cleanup()

    def test_save_thread_round_trips_title(self):
        temporary, root = self.make_project_copy()
        try:
            project = StoryProject(root / "story")
            thread = copy.deepcopy(project.threads["seo_a"])
            target = Path(thread.pop("_source"))
            thread["title"] = "에디터에서 수정한 사건 연결"

            result = save_document(root, {
                "kind": "threads",
                "document": thread,
                "revision": revision(target),
            })

            self.assertTrue(result["saved"])
            self.assertEqual("에디터에서 수정한 사건 연결", result["runtime"]["threads"]["seo_a"]["title"])
        finally:
            temporary.cleanup()

    def test_save_meta_round_trips_unlock_teaser(self):
        temporary, root = self.make_project_copy()
        try:
            project = StoryProject(root / "story")
            meta = copy.deepcopy(project.meta["unlocks"])
            target = Path(meta.pop("_source"))
            meta["mode_teasers"][0]["reveals"][0]["title"] = "에디터에서 수정한 예고"

            result = save_document(root, {
                "kind": "meta",
                "document": meta,
                "revision": revision(target),
            })

            self.assertTrue(result["saved"])
            saved = result["runtime"]["meta"]["unlocks"]
            self.assertEqual("에디터에서 수정한 예고", saved["mode_teasers"][0]["reveals"][0]["title"])
        finally:
            temporary.cleanup()

    def test_duplicate_scene_creates_file_and_updates_route_order(self):
        temporary, root = self.make_project_copy()
        try:
            result = duplicate_scene(root, {
                "source_id": "seo_a.email_request",
                "new_id": "seo_a.email_request_copy",
                "title": "자료는 메일로 복사본",
            })

            self.assertTrue(result["created"])
            self.assertEqual("자료는 메일로 복사본", result["runtime"]["scenes"]["seo_a.email_request_copy"]["title"])
            order = result["runtime"]["routes"]["seo_a"]["scene_order"]
            self.assertEqual(
                [
                    "common.day_02_practical_meeting",
                    "common.day_03_business_trip_or_cafe",
                    "bonus.stat_health_sample_sorting",
                    "bonus.stat_intelligence_version_check",
                    "bonus.stat_humor_tasting_vote",
                    "bonus.stat_appearance_rehearsal",
                    "common.day_04_weekend_encounter",
                    "common.day_05_weekend_reflection",
                    "seo_a.email_request",
                    "seo_a.email_request_copy",
                    "seo_a.relief_smile",
                ],
                order,
            )
            target = root / result["scene"]["path"]
            self.assertTrue(target.is_file())
            self.assertEqual("email_request_copy.yaml", target.name)
            self.assertEqual([], [issue for issue in result["issues"] if issue["severity"] == "error"])
        finally:
            temporary.cleanup()

    def test_duplicate_event_creates_file_and_updates_thread_order(self):
        temporary, root = self.make_project_copy()
        try:
            result = duplicate_event(root, {
                "source_id": "seo_a.email_request",
                "new_id": "seo_a.email_request_copy",
                "title": "메일 요청 복사본",
            })

            self.assertTrue(result["created"])
            self.assertEqual("메일 요청 복사본", result["runtime"]["events"]["seo_a.email_request_copy"]["title"])
            events = result["runtime"]["threads"]["seo_a"]["events"]
            self.assertEqual("seo_a.email_request_copy", events[events.index("seo_a.email_request") + 1])
            target = root / result["event"]["path"]
            self.assertTrue(target.is_file())
            self.assertEqual("email_request_copy.yaml", target.name)
            self.assertEqual([], [issue for issue in result["issues"] if issue["severity"] == "error"])
        finally:
            temporary.cleanup()

    def test_duplicate_event_rolls_back_every_file_when_runtime_write_fails(self):
        temporary, root = self.make_project_copy()
        try:
            thread_path = root / "story" / "threads" / "seo_a.yaml"
            before = thread_path.read_bytes()
            target = root / "story" / "events" / "heroine" / "email_request_copy.yaml"

            with mock.patch("story_editor_bridge.write_json", side_effect=RuntimeError("simulated write failure")):
                with self.assertRaisesRegex(RuntimeError, "simulated write failure"):
                    duplicate_event(root, {
                        "source_id": "seo_a.email_request",
                        "new_id": "seo_a.email_request_copy",
                        "title": "메일 요청 복사본",
                    })

            self.assertFalse(target.exists())
            self.assertEqual(before, thread_path.read_bytes())
            self.assertEqual([], StoryProject(root / "story").validate())
        finally:
            temporary.cleanup()


if __name__ == "__main__":
    unittest.main()
