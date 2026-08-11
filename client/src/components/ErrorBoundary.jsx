import { Component } from 'react';
import { Button, Center, Code, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';

/**
 * The last line of defence: a render-time throw anywhere below this component
 * shows a page instead of a white screen.
 *
 * It has to be a class — `componentDidCatch` and `getDerivedStateFromError`
 * have no hook equivalents, and that is still true in React 18.
 *
 * "Recoverable" means the user can get out without the browser's reload
 * button: `reset()` clears the error and re-renders the routes, which is
 * enough when the throw came from one page's state. A route change resets it
 * too, via the `resetKey` prop App passes — otherwise a crash on /wallet
 * follows the user to every page they navigate to afterwards.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // No error-reporting service in this build; the console is the record.
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <Center mih="100vh" p="md" bg="var(--quorum-panel)">
        <Paper withBorder radius="md" p="xl" maw={520} w="100%" bg="var(--quorum-paper)">
          <Stack gap="md">
            <Title order={2}>Something broke</Title>
            <Text c="dimmed">
              This screen hit an error it could not recover from on its own. Nothing you have
              already asked for was lost — debates keep running on the server.
            </Text>

            <Code block style={{ whiteSpace: 'pre-wrap' }}>
              {error.message || String(error)}
            </Code>

            <Group>
              <Button leftSection={<IconRefresh size={16} />} onClick={this.reset}>
                Try again
              </Button>
              <Button variant="default" component="a" href="/">
                Go home
              </Button>
            </Group>
          </Stack>
        </Paper>
      </Center>
    );
  }
}
