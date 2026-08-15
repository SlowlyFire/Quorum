import { useState } from 'react';
import { Anchor, Badge, Box, Group, Modal, Paper, Stack, Text } from '@mantine/core';

import { Markdown } from '../Markdown.jsx';
import { ModelBadge } from '../ModelBadge.jsx';
import { STANCE_LABEL } from '../../lib/round.js';
import { formatCost, formatDuration } from '../../lib/cost.js';
import { plainExcerpt } from '../../lib/excerpt.js';

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
export function DraftCard({ item, pending = false, index = 0 }) {
  const [open, setOpen] = useState(false);

  if (pending) return <PendingCard />;

  return (
    <>
      <Paper
        withBorder
        radius="md"
        p="md"
        bg="var(--quorum-paper)"
        /**
         * Stage 1 fans out with `Promise.allSettled`, so two models finishing
         * within a frame of each other would otherwise pop in simultaneously and
         * read as a layout jump rather than as two answers arriving. 60ms of
         * stagger is below the threshold where it looks like a queue and above
         * the one where it looks like a single event.
         *
         * Keyed on the card's position rather than on arrival order, so a replay
         * of the SSE buffer (which happens on every reconnect) staggers the same
         * way it did the first time.
         */
        className="quorum-enter"
        style={{
          borderColor: 'var(--quorum-line)',
          display: 'flex',
          flexDirection: 'column',
          '--quorum-enter-delay': `${Math.min(index, 6) * 60}ms`,
        }}
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
            {/**
             * PLAIN TEXT, NOT MARKDOWN, AND THAT IS THE FIX RATHER THAN A
             * SIMPLIFICATION. This was a `-webkit-box` with `WebkitLineClamp: 3`
             * wrapped around `<Markdown>`, and `-webkit-line-clamp` only clamps
             * inline content: the block children markdown emits — `h1`, `p`,
             * `li` — were laid out on top of one another, so a draft that opened
             * with a heading printed its first paragraph through the heading.
             *
             * Mantine's `lineClamp` is what every other clamp in this client
             * uses, and it wants a text node, which `plainExcerpt` supplies.
             * The full answer is markdown in the modal below, rendered by the
             * thing that knows the grammar.
             */}
            <Text style={{ flex: 1 }} lineClamp={3}>
              {plainExcerpt(item.content)}
            </Text>

            <Anchor component="button" type="button" mt="sm" size="sm" onClick={() => setOpen(true)}>
              Read full answer ›
            </Anchor>
          </>
        ) : (
          <ShimmerBar h={48} radius={6} />
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
 *
 * The bars shimmer. On a round where a model can take twenty seconds, a static
 * grey bar is indistinguishable from a bar that is part of the design — the
 * shimmer is the only thing saying the wait is expected rather than stuck.
 */
function PendingCard() {
  return (
    <Paper withBorder radius="md" p="md" bg="var(--quorum-paper)" style={{ borderColor: 'var(--quorum-line)' }}>
      <Group gap="sm" wrap="nowrap" mb="sm">
        <ShimmerBar h={28} w={28} radius={999} />
        <Stack gap={6} style={{ flex: 1 }}>
          <ShimmerBar h={10} w="45%" />
          <ShimmerBar h={8} w="30%" />
        </Stack>
      </Group>

      <Stack gap={8}>
        <ShimmerBar h={8} />
        <ShimmerBar h={8} w="85%" />
        <ShimmerBar h={8} w="60%" />
      </Stack>
    </Paper>
  );
}

/**
 * The one skeleton primitive in the product.
 *
 * Not Mantine's `Skeleton`, for the reduced-motion rule: Mantine animates its
 * own pulse from inside its stylesheet, which `global.css` cannot switch off
 * without reaching into a third party's class names. This is a div with a class
 * that the one media query already covers.
 */
export function ShimmerBar({ h = 8, w = '100%', radius = 4 }) {
  return (
    <Box
      className="quorum-shimmer"
      style={{ height: h, width: w, borderRadius: radius, flexShrink: 0 }}
    />
  );
}

/**
 * Stage 3 — one card per drafter with its stance. CONCEDES is green on green,
 * per the mockup, and it is the chip worth colouring: a model withdrawing its
 * own point is the single clearest evidence the debate did something.
 */
export function RebuttalCard({ item, index = 0 }) {
  const conceded = item.stance === 'concede';

  return (
    <Paper
      withBorder
      radius="md"
      p="md"
      bg={conceded ? 'green.0' : 'var(--quorum-paper)'}
      className="quorum-enter"
      style={{
        borderColor: conceded ? 'var(--mantine-color-green-2)' : 'var(--quorum-line)',
        '--quorum-enter-delay': `${Math.min(index, 6) * 60}ms`,
        // The card turns green when the stance frame lands, which can be after
        // the card itself. A transition rather than an animation, so it is
        // information that survives reduced motion.
        transition: 'background-color 250ms ease, border-color 250ms ease',
      }}
    >
      <Group justify="space-between" wrap="nowrap" mb="sm" gap="sm">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <ModelBadge model={item.modelName} />
          <Text fw={700} truncate>
            {item.modelName}
          </Text>
        </Group>

        {item.stance ? (
          /**
           * CONCEDES overshoots to 1.06 and settles; DEFENDS and REVISES fade
           * in without it. That asymmetry is the point: a model withdrawing its
           * own point is the single clearest evidence the debate did something,
           * and it is the only element in the product that scales past 1. Giving
           * all three the same entrance would say the three outcomes are equally
           * interesting, which is exactly what the mockup's green chip denies.
           */
          <Badge
            key={item.stance}
            radius="sm"
            variant={conceded ? 'filled' : 'outline'}
            color={conceded ? 'green' : 'ink'}
            className={conceded ? 'quorum-stance-in' : 'quorum-stance-in-quiet'}
            style={{ flexShrink: 0 }}
          >
            {STANCE_LABEL[item.stance] ?? item.stance}
          </Badge>
        ) : (
          <ShimmerBar h={20} w={80} radius={4} />
        )}
      </Group>

      {item.error ? (
        <FailureNote error={item.error} />
      ) : item.argument ? (
        <Markdown>{item.argument}</Markdown>
      ) : (
        <Stack gap={8}>
          <ShimmerBar h={8} />
          <ShimmerBar h={8} w="70%" />
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
