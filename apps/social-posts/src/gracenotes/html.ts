// Rich-text sanitizer for Grace Notes pieces pasted from Word, Google Docs, etc.
// A small allow-list tokenizer: no dependencies, output is safe to store and re-render.

export const MAX_RICH_TEXT = 200_000;
// Comments and Word/Outlook directives (<![if ...]>, <!DOCTYPE>, <?xml?>) are skipped; a tag can't span a "<".
const TOKEN = /<!--(?:[\s\S]*?-->|[\s\S]*$)|<[!?][^<>]*>|<\/?([a-zA-Z0-9:]+)([^<>]*)>|[^<]+|</g;

function checkLength(s: string): void {
  if (s.length > MAX_RICH_TEXT) throw new Error("That text is too long.");
}
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const ENTITY = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi;
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  ndash: "–", mdash: "—", hellip: "…", bull: "•",
};
const MAPPED: Record<string, string> = { b: "strong", i: "em", div: "p" };
const ALLOWED = new Set(["p", "br", "strong", "em", "a", "ul", "ol", "li"]);

function decodeEntities(s: string): string {
  return s.replace(ENTITY, (m) => {
    const body = m.slice(1, -1);
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED[body.toLowerCase()] ?? m;
  });
}

function escapeText(s: string): string {
  return s.replace(/&(?!(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripBlocks(input: string): string {
  return input.replace(/<(script|style)\b(?:[\s\S]*?<\/\1\s*>|[\s\S]*$)/gi, "");
}

function readHref(attrs: string): string | null {
  const m = HREF.exec(attrs);
  if (!m) return null;
  const href = decodeEntities(m[1] ?? m[2] ?? m[3] ?? "").trim();
  // Browsers ignore whitespace/control characters inside the scheme, so test without them.
  return /^(https?:|mailto:)/i.test(href.replace(/[\u0000- ]/g, "")) ? href : null;
}

export function sanitizeHtml(input: string): string {
  checkLength(input);
  let out = "";
  const stack: { tag: string; emit: boolean }[] = [];
  for (const m of stripBlocks(input).matchAll(TOKEN)) {
    const [tok, rawName, attrs = ""] = m;
    if (tok.startsWith("<!") || tok.startsWith("<?")) continue;
    if (rawName === undefined) {
      out += tok === "<" ? "&lt;" : escapeText(tok);
      continue;
    }
    const lower = rawName.toLowerCase();
    const tag = MAPPED[lower] ?? lower;
    if (!ALLOWED.has(tag)) continue;
    if (tok.startsWith("</")) {
      if (tag === "br") continue;
      let idx = stack.length - 1;
      while (idx >= 0 && stack[idx].tag !== tag) idx--;
      if (idx < 0) continue;
      while (stack.length > idx) {
        const open = stack.pop()!;
        if (open.emit) out += `</${open.tag}>`;
      }
    } else if (tag === "br") {
      out += "<br>";
    } else if (tag === "a") {
      const href = readHref(attrs);
      stack.push({ tag, emit: href !== null });
      if (href !== null) out += `<a href="${escapeAttr(href)}">`;
    } else {
      stack.push({ tag, emit: true });
      out += `<${tag}>`;
    }
  }
  while (stack.length) {
    const open = stack.pop()!;
    if (open.emit) out += `</${open.tag}>`;
  }
  return out;
}

export function htmlToText(html: string): string {
  checkLength(html);
  let out = "";
  let anchor: { href: string; start: number } | null = null;
  for (const m of stripBlocks(html).matchAll(TOKEN)) {
    const [tok, rawName, attrs = ""] = m;
    if (tok.startsWith("<!") || tok.startsWith("<?")) continue;
    if (rawName === undefined) {
      out += tok === "<" ? "<" : decodeEntities(tok.replace(/\s+/g, " "));
      continue;
    }
    const tag = rawName.toLowerCase();
    const closing = tok.startsWith("</");
    if (tag === "br") out += "\n";
    else if (tag === "p" || tag === "div" || tag === "ul" || tag === "ol") {
      if (closing) out += "\n\n";
    } else if (tag === "li") out += closing ? "\n" : "• ";
    else if (tag === "a") {
      if (!closing) {
        const href = readHref(attrs);
        anchor = href ? { href, start: out.length } : null;
      } else if (anchor) {
        const label = out.slice(anchor.start).trim();
        if (label !== anchor.href && label !== anchor.href.replace(/^mailto:/i, "")) out += ` (${anchor.href})`;
        anchor = null;
      }
    }
  }
  return out
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
