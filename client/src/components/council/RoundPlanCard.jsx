import { Divider, Group, Paper, Stack, Text, Tooltip } from '@mantine/core';

import { estimateRound, formatCost } from '../../lib/cost.js';

/**
 * "THIS ROUND" — the call breakdown from mockup 01, recomputed as the toggles
 * move.
 *
 * What it shows is **what will happen**, not the 2N ceiling: with the chairman
 * abstaining, drafters are the selection minus the chairman, and with rebuttals
 * off stage 3 is struck through at zero. The one thing it cannot predict is the
 * other route into that skip — a verdict of `unanimous` ends the round two calls
 * early, and nothing knows that before the chairman has read the drafts. So this
 * is the upper bound, and the estimate under it is an upper bound too.
 */
export function RoundPlanCard({ council, estimate }) {
  const { total, plan } = estimateRound(council, estimate);

  return (
    <Paper withBorder radius="md" p="lg" bg="var(--quorum-paper)" style={{ borderColor: 'var(--quorum-line)' }}>
      <Stack gap="sm">
        <Text className="quorum-eyebrow">This round</Text>

        {plan.stages.map((entry) => (
          <Group key={entry.stage} justify="space-between" wrap="nowrap" gap="md">
            <Text
              fw={500}
              c={entry.count === 0 ? 'var(--quorum-mute)' : undefined}
              td={entry.skipped ? 'line-through' : undefined}
              style={{ whiteSpace: 'nowrap' }}
            >
              {entry.count} {entry.label}
            </Text>
            <Text size="sm" c="var(--quorum-mute)" ta="right" truncate>
              {entry.skipped ? 'off' : shortNames(entry.models)}
            </Text>
          </Group>
        ))}

        <Divider color="var(--quorum-line)" my={4} />

        <Group justify="space-between" wrap="nowrap">
          <Text fw={700}>Est. per question</Text>

          {/* "est." is not hedging. OpenRouter bills whichever upstream provider
              it routed to, so the same council at the same token count costs
              different amounts on different runs (decision 16). */}
          <Tooltip
            label={`${plan.callCount} calls, priced from our own catalogue and the average tokens a stage of each kind has actually used — the billed figure is OpenRouter's.`}
            multiline
            w={280}
            withArrow
          >
            <Text fw={700} c="var(--quorum-brass)" style={{ cursor: 'help', whiteSpace: 'nowrap' }}>
              ~{formatCost(total)}
            </Text>
          </Tooltip>
        </Group>
      </Stack>
    </Paper>
  );
}

/** "Claude, GPT-5" — the mockup's shorthand, and it is what fits the column. */
export function shortNames(models) {
  if (!models || models.length === 0) return '—';

  return models.map((model) => model.displayName.split(' ')[0]).join(', ');
}
