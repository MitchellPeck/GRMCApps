/**
 * Live check of the Metricool send path, using the app's real credentials and
 * the same functions the Send button calls. Nothing here re-implements the
 * payload — if this passes, the app's request shape is the one Metricool
 * accepted, and if it fails you get Metricool's own words back.
 *
 * Run it inside the container:
 *   docker compose exec social-posts node dist/probe-metricool.js
 *   docker compose exec social-posts node dist/probe-metricool.js --upload
 *   docker compose exec social-posts node dist/probe-metricool.js --networks instagram --upload --send
 *
 * Without --send it stops before scheduling and just prints the payload, so it
 * is safe to run against the live brand.
 */
import { pool } from "./db";
import { getMetricoolCreds, listBrands, normalizeMedia, schedulePost, buildSchedulerPayload } from "./metricool";
import { getR2Creds, uploadPublic, decodeImageDataUrl } from "./r2";

// A 1x1 gif, so the upload check needs no fixture file on disk.
const TINY_GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => console.log(`  FAIL ${m}`);

async function main(): Promise<void> {
  let failures = 0;
  const step = async (label: string, fn: () => Promise<string>): Promise<boolean> => {
    console.log(`\n${label}`);
    try { ok(await fn()); return true; }
    catch (e) { bad((e as Error).message); failures++; return false; }
  };

  const creds = await getMetricoolCreds(pool);
  console.log(`Credentials: userId=${creds.userId} blogId=${creds.blogId || "(none set)"} token=${creds.token ? `${creds.token.slice(0, 6)}…` : "(missing)"}`);

  await step("1. Brands — proves the token and userId are accepted", async () => {
    const brands = await listBrands(creds);
    const mine = brands.find((b) => b.id === creds.blogId);
    if (!creds.blogId) throw new Error(`no brand picked in Settings. Available: ${brands.map((b) => `${b.id} (${b.label})`).join(", ")}`);
    if (!mine) throw new Error(`configured blogId ${creds.blogId} is not in this token's brands: ${brands.map((b) => b.id).join(", ")}`);
    return `${brands.length} brand(s); configured blogId matches "${mine.label}"`;
  });

  // The upload path is the one the modal's "Upload an image" option uses:
  // bytes -> R2 -> public url -> Metricool normalize. Each hop can fail on its
  // own, so check them separately rather than reading one "it didn't work".
  let imageUrl = arg("image");
  if (has("upload")) {
    const uploaded = await step("2a. R2 upload — proves the bucket accepts our writes", async () => {
      const { bytes, contentType } = decodeImageDataUrl(TINY_GIF);
      const url = await uploadPublic(await getR2Creds(pool), bytes, contentType, `probe-${Date.now()}`);
      imageUrl = url;
      return `uploaded to ${url}`;
    });
    if (uploaded) {
      await step("2b. Public read — proves Metricool will be able to fetch it", async () => {
        const res = await fetch(imageUrl);
        if (!res.ok) throw new Error(`${imageUrl} is not publicly readable (${res.status}) — Metricool skips media it cannot fetch. Check the bucket's public access / r2_public_base_url.`);
        const type = res.headers.get("content-type") || "";
        if (!type.startsWith("image/")) throw new Error(`that url served "${type}", not an image — r2_public_base_url may point at the wrong bucket`);
        return `publicly readable, served as ${type}`;
      });
    }
  }

  let mediaUrl = "";
  if (imageUrl) {
    await step("2. Media normalize — proves Metricool will host that public url", async () => {
      mediaUrl = await normalizeMedia(creds, imageUrl);
      if (mediaUrl === imageUrl) throw new Error("Metricool echoed the url back instead of hosting it — it could not fetch that image");
      return `hosted at ${mediaUrl}`;
    });
  } else {
    console.log("\n2. Media normalize — skipped (pass --image <public-url>, or --upload to test the R2 path)");
  }

  const networks = (arg("networks", "facebook") || "").split(",").map((n) => n.trim()).filter(Boolean);
  const when = new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString().slice(0, 19);
  const payload = buildSchedulerPayload({
    text: arg("text", `Metricool API probe — ignore. ${new Date().toISOString()}`),
    networks, dateTime: when, timezone: arg("timezone", "America/New_York"), mediaUrl,
  });
  console.log(`\n3. Payload the app would send for [${networks.join(", ")}]:`);
  console.log(JSON.stringify(payload, null, 2));
  console.log(payload.autoPublish
    ? "  note: autoPublish is ON — this post would publish itself at the scheduled time."
    : "  note: autoPublish is OFF — this lands as a draft for a human to approve in Metricool.");

  if (!has("send")) {
    console.log("\n4. Schedule — skipped. Re-run with --send to actually create the post.");
  } else {
    await step("4. Schedule — proves the payload shape is accepted", async () => {
      const id = await schedulePost(creds, payload);
      return `created post id ${id || "(none returned)"} for ${when}. Delete it in the Metricool planner.`;
    });
  }

  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => { console.error(`\nProbe aborted: ${(e as Error).message}`); await pool.end(); process.exit(1); });
