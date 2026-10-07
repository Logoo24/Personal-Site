# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Logan Randall's personal site — a **static HTML/CSS/JS site** (no framework, no bundler). Vanilla JS, GSAP loaded from CDN, and a small Node build step that compiles markdown blog posts. Deployed via Vercel (`vercel.json`), with `/api/*` as Vercel serverless functions for the CMS auth flow.

> Note: `SETUP.md` describes a Cloudflare Pages + Cloudflare Worker setup. The actual current configuration is Vercel + Vercel serverless functions (`api/auth.js`, `api/callback.js`, `vercel.json`). When something disagrees, trust the code, not `SETUP.md`.

## Commands

```bash
npm install          # one-time
npm run build        # runs build.js — required after any change to _posts/ or post-template.html
npm run resume-pdf   # re-renders files/logan-randall-resume.pdf from _src/resume-pdf.html (needs local Chrome/Edge)
```

There are no tests and no linter. To preview locally, run a static file server from the repo root (`.claude/launch.json` runs `.claude/serve.js` on port 8123, which mirrors `cleanUrls` and the `vercel.json` redirects and also runs the family hub locally — see below); opening `index.html` straight from disk mostly works but root-relative paths like `/images/...` won't resolve. The build modifies `index.html`, `blog.html`, every page's OG block, and `sitemap.xml` **in place** — running it during a working session will show up in `git diff`.

## Build pipeline (`build.js`)

`npm run build` does these things:

1. For each `_posts/*.md` (skipping `draft: true`): parses frontmatter with `gray-matter`, renders markdown with `marked`, substitutes `{{key}}` placeholders into `_src/post-template.html`, writes to `posts/<slug>.html`.
2. Rewrites the post list inside `blog.html` between the literal HTML comments `<!-- POSTS_START -->` and `<!-- POSTS_END -->`. **Personal posts only** — class posts live on their class page (see "Classes" below). With no personal posts it writes an empty-state message linking to the class pages.
3. Rewrites the top-3 recent **personal** posts inside `index.html` between `<!-- RECENT_POSTS_START -->` and `<!-- RECENT_POSTS_END -->` (falls back to links to the class pages when there are none).
3b. Writes one page per class, `classes/<slug>.html`, from `_src/class-template.html` (deletes pages for classes no longer in the list), and fills the nav's Blog dropdown on every page (root pages, `404.html` with root-absolute links, `posts/*`, `classes/*`) between `<!-- BLOG_MENU_START -->` / `<!-- BLOG_MENU_END -->`.
4. Writes the homepage stats via `setStat()`, which rewrites the `<div data-stat="…" data-count="N">N</div>` elements in `index.html`: projects shipped (count of `.proj` cards in `projects.html`), blog posts, and academic posts.
5. Injects `<meta og:image>` / `<meta twitter:image>` tags into every page (including each generated post) between `<!-- OG_IMAGE_START -->` and `<!-- OG_IMAGE_END -->` markers. The URL is `SITE_URL` + `OG_IMAGE` (both constants in `build.js`; currently `/images/og-card.jpg`, a 1200×630 JPG). Social crawlers don't run JS, so these tags **have to** be baked in at build time — and the image must be PNG/JPG, since most crawlers ignore SVG.
6. Generates `sitemap.xml` at the repo root listing every static page + every blog post (with publish date as `lastmod`), using clean URLs (`/about`, `/posts/<slug>`) since `vercel.json` has `cleanUrls: true`. `robots.txt` references the sitemap so crawlers find it.

Template values (title, summary, dates…) are HTML-escaped when substituted into `post-template.html`; only `{{body}}` (the rendered markdown) goes in raw.

**Do not remove those marker comments** — `injectBetween()` silently skips the file if the markers aren't found. If you change the post-card markup, change it inside `build.js` (the strings that get injected), not just in `blog.html` (it'll be overwritten on next build).

Slug = filename minus `.md`, lowercased, non-`[a-z0-9-]` replaced with `-`. Dates are parsed at UTC noon to avoid timezone shifts.

## Content architecture

