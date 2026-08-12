import { describe, expect, it, vi } from "vitest";
import {
  AutosavePolicy,
  DocumentSession,
  SaveCoordinator,
  SaveFailure,
  type DocumentSnapshot,
  type SaveClock,
} from "../editorSave";

function fakeClock(): SaveClock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
  };
}

describe("DocumentSession", () => {
  it("acknowledges only the saved version and preserves newer edits", () => {
    const session = new DocumentSession<{ text: string }>("/project", "scene:intro", "r1");
    session.markEdited(1);
    const snapshot = session.snapshot({ text: "first" });
    session.markSaving(snapshot);
    session.markEdited(2);

    expect(session.acknowledge(snapshot, "r2", 100)).toBe(true);
    expect(session.state()).toMatchObject({
      phase: "dirty",
      editVersion: 2,
      persistedVersion: 1,
      hasPendingChanges: true,
      savedAt: 100,
    });
  });

  it("ignores a response from a previous document epoch", () => {
    const session = new DocumentSession<{ text: string }>("/project", "scene:a", "r1");
    session.markEdited(1);
    const stale = session.snapshot({ text: "a" });
    session.reset("/project", "scene:b", "r2");

    expect(session.acknowledge(stale, "r3", 100)).toBe(false);
    expect(session.state()).toMatchObject({ key: "scene:b", phase: "clean", persistedVersion: 0 });
  });
});

describe("SaveCoordinator", () => {
  it("uses debounce with a max-wait and coalesces continuous input", async () => {
    vi.useFakeTimers();
    const coordinator = new SaveCoordinator(new AutosavePolicy({ debounceMs: 1_500, maxWaitMs: 5_000 }), fakeClock());
    let value = "";
    let version = 0;
    const commits: Array<DocumentSnapshot<string>> = [];
    const registration = coordinator.register("scene", {
      projectRoot: "/project",
      documentKey: "scene:intro",
      revision: "r1",
      read: () => value,
      commit: async (snapshot) => {
        commits.push(snapshot);
        return { revision: `r${commits.length + 1}` };
      },
    });

    for (let second = 0; second < 5; second += 1) {
      value += String(second);
      version += 1;
      registration.markEdited(version);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(commits).toHaveLength(1);
    expect(commits[0].value).toBe("01234");
    registration.dispose();
    vi.useRealTimers();
  });

  it("keeps edits made during an in-flight save and immediately saves the latest snapshot", async () => {
    vi.useFakeTimers();
    const coordinator = new SaveCoordinator(new AutosavePolicy({ debounceMs: 10, maxWaitMs: 100 }), fakeClock());
    let value = "v1";
    let releaseFirst: (() => void) | undefined;
    const commits: string[] = [];
    const registration = coordinator.register("scene", {
      projectRoot: "/project",
      documentKey: "scene:intro",
      revision: "r1",
      read: () => value,
      commit: async (snapshot) => {
        commits.push(snapshot.value);
        if (commits.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return { revision: `r${commits.length + 1}` };
      },
    });

    registration.markEdited(1);
    await vi.advanceTimersByTimeAsync(10);
    value = "v2";
    registration.markEdited(2);
    releaseFirst?.();
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(commits).toEqual(["v1", "v2"]);
    expect(registration.state()).toMatchObject({ phase: "clean", editVersion: 2, persistedVersion: 2 });
    registration.dispose();
    vi.useRealTimers();
  });

  it("coalesces one hundred edits made during a save into one latest follow-up", async () => {
    vi.useFakeTimers();
    const coordinator = new SaveCoordinator(new AutosavePolicy({ debounceMs: 10, maxWaitMs: 100 }), fakeClock());
    let value = "v0";
    let releaseFirst: (() => void) | undefined;
    const commits: string[] = [];
    const registration = coordinator.register("scene", {
      projectRoot: "/project",
      documentKey: "scene:intro",
      revision: "r1",
      read: () => value,
      commit: async (snapshot) => {
        commits.push(snapshot.value);
        if (commits.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return { revision: `r${commits.length + 1}` };
      },
    });

    registration.markEdited(1);
    await vi.advanceTimersByTimeAsync(10);
    for (let version = 2; version <= 101; version += 1) {
      value = `v${version}`;
      registration.markEdited(version);
    }
    releaseFirst?.();
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(commits).toEqual(["v0", "v101"]);
    expect(registration.state()).toMatchObject({ phase: "clean", persistedVersion: 101 });
    registration.dispose();
    vi.useRealTimers();
  });

  it("serializes commits from different documents in the same project", async () => {
    const coordinator = new SaveCoordinator(new AutosavePolicy(), fakeClock());
    let concurrent = 0;
    let maxConcurrent = 0;
    let releaseFirst: (() => void) | undefined;
    const order: string[] = [];
    const register = (slot: string) => coordinator.register(slot, {
      projectRoot: "/project",
      documentKey: slot,
      revision: "r1",
      read: () => slot,
      commit: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(slot);
        if (slot === "a") await new Promise<void>((resolve) => { releaseFirst = resolve; });
        concurrent -= 1;
        return { revision: "r2" };
      },
    });
    const a = register("a");
    const b = register("b");
    a.markEdited(1);
    b.markEdited(1);
    const flushing = Promise.all([a.flush(), b.flush()]);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["a"]);
    releaseFirst?.();
    await flushing;

    expect(order).toEqual(["a", "b"]);
    expect(maxConcurrent).toBe(1);
    a.dispose();
    b.dispose();
  });

  it("pauses automatic retries on validation and conflict failures", async () => {
    vi.useFakeTimers();
    for (const kind of ["validation", "conflict"] as const) {
      const coordinator = new SaveCoordinator(new AutosavePolicy({ debounceMs: 10, maxWaitMs: 100 }), fakeClock());
      const commit = vi.fn(async () => { throw new SaveFailure(kind, kind); });
      const registration = coordinator.register(kind, {
        projectRoot: "/project",
        documentKey: `scene:${kind}`,
        revision: "r1",
        read: () => kind,
        commit,
      });
      registration.markEdited(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(registration.state().phase).toBe(kind === "conflict" ? "conflict" : "error");
      registration.dispose();
    }
    vi.useRealTimers();
  });
});
