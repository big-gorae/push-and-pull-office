export type SavePhase = "clean" | "dirty" | "queued" | "saving" | "error" | "conflict";

export type DocumentSnapshot<T> = {
  key: string;
  projectRoot: string;
  sessionEpoch: number;
  editVersion: number;
  baseRevision: string;
  value: Readonly<T>;
};

export type SaveCommitResult = {
  revision: string;
};

export type SaveState = {
  key: string;
  phase: SavePhase;
  editVersion: number;
  persistedVersion: number;
  hasPendingChanges: boolean;
  savedAt?: number;
  error?: string;
};

export type SaveCompletion<T> = {
  snapshot: DocumentSnapshot<T>;
  isLatest: boolean;
  state: SaveState;
};

export class SaveFailure extends Error {
  constructor(
    message: string,
    readonly kind: "validation" | "conflict" | "transient" = "transient",
  ) {
    super(message);
    this.name = "SaveFailure";
  }
}

export class DocumentSession<T> {
  private epoch = 0;
  private editVersionValue = 0;
  private persistedVersionValue = 0;
  private phaseValue: SavePhase = "clean";
  private savedAtValue: number | undefined;
  private errorValue: string | undefined;

  constructor(
    private projectRootValue: string,
    private keyValue: string,
    private revisionValue: string,
  ) {
    this.epoch = 1;
  }

  get key(): string { return this.keyValue; }
  get projectRoot(): string { return this.projectRootValue; }
  get revision(): string { return this.revisionValue; }
  get editVersion(): number { return this.editVersionValue; }
  get persistedVersion(): number { return this.persistedVersionValue; }
  get isDirty(): boolean { return this.editVersionValue > this.persistedVersionValue; }

  reset(projectRoot: string, key: string, revision: string, version = 0): void {
    this.projectRootValue = projectRoot;
    this.keyValue = key;
    this.revisionValue = revision;
    this.epoch += 1;
    this.editVersionValue = version;
    this.persistedVersionValue = version;
    this.phaseValue = "clean";
    this.savedAtValue = undefined;
    this.errorValue = undefined;
  }

  markEdited(version?: number): void {
    this.editVersionValue = version === undefined
      ? this.editVersionValue + 1
      : Math.max(this.editVersionValue + 1, version);
    this.phaseValue = "dirty";
    this.errorValue = undefined;
  }

  markClean(revision: string, version = this.editVersionValue): void {
    this.revisionValue = revision || this.revisionValue;
    this.editVersionValue = Math.max(this.editVersionValue, version);
    this.persistedVersionValue = this.editVersionValue;
    this.phaseValue = "clean";
    this.errorValue = undefined;
  }

  snapshot(value: T): DocumentSnapshot<T> {
    return {
      key: this.keyValue,
      projectRoot: this.projectRootValue,
      sessionEpoch: this.epoch,
      editVersion: this.editVersionValue,
      baseRevision: this.revisionValue,
      value,
    };
  }

  markQueued(): void {
    if (this.phaseValue !== "saving") this.phaseValue = "queued";
  }

  markSaving(snapshot: DocumentSnapshot<T>): boolean {
    if (!this.matches(snapshot)) return false;
    this.phaseValue = "saving";
    this.errorValue = undefined;
    return true;
  }

  acknowledge(snapshot: DocumentSnapshot<T>, revision: string, now: number): boolean {
    if (!this.matches(snapshot)) return false;
    this.revisionValue = revision;
    this.persistedVersionValue = Math.max(this.persistedVersionValue, snapshot.editVersion);
    this.savedAtValue = now;
    this.errorValue = undefined;
    this.phaseValue = this.isDirty ? "dirty" : "clean";
    return true;
  }

  fail(snapshot: DocumentSnapshot<T>, failure: SaveFailure): boolean {
    if (!this.matches(snapshot)) return false;
    this.errorValue = failure.message;
    this.phaseValue = failure.kind === "conflict" ? "conflict" : "error";
    return true;
  }

  state(): SaveState {
    return {
      key: this.keyValue,
      phase: this.phaseValue,
      editVersion: this.editVersionValue,
      persistedVersion: this.persistedVersionValue,
      hasPendingChanges: this.isDirty,
      savedAt: this.savedAtValue,
      error: this.errorValue,
    };
  }

  private matches(snapshot: DocumentSnapshot<T>): boolean {
    return snapshot.sessionEpoch === this.epoch
      && snapshot.key === this.keyValue
      && snapshot.projectRoot === this.projectRootValue;
  }
}

export type SaveClock = {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
};

const browserClock: SaveClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

export type AutosavePolicyOptions = {
  debounceMs?: number;
  maxWaitMs?: number;
  retryDelaysMs?: number[];
};

