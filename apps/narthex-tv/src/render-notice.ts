import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "./convert";
import { layoutNotice, LayoutOptions, NoticeLayout, NoticeText } from "./notices";

// Whatever the image actually ships. Probed rather than hard-coded so a change
// to the font packages degrades to a different face instead of a blank slide.
const SERIF_CANDIDATES = [
  "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
];
const SANS_CANDIDATES = [
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
];

function firstPresent(paths: string[]): string | null {
  for (const p of paths) if (existsSync(p)) return p;
  return null;
}

export function fontsAvailable(): { serif: string | null; sans: string | null } {
  return { serif: firstPresent(SERIF_CANDIDATES), sans: firstPresent(SANS_CANDIDATES) };
}

/**
 * Build the filtergraph for a laid-out notice.
 *
 * Every piece of text goes through `textfile=`, never `text=`. drawtext's own
 * escaping rules are a minefield — a colon, an apostrophe, a percent or a
 * comma in somebody's announcement would otherwise break the filtergraph or,
 * worse, change it. Reading from a file means the text never touches the
 * filter string at all.
 */
export function buildFilter(
  layout: NoticeLayout,
  linePaths: string[],
  fonts: { serif: string; sans: string }
): string {
  const parts: string[] = [];

  if (layout.rule) {
    const w = Math.round(layout.width * 0.1);
    const x = Math.round((layout.width - w) / 2);
    parts.push(
      `drawbox=x=${x}:y=${layout.rule.y}:w=${w}:h=4:color=${layout.rule.colour}:t=fill`
    );
  }

  layout.lines.forEach((line, i) => {
    const font = line.serif ? fonts.serif : fonts.sans;
    parts.push(
      [
        `drawtext=fontfile=${font}`,
        `textfile=${linePaths[i]}`,
        `fontcolor=${line.colour}`,
        `fontsize=${line.fontSize}`,
        "x=(w-text_w)/2",
        `y=${line.y}`,
        // Without this a glyph that overhangs the box is clipped rather than
        // drawn, which looks like a rendering fault.
        "fix_bounds=1",
      ].join(":")
    );
  });

  // An empty notice would produce an empty graph, which ffmpeg rejects.
  return parts.length ? parts.join(",") : "null";
}

export interface RenderedNotice {
  path: string;
  width: number;
  height: number;
}

/**
 * Rasterise a notice to a JPEG the player and playout.py can both show,
 * exactly like any uploaded photo.
 */
export async function renderNotice(
  text: NoticeText,
  dir: string,
  opts: LayoutOptions = {}
): Promise<RenderedNotice> {
  const fonts = fontsAvailable();
  if (!fonts.serif || !fonts.sans) {
    throw new Error(
      "No usable fonts in the image — a notice cannot be drawn. " +
        "fonts-liberation and fonts-dejavu-core should be installed."
    );
  }

  const layout = layoutNotice(text, opts);
  await mkdir(dir, { recursive: true });
  const lineDir = join(dir, "lines");
  await rm(lineDir, { recursive: true, force: true });
  await mkdir(lineDir, { recursive: true });

  const linePaths: string[] = [];
  for (let i = 0; i < layout.lines.length; i++) {
    const path = join(lineDir, `${i}.txt`);
    await writeFile(path, layout.lines[i].text, "utf8");
    linePaths.push(path);
  }

  const out = join(dir, "play.jpg");
  await run(
    "ffmpeg",
    [
      "-y",
      "-f", "lavfi",
      "-i", `color=c=${layout.background}:s=${layout.width}x${layout.height}`,
      "-vf", buildFilter(layout, linePaths, { serif: fonts.serif, sans: fonts.sans }),
      "-frames:v", "1",
      "-q:v", "2",
      out,
    ],
    120_000
  );

  await rm(lineDir, { recursive: true, force: true });
  return { path: out, width: layout.width, height: layout.height };
}
