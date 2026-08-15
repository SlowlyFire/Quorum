/**
 * Markdown reduced to one line of plain text, for a clamped preview.
 *
 * WHY A PREVIEW MUST NOT BE MARKDOWN, WHICH IS THE SAME REASON A STREAM MUST
 * NOT BE. `FinalCard` renders the arriving answer as plain text and swaps to
 * markdown once, because markdown on partial input does not degrade, it
 * flickers (decision 62). A three-line clamp is partial input by construction,
 * and it fails in a worse way than flicker: `-webkit-line-clamp` needs inline
 * content, so a `<Markdown>` inside a `-webkit-box` lays its block children —
 * `h1`, `p`, `li` — on top of one another. A draft that opened with a heading
 * rendered the heading at full size with the first paragraph printed through
 * it. Every other clamp in this client is Mantine's `<Text lineClamp>` over a
 * text node; this exists so the draft card can be one too.
 *
 * NOT A MARKDOWN PARSER, AND MUST NOT BECOME ONE. It throws away structure on
 * purpose — the full answer is one click away and is rendered properly there,
 * by `react-markdown`, which is the thing that actually knows the grammar. The
 * job here is only to stop syntax characters showing up as literal text in a
 * sentence fragment.
 *
 * Order matters in a couple of places and is commented where it does.
 */

const RULES = [
  /** Fenced code: keep what is inside, drop the fences and any info string.
   *  First, so the markers inside a block are not treated as markup below. */
  [/```[^\n]*\n?([\s\S]*?)```/g, '$1'],
  [/```/g, ''],

  /** Images before links — an image is a link with a `!`, and the link rule
   *  would otherwise leave the `!` and the alt text behind as "!alt". */
  [/!\[[^\]]*\]\([^)]*\)/g, ''],
  [/\[([^\]]*)\]\([^)]*\)/g, '$1'],

  /** Line-leading markers: heading hashes, blockquote arrows, list bullets and
   *  ordered-list numbers, and horizontal rules. */
  [/^\s{0,3}#{1,6}\s+/gm, ''],
  [/^\s{0,3}>\s?/gm, ''],
  [/^\s{0,3}[-*+]\s+/gm, ''],
  [/^\s{0,3}\d+[.)]\s+/gm, ''],
  [/^\s{0,3}([-*_])\s*(\1\s*){2,}$/gm, ''],

  /** Emphasis and inline code. The character classes are deliberately blunt:
   *  a stray asterisk in prose is rarer than a preview showing "**". */
  [/(\*\*|__)(.*?)\1/g, '$2'],
  [/(\*|_)(.*?)\1/g, '$2'],
  [/`([^`]*)`/g, '$1'],

  /**
   * Tables. The alignment row (`|---|:--:|`) carries no words at all, so it is
   * dropped whole — stripping only the outer pipes left "---|---" sitting in
   * the middle of the sentence. Remaining pipes become spaces rather than
   * nothing, so two cells do not fuse into one word.
   */
  [/^[\s|:-]*\|[\s|:-]*$/gm, ''],
  [/\|/g, ' '],
];

/**
 * Returns '' for anything that is not a non-empty string, so a caller can pass
 * a half-arrived or absent `content` straight in.
 */
export function plainExcerpt(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return '';

  let text = markdown;
  for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement);

  /** Every newline becomes a space last of all: the line-leading rules above
   *  need the lines to still be lines when they run. */
  return text.replace(/\s+/g, ' ').trim();
}