export class AutosavePolicy {
  readonly debounceMs: number;
  readonly maxWaitMs: number;
  readonly retryDelaysMs: number[];

  constructor(options: AutosavePolicyOptions = {}) {
    this.debounceMs = options.debounceMs ?? 1_500;
    this.maxWaitMs = options.maxWaitMs ?? 5_000;
    this.retryDelaysMs = options.retryDelaysMs ?? [1_000, 2_000, 5_000, 15_000];
  }

  retryDelay(attempt: number): number {
    return this.retryDelaysMs[Math.min(attempt, this.retryDelaysMs.length - 1)] ?? 15_000;
  }
}

type SaveTarget<T, Result extends SaveCommitResult> = {
  projectRoot: string;
  documentKey: string;
  revision: string;
  read(): T | null;
  commit(snapshot: DocumentSnapshot<T>): Promise<Result>;
  onCommitted?(result: Result, completion: SaveCompletion<T>): void;
  onState?(state: SaveState): void;
};

type ErasedTarget = SaveTarget<unknown, SaveCommitResult>;

type Entry = {
  slot: string;
  target: ErasedTarget;
  session: DocumentSession<unknown>;
  idleTimer?: unknown;
  maxTimer?: unknown;
  retryTimer?: unknown;
  inFlight: boolean;
  pendingLatest: boolean;
  retryAttempt: number;
};

export type SaveRegistration<T, Result extends SaveCommitResult> = {
  update(target: SaveTarget<T, Result>): void;
  reset(projectRoot: string, documentKey: string, revision: string, version?: number): void;
  markEdited(version?: number): void;
  reconcile(dirty: boolean, version: number, revision: string): void;
  flush(): Promise<void>;
  activate(): void;
  state(): SaveState;
  dispose(): void;
};

export class SaveCoordinator {
  private entries = new Map<string, Entry>();
  private projectTails = new Map<string, Promise<void>>();
  private activeSlot: string | undefined;

  constructor(
    private readonly policy = new AutosavePolicy(),
    private readonly clock: SaveClock = browserClock,
  ) {}

  register<T, Result extends SaveCommitResult>(slot: string, target: SaveTarget<T, Result>): SaveRegistration<T, Result> {
    this.unregister(slot);
    const erased = target as unknown as ErasedTarget;
    const entry: Entry = {
      slot,
      target: erased,
      session: new DocumentSession<unknown>(target.projectRoot, target.documentKey, target.revision),
      inFlight: false,
      pendingLatest: false,
      retryAttempt: 0,
    };
    this.entries.set(slot, entry);
    return {
      update: (next) => { entry.target = next as unknown as ErasedTarget; },
      reset: (projectRoot, documentKey, revision, version = 0) => {
        this.clearTimers(entry);
        entry.pendingLatest = false;
        entry.retryAttempt = 0;
        entry.session.reset(projectRoot, documentKey, revision, version);
        this.emit(entry);
      },
      markEdited: (version) => this.markEdited(entry, version),
      reconcile: (dirty, version, revision) => this.reconcile(entry, dirty, version, revision),
      flush: () => this.flushEntry(entry, true),
      activate: () => { this.activeSlot = slot; },
      state: () => entry.session.state(),
      dispose: () => this.unregister(slot, entry),
    };
  }

  async flushActive(): Promise<void> {
    const entry = this.activeSlot ? this.entries.get(this.activeSlot) : undefined;
    if (entry) await this.flushEntry(entry, true);
  }

  hasPending(scope?: string): boolean {
    return [...this.entries.values()].some((entry) =>
      (!scope || entry.slot === scope || entry.target.projectRoot === scope)
      && (entry.inFlight || entry.session.isDirty));
  }

  async barrier(scope?: string): Promise<void> {
    const targets = [...this.entries.values()].filter((entry) =>
      !scope || entry.slot === scope || entry.target.projectRoot === scope);
    while (targets.some((entry) => entry.inFlight || entry.session.isDirty)) {
      await Promise.all(targets.map((entry) => this.flushEntry(entry, true)));
      const tails = [...new Set(targets.map((entry) => this.projectTails.get(entry.target.projectRoot)).filter(Boolean))] as Promise<void>[];
      await Promise.all(tails);
      const failed = targets.find((entry) => {
        const phase = entry.session.state().phase;
        return entry.session.isDirty && (phase === "error" || phase === "conflict");
      });
      if (failed) {
        const state = failed.session.state();
        throw new SaveFailure(state.error || "저장 barrier를 완료하지 못했습니다.", state.phase === "conflict" ? "conflict" : "validation");
      }
    }
  }

