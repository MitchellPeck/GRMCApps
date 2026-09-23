/**
 * Announcement slides composed in the app, rather than in PowerPoint.
 *
 * These are rasterised on the server with ffmpeg's drawtext, not rendered by
 * the player. The narthex screen is driven through the DeckLink by
 * playout.py, which decodes pictures and video — it cannot render HTML, so a
 * browser-drawn notice would be invisible on the actual screen.
 *
 * Everything in this file is pure: the layout is worked out here and tested,
 * and render-notice.ts does nothing but run the commands it describes.
 */

export interface NoticeText {
  headline: string;
  body: string;
  footnote: string;
}

export type NoticeTheme = "navy" | "gold" | "paper" | "plain" | "urgent";

export interface ThemeColours {
  background: string;
  headline: string;
  body: string;
  footnote: string;
  rule: string;
}

// ffmpeg wants 0xRRGGBB. These mirror shared/ui/grmc.css so a notice looks
// like it belongs beside everything else the church publishes.
export const THEMES: Record<NoticeTheme, ThemeColours> = {
  navy:  { background: "0x092D3E", headline: "0xFFFFFF", body: "0xE8EEF1", footnote: "0xD3B02B", rule: "0xD3B02B" },
  gold:  { background: "0xD3B02B", headline: "0x092D3E", body: "0x14202A", footnote: "0x092D3E", rule: "0x092D3E" },
  paper: { background: "0xF7F3E9", headline: "0x092D3E", body: "0x23303A", footnote: "0x9A7D20", rule: "0xD3B02B" },
  plain: { background: "0x000000", headline: "0xFFFFFF", body: "0xE6E6E6", footnote: "0xBBBBBB", rule: "0x666666" },
  // Emergency takeover. Matches #takeover in player.css so the two clients
  // showing the same message do not look like different systems.
  urgent: { background: "0x7A1D1D", headline: "0xFFFFFF", body: "0xF2E4E4", footnote: "0xF2E4E4", rule: "0xFFFFFF" },
};

export function themeFor(name: string): ThemeColours {
  return THEMES[(name as NoticeTheme)] ?? THEMES.navy;
}

/**
 * Greedy word wrap to a column width in characters.
 *
 * A word longer than the column is broken rather than allowed to run off the
 * slide — a pasted URL would otherwise disappear over the right-hand edge.
 */
export function wrapText(text: string, columns: number): string[] {
  const cleaned = String(text ?? "").replace(/\r/g, "").trim();
  if (!cleaned) return [];
  if (columns < 1) columns = 1;

  const lines: string[] = [];
  for (const paragraph of cleaned.split("\n")) {
    if (!paragraph.trim()) { lines.push(""); continue; }
    let line = "";
    for (let word of paragraph.trim().split(/\s+/)) {
      while (word.length > columns) {
        if (line) { lines.push(line); line = ""; }
        lines.push(word.slice(0, columns));
        word = word.slice(columns);
      }
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length <= columns) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * How many characters fit across, for a font size.
 *
 * drawtext cannot measure or wrap, so this approximates from the average
 * advance width of the fonts we ship: about 0.5em for the sans, a little
 * narrower for the serif. Deliberately conservative — a line that wraps one
 * word early looks fine, a line that overruns the slide does not.
 */
export function columnsFor(widthPx: number, fontSize: number, serif: boolean): number {
  const advance = fontSize * (serif ? 0.46 : 0.52);
  return Math.max(8, Math.floor(widthPx / advance));
}

export interface LaidOutLine {
  text: string;
  /** Baseline-independent: drawtext positions by the box's top edge. */
  y: number;
  fontSize: number;
  colour: string;
  serif: boolean;
}

export interface NoticeLayout {
  width: number;
  height: number;
  background: string;
  lines: LaidOutLine[];
  /** A rule between the headline and the body, when there is both. */
  rule: { y: number; colour: string } | null;
}

export interface LayoutOptions {
  width?: number;
  height?: number;
  theme?: string;
}

/**
 * Lay a notice out on the canvas: headline large and serif, body beneath a
 * gold rule, footnote at the bottom. The whole block is centred vertically so
 * a two-word notice does not sit awkwardly at the top.
 */
export function layoutNotice(text: NoticeText, opts: LayoutOptions = {}): NoticeLayout {
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const colours = themeFor(opts.theme ?? "navy");
  const margin = Math.round(width * 0.09);
  const usable = width - margin * 2;

  // Long headlines step down a size rather than wrapping to four lines.
  const headlineRaw = String(text.headline ?? "").trim();
  let headSize = headlineRaw.length > 60 ? 84 : headlineRaw.length > 30 ? 108 : 132;
  let headLines = wrapText(headlineRaw, columnsFor(usable, headSize, true));
  while (headLines.length > 3 && headSize > 56) {
    headSize -= 12;
    headLines = wrapText(headlineRaw, columnsFor(usable, headSize, true));
  }

  const bodySize = 54;
  const bodyLines = wrapText(text.body, columnsFor(usable, bodySize, false)).slice(0, 8);
  const footSize = 38;
  const footLines = wrapText(text.footnote, columnsFor(usable, footSize, false)).slice(0, 2);

  const headLead = Math.round(headSize * 1.16);
  const bodyLead = Math.round(bodySize * 1.42);
  const footLead = Math.round(footSize * 1.4);
  const ruleGap = headLines.length && bodyLines.length ? Math.round(bodySize * 1.5) : 0;

  const blockHeight =
    headLines.length * headLead +
    ruleGap +
    bodyLines.length * bodyLead +
    (footLines.length ? Math.round(footSize * 1.8) + footLines.length * footLead : 0);

  let y = Math.max(margin, Math.round((height - blockHeight) / 2));
  const lines: LaidOutLine[] = [];

  for (const line of headLines) {
    lines.push({ text: line, y, fontSize: headSize, colour: colours.headline, serif: true });
    y += headLead;
  }

  let rule: NoticeLayout["rule"] = null;
  if (ruleGap) {
    rule = { y: y + Math.round(ruleGap / 2) - 2, colour: colours.rule };
    y += ruleGap;
  }

  for (const line of bodyLines) {
    lines.push({ text: line, y, fontSize: bodySize, colour: colours.body, serif: false });
    y += bodyLead;
  }

  if (footLines.length) {
    y += Math.round(footSize * 1.8);
    for (const line of footLines) {
      lines.push({ text: line, y, fontSize: footSize, colour: colours.footnote, serif: false });
      y += footLead;
    }
  }

  return { width, height, background: colours.background, lines, rule };
}

export type NoticeValidation = { ok: true } | { ok: false; error: string };

export function validateNotice(text: Partial<NoticeText>): NoticeValidation {
  const headline = String(text.headline ?? "").trim();
  const body = String(text.body ?? "").trim();
  if (!headline && !body) return { ok: false, error: "Give the notice something to say." };
  if (headline.length > 200) return { ok: false, error: "That headline is too long for a screen." };
  if (body.length > 800) return { ok: false, error: "That's more text than fits on a slide." };
  return { ok: true };
}
