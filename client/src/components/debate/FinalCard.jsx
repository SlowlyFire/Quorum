import { Box, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useClipboard } from '@mantine/hooks';

import { Markdown } from '../Markdown.jsx';
import { ShimmerBar } from './ResponseCards.jsx';
import { formatCost, formatDuration, formatTokens } from '../../lib/cost.js';

/**
 * Stage 4 — the answer, inside the heavy ink border that says "this is the one".
 *
 * The footer is the product's honesty in one line: what the debate cost, how
 * many calls it took, how long it ran. `$0.041` is the real billed figure summed
 * from `usage.cost`, not an estimate — the estimate was on the previous screen
 * and said "est." for the reason decision 16 records.
 *
 * `open_questions` renders as its own block rather than as a paragraph of the
 * answer. It is the chairman saying what the council could not settle, and
 * folding it into the answer would let it read as part of the conclusion.
 */
export function FinalCard({ final, totals, running = false }) {
  const clipboard = useClipboard({ timeout: 1500 });

  return (
    <Paper
      radius="md"
      p="lg"
      bg="var(--quorum-paper)"
      /**
       * The payoff, so it gets the longest entrance in the product — 380ms,
       * still inside the 400ms budget. Keyed on whether the answer is present,
       * which is what makes the card animate at the moment the text arrives
       * rather than when the empty skeleton first mounted: a round waits up to
       * forty seconds between those two, and animating the skeleton would spend
       * the entrance on nothing.
       */
      key={final?.answer ? 'answered' : 'waiting'}
      className={final?.answer ? 'quorum-enter-final' : undefined}
      style={{ border: '2px solid var(--quorum-ink)' }}
    >
      {final?.answer ? (
        <Markdown size="md">{final.answer}</Markdown>
      ) : running ? (
        <Stack gap={10}>
          <ShimmerBar h={9} />
          <ShimmerBar h={9} w="90%" />
          <ShimmerBar h={9} />
          <ShimmerBar h={9} w="70%" />
        </Stack>
      ) : (
        <Text c="var(--quorum-mute)">No final answer was produced for this round.</Text>
      )}

      {final?.openQuestions && (
        <Box
          mt="md"
          p="md"
          bg="var(--quorum-panel)"
          style={{ borderRadius: 'var(--mantine-radius-md)', border: '1px solid var(--quorum-line)' }}
        >
          <Text className="quorum-eyebrow" mb={6}>
            Open questions
          </Text>
          <Markdown>{final.openQuestions}</Markdown>
        </Box>
      )}

      <Group
        justify="space-between"
        mt="lg"
        pt="md"
        gap="sm"
        wrap="wrap"
        style={{ borderTop: '1px solid var(--quorum-line)' }}
      >
        <Text size="sm" c="var(--quorum-mute)">
          {[
            formatDuration(totals?.durationMs),
            `${totals?.callCount ?? 0} calls`,
            // Absent while a round streams — no frame carries a token count —
            // and present the moment the persisted round replaces it.
            totals?.tokens ? `${formatTokens(totals.tokens)} tokens` : null,
            // Null on the public shared view, where every cost field is
            // withheld. `formatCost(null)` is "$0.00", which would read as
            // "this debate was free" rather than "you are not being told".
            totals?.cost == null ? null : formatCost(totals.cost, { precise: true }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>

        {final?.answer && (
          <Button
            variant="default"
            size="xs"
            leftSection={clipboard.copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            onClick={() => clipboard.copy(final.answer)}
          >
            {clipboard.copied ? 'Copied' : 'Copy'}
          </Button>
        )}
      </Group>
    </Paper>
  );
}
