import { Box, Group, Stack, Text, Tooltip } from '@mantine/core';

import { formatCost } from '../../lib/cost.js';

/**
 * Mockup 04's right card — seven bars, one per day, tallest in brass.
 *
 * Hand-drawn from flex boxes rather than pulled from a charting library. Seven
 * values with no axes, no legend and no interaction beyond a tooltip is not a
 * chart that needs one, and the smallest of them would add more to the bundle
 * than every component on this page put together.
 *
 * TWO THINGS THAT LOOK LIKE STYLING AND ARE NOT. The bars are scaled against
 * the largest day rather than against the balance, so a week of small spend is
 * still legible — an axis pinned to a fixed maximum would render every real
 * week of this product as seven flat lines. And a day with no spend keeps its
 * column and its label: the server zero-fills the week for exactly this reason,
 * because six bars where seven were asked for is a chart that has silently
 * relabelled its own axis.
 */

/** Single-letter weekday labels, as the mockup has them. */
const WEEKDAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function SpendChart({ days, total }) {
  const peak = Math.max(...days.map((day) => day.spend), 0);

  return (
    <Box
      p="lg"
      h="100%"
      bg="var(--quorum-paper)"
      style={{ border: '1px solid var(--quorum-line)', borderRadius: 12 }}
    >
      <Stack gap="sm" h="100%">
        <Text size="xs" fw={700} c="var(--quorum-mute)" style={{ letterSpacing: '0.08em' }}>
          SPEND, LAST 7 DAYS
        </Text>

        <Group align="flex-end" justify="space-between" gap="xs" h={140} wrap="nowrap" mt="xs">
          {days.map((day) => {
            // Parsed as UTC — the server sends a UTC date, and `new Date('...')`
            // on a bare yyyy-mm-dd is UTC midnight, which getUTCDay must read.
            const weekday = WEEKDAY[new Date(`${day.day}T00:00:00Z`).getUTCDay()];
            const isPeak = peak > 0 && day.spend === peak;

            return (
              <Stack key={day.day} gap={6} align="center" style={{ flex: 1, minWidth: 0 }}>
                <Tooltip
                  label={`${day.day} — ${formatCost(day.spend, { precise: true })}`}
                  withArrow
                  position="top"
                >
                  <Box
                    w="60%"
                    h={peak > 0 ? `${Math.max(4, (day.spend / peak) * 100)}%` : 4}
                    style={{
                      background: isPeak ? 'var(--quorum-brass)' : 'var(--quorum-line)',
                      borderRadius: 4,
                      alignSelf: 'flex-end',
                    }}
                    // A bar is a value, not decoration: a screen reader that
                    // reaches this should hear the figure, not skip an empty box.
                    role="img"
                    aria-label={`${day.day}: ${formatCost(day.spend, { precise: true })}`}
                  />
                </Tooltip>

                <Text size="xs" c="var(--quorum-mute)" aria-hidden>
                  {weekday}
                </Text>
              </Stack>
            );
          })}
        </Group>

        <Text size="sm" c="var(--quorum-mute)" mt="auto">
          {total > 0 ? `${formatCost(total, { precise: true })} spent this week` : 'Nothing spent this week'}
        </Text>
      </Stack>
    </Box>
  );
}
