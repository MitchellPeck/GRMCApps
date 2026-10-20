import { strict as assert } from "node:assert";
import { test } from "node:test";
import { gatherSendMedia } from "./metricool-media";

test("every image picked in the send box is prepared, in order", async () => {
  const calls: string[] = [];
  const deps = {
    approvedBytes: async (id: number) => { calls.push("approved:" + id); return { bytes: Buffer.from("x"), contentType: "image/png" }; },
    toR2: async (_b: Buffer, _t: string, seed: string) => { calls.push("r2:" + seed.split("-")[0]); return "https://r2/" + seed; },
    normalize: async (url: string) => { calls.push("norm:" + url.split("/")[2]); return "https://mc/" + url.split("/").pop(); },
  };
  const urls = await gatherSendMedia({ media: [{ approvedImageId: "11" }, { imageUrl: "https://media.example/media/a.jpg" }] }, deps);
  assert.equal(urls.length, 2);
  assert.deepEqual(calls, ["approved:11", "r2:11", "norm:r2", "norm:media.example"]);
});

test("the old single-image fields still work", async () => {
  const deps = { approvedBytes: async () => ({ bytes: Buffer.from(""), contentType: "" }), toR2: async () => "", normalize: async (u: string) => "N:" + u };
  assert.deepEqual(await gatherSendMedia({ imageUrl: " https://x/y.jpg " }, deps), ["N:https://x/y.jpg"]);
  assert.deepEqual(await gatherSendMedia({}, deps), []);
});
