import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Anchor, Button, PasswordInput, Stack, TextInput } from '@mantine/core';

import { fieldErrorMap } from '../api/client.js';
import { ErrorAlert } from '../components/ErrorAlert.jsx';
import { DEFAULT_SIGNED_IN_ROUTE } from '../routes.js';
import { useAuth } from '../context/AuthContext.jsx';
import { AuthLayout } from './AuthLayout.jsx';
import {
  normaliseEmail,
  validateDisplayName,
  validateEmail,
  validateNewPassword,
} from '../validation/authFields.js';

export function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [values, setValues] = useState({ displayName: '', email: '', password: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  function setField(name, value) {
    setValues((current) => ({ ...current, [name]: value }));
    setFieldErrors((current) => ({ ...current, [name]: null }));
  }

  async function handleSubmit(event) {
    event.preventDefault();

    const clientErrors = {
      displayName: validateDisplayName(values.displayName),
      email: validateEmail(values.email),
      password: validateNewPassword(values.password),
    };

    if (Object.values(clientErrors).some(Boolean)) {
      setFieldErrors(clientErrors);
      return;
    }

    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      await register({
        displayName: values.displayName.trim(),
        email: normaliseEmail(values.email),
        password: values.password,
      });

      navigate(DEFAULT_SIGNED_IN_ROUTE, { replace: true });
    } catch (cause) {
      // A 409 is the one refusal that belongs to a field but carries no
      // `details` — the server declines to attach the pg error, because its
      // detail line quotes the conflicting address. Put it under the email box
      // in words, which is what the user needs to act on.
      if (cause.status === 409) {
        setFieldErrors({ email: 'An account with that email already exists' });
        setError(null);
      } else {
        const named = fieldErrorMap(cause);
        if (named) setFieldErrors(named);
        setError(cause);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Assemble a council and put a question to it."
      footer={
        <>
          Already have an account?{' '}
          <Anchor component={Link} to="/login" c="var(--quorum-brass)" fw={600}>
            Sign in
          </Anchor>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate>
        <Stack gap="md">
          <ErrorAlert error={error} claimedFields={['displayName', 'email', 'password']} />

          <TextInput
            label="Display name"
            placeholder="Ada Lovelace"
            autoComplete="name"
            autoFocus
            maxLength={60}
            value={values.displayName}
            onChange={(event) => setField('displayName', event.currentTarget.value)}
            error={fieldErrors.displayName}
          />

          <TextInput
            label="Email"
            placeholder="you@example.com"
            type="email"
            autoComplete="email"
            value={values.email}
            onChange={(event) => setField('email', event.currentTarget.value)}
            error={fieldErrors.email}
          />

          <PasswordInput
            label="Password"
            placeholder="At least 8 characters"
            autoComplete="new-password"
            description="Minimum 8 characters."
            value={values.password}
            onChange={(event) => setField('password', event.currentTarget.value)}
            error={fieldErrors.password}
          />

          <Button type="submit" fullWidth loading={submitting} mt="xs">
            Create account
          </Button>
        </Stack>
      </form>
    </AuthLayout>
  );
}
