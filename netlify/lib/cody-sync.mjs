// Sends published GRID Insights articles to a Cody knowledge-base folder as branded PDFs,
// and keeps that folder in step with the website (replace on edit, remove on unpublish).
// Used by the daily scheduled function and by the admin's "Sync now" button.
//
// Netlify environment variables: CODY_API_KEY, CODY_FOLDER_ID, DATABASE_URL
// Optional: CODY_API_BASE (default https://getcody.ai/api/v1), SITE_DOMAIN (default real_estate_ph)
import { neon } from "@neondatabase/serverless";
import { marked } from "marked";
import PdfPrinter from "pdfmake";

const SITE_DOMAIN = process.env.SITE_DOMAIN || "real_estate_ph";
const FONT_BASE = process.env.PDF_FONT_BASE || "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/";
const BRAND = { nile: "#1C335E", muesli: "#BE8562", midnight: "#0E192F", iron: "#D2D2D2", muted: "#5A6275", cream: "#F7F2EB" };
const LEARN_TIMEOUT_MIN = 90;

/* ---------------- Cody API ---------------- */
class CodyError extends Error {
  constructor(message, status, retryAfter) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
const codyBase = () => process.env.CODY_API_BASE || "https://getcody.ai/api/v1";

async function cody(path, init = {}) {
  const res = await fetch(codyBase() + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.CODY_API_KEY}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = json?.message || (res.status === 401 ? "Cody rejected the API key (401)." : `Cody API error ${res.status}`);
    throw new CodyError(msg, res.status, Number(res.headers.get("retry-after")) || undefined);
  }
  return json;
}

async function listFolderDocuments(folderId, keyword) {
  const docs = [];
  for (let page = 1; page <= 20; page++) {
    const q = new URLSearchParams({ folder_id: folderId, page: String(page) });
    if (keyword) q.set("keyword", keyword);
    const r = await cody(`/documents?${q}`);
    const batch = Array.isArray(r?.data) ? r.data : [];
    docs.push(...batch);
    const p = r?.meta?.pagination || r?.meta || {};
    const last = p.total_pages ?? p.last_page;
    if (!batch.length || (last && page >= last) || (!last && !p.next_page && !p.links?.next)) break;
  }
  return docs;
}
export async function listFolders() {
  const folders = [];
  for (let page = 1; page <= 20; page++) {
    const r = await cody(`/folders?page=${page}`);
    const batch = Array.isArray(r?.data) ? r.data : [];
    folders.push(...batch.map((f) => ({ id: f.id, name: f.name })));
    const p = r?.meta?.pagination || r?.meta || {};
    const last = p.total_pages ?? p.last_page;
    if (!batch.length || (last && page >= last) || (!last && !p.next_page && !p.links?.next)) break;
  }
  return folders;
}
export const codyHasKey = () => Boolean(process.env.CODY_API_KEY);
const getDocument = async (id) => (await cody(`/documents/${encodeURIComponent(id)}`))?.data;
const deleteDocument = (id) => cody(`/documents/${encodeURIComponent(id)}`, { method: "DELETE" });

async function uploadPdf(folderId, fileName, buffer) {
  const r = await cody("/uploads/signed-url", { method: "POST", body: JSON.stringify({ file_name: fileName, content_type: "application/pdf" }) });
  const url = r?.data?.url ?? r?.url;
  const key = r?.data?.key ?? r?.key;
  if (!url || !key) throw new CodyError("Cody did not return an upload link.", 502);
  const put = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: buffer });
  if (!put.ok) throw new CodyError(`File storage upload failed (${put.status}).`, 502);
  await cody("/documents/file", { method: "POST", body: JSON.stringify({ folder_id: folderId, key }) });
}

/* ---------------- PDF (same design as the website's Download PDF button) ---------------- */
let printerPromise = null;
function getPrinter() {
  if (printerPromise) return printerPromise;
  const files = {
    poppins: "poppins/Poppins-Regular.ttf", poppinsBold: "poppins/Poppins-SemiBold.ttf", poppinsItalic: "poppins/Poppins-Italic.ttf",
    cantata: "cantataone/CantataOne-Regular.ttf",
    judson: "judson/Judson-Regular.ttf", judsonBold: "judson/Judson-Bold.ttf", judsonItalic: "judson/Judson-Italic.ttf",
  };
  printerPromise = (async () => {
    const entries = await Promise.all(Object.entries(files).map(async ([k, path]) => {
      const res = await fetch(FONT_BASE + path);
      if (!res.ok) throw new Error(`Font download failed: ${path} (${res.status})`);
      return [k, Buffer.from(await res.arrayBuffer())];
    }));
    const f = Object.fromEntries(entries);
    return new PdfPrinter({
      Poppins: { normal: f.poppins, bold: f.poppinsBold, italics: f.poppinsItalic, bolditalics: f.poppinsItalic },
      Cantata: { normal: f.cantata, bold: f.cantata, italics: f.cantata, bolditalics: f.cantata },
      Judson: { normal: f.judson, bold: f.judsonBold, italics: f.judsonItalic, bolditalics: f.judsonItalic },
    });
  })().catch((e) => { printerPromise = null; throw e; });
  return printerPromise;
}

