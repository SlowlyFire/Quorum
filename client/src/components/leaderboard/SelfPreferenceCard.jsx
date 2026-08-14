import { Anchor, Badge, Box, Group, Paper, Stack, Text } from '@mantine/core';
import { IconArrowUpRight } from '@tabler/icons-react';

import { modelBadgeColor } from '../../theme.js';
import { BASELINE, STUDY, STUDY_PATH } from '../../lib/selfPreference.js';
import { formatPercent } from '../../lib/leaderboard.js';

/**
 * "Why the chairman abstains" — the self-preference study, cut to a card that
 * reads in ten seconds rather than the three screens of confidence intervals,
 * p-values and post-hoc analysis it used to carry. Every number this card no
 * longer states — the 44.1% pooled rate, the 95% CI, p = 0.20, the merge
 * finding — is in `docs/self-preference-study.md` in full; this is the
 * pointer to it, not a second copy of it.
 *
 * IT LEADS WITH THE BETWEEN-CHAIRMAN SPLIT, NOT THE AGGREGATE, and that
 * ordering is the whole design of what is left. One chairman picked its own
 * draft in 15 of 15 decisive rounds and another in 0 of 16; both are
 * individually significant and point opposite ways, so the 44.1% average is
 * an ARTEFACT of averaging two opposite effects rather than a description of
 * anything — which is also why it is the number cut, not the one kept.
 *
 * THE QUALIFICATION LINE IS NOT OPTIONAL TRIM. GPT-5 Mini's drafts win 74% of
 * rounds judged by OTHER models — most of its 100% self-pick rate is draft
 * quality, not favouritism — and that reading has to survive however short
 * this card gets, or "picked itself every decisive time" reads as a stronger
 * claim than the data supports. `STUDY.significant` still drives the
 * "Preliminary" chip, so a future re-run that finds nothing cannot lose the
 * caveat and one that finds something has to flip a boolean rather than edit
 * prose.
 */
export function SelfPreferenceCard() {
  const [top] = STUDY.perChairman;
  const bottom = STUDY.perChairman[STUDY.perChairman.length - 1];

  return (
    <Paper
      withBorder
      radius="md"
      p={{ base: 'md', sm: 'xl' }}
      bg="var(--quorum-paper)"
      style={{ borderColor: 'var(--quorum-line)' }}
    >
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" gap="sm" wrap="wrap">
          <Group gap="sm" align="center">
            <Text className="quorum-eyebrow">Why the chairman abstains</Text>
            {!STUDY.significant && (
              <Badge size="sm" radius="sm" variant="light" color="gray">
                Preliminary
              </Badge>
            )}
          </Group>

          <Anchor
            href={STUDY_PATH}
            target="_blank"
            rel="noreferrer"
            fw={700}
            c="var(--quorum-brass)"
            style={{ whiteSpace: 'nowrap' }}
          >
            <Group gap={4} wrap="nowrap">
              Read the study
              <IconArrowUpRight size={16} />
            </Group>
          </Anchor>
        </Group>

        {/* THE FINDING, in the largest type on the card. */}
        <Text fz={{ base: 20, sm: 24 }} fw={700} lh={1.25} c="var(--quorum-ink)" maw={760}>
          Chairmen do not behave alike. {top.model} picked itself every decisive time;{' '}
          {bottom.model} never did.
        </Text>

        <Stack gap="sm">
          {STUDY.perChairman.map((row) => (
            <ChairmanBar key={row.model} row={row} />
          ))}
          <Text size="xs" c="var(--quorum-mute)" mt={2}>
            Dashed line is chance ({formatPercent(BASELINE, 1)}). Bars are self-picks over the
            rounds each chaired that named a single winner.
          </Text>
        </Stack>

        {/* THE ONE LINE OF QUALIFICATION THAT MUST NOT BE CUT — see the file
            comment. Everything else the card used to say here is in the study. */}
        <Text size="sm" c="var(--quorum-mute)" maw={640}>
          Most of that is draft quality, not preference: {top.model}&apos;s drafts also win{' '}
          {formatPercent(top.winsUnderOthers, 0)} of rounds judged by other models.
        </Text>
      </Stack>
    </Paper>
  );
}

/**
 * One bar, with the chance baseline drawn through it as a dashed rule. The rule
 * is what makes the row readable without the axis a chart would need — a bar at
 * 100% beside a bar at 0% only means something once you can see where a third of
 * the way across is.
 */
function ChairmanBar({ row }) {
  const colour = modelBadgeColor(row.model);

  return (
    <Box className="quorum-sp-row">
      <Text className="quorum-sp-name" size="sm" fw={600} c="var(--quorum-ink)" lineClamp={1}>
        {row.model}
      </Text>

      <Box
        className="quorum-sp-bar"
        style={{
          position: 'relative',
          minWidth: 0,
          height: 30,
          background: 'var(--quorum-panel)',
          border: '1px solid var(--quorum-line)',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        <Box
          style={{
            width: `${row.rate * 100}%`,
            height: '100%',
            background: colour,
            // Zero is a real value and has to be visible as one, so an empty bar
            // keeps a hairline rather than disappearing into the track.
            minWidth: row.rate === 0 ? 3 : undefined,
            opacity: row.rate === 0 ? 0.35 : 1,
          }}
        />

        <Box
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${BASELINE * 100}%`,
            borderLeft: '2px dashed var(--quorum-ink)',
            opacity: 0.45,
          }}
        />
      </Box>

      <Text className="quorum-sp-pct" size="md" fw={700} c="var(--quorum-ink)" ta="right">
        {formatPercent(row.rate, 0)}
      </Text>
      <Text
        className="quorum-sp-count"
        size="xs"
        c="var(--quorum-mute)"
        ta="right"
        style={{ whiteSpace: 'nowrap' }}
      >
        {row.selfPicks}/{row.n}
      </Text>
    </Box>
  );
}
