import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFrames, itemAiring, planRevision, PlanItem, PlaylistDefaults } from "./plan";
import { DEFAULT_SETTINGS } from "./settings";

const playlist: PlaylistDefaults = {
  id: 1, name: "Announcements", imageSeconds: 0, slideSeconds: 0,
  transition: "", fit: "", footerText: "", shuffle: false,
};

function item(
  over: {
    seconds?: number; fit?: string; enabled?: boolean;
    showFrom?: string | null; showUntil?: string | null;
    media?: Partial<PlanItem["media"]>;
  } = {}
): PlanItem {
  return {
    seconds: over.seconds ?? 0,
    fit: over.fit ?? "",
    enabled: over.enabled ?? true,
    showFrom: over.showFrom ?? null,
    showUntil: over.showUntil ?? null,
    media: {
      id: 1, kind: "image", title: "Item", status: "ready", pageCount: 0, durationMs: null,
      ...(over.media ?? {}),
    },
  };
}

test("a photo becomes one frame at the app's default duration", () => {
  const frames = buildFrames([item({ media: { id: 5, kind: "image" } })], playlist, DEFAULT_SETTINGS);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, "image");
  assert.equal(frames[0].url, "/api/player/media/5/file");
  assert.equal(frames[0].ms, DEFAULT_SETTINGS.imageSeconds * 1000);
});

test("durations fall back item -> playlist -> app", () => {
  const withPlaylist = { ...playlist, imageSeconds: 30 };
  assert.equal(buildFrames([item({ media: {} })], withPlaylist, DEFAULT_SETTINGS)[0].ms, 30_000);
  assert.equal(buildFrames([item({ seconds: 5, media: {} })], withPlaylist, DEFAULT_SETTINGS)[0].ms, 5_000);
  assert.equal(buildFrames([item({ media: {} })], playlist, DEFAULT_SETTINGS)[0].ms, 12_000);
});

test("a video plays to its own end unless an item duration caps it", () => {
  const video = item({ media: { id: 9, kind: "video", durationMs: 45_000 } });
  assert.equal(buildFrames([video], playlist, DEFAULT_SETTINGS)[0].ms, null);
  const capped = buildFrames([{ ...video, seconds: 10 }], playlist, DEFAULT_SETTINGS);
  assert.equal(capped[0].ms, 10_000);
  assert.equal(capped[0].kind, "video");
});

test("a deck expands into one frame per slide", () => {
  const deck = item({ media: { id: 7, kind: "deck", pageCount: 3, title: "Announcements" } });
  const frames = buildFrames([deck], playlist, DEFAULT_SETTINGS);
  assert.equal(frames.length, 3);
  assert.deepEqual(
    frames.map((f) => f.url),
    ["/api/player/media/7/page/1", "/api/player/media/7/page/2", "/api/player/media/7/page/3"]
  );
  assert.equal(frames[0].title, "Announcements (1/3)");
  assert.ok(frames.every((f) => f.kind === "image"));
  assert.ok(frames.every((f) => f.ms === DEFAULT_SETTINGS.slideSeconds * 1000));
});

test("items that are not ready, or are switched off, are skipped rather than shown broken", () => {
  const frames = buildFrames(
    [
      item({ media: { id: 1, status: "ready" } }),
      item({ media: { id: 2, status: "pending" } }),
      item({ media: { id: 3, status: "failed" } }),
      item({ enabled: false, media: { id: 4, status: "ready" } }),
    ],
    playlist,
    DEFAULT_SETTINGS
  );
  assert.deepEqual(frames.map((f) => f.mediaId), [1]);
});

test("fit falls back item -> playlist -> app", () => {
  assert.equal(buildFrames([item({ media: {} })], playlist, DEFAULT_SETTINGS)[0].fit, "contain");
  assert.equal(
    buildFrames([item({ media: {} })], { ...playlist, fit: "cover" }, DEFAULT_SETTINGS)[0].fit,
    "cover"
  );
  assert.equal(
    buildFrames([item({ fit: "contain", media: {} })], { ...playlist, fit: "cover" }, DEFAULT_SETTINGS)[0].fit,
    "contain"
  );
});

