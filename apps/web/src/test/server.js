import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const notAuthenticated = () =>
  HttpResponse.json({ error: { code: 'NOT_AUTHENTICATED', message: 'Please sign in' } }, { status: 401 });

// Defaults: nobody is signed in and there are no notifications. Tests override with server.use().
export const server = setupServer(
  http.get('/v1/auth/me', notAuthenticated),
  http.get('/v1/notifications', () => HttpResponse.json({ items: [], unreadCount: 0 })),
);
