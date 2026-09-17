import { Pool } from "pg";

// The taxonomy the Artifact hardcoded. Seeded ONLY when charge_codes is empty,
// never with ON CONFLICT: an administrator who deletes a code in Settings must
// not have it reappear on the next restart.
const TAXONOMY: { code: string; label: string; subs: { code: string; label: string }[] }[] = [
  { code: "5540", label: "Audio/Video Streaming", subs: [{ code: "5404", label: "Audio/Video Equipment" }] },
  {
    code: "7000",
    label: "Marketing",
    subs: [
      { code: "7040", label: "Photography" },
      { code: "7050", label: "Video" },
      { code: "7060", label: "Podcast Expense" },
      { code: "7070", label: "Marketing Software" },
    ],
  },
  { code: "9300", label: "Security System", subs: [] },
  { code: "8700", label: "Software & Technology", subs: [] },
];

// Settings, by contrast, ARE seeded with ON CONFLICT DO NOTHING: they are a
// fixed key set, so an existing value is kept and a missing key is filled in.
const DEFAULT_SETTINGS: [string, string][] = [
  ["anthropic_api_key", ""],
  ["org_name", "Grace Resurrection Methodist Church"],
  ["default_purchased_by", "Mitchell Peck"],
  ["default_card", "Taylor Bacon"],
  ["default_submitted_by", "Mitchell Peck"],
  ["default_approved_by", "Taylor Bacon"],
];

export async function seedDefaults(pool: Pool): Promise<void> {
  for (const [key, value] of DEFAULT_SETTINGS) {
    await pool.query(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
      [key, value]
    );
  }

  const existing = await pool.query("SELECT 1 FROM charge_codes LIMIT 1");
  if (existing.rowCount) return;

  for (let i = 0; i < TAXONOMY.length; i++) {
    const parent = TAXONOMY[i];
    const r = await pool.query(
      "INSERT INTO charge_codes (code, label, parent_id, sort) VALUES ($1, $2, NULL, $3) RETURNING id",
      [parent.code, parent.label, i]
    );
    const parentId = r.rows[0].id;
    for (let j = 0; j < parent.subs.length; j++) {
      await pool.query(
        "INSERT INTO charge_codes (code, label, parent_id, sort) VALUES ($1, $2, $3, $4)",
        [parent.subs[j].code, parent.subs[j].label, parentId, j]
      );
    }
  }
}
