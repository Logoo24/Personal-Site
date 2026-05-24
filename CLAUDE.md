# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Logan Randall's personal site — a **static HTML/CSS/JS site** (no framework, no bundler). Vanilla JS, GSAP loaded from CDN, and a small Node build step that compiles markdown blog posts. Deployed via Vercel (`vercel.json`), with `/api/*` as Vercel serverless functions for the CMS auth flow.

> Note: `SETUP.md` describes a Cloudflare Pages + Cloudflare Worker setup. The actual current configuration is Vercel + Vercel serverless functions (`api/auth.js`, `api/callback.js`, `vercel.json`). When something disagrees, trust the code, not `SETUP.md`.

## Commands

```bash
npm install          # one-time
npm run build        # runs build.js — required after any change to _posts/ or post-template.html
```

There are no tests, no linter, and no dev server. To preview locally, open `index.html` in a browser (or run any static file server from the repo root). The build modifies `index.html` and `blog.html` **in place** — running it during a working session will show up in `git diff`.

## Build pipeline (`build.js`)

`npm run build` does five things:

1. For each `_posts/*.md` (skipping `draft: true`): parses frontmatter with `gray-matter`, renders markdown with `marked`, substitutes `{{key}}` placeholders into `_src/post-template.html`, writes to `posts/<slug>.html`.
2. Rewrites the post list inside `blog.html` between the literal HTML comments `<!-- POSTS_START -->` and `<!-- POSTS_END -->`.
3. Rewrites the top-3 recent posts inside `index.html` between `<!-- RECENT_POSTS_START -->` and `<!-- RECENT_POSTS_END -->`.
4. Updates the auto-computed fields (`blog_posts`, `classes_documented`) in `data/stats.json`, preserving the manually-edited fields (`projects_shipped`, `online_since`).
5. Injects `<meta og:image>` / `<meta twitter:image>` tags into every page (including each generated post) between `<!-- OG_IMAGE_START -->` and `<!-- OG_IMAGE_END -->` markers. The URL is built from `SITE_URL` (constant in `build.js`) + `images.json` (`og_image` if set, otherwise `hero_cutout`), URL-encoded so paths with spaces work. Social crawlers don't run JS, so these tags **have to** be baked in at build time — that's why this is in `build.js` and not `main.js`.

**Do not remove those marker comments** — `injectBetween()` silently skips the file if the markers aren't found. If you change the post-card markup, change it inside `build.js` (the strings that get injected), not just in `blog.html` (it'll be overwritten on next build).

Slug = filename minus `.md`, lowercased, non-`[a-z0-9-]` replaced with `-`. Dates are parsed at UTC noon to avoid timezone shifts.

## Content architecture (two channels)

Page content comes from two sources that you need to keep in mind together:

**1. Blog posts** — markdown in `_posts/`, rendered at build time into `posts/*.html`. Frontmatter shape:

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

`build.js` `CATEGORY_LABELS` also accepts the legacy values `essay`/`class`/`research`/`project` and maps them onto the two new labels, so un-migrated old posts still render — but new posts should use the two-value set. The blog page's filter pills (`blog.html`) and Decap's category options (`admin/config.yml` posts collection) are both pinned to the two new values, so out-of-set values won't be filterable.

**2. JSON-driven page content** — `data/*.json` files (`about.json`, `resume.json`, `featured-projects.json`, `projects.json`, `hero-variants.json`, `images.json`, `stats.json`) are fetched **client-side** by `js/main.js` and rendered into the static HTML shells. The hooks are HTML attributes:

- `data-render="homepage-hero"`, `"featured-projects"`, `"about-hero"`, `"about-content"`, `"resume-hero"`, `"resume-content"`, `"projects-hero"`, `"all-projects"` — JS finds the element and fills children.
- `data-image="hero_cutout"` (etc.) — JS sets `src` (for `<img>`) or `background-image` (for other elements) from `data/images.json`.
- `data-stat="projects_shipped"` (etc.) — JS sets `textContent` and `data-count` from `data/stats.json`. The GSAP count-up animation reads `data-count` at trigger time (not setup time) so the JSON-injected value wins over the HTML default.

**Two project JSONs, distinct purposes:** `data/featured-projects.json` holds the 3 cards shown on the *homepage*. `data/projects.json` holds the full grid shown on the *projects page*. They're independent — editing one doesn't touch the other.

This means **HTML files contain default/shell markup, JSON files hold the live content, and JS hydrates on load**. Editing prose in `about.html` directly won't show — change `data/about.json`. The exception is `js/main.js` which has hardcoded fallback `heroVariants` so the homepage hero works even if the JSON fetch fails.

## CMS (`/admin/`)

Decap CMS configured in `admin/config.yml`. The collections in `config.yml` mirror the JSON files in `data/` and the `_posts/` folder — if you add a new field to a JSON file, also add it to the matching Decap collection or it won't be editable from the admin UI.

Auth flow (Vercel serverless, in `api/`):
- `api/auth.js` — redirects to GitHub OAuth authorize URL.
- `api/callback.js` — exchanges code for token, posts it back to the admin window via `postMessage`.
- Requires env vars `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in Vercel.
- `admin/config.yml`'s `base_url` and `auth_endpoint: api/auth` must match the deployed domain.

## Frontend conventions

- **Theme**: `data-theme="light|dark"` on `<html>`, choice persisted in `localStorage` under `lb-theme`. Default is light (system preference intentionally ignored — see `main.js:21`). All theme colors are CSS custom properties on `:root, [data-theme="light"]` and `[data-theme="dark"]` in `css/styles.css`; the accent green is `--accent`.
- **Animations**: `.reveal` class on any element triggers a GSAP fade-in on scroll (falls back to IntersectionObserver if GSAP fails to load, and to plain visibility under `prefers-reduced-motion`). GSAP + ScrollTrigger are loaded from cdnjs in each HTML file.
- **Nav active state**: `main.js` matches the current pathname against nav `href`s and adds `.active`. Post pages live at `posts/*.html`, so nav links use `../index.html` etc.

## Things that bite

- The `injectBetween` markers in `index.html` / `blog.html` / every page's `<head>` are required — losing them silently breaks the build's output without an error. The full marker set: `POSTS_START`/`POSTS_END` (blog.html), `RECENT_POSTS_START`/`RECENT_POSTS_END` (index.html), `OG_IMAGE_START`/`OG_IMAGE_END` (every page's `<head>`).
- `data/stats.json` is shared between the CMS and `build.js`: admin edits `projects_shipped` / `online_since`, and the build overwrites `blog_posts` / `classes_documented` on every run. If you add a new auto-computed stat, compute it in `build.js` *and* declare the field in `admin/config.yml` so Decap preserves it on save.
- `SITE_URL` in `build.js` is hardcoded to `https://www.loganbrandall.com`. If the domain ever changes, update it there or social-share previews will point at the old URL.
- The hero photo's height is pinned via CSS `clamp()` (~440-600px on desktop, ~300-420px on mobile) for the cutout variant. The previous viewport-based `max-height: 82vh` caused the image to render at wildly different sizes on different laptops; don't revert it.
- `_posts/welcome.md` has a built version at `posts/welcome.html`; the other `.md` files in `_posts/` only become live HTML after `npm run build` runs (locally or on Vercel).
- Editing JSON in `data/` doesn't require a rebuild — it's fetched at runtime. Editing markdown in `_posts/` **does** require a rebuild.
- `SETUP.md` references a Cloudflare Worker for Decap auth; the live setup uses `api/auth.js` + `api/callback.js` instead. Don't follow SETUP.md verbatim for the auth piece.
