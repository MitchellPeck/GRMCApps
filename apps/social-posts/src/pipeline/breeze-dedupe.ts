import { BreezeInstance } from "../breeze";

// Two Breeze copies are "the same event" only when the name matches exactly
// apart from case and spacing, so near-misses are never merged by accident.
export function matchKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface Cluster {
  key: string;
  seriesIds: string[];
  calendarIds: string[];
  byDate: Map<string, BreezeInstance[]>;
}

export function clusterCopies(groups: Map<string, BreezeInstance[]>, calendarOrder: string[]): Cluster[] {
  const rank = (cal: string) => { const i = calendarOrder.indexOf(cal); return i < 0 ? Infinity : i; };
  const cmpCal = (a: string, b: string) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const nx = parent.get(x)!; parent.set(x, r); x = nx; }
    return r;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };

  const seriesKey = new Map<string, string>();
  const seen = new Map<string, string>(); // matchKey + date -> first series id
  for (const [sid, list] of groups) {
    parent.set(sid, sid);
    seriesKey.set(sid, matchKey(list[0]?.name ?? ""));
  }
  for (const [sid, list] of groups) {
    for (const inst of list) {
      const k = matchKey(inst.name) + "\u0000" + inst.date;
      const first = seen.get(k);
      if (first === undefined) seen.set(k, sid); else union(first, sid);
    }
  }

  const byRoot = new Map<string, string[]>();
  for (const sid of groups.keys()) {
    const r = find(sid);
    byRoot.set(r, [...(byRoot.get(r) ?? []), sid]);
  }

  const out: Cluster[] = [];
  for (const sids of byRoot.values()) {
    const all = sids.flatMap(s => groups.get(s)!);
    const byDate = new Map<string, BreezeInstance[]>();
    for (const d of [...new Set(all.map(i => i.date))].sort()) {
      byDate.set(d, all.filter(i => i.date === d).sort((a, b) =>
        cmpCal(a.calendarId, b.calendarId) || (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0)));
    }
    out.push({
      key: seriesKey.get(sids[0])!,
      seriesIds: sids,
      calendarIds: [...new Set(all.map(i => i.calendarId))].sort(cmpCal),
      byDate,
    });
  }
  const first = (c: Cluster) => c.byDate.keys().next().value as string;
  return out.sort((a, b) => (first(a) < first(b) ? -1 : first(a) > first(b) ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
