import { useEffect, useState } from 'react';
import { Button, Group, Modal, Stack, TextInput } from '@mantine/core';

/**
 * The one rename path in the product. `/sessions` and the debate view both
 * render this component against the same `PATCH /api/sessions/:id` call
 * (`updateSession` in `api/quorum.js`) — a second implementation is a second
 * place the 120-character limit or the empty-title guard could drift from
 * the server's own `updateSessionSchema`.
 */
export function RenameModal({ session, onClose, onSave }) {
  const [title, setTitle] = useState('');

  useEffect(() => {
    if (session) setTitle(session.title ?? '');
  }, [session]);

  const trimmed = title.trim();

  return (
    <Modal opened={Boolean(session)} onClose={onClose} title="Rename session" centered radius="md">
      <Stack gap="md">
        <TextInput
          label="Title"
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && trimmed) onSave(trimmed);
          }}
          maxLength={120}
          data-autofocus
        />

        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSave(trimmed)} disabled={!trimmed}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
