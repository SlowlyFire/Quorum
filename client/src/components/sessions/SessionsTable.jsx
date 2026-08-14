import { Link } from 'react-router-dom';
import { Anchor, Badge, Box, Button, Center, Group, Loader, Stack, Table, Text } from '@mantine/core';
import { IconLink, IconShare } from '@tabler/icons-react';

import { ModelBadge } from '../ModelBadge.jsx';
import { SessionActionsMenu } from './SessionActionsMenu.jsx';
import { formatCost } from '../../lib/cost.js';
import { relativeTime, verdictChipFor } from '../../lib/verdict.js';

/**
 * Mockup 03's session table.
 *
 * The row is a link to the debate and the menu is not, which is the one
 * interaction worth being careful about: the title is an `<a>` so it opens in a
 * new tab on a middle click like any other link, and the trailing controls stop
 * the click from bubbling so "Delete" never also navigates.
 *
 * Below `48em` the table scrolls horizontally inside its own container rather
 * than collapsing into cards. Five short columns fit a 390px viewport at a
 * scroll, and a card layout would be a second component rendering the same rows
 * with a second set of bugs.
 */
export function SessionsTable({ sessions, loading, onShare, onRename, onDelete }) {
  if (loading) {
    return (
      <Center py={80}>
        <Loader color="ink" size="sm" />
      </Center>
    );
  }

  return (
    <Box style={{ overflowX: 'auto' }}>
      <Table verticalSpacing="md" horizontalSpacing="md" miw={720}>
        <Table.Thead>
          <Table.Tr>
            <HeaderCell>TITLE</HeaderCell>
            <HeaderCell>COUNCIL</HeaderCell>
            <HeaderCell>VERDICT</HeaderCell>
            <HeaderCell align="right">SPEND</HeaderCell>
            <HeaderCell>WHEN</HeaderCell>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>

        <Table.Tbody>
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              onShare={onShare}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </Table.Tbody>
      </Table>
    </Box>
  );
}

function HeaderCell({ children, align }) {
  return (
    <Table.Th ta={align}>
      <Text size="xs" fw={700} c="var(--quorum-mute)" style={{ letterSpacing: '0.06em' }}>
        {children}
      </Text>
    </Table.Th>
  );
}

function SessionRow({ session, onShare, onRename, onDelete }) {
  const chip = verdictChipFor(session.latestVerdictType);
  const models = session.council?.models ?? [];

  return (
    // The whole row tints on hover, not just the title link. A row whose only
    // response is on eight characters of text reads as a table of data rather
    // than as a list of things you can open.
    <Table.Tr className="quorum-hover-row">
      <Table.Td>
        <Anchor
          component={Link}
          to={`/chat/${session.id}`}
          c="var(--quorum-ink)"
          fw={700}
          underline="hover"
        >
          <Text fw={700} lineClamp={1} maw={320}>
            {session.title ?? 'Untitled session'}
          </Text>
        </Anchor>

        <Group gap={6} mt={2}>
          <Text size="xs" c="var(--quorum-mute)">
            {session.roundCount} {session.roundCount === 1 ? 'question' : 'questions'}
          </Text>

          {/* The shared state belongs on the row, not only in the modal: a user
              scanning the list needs to see which of these are public. */}
          {session.shareToken && (
            <Group gap={3} c="var(--quorum-brass)">
              <IconLink size={12} />
              <Text size="xs" fw={600}>
                Shared
              </Text>
            </Group>
          )}
        </Group>
      </Table.Td>

      <Table.Td>
        <Group gap={-4} wrap="nowrap">
          {models.map((model, index) => (
            <Box key={model.id} ml={index === 0 ? 0 : -6}>
              <ModelBadge model={model} size={26} fz={12} />
            </Box>
          ))}
          {models.length === 0 && (
            <Text size="sm" c="var(--quorum-mute)">
              —
            </Text>
          )}
        </Group>
      </Table.Td>

      <Table.Td>
        {chip ? (
          <Badge variant="outline" color={chip.color} radius="sm" style={{ textTransform: 'none' }}>
            {chip.label}
          </Badge>
        ) : (
          <Text size="sm" c="var(--quorum-mute)">
            No rounds yet
          </Text>
        )}
      </Table.Td>

      <Table.Td ta="right">
        <Text size="sm" c="var(--quorum-mute)" style={{ whiteSpace: 'nowrap' }}>
          {formatCost(session.totalSpend, { precise: session.totalSpend < 0.01 })}
        </Text>
      </Table.Td>

      <Table.Td>
        <Text size="sm" c="var(--quorum-mute)" style={{ whiteSpace: 'nowrap' }}>
          {relativeTime(session.updatedAt)}
        </Text>
      </Table.Td>

      <Table.Td>
        <Group gap="xs" justify="flex-end" wrap="nowrap">
          <Button
            variant="subtle"
            color="gray"
            size="compact-sm"
            leftSection={<IconShare size={14} />}
            onClick={() => onShare(session)}
          >
            Share
          </Button>

          <SessionActionsMenu session={session} onShare={onShare} onRename={onRename} onDelete={onDelete} />
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

/** A user with no sessions at all — distinct from a filter that matched none. */
export function SessionsEmptyState({ filtered, onClear }) {
  return (
    <Stack gap="sm" align="center" py={60} px="md">
      <Text fw={700} fz="lg">
        {filtered ? 'No sessions match that' : 'No debates yet'}
      </Text>
      <Text c="var(--quorum-mute)" ta="center" maw={420}>
        {filtered
          ? 'Try a different search, or clear the verdict filter.'
          : 'Assemble a council, ask it something, and the debate will show up here with every draft, the chairman’s reasoning, and who conceded.'}
      </Text>

      {filtered ? (
        <Button variant="default" onClick={onClear}>
          Clear filters
        </Button>
      ) : (
        <Button component={Link} to="/new" size="md">
          Start your first debate
        </Button>
      )}
    </Stack>
  );
}
