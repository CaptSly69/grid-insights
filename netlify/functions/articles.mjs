
// Serves published articles from Neon to the website.
// Needs one environment variable in Netlify: DATABASE_URL (your Neon connection string).
import { neon } from "@neondatabase/serverless";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? "public, max-age=60" : "no-store",
    },
  });

export default async (req) => {
  if (!process.env.DATABASE_URL) {
    return json({ error: "missing_database_url",
      message: "DATABASE_URL is not set. Add it in Netlify under Site configuration, Environment variables, then redeploy." }, 500);
  }
  const sql = neon(process.env.DATABASE_URL);
  const slug = new URL(req.url).searchParams.get("slug");

  try {
    if (!slug) {
      const articles = await sql`
        SELECT a.title, a.slug, a.summary, a.domain, a.published_at,
               (SELECT count(DISTINCT c.source_id)
                  FROM article_claims ac JOIN claims c ON c.id = ac.claim_id
                 WHERE ac.article_id = a.id)::int AS source_count
          FROM articles a
         WHERE a.status = 'published'
         ORDER BY a.published_at DESC NULLS LAST`;
      return json({ articles });
    }

    const rows = await sql`
      SELECT id, title, slug, summary, domain, body_md, disclaimer, published_at, updated_at
        FROM articles WHERE slug = ${slug} AND status = 'published' LIMIT 1`;
    if (rows.length === 0) return json({ error: "not_found", message: "Article not found." }, 404);
    const article = rows[0];

    const claims = await sql`
      SELECT c.id AS claim_id, s.id AS source_id, s.title, s.publisher, s.url
        FROM article_claims ac
        JOIN claims c  ON c.id = ac.claim_id
        JOIN sources s ON s.id = c.source_id
       WHERE ac.article_id = ${article.id}`;
    delete article.id;
    return json({ article, claims });
  } catch (err) {
    console.error(err);
    return json({ error: "database_error", message: "The database query failed. Check the function log in Netlify." }, 500);
  }
};

export const config = { path: "/api/articles" };
