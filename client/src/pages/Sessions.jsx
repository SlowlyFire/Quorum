import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Box,
  Button,
  Center,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconSearch } from '@tabler/icons-react';

import { DeleteModal } from '../components/sessions/DeleteModal.jsx';
import { ErrorAlert } from '../components/ErrorAlert.jsx';
import { PresetCards } from '../components/sessions/PresetCards.jsx';
import { PresetModal } from '../components/sessions/PresetModal.jsx';
import { RenameModal } from '../components/sessions/RenameModal.jsx';
import { SessionsEmptyState, SessionsTable } from '../components/sessions/SessionsTable.jsx';
import { ShareModal } from '../components/sessions/ShareModal.jsx';
import {
  deletePreset,
  deleteSession,
  fetchCatalogue,
  listPresets,
  listSessions,
  updateSession,
} from '../api/quorum.js';
import { VERDICT_FILTERS } from '../lib/verdict.js';
import { PageContainer } from '../components/PageContainer.jsx';

/**
 * Mockup 03 — session history and council presets.
 *
 * SEARCH AND THE VERDICT FILTER ARE BOTH SERVER-SIDE, and they have to be: the
 * list is paginated, so filtering the page the client happens to be holding
 * would search twenty rows and call the result "no matches". The search box is
 * debounced by 300ms — long enough that typing a word is one request rather than
 * six, short enough to feel live.
 *
 * The verdict chips filter on the LATEST round's verdict_type. A session has
 * many rounds, so that is the only reading that produces a stable list — the
 * reasoning is in the server's sessionModel, next to the SQL that does it.
 */
