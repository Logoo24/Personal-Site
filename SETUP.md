# How to launch loganbrandall.com

This guide walks you, step by step, through getting your site online and connected to your Namecheap domain. No coding experience required.

By the end you'll have:
- The site deployed on Cloudflare Pages (free, fast, reliable)
- Your Namecheap domain pointing at it
- A self-service admin panel at `loganbrandall.com/admin/` where you can sign in with GitHub and write blog posts in a friendly editor (no coding needed)
- A workflow for editing pages and tweaking the design

Reading time: ~10 minutes. Setup time: 30-60 minutes (mostly waiting for DNS).

---

## What you have

```
loganbrandall-site/
├── index.html          Home page
├── about.html          About page
├── blog.html           Blog index (auto-generated post list)
├── projects.html       Projects showcase
├── resume.html         Resume (with print-to-PDF button)
├── admin/              Self-service login + blog editor (Decap CMS)
│   ├── index.html
│   └── config.yml      <-- you'll edit this with your repo name
├── _posts/             Source markdown for blog posts (CMS writes here)
│   └── welcome.md      The first sample post
├── _src/
│   └── post-template.html   Template for individual post pages
├── posts/              Generated HTML posts (build.js outputs here)
│   └── welcome.html
├── css/
│   └── styles.css      All styles, including dark mode
├── js/
│   └── main.js         Theme toggle + animations
├── build.js            Converts _posts/*.md -> posts/*.html
├── package.json        Build dependencies
└── SETUP.md            This guide
```

---

## Part 1 - Look at it locally first (5 minutes)

1. Find the `loganbrandall-site` folder.
2. Double-click `index.html`. It should open in your default browser.
3. Click around the nav (Home, About, Blog, Projects, Resume) and the sample blog post.
4. Click the moon/sun icon in the top right to toggle dark mode. The first time you visit a fresh browser, you'll see a "try dark mode!" hint with a bouncing arrow - that hint never shows again once you click the toggle.

If everything looks right, move on. If something's broken, take a screenshot and tell me what page.

---

## Part 2 - Put the files on GitHub (10 minutes)

GitHub is where your site source lives. Cloudflare Pages reads from it.

### Step 1. Create a GitHub account
Skip if you have one. Go to https://github.com and sign up. Free.

### Step 2. Install GitHub Desktop
A free app that lets you push files to GitHub without using the command line.
1. Download from https://desktop.github.com.
2. Install and sign in.

### Step 3. Create the repository
1. In GitHub Desktop: File → New Repository.
2. Name: `loganbrandall.com` (anything works).
3. Local path: pick where to store it.
4. Click "Create Repository".

### Step 4. Add your site files
1. Open the repo folder you just created.
2. Copy the **contents** of the `loganbrandall-site/` folder into it (so `index.html`, `_posts/`, etc. should be at the root of the repo, not nested in another folder).
3. Back in GitHub Desktop: type a summary like "Initial site" and click "Commit to main".
4. Click "Publish repository". Uncheck "Keep this code private". Click Publish.

Your code is now on GitHub. Note the repo URL - it'll look like `https://github.com/YOUR-USERNAME/loganbrandall.com`.

---

## Part 3 - Deploy to Cloudflare Pages (10 minutes)

### Step 1. Sign up for Cloudflare
Go to https://dash.cloudflare.com/sign-up. Free.

### Step 2. Create a Pages project
1. In the Cloudflare dashboard sidebar, click "Workers & Pages" (or just "Pages").
2. Click "Create application" → "Pages" tab → "Connect to Git".
3. Click "Connect GitHub" and authorize Cloudflare.
4. Pick your `loganbrandall.com` repo and click "Begin setup".

### Step 3. Configure the build (IMPORTANT - this enables your CMS)
- Project name: `loganbrandall` (this becomes loganbrandall.pages.dev)
- Production branch: `main`
- Framework preset: **None**
- Build command: `npm install && npm run build`
- Build output directory: `/` (or leave blank - the build modifies files in place)

