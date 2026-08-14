import { Badge, Box, Group, Radio, Stack, Switch, Text, Tooltip, UnstyledButton } from '@mantine/core';

import { ModelBadge } from '../ModelBadge.jsx';
import { MAX_COUNCIL } from '../../lib/council.js';

/**
 * Mockup 01's left-hand card: a row per model — toggle, letter badge, name,
 * provider, a chairman radio and a price — then the two debate switches.
 *
 * Controlled, because two screens own this state for different reasons.
 * /new holds it until "Start session" writes it, and the debate view's Edit
 * council modal holds it until PATCH does; neither wants a picker with opinions
 * about when to save.
 *
 * One invariant is enforced here rather than validated later: **the chairman is
 * always a selected model.** Toggling off the chairman clears the nomination,
 * and an unselected row's radio is disabled. The server would refuse the pair
 * (`chairmanId` not in `modelIds` is a Zod `details` entry) but a picker that
 * lets you build the impossible state and then explains it is a worse picker.
 */
export function CouncilPicker({
  models,
  selectedIds,
  chairmanId,
  chairmanAbstains,
  rebuttalEnabled,
  onChange,
  showSettings = true,
  disabled = false,
}) {
  const isSelected = (id) => selectedIds.includes(id);

  function toggleModel(id, on) {
    const next = on ? [...selectedIds, id] : selectedIds.filter((current) => current !== id);

    onChange({
      selectedIds: next,
      // A chairman that has just been toggled off cannot stay nominated.
      ...(chairmanId === id && !on ? { chairmanId: null } : {}),
    });
  }

  return (
    <Stack gap={0}>
      <Group
        px="lg"
        pt="lg"
        pb="xs"
        justify="space-between"
        wrap="nowrap"
        style={{ borderBottom: '1px solid var(--quorum-line)' }}
      >
        <Text className="quorum-eyebrow">Models</Text>

        <Group gap={0} wrap="nowrap">
          <Text className="quorum-eyebrow" w={110} ta="center" visibleFrom="xs">
            Chairman
          </Text>
          <Tooltip
            label="Our own price estimate per 1,000 tokens. What is billed is OpenRouter's figure for the provider it routed to."
            multiline
            w={260}
            withArrow
          >
            <Text className="quorum-eyebrow" w={96} ta="right" style={{ cursor: 'help' }}>
              Cost / 1K
            </Text>
          </Tooltip>
        </Group>
      </Group>

      {models.map((model) => (
        <ModelRow
          key={model.id}
          model={model}
          selected={isSelected(model.id)}
          isChairman={chairmanId === model.id}
          disabled={disabled || (!isSelected(model.id) && selectedIds.length >= MAX_COUNCIL)}
          onToggle={(on) => toggleModel(model.id, on)}
          onNominate={() => onChange({ chairmanId: model.id })}
        />
      ))}

      {showSettings && (
        <Stack gap="md" p="lg" style={{ borderTop: '1px solid var(--quorum-line)' }}>
          <SettingSwitch
            checked={chairmanAbstains}
            onChange={(value) => onChange({ chairmanAbstains: value })}
            disabled={disabled}
            label="Chairman abstains from drafting"
            help="The judge doesn't grade its own answer. Recommended."
          />
          <SettingSwitch
            checked={rebuttalEnabled}
            onChange={(value) => onChange({ rebuttalEnabled: value })}
            disabled={disabled}
            label="Rebuttal round"
            help="Drafters may defend, revise, or concede after the verdict."
          />
        </Stack>
      )}
    </Stack>
  );
}

