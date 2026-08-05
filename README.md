# Clip Lab — เว็บถอดข้อมูลจากคลิป (Touris Us) 🎬

ทีมอัปคลิป (หรือวาง YouTube URL) → ได้สรุป สถานที่ ไอเดียคอนเทนต์ จุดตัด Reel กลับมาเป็นข้อมูลพร้อมใช้
Key อยู่ฝั่ง server — **ทีมไม่ต้องมี API key และไม่ต้องลงอะไรบนเครื่อง** แค่เปิดเว็บ

Stack: Bun + Hono + Gemini Files API (แนวเดียวกับ DocFlow)

## รันในเครื่อง (ทดสอบ)

```bash
bun install
cp .env.example .env      # ใส่ GEMINI_API_KEY
bun run server.ts
# เปิด http://localhost:3000
```

## Deploy บน Render (แนะนำ — รองรับคลิปยาว ไม่ timeout)

1. push โฟลเดอร์นี้ขึ้น GitHub
2. Render → New → **Web Service** → เชื่อม repo
3. ตั้งค่า:
   - **Runtime:** เลือก Docker หรือใช้ Bun ผ่าน build/start command
   - **Build Command:** `bun install`
   - **Start Command:** `bun run server.ts`
   - (ถ้า Render ไม่มี Bun ในตัว → ใช้ Dockerfile ฐาน `oven/bun`)
4. **Environment** → เพิ่ม `GEMINI_API_KEY` (masked)
5. Deploy → ได้ URL เช่น `https://clip-lab.onrender.com`

> เว็บนี้เสิร์ฟทั้ง frontend + API จาก service เดียว — deploy ครั้งเดียวจบ
> อยากได้โดเมนสวย: ผูก `clip.zendbot.co` ผ่าน Custom Domain ได้ (แนวเดียวกับ docflow.zendbot.co)

### Dockerfile (ถ้า Render ต้องการ)
```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .
EXPOSE 3000
CMD ["bun","run","server.ts"]
```

## งานที่รองรับ (เลือกในหน้าเว็บ)

| โหมด | ใช้กับ | ได้อะไร |
|---|---|---|
| **Reels/โพสต์** | คลิปทริปของทัวริสอัส | hook + แคปชัน + สถานที่ + จุดตัด Reel |
| **ถอดเทคนิค** | โฆษณา/คลิปคู่แข่ง | เทคนิคเล่าเรื่อง + เอามาใช้กับทัวริสอัส |
| **คลิปยาว** | สัมมนา/บรีฟทริป/รีวิวยาว | หัวข้อ + ข้อมูลสำคัญ + FAQ + transcript |

## แจ้งเตือน (ไม่บังคับ)

ถอดเสร็จ ping Telegram + log เข้า Notion อัตโนมัติ — ตั้ง env แล้วทำงานเอง (ไม่ตั้ง = ปิดเงียบ):

**Telegram:**
- `TELEGRAM_BOT_TOKEN` — จาก @BotFather (หรือ bot เดิมของ HIVE)
- `TELEGRAM_CHAT_ID` — id กลุ่ม (เพิ่ม bot เข้ากลุ่ม แล้วดู id จาก getUpdates หรือ @userinfobot)

**Notion:**
- `NOTION_TOKEN` — จาก notion.so/my-integrations (สร้าง integration แล้ว **share หน้า Master Plan ให้ integration ด้วย**)
- `NOTION_PAGE_ID` — default = Master Plan อยู่แล้ว (ไม่ต้องตั้งก็ได้)

ทั้งคู่ยิงแบบ fire-and-forget — ถ้าล้มเหลวก็ไม่กระทบผลถอดคลิป

## หมายเหตุ

- ไฟล์ **<20MB** ส่ง inline / **>=20MB** อัปผ่าน Files API + poll อัตโนมัติ (คลิปยาวเป็นชั่วโมงก็ได้)
- YouTube URL ต้องเป็น **public**
- กฎกันแบรนด์อื่น (เช่น GOMO/ซิม) ฝังไว้ในโหมด Reels แล้ว
- ปรับ prompt/schema ได้ในตัวแปร `TEMPLATES` ใน `server.ts`
- ต่อ Telegram/Notion: เพิ่มใน endpoint `/api/extract` หลังได้ `data` (pattern เดียวกับ notify-booking)
