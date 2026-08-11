import { useEffect, useMemo, useState } from 'react';
import { Box, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';

import { CouncilPicker } from '../council/CouncilPicker.jsx';
import { ErrorAlert } from '../ErrorAlert.jsx';
import { councilBody, councilProblem } from '../../lib/council.js';
import { createPreset, updatePreset } from '../../api/quorum.js';

/**
 * Create, edit or duplicate a preset — one modal for all three, because they
 * differ only in what the form opens with and which verb the button uses.
 *
 * `CouncilPicker` IS THE SAME COMPONENT /new USES. A preset is a saved council,
 * so a second picker built for this modal would be a second place the chairman
 * rule is enforced and a second thing to keep looking like the first. It also
 * means the refusals here are `lib/council.js`'s, which are the server's
 * restated — a preset that cannot debate is refused at save time by
 * presetService, and this is the same three sentences said earlier.
 *
 * The 409 for a duplicate name gets its own treatment. It belongs to the Name
 * field but the server sends no `details` array with it, exactly as register's
 * 409 does, so it is lifted onto the input by code rather than by field name.
 */
export function PresetModal({ opened, onClose, models, preset, mode = 'create', onSaved }) {
  const [name, setName] = useState('');
  const [council, setCouncil] = useState({
    selectedIds: [],
    chairmanId: null,
    chairmanAbstains: true,
    rebuttalEnabled: true,
  });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const isEdit = mode === 'edit';

  useEffect(() => {
    if (!opened) return;

    setError(null);
    setSaving(false);

    if (preset) {
      setName(mode === 'duplicate' ? `${preset.name} copy` : preset.name);
      setCouncil({
        selectedIds: (preset.council?.models ?? []).map((model) => model.id),
        chairmanId: preset.council?.chairmanId ?? null,
        chairmanAbstains: preset.chairmanAbstains,
        rebuttalEnabled: preset.rebuttalEnabled,
      });

      return;
    }

    /**
     * A new preset opens on the whole catalogue with the cheapest chairing —
     * the same default /new opens with, and for the same reason: an empty
     * picker asks a question the user has no way to answer yet.
     */
    const cheapest = [...models].sort((a, b) => a.outputPer1k - b.outputPer1k)[0];

    setName('');
    setCouncil({
      selectedIds: models.map((model) => model.id),
      chairmanId: cheapest?.id ?? null,
      chairmanAbstains: true,
      rebuttalEnabled: true,
    });
  }, [opened, preset, mode, models]);

  const selected = useMemo(
    () => models.filter((model) => council.selectedIds.includes(model.id)),
    [models, council.selectedIds],
  );

  const problem = councilProblem({ ...council, selected });
  const trimmedName = name.trim();
  const nameError = error?.status === 409 ? error.message : null;

  async function handleSave() {
    setError(null);
    setSaving(true);

    const body = {
      name: trimmedName,
      council: councilBody({ selected, chairmanId: council.chairmanId }),
      chairmanAbstains: council.chairmanAbstains,
      rebuttalEnabled: council.rebuttalEnabled,
    };

    try {
      const saved = isEdit ? await updatePreset(preset.id, body) : await createPreset(body);

      onSaved(saved);
      onClose();
    } catch (cause) {
      setError(cause);
      setSaving(false);
    }
  }

  const title = isEdit ? 'Edit preset' : mode === 'duplicate' ? 'Duplicate preset' : 'New preset';

  return (
    <Modal opened={opened} onClose={onClose} title={title} centered radius="md" size="lg">
      <Stack gap="md">
        <TextInput
          label="Name"
          placeholder="Fact-check trio"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          error={nameError}
          maxLength={60}
          disabled={saving}
          data-autofocus
        />

        <Box
          style={{ border: '1px solid var(--quorum-line)', borderRadius: 8, overflow: 'hidden' }}
        >
          <CouncilPicker
            models={models}
            selectedIds={council.selectedIds}
            chairmanId={council.chairmanId}
            chairmanAbstains={council.chairmanAbstains}
            rebuttalEnabled={council.rebuttalEnabled}
            onChange={(patch) => setCouncil((current) => ({ ...current, ...patch }))}
            disabled={saving}
          />
        </Box>

        {/* A 409 is rendered against the Name field above, never twice. */}
        {error && error.status !== 409 && <ErrorAlert error={error} title="Could not save" />}

        <Group justify="space-between">
          <Text size="sm" c={problem ? 'var(--quorum-brass)' : 'var(--quorum-mute)'}>
            {problem ?? 'Saved presets fill the whole form on a new session.'}
          </Text>

          <Group gap="xs">
            <Button variant="default" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              loading={saving}
              disabled={Boolean(problem) || trimmedName.length === 0}
            >
              {isEdit ? 'Save changes' : 'Create preset'}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
