import { Center, Loader } from '@mantine/core';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { AppShell } from './components/AppShell.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { useAuth } from './context/AuthContext.jsx';
import { Chat } from './pages/Chat.jsx';
import { Landing } from './pages/Landing.jsx';
import { Leaderboard } from './pages/Leaderboard.jsx';
import { Login } from './pages/Login.jsx';
import { NewSession } from './pages/NewSession.jsx';
import { Register } from './pages/Register.jsx';
import { Sessions } from './pages/Sessions.jsx';
import { Shared } from './pages/Shared.jsx';
import { Wallet } from './pages/Wallet.jsx';
import { SIGNED_IN_HOME } from './routes.js';

/**
 * Route paths follow the route table in the product document §6.
 *
 * Access control is here rather than in the pages, so that adding a route
 * cannot accidentally add an unguarded one: a page is protected by which of
 * the two blocks below it sits in, and that is visible in one screen.
 */
export function App() {
  const location = useLocation();

  return (
    // A crash on one page must not follow the user to the next, so the
    // boundary resets when the path changes.
    <ErrorBoundary resetKey={location.pathname}>
      <Routes>
        {/* Public. /s/:shareToken is the only unauthenticated read surface. */}
        <Route path="/" element={<Landing />} />
        <Route path="/s/:shareToken" element={<Shared />} />

        <Route
          path="/login"
          element={
            <PublicOnlyRoute>
              <Login />
            </PublicOnlyRoute>
          }
        />
        <Route
          path="/register"
          element={
            <PublicOnlyRoute>
              <Register />
            </PublicOnlyRoute>
          }
        />

        {/* Everything below needs a session cookie the server accepts. */}
        <Route
          path="/new"
          element={
            <ProtectedRoute>
              <NewSession />
            </ProtectedRoute>
          }
        />
        <Route
          path="/chat/:sessionId"
          element={
            <ProtectedRoute>
              <Chat />
            </ProtectedRoute>
          }
        />
        <Route
          path="/sessions"
          element={
            <ProtectedRoute>
              <Sessions />
            </ProtectedRoute>
          }
        />
        <Route
          path="/wallet"
          element={
            <ProtectedRoute>
              <Wallet />
            </ProtectedRoute>
          }
        />
        <Route
          path="/leaderboard"
          element={
            <ProtectedRoute>
              <Leaderboard />
            </ProtectedRoute>
          }
        />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ErrorBoundary>
  );
}

/**
 * A protected page renders inside the shell, and only once the bootstrap has
 * answered.
 *
 * The `loading` branch is the whole reason AuthContext starts loading at true.
 * Without it, the first render of a refresh on /sessions sees `user === null`,
 * redirects to /login, and then has to come back — which is visible as a flash
 * and, worse, throws away the location the user actually asked for.
 */
function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageLoader />;

  if (!user) {
    // `state.from` is what Login replays after a successful sign-in, so a user
    // who was sent here from /sessions lands back on /sessions and not on the
    // default screen. `replace` keeps the guarded URL out of the back stack.
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <AppShell>{children}</AppShell>;
}

/** /login and /register: a signed-in visitor has no business on either. */
function PublicOnlyRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) return <FullPageLoader />;
  if (user) return <Navigate to={SIGNED_IN_HOME} replace />;

  return children;
}

function FullPageLoader() {
  return (
    <Center mih="100vh" bg="var(--quorum-panel)">
      <Loader color="ink" />
    </Center>
  );
}
