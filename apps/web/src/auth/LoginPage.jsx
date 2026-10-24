import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Alert, Anchor, Button, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { STAGES } from '@vs/shared/stages.js';
import { BrandStitch } from '../layout/Sidebar.jsx';
import { useAuth } from './AuthContext.js';

// The 14 stages as one long running stitch across the brand panel, knots filled to Tailors.
function ThreadMotif() {
  const step = 30;
  const done = 6;
  return (
    <svg width="100%" height="64" viewBox={`0 0 ${step * 13 + 16} 64`} preserveAspectRatio="xMinYMid meet" aria-hidden="true">
      <line x1="8" y1="32" x2={8 + step * done} y2="32" stroke="var(--vs-chalk)" strokeWidth="2" strokeDasharray="7 5" />
      <line x1={8 + step * done} y1="32" x2={8 + step * 13} y2="32" stroke="rgba(244,245,249,0.35)" strokeWidth="2" strokeDasharray="7 5" />
      {STAGES.map((s, i) =>
        i < done ? (
          <circle key={s.key} cx={8 + step * i} cy="32" r="5" fill="var(--vs-chalk)" />
        ) : i === done ? (
          <circle key={s.key} cx={8 + step * i} cy="32" r="8" fill="var(--vs-indigo)" stroke="var(--vs-haldi)" strokeWidth="3" />
        ) : (
          <circle key={s.key} cx={8 + step * i} cy="32" r="4" fill="var(--vs-indigo)" stroke="rgba(244,245,249,0.45)" strokeWidth="1.5" />
        ),
      )}
    </svg>
  );
}

function BrandPanel() {
  return (
    <div className="vs-login-brand">
      <div style={{ fontFamily: 'var(--vs-display)', fontSize: 22 }}>
        Vastrasanskara
        <BrandStitch />
      </div>
      <div>
        <ThreadMotif />
        <p className="vs-display" style={{ fontSize: 34, lineHeight: 1.2, margin: '28px 0 0', maxWidth: '16ch' }}>
          Every garment, every stage, on time.
        </p>
      </div>
      <Text size="sm" c="rgba(244,245,249,0.7)">
        Orders, production and billing for the house.
      </Text>
    </div>
  );
}

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
    <div className="vs-login">
      <BrandPanel />
      <div className="vs-login-form">
        <form onSubmit={handleSubmit} style={{ width: '100%', maxWidth: 360 }}>
          <Stack>
            <div>
              <h1 className="vs-display" style={{ margin: 0, fontSize: 30, color: 'var(--vs-indigo)' }}>
                Vastrasanskara
              </h1>
              <Text c="var(--vs-muted)" mt={4}>
                Log in to the workshop.
              </Text>
            </div>
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
            <Anchor component={Link} to="/forgot-password" size="sm">
              Forgot password?
            </Anchor>
          </Stack>
        </form>
      </div>
    </div>
  );
}
