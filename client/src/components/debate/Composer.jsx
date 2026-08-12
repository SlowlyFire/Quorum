import { useRef } from 'react';
import { ActionIcon, Button, Group, Paper, Stack, Text, Textarea, Tooltip } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';

import { AttachmentChip } from './AttachmentChip.jsx';
import { ACCEPTED_TYPES, MAX_PER_ROUND, canSee } from '../../lib/attachments.js';
import { estimateRound, formatCost } from '../../lib/cost.js';

/**
 * "Ask a follow-up…" — the composer at the foot of the thread.
 *
 * Disabled while a round runs, and that is a product decision rather than a
 * technical one: the server would happily start a second debate, and the two
 * would interleave in one thread while both spent money. A round is 8–47
 * seconds, which is short enough to wait for and long enough that the button
 * has to say why it will not press.
 *
 * The estimate beside it is the same arithmetic as the council picker's, over
 * the session's stored council. It is labelled "est." for decision 16's reason:
 * OpenRouter bills whichever upstream provider it routed to.
 *
 * The attachment button became real in Session 11. Uploading is a separate
 * request that happens as soon as a file is chosen, not on send — an 8 MB PNG
 * should be going up while the question is still being typed, and by the time
 * Send is pressed the round is starting with an id rather than a file.
 */
export function Composer({
  value,
  onChange,
  onSend,
  disabled,
  running,
  session,
  models,
  estimate,
  attachments = [],
  onAttach,
  onRemoveAttachment,
}) {
  const fileInput = useRef(null);

  const selected = models.filter((model) =>
    session.council.models.some((member) => member.id === model.id),
  );

  const { total } = estimateRound(
    {
      selected,
      chairmanId: session.council.chairmanId,
      chairmanAbstains: session.chairmanAbstains,
      rebuttalEnabled: session.rebuttalEnabled,
      /**
       * The question being typed, so the figure moves as it is written. A long
       * question produces longer drafts and stages 2-4 pay to read them back —
       * quoting a two-line judgement call at the price of "what is 17x4" was
       * how Session 13's study cost 2.6x its estimate.
       */
      promptText: value,
    },
    estimate,
  );

  /**
   * A round cannot start while a file is still going up: its id does not exist
   * yet, so it could not be named in the body. Saying so is better than a Send
   * that quietly drops the attachment.
   */
  const uploading = attachments.some((item) => item.progress !== undefined && item.progress < 1);
  const canSend = value.trim().length > 0 && !disabled && !uploading;
  const atLimit = attachments.length >= MAX_PER_ROUND;

  /**
   * Which council members will not be able to see what is attached. Computed
   * from the catalogue rows the picker already loaded, using the same `canSee`
   * the round view uses on persisted data — one rule, two surfaces.
   */
  const blind = attachments.length === 0
    ? []
    : selected.filter(
        (model) =>
          model.id !== (session.chairmanAbstains ? session.council.chairmanId : null) &&
          attachments.some((attachment) => attachment.id && !canSee(model, attachment)),
      );

  function handleKeyDown(event) {
    // Enter sends, Shift+Enter breaks the line — the convention every chat
    // surface has taught. A question can be several paragraphs, so the escape
    // hatch matters as much as the shortcut.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSend();
    }
  }

  function handleFiles(event) {
    const chosen = [...event.currentTarget.files];

    // Reset first, so choosing the same file twice in a row still fires change.
    event.currentTarget.value = '';

    if (chosen.length > 0) onAttach?.(chosen);
  }

  return (
    <Paper
      withBorder
      radius="md"
      p="sm"
      bg="var(--quorum-paper)"
      style={{ borderColor: 'var(--quorum-line)' }}
    >
      <Stack gap="xs">
        {attachments.length > 0 && (
          <Group gap="xs" px="xs" wrap="wrap">
            {attachments.map((attachment) => (
              <AttachmentChip
                key={attachment.key ?? attachment.id}
                attachment={attachment}
                onRemove={onRemoveAttachment}
                size={44}
              />
            ))}
          </Group>
        )}

        {blind.length > 0 && (
          <Text size="xs" c="var(--quorum-brass)" px="xs">
            {blind.map((model) => model.displayName).join(', ')}{' '}
            {blind.length === 1 ? 'cannot' : 'cannot'} read{' '}
            {blind.length === 1 ? 'this attachment' : 'these attachments'} and will be told so in
            its prompt.
          </Text>
        )}

        <Group gap="sm" align="flex-end" wrap="nowrap">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPTED_TYPES.join(',')}
            onChange={handleFiles}
            style={{ display: 'none' }}
          />

          <Tooltip
            label={
              atLimit
                ? `At most ${MAX_PER_ROUND} attachments per question`
                : 'Attach a PNG, JPEG, WebP or PDF'
            }
            withArrow
          >
            <ActionIcon
              variant="subtle"
              color="gray"
              size="lg"
              radius="xl"
              disabled={disabled || atLimit}
              onClick={() => fileInput.current?.click()}
              aria-label="Attach a file"
            >
              <IconPlus size={18} />
            </ActionIcon>
          </Tooltip>

          <Textarea
            variant="unstyled"
            placeholder={running ? 'The council is deliberating…' : 'Ask a follow-up…'}
            autosize
            minRows={1}
            maxRows={8}
            maxLength={8000}
            value={value}
            onChange={(event) => onChange(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            style={{ flex: 1 }}
            aria-label="Your question"
          />

          <Button onClick={onSend} disabled={!canSend} loading={running}>
            Send
          </Button>
        </Group>

        <Group justify="space-between" gap="sm" px="xs">
          <Text size="xs" c="var(--quorum-mute)">
            {running
              ? 'One round at a time — this one is still running.'
              : uploading
                ? 'Waiting for the upload to finish…'
                : 'Enter to send, Shift+Enter for a new line.'}
          </Text>
          <Text size="xs" c="var(--quorum-mute)">
            est. ~{formatCost(total)} per question
          </Text>
        </Group>
      </Stack>
    </Paper>
  );
}
