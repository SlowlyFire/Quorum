import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Box,
  Burger,
  Center,
  Drawer,
  Group,
  Loader,
  Stack,
  Text,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';

import { Composer } from '../components/debate/Composer.jsx';
import { CouncilRail } from '../components/debate/CouncilRail.jsx';
import { ErrorAlert } from '../components/ErrorAlert.jsx';
import { RoundView } from '../components/debate/RoundView.jsx';
import { SessionSidebar } from '../components/debate/SessionSidebar.jsx';
import { TopUpPrompt } from '../components/debate/TopUpPrompt.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import {
  fetchCatalogue,
  fetchSession,
  listSessions,
  startRound,
  updateSession,
} from '../api/quorum.js';
import { roundFromDetail } from '../lib/round.js';
import { useRoundStream } from '../hooks/useRoundStream.js';

/**
 * Mockup 02 — the debate view, and the screen the product is.
 *
 * Three panes on a desktop (sessions, thread, council + spend), stacked on a
 * phone. What it orchestrates is smaller than it looks, because the two hard
 * parts live elsewhere: `useRoundStream` owns the EventSource and its fallbacks,
 * and `lib/round.js` turns both a live stream and a persisted row into the same
 * object. This file decides *which* round is live and when to reconcile.
 *
 * RECONCILIATION, WHICH IS THE ONLY SUBTLE PART. A round is rendered from the
 * stream while it runs and from the database once it has finished, and the swap
 * has to be invisible. So `onSettled` refetches the session first and clears the
 * live round only after that resolves — the persisted row carries the token
 * counts no frame ever did, and clearing first would blank the transcript for a
 * frame.
 *
 * A refresh mid-round needs no special case at all: the session detail names a
 * round whose status is not `complete` or `failed`, that id becomes the live
 * one, and the server replays its whole buffer to the new subscriber.
 */
