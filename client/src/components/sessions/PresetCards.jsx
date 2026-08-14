import { Box, Button, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';

import { ModelBadge } from '../ModelBadge.jsx';

/**
 * Mockup 03's "Council presets" strip: a card per preset, then a dashed
 * "+ New preset".
 *
 * The line-up summary is the mockup's own format — "Claude · GPT · Gemini
 * (chair)" — which reads as a sentence rather than a list and puts the one
 * thing that distinguishes two similar presets, who chairs, at the end where
 * the eye lands.
 */
export function PresetCards({ presets, onCreate, onEdit, onDuplicate, onDelete, busyId }) {
  return (
    <Box
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
        gap: 'var(--mantine-spacing-md)',
      }}
    >
      {presets.map((preset) => (
        <PresetCard
          key={preset.id}
          preset={preset}
          onEdit={onEdit}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          busy={busyId === preset.id}
        />
      ))}

      <UnstyledButton
        onClick={onCreate}
        p="lg"
        className="quorum-hover-lift"
        style={{
          border: '1px dashed var(--quorum-line)',
          borderRadius: 12,
          display: 'grid',
          placeItems: 'center',
          minHeight: 120,
        }}
      >
        <Group gap={6} c="var(--quorum-mute)">
          <IconPlus size={16} />
          <Text fw={700}>New preset</Text>
        </Group>
      </UnstyledButton>
    </Box>
  );
}

/** "Claude · GPT · Gemini (chair)". First word of each name, as the mockup has it. */
export function lineUpSummary(preset) {
  const models = preset.council?.models ?? [];

  if (models.length === 0) return 'No models';

  return models
    .map((model) => {
      const short = model.displayName.split(' ')[0];
      return model.isChairman ? `${short} (chair)` : short;
    })
    .join(' · ');
}

function PresetCard({ preset, onEdit, onDuplicate, onDelete, busy }) {
  return (
    <Box
      p="lg"
      bg="var(--quorum-paper)"
      className="quorum-hover-lift"
      style={{ border: '1px solid var(--quorum-line)', borderRadius: 12, opacity: busy ? 0.5 : 1 }}
    >
      <Stack gap="xs" h="100%">
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Text fw={700} lineClamp={1}>
            {preset.name}
          </Text>
          <Group gap={-4} wrap="nowrap">
            {(preset.council?.models ?? []).slice(0, 4).map((model, index) => (
              <Box key={model.id} ml={index === 0 ? 0 : -6}>
                <ModelBadge model={model} size={22} fz={12} />
              </Box>
            ))}
          </Group>
        </Group>

        <Text size="sm" c="var(--quorum-mute)" lineClamp={2}>
          {lineUpSummary(preset)}
        </Text>

        {/**
         * A preset outlives the catalogue, so a model retired since it was saved
         * leaves it readable and unloadable. Saying so on the card is the only
         * place a user can learn it before the picker refuses to fill.
         */}
        {preset.hasRetiredModel && (
          <Text size="xs" c="var(--quorum-brass)">
            One of these models has been retired — edit the line-up to use this preset.
          </Text>
        )}

        <Group gap={4} mt="auto" pt="xs">
          <CardAction onClick={() => onEdit(preset)}>Edit</CardAction>
          <Dot />
          <CardAction onClick={() => onDuplicate(preset)}>Duplicate</CardAction>
          <Dot />
          <CardAction onClick={() => onDelete(preset)} danger>
            Delete
          </CardAction>
        </Group>
      </Stack>
    </Box>
  );
}

function CardAction({ children, onClick, danger = false }) {
  return (
    <Button
      variant="subtle"
      size="compact-xs"
      color={danger ? 'red' : 'gray'}
      px={4}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function Dot() {
  return (
    <Text size="xs" c="var(--quorum-line)">
      ·
    </Text>
  );
}
