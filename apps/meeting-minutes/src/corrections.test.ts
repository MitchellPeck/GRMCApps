import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renamedVoices, replaceInActionItems, replaceInSegments, replaceMany, replaceWords } from "./corrections";

test("replaceWords matches whole words only, keeps possessives and punctuation", () => {
  assert.deepEqual(replaceWords("John met Johnson. John's car, john.", "John", "Jon"),
    { text: "Jon met Johnson. Jon's car, john.", count: 2 });
});

test("replaceWords inserts the replacement literally", () => {
  assert.deepEqual(replaceWords("cost: X", "X", "$5 & $1"), { text: "cost: $5 & $1", count: 1 });
  assert.deepEqual(replaceWords("a.b a b", "a.b", "c"), { text: "c a b", count: 1 });
});

test("replaceWords handles multi-word names and non-Latin text", () => {
  assert.equal(replaceWords("Pastor Jon Hale spoke", "Jon Hale", "John Hale").text, "Pastor John Hale spoke");
  assert.equal(replaceWords("예배 위원회", "예배", "X").count, 1);
  assert.deepEqual(replaceWords("anything", "", "x"), { text: "anything", count: 0 });
});

test("segments and action items report how many places changed", () => {
  const s = replaceInSegments([{ text: "John said", speaker: "S0", start: 0, end: 1 }, { text: "ok", speaker: "S1", start: 1, end: 2 }], "John", "Jon");
  assert.equal(s.count, 1);
  assert.equal(s.segments[0].text, "Jon said");
  const a = replaceInActionItems([{ task: "Call John", owner: "John", start: 1, end: 2 }], "John", "Jon", ["owner"]);
  assert.deepEqual(a, { items: [{ task: "Call John", owner: "Jon", start: 1, end: 2 }], count: 1 });
  assert.equal(replaceInActionItems([{ task: "Call John", owner: "John" }], "John", "Jon").count, 2);
});

test("renamedVoices pairs old and new display names, skipping names still in use", () => {
  assert.deepEqual(renamedVoices({ S0: "John" }, { S0: "Jon" }, ["S0"]), [{ from: "John", to: "Jon" }]);
  assert.deepEqual(renamedVoices({}, { S1: "Linda" }, ["S0", "S1"]), [{ from: "Speaker 2", to: "Linda" }]);
  assert.deepEqual(renamedVoices({ S0: "John", S1: "John" }, { S0: "Linda", S1: "John" }, ["S0", "S1"]), []);
  assert.deepEqual(renamedVoices({ S0: "A", S1: "A" }, { S0: "B", S1: "B" }, ["S0", "S1"]), [{ from: "A", to: "B" }]);
  assert.deepEqual(renamedVoices({ S0: "A" }, { S0: "A" }, ["S0"]), []);
});

test("replaceMany applies several renames at once, so two names can swap", () => {
  assert.deepEqual(replaceMany("Ann thanked Bob.", [{ from: "Ann", to: "Bob" }, { from: "Bob", to: "Ann" }]),
    { text: "Bob thanked Ann.", count: 2 });
  assert.deepEqual(replaceMany("Speaker 1 and Speaker 10", [{ from: "Speaker 1", to: "Linda" }]),
    { text: "Linda and Speaker 10", count: 1 });
});

test("a straight apostrophe matches a curly one and the other way round", () => {
  assert.deepEqual(replaceWords("Thanks, O’Brien.", "O'Brien", "O'Bryan"), { text: "Thanks, O'Bryan.", count: 1 });
  assert.equal(replaceWords("O'Brien", "O’Brien", "X").count, 1);
});
