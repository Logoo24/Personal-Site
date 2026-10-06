// Vercel function: the family hub's whole API, routed by ?r=. One function
// (rather than one per route) keeps us well inside the Hobby plan's limit.
//
//   POST login    {name, password}  -> sign in with the family password
//   POST google   {credential}      -> sign in with a Google ID token
//   POST logout
//   GET  session                    -> { user, googleClientId }
//   GET  recipes [&full=1]          -> cookbook index (or every full recipe)
//   GET  recipe&id=                 -> one recipe
//   POST recipe   {...recipe}       -> create / update
//   DELETE recipe&id=
//   POST upload   (raw image body)  -> { name, url }
//   GET  media&f=                   -> a stored photo
//   POST publish  {id, publish}     -> share to / remove from the public site
//   POST import   {url|text, tags}  -> a draft recipe read from a link or pasted text
//   GET  calendar&from=&to=         -> calendar events (YYYY-MM-DD range)
//
// Env: FAMILY_PASSWORD, FAMILY_SESSION_SECRET, GOOGLE_CLIENT_ID,
// FAMILY_GOOGLE_EMAILS (comma-separated), GITHUB_PUBLISH_TOKEN, the Blob
// store's BLOB_READ_WRITE_TOKEN, and ANTHROPIC_API_KEY (recipe import).

import { createToken, readSession, sessionCookie, clearedCookie, sessionSecret, safeEqual } from './_family/session.js';
import { listRecipes, allRecipes, getRecipe, saveRecipe, deleteRecipe, saveMedia, mediaIn, MEDIA_URL } from './_family/recipes.js';
import { publishRecipe, unpublishRecipe } from './_family/publish.js';
import { eventsBetween, CALENDAR_LINKS } from './_family/calendar.js';
import { importRecipe } from './_family/import.js';
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

  const user = await readSession(request);
  if (r === 'session') return json({ user, googleClientId: process.env.GOOGLE_CLIENT_ID || null, calendar: CALENDAR_LINKS });
  if (!user) return fail(401, 'Please sign in.');

  switch (`${method} ${r}`) {
    case 'GET recipes':
      return json({ recipes: url.searchParams.get('full') ? await allRecipes() : await listRecipes() });
    case 'GET recipe': {
      const recipe = await getRecipe(url.searchParams.get('id'));
      return recipe ? json({ recipe }) : fail(404, 'Recipe not found');
    }
    case 'POST recipe': {
      const recipe = await saveRecipe(await request.json(), user);
      return json({ recipe });
    }
    case 'DELETE recipe': {
      const recipe = await getRecipe(url.searchParams.get('id'));
      if (!recipe) return fail(404, 'Recipe not found');
      if (recipe.published) await unpublishRecipe(recipe, user);
      await deleteRecipe(recipe.id);
      await Promise.all(mediaIn(recipe).map(f => remove('media/' + f).catch(() => {})));
      return json({ ok: true });
    }
    case 'POST upload': {
      const name = await saveMedia(Buffer.from(await request.arrayBuffer()), (request.headers.get('content-type') || '').split(';')[0]);
      return json({ name, url: MEDIA_URL + name });
    }
    case 'GET media':
      return media(request, url);
    case 'POST publish': {
      const { id, publish } = await request.json();
      const recipe = await getRecipe(id);
      if (!recipe) return fail(404, 'Recipe not found');
      return json({ recipe: publish ? await publishRecipe(recipe, user) : await unpublishRecipe(recipe, user) });
    }
    case 'POST import':
      return json(await importRecipe(await request.json().catch(() => ({}))));
    case 'GET calendar':
      return json({ events: await eventsBetween(url.searchParams.get('from'), url.searchParams.get('to')), links: CALENDAR_LINKS });
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