Click "Save and Deploy". Build takes 30-60 seconds.

### Step 4. Confirm
When it finishes, click the URL Cloudflare gives you (`loganbrandall.pages.dev`). The site should load. Test all pages and the theme toggle.

---

## Part 4 - Connect your Namecheap domain (10 minutes + DNS wait)

This is where loganbrandall.com starts pointing at your site.

### Step 1. Add your domain in Cloudflare Pages
1. Inside your Pages project, click the "Custom domains" tab.
2. Click "Set up a custom domain".
3. Type `loganbrandall.com` and Continue.

### Step 2. Move DNS to Cloudflare (recommended path)
1. In Cloudflare top nav, click "Add a site". Type `loganbrandall.com`. Pick the Free plan.
2. Cloudflare scans existing DNS records (probably none if the domain is new). Continue.
3. Cloudflare gives you two nameservers, like `xxx.ns.cloudflare.com` and `yyy.ns.cloudflare.com`. Copy both.
4. Go to https://ap.www.namecheap.com → sign in → Domain List → "Manage" next to loganbrandall.com.
5. Find the "Nameservers" section. Change the dropdown from "Namecheap BasicDNS" to "Custom DNS".
6. Paste the two Cloudflare nameservers, one per row. Click the green checkmark to save.
7. Wait. Nameserver changes can take 5 minutes to 24 hours (usually under an hour). Cloudflare will email you when it's active.
8. Once active, your Pages project's "Custom domains" tab will show "Active" and the site will be live at https://loganbrandall.com with HTTPS already set up.

---

## Part 5 - Turn on the self-service blog editor (15 minutes, one-time)

This is the part that lets you log in at `loganbrandall.com/admin/` and write blog posts without editing code. It uses Decap CMS, which talks to your GitHub repo.

You need to do three things: register a GitHub OAuth app, deploy a tiny Cloudflare Worker that handles the login flow, and update `admin/config.yml`.