  private markEdited(entry: Entry, version?: number): void {
    entry.session.markEdited(version);
    entry.pendingLatest ||= entry.inFlight;
    entry.retryAttempt = 0;
    this.clearTimer(entry, "retryTimer");
    this.schedule(entry);
    this.emit(entry);
  }

  private reconcile(entry: Entry, dirty: boolean, version: number, revision: string): void {
    if (dirty) {
      if (version > entry.session.editVersion || !entry.session.isDirty) this.markEdited(entry, version);
      return;
    }
    if (entry.inFlight) {
      if (version > entry.session.editVersion) this.markEdited(entry, version);
      entry.pendingLatest = entry.session.isDirty;
      return;
    }
    this.clearTimers(entry);
    entry.pendingLatest = false;
    entry.session.markClean(revision, version);
    this.emit(entry);
  }

  private schedule(entry: Entry): void {
    this.clearTimer(entry, "idleTimer");
    entry.idleTimer = this.clock.setTimeout(() => {
      entry.idleTimer = undefined;
      void this.flushEntry(entry, false);
    }, this.policy.debounceMs);
    if (entry.maxTimer === undefined) {
      entry.maxTimer = this.clock.setTimeout(() => {
        entry.maxTimer = undefined;
        void this.flushEntry(entry, false);
      }, this.policy.maxWaitMs);
    }
  }

  private async flushEntry(entry: Entry, manual: boolean): Promise<void> {
    if (!entry.session.isDirty) return;
    this.clearTimer(entry, "idleTimer");
    this.clearTimer(entry, "maxTimer");
    if (entry.inFlight) {
      entry.pendingLatest = true;
      this.emit(entry);
      return;
    }
    entry.inFlight = true;
    entry.session.markQueued();
    this.emit(entry);

    const task = async () => {
      const target = entry.target;
      const value = target.read();
      if (value === null || !entry.session.isDirty) return;
      const snapshot = entry.session.snapshot(value);
      entry.pendingLatest = false;
      if (!entry.session.markSaving(snapshot)) return;
      this.emit(entry);
      try {
        const result = await target.commit(snapshot);
        const accepted = entry.session.acknowledge(snapshot, result.revision, this.clock.now());
        if (accepted) entry.retryAttempt = 0;
        const state = entry.session.state();
        target.onCommitted?.(result, { snapshot, isLatest: accepted && !state.hasPendingChanges, state });
      } catch (error) {
        const failure = error instanceof SaveFailure ? error : new SaveFailure(String(error));
        entry.session.fail(snapshot, failure);
        if (failure.kind === "transient") this.scheduleRetry(entry);
      } finally {
        entry.inFlight = false;
        this.emit(entry);
        if (entry.pendingLatest || entry.session.isDirty && entry.session.state().phase !== "error" && entry.session.state().phase !== "conflict") {
          entry.pendingLatest = false;
          if (manual) void this.flushEntry(entry, true);
          else this.schedule(entry);
        }
      }
    };

    const tail = (this.projectTails.get(entry.target.projectRoot) ?? Promise.resolve())
      .catch(() => undefined)
      .then(task);
    this.projectTails.set(entry.target.projectRoot, tail);
    try {
      await tail;
    } finally {
      if (this.projectTails.get(entry.target.projectRoot) === tail) this.projectTails.delete(entry.target.projectRoot);
    }
  }

  private scheduleRetry(entry: Entry): void {
    this.clearTimer(entry, "retryTimer");
    const delay = this.policy.retryDelay(entry.retryAttempt);
    entry.retryAttempt += 1;
    entry.retryTimer = this.clock.setTimeout(() => {
      entry.retryTimer = undefined;
      if (entry.session.isDirty) void this.flushEntry(entry, false);
    }, delay);
  }

  private emit(entry: Entry): void {
    entry.target.onState?.(entry.session.state());
  }

  private unregister(slot: string, expected?: Entry): void {
    const entry = this.entries.get(slot);
    if (!entry || expected && entry !== expected) return;
    this.clearTimers(entry);
    this.entries.delete(slot);
    if (this.activeSlot === slot) this.activeSlot = undefined;
  }

  private clearTimers(entry: Entry): void {
    this.clearTimer(entry, "idleTimer");
    this.clearTimer(entry, "maxTimer");
    this.clearTimer(entry, "retryTimer");
  }

  private clearTimer(entry: Entry, key: "idleTimer" | "maxTimer" | "retryTimer"): void {
    const handle = entry[key];
    if (handle !== undefined) this.clock.clearTimeout(handle);
    entry[key] = undefined;
  }
}

export const editorSaveCoordinator = new SaveCoordinator();
