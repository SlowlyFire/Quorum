import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';

import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './global.css';

import { App } from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { theme } from './theme.js';

/**
 * Provider order matters in one place: AuthProvider is inside BrowserRouter,
 * because a 401 handler that wanted to navigate would need the router — and it
 * is inside MantineProvider, because it raises a notification when a session
 * expires.
 */
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="light">
      <Notifications position="top-right" limit={3} />
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </MantineProvider>
  </React.StrictMode>,
);