### Step 1. Register a GitHub OAuth app
1. Go to https://github.com/settings/developers
2. "OAuth Apps" → "New OAuth App"
3. Fill in:
   - Application name: `Logan Randall - blog editor`
   - Homepage URL: `https://loganbrandall.com`
   - Authorization callback URL: leave blank for now (we'll update once the Worker is deployed)
4. Click "Register application". You'll see a Client ID. Copy it.
5. Click "Generate a new client secret". Copy that too. (You won't see it again.)
6. Keep this tab open.

### Step 2. Deploy the Decap auth Cloudflare Worker
The Worker is the bridge between Decap CMS and GitHub. Decap publishes a ready-to-use one.

1. In Cloudflare dashboard → Workers & Pages → "Create" → "Workers" tab → "Get started".
2. Name: `decap-auth-loganbrandall`. Click Deploy with the default starter.
3. After the deploy succeeds, click the worker name to open it → "Edit code".
4. Delete everything in the editor and paste the official Decap GitHub OAuth proxy code from https://github.com/i40west/netlify-cms-oauth-cloudflare (it's about 150 lines, MIT-licensed).
5. Click "Save and deploy".
6. Back in the Worker dashboard → "Settings" → "Variables and Secrets" → "Add variable":
   - Name: `GITHUB_CLIENT_ID`, Value: paste the Client ID from Step 1
   - Click "Encrypt" → "Save"
   - Add another: `GITHUB_CLIENT_SECRET` (paste the secret), encrypt, save
7. Note the Worker URL (looks like `https://decap-auth-loganbrandall.YOUR-USERNAME.workers.dev`).
8. Go back to the GitHub OAuth app you made and set the **Authorization callback URL** to: `https://decap-auth-loganbrandall.YOUR-USERNAME.workers.dev/callback` (replace with your actual Worker URL).

### Step 3. Wire it into your site's `admin/config.yml`
1. In your local repo, open `admin/config.yml` in any text editor.
2. Find the `repo:` line and change `USERNAME/loganbrandall.com` to your actual `github-username/repo-name`.
3. Find the `base_url:` line and change it to your Worker URL (without `/callback`).
4. Save.
5. In GitHub Desktop, commit and push. Cloudflare Pages auto-deploys in ~30 seconds.

### Step 4. Try it
1. Go to https://loganbrandall.com/admin/
2. Click "Login with GitHub". Authorize the OAuth app you registered.
3. You'll see the post editor. Click "New Post" → fill in title, date, summary, write the body in markdown → click "Publish".
4. Behind the scenes Decap commits a new `_posts/your-slug.md` to GitHub. Cloudflare Pages detects the commit, runs `npm run build`, and within ~30 seconds your post is live at https://loganbrandall.com/posts/your-slug.html and listed on /blog.html.

If the auth setup is too much for now, skip it - the rest of the site works perfectly without it. You can come back and turn on the CMS anytime, or just write posts by editing markdown files in `_posts/` directly through the GitHub web UI.

---

## Part 6 - Editing your site

You have three ways to make changes.

### A) Through the admin (`/admin/`) - blog posts only
Best for new blog posts. Login → New Post → Publish. That's it.

### B) Through the GitHub web UI - any file, no install needed
1. Go to your repo on github.com.
2. Click any file (e.g. `about.html`).
3. Click the pencil icon to edit.
4. Make changes, scroll down, click "Commit changes".
5. Live in ~30 seconds.

### C) On your computer
1. Open the repo folder in any text editor (VS Code is great and free).
2. Edit, save, commit in GitHub Desktop, push.

---

## Part 7 - Adding a new blog post manually (without admin)

If the admin isn't set up yet, or you'd rather just write markdown:

1. In `_posts/`, create a new file like `2026-06-15-my-new-post.md`.
2. Copy the structure of `_posts/welcome.md`:

```markdown
---
title: "Your post title"
date: 2026-06-15
category: essay
summary: "A 1-2 sentence description that shows on the blog list."
readMinutes: 5
draft: false
---

Write your post body here in markdown.

## Sub-heading

Regular paragraph text. **Bold** and *italic*.

- Bullet list
- Item two
```

3. Commit and push (or commit through the GitHub web UI).
4. Cloudflare Pages auto-builds and your post is live in ~30 seconds.

### Markdown tips
- `# Heading 1`, `## Heading 2`, `### Heading 3`
- `**bold**`, `*italic*`
- `[link text](https://example.com)`
- Bulleted list: lines starting with `-`
- Numbered list: `1.`, `2.`, etc.
- Blockquote: lines starting with `>`
- Inline code: `` `code` ``
- Code block: three backticks

---

## Common questions

**My theme keeps switching to dark when I want light.** Click the toggle - your choice is remembered on each browser. The site defaults to light for new visitors.

**How do I change the green to a different color?** Open `css/styles.css`. The first block (`:root, [data-theme="light"]`) has all the light colors. The next block (`[data-theme="dark"]`) has all the dark ones. Change `--accent` (the green) to any hex you like - everywhere it's used updates automatically.

**How do I change my email?** Search the codebase for `hello@loganbrandall.com` and replace with what you want. (You can set up that email address in Cloudflare Email Routing for free.)

**My changes aren't showing up.** Hard refresh (Cmd+Shift+R / Ctrl+Shift+R). If still not, check Cloudflare Pages → Deployments tab to see if the latest commit deployed. Click any deployment to see its build log.

**The build is failing.** Check the Cloudflare Pages build log. The most common cause is a malformed YAML frontmatter in a markdown file - make sure it's bracketed by `---` on lines by themselves and the values don't have unescaped quotes.

**Can I use a different domain?** Yes. Just add another custom domain in Cloudflare Pages.

**I want to turn off a blog post temporarily.** In the post's frontmatter, set `draft: true` and commit. The build will skip it.

---

Have fun. The site is yours to break.
