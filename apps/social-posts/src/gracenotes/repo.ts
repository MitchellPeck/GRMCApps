// Grace Notes storage: contributors (permanent no-login links) and sections.
import { randomBytes } from "node:crypto";
import { Pool, PoolClient } from "pg";
import { Result } from "../pipeline/rules";
import { Contributor, Section, SectionKind, SECTION_KINDS } from "./types";

type Db = Pool | PoolClient;
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const newToken = () => randomBytes(24).toString("base64url");

const CONTRIBUTOR_COLS = "id, name, email, token, retired_at IS NOT NULL AS retired";

function contributorRow(r: Record<string, unknown>): Contributor {
  return { id: r.id as string, name: r.name as string, email: r.email as string, token: r.token as string, retired: r.retired as boolean };
}

export async function createContributor(db: Db, input: { name: string; email?: string }): Promise<Result<Contributor>> {
  const name = (input.name ?? "").trim();
  if (!name) return fail("A contributor needs a name.");
  const { rows } = await db.query(
    `INSERT INTO gn_contributors (name, email, token) VALUES ($1, $2, $3) RETURNING ${CONTRIBUTOR_COLS}`,
    [name, (input.email ?? "").trim(), newToken()],
  );
  return { ok: true, value: contributorRow(rows[0]) };
}

export async function updateContributor(db: Db, id: string, patch: { name?: string; email?: string }): Promise<Result<Contributor>> {
  const name = patch.name === undefined ? null : patch.name.trim();
  if (name === "") return fail("A contributor needs a name.");
  const email = patch.email === undefined ? null : patch.email.trim();
  const { rows } = await db.query(
    `UPDATE gn_contributors SET name = COALESCE($2, name), email = COALESCE($3, email)
      WHERE id = $1 RETURNING ${CONTRIBUTOR_COLS}`,
    [id, name, email],
  );
  return rows[0] ? { ok: true, value: contributorRow(rows[0]) } : fail("Contributor not found.");
}

/** Retire and replace the token, so the old link stops working at once. */
export async function retireContributor(db: Db, id: string): Promise<Result<Contributor>> {
  const { rows } = await db.query(
    `UPDATE gn_contributors SET retired_at = COALESCE(retired_at, now()), token = $2
      WHERE id = $1 RETURNING ${CONTRIBUTOR_COLS}`,
    [id, newToken()],
  );
  return rows[0] ? { ok: true, value: contributorRow(rows[0]) } : fail("Contributor not found.");
}

export async function listContributors(db: Db): Promise<Contributor[]> {
  const { rows } = await db.query(`SELECT ${CONTRIBUTOR_COLS} FROM gn_contributors ORDER BY lower(name), created_at`);
  return rows.map(contributorRow);
}

