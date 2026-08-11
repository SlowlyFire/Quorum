import { useState } from 'react';
import { Box, Button, Group, Paper, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDeviceFloppy } from '@tabler/icons-react';

import { ErrorAlert } from '../ErrorAlert.jsx';
import { lineUpSummary } from '../sessions/PresetCards.jsx';
import { councilBody } from '../../lib/council.js';
import { createPreset } from '../../api/quorum.js';

/**
 * The presets card on /new — replacing the "Session 10" placeholder that stood
 * here since Session 8.
 *
 * TWO DIRECTIONS, and they are the whole feature. Selecting a preset fills the
 * form — every model, the chairman, and BOTH debate settings, because
 * `chairmanAbstains` and `rebuttalEnabled` are part of a saved council and a
 * preset that restored the line-up but not the settings would produce a
 * different debate from the one that was saved. And "Save as preset" captures
 * whatever the picker currently holds, which is how a council a user has just
 * assembled becomes reusable without retyping it on another screen.
 *
 * A preset is highlighted as selected only while the form still matches it.
 * Touching any toggle clears the highlight, because the alternative — a card
 * that still looks chosen while the council has changed underneath it — is a
 * label that lies.
 */
export function PresetPicker({ presets, selectedId, onSelect, council, selected, problem }) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [naming, setNaming] = useState(false);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;

    setError(null);
    setSaving(true);

    try {
      const preset = await createPreset({
        name: trimmed,
        council: councilBody({ selected, chairmanId: council.chairmanId }),
        chairmanAbstains: council.chairmanAbstains,
        rebuttalEnabled: council.rebuttalEnabled,
      });

      onSelect(preset, { silent: true });
      setNaming(false);
      setName('');
      notifications.show({
        color: 'green',
        title: 'Preset saved',
        message: `“${preset.name}” is on your sessions page and in this list.`,
      });
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Paper
      radius="md"
      p="lg"
      bg="var(--quorum-paper)"
      style={{ border: '1px solid var(--quorum-line)' }}
    >
      <Stack gap="sm">
        <Text fw={700}>Council presets</Text>

        {presets === null && (
          <Text size="sm" c="var(--quorum-mute)">
            Loading…
          </Text>
        )}

        {presets?.length === 0 && (
          <Text size="sm" c="var(--quorum-mute)">
            No presets yet. Assemble a council and save it below to reuse it.
          </Text>
        )}

        {presets && presets.length > 0 && (
          <Stack gap={6}>
            {presets.map((preset) => (
              <PresetRow
                key={preset.id}
                preset={preset}
                selected={preset.id === selectedId}
                onSelect={() => onSelect(preset)}
              />
            ))}
          </Stack>
        )}

        {error && <ErrorAlert error={error} title="Could not save the preset" />}

        {naming ? (
          <Stack gap="xs">
            <TextInput
              placeholder="Name this council"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleSave();
                if (event.key === 'Escape') setNaming(false);
              }}
              maxLength={60}
              disabled={saving}
              autoFocus
            />
            <Group gap="xs" grow>
              <Button variant="default" size="xs" onClick={() => setNaming(false)} disabled={saving}>
                Cancel
              </Button>
              <Button size="xs" onClick={handleSave} loading={saving} disabled={!name.trim()}>
                Save
              </Button>
            </Group>
          </Stack>
        ) : (
          <Button
            variant="default"
            size="xs"
            leftSection={<IconDeviceFloppy size={14} />}
            onClick={() => setNaming(true)}
            // A council that cannot debate cannot be saved either — presetService
            // refuses it, and offering the button would be offering a 400.
            disabled={Boolean(problem)}
          >
            Save as preset
          </Button>
        )}
      </Stack>
    </Paper>
  );
}

function PresetRow({ preset, selected, onSelect }) {
  const unusable = preset.hasRetiredModel;

  return (
    <UnstyledButton
      onClick={unusable ? undefined : onSelect}
      p="xs"
      style={{
        borderRadius: 8,
        border: `1px solid ${selected ? 'var(--quorum-brass-border)' : 'var(--quorum-line)'}`,
        background: selected ? 'var(--quorum-brass-bg)' : 'transparent',
        cursor: unusable ? 'not-allowed' : 'pointer',
        opacity: unusable ? 0.55 : 1,
      }}
    >
      <Box>
        <Text size="sm" fw={600} c="var(--quorum-ink)" lineClamp={1}>
          {preset.name}
        </Text>
        <Text size="xs" c="var(--quorum-mute)" lineClamp={1}>
          {unusable ? 'Contains a retired model — edit it on the sessions page' : lineUpSummary(preset)}
        </Text>
      </Box>
    </UnstyledButton>
  );
}
