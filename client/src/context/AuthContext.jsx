import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { notifications } from '@mantine/notifications';

import { ApiError, api, setUnauthorizedHandler } from '../api/client.js';
import { humanMessage, signedOutNotice } from '../lib/errorMessages.js';

const AuthContext = createContext(null);

/**
 * The client's copy of who is signed in.
 *
 * There is no token to hold — it is in an httpOnly cookie the JavaScript
 * cannot read — so "am I signed in?" is only answerable by asking the server.
 * That is what the mount effect does, and it is why `loading` starts TRUE.
 *
 * Starting it false is the single most common bug in this pattern: for the one
 * render before GET /api/auth/me answers, `user` is null, every ProtectedRoute
 * sees an anonymous visitor, and a refresh on /sessions flashes the login page
 * before snapping back. The flash is not cosmetic either — the redirect is
 * real, and it takes the intended location with it.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const { user: me } = await api.get('/api/auth/me');
        if (!cancelled) setUser(me);
      } catch (cause) {
        // A 401 here is the normal answer for a visitor with no cookie, not a
        // failure worth showing. Anything else — the server is down, a 500 —
        // is worth showing, because it means the app cannot tell.
        if (!cancelled && cause instanceof ApiError && cause.status !== 401) {
          setError(cause);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * A 401 on any non-auth call means the cookie expired or was cleared in
   * another tab. Clearing `user` here is the whole redirect: every
   * ProtectedRoute reads it, so the one the user is standing on navigates to
   * /login by itself. Routing decisions stay in the router rather than moving
   * into a fetch wrapper that has no idea where the user is.
   */
  // The handler is registered once and must still see the current user, so it
  // reads a ref rather than closing over the state it was created with.
  const userRef = useRef(null);
  userRef.current = user;

  useEffect(() => {
    setUnauthorizedHandler((error) => {
      // A burst of parallel calls can all 401 at once; say it once.
      if (userRef.current === null) return;
      userRef.current = null;

      setUser(null);

      /**
       * The wording comes from the failure, not from a constant. This used to
       * be a hardcoded "Your session expired", which was simply false for the
       * commonest cause in production — a browser refusing to send the
       * cross-site session cookie, where nothing expired and signing in again
       * cannot work. The server distinguishes the two cases; discarding that
       * and asserting the wrong one was the actual defect.
       */
      const notice = signedOutNotice(error);

      notifications.show({
        color: 'red',
        title: notice.title,
        message: notice.message,
        ...(notice.autoClose === false ? { autoClose: false } : {}),
      });
    });

    return () => setUnauthorizedHandler(null);
  }, []);

  /**
   * Re-reads the signed-in user, which since Session 9 is how the header's
   * credits chip stays true: `creditBalance` rides on the user object, and a
   * round debits it on the server long after the object in this state was
   * fetched. Called by the debate view when a round settles and by the wallet
   * page after a top-up or a load.
   *
   * Deliberately silent on failure. It is a refresh of something already on the
   * screen, so a blip should leave the stale figure showing rather than blank
   * the header or raise an alert over a number that is about to be right again.
   * A 401 is the exception and it is not silent — `request` clears the user
   * through the unauthorized handler, exactly as it does for any other call.
   */
  const refreshUser = useCallback(async () => {
    try {
      const { user: me } = await api.get('/api/auth/me');
      setUser(me);
      return me;
    } catch {
      return null;
    }
  }, []);

  /**
   * DID THE COOKIE ACTUALLY STICK?
   *
   * A successful login is not the same as a usable session. The POST returns 200
   * and a user object even when the browser then refuses to STORE the
   * `Set-Cookie` it carried — which is what WebKit does to a third-party cookie,
   * and this cookie is third-party (decision 77). Trusting the response body
   * alone is how a user ends up signed in according to the app and anonymous
   * according to every subsequent request.
   *
   * The symptom that produced was the worst possible one: on a cold load the
   * bootstrap's own 401 is exempt from the sign-out handler — it is how an
   * anonymous visitor is detected — so the user was bounced to /login with NO
   * explanation, pressed Sign in again, and went round. One extra round trip per
   * sign-in buys the difference between that loop and a sentence saying why.
   */
  const confirmSessionUsable = useCallback(async () => {
    try {
      await api.get('/api/auth/me');
    } catch (cause) {
      if (cause?.status === 401) {
        throw new ApiError(humanMessage({ code: 'AUTH_REQUIRED' }), 401, 'AUTH_REQUIRED');
      }
      // Anything else — a blip, a 500 — is not evidence the cookie failed, and
      // refusing the sign-in over it would be worse than letting it through.
    }
  }, []);

  const login = useCallback(async (credentials) => {
    setError(null);
    const { user: me } = await api.post('/api/auth/login', credentials);
    await confirmSessionUsable();
    setUser(me);
    return me;
  }, [confirmSessionUsable]);

  const register = useCallback(async (details) => {
    setError(null);
    const { user: me } = await api.post('/api/auth/register', details);
    await confirmSessionUsable();
    setUser(me);
    return me;
  }, [confirmSessionUsable]);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      // The server's logout is a 204 that cannot fail, but a network error can
      // still stop it arriving. Clearing locally regardless is right: the user
      // asked to be signed out, and leaving them looking signed in is worse
      // than a cookie that outlives the click.
      setUser(null);
      setError(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, error, login, register, logout, refreshUser }),
    [user, loading, error, login, register, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (context === null) {
    throw new Error('useAuth must be used inside an AuthProvider');
  }

  return context;
}
