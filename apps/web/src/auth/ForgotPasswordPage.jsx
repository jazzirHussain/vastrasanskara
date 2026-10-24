import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Anchor, Button, Center, Paper, Stack, Text, TextInput, Title } from '@mantine/core';
import { apiFetch } from '../lib/api.js';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch('/v1/auth/password-reset/request', { method: 'POST', body: { email } });
      setSent(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder shadow="sm" p="xl" w="100%" maw={400}>
        <Stack>
          <Title order={2}>Reset your password</Title>
          {sent ? (
            <Text>If that email has an account, a reset link has been sent.</Text>
          ) : (
            <form onSubmit={handleSubmit}>
              <Stack>
                {error && <Alert color="red">{error}</Alert>}
                <TextInput
                  label="Email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.currentTarget.value)}
                />
                <Button type="submit" loading={submitting}>
                  Send reset link
                </Button>
              </Stack>
            </form>
          )}
          <Anchor component={Link} to="/login" size="sm">
            Back to log in
          </Anchor>
        </Stack>
      </Paper>
    </Center>
  );
}
