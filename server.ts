/**
 * clip-extractor-web — เว็บถอดข้อมูลจากคลิป (Touris Us)
 * Backend: Hono + Gemini Files API. Key อยู่ฝั่ง server ทีมไม่เห็น
 * รัน: bun run server.ts   (Render ตั้ง PORT ให้เอง)
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { GoogleGenAI } from "@google/genai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
if (!API_KEY) console.error("⚠️  ไม่พบ GEMINI_API_KEY — ตั้งใน env ก่อน");

const ai = new GoogleGenAI({ apiKey: API_KEY });
const INLINE_LIMIT = 20 * 1024 * 1024;

// ---------- prompt templates (กฎกันแบรนด์อื่นฝังไว้แล้ว) ----------
const ANTI_BRAND =
  "ห้ามใส่ชื่อแบรนด์/สินค้าอื่นที่ปรากฏในคลิป (เช่น ซิม แบรนด์มือถือ ผู้สนับสนุน) ในแคปชันหรือแฮชแท็ก ให้โฟกัสเฉพาะการขายทริปของทัวริสอัสเท่านั้น";

const TOURISUS = "ทัวริสอัส = บริษัททัวร์ outbound จากไทย (จัดทริป ตั๋วเครื่องบิน วีซ่า ประกัน โรงแรม)";

const TEMPLATES: Record<string, string> = {
  reels: `วิเคราะห์คลิปท่องเที่ยวนี้ (ภาพ+เสียง) เพื่อทำคอนเทนต์โซเชียล ตอบเป็น JSON ภาษาไทยเท่านั้น:
{
  "summary": "คลิปนี้เกี่ยวกับอะไร",
  "locations_shown": ["สถานที่/แลนด์มาร์กที่เห็นในภาพ"],
  "best_moments": [{"time": "MM:SS", "why": "ช่วงนี้เด่นเพราะ..."}],
  "hook_ideas": ["ประโยคเปิด 3 วิแรกสำหรับ Reel 3 แบบ"],
  "caption_options": ["แคปชันพร้อมโพสต์ 3 แบบ โทนต่างกัน"],
  "hashtags": ["#แฮชแท็กไทย+อังกฤษ"],
  "suggested_cuts": ["ช่วงเวลาที่ควรตัดทำ Reel 15-30 วิ พร้อม timestamp เริ่ม-จบ"]
}
บริบท: ${TOURISUS} ต้องการคอนเทนต์กระตุ้นคนอยากจองทริป
${ANTI_BRAND}`,

  teardown: `วิเคราะห์คลิปโฆษณา/คลิปอ้างอิงนี้ (ภาพ+เสียง) เพื่อถอดเทคนิคเล่าเรื่อง ตอบเป็น JSON ภาษาไทยเท่านั้น:
{
  "summary": "สรุปเนื้อเรื่อง 3-4 ประโยค",
  "hook": "3 วินาทีแรกใช้อะไรดึงคนดู",
  "storytelling_technique": "โครงเรื่อง/เทคนิคที่ใช้",
  "emotional_arc": "อารมณ์ดำเนินยังไงตั้งแต่ต้นจนจบ",
  "key_message": "สารหลักของคลิป",
  "why_it_works": "ทำไมถึงโดน",
  "apply_to_tourisus": ["เอาเทคนิคนี้มาทำคอนเทนต์ขายทริปทัวริสอัสยังไง 3-5 ข้อ"]
}
บริบท: ${TOURISUS}`,

  longextract: `ถอดข้อมูลจากคลิปนี้แบบละเอียด (ภาพ+เสียง) ตอบเป็น JSON ภาษาไทยเท่านั้น:
{
  "summary": "สรุปภาพรวม",
  "topics": [{"time": "MM:SS", "topic": "หัวข้อ", "detail": "สาระสำคัญ"}],
  "key_facts": ["ข้อมูล/ตัวเลข/ชื่อสถานที่ที่ควรจำ"],
  "faq_extracted": [{"q": "คำถาม", "a": "คำตอบ"}],
  "full_transcript": [{"time": "MM:SS", "speaker": "ผู้พูด", "text": "คำพูด"}]
}`,
};

// ---------- helpers ----------
function isYouTube(s: string) {
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(s.trim());
}
function safeParse(text: string): any {
  const c = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(c); }
  catch { const m = c.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error("parse JSON ไม่ได้"); }
}

async function buildMediaPart(file: File | undefined, youtubeUrl: string | undefined): Promise<any> {
  if (youtubeUrl && isYouTube(youtubeUrl)) {
    return { fileData: { fileUri: youtubeUrl.trim() } };
  }
  if (!file) throw new Error("ต้องแนบไฟล์คลิป หรือใส่ YouTube URL (public)");

  const buf = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || "video/mp4";

  if (buf.length < INLINE_LIMIT) {
    return { inlineData: { mimeType, data: buf.toString("base64") } };
  }
  // ไฟล์ใหญ่ → Files API + poll
  const tmp = path.join(os.tmpdir(), `clip-${Date.now()}-${file.name.replace(/[^\w.]/g, "_")}`);
  fs.writeFileSync(tmp, buf);
  try {
    let up = await ai.files.upload({ file: tmp, config: { mimeType } });
    while (up.state === "PROCESSING") {
      await new Promise((r) => setTimeout(r, 3000));
      up = await ai.files.get({ name: up.name! });
    }
    if (up.state === "FAILED") throw new Error("Gemini ประมวลผลไฟล์ไม่สำเร็จ");
    return { fileData: { fileUri: up.uri!, mimeType: up.mimeType! } };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ---------- app ----------
const app = new Hono();
app.use("/*", cors());

app.get("/", (c) => {
  const html = fs.readFileSync(path.join(__dir, "public", "index.html"), "utf-8");
  return c.html(html);
});

app.get("/health", (c) => c.json({ ok: true, model: MODEL, keySet: !!API_KEY }));

app.post("/api/extract", async (c) => {
  const t0 = Date.now();
  try {
    if (!API_KEY) return c.json({ error: "server ยังไม่ตั้ง GEMINI_API_KEY" }, 500);

    const body = await c.req.parseBody();
    const template = ((body.template as string) || "reels").trim();
    const youtubeUrl = (body.youtubeUrl as string) || undefined;
    const file = body.file as File | undefined;
    const prompt = TEMPLATES[template] || TEMPLATES.reels;

    const mediaPart = await buildMediaPart(file, youtubeUrl);

    const resp = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [mediaPart, { text: prompt }] }],
      config: { responseMimeType: "application/json", temperature: 0.4 },
    });

    const data = safeParse(resp.text ?? "");
    return c.json({ ok: true, template, seconds: ((Date.now() - t0) / 1000).toFixed(1), data });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 500);
  }
});

export { app };
export default { port: Number(process.env.PORT) || 3000, fetch: app.fetch };
