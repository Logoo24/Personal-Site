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

`npm run build` does three things:

1. For each `_posts/*.md` (skipping `draft: true`): parses frontmatter with `gray-matter`, renders markdown with `marked`, substitutes `{{key}}` placeholders into `_src/post-template.html`, writes to `posts/<slug>.html`.
2. Rewrites the post list inside `blog.html` between the literal HTML comments `<!-- POSTS_START -->` and `<!-- POSTS_END -->`.
3. Rewrites the top-3 recent posts inside `index.html` between `<!-- RECENT_POSTS_START -->` and `<!-- RECENT_POSTS_END -->`.

**Do not remove those marker comments** — `injectBetween()` silently skips the file if the markers aren't found. If you change the post-card markup, change it inside `build.js` (the strings that get injected), not just in `blog.html` (it'll be overwritten on next build).

Slug = filename minus `.md`, lowercased, non-`[a-z0-9-]` replaced with `-`. Dates are parsed at UTC noon to avoid timezone shifts.

## Content architecture (two channels)

Page content comes from two sources that you need to keep in mind together:

**1. Blog posts** — markdown in `_posts/`, rendered at build time into `posts/*.html`. Frontmatter shape:

```yaml
---
title: "..."
date: 2026-06-15
category: essay | class | research | project
summary: "..."
readMinutes: 5
draft: false
---
```

**2. JSON-driven page content** — `data/*.json` files (`about.json`, `resume.json`, `featured-projects.json`, `hero-variants.json`, `images.json`) are fetched **client-side** by `js/main.js` and rendered into the static HTML shells. The hooks are HTML attributes:

- `data-render="homepage-hero"`, `"featured-projects"`, `"about-hero"`, `"about-content"`, `"resume-hero"`, `"resume-content"` — JS finds the element and fills children.
- `data-image="hero_cutout"` (etc.) — JS sets `src` (for `<img>`) or `background-image` (for other elements) from `data/images.json`.

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

- The `injectBetween` markers in `index.html` / `blog.html` are required — losing them silently breaks the build's output without an error.
- `_posts/welcome.md` has a built version at `posts/welcome.html`; the other `.md` files in `_posts/` only become live HTML after `npm run build` runs (locally or on Vercel).
- Editing JSON in `data/` doesn't require a rebuild — it's fetched at runtime. Editing markdown in `_posts/` **does** require a rebuild.
- `SETUP.md` references a Cloudflare Worker for Decap auth; the live setup uses `api/auth.js` + `api/callback.js` instead. Don't follow SETUP.md verbatim for the auth piece.