function ModelRow({ model, selected, isChairman, disabled, onToggle, onNominate }) {
  return (
    <Box style={{ borderBottom: '1px solid var(--quorum-line)' }}>
      <Group px="lg" py="md" justify="space-between" wrap="nowrap">
        {/* `flex: 1` all the way down to the name `Box`, not just `minWidth: 0`
            — `minWidth: 0` alone says "you are ALLOWED to shrink below your
            content's natural size", not "claim the row's remaining space".
            Without a flex-basis to wrap within, a wrapping (not truncating)
            text node has no width to wrap AT, and the browser was shrinking it
            to a near-arbitrary sliver — "Claude Haiku 4.5" rendered one or two
            characters per line, worse than the truncation this replaced.

            The gaps shrink below `xs` too (`md`→`xs`, `sm`→4px): at 320px —
            "the hardest case", per the responsive audit — switch, avatar and
            the 96px price column alone leave the name column ~42px wide even
            with the space above reclaimed, which is still one word per line
            at best. Every pixel a gap gives back here is a pixel the name
            gets, and the price column below does the same. */}
        <Group gap={{ base: 'xs', xs: 'md' }} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
          <Switch
            checked={selected}
            onChange={(event) => onToggle(event.currentTarget.checked)}
            disabled={disabled && !selected}
            color="ink"
            size="md"
            aria-label={`Include ${model.displayName}`}
          />

          {/* Dimmed rather than hidden when off: the mockup keeps the row legible
              so the council reads as a set of choices, not a list of the chosen. */}
          <Box style={{ opacity: selected ? 1 : 0.45, minWidth: 0, flex: 1 }}>
            <Group gap={{ base: 4, xs: 'sm' }} wrap="nowrap" style={{ minWidth: 0 }}>
              <ModelBadge model={model} />
              {/* The name wraps rather than truncates — there is room for a
                  second line (the price column shrinks below `xs`, freeing
                  more of it) and "Gemini 2.5 Flash" ellipsised to
                  "Gemini 2.5 …" is a worse reading than two short lines. */}
              <Box style={{ minWidth: 0, flex: 1 }}>
                <Text fw={700} style={{ overflowWrap: 'break-word' }}>
                  {model.displayName}
                </Text>
                <Text size="sm" c="var(--quorum-mute)" truncate>
                  {providerLabel(model.provider)}
                </Text>
              </Box>
            </Group>
          </Box>
        </Group>

        <Group gap={0} wrap="nowrap">
          <Group w={110} justify="center" gap="xs" wrap="nowrap" visibleFrom="xs">
            <Tooltip label="Toggle the model on to nominate it" disabled={selected} withArrow>
              <Box>
                <Radio
                  checked={isChairman}
                  onChange={onNominate}
                  disabled={!selected}
                  color="brass"
                  aria-label={`Make ${model.displayName} chairman`}
                />
              </Box>
            </Tooltip>

            {isChairman && (
              <Badge color="brass" variant="light" radius="sm" size="sm" tt="lowercase">
                judging
              </Badge>
            )}
          </Group>

          <Tooltip
            label={`${money(model.inputPer1k)} in · ${money(model.outputPer1k)} out, per 1K tokens`}
            withArrow
          >
            {/* 96px comfortably fits every price ("$0.0001"–"$0.500") with
                room to spare — that spare room is exactly what the name
                column below `xs` cannot afford to leave unclaimed. */}
            <Text w={{ base: 68, xs: 96 }} ta="right" c="var(--quorum-ink)" style={{ cursor: 'help' }}>
              {money(model.outputPer1k)}
            </Text>
          </Tooltip>
        </Group>
      </Group>

      {/* Below `xs` the radio column above is hidden — there is no room for it
          next to the always-visible price column without truncating the name
          to nothing — so chairman selection moves to its own full-width row.
          It is a button rather than a bare radio because the tap target has to
          be the whole row (44px tall) for a control that decides half the
          product's outcome, not just the 20px dot. */}
      <UnstyledButton
        hiddenFrom="xs"
        onClick={selected ? onNominate : undefined}
        disabled={!selected}
        role="radio"
        aria-checked={isChairman}
        aria-label={isChairman ? `${model.displayName} is chairman` : `Make ${model.displayName} chairman`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          minHeight: 44,
          padding: '8px 20px 12px',
          opacity: selected ? 1 : 0.45,
          cursor: selected ? 'pointer' : 'not-allowed',
        }}
      >
        {/* A decorative dot, not a <Radio> — a real `<input>` cannot legally
            nest inside this `<button>`, and the button above already carries
            the radio role and checked state for assistive tech. */}
        <Box
          aria-hidden="true"
          style={{
            width: 16,
            height: 16,
            flexShrink: 0,
            borderRadius: '50%',
            border: `1px solid ${isChairman ? 'var(--quorum-brass)' : 'var(--quorum-mute)'}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {isChairman && (
            <Box style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--quorum-brass)' }} />
          )}
        </Box>
        <Text size="sm" fw={isChairman ? 700 : 500} c={isChairman ? 'var(--quorum-brass)' : 'var(--quorum-mute)'}>
          {isChairman ? 'Chairman — judges the debate' : 'Make chairman'}
        </Text>
      </UnstyledButton>
    </Box>
  );
}

function SettingSwitch({ checked, onChange, label, help, disabled }) {
  return (
    <Group gap="md" align="flex-start" wrap="nowrap">
      <Switch
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        disabled={disabled}
        color="ink"
        size="md"
        mt={2}
        aria-label={label}
      />
      <Box>
        <Text fw={700}>{label}</Text>
        <Text size="sm" c="var(--quorum-mute)">
          {help}
        </Text>
      </Box>
    </Group>
  );
}

/**
 * The catalogue stores a vendor slug (`anthropic`, `openai`); the mockup shows
 * the name a person would write. Anything unrecognised is capitalised rather
 * than dropped, so seating a fifth vendor needs no change here.
 */
const PROVIDER_LABELS = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  meta: 'Meta',
};

function providerLabel(provider) {
  return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** Prices are per 1K tokens and run to four decimals; two would show $0.00. */
function money(value) {
  return `$${Number(value ?? 0).toFixed(Number(value) < 0.001 ? 4 : 3)}`;
}
