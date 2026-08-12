import { Anchor, Badge, Box, Group, Paper, Stack, Text } from '@mantine/core';
import { IconArrowUpRight } from '@tabler/icons-react';

import { modelBadgeColor } from '../../theme.js';
import { BASELINE, STUDY, STUDY_PATH } from '../../lib/selfPreference.js';
import { formatPercent } from '../../lib/leaderboard.js';

/**
 * "Why the chairman abstains" — the self-preference study, on the page where the
 * question naturally arises.
 *
 * IT LEADS WITH THE BETWEEN-CHAIRMAN SPLIT, NOT THE AGGREGATE, and that ordering
 * is the whole design of this card. One chairman picked its own draft in 15 of
 * 15 decisive rounds and another in 0 of 16; both are individually significant
 * and they point opposite ways, so the 44.1% average is an ARTEFACT of averaging
 * two opposite effects rather than a description of anything. Leading with the
 * average would put the least informative number in the largest type.
 *
 * THE NULL IS STILL STATED PLAINLY, immediately under the chart and in the
 * study, because the headline claim — "chairmen prefer their own drafts" — is
 * the thing we set out to test and did not find. Leading with the split must not
 * become a way of implying we found it.
 *
 * Both of those are enforced by data rather than by prose: `STUDY.significant`
 * drives the "Preliminary" chip and the not-distinguishable line, so a future
 * run that finds nothing cannot lose the caveat, and one that finds something
 * has to flip a boolean.
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
            <Text c="var(--quorum-mute)" mt={6} maw={640}>
              We ran {STUDY.rounds} real debates in which the chairman also drafted, and counted how
              often it chose its own draft. Chance is {formatPercent(BASELINE, 1)} with three
              drafters.
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

        {/* THE FINDING, in the largest type on the card. */}
        <Box>
          <Text fz={{ base: 22, sm: 28 }} fw={700} lh={1.25} c="var(--quorum-ink)" maw={760}>
            Chairmen do not behave alike. {top.model} picked itself every decisive time;{' '}
            {bottom.model} never did.
          </Text>
        </Box>

        <Stack gap="sm">
          {STUDY.perChairman.map((row) => (
            <ChairmanBar key={row.model} row={row} />
          ))}
          <Text size="xs" c="var(--quorum-mute)" mt={2}>
            Dashed line is chance ({formatPercent(BASELINE, 1)}). Bars are self-picks over the
            rounds each chaired that named a single winner.
          </Text>
        </Stack>

        {/*
          The aggregate, deliberately demoted to a footnote-sized block: it is the
          number the study set out to produce and it is the least informative one
          on the card. It still says the null in full.
        */}
        <Box
          p="md"
          bg="var(--quorum-panel)"
          style={{ borderRadius: 'var(--mantine-radius-md)', border: '1px solid var(--quorum-line)' }}
        >
          <Text size="sm" c="var(--quorum-ink)" maw={800} style={{ lineHeight: 1.6 }}>
            <strong>
              Averaged, that is {formatPercent(STUDY.rate, 1)} against a{' '}
              {formatPercent(BASELINE, 1)} baseline — which on its own is not distinguishable from
              chance.
            </strong>{' '}
            95% CI [{formatPercent(STUDY.ci.low, 1)}, {formatPercent(STUDY.ci.high, 1)}] contains the
            baseline, p&nbsp;=&nbsp;{STUDY.p.toFixed(2)} at n&nbsp;=&nbsp;{STUDY.decisiveRounds}. The
            average is an artefact of two opposite, individually significant effects cancelling —
            which is why the study rotates the chair rather than reporting one model.
          </Text>
        </Box>

        <Text size="sm" c="var(--quorum-mute)" maw={800} style={{ lineHeight: 1.6 }}>
          Most of {top.model}&apos;s is draft quality rather than preference: its drafts also win{' '}
          {formatPercent(top.winsUnderOthers, 0)} of rounds judged by <em>other</em> models, so a
          chairman picking them is mostly agreeing with everyone else. The one signal that survived
          the controls was narrower — when a chairman merged instead of picking, it included its own
          draft in all {STUDY.merges.n} merges (p&nbsp;=&nbsp;{STUDY.merges.p}, post-hoc). Quorum
          abstains by default anyway: the cost is one draft, and the cost of being wrong is a judge
          marking its own work.
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
