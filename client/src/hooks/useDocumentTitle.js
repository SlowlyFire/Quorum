import { useEffect } from 'react';
import { matchPath, useLocation } from 'react-router-dom';

/**
 * The tab title, per route.
 *
 * Every tab said "Quorum" until Session 12, which is the same as saying nothing
 * once a user has three of them open — and three open tabs is the normal state
 * of this product, because comparing two debates means looking at two debates.
 *
 * The pattern list mirrors `App.jsx`'s routes and is checked in order, so the
 * specific paths win before the catch-all. A route added there without a line
 * here falls back to the bare wordmark rather than to the previous page's
 * title, which would be worse than generic.
 */
const TITLES = [
  ['/', 'Quorum — make several AI models argue, then answer'],
  ['/login', 'Sign in · Quorum'],
  ['/register', 'Create an account · Quorum'],
  ['/new', 'New debate · Quorum'],
  ['/sessions', 'Sessions · Quorum'],
  ['/wallet', 'Wallet · Quorum'],
  ['/leaderboard', 'Leaderboard · Quorum'],
  ['/chat/:sessionId', 'Debate · Quorum'],
  ['/s/:shareToken', 'Shared debate · Quorum'],
];

export function useDocumentTitle() {
  const { pathname } = useLocation();

  useEffect(() => {
    const match = TITLES.find(([pattern]) => matchPath({ path: pattern, end: true }, pathname));

    document.title = match?.[1] ?? 'Quorum';
  }, [pathname]);
}
