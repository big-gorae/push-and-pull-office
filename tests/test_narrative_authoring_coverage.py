import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from story_editor_bridge import (  # noqa: E402
    YAML_RT,
    editable_story_text_field,
    resolve_yaml_text_field,
    source_path_for_entry,
)
from story_harness import StoryProject, collect_localizable_entries  # noqa: E402


def is_player_narrative(entry: dict) -> bool:
    domain = entry.get("domain")
    field_path = entry.get("sourceDocument", {}).get("fieldPath", "")
    if domain == "system_flow":
        return True
    if domain == "scene":
        return ".analysis_hints." in field_path or field_path.endswith(".line") or any(
            field_path.endswith(suffix)
            for suffix in (".prompt", ".stimulus", ".label", ".interpretation", ".action")
        )
    if domain == "event":
        return ".presentation." in field_path
    return False


class NarrativeAuthoringCoverageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.project = StoryProject(ROOT / "story")
        cls.entries = collect_localizable_entries(cls.project)

    def test_every_player_narrative_unit_has_one_editable_physical_yaml_field(self):
        units = [entry for entry in self.entries.values() if is_player_narrative(entry)]
        self.assertGreater(len(units), 350)
        owners = set()
        documents = {}
        for entry in units:
            document = entry["sourceDocument"]
            kind = document["kind"]
            field_path = document["fieldPath"]
            self.assertTrue(
                editable_story_text_field(kind, field_path),
                f"missing editor target: {entry['key']} -> {kind}:{field_path}",
            )
            target = source_path_for_entry(ROOT, self.project, entry)
            if target not in documents:
                with target.open("r", encoding="utf-8") as handle:
                    documents[target] = YAML_RT.load(handle)
            parent, field = resolve_yaml_text_field(documents[target], field_path)
            self.assertEqual(entry["source"], str(parent[field]), entry["key"])
            identity = (str(target), field_path)
            self.assertNotIn(identity, owners, f"multiple text units own {identity}")
            owners.add(identity)
        self.assertEqual(len(units), len(owners))

    def test_system_narrative_is_not_owned_by_ui_or_manifest(self):
        ui_keys = set(self.project.ui.get("strings", {}))
        forbidden_ui = {
            "selfDevelopment.intro",
            "selfDevelopment.forcedIntro",
            "analysisHint.lesson.pull",
            "analysisHint.lesson.push",
            "analysisHint.lesson.none",
        }
        self.assertTrue(ui_keys.isdisjoint(forbidden_ui))
        self.assertFalse(any(".reflection." in key for key in ui_keys))
        self.assertNotIn("conversation_topics", self.project.manifest.get("self_development", {}))

    def test_no_runtime_only_dialogue_template_or_player_fallback_remains(self):
        for scene in self.project.scenes.values():
            for node in scene.get("nodes", []):
                self.assertNotIn("self_development_template", node)
        player_source = (ROOT / "src/player/WebGame.tsx").read_text(encoding="utf-8")
        self.assertNotIn('i18n.ui("selfDevelopment.intro")', player_source)
        self.assertNotIn("analysisHint.lesson.", player_source)
        self.assertNotIn("reflection_keys", player_source)

    def test_required_system_groups_are_present_in_the_authoring_registry(self):
        system_entries = [entry for entry in self.entries.values() if entry["domain"] == "system_flow"]
        by_flow = {entry["context"]["flowId"] for entry in system_entries}
        self.assertEqual({"system.night_activity", "system.analysis_hint"}, by_flow)
        # 2 intro lines + 6 result lines + 12 option fields + 3 instructor lines.
        self.assertEqual(23, len(system_entries))


if __name__ == "__main__":
    unittest.main()
