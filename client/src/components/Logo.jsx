import { Group, Text } from '@mantine/core';

/**
 * The mockup's wordmark: a solid ink square, then QUORUM in bold letterspaced
 * caps. It appears in the header on every screen and on the landing page, so
 * it is one component rather than two Groups that drift apart.
 */
export function Logo({ size = 26, showText = true }) {
  return (
    <Group gap={10} wrap="nowrap">
      <div
        aria-hidden
        style={{
          width: size,
          height: size,
          borderRadius: 6,
          background: 'var(--quorum-ink)',
          flexShrink: 0,
        }}
      />
      {showText && (
        <Text
          fw={700}
          fz={size * 0.72}
          lh={1}
          c="var(--quorum-ink)"
          style={{ letterSpacing: '0.14em' }}
        >
          QUORUM
        </Text>
      )}
    </Group>
  );
}
