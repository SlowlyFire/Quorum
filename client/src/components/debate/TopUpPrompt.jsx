import { Link } from 'react-router-dom';
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { IconWallet } from '@tabler/icons-react';

import { formatCost } from '../../lib/cost.js';

/**
 * What a 402 from POST /rounds looks like on the screen.
 *
 * A user who has spent their two free debates must never meet a wall with no
 * explanation, and "Request failed with status 402" is a wall. So the server's
 * 402 carries a `billing` block — the estimate, the balance, and how many free
 * debates are left — and this renders it as the three facts and the one action.
 *
 * TWO REFUSALS, TWO SENTENCES, because they have different remedies. An empty
 * wallet that has used the allowance (DAILY_LIMIT_REACHED) can top up or wait
 * for UTC midnight. A funded wallet too small for THIS council
 * (INSUFFICIENT_CREDIT) can also shrink the council, which is free and
 * immediate — so it is offered first.
 *
 * Rendered inline in the thread, under the composer that just refused, rather
 * than as a notification. The question the user typed is still in the box and
 * still valid; this is about what happens when they press Send again.
 */
export function TopUpPrompt({ error }) {
  const billing = error?.billing ?? null;
  const isInsufficient = error?.code === 'INSUFFICIENT_CREDIT';

  return (
    <Alert
      color="brass"
      variant="light"
      icon={<IconWallet size={18} />}
      title={isInsufficient ? 'Not enough credit for this council' : "That is today's free debates"}
    >
      <Stack gap="sm">
        <Text size="sm">{error?.message}</Text>

        {billing && (
          <Group gap="lg" wrap="wrap">
            <Figure label="This round, est." value={formatCost(billing.estimate, { precise: true })} />
            <Figure label="Your balance" value={formatCost(Math.max(0, billing.balance), { precise: true })} />
            <Figure label="Free debates left today" value={String(billing.freeRemaining ?? 0)} />
          </Group>
        )}

        <Group gap="sm">
          <Button component={Link} to="/wallet" size="xs" leftSection={<IconWallet size={14} />}>
            Top up
          </Button>

          {isInsufficient && (
            <Text size="xs" c="var(--quorum-mute)">
              Or drop a model from the council on the right — a smaller council costs less and may
              already be affordable.
            </Text>
          )}
        </Group>
      </Stack>
    </Alert>
  );
}

function Figure({ label, value }) {
  return (
    <Stack gap={0}>
      <Text size="xs" c="var(--quorum-mute)">
        {label}
      </Text>
      <Text fw={700} size="sm" c="var(--quorum-ink)">
        {value}
      </Text>
    </Stack>
  );
}
