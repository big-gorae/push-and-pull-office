import copy
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from story_editor_bridge import (  # noqa: E402
    derive_state_contract,
    duplicate_event,
    duplicate_scene,
    load_project,
    revision,
    save_document,
    save_scene,
    validate_scene,
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
        self.assertEqual(14, len(result["runtime"]["scenes"]))
        self.assertEqual(14, len(result["documents"]["scenes"]))
        self.assertEqual([], result["issues"])
        self.assertEqual(64, len(result["documents"]["scenes"]["seo_a.email_request"]["revision"]))
        self.assertEqual(24, len(result["documents"]["events"]))
        self.assertIn("common.day_01_company_meeting", result["documents"]["scenes"])
        self.assertIn("common.day_01_parent_pressure", result["documents"]["scenes"])
        self.assertIn("common.day_02_practical_meeting", result["documents"]["scenes"])
        self.assertIn("common.day_03_business_trip_or_cafe", result["documents"]["scenes"])
        self.assertIn("common.day_04_weekend_encounter", result["documents"]["scenes"])
        self.assertIn("common.day_05_weekend_reflection", result["documents"]["scenes"])
        self.assertIn("anchor.day_01_parent_pressure", result["documents"]["events"])
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
                    "self_development": {"expression": "stamina.answer"},
                }],
            }],
        }
        derive_state_contract(scene, {
            "stamina.answer": {
                "requires": {
                    "appeal_gte": 32,
                    "stat": "stamina",
                    "minimum": 2,
                    "fatigue_lte": 4,
                },
            },
        })
        self.assertEqual(
            [
                "visible.protagonist.self_development.appeal",
                "visible.protagonist.self_development.stats.stamina",
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

    def test_save_scene_rejects_stale_revision(self):
        temporary, root = self.make_project_copy()
        try:
            project = StoryProject(root / "story")
            scene = project.build_bundle()["scenes"]["seo_a.email_request"]
            with self.assertRaisesRegex(RuntimeError, "REVISION_CONFLICT"):
                save_scene(root, {"scene": scene, "revision": "0" * 64})
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
