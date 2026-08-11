import { Link } from 'react-router-dom';
import { Box, Center, Container, Paper, Stack, Text, Title } from '@mantine/core';

import { Logo } from '../components/Logo.jsx';

/** The card Login and Register share, so the two cannot drift apart. */
export function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <Box mih="100vh" bg="var(--quorum-panel)">
      <Center mih="100vh" p="md">
        <Container size={420} w="100%" p={0}>
          <Stack gap="lg">
            <Center>
              <Link to="/" style={{ textDecoration: 'none' }}>
                <Logo size={28} />
              </Link>
            </Center>

            <Paper
              withBorder
              radius="md"
              p={{ base: 'lg', sm: 'xl' }}
              bg="var(--quorum-paper)"
              style={{ borderColor: 'var(--quorum-line)' }}
            >
              <Stack gap="lg">
                <Stack gap={4}>
                  <Title order={2} fz={26}>
                    {title}
                  </Title>
                  {subtitle && (
                    <Text size="sm" c="var(--quorum-mute)">
                      {subtitle}
                    </Text>
                  )}
                </Stack>

                {children}
              </Stack>
            </Paper>

            {footer && (
              <Text size="sm" ta="center" c="var(--quorum-mute)">
                {footer}
              </Text>
            )}
          </Stack>
        </Container>
      </Center>
    </Box>
  );
}
