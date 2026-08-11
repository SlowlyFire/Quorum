import { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import {
  Avatar,
  Box,
  Burger,
  Divider,
  Drawer,
  Group,
  Menu,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconLogout, IconWallet } from '@tabler/icons-react';

import { useAuth } from '../context/AuthContext.jsx';
import { Logo } from './Logo.jsx';

/**
 * The chrome every signed-in screen sits inside, matching the §5 mockups'
 * header: wordmark left, nav links beside it, credits chip and avatar right.
 *
 * The mockups are all desktop, and §Technical Requirements asks for a
 * responsive layout, so below `sm` the nav links move into a burger — which is
 * exactly what quorum-05-mobile.png shows.
 */
const NAV_LINKS = [
  { label: 'Sessions', to: '/sessions' },
  { label: 'Leaderboard', to: '/leaderboard' },
  { label: 'Wallet', to: '/wallet' },
];

export function AppShell({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const isMobile = useMediaQuery('(max-width: 48em)');
  const [drawerOpen, setDrawerOpen] = useState(false);

  async function handleLogout() {
    setDrawerOpen(false);
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <Box mih="100vh" bg="var(--quorum-panel)">
      <Box
        component="header"
        h={64}
        px={{ base: 'md', sm: 'xl' }}
        bg="var(--quorum-paper)"
        style={{ borderBottom: '1px solid var(--quorum-line)' }}
      >
        <Group h="100%" justify="space-between" wrap="nowrap">
          <Group gap="xl" wrap="nowrap">
            <Link to={user ? '/sessions' : '/'} style={{ textDecoration: 'none' }}>
              <Logo />
            </Link>

            {!isMobile && (
              <Group gap="lg" wrap="nowrap">
                {NAV_LINKS.map((link) => (
                  <HeaderLink key={link.to} to={link.to}>
                    {link.label}
                  </HeaderLink>
                ))}
              </Group>
            )}
          </Group>

          <Group gap="sm" wrap="nowrap">
            <CreditsChip balance={user?.creditBalance} />

            {isMobile ? (
              <Burger
                opened={drawerOpen}
                onClick={() => setDrawerOpen((open) => !open)}
                size="sm"
                aria-label="Open navigation"
              />
            ) : (
              <AccountMenu user={user} onLogout={handleLogout} />
            )}
          </Group>
        </Group>
      </Box>

      <Drawer
        opened={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        position="right"
        size="16rem"
        title={<Logo size={22} />}
      >
        <Stack gap="xs">
          {NAV_LINKS.map((link) => (
            <DrawerLink key={link.to} to={link.to} onNavigate={() => setDrawerOpen(false)}>
              {link.label}
            </DrawerLink>
          ))}

          <Divider my="xs" />

          <Text size="sm" c="dimmed" px="xs">
            {user?.displayName}
          </Text>
          <DrawerLink to="#" onNavigate={handleLogout} asButton>
            Log out
          </DrawerLink>
        </Stack>
      </Drawer>

      <Box component="main">{children}</Box>
    </Box>
  );
}

function HeaderLink({ to, children }) {
  return (
    <NavLink to={to} style={{ textDecoration: 'none' }}>
      {({ isActive }) => (
        <Text
          size="md"
          fw={isActive ? 600 : 500}
          c={isActive ? 'var(--quorum-ink)' : 'var(--quorum-mute)'}
        >
          {children}
        </Text>
      )}
    </NavLink>
  );
}

function DrawerLink({ to, children, onNavigate, asButton = false }) {
  const props = asButton
    ? { component: 'button', type: 'button', onClick: onNavigate }
    : { component: Link, to, onClick: onNavigate };

  return (
    <UnstyledButton
      {...props}
      p="xs"
      style={{ borderRadius: 8, textAlign: 'left', width: '100%' }}
    >
      <Text fw={500} c="var(--quorum-ink)">
        {children}
      </Text>
    </UnstyledButton>
  );
}

/**
 * The brass-on-brassBg pill from the mockups. It reads user.creditBalance,
 * which is real today and always 0 until Session 9 funds a wallet — the chip
 * is not a placeholder, its balance is.
 */
function CreditsChip({ balance }) {
  const amount = Number.isFinite(balance) ? balance : 0;

  return (
    <Box
      px="md"
      py={6}
      style={{
        background: 'var(--quorum-brass-bg)',
        border: '1px solid var(--quorum-brass-border)',
        borderRadius: 999,
        whiteSpace: 'nowrap',
      }}
    >
      <Text size="sm" fw={600} c="var(--quorum-brass)">
        ${amount.toFixed(2)} credits
      </Text>
    </Box>
  );
}

function AccountMenu({ user, onLogout }) {
  const initial = (user?.displayName?.trim()[0] ?? '?').toUpperCase();

  return (
    <Menu position="bottom-end" shadow="md" width={220}>
      <Menu.Target>
        <UnstyledButton aria-label="Account menu">
          <Avatar radius="xl" color="ink" variant="light">
            {initial}
          </Avatar>
        </UnstyledButton>
      </Menu.Target>

      <Menu.Dropdown>
        <Menu.Label>
          <Text size="sm" fw={600} c="var(--quorum-ink)" truncate>
            {user?.displayName}
          </Text>
          <Text size="xs" c="dimmed" truncate>
            {user?.email}
          </Text>
        </Menu.Label>

        <Menu.Divider />

        <Menu.Item component={Link} to="/wallet" leftSection={<IconWallet size={16} />}>
          Wallet
        </Menu.Item>
        <Menu.Item color="red" leftSection={<IconLogout size={16} />} onClick={onLogout}>
          Log out
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
