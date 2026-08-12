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
 *
 * SESSION 12 ADDED MOTION TO EXACTLY TWO THINGS HERE, and both of them are the
 * rail saying where the machine is:
 *
 *   the running disc breathes a soft ring outward — ink on 1 and 3, brass on 2
 *   and 4, so even the pulse carries the chairman distinction — and
 *
 *   the dashed connector below a finished stage FILLS DOWNWARD. That is the
 *   whole point of the rail: a user glancing at the screen should see how far
 *   the round has got without reading a word. It is a `scaleY` on a
 *   pseudo-element, so it costs one compositor property and no layout, on a
 *   rail that is re-rendered on every SSE frame.
 *
 * The dim-to-solid change is an opacity transition and NOT an animation, which
 * is why it survives `prefers-reduced-motion`: it is information about which
 * stage is live, and a user who asked for less movement still needs it.
 */
export function StageBlock({ stage, state, skipReason, heading, isLast = false, children }) {
  const skipped = state === STAGE_STATE.skipped;
  const running = state === STAGE_STATE.running;
  const pending = state === STAGE_STATE.pending;
  const failed = state === STAGE_STATE.failed;

  /**
   * How much of the run to the next stage is drawn. 1 once this stage is behind
   * us, a half-height stub while it is working — which reads as "on the way"
   * rather than as an arrival that has not happened.
   */
  const connectorProgress = skipped || state === STAGE_STATE.done ? 1 : running ? 0.5 : 0;

  const disc = (
    <Box
      w={34}
      h={34}
      className={
        running ? (stage.chairman ? 'quorum-stage-running-brass' : 'quorum-stage-running') : undefined
      }
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
        // Not an animation, so reduced motion keeps it. See the note above.
        transition: 'opacity 250ms ease, background-color 250ms ease',
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
            className="quorum-connector"
            style={{ '--quorum-connector-progress': connectorProgress }}
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
