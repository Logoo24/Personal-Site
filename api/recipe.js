// Vercel function: public recipe links. vercel.json rewrites
//   /recipes/<slug>               -> ?slug=<slug>            (the page)
//   /recipes/<slug>/photos/<file> -> ?slug=<slug>&f=<file>   (its photos)
// Only recipes the family has made public are served, and only the photos
// that recipe uses. No sign-in needed (see api/_family/share.js).

import { recipeForSlug } from './_family/share.js';
import { renderSharedRecipe, renderNotShared } from './_family/share-page.js';
import { mediaIn } from './_family/recipes.js';
import { getFile } from './_family/store.js';

const notFound = () => new Response(renderNotShared(), {
  status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
});

async function route(request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug') || '';
  const f = url.searchParams.get('f');
  const recipe = await recipeForSlug(slug);
  if (!recipe) return f ? new Response('Not found', { status: 404 }) : notFound();

  if (f) {
    if (!mediaIn(recipe).includes(f)) return new Response('Not found', { status: 404 });
    const file = await getFile('media/' + f);
    if (!file) return new Response('Not found', { status: 404 });
    return new Response(file.body, {
      headers: { 'Content-Type': file.contentType, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' }
    });
  }

  // Not cached, so making a recipe private takes effect right away.
  const origin = `${request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')}://${request.headers.get('x-forwarded-host') || url.host}`;
  return new Response(renderSharedRecipe(recipe, { origin, slug }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
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
