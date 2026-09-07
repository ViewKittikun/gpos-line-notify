# GPOS → LINE สรุปยอดขาย (Nerd Cafe CNX)

ดึงสรุปยอดขาย / เมนูขายดี / สต็อกต่ำ จากหลังบ้าน GPOS แล้วส่งเข้า LINE
รันบน **GitHub Actions** (คลาวด์ ฟรี — ไม่ต้องเปิดคอม)

ใช้วิธี **headless browser (Playwright)** login ผ่านหน้าเว็บ GPOS จริง เพื่อให้
SDK ของ GPOS จัดการเข้ารหัสรหัสผ่าน + token ให้เอง (ไม่ต้องถอดลอจิกเข้ารหัส)

---

## ทำเป็น 2 สเต็ป

### สเต็ป 1 — ให้ login + ดึงข้อมูลผ่านก่อน (ยังไม่ส่ง LINE)
1. สร้าง repo ใหม่ (เช่น `gpos-line-notify`) แล้วอัปโหลดไฟล์ทั้งหมดนี้ขึ้นไป
2. ไปที่ **Settings → Secrets and variables → Actions → New repository secret** เพิ่ม:
   - `GPOS_USER` = อีเมล login GPOS
   - `GPOS_PASS` = รหัสผ่าน GPOS
3. ไปแท็บ **Actions → "GPOS → LINE สรุปยอดขาย" → Run workflow** (กดรันเอง)
4. เปิด log ดูว่าขึ้น `login สำเร็จ ✓` และมี **RAW DUMP** ของข้อมูล
   - โหลดไฟล์ `gpos-debug` (artifact) มาดู `gpos_raw.json` = โครงสร้าง JSON จริง
   - ถ้า login ไม่ผ่าน จะมี `login_failed.png` ให้ดูว่าติดตรงไหน

➡️ เอา `gpos_raw.json` (หรือข้อความ log) กลับมาให้ปรับ parser ให้ตรงเป๊ะ

### สเต็ป 2 — เปิดส่ง LINE จริง
1. เพิ่ม secret:
   - `LINE_CHANNEL_ACCESS_TOKEN` = channel access token ของ LINE OA (`@002kuwgr`)
   - `LINE_TO` = LINE user id ผู้รับ (คั่นด้วย `,` ได้หลายคน)
2. แก้ `.github/workflows/gpos-line.yml` บรรทัด `SEND_LINE: '0'` → `'1'`
3. เวลาส่งอัตโนมัติตั้งไว้ที่ **22:00 น. ไทย** (แก้ที่ `cron` ได้)

---

## รันในเครื่อง (ถ้าอยากทดสอบเอง)
```bash
npm install
npx playwright install chromium
GPOS_USER='...' GPOS_PASS='...' npm start
```

## ไฟล์
- `fetch_gpos.js` — login + ดึง 4 service + ประกอบข้อความ + ส่ง LINE
- `.github/workflows/gpos-line.yml` — ตั้งเวลารันบนคลาวด์
- `package.json` — dependency (playwright)

## หมายเหตุความปลอดภัย
- รหัสผ่าน/​token เก็บใน **GitHub Secrets** เท่านั้น ไม่อยู่ในโค้ด
- แนะนำให้ repo เป็น **private**
