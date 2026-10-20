// Everything about the content pipeline that someone might reasonably want to
// tune lives here: the platform list, the gap-alert thresholds and the event
// colour palette. The client reads all of it from GET /api/pipeline/meta, so
// editing this file is the whole change.

// What each platform allows. `limit` is its caption length; `urlLength` is
// what a link costs there (X counts every link as 23 characters, however long);
// `needsImage` means a text-only post can't go there at all.
export interface Platform {
  key: string; label: string; limit: number; urlLength?: number; needsImage?: boolean;
  /** How Claude should write for it. */
  guidance: string;
}
export const PLATFORMS: Platform[] = [
  { key: "instagram", label: "Instagram", limit: 2200, needsImage: true,
    guidance: "Instagram: written to sit under an image. Open strong, short lines with breaks, a few relevant hashtags at the end are fine. Links aren't clickable in captions, so say \"link in bio\" instead of pasting a URL." },
  { key: "facebook", label: "Facebook", limit: 16192,
    guidance: "Facebook: warm and conversational, can run a little longer, include the full link if there is one. Hashtags only if natural." },
  { key: "x", label: "X", limit: 280, urlLength: 23,
    guidance: "X: one or two punchy sentences. Hard limit 280 characters, and any link counts as 23 characters. No hashtag clutter." },
];

// New content items get these platforms unless the caller says otherwise.
export const DEFAULT_PLATFORMS = ["instagram", "facebook"];

export const GAP_THRESHOLDS = {
  /** Alert 1: posts publishing within this many days that are not Ready. */
  readinessDays: 7,
  /** Alert 3: media with no gather date for posts publishing within this many days. */
  unscheduledMediaDays: 21,
};

// Dashboard "next N days" window for posts and capture days.
export const UPCOMING_DAYS = 7;

// Cycled through when an event is created without a colour (and by the
// backfill). Navy and gold first, then muted tones that sit beside them.
export const EVENT_COLORS = [
  "#092D3E", "#D3B02B", "#3f6b2e", "#9a4b3a", "#0c447c", "#7A2E86", "#0F6C6C", "#854F0B",
];

// The automated runs don't belong to a series row, so each gets a standing
// event of its own. The ids are fixed so drafting can find them.
export const RUN_EVENTS: Record<string, { id: string; name: string; color: string }> = {
  wednesday: { id: "run-wednesday", name: "Grace Notes & Sunday invite", color: "#534AB7" },
  friday: { id: "run-friday", name: "Weekly blog", color: "#0F6C6C" },
  podcast: { id: "run-podcast", name: "Podcast", color: "#7A2E86" },
};
