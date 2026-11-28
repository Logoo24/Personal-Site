// Vercel function: the family hub's whole API, routed by ?r=. One function
// (rather than one per route) keeps us well inside the Hobby plan's limit.
//
//   POST login    {name, password}  -> sign in with the family password
//   POST google   {credential}      -> sign in with a Google ID token
//   POST logout
//   GET  session                    -> { user, googleClientId }
//   GET  recipes [&full=1]          -> cookbook index (or every full recipe)
//   GET  recipe&id=                 -> one recipe
//   POST recipe   {...recipe, slug?, private?} -> create / update (and its public link)
//   DELETE recipe&id=
//   POST upload   (raw image body)  -> { name, url }
//   GET  media&f=                   -> a stored photo
//   POST import   {url|text|files, tags} -> a draft recipe read from a link, pasted
//                                     text, or uploaded photos/PDF/documents
//                                     (files: [{name, data: base64}])
//   POST recipe-ask {id, question, history, factor} -> { answer } about one recipe
//   GET  calendar&from=&to=         -> calendar events (YYYY-MM-DD range)
//   GET  calendar-series&id=        -> a repeating event's repeat setting
//   POST calendar-event {action, id?, scope?, event?} -> add / edit / delete an event
//   *    fin-*                          -> Finance (api/_family/finance/index.js),
//                                          only for FAMILY_FINANCE_EMAILS
//   GET  fin-cron                       -> Finance's daily job (Vercel Cron via
//                                          /api/finance-cron, CRON_SECRET)
//   *    docs-*                         -> Documents (api/_family/docs/index.js),
//                                          only for FAMILY_DOCUMENTS_EMAILS
//
// Env: FAMILY_PASSWORD, FAMILY_SESSION_SECRET, GOOGLE_CLIENT_ID,
// FAMILY_GOOGLE_EMAILS, FAMILY_ADMIN_EMAILS, FAMILY_FINANCE_EMAILS and
// FAMILY_DOCUMENTS_EMAILS (comma-separated), the Blob store's
// BLOB_READ_WRITE_TOKEN, ANTHROPIC_API_KEY (recipe import, reading
// documents), GOOGLE_CALENDAR_SERVICE_ACCOUNT (calendar editing),
// FINANCE_ENCRYPTION_KEY (Finance) and GOOGLE_CLIENT_SECRET (Documents'
// Google Drive connection).

import { createToken, readSession, sessionCookie, clearedCookie, sessionSecret, safeEqual, isAdmin, canSeeFinance, canSeeDocuments } from './_family/session.js';
import { financeRoute, financeCron } from './_family/finance/index.js';
import { documentsRoute } from './_family/docs/index.js';
import { listRecipes, allRecipes, getRecipe, saveRecipe, deleteRecipe, saveMedia, mediaIn, MEDIA_URL } from './_family/recipes.js';
import { checkSlug, linkRecipe, linkEveryRecipe, dropLinks } from './_family/share.js';
import { eventsBetween, CALENDAR_LINKS, canEditCalendar, seriesInfo, changeEvent } from './_family/calendar.js';
import { importRecipe } from './_family/import.js';
import { askRecipe } from './_family/recipe-ask.js';
import { getFile, remove } from './_family/store.js';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const fail = (status, error) => json({ error }, status);

async function signIn(request, user) {
  const secret = sessionSecret();
  if (!secret) return fail(500, 'Sign-in is not set up yet (FAMILY_SESSION_SECRET is missing).');
  return json({ user }, 200, { 'Set-Cookie': sessionCookie(await createToken(user, secret), request) });
}

async function passwordLogin(request) {
  const { password, name } = await request.json().catch(() => ({}));
  const expected = process.env.FAMILY_PASSWORD;
  if (!expected) return fail(500, 'Password sign-in is not set up yet (FAMILY_PASSWORD is missing).');
  const who = String(name || '').trim().slice(0, 40);
  if (!who) return fail(400, 'Tell us who you are.');
  if (!safeEqual(String(password || ''), expected)) {
    await new Promise(r => setTimeout(r, 800)); // slow down guessing
    return fail(401, 'That password isn’t right.');
  }
  return signIn(request, { name: who, via: 'password' });
}

async function googleLogin(request) {
  const { credential } = await request.json().catch(() => ({}));
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return fail(500, 'Google sign-in is not set up yet.');
  if (!credential) return fail(400, 'Missing Google credential.');
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  const info = r.ok ? await r.json() : null;
  if (!info || info.aud !== clientId || String(info.email_verified) !== 'true') return fail(401, 'Google couldn’t verify that sign-in.');
  const email = String(info.email).toLowerCase();
  const allowed = String(process.env.FAMILY_GOOGLE_EMAILS || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!allowed.includes(email)) return fail(403, `${email} isn’t on the family list. Use the family password instead, or ask Logan to add you.`);
  return signIn(request, { name: info.given_name || info.name || email.split('@')[0], email, via: 'google', picture: info.picture || null });
}

