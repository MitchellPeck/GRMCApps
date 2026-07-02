import { Pool } from "pg";

export interface Person {
  id: number;
  name: string;
  email: string;
  title: string;
  active: boolean;
}

export type AddResult = { ok: true; id: number } | { ok: false; error: string };

function rowToPerson(row: any): Person {
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    title: row.title,
    active: row.active,
  };
}

// Insert a person into the library. Email is optional; when present we normalize
// it and reactivate/update any existing person with the same email.
export async function addPerson(
  pool: Pool,
  name: string,
  email: string,
  title: string
): Promise<AddResult> {
  const n = name.trim();
  const e = email.trim().toLowerCase();
  const t = title.trim();
  if (!n) return { ok: false, error: "Name is required." };
  if (e && !e.includes("@")) return { ok: false, error: "Enter a valid email or leave it blank." };
  try {
    if (e) {
      const existing = await pool.query("SELECT id FROM people WHERE email = $1", [e]);
      if (existing.rows[0]) {
        const id = Number(existing.rows[0].id);
        await pool.query(
          "UPDATE people SET name = $2, title = $3, active = true WHERE id = $1",
          [id, n, t]
        );
        return { ok: true, id };
      }
    }
    const r = await pool.query(
      "INSERT INTO people (name, email, title, active) VALUES ($1, $2, $3, true) RETURNING id",
      [n, e, t]
    );
    return { ok: true, id: Number(r.rows[0].id) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function updatePerson(
  pool: Pool,
  id: number,
  name: string,
  email: string,
  title: string
): Promise<AddResult> {
  const n = name.trim();
  const e = email.trim().toLowerCase();
  if (!n) return { ok: false, error: "Name is required." };
  if (e && !e.includes("@")) return { ok: false, error: "Enter a valid email or leave it blank." };
  try {
    const r = await pool.query(
      "UPDATE people SET name = $2, email = $3, title = $4 WHERE id = $1 RETURNING id",
      [id, n, e, title.trim()]
    );
    if (!r.rows[0]) return { ok: false, error: "Person not found." };
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function listPeople(pool: Pool, includeInactive: boolean): Promise<Person[]> {
  const where = includeInactive ? "" : "WHERE active = true";
  const r = await pool.query(`SELECT id, name, email, title, active FROM people ${where} ORDER BY name`);
  return r.rows.map(rowToPerson);
}

export async function setPersonActive(pool: Pool, id: number, active: boolean): Promise<void> {
  await pool.query("UPDATE people SET active = $2 WHERE id = $1", [id, active]);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Return the ids of library people whose name appears (case-insensitive, as a
// whole word/phrase) in the given text — used to link people named in an
// action item to the meeting. Names shorter than 2 chars are ignored.
export function peopleNamedIn(text: string, people: Person[]): number[] {
  if (!text) return [];
  const ids: number[] = [];
  for (const p of people) {
    const name = p.name.trim();
    if (name.length < 2) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(name)}([^\\p{L}\\p{N}]|$)`, "iu");
    if (re.test(text) && !ids.includes(p.id)) ids.push(p.id);
  }
  return ids;
}
