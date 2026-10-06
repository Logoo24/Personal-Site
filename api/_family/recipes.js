// Family cookbook storage. Each recipe is recipes/<id>.json; a summary of
// every recipe lives in recipes/index.json so the cookbook page loads with a
// single read. Photos are media/<random>.<ext>.

import { readJSON, writeJSON, putFile, remove } from './store.js';

const INDEX = 'recipes/index.json';
export const MEDIA_URL = '/api/family?r=media&f=';
const MEDIA_TYPES = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' };

export function randomId(len = 10) {
  const chars = 'abcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'recipe';
}

const str = (v, max = 400) => String(v == null ? '' : v).slice(0, max).trim();
const int = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? Math.min(n, 100000) : null; };
const media = v => (/^[a-z0-9]{6,32}\.(webp|jpg|png|gif)$/.test(String(v || '')) ? String(v) : null);

// Cleans up whatever the editor sent into the stored recipe shape.
function normalize(input) {
  const ingredients = (Array.isArray(input.ingredients) ? input.ingredients : []).slice(0, 200).map(i =>
    i && i.section != null
      ? { section: str(i.section, 120) }
      : { qty: str(i && i.qty, 40), unit: str(i && i.unit, 40), item: str(i && i.item, 200), note: str(i && i.note, 200) }
  ).filter(i => i.section || i.item || i.qty);
  const steps = (Array.isArray(input.steps) ? input.steps : []).slice(0, 100).map(s => str(s, 4000)).filter(Boolean);
  const tags = [...new Set((Array.isArray(input.tags) ? input.tags : []).map(t => str(t, 40)).filter(Boolean))].slice(0, 12);
  const servings = parseFloat(input.servings);
  return {
    title: str(input.title, 140) || 'Untitled recipe',
    summary: str(input.summary, 400),
    source: str(input.source, 120),
    tags,
    servings: Number.isFinite(servings) && servings > 0 ? Math.min(servings, 1000) : null,
    yieldUnit: str(input.yieldUnit, 40) || 'servings',
    prepMinutes: int(input.prepMinutes),
    cookMinutes: int(input.cookMinutes),
    cover: media(input.cover),
    ingredients,
    steps,
    story: str(input.story, 40000),
    notes: str(input.notes, 8000)
  };
}

function summarize(r) {
  return {
    id: r.id, title: r.title, summary: r.summary, tags: r.tags, cover: r.cover,
    servings: r.servings, yieldUnit: r.yieldUnit,
    totalMinutes: (r.prepMinutes || 0) + (r.cookMinutes || 0) || null,
    updatedAt: r.updatedAt, createdBy: r.createdBy,
    // Ingredient names, so the cookbook search can find "buttermilk".
    search: r.ingredients.filter(i => i.item).map(i => i.item).join(', ').slice(0, 600),
    published: r.published ? { slug: r.published.slug } : null
  };
}

export async function listRecipes() {
  const idx = await readJSON(INDEX);
  return idx ? idx.data.recipes || [] : [];
}

export async function getRecipe(id) {
  if (!/^[a-z0-9]{6,32}$/.test(String(id || ''))) return null;
  const r = await readJSON(`recipes/${id}.json`);
  return r ? r.data : null;
}

export async function allRecipes() {
  const list = await listRecipes();
  return (await Promise.all(list.map(r => getRecipe(r.id)))).filter(Boolean);
}

// Read-modify-write on the index, retried if someone else saved in between.
async function updateIndex(fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await readJSON(INDEX);
    const recipes = fn(cur ? cur.data.recipes || [] : []);
    try {
      await writeJSON(INDEX, { recipes }, cur ? cur.etag : null);
      return;
    } catch (e) {
      if (!e.precondition) throw e;
    }
  }
  throw new Error('The cookbook is busy — try saving again.');
}

export async function saveRecipe(input, user) {
  const now = new Date().toISOString();
  const existing = input.id ? await getRecipe(input.id) : null;
  if (input.id && !existing) throw Object.assign(new Error('Recipe not found'), { status: 404 });
  const recipe = {
    ...normalize(input),
    id: existing ? existing.id : randomId(),
    createdAt: existing ? existing.createdAt : now,
    createdBy: existing ? existing.createdBy : user.name,
    updatedAt: now,
    updatedBy: user.name,
    published: existing ? existing.published || null : null
  };
  await writeJSON(`recipes/${recipe.id}.json`, recipe);
  await updateIndex(list => [summarize(recipe), ...list.filter(r => r.id !== recipe.id)]);
  return recipe;
}

// Used by publish.js to record (or clear) the public slug.
export async function setPublished(id, published) {
  const r = await getRecipe(id);
  if (!r) return null;
  r.published = published;
  await writeJSON(`recipes/${id}.json`, r);
  await updateIndex(list => list.map(x => (x.id === id ? summarize(r) : x)));
  return r;
}

export async function deleteRecipe(id) {
  await remove(`recipes/${id}.json`);
  await updateIndex(list => list.filter(r => r.id !== id));
}

export async function saveMedia(bytes, contentType) {
  const ext = MEDIA_TYPES[contentType];
  if (!ext) throw Object.assign(new Error('Photos must be WebP, JPEG, PNG or GIF'), { status: 415 });
  if (bytes.length > 4 * 1024 * 1024) throw Object.assign(new Error('That photo is too large (4 MB max)'), { status: 413 });
  const name = randomId(16) + '.' + ext;
  await putFile('media/' + name, bytes, contentType);
  return name;
}

// Every media file a recipe uses: its cover plus photos in the story/notes.
export function mediaIn(recipe) {
  const found = new Set();
  if (recipe.cover) found.add(recipe.cover);
  const re = /\/api\/family\?r=media&(?:amp;)?f=([a-z0-9]{6,32}\.(?:webp|jpg|png|gif))/g;
  for (const text of [recipe.story, recipe.notes]) {
    let m;
    while ((m = re.exec(text || ''))) found.add(m[1]);
  }
  return [...found];
}
