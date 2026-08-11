import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Anchor, Button, PasswordInput, Stack, TextInput } from '@mantine/core';

import { fieldErrorMap } from '../api/client.js';
import { ErrorAlert } from '../components/ErrorAlert.jsx';
import { DEFAULT_SIGNED_IN_ROUTE } from '../routes.js';
import { useAuth } from '../context/AuthContext.jsx';
import { AuthLayout } from './AuthLayout.jsx';
import { normaliseEmail, validateEmail, validateLoginPassword } from '../validation/authFields.js';

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [values, setValues] = useState({ email: '', password: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  function setField(name, value) {
    setValues((current) => ({ ...current, [name]: value }));
    // Clear a field's error the moment it is edited; leaving it under a box the
    // user is actively fixing reads as though the fix did not register.
    setFieldErrors((current) => ({ ...current, [name]: null }));
  }

  async function handleSubmit(event) {
    event.preventDefault();

    const clientErrors = {
      email: validateEmail(values.email),
      password: validateLoginPassword(values.password),
    };

    if (clientErrors.email || clientErrors.password) {
      setFieldErrors(clientErrors);
      return;
    }

    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      await login({ email: normaliseEmail(values.email), password: values.password });

      // Where the ProtectedRoute that bounced us here wanted to go. Absent —
      // the user came to /login directly — the default screen.
      const destination = location.state?.from?.pathname ?? DEFAULT_SIGNED_IN_ROUTE;
      navigate(destination, { replace: true });
    } catch (cause) {
      // The server names a field on a 400 and nothing else, so a 401 lands in
      // the alert above the form, which is right: it is not the email that is
      // wrong, and it is not the password — the server declines to say which.
      const named = fieldErrorMap(cause);
      if (named) setFieldErrors(named);
      setError(cause);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back. Your councils are where you left them."
      footer={
        <>
          No account yet?{' '}
          <Anchor component={Link} to="/register" c="var(--quorum-brass)" fw={600}>
            Create one
          </Anchor>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate>
        <Stack gap="md">
          <ErrorAlert error={error} claimedFields={['email', 'password']} />

          <TextInput
            label="Email"
            placeholder="you@example.com"
            type="email"
            autoComplete="email"
            autoFocus
            value={values.email}
            onChange={(event) => setField('email', event.currentTarget.value)}
            error={fieldErrors.email}
          />

          <PasswordInput
            label="Password"
            placeholder="Your password"
            autoComplete="current-password"
            value={values.password}
            onChange={(event) => setField('password', event.currentTarget.value)}
            error={fieldErrors.password}
          />

          <Button type="submit" fullWidth loading={submitting} mt="xs">
            Sign in
          </Button>
        </Stack>
      </form>
    </AuthLayout>
  );
}