const decodeHtml = (s) => String(s)
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const fmtDate = (d) => d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Manila" }) : "";
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function splitDisclaimer(md, disclaimer) {
  const i = md.lastIndexOf("\n---");
  if (i !== -1 && md.length - i < 1200) return [md.slice(0, i), disclaimer || md.slice(i + 4).replace(/[*_]/g, "").trim()];
  return [md, disclaimer];
}
function numberSources(md, claims) {
  const sourceOfClaim = new Map(claims.map((c) => [String(c.claim_id), c]));
  const order = [], numberOf = new Map();
  const out = md.replace(/(?:[ \t]*\[c(\d+)\])+/g, (run) => {
    const nums = [];
    for (const m of run.matchAll(/\[c(\d+)\]/g)) {
      const c = sourceOfClaim.get(m[1]);
      if (!c) continue;
      if (!numberOf.has(c.source_id)) { numberOf.set(c.source_id, order.length + 1); order.push(c); }
      const n = numberOf.get(c.source_id);
      if (!nums.includes(n)) nums.push(n);
    }
    return nums.length ? `⟦${nums.join(",")}⟧` : "";
  });
  return { md: out, sources: order };
}
function inline(tokens, base = {}) {
  const out = [];
  for (const t of tokens || []) {
    if (t.type === "strong") out.push(...inline(t.tokens, { ...base, bold: true }));
    else if (t.type === "em") out.push(...inline(t.tokens, { ...base, italics: true }));
    else if (t.type === "link") out.push(...inline(t.tokens, { ...base, link: t.href, color: BRAND.nile, decoration: "underline" }));
    else if (t.type === "br") out.push({ text: "\n" });
    else if (t.type !== "text" && t.type !== "escape" && t.tokens) out.push(...inline(t.tokens, base));
    else if (t.type === "text" && t.tokens) out.push(...inline(t.tokens, base));
    else {
      decodeHtml(t.text ?? t.raw ?? "").split(/(⟦[\d,]+⟧)/).forEach((part) => {
        if (!part) return;
        const m = part.match(/^⟦([\d,]+)⟧$/);
        out.push(m ? { text: m[1], sup: true, fontSize: 7, bold: true, color: BRAND.muesli } : { text: part, ...base });
      });
    }
  }
  return out;
}
function blocks(tokens) {
  const out = [];
  for (const t of tokens) {
    if (t.type === "heading" && t.depth <= 2) {
      out.push({ stack: [
        { canvas: [{ type: "line", x1: 0, y1: 0, x2: 36, y2: 0, lineWidth: 1.6, lineColor: BRAND.muesli }], margin: [0, 14, 0, 7] },
        { text: inline(t.tokens), style: "h2" }], headlineLevel: 1, unbreakable: true });
    } else if (t.type === "heading") out.push({ text: inline(t.tokens), style: "h3" });
    else if (t.type === "paragraph") out.push({ text: inline(t.tokens), style: "p" });
    else if (t.type === "list") {
      const items = t.items.map((it) => {
        const parts = blocks(it.tokens.map((x) => (x.type === "text" ? { type: "paragraph", tokens: x.tokens || [x] } : x)));
        parts.forEach((p) => { if (p.style === "p") p.style = "li"; });
        return parts.length === 1 ? parts[0] : { stack: parts };
      });
      out.push({ [t.ordered ? "ol" : "ul"]: items, markerColor: BRAND.muesli, margin: [6, 0, 0, 8] });
    } else if (t.type === "blockquote") {
      out.push({ table: { widths: [3, "*"], body: [[{ text: "", fillColor: BRAND.muesli }, { stack: blocks(t.tokens), margin: [8, 2, 0, 0] }]] },
        layout: "noBorders", margin: [0, 2, 0, 8] });
    } else if (t.type === "table") {
      const head = t.header.map((c) => ({ text: inline(c.tokens), bold: true, color: "#FFFFFF", fillColor: BRAND.nile }));
      const rows = t.rows.map((r) => r.map((c) => ({ text: inline(c.tokens) })));
      out.push({ table: { headerRows: 1, widths: head.map(() => "*"), body: [head, ...rows] }, layout: "lightHorizontalLines", fontSize: 8.5, margin: [0, 4, 0, 10] });
    } else if (t.type === "code") out.push({ text: t.text, style: "p" });
  }
  return out;
}

