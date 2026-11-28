// Vercel function: the public recipe book. vercel.json rewrites
//   /recipes                      -> ?book=1                 (every public recipe)
//   /recipes/<slug>               -> ?slug=<slug>            (the page)
//   /recipes/<slug>/photos/<file> -> ?slug=<slug>&f=<file>   (its photos)
// and the page's question box posts to ?slug=<slug>&ask=1. Only public
// recipes are served (not private, not on "Want to make"), and only the
// photos a recipe uses. No sign-in needed (see api/_family/share.js).

import { recipeForSlug, publicBook } from './_family/share.js';
import { renderSharedRecipe, renderBook, renderNotShared, SHARE_CSP } from './_family/share-page.js';
import { askPublicRecipe, takePublicTurn, canAsk } from './_family/recipe-ask.js';
import { mediaIn } from './_family/recipes.js';
import { getFile } from './_family/store.js';
import { readSession } from './_family/session.js';

const page = (html, status = 200) => new Response(html, {
  status,
  // Not cached, so a recipe made private is gone at once.
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': SHARE_CSP }
});
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function originOf(request, url) {
  return `${request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')}://${request.headers.get('x-forwarded-host') || url.host}`;
}

// A question from the public page. It has to come from the page itself (a
// JSON post with the page's own header, which another site's page can't
// send without permission it never gets), and the visitor is counted
// against the limits before anything is read, so a flood costs nothing.
async function ask(request, url) {
  if (request.headers.get('x-recipe-ask') !== '1' || !/application\/json/.test(request.headers.get('content-type') || '')) return json({ error: 'Forbidden' }, 403);
  const address = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || '';
  if (!takePublicTurn(address)) return json({ error: 'That’s a lot of questions in a few minutes. Try again a little later.' }, 429);
  const recipe = await recipeForSlug(url.searchParams.get('slug') || '');
  if (!recipe) return json({ error: 'Not found' }, 404);
  try {
    return json(await askPublicRecipe(recipe, await request.json().catch(() => ({}))));
  } catch (e) {
    return json({ error: e.status ? e.message : 'Something went wrong.' }, e.status || 500);
  }
}

async function route(request) {
  const url = new URL(request.url);
  const origin = originOf(request, url);
  if (url.searchParams.get('book')) {
    return page(renderBook(await publicBook(), { origin, familyView: !!(await readSession(request)) }));
  }

  if (request.method === 'POST') return url.searchParams.get('ask') ? ask(request, url) : json({ error: 'Not found' }, 404);
  const slug = url.searchParams.get('slug') || '';
  const f = url.searchParams.get('f');
  // A photo may use a copy of the recipe up to a minute old (a page loads
  // several at once); the page itself always reads it fresh.
  const recipe = await recipeForSlug(slug, !!f);
  if (!recipe) return f ? new Response('Not found', { status: 404 }) : page(renderNotShared(), 404);

  if (f) {
    if (!mediaIn(recipe).includes(f)) return new Response('Not found', { status: 404 });
    const file = await getFile('media/' + f);
    if (!file) return new Response('Not found', { status: 404 });
    // The CDN keeps a photo ten minutes, so the recipe book's covers don't
    // cost a Blob read per visit; that's also the longest a photo stays
    // reachable after its recipe is made private or deleted.
    return new Response(file.body, {
      headers: { 'Content-Type': file.contentType, 'Cache-Control': 'public, max-age=300, s-maxage=600', 'X-Content-Type-Options': 'nosniff' }
    });
  }

  return page(renderSharedRecipe(recipe, { origin, slug, familyView: !!(await readSession(request)), askable: canAsk() }));
}

export default {
  async fetch(request) {
    try {
      return await route(request);
    } catch (e) {
      console.error(e);
      return new Response('Something went wrong.', { status: 500 });
    }
  }
};