test("shuffle is stable for a given seed so the TV does not restart every poll", () => {
  const items = [1, 2, 3, 4, 5, 6].map((id) => item({ media: { id } }));
  const shuffled = { ...playlist, shuffle: true };
  const a = buildFrames(items, shuffled, DEFAULT_SETTINGS, 42).map((f) => f.mediaId);
  const b = buildFrames(items, shuffled, DEFAULT_SETTINGS, 42).map((f) => f.mediaId);
  const c = buildFrames(items, shuffled, DEFAULT_SETTINGS, 43).map((f) => f.mediaId);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.deepEqual([...a].sort(), [1, 2, 3, 4, 5, 6]);
});

test("the revision changes when anything the screen renders changes", () => {
  const base = {
    sourceKey: "schedule:1:1:",
    playlistId: 1,
    playlistName: "A",
    entryId: 1,
    entryLabel: "",
    endsAt: null,
    display: {
      background: "#000", transition: "fade" as const, transitionMs: 600,
      clock: "off" as const, clockPosition: "bottom-right" as const,
      timezone: "America/Chicago",
      footerText: "", rotation: 0, pollSeconds: 10, idleMessage: "",
      idleHeadline: "", idleShowMark: true, loopSingleVideo: true,
    },
    power: { on: true, changesAt: null },
    takeover: { active: false, headline: "", body: "", urgent: true },
    frames: buildFrames([item({ media: {} })], playlist, DEFAULT_SETTINGS),
  };
  const first = planRevision(base);
  assert.equal(planRevision({ ...base }), first);
  assert.notEqual(planRevision({ ...base, display: { ...base.display, rotation: 90 } }), first);
  assert.notEqual(
    planRevision({ ...base, frames: buildFrames([item({ seconds: 3, media: {} })], playlist, DEFAULT_SETTINGS) }),
    first
  );
  // The playlist NAME is cosmetic for the admin UI and is not hashed.
  assert.equal(planRevision({ ...base, playlistName: "B" }), first);
  // An emergency message must reach the TV, and clearing it must too.
  assert.notEqual(
    planRevision({ ...base, takeover: { active: true, headline: "Evacuate", body: "", urgent: true } }),
    first
  );
  // Going dark outside opening hours must reach the TV.
  assert.notEqual(planRevision({ ...base, power: { on: false, changesAt: null } }), first);
  // ...but the countdown to the next boundary moves every second and must not.
  assert.equal(
    planRevision({ ...base, power: { on: true, changesAt: "2026-01-11T14:00:00.000Z" } }),
    first
  );
});

// ── date windows on an item ─────────────────────────────────────────────────

test("an item outside its date window is not on the screen", () => {
  const items = [
    item({ media: { id: 1 } }),                                   // always
    item({ showUntil: "2026-10-27", media: { id: 2 } }),          // retires
    item({ showFrom: "2026-11-30", media: { id: 3 } }),           // not yet
    item({ showFrom: "2026-10-01", showUntil: "2026-10-31", media: { id: 4 } }),
  ];
  const on = (today: string) =>
    buildFrames(items, playlist, DEFAULT_SETTINGS, 0, today).map((f) => f.mediaId);

  assert.deepEqual(on("2026-10-15"), [1, 2, 4]);
  // The bounds are INCLUSIVE at both ends.
  assert.deepEqual(on("2026-10-27"), [1, 2, 4]);
  // 2 has expired; 4 is still inside its own window, which runs to the 31st.
  assert.deepEqual(on("2026-10-28"), [1, 4]);
  assert.deepEqual(on("2026-10-01"), [1, 2, 4]);
  assert.deepEqual(on("2026-11-30"), [1, 3]);
});

test("with no date given, every item airs — the window is opt-in", () => {
  const items = [item({ showUntil: "2020-01-01", media: { id: 9 } })];
  assert.deepEqual(buildFrames(items, playlist, DEFAULT_SETTINGS).map((f) => f.mediaId), [9]);
});

test("itemAiring is inclusive at both ends and ignores absent bounds", () => {
  const bounded = item({ showFrom: "2026-10-01", showUntil: "2026-10-31", media: {} });
  assert.equal(itemAiring(bounded, "2026-09-30"), false);
  assert.equal(itemAiring(bounded, "2026-10-01"), true);
  assert.equal(itemAiring(bounded, "2026-10-31"), true);
  assert.equal(itemAiring(bounded, "2026-11-01"), false);
  assert.equal(itemAiring(item({ media: {} }), "1999-01-01"), true);
});

test("an expired item drops out of the plan entirely rather than showing blank", () => {
  const items = [item({ showUntil: "2026-01-01", media: { id: 1 } })];
  assert.deepEqual(buildFrames(items, playlist, DEFAULT_SETTINGS, 0, "2026-10-15"), []);
});
