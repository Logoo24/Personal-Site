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

There are no tests and no linter. To preview locally, run a static file server from the repo root (`.claude/launch.json` has one: `python -m http.server 8123`); opening `index.html` straight from disk mostly works but root-relative paths like `/images/...` won't resolve. The build modifies `index.html`, `blog.html`, every page's OG block, and `sitemap.xml` **in place** — running it during a working session will show up in `git diff`.

## Build pipeline (`build.js`)

`npm run build` does six things:

1. For each `_posts/*.md` (skipping `draft: true`): parses frontmatter with `gray-matter`, renders markdown with `marked`, substitutes `{{key}}` placeholders into `_src/post-template.html`, writes to `posts/<slug>.html`.
2. Rewrites the post list inside `blog.html` between the literal HTML comments `<!-- POSTS_START -->` and `<!-- POSTS_END -->`.
3. Rewrites the top-3 recent posts inside `index.html` between `<!-- RECENT_POSTS_START -->` and `<!-- RECENT_POSTS_END -->`.
4. Writes the homepage stats via `setStat()`, which rewrites the `<div data-stat="…" data-count="N">N</div>` elements in `index.html`: projects shipped (count of `.proj` cards in `projects.html`), blog posts, and academic posts.
5. Injects `<meta og:image>` / `<meta twitter:image>` tags into every page (including each generated post) between `<!-- OG_IMAGE_START -->` and `<!-- OG_IMAGE_END -->` markers. The URL is `SITE_URL` + `OG_IMAGE` (both constants in `build.js`; currently `/images/og-card.jpg`, a 1200×630 JPG). Social crawlers don't run JS, so these tags **have to** be baked in at build time — and the image must be PNG/JPG, since most crawlers ignore SVG.
6. Generates `sitemap.xml` at the repo root listing every static page + every blog post (with publish date as `lastmod`), using clean URLs (`/about`, `/posts/<slug>`) since `vercel.json` has `cleanUrls: true`. `robots.txt` references the sitemap so crawlers find it.

Template values (title, summary, dates…) are HTML-escaped when substituted into `post-template.html`; only `{{body}}` (the rendered markdown) goes in raw.

**Do not remove those marker comments** — `injectBetween()` silently skips the file if the markers aren't found. If you change the post-card markup, change it inside `build.js` (the strings that get injected), not just in `blog.html` (it'll be overwritten on next build).

Slug = filename minus `.md`, lowercased, non-`[a-z0-9-]` replaced with `-`. Dates are parsed at UTC noon to avoid timezone shifts.

## Content architecture

