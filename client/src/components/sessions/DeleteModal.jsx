import { Button, Group, Modal, Stack, Text } from '@mantine/core';

/**
 * The one delete path in the product, for the same reason `RenameModal` is:
 * `/sessions` and the debate view both render this against the same
 * `DELETE /api/sessions/:id` call.
 *
 * Deleting a session cascades to its rounds and every model response in them,
 * so the confirmation says so in those words rather than asking "are you sure".
 * What it does NOT claim to delete is the billing history: the ledger's
 * `round_id` is ON DELETE SET NULL precisely so the record of what was charged
 * outlives the conversation, and telling a user their spending is erased would
 * be false.
 */
export function DeleteModal({ session, onClose, onConfirm }) {
  return (
    <Modal opened={Boolean(session)} onClose={onClose} title="Delete this session?" centered radius="md">
      <Stack gap="md">
        <Text>
          “{session?.title ?? 'Untitled session'}” and all{' '}
          {session?.roundCount ?? 0} of its {session?.roundCount === 1 ? 'debate' : 'debates'} will
          be deleted — every draft, verdict and rebuttal. This cannot be undone.
        </Text>

        <Text size="sm" c="var(--quorum-mute)">
          Your wallet history is not affected: the ledger keeps what each round cost, without the
          session it belonged to.
        </Text>

        {session?.shareToken && (
          <Text size="sm" c="var(--quorum-brass)">
            The public link to this session will stop working.
          </Text>
        )}

        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button color="red" onClick={onConfirm}>
            Delete session
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
