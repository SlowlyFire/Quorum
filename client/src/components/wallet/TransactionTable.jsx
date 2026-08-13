import { Link } from 'react-router-dom';
import { Anchor, Badge, Box, Button, Center, Group, Loader, Stack, Table, Text } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';

import { transactionsCsvUrl } from '../../api/quorum.js';
import { formatCost, formatTokens } from '../../lib/cost.js';

/**
 * Mockup 04's ledger table.
 *
 * ONE ROW PER ROUND, WHICH IS NOT WHAT THE MOCKUP DRAWS. The mockup shows a row
 * per model call — "Gemini 2.5 Pro, 1,240 tokens, final, -$0.008" — and the
 * ledger writes one row per debate instead (decision 33). The per-call detail
 * still exists and is still shown, in the debate view's own transcript, which
 * is where a user is actually asking "what did this model say and what did it
 * cost". Here the question is where the balance went, and a wallet with eight
 * rows per debate cannot answer it.
 *
 * So the MODEL and TOKENS columns are kept and filled from the round: the
 * council's size, and every token the debate spent. A top-up has neither and
 * renders the mockup's em dash.
 */
export function TransactionTable({ transactions, loading, total }) {
  return (
    <Box
      p="lg"
      bg="var(--quorum-paper)"
      style={{ border: '1px solid var(--quorum-line)', borderRadius: 12 }}
    >
      <Group justify="space-between" mb="md" wrap="nowrap">
        <Text size="xs" fw={700} c="var(--quorum-mute)" style={{ letterSpacing: '0.08em' }}>
          TRANSACTIONS
        </Text>

        {/* A plain anchor, not a fetch. The browser attaches the session cookie
            by itself and honours the server's Content-Disposition filename;
            doing it through fetch would need a Blob, an object URL and a
            synthetic click to end up in the same place. */}
        <Button
          component="a"
          href={transactionsCsvUrl()}
          variant="subtle"
          size="compact-sm"
          color="gray"
          leftSection={<IconDownload size={14} />}
          disabled={!transactions?.length}
        >
          Export CSV
        </Button>
      </Group>

      {loading && (
        <Center py="xl">
          <Loader color="ink" size="sm" />
        </Center>
      )}

      {!loading && transactions?.length === 0 && (
        <Stack gap={8} py="lg" align="flex-start">
          <Text c="var(--quorum-mute)">No transactions yet.</Text>
          <Text size="sm" c="var(--quorum-mute)">
            Free debates do not appear here — nothing is charged for them, so there is nothing to
            record. Your rounds are all in the session history either way.
          </Text>
          {/* An empty list that only explains itself leaves the user nowhere to
              go. Both routes out of this state are one click. */}
          {/* One action, and deliberately not "Add credits" — the card that does
              that is already on this screen, a few hundred pixels up. The thing
              a user with an empty ledger actually needs is the thing that is not
              in front of them. */}
          <Button component={Link} to="/new" size="xs" variant="default" mt={4}>
            Start a debate
          </Button>
        </Stack>
      )}

      {!loading && transactions?.length > 0 && (
        <Box style={{ overflowX: 'auto' }}>
          <Table verticalSpacing="sm" horizontalSpacing="md" miw={640}>
            <Table.Thead>
              <Table.Tr>
                <HeaderCell>WHEN</HeaderCell>
                <HeaderCell>SESSION</HeaderCell>
                <HeaderCell>MODELS</HeaderCell>
                <HeaderCell align="right">TOKENS</HeaderCell>
                <HeaderCell>TYPE</HeaderCell>
                <HeaderCell align="right">AMOUNT</HeaderCell>
              </Table.Tr>
            </Table.Thead>

            <Table.Tbody>
              {transactions.map((row) => (
                <TransactionRow key={row.id} row={row} />
              ))}
            </Table.Tbody>
          </Table>

          {total > transactions.length && (
            <Text size="sm" c="var(--quorum-mute)" mt="md">
              Showing the {transactions.length} most recent of {total}. The CSV export carries more.
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function HeaderCell({ children, align }) {
  return (
    <Table.Th ta={align}>
      <Text size="xs" fw={700} c="var(--quorum-mute)" style={{ letterSpacing: '0.06em' }}>
        {children}
      </Text>
    </Table.Th>
  );
}

/** Credits green, debits ink — the mockup's two chip colours. */
const CHIP = {
  topup: { label: 'top-up', color: 'green' },
  bonus: { label: 'bonus', color: 'green' },
  refund: { label: 'refund', color: 'green' },
  debit: { label: 'debit', color: 'gray' },
};

function TransactionRow({ row }) {
  const chip = CHIP[row.type] ?? { label: row.type, color: 'gray' };
  const isCredit = row.amount > 0;

  return (
    <Table.Tr>
      <Table.Td>
        <Text size="sm" c="var(--quorum-mute)" style={{ whiteSpace: 'nowrap' }}>
          {new Date(row.createdAt).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })}
        </Text>
      </Table.Td>

      <Table.Td>
        {row.sessionId ? (
          <Anchor component={Link} to={`/chat/${row.sessionId}`} c="var(--quorum-ink)" underline="hover">
            <Text size="sm" lineClamp={1}>
              {row.sessionTitle ?? 'Untitled session'}
            </Text>
          </Anchor>
        ) : (
          <Dash />
        )}
      </Table.Td>

      <Table.Td>
        {row.modelCount ? (
          <Text size="sm" c="var(--quorum-mute)">
            {row.modelCount} model{row.modelCount === 1 ? '' : 's'}
          </Text>
        ) : (
          <Dash />
        )}
      </Table.Td>

      <Table.Td ta="right">
        {row.tokens ? (
          <Text size="sm" c="var(--quorum-mute)">
            {formatTokens(row.tokens)}
          </Text>
        ) : (
          <Dash />
        )}
      </Table.Td>

      <Table.Td>
        <Badge variant="light" color={chip.color} radius="sm">
          {chip.label}
        </Badge>
      </Table.Td>

      <Table.Td ta="right">
        <Text
          fw={700}
          size="sm"
          c={isCredit ? 'var(--quorum-green)' : 'var(--quorum-ink)'}
          style={{ whiteSpace: 'nowrap' }}
        >
          {isCredit ? '+' : '−'}
          {formatCost(Math.abs(row.amount), { precise: Math.abs(row.amount) < 1 })}
        </Text>
      </Table.Td>
    </Table.Tr>
  );
}

function Dash() {
  return (
    <Text size="sm" c="var(--quorum-mute)">
      —
    </Text>
  );
}
