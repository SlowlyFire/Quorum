import { Link } from 'react-router-dom';
import { Anchor, Box, Button, Loader, Stack, Text, UnstyledButton } from '@mantine/core';

/**
 * The session list down the left of mockup 02, grouped Today / Yesterday /
 * Earlier.
 *
 * Grouped by date rather than paginated because a debate is remembered by when
 * it happened — "the SQL one from yesterday" — and `GET /api/sessions` already
 * returns newest activity first. The subtitle is the council size and the
 * verdict of the last round, which is the least a user needs to tell two
 * sessions about the same subject apart.
 */
export function SessionSidebar({ sessions, loading, activeId, onNavigate }) {
  const groups = groupByDay(sessions ?? []);

  return (
    <Stack gap="lg" p="md">
      <Button component={Link} to="/new" size="md" fullWidth onClick={onNavigate}>
        + New session
      </Button>

      {loading && (
        <Box ta="center" py="md">
          <Loader size="sm" color="ink" />
        </Box>
      )}

      {/* A sentence telling somebody to assemble a council is not a way to
          assemble one. The button above this list already goes to /new, so the
          empty state points at it rather than repeating it as prose. */}
      {!loading && sessions?.length === 0 && (
        <Stack gap={6} align="flex-start">
          <Text size="sm" c="var(--quorum-mute)">
            No sessions yet.
          </Text>
          <Anchor component={Link} to="/new" size="sm">
            Assemble a council →
          </Anchor>
        </Stack>
      )}

      {groups.map((group) => (
        <Stack key={group.label} gap={4}>
          <Text className="quorum-eyebrow">{group.label}</Text>

          {group.sessions.map((session) => (
            <SessionLink
              key={session.id}
              session={session}
              active={session.id === activeId}
              onNavigate={onNavigate}
            />
          ))}
        </Stack>
      ))}
    </Stack>
  );
}

function SessionLink({ session, active, onNavigate }) {
  return (
    <UnstyledButton
      component={Link}
      to={`/chat/${session.id}`}
      onClick={onNavigate}
      p="sm"
      className="quorum-hover-row"
      data-selected={active ? 'true' : undefined}
      style={{
        borderRadius: 'var(--mantine-radius-md)',
        background: active ? 'var(--quorum-line)' : 'transparent',
      }}
    >
      <Text fw={active ? 700 : 500} c="var(--quorum-ink)" lineClamp={1}>
        {session.title ?? 'Untitled session'}
      </Text>
      <Text size="sm" c="var(--quorum-mute)">
        {session.council.models.length} model{session.council.models.length === 1 ? '' : 's'}
        {session.roundCount ? ` · ${session.roundCount} question${session.roundCount === 1 ? '' : 's'}` : ''}
      </Text>
    </UnstyledButton>
  );
}

/**
 * Today / Yesterday / Earlier, on the client's own clock. `updatedAt` is what
 * the server sorts by — a session touched by a new round moves to the top — so
 * grouping on the same field keeps the order inside a group correct for free.
 */
function groupByDay(sessions) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;

  const buckets = { Today: [], Yesterday: [], Earlier: [] };

  for (const session of sessions) {
    const at = new Date(session.updatedAt ?? session.createdAt).getTime();

    if (at >= startOfToday) buckets.Today.push(session);
    else if (at >= startOfYesterday) buckets.Yesterday.push(session);
    else buckets.Earlier.push(session);
  }

  return Object.entries(buckets)
    .filter(([, group]) => group.length > 0)
    .map(([label, group]) => ({ label, sessions: group }));
}
