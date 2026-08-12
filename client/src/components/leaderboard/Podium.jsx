import { Box, Group, Paper, Stack, Text } from '@mantine/core';

import { ModelBadge } from '../ModelBadge.jsx';
import { useCountUp } from '../../hooks/useCountUp.js';
import {
  PODIUM_COLORS,
  PODIUM_HEIGHTS,
  PODIUM_ORDER,
  formatPercent,
} from '../../lib/leaderboard.js';

/**
 * THE ANIMATION, and the order it runs in.
 *
 * Third place rises first, then second, then first — the reverse of rank, so
 * the eye is carried up to the winner instead of away from it. Each block takes
 * 400ms and they start 160ms apart, which overlaps them: three fully sequential
 * 400ms rises would be 1.2 seconds of a page doing nothing else, and this is a
 * standings table, not a title sequence.
 *
 * The badge, percentage and draft count above a block wait for that block to
 * settle before fading in, so the number arrives on a plinth rather than in
 * mid-air. The count-up then runs for 800ms from there.
 *
 * `runKey` restarts the whole thing when the My council / All time toggle
 * changes, because the numbers being compared have changed and a set of figures
 * that silently swapped underneath the same blocks would be the one case where
 * this animation is carrying information rather than polish.
 */
const RISE_MS = 400;
const RISE_STAGGER_MS = 160;

/** Third, second, first — index into PODIUM_ORDER's seating, not into rank. */
const RISE_SEQUENCE = { 0: 2, 1: 1, 2: 0 };

/**
 * Mockup 07's podium: three stepped blocks, first tallest and centre.
 *
 * Drawn with flexbox and three boxes rather than with a charting library, for
 * the same reason `SpendChart` is: it is three rectangles of known height, and
 * the nearest dependency that would draw them is larger than this whole page.
 *
 * The badge, win rate and draft count sit ABOVE each block and the medallion and
 * name sit ON it, which is what the mockup does and is also what keeps the three
 * columns readable when the blocks are different heights — the labels line up
 * with each other rather than stepping with the podium.
 *
 * Fewer than three ranked models renders fewer blocks, in the same seats. Two
 * models draw first and second and leave third empty rather than promoting
 * anybody, because a podium with a silver and no gold would be a lie about who
 * won.
 */
export function Podium({ standings, runKey = 0 }) {
  return (
    <Paper
      withBorder
      radius="md"
      p={{ base: 'md', sm: 'xl' }}
      bg="var(--quorum-paper)"
      style={{ borderColor: 'var(--quorum-line)', overflowX: 'auto' }}
    >
      <Group
        justify="center"
        align="flex-end"
        gap={{ base: 4, sm: 'md' }}
        wrap="nowrap"
        style={{ minHeight: 300, minWidth: 320 }}
      >
        {PODIUM_ORDER.map((rankIndex) => {
          const standing = standings[rankIndex];

          if (!standing) {
            // The seat is held rather than collapsed, so second place stays left
            // of first when there is no third.
            return <Box key={rankIndex} w={{ base: 96, sm: 200 }} aria-hidden />;
          }

          return (
            <PodiumBlock
              // The runKey is IN the key, which is what makes the CSS
              // animations restart on a scope change: an element that was not
              // remounted keeps its finished animation and would not replay.
              key={`${standing.modelId}-${runKey}`}
              standing={standing}
              rankIndex={rankIndex}
              runKey={runKey}
            />
          );
        })}
      </Group>
    </Paper>
  );
}

function PodiumBlock({ standing, rankIndex, runKey }) {
  const color = PODIUM_COLORS[rankIndex];

  const riseDelay = RISE_SEQUENCE[rankIndex] * RISE_STAGGER_MS;
  /** The label waits for its own block to finish rising. */
  const labelDelay = riseDelay + RISE_MS;

  const percent = useCountUp(standing.winRate ?? 0, { durationMs: 800, restartKey: runKey });

  return (
    <Stack gap={0} align="center" w={{ base: 96, sm: 200 }}>
      {/*
        Badge, percentage and draft count are ONE animated wrapper, not three.
        They arrive as a single label above the block, so animating them
        separately would be three entrances where the design has one — and a
        wrapper per element invites `display: contents` to preserve the layout,
        which silently cannot be animated at all (a box that generates no box
        has nothing to animate).
      */}
      <Box
        className="quorum-podium-label"
        style={{
          '--quorum-enter-delay': `${labelDelay}ms`,
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        <ModelBadge
          model={{ displayName: standing.displayName, slug: standing.slug }}
          size={44}
          fz={16}
        />

        <Text fz={{ base: 26, sm: 34 }} fw={700} c="var(--quorum-ink)" mt="xs" lh={1.15}>
          {/* Rounded, so it never shows a fractional percent mid-count and
              never renders a different final value from the table's. */}
          {formatPercent(percent)}
        </Text>
        <Text size="sm" c="var(--quorum-mute)">
          {standing.drafts} drafts
        </Text>
      </Box>

      <Box
        className="quorum-podium-block"
        mt="sm"
        w="100%"
        h={PODIUM_HEIGHTS[rankIndex]}
        style={{
          '--quorum-enter-delay': `${riseDelay}ms`,
          background: 'var(--quorum-panel)',
          border: '1px solid var(--quorum-line)',
          // The gold / silver / bronze rule across the top of the block. A
          // border rather than a filled bar so the block itself stays the
          // mockup's pale grey at every rank.
          borderTop: `4px solid ${color}`,
          borderRadius: '4px 4px 0 0',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          paddingTop: 18,
          paddingInline: 8,
        }}
      >
        {/* Held at full opacity through the rise rather than counter-scaled:
            the block grows from its base, and the medallion riding up with it
            is what makes it read as a plinth being placed. */}
        <Medallion rank={rankIndex + 1} color={color} />
        <Text fw={700} size="sm" ta="center" c="var(--quorum-ink)" style={{ lineHeight: 1.25 }}>
          {standing.displayName}
        </Text>
      </Box>
    </Stack>
  );
}

function Medallion({ rank, color }) {
  return (
    <Box
      w={34}
      h={34}
      style={{
        borderRadius: 999,
        background: color,
        color: '#fff',
        display: 'grid',
        placeItems: 'center',
        fontWeight: 700,
        fontSize: 15,
        flexShrink: 0,
      }}
      aria-label={`Rank ${rank}`}
    >
      {rank}
    </Box>
  );
}
