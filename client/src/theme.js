/**
 * The Quorum palette, from the §5 mockups.
 *
 * Eight named colours and four model-badge colours, and this file is the only
 * place any of the twelve is written down. Sessions 8 and 11 both need the
 * badge map — a debate view that colours Response A by its model, and an
 * attachment thumbnail that does the same — so it is exported rather than
 * re-typed there.
 *
 * Mantine wants a ten-shade tuple per colour, and which index a component
 * reaches for depends on its variant. The ramps below are built so that the
 * shade Mantine defaults to IS the mockup's colour: index 9 for `ink` (set as
 * primaryShade), index 6 for `brass` and `green`. Reading `theme.colors.ink[9]`
 * and getting anything other than #131A22 would mean this file is wrong.
 */
import { createTheme } from '@mantine/core';

/** The flat palette. Use these when a raw CSS colour is what is wanted. */
export const PALETTE = {
  ink: '#131A22', // text, primary buttons
  mute: '#7C8B9A', // secondary text
  line: '#DCE2E8', // borders
  panel: '#F5F7F9', // page background
  paper: '#FFFFFF', // cards
  brass: '#9A6B1F', // chairman, verdicts, credits — the accent
  brassBg: '#FBF3E4',
  green: '#2E7D57', // concessions, positive amounts
};

/**
 * Model badge colours — the single source, per the note above.
 *
 * Keyed on the vendor rather than on a slug, because a slug changes with every
 * model we seat (`claude-haiku-4.5` today, something else next quarter) and the
 * badge is really saying "this is the Anthropic one". `modelBadgeColor` below
 * is what callers should use; it takes whatever a row happens to carry.
 */
export const MODEL_BADGE_COLORS = {
  claude: '#3B5BA5',
  gpt: '#1F7A5A',
  gemini: '#7A4AA5',
  llama: '#B25A3A',
};

/** Anything we cannot recognise gets `mute`, never a random colour. */
export const MODEL_BADGE_FALLBACK = PALETTE.mute;

/**
 * Every string that should map to a badge colour. Matched as a substring
 * against the lower-cased slug, provider and display name together, so
 * `anthropic/claude-haiku-4.5`, `Anthropic` and `Claude Haiku 4.5` all land on
 * the same blue.
 */
const BADGE_ALIASES = [
  [['claude', 'anthropic'], MODEL_BADGE_COLORS.claude],
  [['gpt', 'openai', 'o1', 'o3'], MODEL_BADGE_COLORS.gpt],
  [['gemini', 'google'], MODEL_BADGE_COLORS.gemini],
  [['llama', 'meta'], MODEL_BADGE_COLORS.llama],
];

/**
 * @param {{ slug?: string, provider?: string, displayName?: string } | string} model
 * @returns {string} a hex colour, never undefined
 */
export function modelBadgeColor(model) {
  const haystack = (
    typeof model === 'string'
      ? model
      : [model?.slug, model?.openrouterSlug, model?.provider, model?.displayName].join(' ')
  ).toLowerCase();

  for (const [needles, color] of BADGE_ALIASES) {
    if (needles.some((needle) => haystack.includes(needle))) return color;
  }

  return MODEL_BADGE_FALLBACK;
}

/** The letter in the round badge: C, G, M, L in the mockups. */
export function modelBadgeLetter(model) {
  const name = typeof model === 'string' ? model : (model?.displayName ?? '');
  return (name.trim()[0] ?? '?').toUpperCase();
}

const inkShades = [
  '#F4F6F8',
  '#E6EAEE',
  '#CBD3DA',
  '#AEB9C4',
  '#94A2B0',
  PALETTE.mute, // 5 — secondary text
  '#5E6E7D',
  '#414F5C',
  '#29343E',
  PALETTE.ink, // 9 — primaryShade
];

const brassShades = [
  PALETTE.brassBg, // 0 — the credits chip and verdict card background
  '#F7E9CE',
  '#EED7A8',
  '#E3C079',
  '#D5A94F',
  '#B98A2F',
  PALETTE.brass, // 6 — Mantine's default filled shade
  '#82591A',
  '#684614',
  '#4E340F',
];

const greenShades = [
  '#E8F5EE',
  '#D0EADC',
  '#A4D6BC',
  '#74C09B',
  '#4CAB7F',
  '#37926A',
  PALETTE.green, // 6
  '#266A49',
  '#1E553B',
  '#16402C',
];

/**
 * A system stack rather than a web font: nothing to download, nothing to block
 * first paint, and one less external origin on a page that already has a
 * cross-origin API.
 */
const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export const theme = createTheme({
  fontFamily: FONT_STACK,
  headings: { fontFamily: FONT_STACK, fontWeight: '700' },
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',

  colors: { ink: inkShades, brass: brassShades, green: greenShades },
  primaryColor: 'ink',
  primaryShade: 9,

  defaultRadius: 'md',
  white: PALETTE.paper,
  black: PALETTE.ink,

  // Consumed by components/global.css as --quorum-* variables, so a card
  // border and a page background are named once here and not repeated as hex
  // in every file that draws one.
  other: PALETTE,

  components: {
    Anchor: { defaultProps: { underline: 'never' } },
  },
});
