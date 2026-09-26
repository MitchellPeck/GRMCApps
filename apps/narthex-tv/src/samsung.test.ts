import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_CONNECT, EVENT_UNAUTHORIZED, NO_SAMSUNG, encodeName, pair,
  readEvent, remoteKeyPayload, sendKey, validateHost, websocketUrl,
  SamsungDeps, SamsungSocket,
} from "./samsung";

/** A television, as far as this code can tell. */
class FakeTv implements SamsungSocket {
  sent: string[] = [];
  closed = false;
  private message: (raw: string) => void = () => {};
  private error: (e: Error) => void = () => {};
  private closeHandler: () => void = () => {};

  send(text: string) { this.sent.push(text); }
  close() { this.closed = true; }
  onMessage(h: (raw: string) => void) { this.message = h; }
  onError(h: (e: Error) => void) { this.error = h; }
  onClose(h: () => void) { this.closeHandler = h; }

  says(event: string, data: Record<string, unknown> = {}) {
    this.message(JSON.stringify({ event, data }));
  }
  fails(message: string) { this.error(new Error(message)); }
  hangsUp() { this.closeHandler(); }
}

function harness() {
  const tv = new FakeTv();
  const urls: string[] = [];
  let fire: (() => void) | null = null;
  const deps: SamsungDeps = {
    open(url) { urls.push(url); return tv; },
    setTimer(fn) { fire = fn; return { cancel() { fire = null; } }; },
  };
  return { tv, urls, deps, expire: () => fire?.() };
}

test("the pairing URL carries the name and no token", () => {
  const url = new URL(websocketUrl("192.168.1.50", "Narthex TV"));
  assert.equal(url.protocol, "wss:");
  assert.equal(url.port, "8002");
  assert.equal(url.pathname, "/api/v2/channels/samsung.remote.control");
  // The name is what appears on the television's prompt.
  assert.equal(Buffer.from(url.searchParams.get("name")!, "base64").toString(), "Narthex TV");
  // No token is the point: with one, the set never raises the prompt.
  assert.equal(url.searchParams.get("token"), null);
});

test("a paired connection sends the token", () => {
  const url = new URL(websocketUrl("192.168.1.50", "Narthex TV", "12345678"));
  assert.equal(url.searchParams.get("token"), "12345678");
});

test("the host must be a bare address, never a URL", () => {
  // This value is interpolated into the WebSocket URL, so anything carrying a
  // scheme, port, path or credentials would point the session elsewhere.
  for (const bad of ["http://1.2.3.4", "1.2.3.4:8002", "1.2.3.4/evil",
                     "user:pass@1.2.3.4", "1.2.3.4 ok", ""]) {
    assert.equal(validateHost(bad).ok, false, bad);
  }
  assert.deepEqual(validateHost(" 192.168.1.50 "), { ok: true, host: "192.168.1.50" });
  assert.deepEqual(validateHost("tv.local"), { ok: true, host: "tv.local" });
});

test("encodeName falls back rather than sending an empty prompt", () => {
  assert.equal(Buffer.from(encodeName(""), "base64").toString(), NO_SAMSUNG.name);
});

test("the key payload is the shape the v2 API wants", () => {
  assert.deepEqual(JSON.parse(remoteKeyPayload("KEY_POWER")), {
    method: "ms.remote.control",
    params: { Cmd: "Click", DataOfCmd: "KEY_POWER", Option: "false", TypeOfRemote: "SendRemoteKey" },
  });
});

test("readEvent never throws on rubbish", () => {
  assert.deepEqual(readEvent("not json"), { event: "", token: "", message: "" });
  assert.equal(readEvent(JSON.stringify({ event: EVENT_CONNECT, data: { token: "abc" } })).token, "abc");
});

test("pressing Allow yields the token", async () => {
  const h = harness();
  const outcome = pair("192.168.1.50", "Narthex TV", h.deps);
  h.tv.says(EVENT_CONNECT, { token: "58527546" });
  assert.deepEqual(await outcome, { ok: true, token: "58527546" });
  assert.ok(h.tv.closed, "the session should not be left open after pairing");
});

test("pressing Deny is reported as a denial, not a timeout", async () => {
  // They need different advice: one is "press Allow", the other is "check the
  // address". Collapsing them into one message sends people the wrong way.
  const h = harness();
  const outcome = pair("192.168.1.50", "Narthex TV", h.deps);
  h.tv.says(EVENT_UNAUTHORIZED);
  const result = await outcome;
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.denied, true);
});

test("a prompt nobody answers times out with something to act on", async () => {
  const h = harness();
  const outcome = pair("192.168.1.50", "Narthex TV", h.deps);
  h.expire();
  const result = await outcome;
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /switched on/);
});

test("a connection with no token is not mistaken for success", async () => {
  // A set that still remembers this name answers at once and sends nothing.
  // Storing "" would look paired and fail at the first keypress.
  const h = harness();
  const outcome = pair("192.168.1.50", "Narthex TV", h.deps);
  h.tv.says(EVENT_CONNECT, {});
  const result = await outcome;
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /Device List/);
});

test("a set that hangs up says so rather than hanging", async () => {
  const h = harness();
  const outcome = pair("192.168.1.50", "Narthex TV", h.deps);
  h.tv.hangsUp();
  assert.equal((await outcome).ok, false);
});

test("sending a key waits for the connection first", async () => {
  const config = { ...NO_SAMSUNG, host: "192.168.1.50", token: "abc" };
  const h = harness();
  const outcome = sendKey(config, "KEY_POWER", h.deps);
  // Nothing may be sent before the set has accepted the token.
  assert.deepEqual(h.tv.sent, []);
  h.tv.says(EVENT_CONNECT);
  const result = await outcome;
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(h.tv.sent[0]).params.DataOfCmd, "KEY_POWER");
  assert.ok(new URL(h.urls[0]).searchParams.get("token"), "must present the stored token");
});

test("an unpaired television is refused before anything is opened", async () => {
  const h = harness();
  const result = await sendKey({ ...NO_SAMSUNG, host: "192.168.1.50" }, "KEY_POWER", h.deps);
  assert.equal(result.ok, false);
  assert.deepEqual(h.urls, [], "should not dial a set it cannot talk to");
});

test("a rejected token says to pair again", async () => {
  const config = { ...NO_SAMSUNG, host: "192.168.1.50", token: "stale" };
  const h = harness();
  const outcome = sendKey(config, "KEY_POWER", h.deps);
  h.tv.says(EVENT_UNAUTHORIZED);
  const result = await outcome;
  assert.equal(result.ok, false);
  assert.match(result.detail, /[Pp]air it again/);
});

test("no answer reads as already off, which is what it usually is", async () => {
  // A Samsung stops answering on 8002 the moment it is off, so a timeout on
  // KEY_POWER is the normal case and must not read as a fault.
  const config = { ...NO_SAMSUNG, host: "192.168.1.50", token: "abc" };
  const h = harness();
  const outcome = sendKey(config, "KEY_POWER", h.deps);
  h.expire();
  const result = await outcome;
  assert.equal(result.ok, false);
  assert.match(result.detail, /already off/);
});
