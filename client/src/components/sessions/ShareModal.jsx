import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  CopyButton,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconCheck, IconCopy, IconInfoCircle } from '@tabler/icons-react';

import { ErrorAlert } from '../ErrorAlert.jsx';
import { revokeShare, shareSession } from '../../api/quorum.js';

/**
 * The share modal: mint a link, copy it, revoke it.
 *
 * IT MINTS ON OPEN, and that is a deliberate small commitment. The alternative —
 * a "Generate link" button inside the modal — makes sharing two clicks and a
 * decision, when the user already made the decision by pressing Share. The
 * server call is idempotent, so opening the modal twice does not rotate a link
 * somebody has already been sent; a session that was never shared gets a token,
 * and one that was shows the token it already had.
 *
 * The cost of minting on open is a token existing for a user who then closed the
 * modal without copying anything. Revoke is one click away in the same modal and
 * the row shows "Shared", so the state is never invisible.
 *
 * The copy control is Mantine's CopyButton rather than a hand-rolled one, so the
 * clipboard write happens directly in the click handler — a copy several awaits
 * from the user's gesture is a copy Safari refuses.
 */
export function ShareModal({ session, opened, onClose, onChange }) {
  const [share, setShare] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!opened || !session) return undefined;

    let cancelled = false;

    setShare(null);
    setError(null);

    async function mint() {
      try {
        const result = await shareSession(session.id);
        if (cancelled) return;

        setShare(result);
        // The row's "Shared" marker reads session.shareToken, so the list has
        // to hear about a token it did not have a moment ago.
        onChange?.(session.id, result.shareToken);
      } catch (cause) {
        if (!cancelled) setError(cause);
      }
    }

    void mint();

    return () => {
      cancelled = true;
    };
    // `onChange` is stable enough in practice and adding it re-mints on every
    // parent render, which is a POST per keystroke elsewhere on the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, session?.id]);

  async function handleRevoke() {
    setBusy(true);
    setError(null);

    try {
      await revokeShare(session.id);
      onChange?.(session.id, null);
      onClose();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Share this debate" centered radius="md">
      <Stack gap="md">
        <Text size="sm" c="var(--quorum-mute)">
          Anyone with this link can read {session?.title ? `“${session.title}”` : 'this session'} —
          every draft, the chairman’s reasoning and the final answer. They will not see your
          account or what the debate cost.
        </Text>

        {error && <ErrorAlert error={error} title="Could not share this session" />}

        {!share && !error && (
          <Group gap="xs">
            <Loader size="xs" color="ink" />
            <Text size="sm" c="var(--quorum-mute)">
              Creating the link…
            </Text>
          </Group>
        )}

        {share && (
          <>
            <Group gap="xs" wrap="nowrap" align="flex-end">
              <TextInput
                label="Public link"
                value={share.url}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
                style={{ flex: 1 }}
                styles={{ input: { fontFamily: 'monospace', fontSize: 13 } }}
              />

              <CopyButton value={share.url} timeout={1500}>
                {({ copied, copy }) => (
                  <Button
                    onClick={copy}
                    leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                    color={copied ? 'green' : undefined}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                )}
              </CopyButton>
            </Group>

            <Alert
              variant="light"
              color="gray"
              icon={<IconInfoCircle size={16} />}
              styles={{ message: { fontSize: 13 } }}
            >
              The link keeps working as you ask more questions — a shared session shows every round,
              including the ones you have not run yet.
            </Alert>

            <Group justify="space-between">
              <Button variant="subtle" color="red" onClick={handleRevoke} loading={busy}>
                Revoke link
              </Button>
              <Button variant="default" onClick={onClose}>
                Done
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}
