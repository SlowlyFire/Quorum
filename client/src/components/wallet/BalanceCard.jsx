import { Box, Group, Progress, Stack, Text } from '@mantine/core';

import { formatCost } from '../../lib/cost.js';

/**
 * Mockup 04's left card — the balance, the brass bar, and what it buys.
 *
 * TWO CARDS IN ONE COMPONENT, because a free user has no balance to render and
 * a bar filled to zero says the wrong thing: it reads as "you spent it all",
 * when the truth is "you are on the free tier and have two debates a day". §3
 * makes those the same account with different amounts in it, so the card
 * switches on `mode` and the page above it does not have to know.
 *
 * The bar's denominator is the last top-up rather than a fixed ceiling: the
 * mockup reads "of $15.00 topped up on Aug 6", which is a fraction of a real
 * event and not of an invented maximum. A user who has never topped up has no
 * denominator at all, so there is no bar.
 */
export function BalanceCard({ wallet }) {
  return wallet.mode === 'free' ? <FreeTier wallet={wallet} /> : <FundedBalance wallet={wallet} />;
}

function Card({ label, children }) {
  return (
    <Box
      p="lg"
      h="100%"
      bg="var(--quorum-paper)"
      style={{ border: '1px solid var(--quorum-line)', borderRadius: 12 }}
    >
      <Stack gap="sm" h="100%">
        <Text size="xs" fw={700} c="var(--quorum-mute)" style={{ letterSpacing: '0.08em' }}>
          {label}
        </Text>
        {children}
      </Stack>
    </Box>
  );
}

function FundedBalance({ wallet }) {
  const topup = wallet.latestTopup;
  // Only when the last top-up is still the larger number. Spending past it and
  // topping up again would otherwise render a bar over 100%.
  const filled = topup?.amount > 0 ? Math.min(100, (wallet.displayBalance / topup.amount) * 100) : null;

  return (
    <Card label="BALANCE">
      <Text fz={{ base: 40, sm: 52 }} fw={800} lh={1.05} c="var(--quorum-ink)">
        {formatCost(wallet.displayBalance, { precise: wallet.displayBalance < 1 })}
      </Text>

      {topup && (
        <Text size="sm" c="var(--quorum-mute)">
          of {formatCost(topup.amount)} topped up on{' '}
          {new Date(topup.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </Text>
      )}

      {filled !== null && (
        <Progress value={filled} color="brass" size="md" radius="xl" bg="var(--quorum-line)" />
      )}

      <Text size="sm" c="var(--quorum-mute)" mt="auto">
        {wallet.roundsRemaining === null
          ? 'Start a debate to see what a round costs you.'
          : `≈ ${wallet.roundsRemaining.toLocaleString('en-US')} more debate${
              wallet.roundsRemaining === 1 ? '' : 's'
            } at your current council`}
      </Text>

      {/* The per-round figure is either measured from their own rounds or
          quoted from the catalogue, and the card says which. A projection
          presented as a measurement is the one thing this number must not be. */}
      <Text size="xs" c="var(--quorum-mute)">
        {wallet.perRoundSource === 'measured'
          ? `Based on ${formatCost(wallet.perRoundCost, { precise: true })} per round, your recent average.`
          : `Based on an estimated ${formatCost(wallet.perRoundCost, { precise: true })} per round.`}
      </Text>
    </Card>
  );
}

function FreeTier({ wallet }) {
  const { freeRemaining, freeRoundsPerDay } = wallet;

  return (
    <Card label="FREE PLAN">
      <Group align="baseline" gap="xs">
        <Text fz={{ base: 40, sm: 52 }} fw={800} lh={1.05} c="var(--quorum-ink)">
          {freeRemaining}
        </Text>
        <Text fz="lg" fw={600} c="var(--quorum-mute)">
          of {freeRoundsPerDay} left today
        </Text>
      </Group>

      <Text size="sm" c="var(--quorum-mute)">
        {freeRoundsPerDay} debates per day, resetting at 00:00 UTC.
      </Text>

      <Progress
        value={(freeRemaining / freeRoundsPerDay) * 100}
        color={freeRemaining === 0 ? 'gray' : 'brass'}
        size="md"
        radius="xl"
        bg="var(--quorum-line)"
      />

      <Text size="sm" c="var(--quorum-mute)" mt="auto">
        {wallet.displayBalance > 0
          ? `Your wallet holds ${formatCost(wallet.displayBalance, { precise: true })} — below the ` +
            `${formatCost(wallet.threshold)} a round of your size needs, so today's debates are free ones.`
          : 'Top up to remove the daily limit and be billed per call instead.'}
      </Text>
    </Card>
  );
}
