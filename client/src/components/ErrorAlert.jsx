import { Alert, List } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

import { ApiError } from '../api/client.js';

/**
 * The one way an ApiError is shown to a user.
 *
 * A form renders its server errors against the field the envelope names, and
 * falls back to this for everything that names no field — a 409, a 429, a 502
 * from the model provider, or the server simply not being there. Anything
 * details-shaped that a form did NOT claim is listed, so a validation failure
 * cannot silently render as an empty box.
 */
export function ErrorAlert({ error, title, claimedFields = [], ...props }) {
  if (!error) return null;

  const isApiError = error instanceof ApiError;
  const message = isApiError ? error.message : 'Something went wrong. Please try again.';

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
  if (error?.isNetworkError) return 'Cannot reach the server';
  if (error?.status === 429) return 'Slow down';
  if (error?.status >= 500) return 'Server error';
  return 'That did not work';
}
