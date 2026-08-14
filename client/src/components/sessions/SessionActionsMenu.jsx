import { Box, Menu, UnstyledButton } from '@mantine/core';
import { IconDots, IconPencil, IconShare, IconTrash } from '@tabler/icons-react';

/**
 * The one kebab menu — Share, Rename, Delete — reused everywhere a session
 * row can be acted on: `/sessions`' table, the debate view's own title, and
 * the debate view's session sidebar. One component rather than three copies
 * of the same `<Menu>` is what keeps "Delete" meaning the same confirmation
 * and the same DELETE call in all three places.
 *
 * WRAPPED IN A `stopPropagation` BOX, because the sidebar's row is itself a
 * `<Link>` (the whole row navigates to the session) — React bubbles a click
 * through the tree the JSX declares, not the DOM tree a Mantine `Menu`
 * portals its dropdown into, so a click on "Delete" would otherwise also
 * fire the row's navigation. The wrapper is a no-op everywhere this menu is
 * NOT nested inside something clickable.
 */
export function SessionActionsMenu({ session, onShare, onRename, onDelete }) {
  return (
    <Box onClick={(event) => event.stopPropagation()} style={{ display: 'inline-flex' }}>
      <Menu position="bottom-end" shadow="md" width={180}>
        <Menu.Target>
          <UnstyledButton
            aria-label={`Actions for ${session.title ?? 'this session'}`}
            p={4}
            style={{ borderRadius: 6, color: 'var(--quorum-mute)' }}
          >
            <IconDots size={18} />
          </UnstyledButton>
        </Menu.Target>

        <Menu.Dropdown>
          <Menu.Item leftSection={<IconShare size={14} />} onClick={() => onShare(session)}>
            Share
          </Menu.Item>
          <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => onRename(session)}>
            Rename
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item
            color="red"
            leftSection={<IconTrash size={14} />}
            onClick={() => onDelete(session)}
          >
            Delete
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Box>
  );
}
