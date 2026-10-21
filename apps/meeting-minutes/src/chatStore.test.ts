import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import { createMeeting } from "./meetings";
import { appendChat, loadChatHistory } from "./chatStore";

const url = process.env.TEST_DATABASE_URL;

test("chat history comes back exactly as it was stored, in order", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query("DELETE FROM meetings");
    const m = await createMeeting(pool, { title: "Chat", meetingDate: "", location: "", description: "", email: "", name: "" });
    assert.ok(m.ok);
    const assistant = [
      { type: "thinking", thinking: "", signature: "sig/abc==" },
      { type: "tool_use", id: "toolu_1", name: "get_meeting", input: { z: 1, a: [2, { y: "é" }] } },
    ];
    await appendChat(pool, m.id, "user", [{ type: "text", text: "Hi" }], [], "a@x");
    await appendChat(pool, m.id, "assistant", assistant, [{ kind: "change", summary: "x", changeId: 3 }]);
    const h = await loadChatHistory(pool, m.id);
    assert.deepEqual(h.map((r: any) => r.role), ["user", "assistant"]);
    assert.equal(JSON.stringify(h[1].content), JSON.stringify(assistant), "byte-identical, key order kept");
    assert.deepEqual(h[1].cards, [{ kind: "change", summary: "x", changeId: 3 }]);
  } finally { await pool.end(); }
});
