// Deciding which of a batch of media may go, kept apart from the route so the
// rules are the same ones the single delete applies and are testable without a
// database: your own uploads always, anyone's with manage, and nothing still in
// a live playlist unless the person has said "delete anyway".

export interface BulkDeleteInput {
  rows: { id: number | string; uploaded_by_email: string }[];
  requested: number[];
  email: string;
  manage: boolean;
  /** media id → names of the live playlists it is in */
  usage: Map<number, string[]>;
  force: boolean;
}

export interface BulkDeletePlan {
  deletable: number[];
  notYours: number[];
  inUse: { id: number; playlists: string[] }[];
  missing: number[];
}

export function planBulkDelete(input: BulkDeleteInput): BulkDeletePlan {
  const byId = new Map(input.rows.map((r) => [Number(r.id), r]));
  const me = input.email.toLowerCase();
  const plan: BulkDeletePlan = { deletable: [], notYours: [], inUse: [], missing: [] };

  for (const id of input.requested) {
    const row = byId.get(id);
    if (!row) {
      plan.missing.push(id);
      continue;
    }
    if (!input.manage && row.uploaded_by_email.toLowerCase() !== me) {
      plan.notYours.push(id);
      continue;
    }
    const playlists = input.usage.get(id) ?? [];
    if (playlists.length && !input.force) {
      plan.inUse.push({ id, playlists });
      continue;
    }
    plan.deletable.push(id);
  }
  return plan;
}
