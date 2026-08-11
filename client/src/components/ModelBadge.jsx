import { Box } from '@mantine/core';

import { modelBadgeColor, modelBadgeLetter } from '../theme.js';

/**
 * The coloured letter disc from every mockup — C, G, M, L.
 *
 * The colour is keyed on the vendor rather than the slug and comes from
 * theme.js, which is the only file allowed to know a hex value. What is passed
 * in is whatever the caller happens to hold: a model row, a council member, or
 * just a display name.
 */
export function ModelBadge({ model, size = 28, fz = 12 }) {
  return (
    <Box
      w={size}
      h={size}
      style={{
        flexShrink: 0,
        borderRadius: 999,
        background: modelBadgeColor(model),
        color: '#fff',
        display: 'grid',
        placeItems: 'center',
        fontWeight: 700,
        fontSize: fz,
        lineHeight: 1,
      }}
    >
      {modelBadgeLetter(model)}
    </Box>
  );
}