export function Sessions() {
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const [verdict, setVerdict] = useState('all');

  const [sessions, setSessions] = useState(null);
  const [presets, setPresets] = useState(null);
  const [models, setModels] = useState([]);
  const [error, setError] = useState(null);
  const [listing, setListing] = useState(false);

  const [shareFor, setShareFor] = useState(null);
  const [renameFor, setRenameFor] = useState(null);
  const [deleteFor, setDeleteFor] = useState(null);
  const [presetModal, setPresetModal] = useState(null); // { mode, preset }
  const [busyPresetId, setBusyPresetId] = useState(null);

  // -- loading -------------------------------------------------------------

  const loadSessions = useCallback(async () => {
    setListing(true);

    try {
      const { sessions: rows } = await listSessions({
        limit: 50,
        search: debouncedSearch || undefined,
        verdict,
      });

      setSessions(rows);
      setError(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setListing(false);
    }
  }, [debouncedSearch, verdict]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  /**
   * The catalogue and the presets load once, not per filter change. They are
   * the bottom half of the page and nothing about a search affects them.
   */
  const loadedOnce = useRef(false);

  useEffect(() => {
    if (loadedOnce.current) return;
    loadedOnce.current = true;

    async function load() {
      try {
        const [catalogue, rows] = await Promise.all([fetchCatalogue(), listPresets()]);
        setModels(catalogue.models);
        setPresets(rows);
      } catch (cause) {
        setError((current) => current ?? cause);
      }
    }

    void load();
  }, []);

  // -- session actions -----------------------------------------------------

  /** The share modal mints on open, so the row's "Shared" marker has to hear
   *  about a token the list did not fetch. */
  const applyShareToken = useCallback((sessionId, shareToken) => {
    setSessions((current) =>
      (current ?? []).map((session) =>
        session.id === sessionId ? { ...session, shareToken } : session,
      ),
    );
  }, []);

  async function handleRename(title) {
    const target = renameFor;
    setRenameFor(null);

    try {
      const updated = await updateSession(target.id, { title });
      setSessions((current) =>
        (current ?? []).map((session) =>
          session.id === target.id ? { ...session, title: updated.title } : session,
        ),
      );
    } catch (cause) {
      notifications.show({ color: 'red', title: 'Could not rename', message: cause.message });
    }
  }

  async function handleDelete() {
    const target = deleteFor;
    setDeleteFor(null);

    try {
      await deleteSession(target.id);
      setSessions((current) => (current ?? []).filter((session) => session.id !== target.id));
      notifications.show({
        color: 'gray',
        title: 'Session deleted',
        message: `“${target.title ?? 'Untitled session'}” and its debates are gone.`,
      });
    } catch (cause) {
      notifications.show({ color: 'red', title: 'Could not delete', message: cause.message });
    }
  }

  // -- preset actions ------------------------------------------------------

  function upsertPreset(saved) {
    setPresets((current) => {
      const rows = current ?? [];
      const index = rows.findIndex((preset) => preset.id === saved.id);

      return index === -1
        ? [...rows, saved]
        : rows.map((preset, at) => (at === index ? saved : preset));
    });
  }

  async function handleDeletePreset(preset) {
    setBusyPresetId(preset.id);

    try {
      await deletePreset(preset.id);
      setPresets((current) => (current ?? []).filter((row) => row.id !== preset.id));
    } catch (cause) {
      notifications.show({ color: 'red', title: 'Could not delete preset', message: cause.message });
    } finally {
      setBusyPresetId(null);
    }
  }

  // -- render --------------------------------------------------------------

  const isFiltered = Boolean(debouncedSearch) || verdict !== 'all';
  const showEmptyState = sessions?.length === 0;

  return (
    <PageContainer>
      <Stack gap="xl">
        <Title order={1} fz={{ base: 28, sm: 40 }}>
          Sessions
        </Title>

        <Group gap="sm" wrap="wrap" align="center">
          <TextInput
            placeholder="Search sessions…"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            leftSection={<IconSearch size={16} />}
            style={{ flex: '1 1 240px', minWidth: 200 }}
            aria-label="Search sessions"
          />

          <Group gap="xs" wrap="wrap">
            {VERDICT_FILTERS.map((filter) => (
              <Button
                key={filter.key}
                size="sm"
                radius="xl"
                variant={verdict === filter.key ? 'filled' : 'default'}
                onClick={() => setVerdict(filter.key)}
              >
                {filter.label}
              </Button>
            ))}
          </Group>

          <Button component={Link} to="/new" size="sm" ml="auto">
            New session
          </Button>
        </Group>

        {error && <ErrorAlert error={error} title="Could not load your sessions" />}

        <Box
          bg="var(--quorum-paper)"
          style={{ border: '1px solid var(--quorum-line)', borderRadius: 12, overflow: 'hidden' }}
        >
          {sessions === null ? (
            <Center py={80}>
              <Loader color="ink" size="sm" />
            </Center>
          ) : showEmptyState ? (
            <SessionsEmptyState
              filtered={isFiltered}
              onClear={() => {
                setSearch('');
                setVerdict('all');
              }}
            />
          ) : (
            <SessionsTable
              sessions={sessions}
              loading={listing && sessions.length === 0}
              onShare={setShareFor}
              onRename={setRenameFor}
              onDelete={setDeleteFor}
            />
          )}
        </Box>

        <Stack gap="md">
          <Title order={2} fz={{ base: 22, sm: 28 }}>
            Council presets
          </Title>

          {presets === null ? (
            <Center py={40}>
              <Loader color="ink" size="sm" />
            </Center>
          ) : (
            <PresetCards
              presets={presets}
              busyId={busyPresetId}
              onCreate={() => setPresetModal({ mode: 'create', preset: null })}
              onEdit={(preset) => setPresetModal({ mode: 'edit', preset })}
              onDuplicate={(preset) => setPresetModal({ mode: 'duplicate', preset })}
              onDelete={handleDeletePreset}
            />
          )}
        </Stack>
      </Stack>

      <ShareModal
        session={shareFor}
        opened={Boolean(shareFor)}
        onClose={() => setShareFor(null)}
        onChange={applyShareToken}
      />

      <RenameModal session={renameFor} onClose={() => setRenameFor(null)} onSave={handleRename} />

      <DeleteModal session={deleteFor} onClose={() => setDeleteFor(null)} onConfirm={handleDelete} />

      <PresetModal
        opened={Boolean(presetModal)}
        onClose={() => setPresetModal(null)}
        models={models}
        preset={presetModal?.preset ?? null}
        mode={presetModal?.mode ?? 'create'}
        onSaved={upsertPreset}
      />
    </PageContainer>
  );
}
