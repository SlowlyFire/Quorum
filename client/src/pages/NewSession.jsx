import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Center,
  Container,
  Grid,
  Loader,
  Paper,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';

import { CouncilPicker } from '../components/council/CouncilPicker.jsx';
import { PresetsCard, RoundPlanCard } from '../components/council/RoundPlanCard.jsx';
import { ErrorAlert } from '../components/ErrorAlert.jsx';
import { createSession, fetchCatalogue } from '../api/quorum.js';
import { councilBody, councilProblem } from '../lib/council.js';

/**
 * Mockup 01 — "Assemble your council".
 *
 * The screen makes one request when it opens (`GET /api/models`) and one when it
 * is submitted (`POST /api/sessions`). Everything between — who drafts, how many
 * calls that is, what it will cost, and whether the council can debate at all —
 * is computed in the browser from the catalogue it already has. That is the
 * point of the right-hand rail: the arithmetic is visible while it is still
 * being decided, rather than after a round trip.
 *
 * The refusals are the same three the server raises, restated in lib/council.js.
 * A user should never learn "a debate needs at least 3 models when the chairman
 * abstains" from a 400.
 */
export function NewSession() {
  const navigate = useNavigate();

  const [catalogue, setCatalogue] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [firstPrompt, setFirstPrompt] = useState('');

  const [council, setCouncil] = useState({
    selectedIds: [],
    chairmanId: null,
    // Both default ON, matching the mockup, the session defaults and §2's two
    // invariants. Neither is a preference; they are why the product works.
    chairmanAbstains: true,
    rebuttalEnabled: true,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await fetchCatalogue();
        if (cancelled) return;

        setCatalogue(data);

        /**
         * Every model on, and the cheapest of them chairing. A council picker
         * that opens empty asks a question the user cannot answer yet — they
         * have not seen a debate — and the whole catalogue is the line-up the
         * product is actually about. The chairman has to be *someone*, and the
         * cheapest is the least opinionated way to pick before the user does.
         */
        const cheapest = [...data.models].sort((a, b) => a.outputPer1k - b.outputPer1k)[0];

        setCouncil((current) => ({
          ...current,
          selectedIds: data.models.map((model) => model.id),
          chairmanId: cheapest?.id ?? null,
        }));
      } catch (error) {
        if (!cancelled) setLoadError(error);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  const models = catalogue?.models ?? [];
  const selected = useMemo(
    () => models.filter((model) => council.selectedIds.includes(model.id)),
    [models, council.selectedIds],
  );

  const planInput = { ...council, selected };
  const problem = councilProblem(planInput);

  async function handleStart() {
    setSubmitError(null);
    setSubmitting(true);

    try {
      const session = await createSession({
        council: councilBody({ selected, chairmanId: council.chairmanId }),
        chairmanAbstains: council.chairmanAbstains,
        rebuttalEnabled: council.rebuttalEnabled,
        ...(firstPrompt.trim() ? { title: firstPrompt.trim().slice(0, 120) } : {}),
      });

      /**
       * The first question rides across in router state rather than in the URL:
       * it can be 8000 characters, and a question is not an address. The debate
       * view sends it once and clears it, so a refresh does not re-ask it.
       */
      navigate(`/chat/${session.id}`, {
        state: firstPrompt.trim() ? { firstPrompt: firstPrompt.trim() } : undefined,
      });
    } catch (error) {
      setSubmitError(error);
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <Container size="lg" py="xl">
        <ErrorAlert error={loadError} title="Could not load the model catalogue" />
      </Container>
    );
  }

  if (!catalogue) {
    return (
      <Center py={120}>
        <Loader color="ink" />
      </Center>
    );
  }

  return (
    <Container size="lg" py={{ base: 'lg', sm: 'xl' }}>
      <Stack gap="xl">
        <Stack gap={6}>
          <Title order={1} fz={{ base: 28, sm: 40 }}>
            Assemble your council
          </Title>
          <Text c="var(--quorum-mute)" fz={{ base: 'md', sm: 'lg' }}>
            Pick who answers, pick who judges. You can change this mid-session.
          </Text>
        </Stack>

        <Grid gutter="xl">
          <Grid.Col span={{ base: 12, md: 8 }}>
            <Paper
              withBorder
              radius="md"
              bg="var(--quorum-paper)"
              style={{ borderColor: 'var(--quorum-line)' }}
            >
              <CouncilPicker
                models={models}
                selectedIds={council.selectedIds}
                chairmanId={council.chairmanId}
                chairmanAbstains={council.chairmanAbstains}
                rebuttalEnabled={council.rebuttalEnabled}
                onChange={(patch) => setCouncil((current) => ({ ...current, ...patch }))}
                disabled={submitting}
              />

              <Box p="lg" style={{ borderTop: '1px solid var(--quorum-line)' }}>
                <Textarea
                  label="First question"
                  description="Optional — the session opens on the debate view either way."
                  placeholder="What do you want the council to argue about?"
                  autosize
                  minRows={2}
                  maxRows={6}
                  maxLength={8000}
                  value={firstPrompt}
                  onChange={(event) => setFirstPrompt(event.currentTarget.value)}
                  disabled={submitting}
                />
              </Box>
            </Paper>
          </Grid.Col>

          <Grid.Col span={{ base: 12, md: 4 }}>
            <Stack gap="md">
              <RoundPlanCard council={planInput} estimate={catalogue.estimate} />

              <PresetsCard />

              {submitError && <ErrorAlert error={submitError} />}

              <Stack gap="xs">
                <Button
                  size="lg"
                  fullWidth
                  onClick={handleStart}
                  disabled={Boolean(problem)}
                  loading={submitting}
                >
                  Start session
                </Button>

                {/* The reason sits under the button it disabled, which is where
                    a user looks when a button will not press. */}
                <Text size="sm" c={problem ? 'var(--quorum-brass)' : 'var(--quorum-mute)'} ta="center">
                  {problem ?? 'Free plan: 2 debates per day. Top up to remove the limit.'}
                </Text>
              </Stack>
            </Stack>
          </Grid.Col>
        </Grid>
      </Stack>
    </Container>
  );
}
