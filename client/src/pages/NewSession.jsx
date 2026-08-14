import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Center,
  Grid,
  Loader,
  Paper,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';

import { CouncilPicker } from '../components/council/CouncilPicker.jsx';
import { PresetPicker } from '../components/council/PresetPicker.jsx';
import { RoundPlanCard } from '../components/council/RoundPlanCard.jsx';
import { ErrorAlert } from '../components/ErrorAlert.jsx';
import { createSession, fetchCatalogue, listPresets } from '../api/quorum.js';
import { councilBody, councilProblem } from '../lib/council.js';
import { PageContainer } from '../components/PageContainer.jsx';

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

  const [presets, setPresets] = useState(null);
  const [presetId, setPresetId] = useState(null);

  const [council, setCouncil] = useState({
    selectedIds: [],
    chairmanId: null,
    // Both default ON, matching the mockup, the session defaults and §2's two
    // invariants. Neither is a preference; they are why the product works.
    chairmanAbstains: true,
    rebuttalEnabled: true,
  });

  /**
   * Every path that changes the council clears the selected preset, except the
   * one that selects a preset. A card that still looks chosen while the toggles
   * have moved underneath it is a label that lies, and this is the only place
   * that could happen.
   */
  const patchCouncil = (patch, { fromPreset = false } = {}) => {
    if (!fromPreset) setPresetId(null);
    setCouncil((current) => ({ ...current, ...patch }));
  };

  /**
   * Selecting a preset restores the line-up AND both debate settings. A preset
   * that brought back who was on the council but not whether the chairman
   * abstains would produce a different debate from the one that was saved.
   */
  const applyPreset = (preset) => {
    setPresetId(preset.id);
    setCouncil({
      selectedIds: (preset.council?.models ?? []).map((model) => model.id),
      chairmanId: preset.council?.chairmanId ?? null,
      chairmanAbstains: preset.chairmanAbstains,
      rebuttalEnabled: preset.rebuttalEnabled,
    });

    setPresets((current) => {
      const rows = current ?? [];
      // "Save as preset" hands back a preset the list has not seen.
      return rows.some((row) => row.id === preset.id) ? rows : [...rows, preset];
    });
  };

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [data, presetRows] = await Promise.all([
          fetchCatalogue(),
          // A failure here must not take the page down: presets are a
          // convenience and the council picker is the screen.
          listPresets().catch(() => []),
        ]);
        if (cancelled) return;

        setCatalogue(data);
        setPresets(presetRows);

        /**
         * "Full council" is one of the two presets every account is seeded with
         * (decision 38), and it is exactly the default this screen has opened
         * with since Session 8 — every model on, the cheapest chairing. So when
         * it is there, the page opens on it and the card is highlighted, which
         * tells a new user what a preset is by showing them one already in use.
         *
         * Falling back to computing the same council in place keeps the screen
         * working for an account whose seeding failed or whose presets were all
         * deleted — the picker must never open empty, because a council picker
         * that opens empty asks a question the user cannot answer yet.
         */
        const usable = presetRows.filter((preset) => !preset.hasRetiredModel);
        const opening = usable.find((preset) => preset.name === 'Full council') ?? usable[0] ?? null;

        if (opening) {
          setPresetId(opening.id);
          setCouncil({
            selectedIds: (opening.council?.models ?? []).map((model) => model.id),
            chairmanId: opening.council?.chairmanId ?? null,
            chairmanAbstains: opening.chairmanAbstains,
            rebuttalEnabled: opening.rebuttalEnabled,
          });

          return;
        }

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

  // `promptText` feeds the quote, not the plan: a longer question means longer
  // drafts, which stages 2-4 pay to read back (decision 56). The call breakdown
  // above the figure is unaffected.
  const planInput = { ...council, selected, promptText: firstPrompt };
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
      <PageContainer py="xl">
        <ErrorAlert error={loadError} title="Could not load the model catalogue" />
      </PageContainer>
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
    <PageContainer>
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
          {/*
            On mobile these two columns stack in DOM order, and the DOM order
            below is the one CouncilPicker's card wants (models before the
            plan). But that buried "Council presets" — the fast path — beneath
            a full model list, five rows of switches, two settings toggles and
            a textarea, roughly two screens of scrolling on a 360px phone.
            `order` swaps which one stacks on top below `md` without touching
            desktop, where both columns already sit side by side.
          */}
          <Grid.Col span={{ base: 12, md: 8 }} order={{ base: 2, md: 1 }}>
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
                onChange={patchCouncil}
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

          <Grid.Col span={{ base: 12, md: 4 }} order={{ base: 1, md: 2 }}>
            <Stack gap="md">
              <RoundPlanCard council={planInput} estimate={catalogue.estimate} />

              <PresetPicker
                presets={presets}
                selectedId={presetId}
                onSelect={applyPreset}
                council={council}
                selected={selected}
                problem={problem}
              />

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
    </PageContainer>
  );
}
