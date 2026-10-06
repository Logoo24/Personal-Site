// Vercel Routing Middleware: everything under /family needs a family-hub
// session (see api/_family/session.js). Signed-out visitors are sent to
// /family/login, which comes back to the page they asked for.
// The hub's data is protected again inside api/family.js; this just keeps
// signed-out visitors from landing on empty hub pages.

import { readSession } from './api/_family/session.js';

export const config = { matcher: ['/family', '/family/:path*'] };

const OPEN = /^\/family\/(login(\.html)?|assets\/.*)$/;

export default async function middleware(request) {
  const url = new URL(request.url);
  if (OPEN.test(url.pathname)) return;
  if (await readSession(request)) return;
  const login = new URL('/family/login', url);
  if (url.pathname !== '/family' && url.pathname !== '/family/') login.searchParams.set('next', url.pathname + url.search);
  return Response.redirect(login, 302);
}
