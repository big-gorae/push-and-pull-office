import { useCallback, useEffect, useRef } from "react";
import {
  editorSaveCoordinator,
  type DocumentSnapshot,
  type SaveCommitResult,
  type SaveCompletion,
  type SaveCoordinator,
  type SaveState,
} from "./editorSave";

type Options<T, Result extends SaveCommitResult> = {
  slot: string;
  active: boolean;
  projectRoot: string;
  documentKey: string;
  revision: string;
  dirty: boolean;
  version: number;
  read(): T | null;
  commit(snapshot: DocumentSnapshot<T>): Promise<Result>;
  onCommitted?(result: Result, completion: SaveCompletion<T>): void;
  onState?(state: SaveState): void;
  coordinator?: SaveCoordinator;
};

export function useDocumentAutosave<T, Result extends SaveCommitResult>(options: Options<T, Result>) {
  const coordinator = options.coordinator ?? editorSaveCoordinator;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const registrationRef = useRef<ReturnType<typeof coordinator.register<T, Result>> | null>(null);

  if (!registrationRef.current) {
    registrationRef.current = coordinator.register<T, Result>(options.slot, {
      projectRoot: options.projectRoot,
      documentKey: options.documentKey,
      revision: options.revision,
      read: () => optionsRef.current.read(),
      commit: (snapshot) => optionsRef.current.commit(snapshot),
      onCommitted: (result, completion) => optionsRef.current.onCommitted?.(result, completion),
      onState: (state) => optionsRef.current.onState?.(state),
    });
  }

  registrationRef.current.update({
    projectRoot: options.projectRoot,
    documentKey: options.documentKey,
    revision: options.revision,
    read: () => optionsRef.current.read(),
    commit: (snapshot) => optionsRef.current.commit(snapshot),
    onCommitted: (result, completion) => optionsRef.current.onCommitted?.(result, completion),
    onState: (state) => optionsRef.current.onState?.(state),
  });

  const identityRef = useRef(`${options.projectRoot}\0${options.documentKey}`);
  useEffect(() => {
    const identity = `${options.projectRoot}\0${options.documentKey}`;
    if (identityRef.current !== identity) {
      identityRef.current = identity;
      registrationRef.current?.reset(options.projectRoot, options.documentKey, options.revision, options.version);
    }
  }, [options.documentKey, options.projectRoot, options.revision, options.version]);

  useEffect(() => {
    registrationRef.current?.reconcile(options.dirty, options.version, options.revision);
  }, [options.dirty, options.revision, options.version]);

  useEffect(() => {
    if (options.active) registrationRef.current?.activate();
  }, [options.active]);

  useEffect(() => () => registrationRef.current?.dispose(), []);

  return {
    flush: useCallback(() => registrationRef.current?.flush() ?? Promise.resolve(), []),
    state: useCallback(() => registrationRef.current?.state(), []),
  };
}

export function useSaveCommandBinding(
  enabled = true,
  coordinator: SaveCoordinator = editorSaveCoordinator,
): void {
  useEffect(() => {
    if (!enabled) return;
    const handleKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "s") return;
      event.preventDefault();
      void coordinator.flushActive();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [coordinator, enabled]);
}
