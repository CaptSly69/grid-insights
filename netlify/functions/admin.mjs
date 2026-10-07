// Admin API for the Strategy Notes pipeline. Every route except login needs a valid session.
// Needs two Netlify environment variables: DATABASE_URL and ADMIN_PASSWORD.
import { neon } from "@neondatabase/serverless";
import { createHmac, timingSafeEqual } from "node:crypto";
import { runCodySync, codyConfigured, codyHasKey, listFolders } from "../lib/cody-sync.mjs";

// Which subject area the console manages. Override with a SITE_DOMAIN environment variable in Netlify.
const DOMAIN = process.env.SITE_DOMAIN || "real_estate_ph";
const COOKIE = "sn_admin";
const SESSION_DAYS = 7;

const DEFAULT_SETTINGS = {
  audience: "Filipino property buyers (including OFWs), local and foreign investors, and brokers who want a clear, data-backed read on the Philippine real estate market.",
  tone: "Clear, practical and neutral. Plain English, with Philippine market terms explained. No hype, no price predictions, no sales pitch.",
  prefer: ["Bangko Sentral ng Pilipinas (BSP), including its Residential Real Estate Price Index", "Philippine Statistics Authority (PSA)",
    "government agencies and laws (DHSUD, BIR, LRA, Pag-IBIG Fund, PEZA)", "property consultancy research (Colliers, Leechiu, JLL, Santos Knight Frank, Cushman & Wakefield)",
    "listed developers' PSE disclosures and annual reports", "established business news (BusinessWorld, Inquirer, Philstar, Reuters, Bloomberg)"],
  avoid: ["property listing ads and agent marketing pages", "developer sales brochures used as evidence of market performance",
    "forums, social media and anonymous blogs", "content farms and AI-generated SEO sites"],
  required_sections: ["What it is", "How it works", "Worked example", "Risks", "Who it may suit", "Key takeaways"],
  min_words: 900,
  max_words: 1900,
  stale_days: 180,
  min_sources: 3,
  min_verified_claims: 8,
  banned_phrases: ["guaranteed", "risk-free", "sure profit", "can't lose", "guaranteed appreciation", "prices will only go up", "best time to buy", "once in a lifetime"],
  disclaimer: "This article is for general information only and is not legal, tax or investment advice. Figures change over time; verify them with the relevant government office or a licensed professional before making a decision.",
};

/* ---------- responses ---------- */
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
const fail = (status, message, extra = {}) => json({ error: message, ...extra }, status);

