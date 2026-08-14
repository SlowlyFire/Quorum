import { Box, Group, Paper, Table, Text, Tooltip } from '@mantine/core';

import { ModelBadge } from '../ModelBadge.jsx';
import { formatAvgCost, formatPercent } from '../../lib/leaderboard.js';

/**
 * Mockup 07's full standings: #, model, drafts, wins, merged, conceded, win
 * rate, avg cost.
 *
 * WINS AND MERGED ARE DISJOINT, which is what makes the row check out against
 * its own win rate: a sole win is 1.0 and a shared one is 0.5, so
 * `(wins + merged / 2) / drafts` is the percentage in the next column but one.
 * A reader who does that arithmetic should get the right answer, which is why
 * the two columns do not overlap and why the header carries the note.
 *
 * The table scrolls inside itself below `sm` rather than the page scrolling
 * sideways — eight columns do not fit a phone, and dropping columns would leave
 * the win rate unverifiable from the row.
 */
export function StandingsTable({ standings }) {
  return (
    <Paper
      withBorder
      radius="md"
      bg="var(--quorum-paper)"
      style={{ borderColor: 'var(--quorum-line)', overflow: 'hidden' }}
    >
      <Box style={{ overflowX: 'auto' }}>
        {/* `miw` is what makes the box scroll rather than the page: eight
            columns need about 640px before anything wraps, and below that the
            table gets its own horizontal scrollbar inside the card. */}
        <Table verticalSpacing="md" horizontalSpacing="md" miw={640}>
          <Table.Thead>
            <Table.Tr>
              <HeaderCell w={48}>#</HeaderCell>
              <HeaderCell>Model</HeaderCell>
              <HeaderCell numeric>Drafts</HeaderCell>
              <HeaderCell numeric hint="Rounds this model won outright — 1.0 each.">
                Wins
              </HeaderCell>
              <HeaderCell numeric hint="Rounds it shared with another draft — 0.5 each. Not counted in Wins.">
                Merged
              </HeaderCell>
              <HeaderCell numeric hint="Of the rebuttals it made, not of the rounds it drafted: stage 3 does not always happen.">
                Conceded
              </HeaderCell>
              <HeaderCell numeric hint="(wins + merged ÷ 2) ÷ drafts.">Win rate</HeaderCell>
              <HeaderCell numeric hint="Mean cost of one draft from this model.">
                Avg cost
              </HeaderCell>
            </Table.Tr>
          </Table.Thead>

          <Table.Tbody>
            {standings.map((standing, index) => (
              <Table.Tr key={standing.modelId}>
                <Table.Td>
                  <Text size="sm" fw={600} c="var(--quorum-mute)">
                    {index + 1}
                  </Text>
                </Table.Td>

                <Table.Td>
                  <Group gap="sm" wrap="nowrap">
                    <ModelBadge
                      model={{ displayName: standing.displayName, slug: standing.slug }}
                      size={26}
                      fz={12}
                    />
                    {/* Never wrapped. A two-line "Claude Haiku 4.5" makes the
                        row twice as tall as its neighbours and the numbers stop
                        scanning down the column. The table already scrolls
                        sideways inside its own box if it has to. */}
                    <Text fw={700} size="sm" c="var(--quorum-ink)" style={{ whiteSpace: 'nowrap' }}>
                      {standing.displayName}
                    </Text>
                  </Group>
                </Table.Td>

                <NumberCell>{standing.drafts}</NumberCell>
                <NumberCell>{standing.wins}</NumberCell>
                <NumberCell>{standing.merged}</NumberCell>
                <NumberCell>{formatPercent(standing.concessionRate)}</NumberCell>

                <Table.Td align="right">
                  <Text size="sm" fw={700} c="var(--quorum-ink)">
                    {formatPercent(standing.winRate)}
                  </Text>
                </Table.Td>

                <NumberCell>{formatAvgCost(standing.avgCost)}</NumberCell>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>
    </Paper>
  );
}

function HeaderCell({ children, numeric = false, hint = null, w }) {
  const label = (
    <Text
      size="xs"
      fw={700}
      c="var(--quorum-mute)"
      style={{ letterSpacing: '0.08em', whiteSpace: 'nowrap' }}
      // A dotted underline is the only affordance a tooltip on a table header
      // gets; without it the hint is there and nobody finds it.
      td={hint ? 'underline dotted' : undefined}
    >
      {String(children).toUpperCase()}
    </Text>
  );

  return (
    <Table.Th w={w} style={{ textAlign: numeric ? 'right' : 'left' }}>
      {hint ? (
        <Tooltip label={hint} withArrow multiline w={260} position="top">
          <Box component="span" style={{ cursor: 'help' }}>
            {label}
          </Box>
        </Tooltip>
      ) : (
        label
      )}
    </Table.Th>
  );
}

function NumberCell({ children }) {
  return (
    <Table.Td align="right">
      <Text size="sm" c="var(--quorum-mute)">
        {children}
      </Text>
    </Table.Td>
  );
}
