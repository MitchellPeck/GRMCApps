export interface PayloadInput {
  text: string;
  networks: string[];
  dateTime: string;
  timezone: string;
  mediaUrl: string;
}
export interface SchedulerPayload {
  publicationDate: { dateTime: string; timezone: string };
  text: string;
  providers: Array<{ network: string }>;
  autoPublish: boolean;
  facebookData?: { type: string };
  media?: string[];
}

export function buildSchedulerPayload(i: PayloadInput): SchedulerPayload {
  const payload: SchedulerPayload = {
    publicationDate: { dateTime: i.dateTime, timezone: i.timezone },
    text: i.text,
    providers: i.networks.map((n) => ({ network: n })),
    autoPublish: false,
  };
  if (i.networks.includes("facebook")) payload.facebookData = { type: "POST" };
  if (i.mediaUrl) payload.media = [i.mediaUrl];
  return payload;
}

const WEEKDAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
const MONTHS: Record<string, number> = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };

export type DateSource =
  | { kind: "weekday"; weekday: string }
  | { kind: "seriesDate"; label: string };

export function suggestDateTime(src: DateSource, def: { refDate: string; time: string }): string {
  const [y, m, d] = def.refDate.split("-").map(Number);
  const ref = new Date(Date.UTC(y, m - 1, d, 12));
  let target: Date;
  if (src.kind === "weekday") {
    const want = WEEKDAYS.indexOf(src.weekday.toLowerCase());
    const cur = ref.getUTCDay();
    let delta = (want - cur + 7) % 7;
    if (delta === 0) delta = 7;
    target = new Date(ref.getTime() + delta * 86400000);
  } else {
    const [mon, day] = src.label.split(" ");
    target = new Date(Date.UTC(ref.getUTCFullYear(), MONTHS[mon] ?? 0, parseInt(day, 10), 12));
  }
  const yyyy = target.getUTCFullYear();
  const mm = String(target.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(target.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${def.time}:00`;
}

const LIMITS: Record<string, number> = { instagram: 2200, facebook: 16192, twitter: 280, google: 1500 };
export function charWarnings(text: string, networks: string[]): string[] {
  const out: string[] = [];
  for (const n of networks) {
    const lim = LIMITS[n];
    if (lim && text.length > lim) out.push(`${n} limit is ${lim} chars; this post is ${text.length}.`);
  }
  return out;
}
