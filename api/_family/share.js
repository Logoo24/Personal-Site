// The family's recipes on the web. Every recipe has a link, /recipes/<slug>,
// and is public there unless the family made it private (or it's still on
// the "Want to make" list, untried). The public recipe book, /recipes, lists
// them all. Pages are drawn straight from the cookbook by api/recipe.js, so
// they always show the latest edits, and a recipe made private is gone from
// both at once. Not linked from the site, not in the sitemap, and marked
// noindex: people find it through the family.
//
// shared/slugs.json maps each link to its recipe ({ slugs: { slug: id } }),
// and the recipe's own `published` field holds its slug. Both have to agree
// for the page to show, so a half-finished change fails closed.

import { readJSON, writeJSON } from './store.js';
import { getRecipe, listRecipes, setPublished, setLinks, slugify } from './recipes.js';

const SLUGS = 'shared/slugs.json';
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WANT = 'want to make';

const fail = (status, message) => Object.assign(new Error(message), { status });

export const isWant = r => (r.tags || []).some(t => String(t).trim().toLowerCase() === WANT);
// Shown to anyone: has a link, isn't private, isn't untried.
export const isPublic = r => !!(r && r.published && r.published.slug && !r.private && !isWant(r));

// Public lookups keep the map (and the book's list) for half a minute, so a
// flood of visits or made-up links can't use up the Blob store's monthly
// reads (which the cookbook and Finance share). A recipe made private still
// disappears at once from its own page: the recipe itself is read and
// checked on every request.
const CACHE_MS = 30000;
let slugCache = null; // { at, slugs }
async function slugMap(fresh) {
  if (!fresh && slugCache && Date.now() - slugCache.at < CACHE_MS) return slugCache.slugs;
  const map = await readJSON(SLUGS, { etag: false });
  slugCache = { at: Date.now(), slugs: (map && map.data.slugs) || {} };
  return slugCache.slugs;
}

// Read-modify-write on the slug map, retried if someone else changed it.
async function updateSlugs(fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await readJSON(SLUGS);
    const slugs = fn({ ...(cur ? cur.data.slugs || {} : {}) });
    try {
      await writeJSON(SLUGS, { slugs }, cur ? cur.etag : null);
      slugCache = { at: Date.now(), slugs };
      bookCache = null;
      return;
    } catch (e) {
      if (!e.precondition) throw e;
    }
  }
  throw fail(503, 'The cookbook is busy. Try again.');
}

// A free link name near `base`: base, base-2, base-3…
function freeSlug(slugs, base, id) {
  let slug = base;
  for (let n = 2; slugs[slug] && slugs[slug] !== id; n++) slug = `${base}-${n}`;
  return slug;
}

// A link name someone typed (the editor), checked before anything is saved:
// letters, numbers and dashes, and not another recipe's. Returns the slug.
export async function checkSlug(wanted, id) {
  const slug = slugify(wanted);
  if (!/[a-z0-9]/i.test(String(wanted || '')) || !SLUG_RE.test(slug)) throw fail(400, 'Use letters, numbers and dashes for the link.');
  const owner = (await slugMap(true))[slug];
  if (owner && owner !== id) throw fail(409, 'Another recipe already uses that link. Try another.');
  return slug;
}

// Gives a recipe its link: the one asked for (`wanted`), else the one it
// has, else one made from its title. The old link stops working when it
// changes. Returns the recipe as saved.
export async function linkRecipe(recipe, user, wanted) {
  const requested = wanted != null && String(wanted).trim() ? await checkSlug(wanted, recipe.id) : null;
  const current = recipe.published && recipe.published.slug;
  // Already linked, and keeping it: no write.
  if ((!requested || requested === current) && current && (await slugMap())[current] === recipe.id) return recipe;
  let slug;
  await updateSlugs(slugs => {
    const mine = s => slugs[s] === recipe.id;
    if (requested) {
      if (slugs[requested] && !mine(requested)) throw fail(409, 'Another recipe already uses that link. Try another.');
      slug = requested;
    } else if (current && (!slugs[current] || mine(current))) slug = current;
    else slug = freeSlug(slugs, slugify(recipe.title), recipe.id);
    for (const s of Object.keys(slugs)) if (mine(s)) delete slugs[s];
    slugs[slug] = recipe.id;
    return slugs;
  });
  if (current === slug) return recipe;
  return setPublished(recipe.id, { slug, by: user.name, at: new Date().toISOString() });
}

// A deleted recipe's links go with it.
export async function dropLinks(recipe) {
  await updateSlugs(slugs => {
    for (const s of Object.keys(slugs)) if (slugs[s] === recipe.id) delete slugs[s];
    return slugs;
  });
}

// Recipes from before every recipe had a link get theirs (one slug-map
// write, then each recipe and the index). Runs when the family opens the
// cookbook, never from a public page, and finds nothing to do after the
// first time. Returns the cookbook's list, updated.
export async function linkEveryRecipe(user) {
  const list = await listRecipes();
  const need = list.filter(r => !(r.published && r.published.slug));
  if (!need.length) return list;
  const assigned = {};
  await updateSlugs(slugs => {
    const has = {};
    for (const [s, id] of Object.entries(slugs)) if (!has[id]) has[id] = s;
    for (const r of need) {
      const slug = has[r.id] || freeSlug(slugs, slugify(r.title), r.id);
      slugs[slug] = r.id;
      assigned[r.id] = slug;
    }
    return slugs;
  });
  const at = new Date().toISOString();
  await setLinks(Object.fromEntries(need.map(r => [r.id, { slug: assigned[r.id], by: user.name, at }])));
  return listRecipes();
}

// The recipe behind a public link, or null. Read fresh every time, so
// making it private works at once; cachedOk (a photo: a page loads several
// at once) may use a copy up to a minute old. A link the cached map doesn't
// know (just made, just renamed) gets the map read again, at most every
// five seconds, so a brand-new link works straight away but a flood of
// made-up ones costs almost nothing.
const recipeCache = new Map(); // id -> { at, recipe }
export async function recipeForSlug(slug, cachedOk) {
  if (!SLUG_RE.test(String(slug || '')) || slug.length > 120) return null;
  let slugs = await slugMap();
  if (!Object.hasOwn(slugs, slug) && slugCache && Date.now() - slugCache.at > 5000) slugs = await slugMap(true);
  const id = Object.hasOwn(slugs, slug) ? slugs[slug] : null;
  if (!id) return null;
  const hit = cachedOk && recipeCache.get(id);
  let recipe = hit && Date.now() - hit.at < 60000 ? hit.recipe : null;
  if (!recipe) {
    recipe = await getRecipe(id, { etag: false });
    recipeCache.set(id, { at: Date.now(), recipe });
    if (recipeCache.size > 500) recipeCache.delete(recipeCache.keys().next().value);
  }
  return recipe && isPublic(recipe) && recipe.published.slug === slug ? recipe : null;
}

// The public recipe book: every public recipe's summary, A to Z.
let bookCache = null; // { at, list }
export async function publicBook() {
  if (bookCache && Date.now() - bookCache.at < CACHE_MS) return bookCache.list;
  const list = (await listRecipes({ etag: false })).filter(isPublic).sort((a, b) => a.title.localeCompare(b.title));
  bookCache = { at: Date.now(), list };
  return list;
}
