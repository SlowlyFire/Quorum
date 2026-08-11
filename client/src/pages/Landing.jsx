import { Link } from 'react-router-dom';
import { Box, Button, Container, Group, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';

import { Logo } from '../components/Logo.jsx';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * The only marketing surface, and deliberately one screen of it. What a
 * visitor needs is the premise, the mechanism, and a way in — anything more
 * is a landing page for a product they have not seen yet.
 */
const STAGES = [
  {
    n: '1',
    title: 'Drafts',
    body: 'Every model on the council answers independently, in parallel. No model sees another’s work.',
  },
  {
    n: '2',
    title: 'Verdict',
    body: 'The chairman reads the drafts anonymised and shuffled, then picks one, merges two, or writes its own.',
  },
  {
    n: '3',
    title: 'Rebuttals',
    body: 'Each drafter sees the verdict and may defend, revise, or concede. Conceding is allowed, and it happens.',
  },
  {
    n: '4',
    title: 'Final answer',
    body: 'The chairman rules on the rebuttals and delivers one answer — with the whole argument kept on the record.',
  },
];

export function Landing() {
  const { user, loading } = useAuth();

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
          <Logo />
          {!loading &&
            (user ? (
              <Button component={Link} to="/sessions" size="sm">
                Go to app
              </Button>
            ) : (
              <Group gap="xs">
                <Button component={Link} to="/login" variant="subtle" color="ink" size="sm">
                  Sign in
                </Button>
                <Button component={Link} to="/register" size="sm">
                  Get started
                </Button>
              </Group>
            ))}
        </Group>
      </Box>

      <Container size="lg" py={{ base: 40, sm: 64 }}>
        <Stack gap="xl">
          <Stack gap="md" maw={720}>
            <Text className="quorum-eyebrow">Multi-model deliberation</Text>

            <Title order={1} fz={{ base: 34, sm: 52 }} lh={1.1}>
              One question. Several models. One answer they argued their way to.
            </Title>

            <Text fz={{ base: 'md', sm: 'lg' }} c="var(--quorum-mute)">
              Quorum assembles a council of AI models, nominates one as chairman, and runs a
              structured four-stage debate on your question. You get a single final answer — and
              the full record of how it got there: every draft, the chairman’s reasoning, and who
              conceded.
            </Text>

            <Text fz={{ base: 'md', sm: 'lg' }} c="var(--quorum-mute)">
              Where the models disagree is a signal. It is invisible when you paste the same prompt
              into three chat apps by hand.
            </Text>

            {!loading && !user && (
              <Group mt="md">
                <Button component={Link} to="/register" size="md">
                  Create an account
                </Button>
                <Button component={Link} to="/login" variant="default" size="md">
                  Sign in
                </Button>
              </Group>
            )}
          </Stack>

          <Box>
            <Text className="quorum-eyebrow" mb="sm">
              How a round works
            </Text>

            <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
              {STAGES.map((stage) => (
                <Paper
                  key={stage.n}
                  withBorder
                  radius="md"
                  p="lg"
                  bg="var(--quorum-paper)"
                  style={{ borderColor: 'var(--quorum-line)' }}
                >
                  <Stack gap="sm">
                    <StageNumber n={stage.n} />
                    <Text fw={700}>{stage.title}</Text>
                    <Text size="sm" c="var(--quorum-mute)">
                      {stage.body}
                    </Text>
                  </Stack>
                </Paper>
              ))}
            </SimpleGrid>
          </Box>

          <Text size="sm" c="var(--quorum-mute)">
            Free plan: two debates per day. Top up to remove the limit.
          </Text>
        </Stack>
      </Container>
    </Box>
  );
}

/** The numbered stage pips down the left of the debate view mockup. */
function StageNumber({ n }) {
  const isChairmanStage = n === '2' || n === '4';

  return (
    <Box
      w={28}
      h={28}
      style={{
        borderRadius: 999,
        background: isChairmanStage ? 'var(--quorum-brass)' : 'var(--quorum-ink)',
        color: '#fff',
        display: 'grid',
        placeItems: 'center',
        fontWeight: 700,
        fontSize: 13,
      }}
    >
      {n}
    </Box>
  );
}
