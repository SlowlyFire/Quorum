import { Route, Routes } from 'react-router-dom';

import { Chat } from './pages/Chat.jsx';
import { Landing } from './pages/Landing.jsx';
import { Leaderboard } from './pages/Leaderboard.jsx';
import { Login } from './pages/Login.jsx';
import { NewSession } from './pages/NewSession.jsx';
import { Register } from './pages/Register.jsx';
import { Sessions } from './pages/Sessions.jsx';
import { Shared } from './pages/Shared.jsx';
import { Wallet } from './pages/Wallet.jsx';

/**
 * Route paths follow the route table in docs/quorum-product-document.md §6.
 * Access control (redirect to /login, owner-only checks) is not wired yet.
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/s/:shareToken" element={<Shared />} />

      <Route path="/new" element={<NewSession />} />
      <Route path="/chat/:sessionId" element={<Chat />} />
      <Route path="/sessions" element={<Sessions />} />
      <Route path="/leaderboard" element={<Leaderboard />} />
      <Route path="/wallet" element={<Wallet />} />
    </Routes>
  );
}
