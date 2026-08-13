import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Center, Grid, Loader, Stack, Title } from '@mantine/core';
import { IconCheck, IconInfoCircle } from '@tabler/icons-react';

import { AddCreditsCard } from '../components/wallet/AddCreditsCard.jsx';
import { BalanceCard } from '../components/wallet/BalanceCard.jsx';
import { ErrorAlert } from '../components/ErrorAlert.jsx';
import { SpendChart } from '../components/wallet/SpendChart.jsx';
import { TransactionTable } from '../components/wallet/TransactionTable.jsx';
import { fetchTransactions, fetchWallet } from '../api/quorum.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PageContainer } from '../components/PageContainer.jsx';

/**
 * Mockup 04 — the wallet.
 *
 * Two requests on open: the summary the three cards render, and the first page
 * of the ledger. They are separate endpoints because they change at different
 * rates and for different reasons — a round moves the balance and the chart, a
 * page of history moves neither — and because the CSV export is the transaction
 * endpoint with one query parameter changed.
 *
 * THE RETURN FROM STRIPE IS THE ONE PIECE OF STATE THIS PAGE DID NOT ASK FOR.
 * Checkout sends the browser back to `/wallet?topup=success`, and that URL is
 * NOT evidence a payment happened: it is a redirect a user can type. The credit
 * arrives over the webhook, on Stripe's schedule, which is usually but not
 * always before the browser is back here. So the banner says a top-up is on its
 * way rather than that it landed, and the balance shown is whatever the server
 * says — refetched once a second or so later, because "usually before" is not
 * "always before" and a user who sees their old balance will reload anyway.
 */
export function Wallet() {
  const { refreshUser } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [wallet, setWallet] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [error, setError] = useState(null);

  const topupResult = searchParams.get('topup');

  const load = useCallback(async () => {
    const [summary, transactions] = await Promise.all([fetchWallet(), fetchTransactions({ limit: 50 })]);

    setWallet(summary);
    setLedger(transactions);

    // The header's credits chip reads user.creditBalance, which was fetched at
    // sign-in. Reloading it here is what makes the chip and this page agree.
    void refreshUser();

    return summary;
  }, [refreshUser]);

  useEffect(() => {
    let cancelled = false;

    async function initial() {
      try {
        await load();
      } catch (cause) {
        if (!cancelled) setError(cause);
      }
    }

    void initial();

    return () => {
      cancelled = true;
    };
  }, [load]);

  /**
   * The second look, after a return from Checkout. The webhook and the redirect
   * are two independent races back to this page and neither is guaranteed to
   * win, so one delayed refetch turns "your balance has not moved" into "your
   * balance moved a moment later" for the overwhelming majority of top-ups —
   * without a polling loop for an event that has already happened.
   */
  useEffect(() => {
    if (topupResult !== 'success') return undefined;

    const timer = setTimeout(() => {
      void load().catch(() => {});
    }, 2500);

    return () => clearTimeout(timer);
  }, [topupResult, load]);

  function dismissBanner() {
    // Clears the query string without a navigation, so a refresh does not bring
    // the banner back and the back button does not return to a paid checkout.
    setSearchParams({}, { replace: true });
  }

  if (error) {
    return (
      <PageContainer py="xl">
        <ErrorAlert error={error} title="Could not load your wallet" />
      </PageContainer>
    );
  }

  if (!wallet) {
    return (
      <Center py={120}>
        <Loader color="ink" />
      </Center>
    );
  }

  return (
    <PageContainer>
      <Stack gap="xl">
        <Title order={1} fz={{ base: 28, sm: 40 }}>
          Wallet
        </Title>

        {topupResult === 'success' && (
          <Alert
            color="green"
            icon={<IconCheck size={18} />}
            title="Payment received"
            withCloseButton
            onClose={dismissBanner}
          >
            Stripe has your payment. Credits land as soon as it confirms them with us — usually
            within a few seconds, and this page updates itself when they do.
          </Alert>
        )}

        {topupResult === 'cancelled' && (
          <Alert
            color="gray"
            icon={<IconInfoCircle size={18} />}
            title="Top-up cancelled"
            withCloseButton
            onClose={dismissBanner}
          >
            Nothing was charged and your balance is unchanged.
          </Alert>
        )}

        <Grid gutter="lg" align="stretch">
          <Grid.Col span={{ base: 12, md: 4 }}>
            <BalanceCard wallet={wallet} />
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 4 }}>
            <AddCreditsCard wallet={wallet} />
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 4 }}>
            <SpendChart days={wallet.spendByDay} total={wallet.spendTotal} />
          </Grid.Col>
        </Grid>

        <TransactionTable
          transactions={ledger?.transactions}
          total={ledger?.pagination?.total ?? 0}
          loading={!ledger}
        />
      </Stack>
    </PageContainer>
  );
}
