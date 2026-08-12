import { Group, Paper, Stack, Text } from '@mantine/core';

import { ModelBadge } from '../ModelBadge.jsx';
import { needsMoreDrafts } from '../../lib/leaderboard.js';

/**
 * The models below §4's five-draft minimum.
 *
 * They are listed rather than dropped, and that is the whole point of the
 * component. A user two days into the product has one or two drafts against
 * every model, and a page that silently showed nothing would read as broken
 * rather than as early — so the models appear with their real counts and the
 * one thing they are missing.
 *
 * `draftsNeeded` comes from the server, computed against the threshold the
 * server actually applied. Subtracting from a 5 written down here would be a
 * second copy of the rule, and it would be wrong the first time the threshold
 * moved.
 */
export function UnrankedList({ standings, minDrafts }) {
  if (standings.length === 0) return null;

  return (
    <Stack gap="sm">
      <Text size="sm" c="var(--quorum-mute)">
        Not yet ranked — a model needs {minDrafts} drafts in the period before it appears in the
        standings, so that a single lucky win cannot top the podium.
      </Text>

      <Paper
        withBorder
        radius="md"
        p="md"
        bg="var(--quorum-paper)"
        style={{ borderColor: 'var(--quorum-line)' }}
      >
        <Stack gap="sm">
          {standings.map((standing) => (
            <Group key={standing.modelId} justify="space-between" gap="md" wrap="nowrap">
              <Group gap="sm" wrap="nowrap">
                <ModelBadge
                  model={{ displayName: standing.displayName, slug: standing.slug }}
                  size={24}
                  fz={11}
                />
                <Text size="sm" fw={600} c="var(--quorum-ink)">
                  {standing.displayName}
                </Text>
                <Text size="sm" c="var(--quorum-mute)">
                  {standing.drafts} draft{standing.drafts === 1 ? '' : 's'}
                </Text>
              </Group>

              <Text size="sm" c="var(--quorum-mute)" style={{ whiteSpace: 'nowrap' }}>
                {needsMoreDrafts(standing.draftsNeeded)}
              </Text>
            </Group>
          ))}
        </Stack>
      </Paper>
    </Stack>
  );
}
