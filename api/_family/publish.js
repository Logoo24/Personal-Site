// Sharing a recipe publicly = committing it to the site's repo as
// _recipes/<slug>.md (plus its photos under images/recipes/<slug>/). Vercel
// rebuilds on the push and build.js turns it into /recipes/<slug>.
//
// Needs GITHUB_PUBLISH_TOKEN (a fine-grained token with Contents: read &
// write on the site repo). Locally, without a token, the files are written
// straight into the working copy instead so `npm run build` can show them.

import matter from 'gray-matter';
import fs from 'node:fs';
import path from 'node:path';
import { getFileBuffer } from './store.js';
import { mediaIn, setPublished, slugify } from './recipes.js';

const REPO = process.env.GITHUB_REPO || 'Logoo24/Personal-Site';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const TOKEN = process.env.GITHUB_PUBLISH_TOKEN;
const LOCAL = !TOKEN && !process.env.VERCEL;

async function gh(apiPath, opts = {}) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/${apiPath}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'loganbrandall-family-hub',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {})
    }
  });
  if (r.status === 404 && opts.allow404) return null;
  if (!r.ok) throw Object.assign(new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: 502 });
  return r.json();
}

async function exists(repoPath) {
  if (LOCAL) return fs.existsSync(path.join(process.cwd(), repoPath));
  return !!(await gh(`contents/${repoPath}?ref=${BRANCH}`, { allow404: true }));
}

async function listDir(repoPath) {
  if (LOCAL) {
    const dir = path.join(process.cwd(), repoPath);
    return fs.existsSync(dir) ? fs.readdirSync(dir).map(f => repoPath + '/' + f) : [];
  }
  const items = await gh(`contents/${repoPath}?ref=${BRANCH}`, { allow404: true });
  return Array.isArray(items) ? items.filter(i => i.type === 'file').map(i => i.path) : [];
}

// files: [{ path, content: Buffer }], deletes: [path]. One commit for all.
async function commit(files, deletes, message) {
  if (LOCAL) {
    for (const f of files) {
      const full = path.join(process.cwd(), f.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content);
    }
    for (const d of deletes) {
      fs.rmSync(path.join(process.cwd(), d), { force: true });
      const dir = path.dirname(path.join(process.cwd(), d));
      if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
    }
    return;
  }
  if (!TOKEN) throw Object.assign(new Error('Sharing is not set up yet (GITHUB_PUBLISH_TOKEN is missing).'), { status: 503 });
  const blobs = await Promise.all(files.map(f =>
    gh('git/blobs', { method: 'POST', body: JSON.stringify({ content: f.content.toString('base64'), encoding: 'base64' }) })));
  const tree = files.map((f, i) => ({ path: f.path, mode: '100644', type: 'blob', sha: blobs[i].sha }))
    .concat(deletes.map(d => ({ path: d, mode: '100644', type: 'blob', sha: null })));
  // Retry once if the branch moved while we were building the commit.
  for (let attempt = 0; attempt < 2; attempt++) {
    const ref = await gh(`git/ref/heads/${BRANCH}`);
    const head = await gh(`git/commits/${ref.object.sha}`);
    const newTree = await gh('git/trees', { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree }) });
    const newCommit = await gh('git/commits', { method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [ref.object.sha] }) });
    try {
      await gh(`git/refs/heads/${BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha }) });
      return;
    } catch (e) {
      if (attempt) throw e;
    }
  }
}

function readMinutes(text) {
  return Math.max(2, Math.round(String(text || '').split(/\s+/).filter(Boolean).length / 220) + 2);
}

export async function publishRecipe(recipe, user) {
  let slug = recipe.published && recipe.published.slug;
  if (!slug) {
    const base = slugify(recipe.title);
    slug = base;
    for (let n = 2; await exists(`_recipes/${slug}.md`); n++) slug = `${base}-${n}`;
  }
  const imgDir = `images/recipes/${slug}`;
  const names = mediaIn(recipe);
  const files = [];
  for (const name of names) {
    const buf = await getFileBuffer('media/' + name);
    if (buf) files.push({ path: `${imgDir}/${name}`, content: buf });
  }
  const publicUrl = name => `/${imgDir}/${name}`;
  const rewrite = text => String(text || '').replace(
    /\/api\/family\?r=media&(?:amp;)?f=([a-z0-9]{6,32}\.(?:webp|jpg|png|gif))/g, (all, name) => publicUrl(name));

  // The family's local date (the server runs in UTC). en-CA formats as YYYY-MM-DD.
  const date = (recipe.published && recipe.published.date) ||
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/Boise' });
  // Leave out empty fields so the markdown stays readable.
  const ingredients = recipe.ingredients.map(i =>
    Object.fromEntries(Object.entries(i).filter(([k, v]) => v !== '' || k === 'section')));
  const data = {
    title: recipe.title,
    date,
    category: 'recipe',
    summary: recipe.summary || `A Randall family recipe for ${recipe.title.toLowerCase()}.`,
    readMinutes: readMinutes(recipe.story),
    recipe: {
      source: recipe.source || undefined,
      servings: recipe.servings || undefined,
      yieldUnit: recipe.yieldUnit || 'servings',
      prepMinutes: recipe.prepMinutes || undefined,
      cookMinutes: recipe.cookMinutes || undefined,
      tags: recipe.tags.length ? recipe.tags : undefined,
      cover: recipe.cover ? publicUrl(recipe.cover) : undefined,
      ingredients,
      steps: recipe.steps,
      notes: rewrite(recipe.notes) || undefined
    }
  };
  // js-yaml (inside gray-matter) refuses undefined values, so drop them.
  data.recipe = JSON.parse(JSON.stringify(data.recipe));
  const md = matter.stringify('\n' + rewrite(recipe.story).trim() + '\n', data);
  files.push({ path: `_recipes/${slug}.md`, content: Buffer.from(md, 'utf8') });

  const keep = new Set(files.map(f => f.path));
  const stale = (await listDir(imgDir)).filter(p => !keep.has(p));
  await commit(files, stale, `${recipe.published ? 'Update' : 'Share'} recipe: ${recipe.title}\n\nShared from the family hub by ${user.name}.`);
  return setPublished(recipe.id, { slug, date, by: user.name, at: new Date().toISOString() });
}

export async function unpublishRecipe(recipe, user) {
  const slug = recipe.published && recipe.published.slug;
  if (slug) {
    const deletes = (await listDir(`images/recipes/${slug}`));
    if (await exists(`_recipes/${slug}.md`)) deletes.push(`_recipes/${slug}.md`);
    if (deletes.length) await commit([], deletes, `Unshare recipe: ${recipe.title}\n\nRemoved from the public site by ${user.name}.`);
  }
  return setPublished(recipe.id, null);
}
