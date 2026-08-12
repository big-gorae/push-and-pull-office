import { useEffect, useRef } from "react";

export type DraftRecord<T> = {
  key: string;
  projectRoot: string;
  baseRevision: string;
  editVersion: number;
  value: T;
  updatedAt: number;
};

type StoredDraft = DraftRecord<unknown>;

export interface DraftJournal {
  read<T>(key: string): Promise<DraftRecord<T> | undefined>;
  write<T>(record: DraftRecord<T>): Promise<void>;
  remove(key: string): Promise<void>;
  flush(): Promise<void>;
}

export class IndexedDbDraftJournal implements DraftJournal {
  private readonly memory = new Map<string, StoredDraft>();
  private databasePromise: Promise<IDBDatabase | undefined> | undefined;
  private pending = new Set<Promise<void>>();

  async read<T>(key: string): Promise<DraftRecord<T> | undefined> {
    const database = await this.database().catch(() => undefined);
    if (!database) return this.memory.get(key) as DraftRecord<T> | undefined;
    return new Promise<DraftRecord<T> | undefined>((resolve, reject) => {
      const request = database.transaction("drafts", "readonly").objectStore("drafts").get(key);
      request.onsuccess = () => resolve(request.result as DraftRecord<T> | undefined);
      request.onerror = () => reject(request.error);
    }).catch(() => this.memory.get(key) as DraftRecord<T> | undefined);
  }

  write<T>(record: DraftRecord<T>): Promise<void> {
    this.memory.set(record.key, record as StoredDraft);
    return this.track(this.writeToDatabase(record as StoredDraft));
  }

  remove(key: string): Promise<void> {
    this.memory.delete(key);
    return this.track(this.removeFromDatabase(key));
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private async writeToDatabase(record: StoredDraft): Promise<void> {
    const database = await this.database();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("drafts", "readwrite");
      transaction.objectStore("drafts").put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  private async removeFromDatabase(key: string): Promise<void> {
    const database = await this.database();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("drafts", "readwrite");
      transaction.objectStore("drafts").delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  private track(operation: Promise<void>): Promise<void> {
    const resilient = operation.catch(() => undefined);
    this.pending.add(resilient);
    void resilient.then(() => this.pending.delete(resilient));
    return resilient;
  }

  private database(): Promise<IDBDatabase | undefined> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve) => {
      if (typeof indexedDB === "undefined") {
        resolve(undefined);
        return;
      }
      const request = indexedDB.open("love-office-editor", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("drafts")) {
          request.result.createObjectStore("drafts", { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
    return this.databasePromise;
  }
}

export const editorDraftJournal = new IndexedDbDraftJournal();

type JournalOptions<T> = {
  enabled: boolean;
  key: string;
  projectRoot: string;
  baseRevision: string;
  editVersion: number;
  value: T | null;
  debounceMs?: number;
  maxWaitMs?: number;
  journal?: DraftJournal;
};

export function useDraftJournal<T>({
  enabled,
  key,
  projectRoot,
  baseRevision,
  editVersion,
  value,
  debounceMs = 250,
  maxWaitMs = 2_000,
  journal = editorDraftJournal,
}: JournalOptions<T>): void {
  const idleTimer = useRef<number | undefined>(undefined);
  const maxTimer = useRef<number | undefined>(undefined);
  const latest = useRef({ enabled, key, projectRoot, baseRevision, editVersion, value });
  latest.current = { enabled, key, projectRoot, baseRevision, editVersion, value };

  useEffect(() => {
    const persist = () => {
      const current = latest.current;
      if (!current.enabled || current.value === null) return;
      void journal.write({
        key: current.key,
        projectRoot: current.projectRoot,
        baseRevision: current.baseRevision,
        editVersion: current.editVersion,
        value: current.value,
        updatedAt: Date.now(),
      });
    };
    window.clearTimeout(idleTimer.current);
    if (!enabled || value === null) {
      window.clearTimeout(maxTimer.current);
      maxTimer.current = undefined;
      void journal.remove(key);
      return;
    }
    idleTimer.current = window.setTimeout(() => {
      idleTimer.current = undefined;
      window.clearTimeout(maxTimer.current);
      maxTimer.current = undefined;
      persist();
    }, debounceMs);
    if (maxTimer.current === undefined) {
      maxTimer.current = window.setTimeout(() => {
        maxTimer.current = undefined;
        window.clearTimeout(idleTimer.current);
        idleTimer.current = undefined;
        persist();
      }, maxWaitMs);
    }
    return () => window.clearTimeout(idleTimer.current);
  }, [baseRevision, debounceMs, editVersion, enabled, journal, key, maxWaitMs, projectRoot, value]);

  useEffect(() => () => {
    window.clearTimeout(idleTimer.current);
    window.clearTimeout(maxTimer.current);
    const current = latest.current;
    if (current.enabled && current.value !== null) {
      void journal.write({ ...current, value: current.value, updatedAt: Date.now() });
    }
  }, [journal]);
}