**Everything except blog posts is hard-coded HTML.** To change wording on the homepage, About, Projects, or Resume, edit the HTML file directly — there is no JSON/CMS layer for page content any more (it was removed deliberately; don't reintroduce it).

**Blog posts** — markdown in `_posts/`, rendered at build time into `posts/*.html`. This is the only content managed through the CMS (`/family/manage`). Frontmatter shape:

```yaml
---
title: "..."
date: 2026-06-15
category: personal | academic    # the only two live categories
course: "MKT 353"                 # academic posts only: which class
summary: "..."
readMinutes: 5
draft: false
---
```

`build.js` `CATEGORY_LABELS` also accepts the legacy values `essay`/`class`/`research`/`project` and maps them onto the two new labels, so un-migrated old posts still render — but new posts should use the two-value set (`academic`/`class`/`research` all count as class posts).

**Images in posts**: a markdown image's *title* sets its placement — `![alt](/images/uploads/x.webp "left")`, `"right"` or `"center"` (default), optionally with a caption after a colon (`"right: My caption"`; a title with no position word is just a caption). `build.js` (`marked.use` image renderer + `renderMarkdown()`) turns each into `<figure class="post-img post-img--left|right|center">` and lifts it out of its `<p>`; styles are under `.post-img` in `styles.css` (left/right float with text wrapping, un-floated under 560px; headings clear floats). CMS uploads go to `images/uploads/` and are downscaled to WebP on upload (`media_libraries` in `family/manage/config.yml`).

**Classes**: the class list is `_data/classes.json` (`{ classes: [{ code, name, archived }] }`), editable from the CMS → Classes. Slug = `code` lowercased with non-alphanumerics → `-` (`MKT 353` → `mkt-353`), so changing a class's code changes its URL. An academic post's `course` is matched to a class by slug; a class not in the list gets a page anyway (build warns), and an academic post with no `course` goes under "Other classes". `archived: true` moves a class from "Classes" to "Past classes" in the Blog dropdown and labels its page "Past class" — the page and its posts stay live. Class posts' "back" button links to their class page instead of `blog.html`.

**Blog dropdown** (`li.nav-dd` in every page's nav, including `_src/post-template.html`, `_src/class-template.html` and `404.html`): the "Blog" word is a normal link to `blog.html`; the chevron `button.nav-dd-toggle` toggles `.open` (wired in `main.js`), and on desktop hovering also opens it (CSS). In the mobile full-screen menu the list opens inline under Blog. Any new page with a nav needs the same `li.nav-dd` block with the BLOG_MENU markers, and `build.js` must know about it (`ROOT_PAGES`).

**Projects** appear in two independent places: the homepage "Selected work" grid (`index.html`, plain `.card`s) and the full list on `projects.html`. On the projects page each project is a `.card.proj-card` inside a `.proj.proj--<name>` wrapper in a 2-column `.proj-grid`. A project with a custom look gets styles under `.proj--<name>` in `css/projects.css`, and can put decoration in a `.proj-behind` div that renders under the card (z-index 0) — that's how the ChooseAMovie popcorn bucket peeks over the card's top edge. Linked cards are `<a class="card proj-card">`; external links use `target="_blank" rel="noopener"` and a `↗` in the corner label. The ChooseAMovie card hotlinks its logo from `https://www.chooseamovie.app/brand/logo-lockup.svg` and falls back to a text wordmark via an inline `onerror`.

**Images**: the homepage hero is `images/logan-hero-720.webp` / `-1040.webp` (via `srcset`), generated from the original full-res cutout `images/logan-hero-cutout.svg` (which is just two embedded PNGs: photo + luminance mask; it's 4 MB, so never reference it from a page). The About page uses `images/about-logan-marisa.jpg` (hero, 4:5 crop) and `images/about-wedding-day.jpg` (inline `.figure`); the Resume headshot is `images/logan-headshot.webp` (a 694×694 square, cropped to 4:5 by CSS). There's no image tooling in `package.json` — photos were resized with Windows' System.Drawing, and project screenshots captured with headless Chrome.

**Social links** (LinkedIn, Instagram, Facebook, email) are a `ul.socials` list duplicated in `about.html` and `resume.html` — keep the two in sync. On print, the resume's social links show their full URLs.

**Resume** exists in two forms that must be kept in step: `resume.html` (the "story" version — a timeline of `.tl-item` entries with logo badges, metric tiles and optional `figure.tl-media` photos; styles under `RESUME TIMELINE` in `styles.css`) and the one-page PDF `files/logan-randall-resume.pdf`, rendered from `_src/resume-pdf.html` by `npm run resume-pdf` (not part of the Vercel build — the PDF is committed). The PDF deliberately omits Logan's phone number; never add it back. After regenerating, check it's still one page.

## CMS (`/family/manage`)

Sveltia CMS (a Decap-compatible drop-in, loaded in `family/manage/index.html`) configured in `family/manage/config.yml` (linked by absolute URL via `rel="cms-config-url"`, since `/family/manage` has no trailing slash). It sits behind the family hub sign-in and is admin-only: `middleware.js` sends anyone whose Google email isn't in `FAMILY_ADMIN_EMAILS` back to `/family` (password sign-ins never count, having no verified email), and the hub home page hides its card for them (`isAdmin()` in `api/_family/session.js`; the list is an env var because the repo is public). It then asks for its own GitHub sign-in to commit. `/admin` redirects here (`vercel.json`). Two collections: blog posts in `_posts/`, and "Classes" (a file collection editing `_data/classes.json`). A post's Class field is a relation widget onto that class list. If you add a frontmatter field that the build uses, add it to the posts collection too.

Auth flow (Vercel serverless, in `api/`): Sveltia's "Sign in with GitHub" opens `api/auth` in a pop-up, which hands a GitHub token back with the Decap-style `postMessage` handshake (`api/_family/cms-auth.js`, posting only to the site's own origin).
- `api/auth.js` — if the visitor has a family-hub session from an admin Google email (`isAdmin()`) and `GITHUB_CMS_TOKEN` is set, it returns that token immediately: no GitHub page. `GITHUB_CMS_TOKEN` is a fine-grained personal access token limited to this repo with Contents read/write, so commits are made as its owner. Otherwise it redirects to GitHub's OAuth authorize URL.
- `api/callback.js` — exchanges GitHub's code for a token and hands it back the same way.
- Requires env vars `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in Vercel for the OAuth fallback; `GITHUB_CMS_TOKEN` for the instant admin sign-in.
- `family/manage/config.yml`'s `base_url` and `auth_endpoint: api/auth` must match the deployed domain.

## Family hub (`/family`)

A private area for the Randall family, separate from the public site. Every footer's "Sign in" links to `/family`.

- **Sign-in**: `middleware.js` (Vercel Routing Middleware) sends anyone without a valid `fh_session` cookie to `/family/login` (`/family/login` and `/family/assets/*` are open). The cookie is an HMAC-signed token (`api/_family/session.js`, Web Crypto only so it runs in both the Edge middleware and the Node function). Two ways in: the family password (`FAMILY_PASSWORD`, plus a typed name) or Google (Google Identity Services button → ID token verified server-side; the email must be in `FAMILY_GOOGLE_EMAILS`). **Never commit the password** — the repo is public.
- **API**: one function, `api/family.js`, routed by `?r=` (one function keeps the Hobby plan's function count down). Helpers live in `api/_family/` (underscore = not deployed as functions). Non-GET requests must send `x-family-hub: 1` (CSRF guard); the hub's `Hub.api()` does.
- **Storage**: a private Vercel Blob store — `recipes/index.json` (summaries; written with ETag `ifMatch` retries), `recipes/<id>.json`, `media/<random>.<ext>` (served through `?r=media` to signed-in family; a public recipe's own photos are also served on its link), `shared/slugs.json` (public links). ETags for those conditional writes come from `head()`, not `get()`: the CDN's etag never matches what `put()`'s `ifMatch` checks. Without a Blob token and off Vercel, `api/_family/store.js` falls back to a gitignored `.family-data/` folder.
- **Pages**: plain HTML under `family/` sharing `family/assets/hub.css` + `hub.js` (`window.Hub`: API, header/user menu, theme, toasts, markdown with the same image-placement rules as `build.js`, recipe rendering, photo downscaling). Each page has `<header class="hub-bar" data-crumbs=...>` and calls `Hub.ready()`. Pages load `/css/styles.css` for tokens; note its global `section` padding is reset for the hub. To add a tool: a page at `family/<slug>.html` (or folder), a card in `family/index.html`, and a `.hub-app--<slug>` tint in `hub.css`.
- **Cookbook** (`family/cookbook/`): list/search/tags, `recipe?id=` (scaler, tap-to-check, keep-screen-on, print), `edit` (paste-a-list ingredient parser, story markdown with photo upload, a tag picker — chips plus a search list with "Want to make" first, then tags by how many recipes use them, and an "Add new category" option — and a notes box that's a "- " bullet list by default, Enter adding the next bullet; on new recipes, a sparkle "fill in from a link" box). Tags always start with a capital letter, enforced in the picker and again in `normalize()` (`api/_family/recipes.js`). In the recipe view, the Steps styles and tap-to-check are scoped to `.rc-steps > ol > li`, because the Notes box sits inside the Steps section, `print` (whole cookbook or `?ids=` → browser "Save as PDF"). Quantities parse/scale/format via `js/recipe-scale.js`, shared by the hub, `build.js` and `main.js`.
- **Making a recipe public** (`api/_family/share.js`) gives it an unlisted link, `/recipes/<slug>` (slug from the title; editable from the recipe page's "Link options" pop-up). Nothing is committed or rebuilt: `shared/slugs.json` in Blob maps slug → recipe id, and `vercel.json` rewrites `/recipes/:slug` (and `/recipes/:slug/photos/:file`) to `api/recipe.js`, which renders the page live from the cookbook (`api/_family/share-page.js`: site recipe-card styles + `main.js` scaler, Open Graph tags for link previews, `noindex`, and a corner link: "Back to loganbrandall.com" for guests, "Back to the family cookbook" for anyone signed in to the hub). So it's live instantly, always current, and off the moment it's made private. Only photos the recipe uses are served. Public recipes are deliberately **not** on the main site — no listing page, Blog dropdown entry, homepage stat or sitemap entry. The hub's share button uses the Web Share API (the phone's share sheet), falling back to copying the link.
- **"Want to make"** is a special tag (`Hub.WANT_TAG` / `Hub.isWant()` in `hub.js`) for recipes the family hasn't tried yet. They're left out of the cookbook's All list, the other tag chips, search, the hub home page and the whole-cookbook PDF, and only show under their own chip. A to-try recipe's page has a "We made it! Add to cookbook" button that removes the tag.
- **Calendar** (`family/calendar.html`): `api/_family/calendar.js` reads the family Google Calendar's public iCal feed (cached 5 min), expands RRULEs in wall-clock time (so events keep their local time across DST), and returns JSON for a date range; the page draws its own month grid/agenda.
- **Recipe import** (`POST import`, `api/_family/import.js`): pasting a link (or a whole recipe's text) into the editor's sparkle box returns a draft that fills the form — nothing is saved except the cover photo, which goes to Blob like any upload. The server fetches the page itself (honest bot User-Agent — recipe sites 403 a fake browser UA from Node; private/localhost addresses are refused on every redirect hop), reads its schema.org Recipe JSON-LD, and with `ANTHROPIC_API_KEY` set sends that plus the page text to Claude (`claude-opus-5-5`, structured JSON output) to fill every field including notes/tips and to skip the blogger's story. Instagram posts are read from the post's `/embed/captioned/` page, which carries the caption. Without the key, only JSON-LD pages import (no notes), and Instagram and pasted text are refused with a "not set up" message. `vercel.json` gives `api/family.js` a 60s `maxDuration` for this.
- **Env vars** (Vercel): `FAMILY_PASSWORD`, `FAMILY_SESSION_SECRET` (random, 32+ bytes), `GOOGLE_CLIENT_ID`, `FAMILY_GOOGLE_EMAILS`, `FAMILY_ADMIN_EMAILS` (who sees and can open the site manager), `GITHUB_CMS_TOKEN` (the site manager's instant sign-in for admins), `ANTHROPIC_API_KEY` (recipe import; plus `ANTHROPIC_WORKSPACE_ID` if the key isn't scoped to a workspace), and the Blob store's `BLOB_READ_WRITE_TOKEN` (added when the store is connected). Locally they come from `.env.local` (gitignored). `.claude/serve.js` caches the API modules — restart it after editing `api/`.

## Frontend conventions

- **Touch screens**: the hub's `@media (pointer: coarse)` block (end of `hub.css`) sets text boxes to 16px, so iOS doesn't zoom in when one is tapped, and enlarges chips and small buttons to finger size. Keep new inputs and small controls covered by it. `styles.css` does the same for the Blog dropdown chevron.
- **Theme**: `data-theme="light|dark"` on `<html>`, choice persisted in `localStorage` under `lb-theme`. Default is light (system preference intentionally ignored). A one-line inline `<script>` at the top of every page's `<head>` (including `_src/post-template.html`) applies the saved theme before first paint so dark-mode users don't get a light flash — keep it in any new page. `main.js` also keeps `<meta name="theme-color">` in sync with the theme. All theme colors are CSS custom properties on `:root, [data-theme="light"]` and `[data-theme="dark"]` in `css/styles.css`; the accent green is `--accent`.
- **Animations**: `.reveal` class on any element triggers a GSAP fade-in on scroll (falls back to IntersectionObserver if GSAP fails to load, and to plain visibility under `prefers-reduced-motion`). GSAP + ScrollTrigger are loaded from cdnjs in each HTML file, with `defer` (as is `main.js`, which relies on that ordering).
- **Nav active state**: `main.js` compares bare page names (`about.html` → `about`) so it matches both locally and on Vercel's clean URLs (`/about`); anything under `/posts/` or `/classes/` highlights Blog. Post pages live at `posts/*.html`, so their nav links use `../index.html` etc.
- **Canonical URLs**: every page has `<link rel="canonical">` and `og:url` pointing at the clean URL (`https://www.loganbrandall.com/about`, `/posts/<slug>`).

## Site infrastructure

- **`404.html`** at the repo root is auto-served by Vercel for any not-found route. Styled to match the rest of the site (nav + footer included so users don't dead-end).
- **`apple-touch-icon.png`** (180×180, a photo of Logan and Marisa) at the repo root is the iPhone home-screen icon for every page. iOS picks it up from the root without a `<link>` tag.
- **`robots.txt`** is hand-written and references the sitemap. No reason to change unless you want to block crawlers.
- **`sitemap.xml`** is regenerated by `build.js` on every build — don't hand-edit it, your changes will be overwritten.

## Content placeholder convention

Anywhere content was intentionally left blank for Logan to fill in, the literal word `Placeholder` is used (vs. fake bio copy), with a `TODO(Logan)` HTML comment nearby. Search the repo for either to find every spot that still needs real content (currently none).

## Things that bite

- The `injectBetween` markers in `index.html` / `blog.html` / every page's `<head>` are required — losing them silently breaks the build's output without an error. The full marker set: `POSTS_START`/`POSTS_END` (blog.html), `RECENT_POSTS_START`/`RECENT_POSTS_END` (index.html), `OG_IMAGE_START`/`OG_IMAGE_END` (every page's `<head>`), `BLOG_MENU_START`/`BLOG_MENU_END` (every page's nav).
- All three homepage stats are rewritten by `build.js` via their `data-stat` attributes (projects shipped = number of `<article class="proj …">` cards in `projects.html`; blog posts and academic posts from `_posts/`) — keep the `data-stat="…" data-count="…"` attribute order, since `setStat()` matches it with a regex. Don't hand-edit those numbers.
- `SITE_URL` in `build.js` is hardcoded to `https://www.loganbrandall.com`. If the domain ever changes, update it there or social-share previews will point at the old URL.
- The hero photo's height is pinned via CSS `clamp()` (`clamp(540px, 72vh, 780px)` on desktop, `clamp(360px, 50vh, 500px)` under 900px wide, `clamp(260px, 36vh, 380px)` under 520px so the headline and buttons fit on a phone's first screen) for the cutout variant. The previous viewport-based `max-height: 82vh` caused the image to render at wildly different sizes on different laptops; don't revert it.
- `.md` files in `_posts/` only become live HTML after `npm run build` runs (Vercel runs it on every deploy). Posts created through the CMS land on GitHub as markdown only, so the committed `posts/*.html`, `blog.html` list and homepage stats lag behind until someone builds locally — the live site is fine either way.
- `SETUP.md` references a Cloudflare Worker for Decap auth; the live setup uses `api/auth.js` + `api/callback.js` instead. Don't follow SETUP.md verbatim for the auth piece.
