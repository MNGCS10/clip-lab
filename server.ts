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

// ตัดช่องว่าง/เครื่องหมายคำพูดที่ติดมาตอนวางค่าใน Render
const API_KEY = (process.env.GEMINI_API_KEY || "").trim().replace(/^["']|["']$/g, "") || undefined;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const KEY_FORMAT_OK = !!API_KEY && /^AIza[\w-]{30,}$/.test(API_KEY);
if (!API_KEY) console.error("⚠️  ไม่พบ GEMINI_API_KEY — ตั้งใน env ก่อน");
else if (API_KEY.startsWith("AQ.")) console.error("⚠️  GEMINI_API_KEY ขึ้นต้น AQ. — key ชนิดใหม่ของ AI Studio ตอนนี้หลายคนโดน 401 ACCESS_TOKEN_TYPE_UNSUPPORTED แนะนำใช้ key ขึ้นต้น AIza (สร้างจาก Google Cloud Console → Credentials)");
else if (!KEY_FORMAT_OK) console.error("⚠️  GEMINI_API_KEY รูปแบบไม่ปกติ — ตรวจที่ Render → Environment");

// แปลง error ของ Gemini เป็นข้อความไทยอ่านง่าย (ข้อความดิบเก็บไว้ใน log)
function friendlyError(e: any): string {
  const raw = String(e?.message || e);
  if (/API key not valid|ACCESS_TOKEN_TYPE_UNSUPPORTED|UNAUTHENTICATED|"code":\s*401/i.test(raw))
    return "GEMINI_API_KEY ไม่ถูกต้องหรือหมดอายุ — ตรวจที่ Render → clip-lab → Environment (ถ้า key ขึ้นต้น AQ. ซึ่งเป็นชนิดใหม่ของ AI Studio ให้ลอง key ขึ้นต้น AIza จาก Google Cloud Console → Credentials แทน)";
  if (/PERMISSION_DENIED|"code":\s*403/i.test(raw))
    return "key นี้ไม่มีสิทธิ์ใช้ Gemini API หรือถูกจำกัดการใช้งาน — เช็กที่ Google AI Studio";
  if (/prepayment credits|credits are depleted|"code":\s*402/i.test(raw))
    return "เครดิต Gemini ของ project นี้หมด (prepay = 0) — เติมเครดิต/ผูกบัญชีชำระเงินที่ ai.studio/projects หรือเปลี่ยนไปใช้ key ของ project ที่เป็น Free tier";
  if (/RESOURCE_EXHAUSTED|"code":\s*429/i.test(raw))
    return "โควต้า Gemini เต็มชั่วคราว — รอสักครู่แล้วลองใหม่";
  return raw;
}

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

  // XRAY — ผ่าคลิปคู่แข่ง เห็นโครงสร้าง แล้วเอามาปรับใช้ (ไม่ก๊อป)
  xray: `คุณคือนักวิเคราะห์คอนเทนต์วิดีโอสั้น ดูคลิปนี้ (ภาพ+เสียง) แล้วผ่าโครงสร้างให้ทีมทัวริสอัสเรียนรู้ ตอบเป็น JSON ภาษาไทยเท่านั้น
กติกาสำคัญ:
- ทุกข้อสรุปต้องอิงสิ่งที่เห็น/ได้ยินในคลิปจริง ใส่ไว้ใน "observed"
- สิ่งที่เดา (เช่น ทำไมอัลกอริทึมดัน, ยอดวิว, เบื้องหลังการผลิต) ให้ใส่ใน "guessed" แยกต่างหาก ห้ามปนกัน
- คุณมองไม่เห็นยอดวิว/ไลก์/คอมเมนต์ ห้ามอ้างตัวเลขเหล่านั้น
{
  "clip_info": {"duration": "MM:SS โดยประมาณ", "format": "talking head / b-roll / การ์ตูน / อื่นๆ", "language": "ภาษาในคลิป"},
  "summary": "คลิปนี้เล่าอะไร 2-3 ประโยค",
  "hook": "สิ่งที่เกิดขึ้นใน 0-3 วินาทีแรก (ประโยค/ภาพ/เสียง)",
  "hook_type": "คำถาม | ตัวเลข | ขัดความคาดหวัง | ปัญหา | ภาพช็อต | อื่นๆ",
  "hook_score": 1,
  "hook_reason": "ทำไมให้คะแนนนี้ (1-5)",
  "story_structure": [{"time": "MM:SS", "beat": "เปิด/ปม/จุดพีค/ปิด + เกิดอะไรขึ้น"}],
  "editing_rhythm": "จังหวะตัดต่อ: จำนวนคัตต่อ 10 วินาที, ซับ, เสียง, เพลง",
  "psychology_triggers": [{"trigger": "ความอยากรู้ | FOMO | ความเป็นตัวตน | ความขำ | ประโยชน์ทันที | อื่นๆ", "evidence": "เห็นตรงไหนในคลิป (timestamp)"}],
  "open_loop": "มีการเปิดคำถามค้างไว้แล้วค่อยเฉลยไหม ตรงไหน",
  "cta": "CTA คืออะไร พูด/โชว์ตอนไหน (ถ้าไม่มีให้ตอบว่าไม่มี)",
  "funnel_path": "คนดูถูกพาไปต่อทางไหน (ลิงก์/แชท/ไลน์/เพจ) ถ้าเห็นในคลิป",
  "observed": ["ข้อเท็จจริงที่เห็น/ได้ยินจริง พร้อม timestamp"],
  "guessed": ["ข้อสันนิษฐาน (ระบุว่าเป็นการเดา)"],
  "why_it_works": "สรุปว่าทำไมน่าจะโดน โดยอ้างเฉพาะข้อใน observed",
  "hook_ideas": ["hook 3 แบบสำหรับคลิปทริปของทัวริสอัส ในโทนน้องทัวร์ + ยายอัส (เขียนใหม่ ไม่ลอกประโยคต้นฉบับ)"],
  "apply_to_tourisus": ["เก็บโครงสร้างอะไรไปใช้ได้ 3-5 ข้อ"],
  "do_not_copy": ["สิ่งที่ห้ามเอาตรงๆ: เสียง ภาพ สคริปต์ตัวละคร ชื่อแบรนด์ของคลิปต้นฉบับ"],
  "test_plan": "ทดลอง 1 ไอเดีย → 1 คลิป → วัดผล 48 ชม. โดยดูตัวชี้วัดไหน"
}
บริบท: ${TOURISUS} ใช้คลิปนี้เพื่อเรียนรู้โครงสร้างเท่านั้น ไม่ใช่เพื่อทำซ้ำเนื้อหา
${ANTI_BRAND}`,
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

// ---------- notify (optional — ปิดเงียบถ้าไม่ตั้ง env) ----------
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID || "39275f48-0e52-81f9-bf01-e1b20ce22619";
const NOTION_VERSION = process.env.NOTION_VERSION || "2022-06-28";

const TPL_LABEL: Record<string, string> = { reels: "Reels/โพสต์", teardown: "ถอดเทคนิค", longextract: "คลิปยาว", xray: "XRAY" };
const htmlEsc = (s: any) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
const chunk = (s: string, n = 1900) => { const o: string[] = []; for (let i = 0; i < s.length; i += n) o.push(s.slice(i, i + n)); return o; };

async function notifyTelegram(data: any, template: string, source: string, seconds: string) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    const locs = Array.isArray(data.locations_shown) ? data.locations_shown.slice(0, 5).join(", ") : "";
    const hook = Array.isArray(data.hook_ideas) && data.hook_ideas[0] ? String(data.hook_ideas[0]) : "";
    const xrayHook = data.hook ? `${htmlEsc(String(data.hook).slice(0, 160))}${data.hook_score ? ` (hook ${htmlEsc(data.hook_score)}/5)` : ""}` : "";
    const lines = [
      `🎬 <b>Clip Lab</b> — ถอดเสร็จ (${TPL_LABEL[template] || template})`,
      source ? `📎 ${htmlEsc(source)}` : "",
      data.summary ? `\n📝 ${htmlEsc(String(data.summary).slice(0, 400))}` : "",
      locs ? `\n📍 ${htmlEsc(locs)}` : "",
      template === "xray" && xrayHook ? `\n🎯 ${xrayHook}` : "",
      template === "xray" && data.cta ? `\n📣 CTA: ${htmlEsc(String(data.cta).slice(0, 160))}` : "",
      hook ? `\n💡 ${htmlEsc(hook.slice(0, 200))}` : "",
      `\n⏱ ${seconds}s`,
    ].filter(Boolean);
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text: lines.join("\n"), parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (e) { console.error("telegram notify error:", e); }
}

async function logToNotion(data: any, template: string, source: string, seconds: string) {
  if (!NOTION_TOKEN) { console.log("notion: NOTION_TOKEN ไม่ได้ตั้ง — ข้าม"); return; }
  try {
    console.log("notion: กำลัง log เข้า", NOTION_PAGE_ID);
    const now = new Date().toISOString().replace("T", " ").slice(0, 16);
    const codeRich = chunk(JSON.stringify(data, null, 2)).map((t) => ({ type: "text", text: { content: t } }));
    const children: any[] = [
      { object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: `🎬 Clip Lab — ${TPL_LABEL[template] || template} · ${now} · ${seconds}s` } }] } },
    ];
    if (source) children.push({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: `📎 ${source}` } }] } });
    if (data.summary) children.push({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: String(data.summary).slice(0, 1900) } }] } });
    children.push({ object: "block", type: "code", code: { language: "json", rich_text: codeRich } });

    const res = await fetch(`https://api.notion.com/v1/blocks/${NOTION_PAGE_ID}/children`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${NOTION_TOKEN}`, "Content-Type": "application/json", "Notion-Version": NOTION_VERSION },
      body: JSON.stringify({ children }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`notion log FAILED: HTTP ${res.status} — ${body.slice(0, 600)}`);
    } else {
      console.log("notion: log สำเร็จ ✅");
    }
  } catch (e) { console.error("notion log error (network):", e); }
}

// ---------- app ----------
const app = new Hono();
app.use("/*", cors());

app.get("/", (c) => {
  const html = fs.readFileSync(path.join(__dir, "public", "index.html"), "utf-8");
  return c.html(html);
});

app.get("/health", (c) => c.json({ ok: true, model: MODEL, keySet: !!API_KEY, keyFormatOk: KEY_FORMAT_OK }));

app.post("/api/extract", async (c) => {
  const t0 = Date.now();
  try {
    if (!API_KEY) return c.json({ error: "server ยังไม่ตั้ง GEMINI_API_KEY — ตั้งที่ Render → Environment" }, 500);

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
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    const source = youtubeUrl ? youtubeUrl : file ? file.name : "";

    // ยิงแจ้งเตือนแบบ fire-and-forget (ไม่บล็อกการตอบ user)
    void notifyTelegram(data, template, source, seconds);
    void logToNotion(data, template, source, seconds);

    return c.json({ ok: true, template, seconds, data });
  } catch (e: any) {
    console.error("extract error:", e?.message || e);
    return c.json({ error: friendlyError(e) }, 500);
  }
});

export { app };
export default { port: Number(process.env.PORT) || 3000, fetch: app.fetch };
