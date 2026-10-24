import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Center, Paper, PasswordInput, Stack, TextInput, Title } from '@mantine/core';
import { useAuth } from './AuthContext.js';

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const destination = location.state?.from?.pathname ?? '/';
  if (user) return <Navigate to={destination} replace />;

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate(destination, { replace: true });
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder shadow="sm" p="xl" w="100%" maw={400}>
        <form onSubmit={handleSubmit}>
          <Stack>
            <Title order={2}>Vastrasanskara</Title>
            {error && <Alert color="red">{error}</Alert>}
            <TextInput
              label="Email"
              type="email"
              autoComplete="username"
              required
              withAsterisk={false}
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
            />
            <PasswordInput
              label="Password"
              autoComplete="current-password"
              required
              withAsterisk={false}
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
            <Button type="submit" loading={submitting}>
              Log in
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
