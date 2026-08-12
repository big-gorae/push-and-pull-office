import { describe, expect, it } from "vitest";
import { IndexedDbDraftJournal } from "../editorDraftJournal";

describe("IndexedDbDraftJournal", () => {
  it("keeps an asynchronous recovery record when IndexedDB is unavailable", async () => {
    const journal = new IndexedDbDraftJournal();
    await journal.write({
      key: "scene:intro",
      projectRoot: "/project",
      baseRevision: "r1",
      editVersion: 3,
      value: { title: "draft" },
      updatedAt: 100,
    });
    await expect(journal.read<{ title: string }>("scene:intro")).resolves.toMatchObject({
      baseRevision: "r1",
      editVersion: 3,
      value: { title: "draft" },
    });
    await journal.remove("scene:intro");
    await expect(journal.read("scene:intro")).resolves.toBeUndefined();
  });
});
