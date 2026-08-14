import { strict as assert } from "node:assert";
import { test } from "node:test";
import { segmentByMarkers, chronologicalSpeakerOrder } from "./segmentation";
import { DiarizedSegment } from "./whisper";

const seg = (text: string, speaker: string, start: number, end: number): DiarizedSegment =>
  ({ text, speaker, start, end });

test("segmentByMarkers windows segments by midpoint between markers", () => {
  const segments = [
    seg("intro", "SPEAKER_00", 0, 10),
    seg("budget one", "SPEAKER_00", 12, 20),
    seg("budget two", "SPEAKER_01", 20, 28),
    seg("missions", "SPEAKER_00", 32, 40),
  ];
  const out = segmentByMarkers(segments, [
    { itemId: 7, atSeconds: 2 },
    { itemId: 9, atSeconds: 30 },
  ], 99);
  assert.deepEqual([...out.keys()].sort(), [7, 9]);
  assert.deepEqual(out.get(7)!.map((s) => s.text), ["intro", "budget one", "budget two"]);
  assert.deepEqual(out.get(9)!.map((s) => s.text), ["missions"]);
});

test("segmentByMarkers sends pre-first-marker audio to the first marker's topic", () => {
  const segments = [seg("early", "SPEAKER_00", 0, 4), seg("later", "SPEAKER_00", 60, 70)];
  const out = segmentByMarkers(segments, [{ itemId: 5, atSeconds: 50 }], 99);
  assert.deepEqual(out.get(5)!.map((s) => s.text), ["early", "later"]);
});

test("segmentByMarkers with no markers sends everything to the fallback item", () => {
  const segments = [seg("a", "SPEAKER_00", 0, 5)];
  const out = segmentByMarkers(segments, [], 42);
  assert.deepEqual(out.get(42)!.map((s) => s.text), ["a"]);
  assert.deepEqual(segmentByMarkers([], [], 42).size, 0);
});

test("segmentByMarkers concatenates windows when a topic is revisited", () => {
  const segments = [
    seg("first visit", "SPEAKER_00", 0, 8),
    seg("interlude", "SPEAKER_01", 12, 18),
    seg("second visit", "SPEAKER_00", 22, 30),
  ];
  const out = segmentByMarkers(segments, [
    { itemId: 1, atSeconds: 0 },
    { itemId: 2, atSeconds: 10 },
    { itemId: 1, atSeconds: 20 },
  ], 99);
  assert.deepEqual(out.get(1)!.map((s) => s.text), ["first visit", "second visit"]);
  assert.deepEqual(out.get(2)!.map((s) => s.text), ["interlude"]);
});

test("segmentByMarkers boundary: a midpoint exactly on a marker belongs to that marker", () => {
  const segments = [seg("edge", "SPEAKER_00", 8, 12)]; // midpoint 10
  const out = segmentByMarkers(segments, [
    { itemId: 1, atSeconds: 0 },
    { itemId: 2, atSeconds: 10 },
  ], 99);
  assert.deepEqual([...out.keys()], [2]);
});

test("chronologicalSpeakerOrder orders by first appearance across all items", () => {
  const itemA = [seg("late", "SPEAKER_02", 30, 35)];
  const itemB = [seg("first", "SPEAKER_01", 0, 5), seg("second", "SPEAKER_00", 5, 9)];
  assert.deepEqual(chronologicalSpeakerOrder([itemA, itemB]), ["SPEAKER_01", "SPEAKER_00", "SPEAKER_02"]);
  assert.deepEqual(chronologicalSpeakerOrder([]), []);
});