export async function buildArticlePdf(article, claims) {
  const [bodyMd, disclaimer] = splitDisclaimer(article.body_md || "", article.disclaimer);
  const { md, sources } = numberSources(bodyMd, claims);
  const words = bodyMd.replace(/\[c\d+\]/g, "").split(/\s+/).filter(Boolean).length;
  const mins = Math.max(1, Math.round(words / 220));
  const siteUrl = (process.env.URL || "").replace(/\/$/, "");
  const url = siteUrl ? `${siteUrl}/#/article/${encodeURIComponent(article.slug)}` : "";
  const meta = [`Published ${fmtDate(article.published_at)}`, `${mins} min read`, sources.length ? `Built from ${plural(sources.length, "source")}` : ""].filter(Boolean).join("     ");

  const doc = {
    pageSize: "A4",
    pageMargins: [56, 70, 56, 62],
    info: { title: article.title, author: "GRID Property Ventures", subject: article.summary || "", creator: "GRID Insights" },
    defaultStyle: { font: "Poppins", fontSize: 10, lineHeight: 1.45, color: BRAND.midnight },
    background: (page, size) => ({ canvas: [
      { type: "rect", x: 0, y: 0, w: size.width, h: 7, color: BRAND.nile },
      { type: "rect", x: 0, y: 7, w: size.width, h: 2, color: BRAND.muesli }] }),
    header: (page) => ({ margin: [56, 26, 56, 0], columns: [
      { width: "auto", text: [{ text: "GRID", font: "Cantata", fontSize: 14, color: BRAND.nile, characterSpacing: 2 },
                              { text: "  Insights", font: "Judson", italics: true, fontSize: 12.5, color: BRAND.muesli }] },
      { width: "*", text: page === 1 ? "" : article.title, alignment: "right", fontSize: 7.5, color: BRAND.muted, margin: [16, 4, 0, 0] }] }),
    footer: (page, count) => ({ margin: [56, 22, 56, 0], columns: [
      { width: "*", text: "GRID Property Ventures. General information only, not legal, tax or investment advice.", fontSize: 7, color: BRAND.muted },
      { width: 70, text: `Page ${page} of ${count}`, alignment: "right", fontSize: 7, color: BRAND.muted }] }),
    content: [
      { text: article.title, style: "title" },
      article.summary ? { text: article.summary, style: "dek" } : null,
      { text: meta, style: "meta" },
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: 483, y2: 0, lineWidth: 0.6, lineColor: BRAND.iron }], margin: [0, 2, 0, 4] },
      ...blocks(marked.lexer(md)),
      sources.length ? { stack: [
        { canvas: [{ type: "line", x1: 0, y1: 0, x2: 36, y2: 0, lineWidth: 1.6, lineColor: BRAND.muesli }], margin: [0, 16, 0, 7] },
        { text: "Sources", style: "h2" }], unbreakable: true } : null,
      sources.length ? { layout: "noBorders", table: { widths: [16, "*"], dontBreakRows: true, body: sources.map((s, i) => [
        { text: String(i + 1), bold: true, color: BRAND.muesli, fontSize: 9 },
        { margin: [0, 0, 0, 5], stack: [
          { text: s.title || s.url, link: s.url, bold: true, color: BRAND.nile, fontSize: 9 },
          s.publisher ? { text: s.publisher, fontSize: 8, color: BRAND.muted } : null,
          { text: s.url, link: s.url, fontSize: 7, color: BRAND.muted }].filter(Boolean) }]) } } : null,
      disclaimer ? { margin: [0, 14, 0, 0], table: { widths: ["*"], body: [[{ text: disclaimer, fontSize: 8.5, color: BRAND.muted, margin: [10, 8, 10, 8] }]] },
        layout: { hLineWidth: () => 0, vLineWidth: (i) => (i === 0 ? 3 : 0), vLineColor: () => BRAND.muesli, fillColor: () => BRAND.cream } } : null,
      url ? { text: [{ text: "Read online with clickable sources: " }, { text: url, link: url, color: BRAND.nile }], fontSize: 8, color: BRAND.muted, margin: [0, 12, 0, 0] } : null,
    ].filter(Boolean),
    styles: {
      title: { font: "Cantata", fontSize: 22, lineHeight: 1.18, color: BRAND.nile, margin: [0, 8, 0, 8] },
      dek: { font: "Judson", italics: true, fontSize: 13, lineHeight: 1.3, color: BRAND.muted, margin: [0, 0, 0, 8] },
      meta: { fontSize: 8.5, color: BRAND.muted, margin: [0, 0, 0, 4] },
      h2: { font: "Cantata", fontSize: 14.5, lineHeight: 1.25, color: BRAND.nile, margin: [0, 0, 0, 6] },
      h3: { bold: true, fontSize: 11, margin: [0, 8, 0, 4] },
      p: { margin: [0, 0, 0, 8] },
      li: { margin: [0, 0, 0, 4] },
    },
    pageBreakBefore: (node, followingOnPage) => node.headlineLevel === 1 && followingOnPage.length === 0,
  };

  const printer = await getPrinter();
  return new Promise((resolve, reject) => {
    const pdf = printer.createPdfKitDocument(doc);
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    pdf.end();
  });
}

