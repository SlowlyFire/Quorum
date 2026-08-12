import { useCallback, useEffect, useState } from 'react';
import { Box, Button, Container, Group, Loader, Paper, Stack, Text, Title } from '@mantine/core';

import { ErrorAlert } from '../components/ErrorAlert.jsx';
import { Podium } from '../components/leaderboard/Podium.jsx';
import { SelfPreferenceCard } from '../components/leaderboard/SelfPreferenceCard.jsx';
import { StandingsTable } from '../components/leaderboard/StandingsTable.jsx';
import { UnrankedList } from '../components/leaderboard/UnrankedList.jsx';
import { fetchLeaderboard } from '../api/quorum.js';
import { DEFAULT_SCOPE, SCOPE_TABS } from '../lib/leaderboard.js';

/**
 * Mockup 07 — the podium and the full standings.
 *
 * Everything on this page is the server's arithmetic. §4's scoring rules live in
 * one SQL query (see the server's `leaderboardModel`, which carries the two
 * traps that make it easy to get wrong), the five-draft threshold travels with
 * the response as `minDrafts`, and the page multiplies nothing — it formats.
 * A percentage recomputed here would be a second implementation of a ranking
 * rule, and the two would disagree the first time either moved.
 */
const WINDOW_DAYS = 30;

export function Leaderboard() {
  const [scope, setScope] = useState(DEFAULT_SCOPE);
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async (nextScope) => {
    setLoading(true);
    setError(null);

    try {
      setBoard(await fetchLeaderboard({ scope: nextScope, days: WINDOW_DAYS }));
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(scope);
  }, [load, scope]);

  return (
    <Container size="xl" py={{ base: 'lg', sm: 'xl' }}>
      <Stack gap="lg">
        <Box>
          <Title order={1} fz={{ base: 30, sm: 40 }}>
            Leaderboard
          </Title>
          <Text c="var(--quorum-mute)" mt={4} fz={{ base: 'sm', sm: 'md' }}>
            Win rate across rounds drafted. Rounds spent as chairman are excluded.
          </Text>
        </Box>

        <Group justify="space-between" gap="sm">
          <Group gap="xs">
            {SCOPE_TABS.map((tab) => (
              <ScopeButton
                key={tab.key}
                active={scope === tab.key}
                onClick={() => setScope(tab.key)}
              >
                {tab.label}
              </ScopeButton>
            ))}
          </Group>

          <PeriodChip days={board?.days ?? WINDOW_DAYS} />
        </Group>

        {error && <ErrorAlert error={error} />}

        {loading && !board && (
          <Group justify="center" py="xl">
            <Loader size="sm" color="ink" />
          </Group>
        )}

        {board && !error && <Board board={board} scope={scope} onSwitchScope={setScope} />}

        {/*
          Below the standings, and outside <Board> on purpose: it is a published
          result about the models rather than a view of this board's data, so it
          does not change with the scope toggle and must not appear to.
        */}
        <SelfPreferenceCard />
      </Stack>
    </Container>
  );
}

function Board({ board, scope, onSwitchScope }) {
  if (board.ranked.length === 0) {
    return (
      <Stack gap="lg">
        <EmptyState board={board} scope={scope} onSwitchScope={onSwitchScope} />
        <UnrankedList standings={board.unranked} minDrafts={board.minDrafts} />
      </Stack>
    );
  }

  return (
    <Stack gap="lg">
      {/* The scope IS the run key: switching My council / All time replaces the
          numbers being compared, so the podium re-runs rather than swapping
          figures silently under three blocks that never moved. */}
      <Podium standings={board.ranked.slice(0, board.podiumSize)} runKey={scope} />
      <StandingsTable standings={board.ranked} />
      <UnrankedList standings={board.unranked} minDrafts={board.minDrafts} />
    </Stack>
  );
}

/**
 * WHY THIS SAYS WHAT IT SAYS. An empty podium invites exactly one conclusion —
 * the feature is broken — so the empty state explains the rule that produced it
 * instead of drawing three blank blocks. The two ways out are named, and the
 * one that works immediately (switch to every user's rounds) is a button rather
 * than a sentence, because "My council" being empty is the common case and the
 * remedy is one click.
 */
function EmptyState({ board, scope, onSwitchScope }) {
  const hasSome = board.unranked.length > 0;

  return (
    <Paper
      withBorder
      radius="md"
      p="xl"
      bg="var(--quorum-paper)"
      style={{ borderColor: 'var(--quorum-line)' }}
    >
      <Stack gap="sm" align="flex-start">
        <Text fw={700} fz="lg" c="var(--quorum-ink)">
          {hasSome ? 'No model has debated enough yet' : 'Nothing to rank yet'}
        </Text>

        <Text c="var(--quorum-mute)" maw={620}>
          A model needs {board.minDrafts} drafts in the last {board.days} days before it is ranked,
          so that a single lucky win cannot top the podium.{' '}
          {hasSome
            ? 'The models below are on their way there.'
            : 'Run a debate and the standings fill in from its drafts.'}
        </Text>

        {scope === 'mine' && (
          <Button variant="light" color="ink" mt="xs" onClick={() => onSwitchScope('all')}>
            See every user's rounds
          </Button>
        )}
      </Stack>
    </Paper>
  );
}

/** Mockup 07's pill pair: the selected one is filled ink, the other outlined. */
function ScopeButton({ active, onClick, children }) {
  return (
    <Button
      onClick={onClick}
      radius="xl"
      size="sm"
      px="lg"
      variant={active ? 'filled' : 'default'}
      color="ink"
      style={active ? undefined : { borderColor: 'var(--quorum-line)', color: 'var(--quorum-mute)' }}
    >
      {children}
    </Button>
  );
}

/**
 * Static, because the window is. §8 fixes `days=30` and the mockup draws one
 * chip; the API takes any window up to a year, so this is a label rather than a
 * control until there is a second period worth offering.
 */
function PeriodChip({ days }) {
  return (
    <Box
      px="lg"
      py={7}
      style={{
        background: 'var(--quorum-paper)',
        border: '1px solid var(--quorum-line)',
        borderRadius: 999,
        whiteSpace: 'nowrap',
      }}
    >
      <Text size="sm" c="var(--quorum-mute)">
        Last {days} days
      </Text>
    </Box>
  );
}
