import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Anchor,
  Box,
  Button,
  Center,
  Divider,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconArrowRight, IconLock } from '@tabler/icons-react';

import { ErrorAlert } from '../components/ErrorAlert.jsx';
import { Logo } from '../components/Logo.jsx';
import { ModelBadge } from '../components/ModelBadge.jsx';
import { RoundView } from '../components/debate/RoundView.jsx';
import { fetchSharedSession } from '../api/quorum.js';
import { roundFromDetail } from '../lib/round.js';
import { PageContainer } from '../components/PageContainer.jsx';

/**
 * /s/:shareToken — the only unauthenticated read surface in the product (§6).
 *
 * It renders its own header rather than the AppShell, because there is no user:
 * no credits chip, no account menu, no nav to pages that would bounce a visitor
 * to /login. In its place is one CTA, which is the entire commercial point of a
 * public link.
 *
 * READ-ONLY IS THE ABSENCE OF THINGS, NOT A MODE. There is no composer, no
 * council editor, no sidebar and no spend rail — they are simply not rendered,
 * rather than rendered disabled. A disabled composer on a page with no account
 * behind it invites a visitor to try, and `RoundView` needs no `readOnly` prop
 * because everything interactive on this page lives outside it.
 *
 * Costs are absent for a stronger reason than layout: the server's payload has
 * no cost field in it at any depth (see shareService), so there is nothing here
 * to hide. `lib/round.js` carries a null total and the footer omits the figure.
 *
 * A 404 IS A NORMAL OUTCOME, not an error. An unknown token and a revoked one
 * are deliberately indistinguishable, so this page handles it as its own state
 * with its own copy rather than letting it reach the ErrorBoundary as a crash.
 */
export function Shared() {
  const { shareToken } = useParams();

  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    setSession(null);
    setError(null);

    async function load() {
      try {
        const data = await fetchSharedSession(shareToken);
        if (!cancelled) setSession(data);
      } catch (cause) {
        if (!cancelled) setError(cause);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [shareToken]);

  return (
    <Box mih="100vh" bg="var(--quorum-panel)">
      <SharedHeader />

      <PageContainer py="xl">
        {error?.status === 404 ? (
          <LinkNotFound />
        ) : error ? (
          <ErrorAlert error={error} title="Could not load this debate" />
        ) : !session ? (
          <Center py={120}>
            <Loader color="ink" />
          </Center>
        ) : (
          <SharedSession session={session} />
        )}
      </PageContainer>
    </Box>
  );
}

function SharedHeader() {
  return (
    <Box
      component="header"
      h={64}
      px={{ base: 'md', sm: 'xl' }}
      bg="var(--quorum-paper)"
      style={{ borderBottom: '1px solid var(--quorum-line)' }}
    >
      <Group h="100%" justify="space-between" wrap="nowrap">
        <Link to="/" style={{ textDecoration: 'none' }}>
          <Logo />
        </Link>

        <Group gap="md" wrap="nowrap">
          <Text size="sm" c="var(--quorum-mute)" visibleFrom="sm">
            Shared debate · read only
          </Text>
          <Button
            component={Link}
            to="/register"
            size="sm"
            rightSection={<IconArrowRight size={14} />}
          >
            Try Quorum
          </Button>
        </Group>
      </Group>
    </Box>
  );
}

function SharedSession({ session }) {
  const rounds = (session.rounds ?? []).map(roundFromDetail);
  const models = session.council?.models ?? [];

  return (
    <Stack gap="xl">
      <Stack gap="sm">
        <Text className="quorum-eyebrow">Shared debate</Text>

        <Title order={1} fz={{ base: 26, sm: 34 }}>
          {session.title ?? 'Untitled session'}
        </Title>

        <Group gap="sm" wrap="wrap">
          <Group gap={6} wrap="nowrap">
            {models.map((model) => (
              <Group key={model.modelId} gap={6} wrap="nowrap">
                <ModelBadge model={model} size={22} fz={12} />
                <Text size="sm" c="var(--quorum-mute)">
                  {model.displayName}
                  {model.isChairman ? ' (chair)' : ''}
                </Text>
              </Group>
            ))}
          </Group>
        </Group>

        <Text size="sm" c="var(--quorum-mute)">
          {session.roundCount} {session.roundCount === 1 ? 'question' : 'questions'} ·{' '}
          {new Date(session.createdAt).toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          })}
        </Text>
      </Stack>

      <Divider color="var(--quorum-line)" />

      {rounds.length === 0 ? (
        <Text c="var(--quorum-mute)">This session has no debates in it yet.</Text>
      ) : (
        <Stack gap="xl">
          {rounds.map((round) => (
            <RoundView key={round.id} round={round} />
          ))}
        </Stack>
      )}

      <Paper
        radius="md"
        p="lg"
        bg="var(--quorum-brass-bg)"
        style={{ border: '1px solid var(--quorum-brass-border)' }}
      >
        <Group justify="space-between" gap="md" wrap="wrap">
          <Stack gap={2}>
            <Text fw={700}>Ask your own question</Text>
            <Text size="sm" c="var(--quorum-mute)">
              Four models, one answer they argued their way to. Two free debates a day.
            </Text>
          </Stack>
          <Button component={Link} to="/register">
            Create an account
          </Button>
        </Group>
      </Paper>
    </Stack>
  );
}

/**
 * The 404. Deliberately says nothing about which of the two happened — a page
 * that distinguished "revoked" from "never existed" would confirm to whoever
 * holds a leaked link that it was once real, which is the fact revoking has to
 * stop telling anyone.
 */
function LinkNotFound() {
  return (
    <Stack gap="md" align="center" py={80}>
      <Box
        w={56}
        h={56}
        style={{
          borderRadius: 999,
          background: 'var(--quorum-paper)',
          border: '1px solid var(--quorum-line)',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--quorum-mute)',
        }}
      >
        <IconLock size={24} />
      </Box>

      <Title order={2} fz={{ base: 22, sm: 28 }} ta="center">
        This link is not available
      </Title>

      <Text c="var(--quorum-mute)" ta="center" maw={440}>
        The debate behind it was never shared, or the person who shared it has since revoked the
        link. If someone sent it to you, ask them for a new one.
      </Text>

      <Group gap="sm" mt="xs">
        <Button component={Link} to="/">
          Go to Quorum
        </Button>
        <Anchor component={Link} to="/login" c="var(--quorum-mute)">
          Sign in
        </Anchor>
      </Group>
    </Stack>
  );
}
