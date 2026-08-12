import { Box, Group, Paper, Stack, Text } from '@mantine/core';

import { ModelBadge } from '../ModelBadge.jsx';
import {
  PODIUM_COLORS,
  PODIUM_HEIGHTS,
  PODIUM_ORDER,
  formatPercent,
} from '../../lib/leaderboard.js';

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
export function Podium({ standings }) {
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

          return <PodiumBlock key={standing.modelId} standing={standing} rankIndex={rankIndex} />;
        })}
      </Group>
    </Paper>
  );
}

function PodiumBlock({ standing, rankIndex }) {
  const color = PODIUM_COLORS[rankIndex];

  return (
    <Stack gap={0} align="center" w={{ base: 96, sm: 200 }}>
      <ModelBadge model={{ displayName: standing.displayName, slug: standing.slug }} size={44} fz={16} />

      <Text fz={{ base: 26, sm: 34 }} fw={700} c="var(--quorum-ink)" mt="xs" lh={1.15}>
        {formatPercent(standing.winRate)}
      </Text>
      <Text size="sm" c="var(--quorum-mute)">
        {standing.drafts} drafts
      </Text>

      <Box
        mt="sm"
        w="100%"
        h={PODIUM_HEIGHTS[rankIndex]}
        style={{
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
