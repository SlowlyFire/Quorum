import { ActionIcon, Button, Group, Paper, Stack, Text, Textarea, Tooltip } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';

import { estimateRound, formatCost } from '../../lib/cost.js';

/**
 * "Ask a follow-up…" — the composer at the foot of the thread.
 *
 * Disabled while a round runs, and that is a product decision rather than a
 * technical one: the server would happily start a second debate, and the two
 * would interleave in one thread while both spent money. A round is 8–47
 * seconds, which is short enough to wait for and long enough that the button
 * has to say why it will not press.
 *
 * The estimate beside it is the same arithmetic as the council picker's, over
 * the session's stored council. It is labelled "est." for decision 16's reason:
 * OpenRouter bills whichever upstream provider it routed to.
 */
export function Composer({ value, onChange, onSend, disabled, running, session, models, estimate }) {
  const selected = models.filter((model) =>
    session.council.models.some((member) => member.id === model.id),
  );

  const { total } = estimateRound(
    {
      selected,
      chairmanId: session.council.chairmanId,
      chairmanAbstains: session.chairmanAbstains,
      rebuttalEnabled: session.rebuttalEnabled,
    },
    estimate,
  );

  const canSend = value.trim().length > 0 && !disabled;

  function handleKeyDown(event) {
    // Enter sends, Shift+Enter breaks the line — the convention every chat
    // surface has taught. A question can be several paragraphs, so the escape
    // hatch matters as much as the shortcut.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSend();
    }
  }

  return (
    <Paper
      withBorder
      radius="md"
      p="sm"
      bg="var(--quorum-paper)"
      style={{ borderColor: 'var(--quorum-line)' }}
    >
      <Stack gap="xs">
        <Group gap="sm" align="flex-end" wrap="nowrap">
          <Tooltip label="Attachments arrive in Session 11" withArrow>
            <ActionIcon variant="subtle" color="gray" size="lg" radius="xl" disabled aria-label="Attach a file">
              <IconPlus size={18} />
            </ActionIcon>
          </Tooltip>

          <Textarea
            variant="unstyled"
            placeholder={running ? 'The council is deliberating…' : 'Ask a follow-up…'}
            autosize
            minRows={1}
            maxRows={8}
            maxLength={8000}
            value={value}
            onChange={(event) => onChange(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            style={{ flex: 1 }}
            aria-label="Your question"
          />

          <Button onClick={onSend} disabled={!canSend} loading={running}>
            Send
          </Button>
        </Group>

        <Group justify="space-between" gap="sm" px="xs">
          <Text size="xs" c="var(--quorum-mute)">
            {running ? 'One round at a time — this one is still running.' : 'Enter to send, Shift+Enter for a new line.'}
          </Text>
          <Text size="xs" c="var(--quorum-mute)">
            est. ~{formatCost(total)} per question
          </Text>
        </Group>
      </Stack>
    </Paper>
  );
}