/* ---------------- sync ---------------- */
const norm = (s) => String(s || "").toLowerCase().replace(/\.[a-z0-9]{2,5}$/, "").replace(/[^a-z0-9]+/g, " ").trim();
const fileNameFor = (article) => `GRID-Insights-${article.slug}`.slice(0, 120) + ".pdf";

export function codyConfigured() {
  return Boolean(process.env.CODY_API_KEY && process.env.CODY_FOLDER_ID && process.env.DATABASE_URL);
}

/**
 * One sync pass. maxUploads keeps each run inside Netlify's time limit;
 * anything left over is picked up by the next run (or another "Sync now").
 */
export async function runCodySync({ trigger = "schedule", maxUploads = 3 } = {}) {
  if (!codyConfigured()) {
    return { ok: false, configured: false, message: "Set CODY_API_KEY and CODY_FOLDER_ID in Netlify, then redeploy." };
  }
  const sql = neon(process.env.DATABASE_URL);
  const folderId = process.env.CODY_FOLDER_ID;
  const [run] = await sql`INSERT INTO cody_sync_runs (trigger) VALUES (${trigger}) RETURNING id`;
  const summary = { matched: 0, learned: 0, failed: 0, uploaded: [], replaced: [], removed: [], waiting: 0, errors: [], remaining: 0 };
  const note = (article_id, message) => summary.errors.push({ article_id, message });
  let rateLimited = false;

  try {
    /* 1. Find and track documents Cody is still creating or learning */
    const pending = await sql`SELECT * FROM cody_documents WHERE status IN ('uploaded', 'syncing')`;
    let folderDocs = null;
    const claimed = new Set((await sql`SELECT cody_document_id FROM cody_documents WHERE cody_document_id IS NOT NULL`).map((r) => r.cody_document_id));
    for (const row of pending) {
      try {
        let doc = null;
        if (row.cody_document_id) {
          doc = await getDocument(row.cody_document_id);
        } else {
          folderDocs ??= await listFolderDocuments(row.folder_id);
          const sentAt = row.sent_at ? Math.floor(new Date(row.sent_at).getTime() / 1000) : 0;
          const base = norm(row.file_name);
          doc = folderDocs
            .filter((d) => !claimed.has(d.id) && Number(d.created_at || 0) >= sentAt - 120)
            .filter((d) => { const n = norm(d.name); return n === base || n.includes(base) || base.includes(n); })
            .sort((a, b) => Number(b.created_at) - Number(a.created_at))[0] || null; // newest copy = this upload
          if (doc) { claimed.add(doc.id); summary.matched++; }
        }
        if (doc) {
          const status = ["syncing", "synced", "sync_failed"].includes(doc.status) ? doc.status : "syncing";
          await sql`UPDATE cody_documents SET cody_document_id = ${doc.id}, status = ${status}, error = NULL,
                      learned_at = CASE WHEN ${status} = 'synced' THEN coalesce(learned_at, now()) ELSE learned_at END,
                      updated_at = now() WHERE article_id = ${row.article_id}`;
          if (status === "synced") summary.learned++;
          if (status === "sync_failed") summary.failed++;
        } else if (row.sent_at && Date.now() - new Date(row.sent_at).getTime() > LEARN_TIMEOUT_MIN * 60000) {
          await sql`UPDATE cody_documents SET status = 'error', error = 'Cody did not create the document in time. It will be uploaded again.', updated_at = now() WHERE article_id = ${row.article_id}`;
          summary.failed++;
        } else summary.waiting++;
      } catch (e) {
        if (e.status === 429) { rateLimited = true; break; }
        if (e.status === 404 && row.cody_document_id) {
          await sql`UPDATE cody_documents SET status = 'error', cody_document_id = NULL, error = 'The document was deleted in Cody. It will be uploaded again.', updated_at = now() WHERE article_id = ${row.article_id}`;
        } else note(row.article_id, e.message);
      }
    }

    /* 2. Remove documents for articles that are no longer published */
    const stale = await sql`
      SELECT d.* FROM cody_documents d LEFT JOIN articles a ON a.id = d.article_id
       WHERE d.status <> 'removed' AND (a.id IS NULL OR a.status <> 'published' OR a.domain <> ${SITE_DOMAIN})`;
    for (const row of stale) {
      if (rateLimited) break;
      if (!row.cody_document_id && ["uploaded", "syncing"].includes(row.status)) { summary.waiting++; continue; } // not created yet
      try {
        if (row.cody_document_id) await deleteDocument(row.cody_document_id).catch((e) => { if (e.status !== 404) throw e; });
        await sql`UPDATE cody_documents SET status = 'removed', cody_document_id = NULL, error = NULL, updated_at = now() WHERE article_id = ${row.article_id}`;
        summary.removed.push(row.article_id);
      } catch (e) { if (e.status === 429) rateLimited = true; else note(row.article_id, e.message); }
    }

    /* 3. Upload new, edited, re-published or failed articles */
    const due = await sql`
      SELECT a.id, a.title, a.slug, a.summary, a.body_md, a.disclaimer, a.published_at, a.updated_at,
             d.cody_document_id, d.status AS cody_status, d.article_updated_at
        FROM articles a LEFT JOIN cody_documents d ON d.article_id = a.id
       WHERE a.status = 'published' AND a.domain = ${SITE_DOMAIN}
         AND (d.article_id IS NULL OR d.status IN ('removed', 'error', 'sync_failed')
              OR (d.status = 'synced' AND d.article_updated_at < a.updated_at))
       ORDER BY a.published_at`;
    for (const a of due) {
      if (rateLimited || summary.uploaded.length + summary.replaced.length >= maxUploads) { summary.remaining++; continue; }
      try {
        const claims = await sql`
          SELECT c.id AS claim_id, s.id AS source_id, s.title, s.publisher, s.url
            FROM article_claims ac JOIN claims c ON c.id = ac.claim_id JOIN sources s ON s.id = c.source_id
           WHERE ac.article_id = ${a.id}`;
        const pdf = await buildArticlePdf(a, claims);
        const replacing = a.cody_status === "synced" && a.cody_document_id;
        if (a.cody_document_id) await deleteDocument(a.cody_document_id).catch((e) => { if (e.status !== 404) throw e; });
        const fileName = fileNameFor(a);
        await uploadPdf(folderId, fileName, pdf);
        await sql`
          INSERT INTO cody_documents (article_id, folder_id, file_name, cody_document_id, status, article_updated_at, sent_at, learned_at, error, updated_at)
          VALUES (${a.id}, ${folderId}, ${fileName}, NULL, 'uploaded', (SELECT updated_at FROM articles WHERE id = ${a.id}), now(), NULL, NULL, now())
          ON CONFLICT (article_id) DO UPDATE SET folder_id = EXCLUDED.folder_id, file_name = EXCLUDED.file_name, cody_document_id = NULL,
            status = 'uploaded', article_updated_at = EXCLUDED.article_updated_at, sent_at = now(), learned_at = NULL, error = NULL, updated_at = now()`;
        (replacing ? summary.replaced : summary.uploaded).push(a.id);
      } catch (e) {
        if (e.status === 429) { rateLimited = true; summary.remaining++; continue; }
        note(a.id, e.message);
        await sql`
          INSERT INTO cody_documents (article_id, folder_id, file_name, status, error, updated_at)
          VALUES (${a.id}, ${folderId}, ${fileNameFor(a)}, 'error', ${e.message}, now())
          ON CONFLICT (article_id) DO UPDATE SET status = 'error', error = EXCLUDED.error, updated_at = now()`;
      }
    }
    if (rateLimited) summary.errors.push({ message: "Cody is busy processing files (429). The rest will be sent on the next run." });

    await sql`UPDATE cody_sync_runs SET finished_at = now(), summary = ${JSON.stringify(summary)}::jsonb WHERE id = ${run.id}`;
    return { ok: true, configured: true, summary };
  } catch (e) {
    await sql`UPDATE cody_sync_runs SET finished_at = now(), summary = ${JSON.stringify(summary)}::jsonb, error = ${e.message} WHERE id = ${run.id}`;
    return { ok: false, configured: true, summary, message: e.message };
  }
}
