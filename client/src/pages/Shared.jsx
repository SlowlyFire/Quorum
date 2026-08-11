import { Link, useParams } from 'react-router-dom';
import { Anchor, Box, Container, Group, Paper, Stack, Text, Title } from '@mantine/core';

import { Logo } from '../components/Logo.jsx';

/**
 * The only unauthenticated read surface in the product (§6), so it renders its
 * own header rather than the AppShell — there is no user, no credits chip and
 * no account menu to put in one.
 */
export function Shared() {
  const { shareToken } = useParams();

  return (
    <Box mih="100vh" bg="var(--quorum-panel)">
      <Box
        component="header"
        h={64}
        px={{ base: 'md', sm: 'xl' }}
        bg="var(--quorum-paper)"
        style={{ borderBottom: '1px solid var(--quorum-line)' }}
      >
        <Group h="100%" justify="space-between">
          <Link to="/" style={{ textDecoration: 'none' }}>
            <Logo />
          </Link>
          <Anchor component={Link} to="/register" fw={600} c="var(--quorum-brass)">
            Run your own debate
          </Anchor>
        </Group>
      </Box>

      <Container size="md" py="xl">
        <Stack gap="lg">
          <Stack gap={6}>
            <Text className="quorum-eyebrow">Shared result</Text>
            <Title order={1} fz={{ base: 28, sm: 34 }}>
              A public debate record
            </Title>
          </Stack>

          <Paper
            withBorder
            radius="md"
            p="lg"
            bg="var(--quorum-paper)"
            style={{ borderColor: 'var(--quorum-line)' }}
          >
            <Stack gap="xs">
              <Text size="sm" c="var(--quorum-mute)">
                Share token
              </Text>
              <Text ff="monospace">{shareToken}</Text>
              <Text size="sm" c="var(--quorum-mute)" mt="sm">
                Sharing is scheduled for <strong>Session 10</strong>. The server has no
                GET /api/share/:token route yet, so this page has nothing to fetch — the unique
                index on sessions.share_token that will serve it has existed since migration 001.
              </Text>
            </Stack>
          </Paper>
        </Stack>
      </Container>
    </Box>
  );
}
