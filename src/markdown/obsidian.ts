/**
 * Preprocess Obsidian-flavored Markdown into standard Markdown before it reaches
 * remark. Obsidian's own syntax (wikilinks, embeds, `%%comments%%`, `==highlight==`,
 * callout markers, `#tags`, block refs) is invisible to remark-gfm, so without this
 * pass those tokens leak into the reader DOM and get read aloud as literal brackets
 * and punctuation.
 *
 * Line count is preserved end-to-end (every transform is intra-line, and multi-line
 * comments are blanked in place) so the `data-line` source mapping remains accurate
 * for "Alt+Click → open in editor".
 *
 * Fenced and inline code are left untouched — code is display/announce-only content
 * and must not be rewritten.
 */

const IMAGE_EMBED = /\.(png|jpe?g|gif|webp|svg|bmp|avif|mp3|wav|ogg|m4a|flac|mp4|webm|mov|pdf)$/i;

/** Extract the spoken display text of a wikilink body (`target#heading|alias`). */
function wikiDisplay(inner: string): string {
  const pipe = inner.indexOf('|');
  if (pipe >= 0) {
    const alias = inner.slice(pipe + 1).trim();
    if (alias) return alias;
    inner = inner.slice(0, pipe);
  }
  inner = inner.replace(/#\^[\w-]+/g, ''); // block reference
  const hash = inner.indexOf('#');
  const target = (hash >= 0 ? inner.slice(0, hash) : inner).trim();
  const heading = hash >= 0 ? inner.slice(hash + 1).trim() : '';
  const basename = target.split('/').pop() || '';
  return (basename || heading).trim();
}

/** Apply inline Obsidian transforms to one run of non-code text. */
function transformText(text: string): string {
  return text
    // ![[image.png]] / ![[Note]] embeds: drop media, speak the note title otherwise.
    .replace(/!\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
      const first = String(inner).split('|')[0].split('#')[0].trim();
      return IMAGE_EMBED.test(first) ? '' : wikiDisplay(String(inner));
    })
    // [[target|alias]] / [[target#heading]] wikilinks → their display text.
    .replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => wikiDisplay(String(inner)))
    // ==highlight== → highlight
    .replace(/==([^=]+)==/g, '$1')
    // trailing block-reference anchor: "…text ^block-id"
    .replace(/\s+\^[\w-]+\s*$/g, '')
    // #inline-tags → removed (headings use "# " with a space and are unaffected)
    .replace(/(^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu, '$1');
}

/** Run a line through the inline transforms, skipping inline `code` spans. */
function transformLine(line: string): string {
  // Strip a callout marker at the head of a blockquote line: "> [!note]+ Title" → "> Title".
  line = line.replace(/^(\s*>+\s*)\[!\w+\][-+]?\s?/, '$1');
  if (line.indexOf('`') < 0) return transformText(line);
  // Preserve inline code spans verbatim; transform only the prose between them.
  return line
    .split(/(`+[^`]*`+)/g)
    .map((part) => (part.startsWith('`') ? part : transformText(part)))
    .join('');
}

export function preprocessObsidian(source: string): string {
  const lines = source.split('\n');
  let inFence = false;
  let fenceChar = '';
  let inComment = false;
  let inFrontmatter = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Leading YAML/TOML frontmatter: leave untouched (remark strips it; never spoken).
    if (i === 0 && /^(---|\+\+\+)\s*$/.test(line)) { inFrontmatter = true; continue; }
    if (inFrontmatter) { if (/^(---|\+\+\+)\s*$/.test(line)) inFrontmatter = false; continue; }

    // Fenced code: track open/close, never rewrite the contents.
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence && !inComment) {
      const ch = fence[1][0];
      if (!inFence) { inFence = true; fenceChar = ch; }
      else if (fenceChar === ch) { inFence = false; fenceChar = ''; }
      continue;
    }
    if (inFence) continue;

    // Strip %% comments %% in place (may span lines), keeping the line as blank.
    if (inComment || line.indexOf('%%') >= 0) {
      line = stripComments(line, inComment, (open) => (inComment = open));
    }

    lines[i] = transformLine(line);
  }
  return lines.join('\n');
}

/**
 * Blank out `%%…%%` comment spans on a single line, threading the open/close state
 * across lines. `setOpen` reports whether a comment is still open after this line.
 */
function stripComments(line: string, open: boolean, setOpen: (v: boolean) => void): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (open) {
      const close = line.indexOf('%%', i);
      if (close < 0) { setOpen(true); return out; } // whole rest is comment
      i = close + 2;
      open = false;
    } else {
      const openIdx = line.indexOf('%%', i);
      if (openIdx < 0) { out += line.slice(i); break; }
      out += line.slice(i, openIdx);
      i = openIdx + 2;
      open = true;
    }
  }
  setOpen(open);
  return out;
}
