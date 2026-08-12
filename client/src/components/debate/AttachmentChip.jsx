import { ActionIcon, Box, Group, Image, Progress, Text, Tooltip } from '@mantine/core';
import { IconFileTypePdf, IconX } from '@tabler/icons-react';

import { formatBytes, isImage } from '../../lib/attachments.js';

/**
 * One attachment, as a chip: thumbnail, size, and a remove control.
 *
 * The same component serves three states, because they are the same object at
 * three moments and giving each its own component is how they drift apart:
 *
 *   uploading   a progress bar across the bottom, no remove control — there is
 *               nothing to delete on the server yet
 *   failed      the reason, in red, and a remove control that only forgets it
 *   ready       the thumbnail from the signed URL, and a remove that deletes
 *
 * `readOnly` drops the control entirely, which is how the chip appears on a
 * round already run and on the public shared view.
 */
export function AttachmentChip({ attachment, onRemove, readOnly = false, size = 64 }) {
  const failed = Boolean(attachment.error);
  const uploading = attachment.progress !== undefined && attachment.progress < 1 && !failed;

  return (
    <Box
      style={{
        position: 'relative',
        border: `1px solid ${failed ? 'var(--mantine-color-red-4)' : 'var(--quorum-line)'}`,
        borderRadius: 8,
        background: 'var(--quorum-panel)',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <Group gap="sm" wrap="nowrap" p={6} pr={readOnly ? 10 : 30}>
        <Thumbnail attachment={attachment} size={size} failed={failed} />

        <Box style={{ minWidth: 0, maxWidth: 190 }}>
          <Text size="xs" fw={600} c="var(--quorum-ink)" truncate>
            {label(attachment)}
          </Text>
          <Text size="xs" c={failed ? 'red' : 'var(--quorum-mute)'} lineClamp={2}>
            {failed
              ? attachment.error
              : uploading
                ? `Uploading… ${Math.round(attachment.progress * 100)}%`
                : formatBytes(attachment.sizeBytes)}
          </Text>
        </Box>
      </Group>

      {uploading && (
        <Progress
          value={attachment.progress * 100}
          size={3}
          radius={0}
          color="ink"
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
        />
      )}

      {!readOnly && !uploading && (
        <Tooltip label="Remove" withArrow position="top">
          <ActionIcon
            size="sm"
            radius="xl"
            variant="subtle"
            color="gray"
            onClick={() => onRemove?.(attachment)}
            aria-label={`Remove ${label(attachment)}`}
            style={{ position: 'absolute', top: 4, right: 4 }}
          >
            <IconX size={13} />
          </ActionIcon>
        </Tooltip>
      )}
    </Box>
  );
}

function Thumbnail({ attachment, size, failed }) {
  /**
   * A local object URL while the file is still going up, the signed URL once it
   * has arrived. The first means the preview is instant and needs no network;
   * the second means what is shown is what the server actually stored.
   */
  const src = attachment.previewUrl ?? attachment.signedUrl;

  if (isImage(attachment) && src && !failed) {
    return (
      <Image
        src={src}
        w={size}
        h={size}
        fit="cover"
        radius={4}
        alt=""
        style={{ flexShrink: 0, background: 'var(--quorum-line)' }}
      />
    );
  }

  return (
    <Box
      w={size}
      h={size}
      style={{
        borderRadius: 4,
        background: 'var(--quorum-paper)',
        border: '1px solid var(--quorum-line)',
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
      }}
    >
      <IconFileTypePdf size={26} color="var(--quorum-mute)" />
    </Box>
  );
}

/**
 * NOT the client's filename — we never send it, and the server would not keep
 * it if we did. What a chip has to say is what the thing IS, and the thumbnail
 * says the rest.
 */
function label(attachment) {
  if (attachment.error) return attachment.name ?? 'Attachment';

  return isImage(attachment) ? 'Image' : 'PDF document';
}
