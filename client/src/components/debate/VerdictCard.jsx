import { useState } from 'react';
import { Anchor, Badge, Box, Code, Collapse, Group, Paper, Skeleton, Stack, Text } from '@mantine/core';

import { Markdown } from '../Markdown.jsx';
import { ModelBadge } from '../ModelBadge.jsx';
import { verdictChip } from '../../lib/round.js';

/**
 * Stage 2 — the brass-bordered card, and the only place in the transcript where
 * one model is judging others.
 *
 * The chip is stage 2's OWN verdict type, not `rounds.verdict_type`. They are
 * different judgements made at different times: this one is the blind evaluation
 * of anonymised, shuffled drafts, and stage 4's is delivered after the drafters
 * have argued back — often `unanimous` once they have all conceded. Rendering
 * stage 4's word on stage 2's card would erase the fact that a draft won
 * (decisions 20 and 26).
 *
 * "Show scoring rubric" expands the validated JSON the chairman returned. It is
 * there for the demo, and it earns its place: a verdict a user cannot inspect is
 * indistinguishable from one we made up.
 */
export function VerdictCard({ verdict, running = false }) {
  const [showRubric, setShowRubric] = useState(false);

  if (running && !verdict?.verdictType) {
    return (
      <Paper
        radius="md"
        p="md"
        bg="var(--quorum-brass-bg)"
        style={{ border: '1px solid var(--quorum-brass-border)' }}
      >
        <Group gap="sm" mb="sm">
          <Skeleton height={28} circle />
          <Skeleton height={12} width={160} radius="sm" />
        </Group>
        <Stack gap={8}>
          <Skeleton height={8} radius="sm" />
          <Skeleton height={8} width="80%" radius="sm" />
        </Stack>
      </Paper>
    );
  }

  if (!verdict?.verdictType) return null;

  return (
    <Paper
      radius="md"
      p="lg"
      bg="var(--quorum-brass-bg)"
      style={{ border: '1px solid var(--quorum-brass-border)' }}
    >
      <Group gap="sm" wrap="wrap" mb="md">
        <ModelBadge model={verdict.modelName} size={32} fz={13} />

        <Text fw={700} fz="lg">
          {verdict.modelName ?? 'Chairman'}
        </Text>

        <Badge variant="outline" color="brass" radius="xl" tt="lowercase" fw={500}>
          chairman
        </Badge>

        <Badge variant="filled" color="brass" radius="xl">
          {verdictChip(verdict.verdictType, verdict.winnerLabels)}
        </Badge>
      </Group>

      {verdict.reasoning ? (
        <Markdown size="md">{verdict.reasoning}</Markdown>
      ) : (
        <Text c="var(--quorum-mute)" size="sm">
          The chairman gave no reasoning for this verdict.
        </Text>
      )}

      {verdict.raw && (
        <>
          <Anchor
            component="button"
            type="button"
            mt="md"
            fw={700}
            c="var(--quorum-brass)"
            onClick={() => setShowRubric((open) => !open)}
          >
            {showRubric ? 'Hide scoring rubric ‹' : 'Show scoring rubric ›'}
          </Anchor>

          <Collapse in={showRubric}>
            <Box mt="sm">
              <Code block style={{ maxHeight: 320, overflow: 'auto' }}>
                {verdict.raw}
              </Code>
            </Box>
          </Collapse>
        </>
      )}
    </Paper>
  );
}
