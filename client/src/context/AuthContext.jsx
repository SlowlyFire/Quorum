import { createContext, useContext, useMemo, useState } from 'react';

const AuthContext = createContext(null);

/**
 * Provider skeleton. Session bootstrap (GET /api/auth/me), login, register and
 * logout are not implemented yet — they land in the auth session.
 *
 * status: 'loading' | 'authenticated' | 'anonymous'
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading');

  const value = useMemo(() => ({ user, setUser, status, setStatus }), [user, status]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (context === null) {
    throw new Error('useAuth must be used inside an AuthProvider');
  }

  return context;
}
