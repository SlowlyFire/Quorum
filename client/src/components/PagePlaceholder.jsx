import { Badge, Paper, Stack, Text, Title } from '@mantine/core';
import { PageContainer } from './PageContainer.jsx';

/**
 * A screen that is routed and reachable but not built yet.
 *
 * It says which session builds it rather than "coming soon", because the only
 * person looking at this is someone who wants to know whether it is missing or
 * broken — and those are different problems.
 */
export function PagePlaceholder({ title, session, children }) {
  return (
    <PageContainer>
      <Stack gap="lg">
        <Stack gap={6}>
          <Title order={1} fz={{ base: 28, sm: 34 }}>
            {title}
          </Title>
          {children && (
            <Text c="var(--quorum-mute)" maw={640}>
              {children}
            </Text>
          )}
        </Stack>

        <Paper
          withBorder
          radius="md"
          p="lg"
          bg="var(--quorum-paper)"
          style={{ borderColor: 'var(--quorum-line)' }}
        >
          <Stack gap="sm" align="flex-start">
            <Badge color="brass" variant="light" radius="sm">
              Not built yet
            </Badge>
            <Text size="sm" c="var(--quorum-mute)">
              This screen is scheduled for <strong>Session {session}</strong>. The server routes it
              needs are already live.
            </Text>
          </Stack>
        </Paper>
      </Stack>
    </PageContainer>
  );
}
