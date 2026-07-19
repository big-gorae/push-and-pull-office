import copy
import shutil
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from story_editor_bridge import (  # noqa: E402
    derive_state_contract,
    load_project,
    revision,
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
        self.assertEqual(12, len(result["runtime"]["scenes"]))
        self.assertEqual(12, len(result["documents"]["scenes"]))
        self.assertEqual([], result["issues"])
        self.assertEqual(64, len(result["documents"]["scenes"]["seo_a.email_request"]["revision"]))

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


if __name__ == "__main__":
    unittest.main()
