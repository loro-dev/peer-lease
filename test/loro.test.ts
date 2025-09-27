import { describe, expect, it } from "vitest";
import { tryReuseLoroPeerId } from "../src";
import { LoroDoc } from "loro-crdt";
const DOC_ID = "loro-doc";

describe("tryReuseLoroPeerId", () => {
  it("reuses a cached peer id when the loaded doc has advanced beyond the cached version", async () => {
    let id: string = "";
    {
      const doc = new LoroDoc();
      const release = await tryReuseLoroPeerId(DOC_ID, doc);
      id = doc.peerIdStr;
      await release();
    }
    {
      const doc = new LoroDoc();
      const release = await tryReuseLoroPeerId(DOC_ID, doc);
      expect(doc.peerIdStr).toBe(id);
      const releaseTask = release();
      expect(release.isReleased()).toBe(true);
      await releaseTask;
    }
  });
});
