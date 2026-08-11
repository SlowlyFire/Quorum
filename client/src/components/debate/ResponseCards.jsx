import { useState } from 'react';
import { Anchor, Badge, Box, Group, Modal, Paper, Skeleton, Stack, Text } from '@mantine/core';

import { Markdown } from '../Markdown.jsx';
import { ModelBadge } from '../ModelBadge.jsx';
import { STANCE_LABEL } from '../../lib/round.js';
import { formatCost, formatDuration } from '../../lib/cost.js';

/**
 * Stage 1 — one card per drafter, side by side, headed "Response A" with the
 * model named underneath.
 *
 * The letter is the anonymous label the CHAIRMAN saw; the name underneath is
 * what the chairman did not. Anonymity is a property of stage 2's prompt, not a
 * secret kept from the user — §2 promises the full record of who said what — and
 * showing both in one card is what makes that legible rather than merely true.
 *
 * Three lines and a link, because a council of four produces four essays and a
 * thread that opens with 3,000 words of them is a thread nobody reads. The full
 * answer is one click away and is rendered as markdown, which is what the model
 * wrote.
 */
export function DraftCard({ item, pending = false }) {
  const [open, setOpen] = useState(false);

  if (pending) return <PendingCard />;

  return (
    <>
      <Paper
        withBorder
        radius="md"
        p="md"
        bg="var(--quorum-paper)"
        style={{ borderColor: 'var(--quorum-line)', display: 'flex', flexDirection: 'column' }}
      >
        <Group gap="sm" wrap="nowrap" mb="sm">
          <ModelBadge model={item.modelName} />
          <Box style={{ minWidth: 0 }}>
            <Text fw={700}>Response {item.label}</Text>
            <Text size="sm" c="var(--quorum-mute)" truncate>
              {item.modelName}
            </Text>
          </Box>
        </Group>

        {item.error ? (
          <FailureNote error={item.error} />
        ) : item.content ? (
          <>
            <Box
              style={{
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                flex: 1,
              }}
            >
              <Markdown>{item.content}</Markdown>
            </Box>

            <Anchor component="button" type="button" mt="sm" size="sm" onClick={() => setOpen(true)}>
              Read full answer ›
            </Anchor>
          </>
        ) : (
          <Skeleton height={48} radius="sm" />
        )}
      </Paper>

      <Modal
        opened={open}
        onClose={() => setOpen(false)}
        size="lg"
        title={
          <Group gap="sm">
            <ModelBadge model={item.modelName} />
            <Box>
              <Text fw={700}>Response {item.label}</Text>
              <Text size="xs" c="var(--quorum-mute)">
                {item.modelName}
                {item.latencyMs ? ` · ${formatDuration(item.latencyMs)}` : ''}
                {item.cost ? ` · ${formatCost(item.cost, { precise: true })}` : ''}
              </Text>
            </Box>
          </Group>
        }
      >
        <Markdown size="md">{item.content}</Markdown>
      </Modal>
    </>
  );
}

/**
 * A drafter that is still thinking. Skeleton lines rather than a spinner:
 * stage 1 runs every model in parallel and finishes out of order, so what a
 * user needs to see is *where* the missing answer will land.
 */
function PendingCard() {
  return (
    <Paper withBorder radius="md" p="md" bg="var(--quorum-paper)" style={{ borderColor: 'var(--quorum-line)' }}>
      <Group gap="sm" wrap="nowrap" mb="sm">
        <Skeleton height={28} circle />
        <Stack gap={6} style={{ flex: 1 }}>
          <Skeleton height={10} width="45%" radius="sm" />
          <Skeleton height={8} width="30%" radius="sm" />
        </Stack>
      </Group>

      <Stack gap={8}>
        <Skeleton height={8} radius="sm" />
        <Skeleton height={8} width="85%" radius="sm" />
        <Skeleton height={8} width="60%" radius="sm" />
      </Stack>
    </Paper>
  );
}

/**
 * Stage 3 — one card per drafter with its stance. CONCEDES is green on green,
 * per the mockup, and it is the chip worth colouring: a model withdrawing its
 * own point is the single clearest evidence the debate did something.
 */
export function RebuttalCard({ item }) {
  const conceded = item.stance === 'concede';

  return (
    <Paper
      withBorder
      radius="md"
      p="md"
      bg={conceded ? 'green.0' : 'var(--quorum-paper)'}
      style={{ borderColor: conceded ? 'var(--mantine-color-green-2)' : 'var(--quorum-line)' }}
    >
      <Group justify="space-between" wrap="nowrap" mb="sm" gap="sm">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <ModelBadge model={item.modelName} />
          <Text fw={700} truncate>
            {item.modelName}
          </Text>
        </Group>

        {item.stance ? (
          <Badge
            radius="sm"
            variant={conceded ? 'filled' : 'outline'}
            color={conceded ? 'green' : 'ink'}
            style={{ flexShrink: 0 }}
          >
            {STANCE_LABEL[item.stance] ?? item.stance}
          </Badge>
        ) : (
          <Skeleton height={20} width={80} radius="sm" />
        )}
      </Group>

      {item.error ? (
        <FailureNote error={item.error} />
      ) : item.argument ? (
        <Markdown>{item.argument}</Markdown>
      ) : (
        <Stack gap={8}>
          <Skeleton height={8} radius="sm" />
          <Skeleton height={8} width="70%" radius="sm" />
        </Stack>
      )}

      {item.revisedAnswer && (
        <Box mt="sm" pt="sm" style={{ borderTop: '1px solid var(--quorum-line)' }}>
          <Text className="quorum-eyebrow" mb={4}>
            Revised answer
          </Text>
          <Markdown>{item.revisedAnswer}</Markdown>
        </Box>
      )}
    </Paper>
  );
}

/**
 * A provider that failed. Shown rather than hidden, and shown in place: the
 * round continued without this model (`allSettled`, not `all`), so the card that
 * says so is part of the record of what the council actually was.
 */
function FailureNote({ error }) {
  return (
    <Box>
      <Badge color="red" variant="light" radius="sm" size="sm" mb={6}>
        No response
      </Badge>
      <Text size="sm" c="var(--quorum-mute)" style={{ overflowWrap: 'anywhere' }}>
        {error}
      </Text>
    </Box>
  );
}
