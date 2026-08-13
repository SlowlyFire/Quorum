import { Alert, List } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

import { humanMessage } from '../lib/errorMessages.js';

/**
 * The one way an ApiError is shown to a user.
 *
 * A form renders its server errors against the field the envelope names, and
 * falls back to this for everything that names no field — a 409, a 429, a 502
 * from the model provider, or the server simply not being there. Anything
 * details-shaped that a form did NOT claim is listed, so a validation failure
 * cannot silently render as an empty box.
 *
 * The message comes from `humanMessage`, which guarantees a sentence for any
 * thrown thing — including one that is not an ApiError at all — so no code and
 * no empty alert can reach the screen. It used to test `instanceof ApiError` and
 * show a generic line for everything else, which threw away a perfectly good
 * message from any error the client raised itself.
 */
export function ErrorAlert({ error, title, claimedFields = [], ...props }) {
  if (!error) return null;

  const message = humanMessage(error);

  const unclaimed = (error.details ?? []).filter(
    (detail) => !claimedFields.includes(detail.field),
  );

  return (
    <Alert
      color="red"
      variant="light"
      radius="md"
      icon={<IconAlertTriangle size={18} />}
      title={title ?? defaultTitle(error)}
      {...props}
    >
      {message}

      {unclaimed.length > 0 && (
        <List size="sm" mt="xs" spacing={2}>
          {unclaimed.map((detail) => (
            <List.Item key={`${detail.in}.${detail.field}`}>
              <strong>{detail.field}</strong> — {detail.message}
            </List.Item>
          ))}
        </List>
      )}
    </Alert>
  );
}

function defaultTitle(error) {
  // The one failure whose TITLE carries the diagnosis. "That did not work" is a
  // fine default for a 409 or a 502, and useless here: this is the case where
  // the user needs to know the cause before they read a word of the body.
  if (error?.code === 'AUTH_REQUIRED') return 'Your browser is blocking the session cookie';
  if (error?.isNetworkError) return 'Cannot reach the server';
  if (error?.status === 429) return 'Slow down';
  if (error?.status >= 500) return 'Server error';
  return 'That did not work';
}