/* ---------- sessions ---------- */
const sign = (value) => createHmac("sha256", process.env.ADMIN_PASSWORD).update(value).digest("base64url");
const makeToken = () => {
  const exp = String(Date.now() + SESSION_DAYS * 86400000);
  return `${exp}.${sign(exp)}`;
};
function validToken(token) {
  if (!token) return false;
  const [exp, mac] = token.split(".");
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const a = Buffer.from(mac), b = Buffer.from(sign(exp));
  return a.length === b.length && timingSafeEqual(a, b);
}
function readCookie(req, name) {
  for (const part of (req.headers.get("cookie") || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}
const sessionCookie = (value, maxAge) =>
  `${COOKIE}=${value}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
function passwordMatches(given) {
  const digest = (v) => createHmac("sha256", "compare").update(String(v ?? "")).digest();
  return timingSafeEqual(digest(given), digest(process.env.ADMIN_PASSWORD));
}

/* ---------- article checks (same rules the reviewer task uses) ---------- */
function mainText(body) {
  const i = body.lastIndexOf("\n---");
  return i === -1 ? body : body.slice(0, i);
}
const markerIds = (text) => [...new Set([...text.matchAll(/\[c(\d+)\]/g)].map((m) => Number(m[1])))];

function runChecks(article, cfg, claims) {
  const problems = [];
  const body = article.body_md || "";
  const main = mainText(body);
  const markers = markerIds(main);
  const byId = new Map(claims.map((c) => [Number(c.id), c]));

  const bad = markers.filter((id) => byId.get(id)?.status !== "verified");
  if (bad.length) problems.push(`Cites claims that are missing or not verified: ${bad.map((i) => "c" + i).join(", ")}`);
  const unlinked = markers.filter((id) => byId.get(id)?.status === "verified" && !byId.get(id).linked);
  if (unlinked.length) {
    problems.push(`Cited but missing from the source list: ${unlinked.map((i) => "c" + i).join(", ")}. Saving or publishing fixes this.`);
  }
  if (!markers.length) problems.push("The article doesn't cite any claims.");

  const want = cfg.required_sections || [];
  const headings = [...main.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  if (want.length && headings.join("|").toLowerCase() !== want.join("|").toLowerCase()) {
    problems.push(`Section headings should be, in order: ${want.join(", ")}`);
  }

  const words = main.replace(/\[c\d+\]/g, "").replace(/[#*]/g, "").split(/\s+/).filter(Boolean).length;
  if (cfg.min_words && words < cfg.min_words) problems.push(`Too short: ${words} words (minimum ${cfg.min_words}).`);
  if (cfg.max_words && words > cfg.max_words) problems.push(`Too long: ${words} words (maximum ${cfg.max_words}).`);

  const lower = body.toLowerCase();
  const banned = (cfg.banned_phrases || []).filter((p) => p && lower.includes(p.toLowerCase()));
  if (banned.length) problems.push(`Uses banned phrases: ${banned.join(", ")}`);

  if (body.lastIndexOf("\n---") === -1) problems.push("The disclaimer is missing.");
  return { problems, words, cited: markers.length };
}

/* ---------- validation ---------- */
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strList = (v, maxItems = 30, maxLen = 200) =>
  Array.isArray(v) ? v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems) : [];
const int = (v, min, max) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
};

/* ---------- handler ---------- */
export default async (req) => {
  if (!process.env.DATABASE_URL) return fail(500, "DATABASE_URL is not set in Netlify.");
  if (!process.env.ADMIN_PASSWORD) {
    return fail(500, "ADMIN_PASSWORD is not set. Add it in Netlify under Environment variables, then redeploy.");
  }

  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/admin\/?/, "").split("/").filter(Boolean);
  const [resource, idPart, action] = parts;
  const id = idPart ? Number.parseInt(idPart, 10) : null;
  const method = req.method;

  if (resource === "login" && method === "POST") {
    const { password } = await req.json().catch(() => ({}));
    if (!passwordMatches(password)) {
      await new Promise((r) => setTimeout(r, 600)); // slows down guessing
      return fail(401, "That password isn't right.");
    }
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(makeToken(), SESSION_DAYS * 86400) });
  }
  if (resource === "logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }
  if (!validToken(readCookie(req, COOKIE))) return fail(401, "Please sign in.");
  if (method !== "GET" && req.headers.get("x-admin-request") !== "1") return fail(403, "Request blocked.");
  if (idPart && !Number.isFinite(id) && resource !== "cody") return fail(400, "Invalid id.");

  const sql = neon(process.env.DATABASE_URL);
  const body = method === "GET" ? {} : await req.json().catch(() => ({}));

  async function loadSettings() {
    const rows = await sql`SELECT config FROM pipeline_settings WHERE domain = ${DOMAIN}`;
    return { ...DEFAULT_SETTINGS, ...(rows[0]?.config || {}) };
  }

  try {
    /* ----- session & overview ----- */
    if (resource === "session" && method === "GET") return json({ ok: true, domain: DOMAIN });

    if (resource === "overview" && method === "GET") {
      const [row] = await sql`
        SELECT
          (SELECT count(*)::int FROM topics WHERE domain = ${DOMAIN} AND status = 'queued') AS queued,
          (SELECT count(*)::int FROM articles WHERE domain = ${DOMAIN} AND status IN ('draft', 'needs_review')) AS to_review,
          (SELECT count(*)::int FROM articles WHERE domain = ${DOMAIN} AND status = 'published') AS published,
          (SELECT row_to_json(r) FROM (SELECT id, status, started_at, finished_at FROM pipeline_runs
             WHERE domain = ${DOMAIN} ORDER BY id DESC LIMIT 1) r) AS last_run`;
      return json(row);
    }

    /* ----- topics ----- */
    if (resource === "topics") {
      if (method === "GET" && !id) {
        const topics = await sql`
          SELECT t.id, t.title, t.notes, t.status, t.created_at, t.updated_at,
                 (SELECT count(*)::int FROM pipeline_runs r WHERE r.topic_id = t.id) AS runs,
                 (SELECT a.id FROM articles a WHERE a.topic_id = t.id ORDER BY a.id DESC LIMIT 1) AS article_id,
                 (SELECT a.status FROM articles a WHERE a.topic_id = t.id ORDER BY a.id DESC LIMIT 1) AS article_status
            FROM topics t WHERE t.domain = ${DOMAIN}
           ORDER BY CASE t.status WHEN 'in_progress' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2
                                  WHEN 'skipped' THEN 3 ELSE 4 END,
                    CASE WHEN t.status = 'done' THEN NULL ELSE t.created_at END,
                    t.updated_at DESC`;
        return json({ topics });
      }

      if (method === "POST" && !id) {
        const title = str(body.title, 200);
        const notes = str(body.notes, 500) || null;
        if (title.length < 3) return fail(400, "Give the topic a title of at least 3 characters.");
        const rows = await sql`
          INSERT INTO topics (domain, title, notes, created_at)
          VALUES (${DOMAIN}, ${title}, ${notes},
                  GREATEST(now(), (SELECT max(created_at) FROM topics WHERE domain = ${DOMAIN}) + interval '1 millisecond'))
          ON CONFLICT (domain, title) DO NOTHING RETURNING id`;
        if (!rows.length) return fail(409, "A topic with that title already exists.");
        return json({ id: rows[0].id });
      }

      if (method === "POST" && id && action === "move") {
        const moved = body.direction === "up"
          ? await sql`
              WITH t AS (SELECT id, created_at FROM topics WHERE id = ${id} AND domain = ${DOMAIN} AND status = 'queued'),
                   nb AS (SELECT q.id, q.created_at FROM topics q, t
                           WHERE q.domain = ${DOMAIN} AND q.status = 'queued' AND q.created_at < t.created_at
                           ORDER BY q.created_at DESC LIMIT 1)
              UPDATE topics x SET created_at = CASE WHEN x.id = (SELECT id FROM t) THEN (SELECT created_at FROM nb)
                                                    ELSE (SELECT created_at FROM t) END
               WHERE x.id IN ((SELECT id FROM t), (SELECT id FROM nb)) AND EXISTS (SELECT 1 FROM nb)
              RETURNING x.id`
          : await sql`
              WITH t AS (SELECT id, created_at FROM topics WHERE id = ${id} AND domain = ${DOMAIN} AND status = 'queued'),
                   nb AS (SELECT q.id, q.created_at FROM topics q, t
                           WHERE q.domain = ${DOMAIN} AND q.status = 'queued' AND q.created_at > t.created_at
                           ORDER BY q.created_at ASC LIMIT 1)
              UPDATE topics x SET created_at = CASE WHEN x.id = (SELECT id FROM t) THEN (SELECT created_at FROM nb)
                                                    ELSE (SELECT created_at FROM t) END
               WHERE x.id IN ((SELECT id FROM t), (SELECT id FROM nb)) AND EXISTS (SELECT 1 FROM nb)
              RETURNING x.id`;
        return json({ moved: moved.length === 2 });
      }

      if (method === "POST" && id && action === "status") {
        const to = body.status;
        const [t] = await sql`SELECT status FROM topics WHERE id = ${id} AND domain = ${DOMAIN}`;
        if (!t) return fail(404, "Topic not found.");
        const allowed = {
          queued: ["failed", "skipped", "done", "in_progress"],
          skipped: ["queued", "failed"],
        };
        if (!allowed[to]?.includes(t.status)) return fail(409, `A ${t.status} topic can't be set to ${to}.`);
        if (to === "queued") {
          const position = body.position === "front" ? "front" : "end";
          await sql`
            UPDATE topics SET status = 'queued', updated_at = now(),
              created_at = CASE WHEN ${position} = 'front'
                THEN LEAST(now(), (SELECT min(created_at) FROM topics WHERE domain = ${DOMAIN} AND status = 'queued') - interval '1 millisecond')
                ELSE GREATEST(now(), (SELECT max(created_at) FROM topics WHERE domain = ${DOMAIN}) + interval '1 millisecond') END
            WHERE id = ${id}`;
        } else {
          await sql`UPDATE topics SET status = ${to}, updated_at = now() WHERE id = ${id}`;
        }
        return json({ ok: true });
      }

      if (method === "DELETE" && id) {
        const rows = await sql`
          DELETE FROM topics t WHERE t.id = ${id} AND t.domain = ${DOMAIN} AND t.status IN ('queued', 'skipped')
             AND NOT EXISTS (SELECT 1 FROM pipeline_runs r WHERE r.topic_id = t.id)
             AND NOT EXISTS (SELECT 1 FROM articles a WHERE a.topic_id = t.id)
          RETURNING id`;
        if (!rows.length) return fail(409, "Only queued or skipped topics that have never run can be deleted.");
        return json({ ok: true });
      }
    }

    /* ----- articles ----- */
    if (resource === "articles") {
      if (method === "GET" && !id) {
        const articles = await sql`
          SELECT a.id, a.title, a.slug, a.status, a.created_at, a.updated_at, a.published_at, a.run_id,
                 t.title AS topic, a.critic_report->'auto_review'->>'result' AS auto_review,
                 (SELECT d.status FROM cody_documents d WHERE d.article_id = a.id) AS cody_status,
                 (SELECT count(*)::int FROM article_claims ac WHERE ac.article_id = a.id) AS claims
            FROM articles a LEFT JOIN topics t ON t.id = a.topic_id
           WHERE a.domain = ${DOMAIN}
           ORDER BY CASE a.status WHEN 'needs_review' THEN 0 WHEN 'draft' THEN 1 WHEN 'published' THEN 2 ELSE 3 END,
                    a.created_at DESC`;
        return json({ articles });
      }

      const [article] = id ? await sql`
        SELECT a.id, a.title, a.slug, a.summary, a.body_md, a.status, a.run_id, a.topic_id, a.created_at,
               a.updated_at, a.published_at, a.critic_report, t.title AS topic
          FROM articles a LEFT JOIN topics t ON t.id = a.topic_id
         WHERE a.id = ${id} AND a.domain = ${DOMAIN}` : [];
      if (id && !article) return fail(404, "Article not found.");

      const loadClaims = () => sql`
        SELECT c.id, c.text, c.claim_type, c.value, c.evidence_quote, c.as_of, c.status, c.check_notes,
               s.title AS source_title, s.publisher, s.url,
               EXISTS (SELECT 1 FROM article_claims ac WHERE ac.article_id = ${article.id} AND ac.claim_id = c.id) AS linked
          FROM claims c JOIN sources s ON s.id = c.source_id
         WHERE (c.run_id = ${article.run_id}) OR (${article.run_id}::bigint IS NULL AND c.topic_id = ${article.topic_id})
         ORDER BY c.id`.then((rows) => {
          const cited = new Set(markerIds(mainText(currentBody)));
          return rows.map((c) => ({ ...c, cited: cited.has(Number(c.id)) }))
                     .sort((a, b) => Number(b.cited) - Number(a.cited) || Number(a.id) - Number(b.id));
        });
      let currentBody = article?.body_md || "";
      const syncLinks = async (text) => {
        const cited = markerIds(mainText(text));
        await sql`DELETE FROM article_claims WHERE article_id = ${id} AND NOT (claim_id = ANY(${cited}::bigint[]))`;
        await sql`INSERT INTO article_claims (article_id, claim_id)
                  SELECT ${id}, c.id FROM claims c
                   WHERE c.id = ANY(${cited}::bigint[]) AND c.status = 'verified' AND c.topic_id = ${article.topic_id}
                  ON CONFLICT DO NOTHING`;
      };

      if (method === "GET" && id) {
        const [claims, cfg, cody] = await Promise.all([loadClaims(), loadSettings(),
          sql`SELECT status, sent_at, learned_at, error, updated_at FROM cody_documents WHERE article_id = ${id}`]);
        return json({ article, claims, checks: runChecks(article, cfg, claims), cody: cody[0] || null });
      }

      if (method === "PUT" && id) {
        const title = str(body.title, 300);
        const summary = str(body.summary, 1500);
        const bodyMd = typeof body.body_md === "string" ? body.body_md.slice(0, 200000) : "";
        if (title.length < 3 || bodyMd.trim().length < 50) return fail(400, "The title and article text can't be empty.");
        await sql`UPDATE articles SET title = ${title}, summary = ${summary}, body_md = ${bodyMd}, updated_at = now()
                   WHERE id = ${id}`;
        await sql`
          UPDATE articles SET sections = (
            SELECT coalesce(jsonb_agg(jsonb_build_object('heading', split_part(chunk, E'\\n', 1),
                     'body_md', btrim(substr(chunk, length(split_part(chunk, E'\\n', 1)) + 1), E' \\n')) ORDER BY ord), '[]'::jsonb)
              FROM regexp_split_to_table(regexp_replace(split_part(body_md, E'\\n---', 1), '^## ', ''), E'\\n## ')
                   WITH ORDINALITY AS t(chunk, ord))
          WHERE id = ${id}`;
        await syncLinks(bodyMd);
        currentBody = bodyMd;
        const [fresh] = await sql`SELECT id, title, slug, summary, body_md, status, run_id, topic_id FROM articles WHERE id = ${id}`;
        const [claims, cfg] = await Promise.all([loadClaims(), loadSettings()]);
        return json({ ok: true, checks: runChecks(fresh, cfg, claims) });
      }

      if (method === "POST" && id && action === "status") {
        const to = body.status;
        if (!["published", "draft", "needs_review", "archived"].includes(to)) return fail(400, "Unknown status.");
        if (to === "published") {
          await syncLinks(article.body_md || "");
          const [claims, cfg] = await Promise.all([loadClaims(), loadSettings()]);
          const checks = runChecks(article, cfg, claims);
          if (checks.problems.length && body.force !== true) {
            return fail(409, "This article doesn't pass the checks yet.", { problems: checks.problems });
          }
          const note = { manual_review: { result: "published", forced: checks.problems.length > 0, at: new Date().toISOString() } };
          await sql`UPDATE articles SET status = 'published', published_at = now(), updated_at = now(),
                      critic_report = coalesce(critic_report, '{}'::jsonb) || ${JSON.stringify(note)}::jsonb
                    WHERE id = ${id}`;
        } else {
          await sql`UPDATE articles SET status = ${to}, published_at = NULL, updated_at = now() WHERE id = ${id}`;
        }
        return json({ ok: true });
      }

      if (method === "POST" && id && action === "rerun") {
        if (!article.topic_id) return fail(409, "This article isn't linked to a topic.");
        await sql`UPDATE articles SET status = 'archived', published_at = NULL, updated_at = now() WHERE id = ${id}`;
        await sql`
          UPDATE topics SET status = 'queued', updated_at = now(),
            created_at = LEAST(now(), (SELECT min(created_at) FROM topics WHERE domain = ${DOMAIN} AND status = 'queued') - interval '1 millisecond')
          WHERE id = ${article.topic_id}`;
        return json({ ok: true });
      }
    }

    /* ----- runs ----- */
    if (resource === "runs" && method === "GET") {
      if (id) {
        const [run] = await sql`SELECT id, log, error FROM pipeline_runs WHERE id = ${id} AND domain = ${DOMAIN}`;
        return run ? json({ run }) : fail(404, "Run not found.");
      }
      const runs = await sql`
        SELECT r.id, r.status, r.error, r.started_at, r.finished_at, r.topic_id, t.title AS topic,
               (SELECT coalesce(json_object_agg(status, n), '{}'::json)
                  FROM (SELECT status, count(*)::int AS n FROM claims c WHERE c.run_id = r.id GROUP BY status) x) AS claims,
               (SELECT count(*)::int FROM sources s WHERE s.run_id = r.id) AS sources,
               (SELECT json_build_object('id', a.id, 'status', a.status, 'title', a.title)
                  FROM articles a WHERE a.run_id = r.id ORDER BY a.id DESC LIMIT 1) AS article
          FROM pipeline_runs r LEFT JOIN topics t ON t.id = r.topic_id
         WHERE r.domain = ${DOMAIN} ORDER BY r.id DESC LIMIT 60`;
      return json({ runs });
    }

    /* ----- Cody knowledge base ----- */
    if (resource === "cody") {
      if (method === "GET" && !idPart) {
        const [articles, runs] = await Promise.all([
          sql`SELECT a.id, a.title, a.published_at, a.updated_at, d.status, d.sent_at, d.learned_at, d.error,
                     (d.status = 'synced' AND d.article_updated_at < a.updated_at) AS edited_since
                FROM articles a LEFT JOIN cody_documents d ON d.article_id = a.id
               WHERE a.domain = ${DOMAIN} AND (a.status = 'published' OR (d.status IS NOT NULL AND d.status <> 'removed'))
               ORDER BY a.published_at DESC NULLS LAST`,
          sql`SELECT id, trigger, started_at, finished_at, summary, error FROM cody_sync_runs ORDER BY id DESC LIMIT 10`,
        ]);
        return json({ configured: codyConfigured(), has_key: codyHasKey(), folder: process.env.CODY_FOLDER_ID || null, articles, runs });
      }
      if (method === "GET" && idPart === "folders") {
        if (!codyHasKey()) return fail(400, "Add CODY_API_KEY in Netlify first, then redeploy.");
        try { return json({ folders: await listFolders(), current: process.env.CODY_FOLDER_ID || null }); }
        catch (e) { return fail(502, `Cody said: ${e.message}`); }
      }
      if (method === "POST" && idPart === "sync") {
        // One upload per click-step keeps each request inside Netlify's time limit; the page repeats until done.
        return json(await runCodySync({ trigger: "manual", maxUploads: 1 }));
      }
    }

    /* ----- settings ----- */
    if (resource === "settings") {
      if (method === "GET") {
        const rows = await sql`SELECT config, updated_at FROM pipeline_settings WHERE domain = ${DOMAIN}`;
        return json({ config: { ...DEFAULT_SETTINGS, ...(rows[0]?.config || {}) }, updated_at: rows[0]?.updated_at || null });
      }
      if (method === "PUT") {
        const c = body.config || {};
        const config = {
          audience: str(c.audience, 500),
          tone: str(c.tone, 500),
          prefer: strList(c.prefer),
          avoid: strList(c.avoid),
          required_sections: strList(c.required_sections, 12, 80),
          min_words: int(c.min_words, 200, 10000),
          max_words: int(c.max_words, 300, 20000),
          stale_days: int(c.stale_days, 1, 3650),
          min_sources: int(c.min_sources, 1, 20),
          min_verified_claims: int(c.min_verified_claims, 1, 100),
          banned_phrases: strList(c.banned_phrases, 50, 80),
          disclaimer: str(c.disclaimer, 1000),
        };
        if (!config.audience || !config.tone || !config.disclaimer) return fail(400, "Audience, tone and disclaimer can't be empty.");
        if (config.required_sections.length < 2) return fail(400, "List at least two required sections.");
        if (config.min_words == null || config.max_words == null || config.min_words >= config.max_words) {
          return fail(400, "The minimum word count must be lower than the maximum.");
        }
        if ([config.stale_days, config.min_sources, config.min_verified_claims].includes(null)) {
          return fail(400, "Fill in all the number fields.");
        }
        await sql`INSERT INTO pipeline_settings (domain, config, updated_at) VALUES (${DOMAIN}, ${JSON.stringify(config)}::jsonb, now())
                  ON CONFLICT (domain) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`;
        return json({ ok: true, config });
      }
    }

    return fail(404, "Not found.");
  } catch (err) {
    console.error(err);
    return fail(500, "Something went wrong talking to the database. Check the function log in Netlify.");
  }
};

export const config = { path: "/api/admin/*" };