export function Chat() {
  const { sessionId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { refreshUser } = useAuth();

  const isNarrow = useMediaQuery('(max-width: 62em)');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [session, setSession] = useState(null);
  const [sessions, setSessions] = useState(null);
  const [catalogue, setCatalogue] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [sendError, setSendError] = useState(null);

  const [live, setLive] = useState(null); // { roundId, prompt }
  const [draft, setDraft] = useState('');
  const [starting, setStarting] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());

  const bottomRef = useRef(null);

  // -- loading -------------------------------------------------------------

  const loadSession = useCallback(async () => {
    const detail = await fetchSession(sessionId);
    setSession(detail);
    return detail;
  }, [sessionId]);

  const loadSessions = useCallback(async () => {
    const { sessions: rows } = await listSessions({ limit: 50 });
    setSessions(rows);
  }, []);

  useEffect(() => {
    let cancelled = false;

    setSession(null);
    setLive(null);
    setLoadError(null);
    setExpanded(new Set());

    async function load() {
      try {
        const [detail] = await Promise.all([
          fetchSession(sessionId),
          loadSessions(),
          catalogue ? Promise.resolve() : fetchCatalogue().then(setCatalogue),
        ]);

        if (cancelled) return;
        setSession(detail);

        /**
         * A round left running by a refresh, a closed tab, or a second window.
         * The engine kept going without us — the debate is a background job on
         * the server, not a foreground task of this page — so picking it up is
         * just subscribing to its stream.
         */
        const unfinished = (detail.rounds ?? []).find(
          (round) => round.status !== 'complete' && round.status !== 'failed',
        );

        if (unfinished) setLive({ roundId: unfinished.id, prompt: unfinished.prompt });
      } catch (error) {
        if (!cancelled) setLoadError(error);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
    // `catalogue` is deliberately not a dependency: it is fetched once for the
    // life of the page and re-running this on it would reload the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, loadSessions]);

  // -- the live round ------------------------------------------------------

  const onSettled = useCallback(async () => {
    try {
      await Promise.all([
        loadSession(),
        loadSessions(),
        /**
         * The wallet was debited by the engine as the round finished, so the
         * balance in the header is now one round stale. Refetching the user is
         * what makes the credits chip fall as the debate is paid for, and it is
         * batched with the other two so the whole screen settles at once.
         * `refreshUser` never rejects.
         */
        refreshUser(),
      ]);
    } finally {
      // Only now: the persisted round is in state, so the transcript never
      // blanks between the last frame and the row that replaces it.
      setLive(null);
    }
  }, [loadSession, loadSessions, refreshUser]);

  const { round: liveRound, transport } = useRoundStream({
    roundId: live?.roundId ?? null,
    prompt: live?.prompt,
    onSettled,
  });

  const rounds = useMemo(() => {
    const persisted = (session?.rounds ?? []).map(roundFromDetail);

    if (!liveRound?.id) return persisted;

    // The row for a live round exists in the database from the moment POST
    // answered 202, so it is already in `persisted` — as a shell. The stream is
    // ahead of it in every respect, so it wins.
    const index = persisted.findIndex((round) => round.id === liveRound.id);

    if (index === -1) return [...persisted, liveRound];

    return persisted.map((round, at) => (at === index ? liveRound : round));
  }, [session, liveRound]);

  useEffect(() => {
    if (live?.roundId) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [live?.roundId]);

  // -- sending -------------------------------------------------------------

  const send = useCallback(
    async (prompt) => {
      const question = prompt.trim();
      if (!question) return;

      setSendError(null);
      setStarting(true);

      try {
        const { roundId } = await startRound(sessionId, { prompt: question });

        setDraft('');
        setLive({ roundId, prompt: question });
        // The round row is inserted before the 202, so this reload already sees
        // it; the sidebar's ordering and this session's title depend on it.
        await Promise.all([loadSession(), loadSessions()]);
      } catch (error) {
        setSendError(error);
      } finally {
        setStarting(false);
      }
    },
    [sessionId, loadSession, loadSessions],
  );

  /**
   * The question typed on /new, handed over in router state. Sent once and then
   * erased from history, so a refresh does not ask it again — and it is guarded
   * by a ref rather than by the state itself, because `navigate(replace)` does
   * not take effect before this effect could run a second time.
   */
  const firstPromptSent = useRef(false);

  useEffect(() => {
    const firstPrompt = location.state?.firstPrompt;

    if (!firstPrompt || !session || firstPromptSent.current) return;

    firstPromptSent.current = true;
    navigate(location.pathname, { replace: true, state: null });
    void send(firstPrompt);
  }, [location.state, location.pathname, session, navigate, send]);

  async function saveCouncil(body) {
    await updateSession(sessionId, body);
    await Promise.all([loadSession(), loadSessions()]);
  }

  // -- render --------------------------------------------------------------

  if (loadError) {
    return (
      <Box p="xl">
        <ErrorAlert error={loadError} title="Could not open this session" />
      </Box>
    );
  }

  if (!session || !catalogue) {
    return (
      <Center py={120}>
        <Loader color="ink" />
      </Center>
    );
  }

  const running = Boolean(live?.roundId) || starting;
  const lastIndex = rounds.length - 1;

  const sidebar = (
    <SessionSidebar
      sessions={sessions}
      loading={!sessions}
      activeId={sessionId}
      onNavigate={() => setSidebarOpen(false)}
    />
  );

  const rail = (
    <CouncilRail session={session} models={catalogue.models} rounds={rounds} onSave={saveCouncil} />
  );

  return (
    <Box style={{ display: 'flex', alignItems: 'stretch', minHeight: 'calc(100vh - 64px)' }}>
      {!isNarrow && (
        <Box
          w={280}
          style={{
            flexShrink: 0,
            borderRight: '1px solid var(--quorum-line)',
            background: 'var(--quorum-paper)',
          }}
        >
          {sidebar}
        </Box>
      )}

      <Drawer
        opened={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        size="17rem"
        title="Sessions"
        padding={0}
      >
        {sidebar}
      </Drawer>

      <Box style={{ flex: 1, minWidth: 0 }} p={{ base: 'md', sm: 'lg' }}>
        <Stack gap="xl" maw={900} mx="auto">
          {isNarrow && (
            <Group gap="sm">
              <Burger opened={sidebarOpen} onClick={() => setSidebarOpen(true)} size="sm" aria-label="Sessions" />
              <Text fw={700} lineClamp={1}>
                {session.title ?? 'Untitled session'}
              </Text>
            </Group>
          )}

          {rounds.length === 0 && (
            <Text c="var(--quorum-mute)">
              This session has no questions yet. Ask the council something below.
            </Text>
          )}

          {rounds.map((round, index) => (
            <RoundView
              key={round.id ?? index}
              round={round}
              /**
               * Everything but the newest round opens collapsed. A five-round
               * session is otherwise a page of twenty cards, and the thing a
               * user came back for is the answer, not the argument.
               */
              collapsed={index !== lastIndex && !expanded.has(round.id)}
              showToggle={index !== lastIndex}
              onToggleCollapsed={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(round.id)) next.delete(round.id);
                  else next.add(round.id);
                  return next;
                })
              }
            />
          ))}

          {transport === 'polling' && (
            <Text size="sm" c="var(--quorum-mute)">
              The live stream is unavailable, so this round is being polled instead. Nothing is lost —
              the record is in the database.
            </Text>
          )}

          {/* A 402 is not an error the user should read as a failure — it is
              the wallet saying no, and it has a remedy. Everything else is an
              alert as before. */}
          {sendError?.status === 402 ? (
            <TopUpPrompt error={sendError} />
          ) : (
            sendError && <ErrorAlert error={sendError} title="Could not start that round" />
          )}

          {isNarrow && rail}

          <Box ref={bottomRef}>
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={() => send(draft)}
              disabled={running}
              running={running}
              session={session}
              models={catalogue.models}
              estimate={catalogue.estimate}
            />
          </Box>
        </Stack>
      </Box>

      {!isNarrow && (
        <Box w={320} p="lg" style={{ flexShrink: 0 }}>
          {rail}
        </Box>
      )}
    </Box>
  );
}
