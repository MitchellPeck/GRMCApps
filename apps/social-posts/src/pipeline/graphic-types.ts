// The graphic types the church makes. Editing this file is how types change:
// the later renderer and template editor read it, and the client gets it from
// GET /api/pipeline/meta, so nothing else needs touching.

// `fields` is the event data a template for that type can draw on.
export interface GraphicType {
  key: string; label: string; width: number; height: number;
  /** Where the finished graphic gets used. */
  usedFor: string;
  fields: string[];
}

export const GRAPHIC_TYPES: GraphicType[] = [
  { key: "lower-third", label: "Lower third", width: 1920, height: 280,
    usedFor: "Overlay on the livestream or sermon video", fields: ["name", "date", "time"] },
  { key: "announcement-slide", label: "Announcement slide", width: 1920, height: 1080,
    usedFor: "Sunday service announcement loop", fields: ["name", "date", "time", "location"] },
  { key: "sermon-series", label: "Sermon series", width: 1920, height: 1080,
    usedFor: "Series title graphic for the screens and website", fields: ["name", "date"] },
  { key: "sermon-weekly", label: "Sermon weekly", width: 1920, height: 1080,
    usedFor: "This week's sermon title graphic", fields: ["name", "date", "speaker"] },
  { key: "ig-feed", label: "Instagram feed", width: 1080, height: 1350,
    usedFor: "Instagram feed post (4:5)", fields: ["name", "date", "time", "location"] },
  { key: "ig-story", label: "Instagram story", width: 1080, height: 1920,
    usedFor: "Instagram and Facebook stories (9:16)", fields: ["name", "date", "time", "location"] },
  { key: "fb-event-cover", label: "Facebook event cover", width: 1920, height: 1005,
    usedFor: "Cover image for a Facebook event", fields: ["name", "date", "time", "location"] },
  { key: "grace-notes-banner", label: "Grace Notes banner", width: 1200, height: 400,
    usedFor: "Header banner in the Grace Notes email", fields: ["name", "date"] },
  { key: "podcast-art", label: "Podcast art", width: 3000, height: 3000,
    usedFor: "Podcast episode or show artwork", fields: ["name"] },
];

export function graphicType(key: string): GraphicType | undefined {
  return GRAPHIC_TYPES.find((g) => g.key === key);
}
