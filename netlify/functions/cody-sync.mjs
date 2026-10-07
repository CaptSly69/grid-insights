// Daily: sends newly published GRID Insights articles to Cody as PDFs, replaces edited ones,
// and removes unpublished ones. Runs at 09:00 UTC = 5:00 PM Philippine time, after the 4 PM review.
import { runCodySync } from "../lib/cody-sync.mjs";

export default async () => {
  const result = await runCodySync({ trigger: "schedule", maxUploads: 4 });
  console.log("[cody-sync]", JSON.stringify(result));
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "0 9 * * *" };