async function media(request, url) {
  const f = url.searchParams.get('f') || '';
  if (!/^[a-z0-9]{6,32}\.(webp|jpg|png|gif)$/.test(f)) return fail(400, 'Bad file name');
  const file = await getFile('media/' + f);
  if (!file) return fail(404, 'Not found');
  return new Response(file.body, {
    headers: { 'Content-Type': file.contentType, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }
  });
}

async function route(request) {
  const url = new URL(request.url);
  const r = url.searchParams.get('r');
  const method = request.method;

  // Everything that changes data must come from our own pages' fetch calls.
  if (method !== 'GET' && request.headers.get('x-family-hub') !== '1') return fail(403, 'Forbidden');

  if (r === 'login' && method === 'POST') return passwordLogin(request);
  if (r === 'google' && method === 'POST') return googleLogin(request);
  if (r === 'logout') return json({ ok: true }, 200, { 'Set-Cookie': clearedCookie() });
  // Vercel Cron has no session; it proves itself with CRON_SECRET instead.
  if (r === 'fin-cron' && method === 'GET') return json(await financeCron(request));

  const user = await readSession(request);
  if (r === 'session') return json({ user, admin: isAdmin(user), finance: canSeeFinance(user), documents: canSeeDocuments(user), googleClientId: process.env.GOOGLE_CLIENT_ID || null, calendar: CALENDAR_LINKS });
  if (!user) return fail(401, 'Please sign in.');

  if (r && r.startsWith('fin-')) {
    if (!canSeeFinance(user)) return fail(403, 'Finance is only open to the people it’s set up for.');
    const out = await financeRoute(request, url, user, r);
    return out instanceof Response ? out : json(out);
  }
  if (r && r.startsWith('docs-')) {
    if (!canSeeDocuments(user)) return fail(403, 'Documents is only open to the people it’s set up for.');
    const out = await documentsRoute(request, url, user, r);
    return out instanceof Response ? out : json(out);
  }

  switch (`${method} ${r}`) {
    case 'GET recipes': {
      if (url.searchParams.get('full')) return json({ recipes: await allRecipes() });
      // Opening the cookbook also gives any recipe without a link its link
      // (if that fails, the cookbook still opens, and it's tried next time).
      const recipes = await linkEveryRecipe(user).catch(e => { console.error('Giving recipes links failed', e); return listRecipes(); });
      return json({ recipes });
    }
    case 'GET recipe': {
      const recipe = await getRecipe(url.searchParams.get('id'));
      return recipe ? json({ recipe }) : fail(404, 'Recipe not found');
    }
    case 'POST recipe': {
      const input = await request.json();
      // A link name typed in the editor is checked before anything is saved.
      const slug = input.slug != null && String(input.slug).trim() ? await checkSlug(input.slug, input.id) : null;
      let recipe = await saveRecipe(input, user), warning = null;
      // Saved either way: a link that can't be set now (someone took the
      // name a moment ago, a busy store) is a warning, not a failed save,
      // so saving again can't make a second copy of a new recipe.
      try { recipe = await linkRecipe(recipe, user, slug); } catch (e) {
        console.error('Recipe link failed', e && e.message);
        warning = (e && e.status === 409 ? e.message + ' ' : '') + 'The recipe is saved; its link can be set again from Edit.';
      }
      return json({ recipe, warning });
    }
    case 'DELETE recipe': {
      const recipe = await getRecipe(url.searchParams.get('id'));
      if (!recipe) return fail(404, 'Recipe not found');
      await dropLinks(recipe);
      await deleteRecipe(recipe.id);
      await Promise.all(mediaIn(recipe, true).map(f => remove('media/' + f).catch(() => {})));
      return json({ ok: true });
    }
    case 'POST upload': {
      const name = await saveMedia(Buffer.from(await request.arrayBuffer()), (request.headers.get('content-type') || '').split(';')[0]);
      return json({ name, url: MEDIA_URL + name });
    }
    case 'GET media':
      return media(request, url);
    case 'POST import':
      return json(await importRecipe(await request.json().catch(() => ({}))));
    case 'POST recipe-ask':
      return json(await askRecipe(await request.json().catch(() => ({})), user));
    case 'GET calendar':
      return json({ events: await eventsBetween(url.searchParams.get('from'), url.searchParams.get('to')), links: CALENDAR_LINKS, canEdit: canEditCalendar() });
    case 'GET calendar-series':
      return json(await seriesInfo(url.searchParams.get('id') || ''));
    case 'POST calendar-event':
      return json({ event: await changeEvent(await request.json().catch(() => ({})), user) });
  }
  return fail(404, 'Unknown request');
}

export default {
  async fetch(request) {
    try {
      return await route(request);
    } catch (e) {
      console.error(e);
      return fail(e.status || 500, e.status ? e.message : 'Something went wrong on our end.');
    }
  }
};
