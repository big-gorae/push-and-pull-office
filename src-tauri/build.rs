fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "default_project_root",
            "load_project",
            "validate_project",
            "validate_scene",
            "save_scene",
            "save_document",
            "get_story_text_owner",
            "save_story_text",
            "mobile_sync_snapshot",
            "apply_mobile_sync_changes",
            "duplicate_scene",
            "duplicate_event",
            "build_runtime",
            "read_asset",
            "reveal_in_file_manager",
            "open_source_location",
        ])),
    )
    .expect("failed to build Tauri command permissions")
}
