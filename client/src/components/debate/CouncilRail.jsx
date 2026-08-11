import { useState } from 'react';
import { Anchor, Box, Button, Divider, Group, Modal, Paper, Stack, Text } from '@mantine/core';

import { CouncilPicker } from '../council/CouncilPicker.jsx';
import { ErrorAlert } from '../ErrorAlert.jsx';
import { ModelBadge } from '../ModelBadge.jsx';
import { councilBody, councilProblem } from '../../lib/council.js';
import { formatCost } from '../../lib/cost.js';

/**
 * The right-hand rail of mockup 02: who is on the council, and what the session
 * has spent.
 *
 * "Changes apply from the next question. History is preserved." is not
 * reassurance, it is the data model. A session's council is its DEFAULT and
 * lives in `session_models`; every round snapshots its own line-up into
 * `round_models` as it starts and never updates it. So a PATCH here cannot
 * change a round already run, and the sentence under the link is the only place
 * a user is told that (decision 22).
 */
export function CouncilRail({ session, models, rounds, onSave }) {
  const [editing, setEditing] = useState(false);

  const council = session.council.models;
  const spend = rounds.reduce((total, round) => total + Number(round.totals?.cost ?? 0), 0);
  const completed = rounds.filter((round) => round.status === 'complete').length;

  return (
    <Stack gap="md">
      <Paper withBorder radius="md" p="lg" bg="var(--quorum-paper)" style={{ borderColor: 'var(--quorum-line)' }}>
        <Stack gap="md">
          <Text className="quorum-eyebrow">Council</Text>

          {council.map((member) => (
            <Group key={member.id} gap="sm" wrap="nowrap">
              <ModelBadge model={member} />
              <Box style={{ minWidth: 0 }}>
                <Text fw={700} truncate>
                  {member.displayName}
                </Text>
                <Text
                  size="sm"
                  c={member.isChairman ? 'var(--quorum-brass)' : 'var(--quorum-mute)'}
                  fw={member.isChairman ? 600 : 400}
                >
                  {roleLabel(member, session.chairmanAbstains)}
                </Text>
              </Box>
            </Group>
          ))}

          <Divider color="var(--quorum-line)" />

          <Box>
            <Anchor component="button" type="button" fw={700} onClick={() => setEditing(true)}>
              Edit council
            </Anchor>
            <Text size="sm" c="var(--quorum-mute)" mt={4}>
              Changes apply from the next question. History is preserved.
            </Text>
          </Box>
        </Stack>
      </Paper>

      <Paper withBorder radius="md" p="lg" bg="var(--quorum-paper)" style={{ borderColor: 'var(--quorum-line)' }}>
        <Stack gap={4}>
          <Text className="quorum-eyebrow">Session spend</Text>
          <Text fz={32} fw={700}>
            {formatCost(spend, { precise: spend < 0.01 })}
          </Text>
          <Text size="sm" c="var(--quorum-mute)">
            {completed} question{completed === 1 ? '' : 's'} this session
          </Text>
          {/* Billed, not estimated: every figure summed here is `usage.cost`
              from the provider's own response body. */}
          <Text size="xs" c="var(--quorum-mute)" mt={4}>
            Billed by OpenRouter, summed from completed rounds.
          </Text>
        </Stack>
      </Paper>

      <EditCouncilModal
        opened={editing}
        onClose={() => setEditing(false)}
        session={session}
        models={models}
        onSave={onSave}
      />
    </Stack>
  );
}

function roleLabel(member, chairmanAbstains) {
  if (!member.isChairman) return 'drafter';
  return chairmanAbstains ? 'chairman' : 'chairman · drafts too';
}

/**
 * The picker again, in a modal, over PATCH /api/sessions/:id. Same component and
 * the same three refusals as /new, because the council rules do not change with
 * the screen the council is edited on.
 */
function EditCouncilModal({ opened, onClose, session, models, onSave }) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Seeded from the session each time it opens, so a cancelled edit leaves
  // nothing behind and a saved one is what the next open shows.
  const current = draft ?? {
    selectedIds: session.council.models.map((model) => model.id),
    chairmanId: session.council.chairmanId,
    chairmanAbstains: session.chairmanAbstains,
    rebuttalEnabled: session.rebuttalEnabled,
  };

  const selected = models.filter((model) => current.selectedIds.includes(model.id));
  const problem = councilProblem({ ...current, selected });

  function close() {
    setDraft(null);
    setError(null);
    onClose();
  }

  async function save() {
    setSaving(true);
    setError(null);

    try {
      await onSave({
        council: councilBody({ selected, chairmanId: current.chairmanId }),
        chairmanAbstains: current.chairmanAbstains,
        rebuttalEnabled: current.rebuttalEnabled,
      });

      close();
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal opened={opened} onClose={close} size="lg" title="Edit council">
      <Stack gap="md">
        <Paper withBorder radius="md" style={{ borderColor: 'var(--quorum-line)' }}>
          <CouncilPicker
            models={models}
            selectedIds={current.selectedIds}
            chairmanId={current.chairmanId}
            chairmanAbstains={current.chairmanAbstains}
            rebuttalEnabled={current.rebuttalEnabled}
            onChange={(patch) => setDraft({ ...current, ...patch })}
            disabled={saving}
          />
        </Paper>

        {error && <ErrorAlert error={error} />}

        <Text size="sm" c={problem ? 'var(--quorum-brass)' : 'var(--quorum-mute)'}>
          {problem ?? 'Applies from the next question. Rounds already run keep the council they ran with.'}
        </Text>

        <Group justify="flex-end">
          <Button variant="default" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={Boolean(problem)}>
            Save council
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
