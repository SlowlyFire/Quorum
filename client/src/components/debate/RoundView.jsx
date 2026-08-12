import { Anchor, Alert, Box, Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core';

import { AttachmentChip } from './AttachmentChip.jsx';
import { DraftCard, RebuttalCard } from './ResponseCards.jsx';
import { FinalCard } from './FinalCard.jsx';
import { StageBlock } from './StageBlock.jsx';
import { VerdictCard } from './VerdictCard.jsx';
import { blindDrafters } from '../../lib/attachments.js';
import { STAGES, STAGE_STATE } from '../../lib/round.js';

/**
 * One round: the question, then the four stages down the rail.
 *
 * A session is a conversation, so the same component renders the round happening
 * right now and the four before it. What changes is `collapsed` — an older round
 * shows its final answer and a toggle, because five rounds of full transcript is
 * a page nobody scrolls. The toggle says "show deliberation", which is what is
 * hidden: never the answer.
 */
export function RoundView({ round, collapsed = false, onToggleCollapsed, showToggle = false }) {
  const isLive = round.status !== 'complete' && round.status !== 'failed';

  return (
    <Stack gap="md">
      <PromptCard
        prompt={round.prompt}
        attachments={round.attachments ?? []}
        council={round.council ?? []}
      />

      {round.error && (
        <Alert color="red" variant="light" radius="md" title="This round did not finish">
          {round.error}
        </Alert>
      )}

      {collapsed ? (
        <Stack gap="xs">
          <FinalCard final={round.stages.final} totals={round.totals} />
          <Anchor component="button" type="button" size="sm" onClick={onToggleCollapsed}>
            Show deliberation ›
          </Anchor>
        </Stack>
      ) : (
        <>
          <Box>
            {STAGES.map((stage, index) => (
              <StageBlock
                key={stage.key}
                stage={stage}
                heading={stage.heading}
                state={round.stages[stage.key].state}
                skipReason={round.stages[stage.key].skipReason}
                isLast={index === STAGES.length - 1}
              >
                <StageContent stageKey={stage.key} round={round} isLive={isLive} />
              </StageBlock>
            ))}
          </Box>

          {showToggle && (
            <Anchor component="button" type="button" size="sm" onClick={onToggleCollapsed}>
              ‹ Hide deliberation
            </Anchor>
          )}
        </>
      )}
    </Stack>
  );
}

function StageContent({ stageKey, round, isLive }) {
  const stage = round.stages[stageKey];

  if (stageKey === 'draft') {
    /**
     * `expected` is the drafter count from `round_started`, so the grid can show
     * a skeleton in the place each answer will land rather than growing a card
     * at a time. It is null for a persisted round, where every card already
     * exists.
     */
    const missing = Math.max(0, (stage.expected ?? 0) - stage.items.length);

    if (stage.items.length === 0 && missing === 0 && stage.state === STAGE_STATE.pending) {
      return <WaitingNote>Waiting for the drafters…</WaitingNote>;
    }

    return (
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        {stage.items.map((item) => (
          <DraftCard key={item.key ?? item.label} item={item} />
        ))}
        {Array.from({ length: missing }, (_, index) => (
          <DraftCard key={`pending-${index}`} item={{}} pending />
        ))}
      </SimpleGrid>
    );
  }

  if (stageKey === 'verdict') {
    if (stage.state === STAGE_STATE.pending) return <WaitingNote>The chairman has not read the drafts yet.</WaitingNote>;

    return <VerdictCard verdict={stage} running={stage.state === STAGE_STATE.running} />;
  }

  if (stageKey === 'rebuttal') {
    if (stage.items.length === 0) {
      return stage.state === STAGE_STATE.pending ? (
        <WaitingNote>Not started.</WaitingNote>
      ) : (
        <WaitingNote>Waiting for the drafters to respond to the verdict…</WaitingNote>
      );
    }

    return (
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        {stage.items.map((item) => (
          <RebuttalCard key={item.key ?? item.label} item={item} />
        ))}
      </SimpleGrid>
    );
  }

  if (stage.state === STAGE_STATE.pending) return <WaitingNote>Not started.</WaitingNote>;

  return (
    <FinalCard
      final={stage}
      totals={round.totals}
      running={isLive && stage.state === STAGE_STATE.running}
    />
  );
}

function WaitingNote({ children }) {
  return (
    <Text size="sm" c="var(--quorum-mute)" py={4}>
      {children}
    </Text>
  );
}

/**
 * The question, as the mockup draws it: a white card with "you" beside it —
 * plus, since Session 11, whatever was attached to it.
 *
 * The attachments belong HERE rather than in stage 1, because they are part of
 * what the user asked rather than part of what the council did. A reader
 * scrolling back through a conversation has to be able to see that a round had
 * an image in it without expanding the deliberation.
 */
function PromptCard({ prompt, attachments, council }) {
  /**
   * Derived from the round's own council and its own attachments — the same
   * `canSee` rule the engine applied, so this line is right on a live round, on
   * a reload, and on the public shared view without any of the three storing it.
   */
  const blind = blindDrafters(council, attachments);

  return (
    <Paper
      withBorder
      radius="md"
      p="lg"
      bg="var(--quorum-paper)"
      style={{ borderColor: 'var(--quorum-line)' }}
    >
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="lg">
          <Text fz={{ base: 'md', sm: 'lg' }} style={{ whiteSpace: 'pre-wrap' }}>
            {prompt}
          </Text>
          <Text size="sm" c="var(--quorum-mute)" style={{ flexShrink: 0 }}>
            you
          </Text>
        </Group>

        {attachments.length > 0 && (
          <Stack gap="xs">
            <Group gap="xs" wrap="wrap">
              {attachments.map((attachment) => (
                <AttachmentChip key={attachment.id} attachment={attachment} readOnly size={52} />
              ))}
            </Group>

            {blind.length > 0 && (
              <Text size="xs" c="var(--quorum-brass)">
                {blind.map((member) => member.displayName).join(', ')} drafted without seeing{' '}
                {attachments.length === 1 ? 'this attachment' : 'these attachments'} — the model
                does not accept {attachments.some((a) => a.kind === 'document') ? 'documents' : 'images'},
                and its prompt said so.
              </Text>
            )}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
