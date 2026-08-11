import { Box, Button, Group, Paper, Skeleton, Stack, Text } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useClipboard } from '@mantine/hooks';

import { Markdown } from '../Markdown.jsx';
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
      style={{ border: '2px solid var(--quorum-ink)' }}
    >
      {final?.answer ? (
        <Markdown size="md">{final.answer}</Markdown>
      ) : running ? (
        <Stack gap={10}>
          <Skeleton height={9} radius="sm" />
          <Skeleton height={9} width="90%" radius="sm" />
          <Skeleton height={9} radius="sm" />
          <Skeleton height={9} width="70%" radius="sm" />
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
            formatCost(totals?.cost, { precise: true }),
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
