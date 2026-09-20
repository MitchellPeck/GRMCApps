// The menu of ways to promote one episode. Adding an angle is one entry here —
// the checkbox list, the prompt and the returned draft keys all follow from it.
export interface Angle {
  /** Becomes both the JSON key Claude returns and the saved draft key. */
  key: string;
  label: string;
  instruction: string;
  /** Days after the episode's publish date this post is meant to go out. */
  offsetDays: number;
}

export const ANGLES: Angle[] = [
  {
    key: "announcement",
    label: "Announcement",
    offsetDays: 0,
    instruction:
      "The episode is out. Open with the most compelling thread in it, name the guest if there is one, and end with the listen link on its own line. Make someone want to press play, not merely know it exists.",
  },
  {
    key: "question",
    label: "The question it wrestles with",
    offsetDays: 2,
    instruction:
      "Lead with the real question this episode sits with. Ask it plainly and let it breathe, then point to the episode as where it gets worked through. Do not answer it in the post.",
  },
  {
    key: "quote",
    label: "Pull quote",
    offsetDays: 4,
    instruction:
      "One striking line or idea from the episode, framed so it stands on its own. Keep it short. Attribute it when there is a clear speaker. Close with the listen link.",
  },
  {
    key: "guest",
    label: "Guest or topic spotlight",
    offsetDays: 1,
    instruction:
      "Introduce who is on this episode, or what it digs into when there is no guest, and why this person or subject is worth an hour of someone's attention.",
  },
  {
    key: "invite",
    label: "Invite to Sunday",
    offsetDays: 5,
    instruction:
      "Connect the episode's theme to gathering on Sunday at 11am. Warm, never a hard sell. It should read as an open door to someone who has never walked through it.",
  },
];

// Unknown keys are dropped rather than trusted: these arrive from the browser
// and end up as JSON field names in the prompt.
export function selectAngles(keys: string[]): Angle[] {
  const wanted = new Set(keys || []);
  return ANGLES.filter((a) => wanted.has(a.key));
}

export function anglesBlock(angles: Angle[]): string {
  return angles
    .map((a, i) => `${i + 1}. ${a.key.toUpperCase()} - ${a.label}\n${a.instruction}`)
    .join("\n\n");
}

export function jsonKeysHint(angles: Angle[]): string {
  return angles.map((a) => `"${a.key}"`).join(", ");
}