**Everything except blog posts is hard-coded HTML.** To change wording on the homepage, About, Projects, or Resume, edit the HTML file directly — there is no JSON/CMS layer for page content any more (it was removed deliberately; don't reintroduce it).

**Blog posts** — markdown in `_posts/`, rendered at build time into `posts/*.html`. This is the only content managed through `/admin/`. Frontmatter shape:

```yaml
---
title: "..."
date: 2026-06-15
category: personal | academic    # the only two live categories
summary: "..."
readMinutes: 5
draft: false
---
```

`build.js` `CATEGORY_LABELS` also accepts the legacy values `essay`/`class`/`research`/`project` and maps them onto the two new labels, so un-migrated old posts still render — but new posts should use the two-value set. The blog page's filter pills (`blog.html`) and the CMS category options (`admin/config.yml`) are both pinned to the two new values, so out-of-set values won't be filterable.

**Projects** appear in two independent places: the homepage "Selected work" grid (`index.html`, plain `.card`s) and the full list on `projects.html`. On the projects page each project is a `.card.proj-card` inside a `.proj.proj--<name>` wrapper in a 2-column `.proj-grid`. A project with a custom look gets styles under `.proj--<name>` in `css/projects.css`, and can put decoration in a `.proj-behind` div that renders under the card (z-index 0) — that's how the ChooseAMovie popcorn bucket peeks over the card's top edge. Linked cards are `<a class="card proj-card">`; external links use `target="_blank" rel="noopener"` and a `↗` in the corner label. The ChooseAMovie card hotlinks its logo from `https://www.chooseamovie.app/brand/logo-lockup.svg` and falls back to a text wordmark via an inline `onerror`.

**Images**: the homepage hero is `images/logan-hero-720.webp` / `-1040.webp` (via `srcset`), generated from the original full-res cutout `images/logan-hero-cutout.svg` (which is just two embedded PNGs: photo + luminance mask; it's 4 MB, so never reference it from a page). The About page uses `images/about-logan-marisa.jpg` (hero, 4:5 crop) and `images/about-wedding-day.jpg` (inline `.figure`); the Resume portrait still points at `images/placeholders/portrait.svg`. There's no image tooling in `package.json` — photos were resized with Windows' System.Drawing, and project screenshots captured with headless Chrome.

**Social links** (LinkedIn, Instagram, Facebook, email) are a `ul.socials` list duplicated in `about.html` and `resume.html` — keep the two in sync. On print, the resume's social links show their full URLs.

**Resume** exists in two forms that must be kept in step: `resume.html` (the "story" version — a timeline of `.tl-item` entries with logo badges, metric tiles and optional `figure.tl-media` photos; styles under `RESUME TIMELINE` in `styles.css`) and the one-page PDF `files/logan-randall-resume.pdf`, rendered from `_src/resume-pdf.html` by `npm run resume-pdf` (not part of the Vercel build — the PDF is committed). The PDF deliberately omits Logan's phone number; never add it back. After regenerating, check it's still one page.

## CMS (`/admin/`)

Sveltia CMS (a Decap-compatible drop-in, loaded in `admin/index.html`) configured in `admin/config.yml`. It has a single collection: blog posts in `_posts/`. If you add a frontmatter field that the build uses, add it to that collection too.

Auth flow (Vercel serverless, in `api/`):
- `api/auth.js` — redirects to GitHub OAuth authorize URL.
- `api/callback.js` — exchanges code for token, posts it back to the admin window via `postMessage`.
- Requires env vars `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in Vercel.
- `admin/config.yml`'s `base_url` and `auth_endpoint: api/auth` must match the deployed domain.

## Frontend conventions

- **Theme**: `data-theme="light|dark"` on `<html>`, choice persisted in `localStorage` under `lb-theme`. Default is light (system preference intentionally ignored). A one-line inline `<script>` at the top of every page's `<head>` (including `_src/post-template.html`) applies the saved theme before first paint so dark-mode users don't get a light flash — keep it in any new page. `main.js` also keeps `<meta name="theme-color">` in sync with the theme. All theme colors are CSS custom properties on `:root, [data-theme="light"]` and `[data-theme="dark"]` in `css/styles.css`; the accent green is `--accent`.
- **Animations**: `.reveal` class on any element triggers a GSAP fade-in on scroll (falls back to IntersectionObserver if GSAP fails to load, and to plain visibility under `prefers-reduced-motion`). GSAP + ScrollTrigger are loaded from cdnjs in each HTML file, with `defer` (as is `main.js`, which relies on that ordering).
- **Nav active state**: `main.js` compares bare page names (`about.html` → `about`) so it matches both locally and on Vercel's clean URLs (`/about`); anything under `/posts/` highlights Blog. Post pages live at `posts/*.html`, so their nav links use `../index.html` etc.
- **Canonical URLs**: every page has `<link rel="canonical">` and `og:url` pointing at the clean URL (`https://www.loganbrandall.com/about`, `/posts/<slug>`).

## Site infrastructure

- **`404.html`** at the repo root is auto-served by Vercel for any not-found route. Styled to match the rest of the site (nav + footer included so users don't dead-end).
- **`robots.txt`** is hand-written and references the sitemap. No reason to change unless you want to block crawlers.
- **`sitemap.xml`** is regenerated by `build.js` on every build — don't hand-edit it, your changes will be overwritten.

## Content placeholder convention

Anywhere content was intentionally left blank for Logan to fill in, the literal word `Placeholder` is used (vs. fake bio copy), with a `TODO(Logan)` HTML comment nearby. Search the repo for either to find every spot that still needs real content (currently just the Resume headshot).

## Things that bite

- The `injectBetween` markers in `index.html` / `blog.html` / every page's `<head>` are required — losing them silently breaks the build's output without an error. The full marker set: `POSTS_START`/`POSTS_END` (blog.html), `RECENT_POSTS_START`/`RECENT_POSTS_END` (index.html), `OG_IMAGE_START`/`OG_IMAGE_END` (every page's `<head>`).
- All three homepage stats are rewritten by `build.js` via their `data-stat` attributes (projects shipped = number of `<article class="proj …">` cards in `projects.html`; blog posts and academic posts from `_posts/`) — keep the `data-stat="…" data-count="…"` attribute order, since `setStat()` matches it with a regex. Don't hand-edit those numbers.
- `SITE_URL` in `build.js` is hardcoded to `https://www.loganbrandall.com`. If the domain ever changes, update it there or social-share previews will point at the old URL.
- The hero photo's height is pinned via CSS `clamp()` (`clamp(540px, 72vh, 780px)` on desktop, `clamp(360px, 50vh, 500px)` under 900px wide) for the cutout variant. The previous viewport-based `max-height: 82vh` caused the image to render at wildly different sizes on different laptops; don't revert it.
- `.md` files in `_posts/` only become live HTML after `npm run build` runs (Vercel runs it on every deploy). Posts created through the CMS land on GitHub as markdown only, so the committed `posts/*.html`, `blog.html` list and homepage stats lag behind until someone builds locally — the live site is fine either way.
- `SETUP.md` references a Cloudflare Worker for Decap auth; the live setup uses `api/auth.js` + `api/callback.js` instead. Don't follow SETUP.md verbatim for the auth piece.
