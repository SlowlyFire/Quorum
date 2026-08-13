import { Anchor, Button, Center, Stack, Text, Title } from '@mantine/core';
import { Link, useLocation } from 'react-router-dom';

import { Logo } from '../components/Logo.jsx';
import { SIGNED_IN_HOME } from '../routes.js';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * An unknown path, said out loud.
 *
 * This replaced a `<Navigate to="/" replace />`, which was worse than it looked.
 * A silent redirect to the landing page tells a user who mistyped a URL, or
 * followed a stale link, that the address was fine and the app simply decided to
 * show them something else — and it does the same to a signed-in user, who is
 * bounced to a marketing page they have already read. Nothing distinguishes
 * "that page does not exist" from "you are not allowed in", which are different
 * problems with different fixes.
 *
 * The route is deliberately OUTSIDE both guards, so it renders for signed-in and
 * signed-out visitors alike. What changes is the way out: a signed-in user is
 * offered their sessions, a stranger the landing page.
 */
export function NotFound() {
  const { user } = useAuth();
  const location = useLocation();

  return (
    <Center mih="100vh" bg="var(--quorum-panel)" p="lg">
      <Stack align="center" gap="lg" maw={460}>
        <Logo />

        <Stack align="center" gap={6}>
          <Title order={1} fz={{ base: 48, sm: 64 }} c="var(--quorum-ink)" lh={1}>
            404
          </Title>
          <Text fz="lg" fw={600}>
            That page does not exist
          </Text>
        </Stack>

        {/*
          The path is echoed because a mistyped URL is the common case and seeing
          it is how somebody spots the typo. `wordBreak` because a long unknown
          path is exactly the sort of unbroken string that pushes a phone
          sideways.
        */}
        <Text size="sm" c="var(--quorum-mute)" ta="center" style={{ wordBreak: 'break-all' }}>
          Nothing is served at <strong>{location.pathname}</strong>.
        </Text>

        <Button component={Link} to={user ? SIGNED_IN_HOME : '/'} size="md">
          {user ? 'Go to your sessions' : 'Back to the start'}
        </Button>

        {user && (
          <Anchor component={Link} to="/new" size="sm">
            or start a new debate
          </Anchor>
        )}
      </Stack>
    </Center>
  );
}
