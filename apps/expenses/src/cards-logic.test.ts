import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Card, cardLabel, visibleCardsFor } from "./cards-logic";

const cards: Card[] = [
  { id: 1, last4: "0357", nickname: "Ministry Visa", primary_email: "mitchell.peck@graceresurrection.org", active: true, additional: ["taylor@grmc.app"] },
  { id: 2, last4: "1199", nickname: "Facilities", primary_email: "taylor@grmc.app", active: true, additional: [] },
  { id: 3, last4: "8888", nickname: "Retired", primary_email: "mitchell.peck@graceresurrection.org", active: false, additional: [] },
];

test("the primary holder sees their card", () => {
  assert.deepEqual(visibleCardsFor("mitchell.peck@graceresurrection.org", cards).map((c) => c.id), [1]);
});

test("an additional user sees the card too", () => {
  assert.deepEqual(visibleCardsFor("taylor@grmc.app", cards).map((c) => c.id), [1, 2]);
});

test("someone on no card sees none", () => {
  assert.deepEqual(visibleCardsFor("nobody@grmc.app", cards), []);
});

test("inactive cards are never offered", () => {
  assert.equal(visibleCardsFor("mitchell.peck@graceresurrection.org", cards).some((c) => c.id === 3), false);
});

test("email matching is case-insensitive", () => {
  assert.deepEqual(visibleCardsFor("TAYLOR@GRMC.APP", cards).map((c) => c.id), [1, 2]);
});

test("an empty email sees nothing rather than everything", () => {
  assert.deepEqual(visibleCardsFor("", cards), []);
});

test("cardLabel renders nickname and last four", () => {
  assert.equal(cardLabel(cards[0]), "Ministry Visa ••0357");
});
