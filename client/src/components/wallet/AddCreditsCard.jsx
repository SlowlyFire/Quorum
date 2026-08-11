import { useState } from 'react';
import { Box, Button, Group, Radio, Stack, Text, UnstyledButton } from '@mantine/core';

import { ErrorAlert } from '../ErrorAlert.jsx';
import { startCheckout } from '../../api/quorum.js';
import { formatCost } from '../../lib/cost.js';

/**
 * Mockup 04's middle card — three amounts, $15 preselected, and the note that
 * says which mode Stripe is in.
 *
 * The amounts come from the server (`wallet.topupAmounts`), not from a constant
 * here. They are an allow-list that decides both what Stripe charges and what
 * we credit, so the three buttons must be the three the server will accept — a
 * fourth written down in the client would render, submit, and 400.
 *
 * "Stripe · test mode" is on the card because it is true and because a payment
 * form that does not say so is a form a user might reasonably enter a real card
 * into. The test card number belongs in the docs, not on the screen, but the
 * mode belongs on the screen.
 */
export function AddCreditsCard({ wallet }) {
  const amounts = wallet.topupAmounts ?? [];
  // $15 is the mockup's preselection; the middle amount is the fallback if the
  // server's list ever changes shape.
  const [amount, setAmount] = useState(() => (amounts.includes(15) ? 15 : amounts[1] ?? amounts[0]));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function handleAdd() {
    setError(null);
    setSubmitting(true);

    try {
      const checkout = await startCheckout(amount);

      /**
       * A full navigation rather than a new tab. Checkout is a hosted page that
       * brings the user back to /wallet by itself, so this is one flow across
       * two origins and not a detour — and a popup would be blocked as often as
       * not, since this click is several awaits away from the user's gesture.
       */
      window.location.assign(checkout.url);
    } catch (cause) {
      setError(cause);
      setSubmitting(false);
    }
  }

  /** Whole debates each amount buys, at what a round costs this user. */
  const debatesFor = (value) =>
    wallet.perRoundCost > 0 ? Math.floor(value / wallet.perRoundCost).toLocaleString('en-US') : null;

  return (
    <Box
      p="lg"
      h="100%"
      bg="var(--quorum-paper)"
      style={{ border: '1px solid var(--quorum-line)', borderRadius: 12 }}
    >
      <Stack gap="sm" h="100%">
        <Text size="xs" fw={700} c="var(--quorum-mute)" style={{ letterSpacing: '0.08em' }}>
          ADD CREDITS
        </Text>

        <Stack gap="xs">
          {amounts.map((value) => {
            const selected = value === amount;
            const debates = debatesFor(value);

            return (
              <UnstyledButton
                key={value}
                onClick={() => setAmount(value)}
                disabled={submitting}
                p="sm"
                style={{
                  borderRadius: 10,
                  border: `1px solid ${selected ? 'var(--quorum-brass-border)' : 'var(--quorum-line)'}`,
                  background: selected ? 'var(--quorum-brass-bg)' : 'transparent',
                }}
              >
                <Group justify="space-between" wrap="nowrap">
                  <Group gap="sm" wrap="nowrap">
                    <Radio
                      checked={selected}
                      onChange={() => setAmount(value)}
                      color="brass"
                      tabIndex={-1}
                      aria-label={`Add $${value}`}
                    />
                    <Text fw={700} c="var(--quorum-ink)">
                      ${value}
                    </Text>
                  </Group>

                  {debates && (
                    <Text size="sm" c="var(--quorum-mute)">
                      ~{debates} debates
                    </Text>
                  )}
                </Group>
              </UnstyledButton>
            );
          })}
        </Stack>

        {error && <ErrorAlert error={error} title="Could not start the top-up" />}

        <Button size="md" fullWidth mt="auto" onClick={handleAdd} loading={submitting}>
          Add ${amount}
        </Button>

        <Text size="xs" c="var(--quorum-mute)" ta="center">
          Stripe · test mode
        </Text>

        <Text size="xs" c="var(--quorum-mute)" ta="center">
          Credits are applied when Stripe confirms the payment, which is usually
          before you are back on this page.
        </Text>
      </Stack>
    </Box>
  );
}

/** Exported for the top-up prompt in the debate view, which shows one price. */
export function amountLabel(value) {
  return formatCost(value);
}
