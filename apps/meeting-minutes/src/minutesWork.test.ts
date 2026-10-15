import { strict as assert } from "node:assert";
import { test } from "node:test";
import { reportReadiness } from "./minutesWork";

type It = Parameters<typeof reportReadiness>[1][number];
function item(over: Partial<It> = {}): It {
  return {
    id: 1, title: "Budget", transcript: "Alice: hi", notes: "", summary: "Done.",
    transcribe_status: "done", summarize_status: "idle", ...over,
  };
}
const idle = { recording_status: "done" as const };

test("reportReadiness is ready when every item with content has a summary", () => {
  assert.deepEqual(reportReadiness(idle, [item(), item({ id: 2, transcript: "", summary: "" })]), { kind: "ready" });
});

test("reportReadiness waits for transcription and for the meeting recording", () => {
  assert.deepEqual(reportReadiness(idle, [item({ transcribe_status: "processing" })]), { kind: "wait" });
  assert.deepEqual(reportReadiness({ recording_status: "queued" }, [item()]), { kind: "wait" });
});

test("reportReadiness asks for missing summaries and waits on queued ones", () => {
  assert.deepEqual(reportReadiness(idle, [item({ summary: "" })]), { kind: "summarize", itemIds: [1] });
  assert.deepEqual(reportReadiness(idle, [item({ summary: "", summarize_status: "queued" })]), { kind: "wait" });
});

test("reportReadiness gives up on a failed summary, naming the item", () => {
  assert.deepEqual(
    reportReadiness(idle, [item({ summary: "", summarize_status: "error" })]),
    { kind: "failed", titles: ["Budget"] }
  );
});