export async function contributorByToken(db: Db, token: string): Promise<Contributor | null> {
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT ${CONTRIBUTOR_COLS} FROM gn_contributors WHERE token = $1 AND retired_at IS NULL`, [token]);
  return rows[0] ? contributorRow(rows[0]) : null;
}

// ── Sections ─────────────────────────────────────────────────────────────────

export async function createSection(db: Db, input: { title: string; kind: SectionKind }): Promise<Result<Section>> {
  const title = (input.title ?? "").trim();
  if (!title) return fail("A section needs a title.");
  if (!SECTION_KINDS.includes(input.kind)) return fail(`Kind must be one of: ${SECTION_KINDS.join(", ")}.`);
  const { rows } = await db.query(
    `INSERT INTO gn_sections (title, kind, position)
     VALUES ($1, $2, (SELECT COALESCE(MAX(position), -1) + 1 FROM gn_sections)) RETURNING id`,
    [title, input.kind],
  );
  const got = await getSection(db, rows[0].id);
  return got ? { ok: true, value: got } : fail("Section not found.");
}

export async function updateSection(db: Db, id: string, patch: { title?: string; retired?: boolean }): Promise<Result<Section>> {
  const title = patch.title === undefined ? null : patch.title.trim();
  if (title === "") return fail("A section needs a title.");
  const { rowCount } = await db.query(
    `UPDATE gn_sections SET title = COALESCE($2, title), retired = COALESCE($3, retired) WHERE id = $1`,
    [id, title, patch.retired ?? null],
  );
  if (!rowCount) return fail("Section not found.");
  const got = await getSection(db, id);
  return got ? { ok: true, value: got } : fail("Section not found.");
}

/** Run `fn` atomically. A Pool gets its own transaction; a PoolClient is the caller's to manage. */
export async function withTx<T>(db: Db, fn: (c: Db) => Promise<T>): Promise<T> {
  if (!(db instanceof Pool)) return fn(db);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Listed sections take positions 0..n-1 in the given order; unlisted ones follow in their old order. */
export async function reorderSections(db: Db, ids: string[]): Promise<Result<true>> {
  const listed = [...new Set(ids)];
  return withTx(db, async (c) => {
    const known = await c.query("SELECT id FROM gn_sections WHERE id = ANY($1::text[])", [listed]);
    if (known.rowCount !== listed.length) return fail("Unknown section.");
    await c.query(
      `UPDATE gn_sections s SET position = r.rn
         FROM (SELECT s2.id, (ROW_NUMBER() OVER (ORDER BY (l.ord IS NULL), l.ord, s2.position, s2.id) - 1)::int AS rn
                 FROM gn_sections s2
                 LEFT JOIN unnest($1::text[]) WITH ORDINALITY AS l(lid, ord) ON l.lid = s2.id) r
        WHERE s.id = r.id`,
      [listed],
    );
    return { ok: true as const, value: true as const };
  });
}

export async function setSectionOwners(db: Db, sectionId: string, contributorIds: string[]): Promise<Result<true>> {
  const ids = [...new Set(contributorIds)];
  return withTx(db, async (c) => {
    const sec = await c.query("SELECT 1 FROM gn_sections WHERE id = $1", [sectionId]);
    if (!sec.rowCount) return fail("Section not found.");
    const known = await c.query("SELECT id, retired_at IS NOT NULL AS retired FROM gn_contributors WHERE id = ANY($1::text[])", [ids]);
    if (known.rowCount !== ids.length) return fail("Unknown contributor.");
    if (known.rows.some((r) => r.retired)) return fail("That person has been retired.");
    await c.query("DELETE FROM gn_section_owners WHERE section_id = $1", [sectionId]);
    if (ids.length) {
      await c.query(
        `INSERT INTO gn_section_owners (section_id, contributor_id) SELECT $1, unnest($2::text[])`,
        [sectionId, ids],
      );
    }
    return { ok: true as const, value: true as const };
  });
}

const SECTION_SQL = `
  SELECT s.id, s.title, s.kind, s.position, s.retired,
         COALESCE((SELECT array_agg(o.contributor_id ORDER BY o.contributor_id)
                     FROM gn_section_owners o WHERE o.section_id = s.id), '{}') AS owner_ids
    FROM gn_sections s`;

function sectionRow(r: Record<string, unknown>): Section {
  return {
    id: r.id as string, title: r.title as string, kind: r.kind as SectionKind,
    position: r.position as number, retired: r.retired as boolean, ownerIds: r.owner_ids as string[],
  };
}

async function getSection(db: Db, id: string): Promise<Section | null> {
  const { rows } = await db.query(`${SECTION_SQL} WHERE s.id = $1`, [id]);
  return rows[0] ? sectionRow(rows[0]) : null;
}

export async function listSections(db: Db, opts: { includeRetired?: boolean } = {}): Promise<Section[]> {
  const { rows } = await db.query(
    `${SECTION_SQL} ${opts.includeRetired ? "" : "WHERE NOT s.retired"} ORDER BY s.position, s.id`);
  return rows.map(sectionRow);
}
