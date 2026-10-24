import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Anchor, Button, Center, Paper, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { apiFetch } from '../lib/api.js';
import { errorMessages } from '../lib/errorMessages.js';

/** Sets a new password from an emailed link (/reset-password?token=...), for resets and invites. */
export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch('/v1/auth/password-reset/confirm', { method: 'POST', body: { token, password } });
      setDone(true);
    } catch (err) {
      const passwordIssue = err.details?.find((d) => d.path === 'password');
      setError(passwordIssue ? 'Use at least 10 characters.' : err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder shadow="sm" p="xl" w="100%" maw={400}>
        <Stack>
          <Title order={2}>Set a new password</Title>
          {!token && <Alert color="red">{errorMessages.RESET_TOKEN_INVALID}</Alert>}
          {done ? (
            <Text>Password updated. You can now log in.</Text>
          ) : (
            token && (
              <form onSubmit={handleSubmit}>
                <Stack>
                  {error && <Alert color="red">{error}</Alert>}
                  <PasswordInput
                    label="New password"
                    description="At least 10 characters"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.currentTarget.value)}
                  />
                  <PasswordInput
                    label="Confirm password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.currentTarget.value)}
                  />
                  <Button type="submit" loading={submitting}>
                    Set password
                  </Button>
                </Stack>
              </form>
            )
          )}
          <Anchor component={Link} to="/login" size="sm">
            Go to log in
          </Anchor>
        </Stack>
      </Paper>
    </Center>
  );
}
