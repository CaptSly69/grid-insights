# Strategy Notes website

Shows the published articles from your Neon database. New articles appear automatically:
publish one in Neon and refresh the site within about a minute. No redeploy needed.

## Files
- `public/index.html`: the website (article list + article pages)
- `public/marked.umd.js`: turns the article Markdown into web text
- `netlify/functions/articles.mjs`: reads published articles from Neon
- `netlify.toml`, `package.json`: tell Netlify how to build it

## Deploy (GitHub + Netlify, free)
1. Create a GitHub repository and upload everything in this folder
   (including the hidden-looking `netlify` folder and `netlify.toml`).
2. In Netlify: Add new project, Import an existing project, GitHub, pick the repo.
   Leave the build settings as Netlify fills them in, then deploy.
3. In Neon, click Connect and copy the connection string.
4. In Netlify: Project configuration, Environment variables, Add a variable.
   Key: DATABASE_URL. Value: the connection string.
5. In Netlify: Deploys, Trigger deploy, Deploy project (so the new variable takes effect).

## Changing the name
Edit `Strategy Notes` in `public/index.html` (it appears in the title, the masthead and `SITE_NAME`).
