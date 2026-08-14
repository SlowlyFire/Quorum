import { Link } from 'react-router-dom';
import { Box, Button, Grid, Group, Paper, Stack, Text, Title } from '@mantine/core';

import { CursorGlow } from '../components/CursorGlow.jsx';
import { Logo } from '../components/Logo.jsx';
import { RealDebate } from '../components/landing/RealDebate.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { PageContainer } from '../components/PageContainer.jsx';
import { ModelBadge } from '../components/ModelBadge.jsx';

/**
 * The first thing anyone sees, and the only marketing surface in the product.
 *
 * Two screens of scroll, and the second one is a real debate rather than a
 * claim about debates. What a visitor needs is the premise, the mechanism, and
 * proof — and the proof is the part no competitor's landing page can fake,
 * because it involves a model publicly withdrawing an answer.
 *
 * The copy is plain. This is a tool for comparing AI reasoning, and a page that
 * sounds like a launch announcement would be making a promise the product does
 * not make.
 */
const STAGES = [
  {
    n: '1',
    title: 'Drafts',
    body: 'Every model answers independently, in parallel. None of them sees another’s work.',
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
    body: 'The chairman rules on the rebuttals and delivers one answer, with the whole argument on the record.',
  },
];

export function Landing() {
  const { user, loading } = useAuth();

  return (
    <Box mih="100vh" bg="var(--quorum-panel)" style={{ position: 'relative', overflowX: 'clip' }}>
      {/* Landing page only, and it removes itself under reduced motion or on a
          device with no pointer. See CursorGlow for why both halves matter. */}
      <CursorGlow />

      {/* Everything above the glow. One stacking context rather than a z-index
          on each section. */}
      <Box style={{ position: 'relative', zIndex: 1 }}>
        <Box
          component="header"
          h={64}
          px={{ base: 'md', sm: 'xl' }}
          bg="var(--quorum-paper)"
          style={{ borderBottom: '1px solid var(--quorum-line)' }}
        >
          <Group h="100%" justify="space-between" wrap="nowrap">
            <Logo />
            {!loading &&
              (user ? (
                <Button component={Link} to="/sessions" size="sm">
                  Go to app
                </Button>
              ) : (
                <Group gap="xs" wrap="nowrap">
                  {/* Logo + both buttons does not fit a 320px header in one
                      line, and wrap="nowrap" without this would just move the
                      overflow from "wraps to a second row" to "clips off the
                      edge" — worse. "Sign in" is not lost: the hero two
                      sections down repeats it next to "Create an account". */}
                  <Button
                    component={Link}
                    to="/login"
                    variant="subtle"
                    color="ink"
                    size="sm"
                    visibleFrom="xs"
                  >
                    Sign in
                  </Button>
                  <Button component={Link} to="/register" size="sm">
                    Get started
                  </Button>
                </Group>
              ))}
          </Group>
        </Box>

        <PageContainer py={{ base: 40, sm: 64 }}>
          <Stack gap={{ base: 48, sm: 64 }}>
            {/*
              -- Hero --------------------------------------------------------

              TWO COLUMNS, because the headline needs a short measure and the
              page needs the other half of the screen to be doing something.

              What was wrong before: three different max-widths (780 on the
              stack, 860 on the title, 720 on the lead), all left-aligned inside
              a 1140px column — so the hero occupied the left half of a wide
              screen with nothing to its right, and had three different right
              edges.

              Constraining the headline is correct on its own: 54px type across
              1140px runs to about 90 characters a line, which nobody can read.
              The alternative fix was to centre the whole block, which makes the
              empty space symmetric rather than absent — composed, but still
              empty, and it introduces a second alignment above three
              left-aligned sections.

              The card earns its place by carrying the idea the page has to land
              in the first screen: a council of named models with one of them
              judging. It is the product's actual shape, not decoration.
            */}
            <Grid gutter={{ base: 'xl', md: 48 }} align="center">
              <Grid.Col span={{ base: 12, md: 7 }}>
                <Stack gap="md">
                  <Text className="quorum-eyebrow">Multi-model deliberation</Text>

                  <Title order={1} fz={{ base: 34, sm: 50 }} lh={1.08}>
                    Make several AI models argue, then answer.
                  </Title>

                  <Text fz={{ base: 'md', sm: 'xl' }} c="var(--quorum-mute)">
                    Quorum puts your question to a council of models, has one of them judge the
                    answers blind, and lets the others push back — then gives you the single answer
                    they argued their way to, and the full record of how.
                  </Text>

                  {!loading && (
                    <Group mt="sm" gap="sm">
                      {user ? (
                        <Button component={Link} to="/sessions" size="md">
                          Go to app
                        </Button>
                      ) : (
                        <>
                          <Button component={Link} to="/register" size="md">
                            Create an account
                          </Button>
                          <Button component={Link} to="/login" variant="default" size="md">
                            Sign in
                          </Button>
                        </>
                      )}
                    </Group>
                  )}

                  <Text size="sm" c="var(--quorum-mute)" mt={4}>
                    Two debates a day on the free plan. Top up to remove the limit.
                  </Text>
                </Stack>
              </Grid.Col>

              <Grid.Col span={{ base: 12, md: 5 }}>
                <Paper withBorder radius="md" p="lg" bg="var(--quorum-paper)" style={{ borderColor: 'var(--quorum-line)' }}>
                  <Text className="quorum-eyebrow" mb="sm">The council</Text>
                  <Stack gap="sm">
                    {[
                      ['Claude Haiku 4.5', 'drafter'],
                      ['Gemini 2.5 Flash', 'drafter'],
                      ['Llama 4 Maverick', 'drafter'],
                      ['GPT-5 Mini', 'chairman'],
                    ].map(([name, role]) => (
                      <Group key={name} gap="sm" wrap="nowrap">
                        <ModelBadge model={name} />
                        <Box style={{ minWidth: 0 }}>
                          <Text fw={600} size="sm" truncate>{name}</Text>
                          <Text size="xs" c={role === 'chairman' ? 'var(--quorum-brass)' : 'var(--quorum-mute)'}>
                            {role}
                          </Text>
                        </Box>
                      </Group>
                    ))}
                  </Stack>
                  <Box mt="md" pt="md" style={{ borderTop: '1px solid var(--quorum-line)' }}>
                    <Text size="sm" c="var(--quorum-mute)">
                      Your council, and yours to change: swap any model, nominate any chairman.
                    </Text>
                  </Box>
                </Paper>
              </Grid.Col>
            </Grid>

            {/* -- The four stages ------------------------------------------- */}
            <Box>
              <Text className="quorum-eyebrow" mb="md">
                How a round works
              </Text>

              {/* A connected strip rather than four separate cards: the stages
                  are a sequence, and four boxes in a grid say they are four
                  options. The dividers change axis with the layout — see
                  `.quorum-stage-strip` in global.css for why that cannot be an
                  inline style. The ink/brass rule is the debate view's rail,
                  carried across so the two screens speak one language. */}
              <Box className="quorum-stage-strip">
                {STAGES.map((stage) => (
                  <Box key={stage.n} p="lg">
                    <Stack gap="sm">
                      <StageNumber n={stage.n} />
                      <Text fw={700}>{stage.title}</Text>
                      <Text size="sm" c="var(--quorum-mute)" style={{ lineHeight: 1.55 }}>
                        {stage.body}
                      </Text>
                    </Stack>
                  </Box>
                ))}
              </Box>

              <Text size="sm" c="var(--quorum-mute)" mt="sm">
                Up to <strong>2N calls</strong> for a council of N — fewer when the chairman finds
                the drafts unanimous, because there is then nothing to rebut.
              </Text>
            </Box>

            {/* -- Proof ------------------------------------------------------ */}
            <RealDebate />

            {!loading && !user && (
              <Group gap="sm">
                <Button component={Link} to="/register" size="md">
                  Run your own
                </Button>
                <Text size="sm" c="var(--quorum-mute)">
                  Two free debates a day, no card.
                </Text>
              </Group>
            )}
          </Stack>
        </PageContainer>
      </Box>
    </Box>
  );
}

/**
 * The numbered stage pip. Brass for 2 and 4 because those are the chairman's
 * stages — the same fact the debate view's rail and the shared view both
 * encode with the same two colours.
 */
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
