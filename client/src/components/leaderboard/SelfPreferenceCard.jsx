import { Anchor, Badge, Box, Group, Paper, Stack, Text } from '@mantine/core';
import { IconArrowUpRight } from '@tabler/icons-react';

import { modelBadgeColor } from '../../theme.js';
import { BASELINE, STUDY, STUDY_PATH } from '../../lib/selfPreference.js';
import { formatPercent } from '../../lib/leaderboard.js';

/**
 * "Why the chairman abstains" — the self-preference study, on the page where
 * the question naturally arises.
 *
 * IT REPORTS A NULL RESULT AND MUST KEEP REPORTING ONE. The measured rate is
 * 44.1% against a 33.3% baseline with a confidence interval that contains the
 * baseline, so the honest headline is "not distinguishable from chance". The
 * "Preliminary" chip and the wording below are driven by `STUDY.significant`
 * rather than typed in, so a future run that finds something has to flip one
 * flag and cannot leave the caveat behind — and, more importantly, a future run
 * that finds nothing cannot lose it.
 *
 * WHAT IT LEADS WITH is the per-chairman spread rather than the aggregate,
 * because the spread is the actual finding and it is the thing that reads from
 * across a room: one bar at 100%, two at zero, and a dashed line at chance
 * running through all three. The aggregate sits above them as context.
 */
export function SelfPreferenceCard() {
  return (
    <Paper
      withBorder
      radius="md"
      p={{ base: 'md', sm: 'xl' }}
      bg="var(--quorum-paper)"
      style={{ borderColor: 'var(--quorum-line)' }}
    >
      <Stack gap="lg">
        <Group justify="space-between" align="flex-start" gap="sm" wrap="wrap">
          <Box>
            <Group gap="sm" align="center">
              <Text className="quorum-eyebrow">Why the chairman abstains</Text>
              {!STUDY.significant && (
                <Badge size="sm" radius="sm" variant="light" color="gray">
                  Preliminary
                </Badge>
              )}
            </Group>
            <Text c="var(--quorum-mute)" mt={6} maw={620}>
              We ran {STUDY.rounds} real debates in which the chairman also drafted, and counted how
              often it chose its own draft.
            </Text>
          </Box>

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

        {/* The headline, sized to be read at a distance, with the baseline it
            has to be compared against sitting right beside it — a percentage
            with no baseline next to it is a number nobody can judge. */}
        <Group gap={{ base: 'lg', sm: 48 }} align="flex-end" wrap="wrap">
          <Box>
            <Text fz={{ base: 44, sm: 60 }} fw={700} lh={1} c="var(--quorum-ink)">
              {formatPercent(STUDY.rate, 1)}
            </Text>
            <Text size="sm" c="var(--quorum-mute)" mt={6}>
              picked its own draft
              <br />
              {STUDY.selfPicks} of {STUDY.decisiveRounds} decisive rounds
            </Text>
          </Box>

          <Box>
            <Text fz={{ base: 30, sm: 38 }} fw={700} lh={1} c="var(--quorum-mute)">
              {formatPercent(BASELINE, 1)}
            </Text>
            <Text size="sm" c="var(--quorum-mute)" mt={6}>
              is chance
              <br />
              with three drafters
            </Text>
          </Box>

          <Box maw={330}>
            <Text size="sm" c="var(--quorum-ink)" fw={600}>
              Not distinguishable from chance.
            </Text>
            <Text size="sm" c="var(--quorum-mute)">
              95% CI [{formatPercent(STUDY.ci.low, 1)}, {formatPercent(STUDY.ci.high, 1)}] contains
              the baseline; p&nbsp;=&nbsp;{STUDY.p.toFixed(2)} at n&nbsp;=&nbsp;{STUDY.decisiveRounds}.
            </Text>
          </Box>
        </Group>

        <Box>
          <Text className="quorum-eyebrow" mb="sm">
            But it is not uniform
          </Text>
          <Stack gap="sm">
            {STUDY.perChairman.map((row) => (
              <ChairmanBar key={row.model} row={row} />
            ))}
          </Stack>
        </Box>

        <Text size="sm" c="var(--quorum-mute)" maw={760} style={{ lineHeight: 1.6 }}>
          One chairman picked itself every decisive time and another never did — a bigger gap than
          between either of them and chance, which is why the study rotates the chair rather than
          reporting one model. Most of GPT-5 Mini&apos;s is draft quality rather than preference: its
          drafts also win {formatPercent(STUDY.perChairman[0].winsUnderOthers, 0)} of rounds judged
          by <em>other</em> models. The one signal that survived the controls was narrower — when a
          chairman merged instead of picking, it included its own draft in all{' '}
          {STUDY.merges.n} merges (p&nbsp;=&nbsp;{STUDY.merges.p}). Quorum abstains by default
          anyway: the cost is one draft, and the cost of being wrong is a judge marking its own work.
        </Text>
      </Stack>
    </Paper>
  );
}

/**
 * One bar, with the chance baseline drawn through it as a dashed rule. The rule
 * is what makes the row readable without the axis labels a chart would need —
 * a bar at 100% next to a bar at 0% only means something once you can see where
 * a third of the way across is.
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
          height: 26,
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
            // Zero is a real value here and has to be visible as one, so an
            // empty bar keeps a hairline rather than disappearing.
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

      <Text className="quorum-sp-pct" size="sm" fw={700} c="var(--quorum-ink)" ta="right">
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
