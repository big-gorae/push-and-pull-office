import { invoke } from "@tauri-apps/api/core";

/** Authoritative persistence port used by document adapters after coordination. */
export class EditorSaveRepository {
  saveScene<Result>(root: string, scene: unknown, revision: string): Promise<Result> {
    return invoke<Result>("save_scene", { root, scene, revision });
  }

  saveDocument<Result>(root: string, kind: string, document: unknown, revision: string): Promise<Result> {
    return invoke<Result>("save_document", { root, kind, document, revision });
  }
}

export const editorSaveRepository = new EditorSaveRepository();
