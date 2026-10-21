// The chat loop with a scripted model standing in for Claude, against the test
// database (the tools are real). Like lockRoutes.test.ts, point the app's pool
// at TEST_DATABASE_URL before anything imports db.ts.
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { config } from "./config";

const url = process.env.TEST_DATABASE_URL;
if (url) config.databaseUrl = url;

let pool: any = null, chat: any = null, store: any = null;
async function setup(): Promise<number> {
  if (!pool) {
    ({ pool } = await import("./db"));
    chat = await import("./chat");
    store = await import("./chatStore");
  }
  await pool.query("DELETE FROM meetings");
  return Number((await pool.query(
    "INSERT INTO meetings (title, report, report_generated_at, report_updated_at) VALUES ('Board', $1, now(), now()) RETURNING id",
    ["# Board\n\n## Summary\nJohn reported."])).rows[0].id);
}
after(async () => { if (pool) await pool.end(); });
const who = { email: "a@x", name: "Ann" };

// A model that answers from a script and records every request it gets.
function scripted(replies: any[]) {
  const calls: any[] = [];
  return {
    calls,
    model: {
      create: async (params: any) => {
        calls.push(JSON.parse(JSON.stringify(params)));
        const r = replies.length > 1 ? replies.shift() : replies[0];
        if (r instanceof Error) throw r;
        return { id: "msg", type: "message", role: "assistant", model: params.model, stop_reason: r.stop_reason ?? "end_turn",
          content: r.content, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
}
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const text = (t: string) => ({ type: "text", text: t });

test("a tool turn then an answer: tool results go back together, the reply and cards come out", { skip: !url }, async () => {
  const mid = await setup();
  const s = scripted([
    { stop_reason: "tool_use", content: [{ type: "thinking", thinking: "", signature: "sig" }, toolUse("t1", "get_report", {}),
      toolUse("t2", "fix_words", { from: "John", to: "Jon", item_id: null })] },
    { content: [text("Fixed John → Jon in the minutes.")] },
  ]);
  const r = await chat.chatTurn(pool, mid, "It's Jon not John", who, s.model);
  assert.equal(r.reply, "Fixed John → Jon in the minutes.");
  assert.equal(r.cards.length, 1);
  assert.match(r.cards[0].summary, /“John” → “Jon”/);
  const second = s.calls[1];
  const lastUser = second.messages[second.messages.length - 1];
  assert.equal(lastUser.role, "user");
  assert.deepEqual(lastUser.content.map((b: any) => [b.type, b.tool_use_id]), [["tool_result", "t1"], ["tool_result", "t2"]]);
  // The request shape the chat always uses.
  assert.equal(s.calls[0].model, "claude-opus-5-5");
  assert.deepEqual(s.calls[0].output_config, { effort: "medium" });
  assert.equal(s.calls[0].fallbacks, "default");
  assert.deepEqual(s.calls[0].betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(s.calls[0].thinking, undefined);
  assert.equal(s.calls[0].tool_choice, undefined);
  const h = await store.loadChatHistory(pool, mid);
  assert.deepEqual(h.map((x: any) => x.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(h[1].content[0], { type: "thinking", thinking: "", signature: "sig" }, "stored as returned");
});

test("the next message replays the history exactly, appended to", { skip: !url }, async () => {
  const mid = await setup();
  const s = scripted([{ content: [text("Hello.")] }]);
  await chat.chatTurn(pool, mid, "Hi", who, s.model);
  await chat.chatTurn(pool, mid, "Again", who, s.model);
  const msgs = s.calls[1].messages;
  assert.deepEqual(msgs.slice(0, 2), [
    { role: "user", content: [{ type: "text", text: "Hi" }] },
    { role: "assistant", content: [{ type: "text", text: "Hello." }] },
  ]);
  assert.deepEqual(msgs[2], { role: "user", content: [{ type: "text", text: "Again" }] });
});

test("a model that never stops is cut off cleanly after 12 calls", { skip: !url }, async () => {
  const mid = await setup();
  const s = scripted([{ stop_reason: "tool_use", content: [toolUse("t", "get_report", {})] }]);
  const r = await chat.chatTurn(pool, mid, "Loop", who, s.model);
  assert.equal(s.calls.length, 12);
  assert.match(r.reply, /stopped/i);
  const h = await store.loadChatHistory(pool, mid);
  assert.equal(h[h.length - 1].role, "assistant");
  assert.equal(h[h.length - 2].role, "user", "every tool_use got its tool_result");
  assert.equal(h[h.length - 2].content[0].type, "tool_result");
});

test("a refusal says so", { skip: !url }, async () => {
  const mid = await setup();
  const s = scripted([{ stop_reason: "refusal", content: [] }]);
  const r = await chat.chatTurn(pool, mid, "Something", who, s.model);
  assert.equal(r.reply, "I can't help with that one.");
});

test("an API failure is reported and the history still ends cleanly", { skip: !url }, async () => {
  const mid = await setup();
  const s = scripted([{ stop_reason: "tool_use", content: [toolUse("t", "get_report", {})] }, new Error("overloaded")]);
  const r = await chat.chatTurn(pool, mid, "Do it", who, s.model);
  assert.match(r.reply, /couldn’t finish/i);
  const h = await store.loadChatHistory(pool, mid);
  assert.equal(h[h.length - 1].role, "assistant");
});

test("a bad tool input becomes an error result, not a crash", { skip: !url }, async () => {
  const mid = await setup();
  const s = scripted([
    { stop_reason: "tool_use", content: [toolUse("t", "edit_report", { edits: [{ line: 99, text: "x" }] })] },
    { content: [text("That line doesn't exist.")] },
  ]);
  await chat.chatTurn(pool, mid, "Edit line 99", who, s.model);
  const res = s.calls[1].messages[s.calls[1].messages.length - 1].content[0];
  assert.equal(res.is_error, true);
});

test("the display history shows people's words and the chat's answers, with cards", { skip: !url }, async () => {
  const mid = await setup();
  const s = scripted([
    { stop_reason: "tool_use", content: [text("Let me fix that."), toolUse("t1", "fix_words", { from: "John", to: "Jon", item_id: null })] },
    { content: [text("Done.")] },
  ]);
  await chat.chatTurn(pool, mid, "Jon not John", who, s.model);
  const d = await chat.chatDisplay(pool, mid);
  assert.deepEqual(d.map((x: any) => [x.role, x.text]), [["user", "Jon not John"], ["assistant", "Let me fix that.\n\nDone."]]);
  assert.equal(d[1].cards.length, 1);
});
