import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema, type Options } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import type { Root, Element } from 'hast';
import { preprocessObsidian } from './obsidian';

/**
 * Render Markdown to a clean, sanitized HTML string for the reader.
 *
 * The reader DOM is the source of truth for sentence segmentation: it wraps each
 * sentence in this HTML in a `<span data-seg>` (via Intl.Segmenter, matching
 * src/segmenter.ts) and requests audio per sentence. So this pass only needs to
 * produce safe, well-formed display HTML — no speech text, no ids.
 *
 * Block elements carry `data-line` (1-based source line) so the reader can
 * offer "Alt+Click → open this sentence in the source editor".
 *
 * rehype-sanitize (GitHub schema) is the security boundary: the document is
 * untrusted, markdown-derived content rendered into the reader DOM, so we
 * strip scripts/handlers/styles and keep only standard prose elements.
 */

const LINED: ReadonlySet<string> = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'pre', 'blockquote', 'table', 'td', 'th',
]);

function rehypeSourceLines() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      const line = node.position?.start?.line;
      if (line && LINED.has(node.tagName)) {
        node.properties = node.properties || {};
        node.properties.dataLine = String(line);
      }
    });
  };
}

const baseSchema: Options = defaultSchema;
const schema: Options = {
  ...baseSchema,
  attributes: {
    ...baseSchema.attributes,
    '*': [...(baseSchema.attributes?.['*'] ?? []), 'dataLine'],
  },
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ['yaml', 'toml']) // parsed so it is NOT rendered as text
  .use(remarkRehype)
  .use(rehypeSourceLines)
  .use(rehypeSanitize, schema)
  .use(rehypeStringify);

export function renderMarkdownHtml(source: string): string {
  return String(processor.processSync(preprocessObsidian(source)));
}
