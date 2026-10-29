import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Reads an exam-schedule image/PDF with Google AI (Gemini) and returns structured rows.
// - The API key lives only in Supabase Secrets (GEMINI_API_KEY) and is never sent to the browser.
// - Only users whose profiles.ai_enabled = true may call it (checked here, on the server).
// - It never computes marks or averages; it only extracts dates, subjects and titles.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
const MAX_BASE64_CHARS = 8_000_000; // roughly 6 MB of file

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const PROMPT = `You read an Arabic school exam schedule (a table inside an image or PDF).
Extract ONLY real exam rows. Each real row has a date and a subject.
Rules:
- Skip empty day rows, headers, notes, holidays and any row without a clear subject. Never invent an exam from an empty or uncertain row.
- "date": ISO format YYYY-MM-DD. If the year is not shown, use the reference year given below. If the month is not shown for a row, infer it only from the surrounding rows of the same table.
- "day": the weekday name exactly as written (Arabic), or an empty string if not shown.
- "subject": the subject name exactly as written in the table.
- "title": the lesson / unit / topic text for that exam exactly as written, or an empty string.
- "notes": any other text in that row that is useful (room, time, remarks), or an empty string.
- Do not translate, summarise or correct the Arabic text. Do not add marks.
Return JSON only.`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    exams: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          date: { type: "STRING" },
          day: { type: "STRING" },
          subject: { type: "STRING" },
          title: { type: "STRING" },
          notes: { type: "STRING" },
        },
        required: ["date", "subject"],
      },
    },
  },
  required: ["exams"],
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    // 1) Identify the caller from their JWT
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);

    // 2) Only AI-enabled accounts may continue (RLS lets a user read only their own profile)
    const { data: profile, error: profErr } = await supabase
      .from("profiles")
      .select("ai_enabled")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (profErr) return json({ error: "profile_lookup_failed" }, 500);
    if (!profile?.ai_enabled) return json({ error: "ai_not_enabled" }, 403);

    // 3) Validate the request
    const body = await req.json().catch(() => null);
    const mimeType = String(body?.mimeType ?? "");
    const data = String(body?.data ?? "");
    const referenceYear = Number.isInteger(body?.referenceYear) ? body.referenceYear : new Date().getFullYear();
    if (!ALLOWED_MIME.includes(mimeType)) return json({ error: "unsupported_file_type" }, 400);
    if (!data || data.length > MAX_BASE64_CHARS) return json({ error: "file_missing_or_too_large" }, 400);

    // 4) Call Google AI. The key comes from Supabase Secrets only.
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) return json({ error: "ai_not_configured" }, 500);
    const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash-lite";

    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { text: `${PROMPT}\n\nReference year: ${referenceYear}` },
              { inline_data: { mime_type: mimeType, data } },
            ],
          }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
          },
        }),
      },
    );

    if (!aiRes.ok) {
      // Do not forward provider error bodies (they could echo request details)
      const status = aiRes.status === 429 ? 429 : 502;
      return json({ error: status === 429 ? "ai_rate_limited" : "ai_provider_error" }, status);
    }

    const aiJson = await aiRes.json();
    const text = aiJson?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    let parsed: { exams?: unknown[] } = {};
    try { parsed = JSON.parse(text); } catch { return json({ error: "ai_bad_output" }, 502); }

    // 5) Sanitise the output; the client still shows it for review before anything is saved
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const exams = (Array.isArray(parsed.exams) ? parsed.exams : [])
      .slice(0, 200)
      .map((e: any) => ({
        date: String(e?.date ?? "").trim(),
        day: String(e?.day ?? "").trim().slice(0, 30),
        subject: String(e?.subject ?? "").trim().slice(0, 80),
        title: String(e?.title ?? "").trim().slice(0, 300),
        notes: String(e?.notes ?? "").trim().slice(0, 1000),
      }))
      .filter((e) => dateRe.test(e.date) && !Number.isNaN(Date.parse(e.date)) && e.subject.length > 0);

    return json({ exams });
  } catch (_err) {
    return json({ error: "internal_error" }, 500);
  }
});
