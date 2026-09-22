import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ActionDeps, magicPacket, NO_ACTION, parseAction, PowerAction, runAction, serializeAction,
} from "./power-actions";

function deps(over: Partial<ActionDeps> = {}) {
  const sent: Array<{ target: string; packet: Buffer }> = [];
  const requests: PowerAction[] = [];
  const base: ActionDeps = {
    async request(action) { requests.push(action); return { status: 200 }; },
    async wake(packet, target) { sent.push({ packet, target }); },
  };
  return { deps: { ...base, ...over }, sent, requests };
}

test("no configuration is a valid, silent action", async () => {
  assert.deepEqual(parseAction(""), { ok: true, action: NO_ACTION });
  assert.deepEqual(parseAction(null), { ok: true, action: NO_ACTION });
  const r = await runAction(NO_ACTION, deps().deps);
  assert.equal(r.ok, true);
});

test("an HTTP action round-trips through storage", () => {
  const parsed = parseAction({
    kind: "http", method: "post", url: "http://10.0.0.5:8060/keypress/PowerOff",
    headers: { "x-k": "v" }, body: "",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.action.kind, "http");
  const again = parseAction(serializeAction(parsed.action));
  assert.deepEqual(again, parsed);
});

test("only http and https are ever dialled", () => {
  for (const url of ["file:///etc/passwd", "ftp://x/y", "not a url", ""]) {
    const r = parseAction({ kind: "http", url });
    assert.equal(r.ok, false, url);
  }
  assert.equal(parseAction({ kind: "http", url: "https://tv.local/off" }).ok, true);
});

test("a method we would not send is refused", () => {
  assert.equal(parseAction({ kind: "http", url: "http://x/y", method: "TRACE" }).ok, false);
  assert.equal(parseAction({ kind: "http", url: "http://x/y", method: "get" }).ok, true);
});

test("an HTTP action reports the status it got back", async () => {
  const parsed = parseAction({ kind: "http", url: "http://tv/off", method: "POST" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const good = await runAction(parsed.action, deps().deps);
  assert.equal(good.ok, true);
  assert.match(good.detail, /200/);

  const bad = await runAction(parsed.action, deps({ async request() { return { status: 500 }; } }).deps);
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /500/);
});

test("a TV that does not answer fails the action rather than throwing", async () => {
  const parsed = parseAction({ kind: "http", url: "http://tv/off" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const r = await runAction(
    parsed.action,
    deps({ async request() { throw new Error("connect ECONNREFUSED"); } }).deps
  );
  assert.equal(r.ok, false);
  assert.match(r.detail, /ECONNREFUSED/);
});

test("a magic packet is 6 bytes of 0xFF then the MAC sixteen times", () => {
  const packet = magicPacket("AA:BB:CC:DD:EE:FF");
  assert.equal(packet.length, 102);
  assert.deepEqual([...packet.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
  for (let i = 0; i < 16; i++) {
    assert.deepEqual(
      [...packet.subarray(6 + i * 6, 12 + i * 6)],
      [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff],
      `repeat ${i}`
    );
  }
});

test("MAC addresses are accepted in the forms people paste", () => {
  for (const mac of ["aa:bb:cc:dd:ee:ff", "AA-BB-CC-DD-EE-FF", "aabbccddeeff"]) {
    assert.equal(parseAction({ kind: "wol", mac }).ok, true, mac);
  }
  for (const mac of ["aa:bb:cc:dd:ee", "zz:bb:cc:dd:ee:ff", "", "aa:bb-cc:dd:ee:ff"]) {
    assert.equal(parseAction({ kind: "wol", mac }).ok, false, mac);
  }
});

test("wake-on-LAN goes to the TV's own address when one is given", async () => {
  const parsed = parseAction({ kind: "wol", mac: "aa:bb:cc:dd:ee:ff", ip: "10.0.0.5" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const d = deps();
  const r = await runAction(parsed.action, d.deps);
  assert.equal(r.ok, true);
  assert.equal(d.sent[0].target, "10.0.0.5");
  assert.equal(d.sent[0].packet.length, 102);
});

test("wake-on-LAN falls back to broadcast with no address", async () => {
  const parsed = parseAction({ kind: "wol", mac: "aa:bb:cc:dd:ee:ff" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const d = deps();
  await runAction(parsed.action, d.deps);
  assert.equal(d.sent[0].target, "255.255.255.255");
});

test("junk in the settings row is reported, not thrown", () => {
  assert.equal(parseAction("{not json").ok, false);
  assert.equal(parseAction({ kind: "teleport" }).ok, false);
  assert.equal(parseAction(42).ok, false);
});
