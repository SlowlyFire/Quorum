import { Box, Stack, Text, Tooltip } from '@mantine/core';

import { STAGE_STATE } from '../../lib/round.js';

/**
 * The four numbered discs down the left of a round, connected by a dashed line —
 * the thing that makes the architecture legible. A user watching this should be
 * able to say what the machine is doing without being told.
 *
 * Colour carries one fact: **2 and 4 are brass because they are the chairman's
 * stages**, 1 and 3 are ink because they are the drafters'. It is the same
 * distinction the landing page's cards make and the same one the verdict card's
 * border makes.
 *
 * Four states, each drawn differently and none of them a spinner in a corner:
 * dim before a stage starts, pulsing while it runs, solid once it is done, and
 * struck through when it was skipped — with the reason on hover, because "why
 * did stage 3 not happen" is the first question a skipped stage raises.
 */
export function StageBlock({ stage, state, skipReason, heading, isLast = false, children }) {
  const skipped = state === STAGE_STATE.skipped;
  const running = state === STAGE_STATE.running;
  const pending = state === STAGE_STATE.pending;
  const failed = state === STAGE_STATE.failed;

  const disc = (
    <Box
      w={34}
      h={34}
      className={running ? 'quorum-stage-running' : undefined}
      style={{
        flexShrink: 0,
        borderRadius: 999,
        display: 'grid',
        placeItems: 'center',
        fontWeight: 700,
        fontSize: 14,
        color: skipped || pending ? 'var(--quorum-mute)' : '#fff',
        background: skipped
          ? 'transparent'
          : stage.chairman
            ? 'var(--quorum-brass)'
            : 'var(--quorum-ink)',
        border: skipped ? '2px dashed var(--quorum-line)' : 'none',
        opacity: pending ? 0.3 : 1,
        textDecoration: skipped ? 'line-through' : 'none',
        transition: 'opacity 200ms ease',
      }}
    >
      {stage.n}
    </Box>
  );

  return (
    <Box style={{ display: 'flex', gap: 'var(--mantine-spacing-md)', alignItems: 'stretch' }}>
      {/* The gutter: disc, label, and the dashed run down to the next stage.
          It grows with the block beside it, which is what keeps the line
          continuous however tall a stage's content turns out to be. */}
      <Box
        visibleFrom="sm"
        style={{ width: 72, display: 'flex', flexDirection: 'column', alignItems: 'center' }}
      >
        {skipReason ? (
          <Tooltip label={skipReason} multiline w={260} withArrow position="right">
            <Box style={{ cursor: 'help' }}>{disc}</Box>
          </Tooltip>
        ) : (
          disc
        )}

        <Text
          size="xs"
          fw={600}
          mt={6}
          ta="center"
          c={pending ? 'var(--quorum-line)' : 'var(--quorum-mute)'}
          td={skipped ? 'line-through' : undefined}
        >
          {stage.title}
        </Text>

        {!isLast && (
          <Box
            style={{
              flex: 1,
              width: 0,
              minHeight: 24,
              margin: '8px 0',
              borderLeft: '2px dashed var(--quorum-line)',
            }}
          />
        )}
      </Box>

      <Stack gap="xs" pb="lg" style={{ flex: 1, minWidth: 0 }}>
        <Text className="quorum-eyebrow" td={skipped ? 'line-through' : undefined}>
          {heading}
        </Text>

        {skipped ? (
          <Box
            p="md"
            style={{
              border: '1px dashed var(--quorum-line)',
              borderRadius: 'var(--mantine-radius-md)',
            }}
          >
            <Text size="sm" c="var(--quorum-mute)">
              Skipped — {lowerFirst(skipReason ?? 'this stage did not run for this round.')}
            </Text>
          </Box>
        ) : (
          children
        )}

        {failed && !skipped && (
          <Text size="sm" c="red.7">
            This stage did not finish.
          </Text>
        )}
      </Stack>
    </Box>
  );
}

/** The card writes "Skipped — the chairman found…"; the tooltip writes it as a
 *  sentence on its own. One reason string, two grammars. */
function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
