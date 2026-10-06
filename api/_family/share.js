// Making a recipe public: it gets a link, /recipes/<slug>, that anyone can
// open. The page is drawn straight from the cookbook by api/recipe.js, so it
// is live the moment the recipe is made public, always shows the latest
// edits, and stops working the moment it's made private again. Public
// recipes aren't listed anywhere on the site; only people with the link see
// them.
//
// shared/slugs.json maps each link to its recipe ({ slugs: { slug: id } }),
// and the recipe's own `published` field holds its slug. Both have to agree
// for the page to show, so a half-finished change fails closed.

import { readJSON, writeJSON } from './store.js';
import { getRecipe, setPublished, slugify } from './recipes.js';

const SLUGS = 'shared/slugs.json';
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const fail = (status, message) => Object.assign(new Error(message), { status });

// Read-modify-write on the slug map, retried if someone else changed it.
async function updateSlugs(fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await readJSON(SLUGS);
    const slugs = fn({ ...(cur ? cur.data.slugs || {} : {}) });
    try {
      await writeJSON(SLUGS, { slugs }, cur ? cur.etag : null);
      return;
    } catch (e) {
      if (!e.precondition) throw e;
    }
  }
  throw fail(503, 'The cookbook is busy. Try again.');
}

// wanted: a new link name, or nothing to keep the current one (or make one
// from the title).
export async function shareRecipe(recipe, user, wanted) {
  let requested = null;
  if (wanted != null) {
    requested = slugify(wanted);
    if (!String(wanted).trim() || !SLUG_RE.test(requested)) throw fail(400, 'Use letters, numbers and dashes for the link.');
  }
  const current = recipe.published && recipe.published.slug;
  let slug;
  await updateSlugs(slugs => {
    const mine = s => slugs[s] === recipe.id;
    if (requested) {
      if (slugs[requested] && !mine(requested)) throw fail(409, 'Another recipe already uses that link.');
      slug = requested;
    } else if (current && (!slugs[current] || mine(current))) {
      slug = current;
    } else {
      const base = slugify(recipe.title);
      slug = base;
      for (let n = 2; slugs[slug] && !mine(slug); n++) slug = `${base}-${n}`;
    }
    for (const s of Object.keys(slugs)) if (mine(s)) delete slugs[s];
    slugs[slug] = recipe.id;
    return slugs;
  });
  const keep = recipe.published && recipe.published.slug ? recipe.published : null;
  return setPublished(recipe.id, keep && keep.slug === slug ? keep : { slug, by: user.name, at: new Date().toISOString() });
}

export async function unshareRecipe(recipe) {
  const updated = await setPublished(recipe.id, null);
  await updateSlugs(slugs => {
    for (const s of Object.keys(slugs)) if (slugs[s] === recipe.id) delete slugs[s];
    return slugs;
  });
  return updated;
}

// The recipe behind a public link, or null.
export async function recipeForSlug(slug) {
  if (!SLUG_RE.test(String(slug || ''))) return null;
  const map = await readJSON(SLUGS);
  const id = map && map.data.slugs && map.data.slugs[slug];
  const recipe = id ? await getRecipe(id) : null;
  return recipe && recipe.published && recipe.published.slug === slug ? recipe : null;
}
