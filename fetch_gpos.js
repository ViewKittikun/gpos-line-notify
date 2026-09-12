/**
 * GPOS → LINE  (Nerd Cafe CNX)  — Path B-headless
 * ------------------------------------------------------------------
 * สเต็ปนี้ (v0.1) โฟกัส 2 อย่างที่ "เสี่ยงสุด" ให้ผ่านก่อน:
 *   1) login เข้า GPOS ผ่านหน้าเว็บจริง (ให้ SDK จัดการเข้ารหัส/token เอง)
 *   2) ดึง JSON ดิบของ 4 service ที่ต้องใช้ แล้ว dump ออกมาให้เห็นโครงสร้างจริง
 *
 * เมื่อ login + ดึงข้อมูลผ่านแล้ว เราจะเห็นหน้าตา JSON ครบ → สเต็ปถัดไปค่อยต่อ
 * "ประกอบข้อความ + ส่งเข้า LINE" จากข้อมูลจริง (โค้ดส่ง LINE เตรียมไว้ให้แล้วด้านล่าง
 * เปิดใช้ด้วย SEND_LINE=1)
 *
 * ค่าที่ต้องตั้ง (ผ่าน env / GitHub Secrets):
 *   GPOS_USER, GPOS_PASS                      (จำเป็น)
 *   LINE_CHANNEL_ACCESS_TOKEN, LINE_TO        (ใช้ตอนจะส่ง LINE)
 *   SEND_LINE=1                               (ตั้งเมื่อพร้อมส่งจริง)
 * ================================================================== */

const { chromium } = require('playwright');
const fs = require('fs');

const WEB   = 'https://gpos_web-1pq8t2.th.biot-apps.com';
const STORE = 'S002609058318048528';           // Nerd Cafe CNX
const TZ_OFFSET_MS = 7 * 3600 * 1000;           // Asia/Bangkok = UTC+7

const USER = process.env.GPOS_USER;
const PASS = process.env.GPOS_PASS;

// ปลายทางสมุดบัญชี Nerd Cafe (Apps Script web app) — ตั้งใน GitHub Secrets (repo นี้ public)
const LEDGER_URL   = process.env.LEDGER_URL || '';
const LEDGER_TOKEN = process.env.LEDGER_TOKEN || '';

// service ที่เราสนใจ (จะดักทั้ง request+response ตามชื่อนี้)
const SERVICES = [
  'querySalesItemReport',       // ยอดขายรายสินค้า = เมนูขายดี + ยอดรวม
  'queryBusinessTrendReport',   // ยอดขาย/กำไร รายวัน
  'queryAlertNum',              // จำนวนสินค้าใกล้หมด/หมดอายุ
  'queryInvSpuListManage'       // รายการสินค้า (แท็บแจ้งเตือนสต็อก = สต็อกต่ำ)
];

const captures = {};  // serviceName -> { request:{headers,body}, response:<json> }

function log(...a){ console.log('[gpos]', ...a); }

/** ช่วงเวลา "วันนี้" ตามเวลาไทย เป็น epoch ms */
function todayRangeBangkok() {
  const now = Date.now();
  const bkk = new Date(now + TZ_OFFSET_MS);
  const y = bkk.getUTCFullYear(), m = bkk.getUTCMonth(), d = bkk.getUTCDate();
  const startUtc = Date.UTC(y, m, d, 0, 0, 0) - TZ_OFFSET_MS;
  const endUtc   = Date.UTC(y, m, d, 23, 59, 59) - TZ_OFFSET_MS;
  return { startTime: startUtc, endTime: endUtc };
}

async function main() {
  if (!USER || !PASS) throw new Error('ต้องตั้ง env GPOS_USER และ GPOS_PASS');

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ locale: 'th-TH' });
  const page = await ctx.newPage();

  // ---- ดักทั้ง request และ response ของ service ที่สนใจ ----
  page.on('request', req => {
    const u = req.url();
    const svc = SERVICES.find(s => u.includes('serviceName=' + s));
    if (svc && req.method() === 'POST') {
      captures[svc] = captures[svc] || {};
      if (!captures[svc].request) {
        let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
        captures[svc].request = { headers: req.headers(), body };
      }
    }
  });
  page.on('response', async res => {
    const u = res.url();
    const svc = SERVICES.find(s => u.includes('serviceName=' + s));
    if (svc) {
      try {
        const j = await res.json();
        captures[svc] = captures[svc] || {};
        // เก็บอันที่ success ไว้ก่อน อย่าให้อันที่ error (เช่น storeId ว่าง) มาทับ
        if (j && j.success !== false) captures[svc].response = j;
        else if (!captures[svc].response) captures[svc].responseErr = j;
      } catch (_) {}
    }
  });

  try {
    // ---------- 1) LOGIN ----------
    log('เปิดหน้า login…');
    await page.goto(WEB + '/login', { waitUntil: 'networkidle', timeout: 60000 });

    // ช่องอีเมล (antd autocomplete) — คลิกแล้วพิมพ์
    const userInput = page.locator('input').first();
    await userInput.click();
    await userInput.fill(USER);

    // ช่องรหัสผ่าน
    await page.locator('input[type=password]').fill(PASS);

    // ติ๊กช่องยอมรับนโยบาย (เผื่อบังคับ) — ติ๊กทุก checkbox ที่ยังไม่ติ๊ก
    const boxes = page.locator('input[type=checkbox]');
    const n = await boxes.count();
    for (let i = 0; i < n; i++) {
      const b = boxes.nth(i);
      if (!(await b.isChecked())) { await b.check({ force: true }).catch(()=>{}); }
    }

    log('กดเข้าสู่ระบบ…');
    await page.getByText('เข้าสู่ระบบ', { exact: true }).click();

    // รอจนออกจากหน้า login (redirect เข้า dashboard)
    await page.waitForURL(u => !String(u).includes('/login'), { timeout: 30000 })
      .catch(async () => {
        await page.screenshot({ path: 'login_failed.png', fullPage: true });
        throw new Error('login ไม่สำเร็จ (ยังอยู่หน้า login) — ดู login_failed.png และตรวจ GPOS_USER/GPOS_PASS');
      });
    log('login สำเร็จ ✓  url =', page.url());

    // ---------- 1.5) เลือกร้าน (choose_institution) เพื่อให้มี store context ----------
    for (let attempt = 0; attempt < 3 && page.url().includes('choose_institution'); attempt++) {
      log('อยู่หน้าเลือกร้าน — คลิกเลือก Nerd… (รอบ ' + (attempt + 1) + ')');
      await page.waitForTimeout(1500);
      // คลิกการ์ด/ปุ่มที่มีคำว่า Nerd (แบรนด์ หรือ ร้าน)
      const clicked = await page.getByText(/Nerd/i).first().click({ timeout: 8000 }).then(() => true).catch(() => false);
      if (!clicked) { await page.screenshot({ path: 'choose_failed.png', fullPage: true }); break; }
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    log('store context พร้อม — url =', page.url());

    // ---------- 2) เยี่ยมหน้ารายงานเพื่อกระตุ้นให้ยิง API ----------
    log('เปิดหน้าสรุปยอดขายสินค้า…');
    await page.goto(WEB + '/branch/reports_sales_details', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2500);

    log('เปิดหน้าสต็อก…');
    await page.goto(WEB + '/branch/stock_inventory', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);
    // คลิกแท็บ "แจ้งเตือนสต็อก" เพื่อให้ยิงรายการสต็อกต่ำ + รอ response ของ queryInvSpuListManage
    try {
      const waitInv = page.waitForResponse(r => r.url().includes('queryInvSpuListManage'), { timeout: 15000 }).catch(()=>null);
      await page.getByText(/แจ้งเตือนสต็อก/).first().click({ timeout: 8000 });
      const r = await waitInv;
      if (r) { try { captures['queryInvSpuListManage'] = captures['queryInvSpuListManage'] || {}; captures['queryInvSpuListManage'].lowStock = await r.json(); } catch(_){} }
      await page.waitForTimeout(1500);
    } catch (e) { log('  (คลิกแท็บแจ้งเตือนสต็อกไม่ได้: ' + e.message + ')'); }

    log('เปิดหน้าสรุปยอดขายทั้งหมด…');
    await page.goto(WEB + '/branch/reports_business_overview', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2500);

    // ---------- 3) REPLAY รายงานยอดขายด้วยช่วง "วันนี้" ----------
    // ใช้ headers+envelope จริงที่ดักได้ (มี token ครบ) แล้วแก้แค่วันที่
    const range = todayRangeBangkok();
    log('ช่วงวันนี้ (ไทย):', new Date(range.startTime).toISOString(), '→', new Date(range.endTime).toISOString());

    async function replay(svc, patchBody) {
      const cap = captures[svc];
      if (!cap || !cap.request) { log('  (ข้าม replay ' + svc + ' — ยังไม่มี template)'); return null; }
      const env = JSON.parse(JSON.stringify(cap.request.body));
      if (env.httpData && env.httpData.body) Object.assign(env.httpData.body, patchBody);
      const resp = await ctx.request.post('https://api-th1.biot-apps.com/?serviceName=' + svc, {
        headers: cap.request.headers,
        data: env
      });
      let j = null; try { j = await resp.json(); } catch(_) {}
      captures[svc].todayResponse = j;
      return j;
    }

    await replay('querySalesItemReport', { startTime: range.startTime, endTime: range.endTime, storeId: STORE, pageNum: 1, pageSize: 500 });
    await replay('queryBusinessTrendReport', { startTime: range.startTime, endTime: range.endTime, storeId: STORE });
    // สต็อก: กันเหนียว replay ใส่ storeId (เผื่อ natural call ยังไม่มี store context)
    await replay('queryAlertNum', { storeId: STORE });
    // รายชื่อสินค้า: ดึงมาทั้งหมด (pageSize ใหญ่) แล้วค่อยกรองวัตถุดิบสต็อกต่ำเองฝั่งเรา
    // (server ไม่รับ filter สต็อกต่ำ — คืนทุกอย่างมาอยู่ดี)
    await replay('queryInvSpuListManage', { storeId: STORE, pageNum: 1, pageSize: 500 });

    // ---------- 4) DUMP ข้อมูลดิบให้เห็นโครงสร้างจริง ----------
    const dump = {};
    for (const s of SERVICES) {
      const c = captures[s] || {};
      dump[s] = {
        gotRequest:  !!c.request,
        gotResponse: !!c.response,
        response:      c.response,
        todayResponse: c.todayResponse,
        lowStock:      c.lowStock
      };
    }
    fs.writeFileSync('gpos_raw.json', JSON.stringify(dump, null, 2));
    // สรุปสั้น ๆ ว่าแต่ละ service ดักได้ไหม (พิมพ์ก่อน JSON ก้อนใหญ่ กันโดนตัด)
    console.log('\n==================== CAPTURED SUMMARY ====================');
    for (const s of SERVICES) {
      const c = captures[s] || {};
      console.log(`- ${s}: req=${!!c.request} resp=${!!c.response} today=${!!c.todayResponse} lowStock=${!!c.lowStock}`);
    }
    console.log('=========================================================\n');
    log('บันทึก gpos_raw.json แล้ว (ดูโครงสร้างเต็มใน artifact)');

    // ---------- 5) LINE — เฉพาะรอบสรุป (SEND_LINE=1, ยิงวันละครั้ง 16:41) ----------
    if (process.env.SEND_LINE === '1') {
      let msg = buildMessage(captures, range);
      const staffSection = await getStaffSection();  // Attendance API (ถ้าตั้งไว้)
      if (staffSection) msg += '\n' + staffSection;
      console.log('\n---------- ข้อความ LINE ----------\n' + msg + '\n----------------------------------\n');
      await sendLine(msg);
      log('ส่งเข้า LINE แล้ว ✓');
    } else {
      log('ข้าม LINE (SEND_LINE != 1)');
    }

    // ---------- 6) เขียนจำนวนสินค้าลง NerdDoc — เฉพาะรอบเปิดร้าน (WRITE_SHEET=1, ทุก 30 นาที 07:30–15:30) ----------
    if (process.env.WRITE_SHEET === '1') {
      await pushNerdFill(captures, range);
    } else {
      log('ข้ามเขียน NerdDoc (WRITE_SHEET != 1)');
    }

  } finally {
    await browser.close();
  }
}

/** ประกอบข้อความสรุป — ใช้ field จริงจาก JSON ที่ดักได้ */
function buildMessage(cap, range) {
  const baht = n => (Number(n || 0) / 1000).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dateLabel = new Date(range.startTime + TZ_OFFSET_MS).toISOString().slice(0, 10);
  let lines = ['📊 สรุปยอดขาย Nerd Cafe CNX', '📅 ' + dateLabel, ''];

  // ---- ยอดขายรวม + เมนูขายดี จาก querySalesItemReport ----
  const sales = (cap.querySalesItemReport && (cap.querySalesItemReport.todayResponse || cap.querySalesItemReport.response)) || null;
  const data = sales && sales.data;
  const list = (data && (data.list || data.salesReportModelList)) || [];
  if (Array.isArray(list) && list.length) {
    const items = list.map(it => ({
      name: it.itemTitle || '-',
      qty:  Number(it.sales || 0),
      amt:  Number((it.salesPrice && it.salesPrice.amount) || 0)
    }));
    // ยอดขายรวมของวัน: statisticalData → SALES_AMOUNT (ถ้าไม่มีค่อยรวมเอง)
    let total = 0;
    const stat = (data.statisticalData || []).find(s => s.key === 'SALES_AMOUNT');
    total = (stat && stat.value && stat.value.amount) || items.reduce((s, x) => s + x.amt, 0);

    lines.push('💰 ยอดขายรวม: ' + baht(total) + ' บาท');
    lines.push('🧾 จำนวนรายการสินค้า: ' + (data.total != null ? data.total : items.length));
    lines.push('');
    lines.push('🏆 เมนูขายดี:');
    items.sort((a, b) => b.qty - a.qty).slice(0, 5).forEach((x, i) => {
      lines.push(`${i + 1}. ${x.name}  ×${x.qty}  (${baht(x.amt)}฿)`);
    });

    // ---- นับแก้วเย็น / แก้วร้อน / แก้วฟรี จากรายการทั้งหมด ----
    // ฟรี = โปรโมชัน เมนูชื่อ "แก้วฟรี" (มีคำว่า "ฟรี") → นับแยกต่างหาก
    // ร้อน = มีคำว่า "ร้อน"
    // เย็น = "เย็น" / "ปั่น" / "โซดา" / "สมูทตี้" (ทั้งหมดใช้แก้วเย็น)
    // อาหาร (เค้ก/แซนวิช ฯลฯ) ไม่มีคีย์เวิร์ดพวกนี้ → ไม่ถูกนับ
    let hotCups = 0, coldCups = 0, freeCups = 0;
    items.forEach(x => {
      const nm = String(x.name || '');
      if (nm.indexOf('ฟรี') >= 0) freeCups += x.qty;
      else if (nm.indexOf('ร้อน') >= 0) hotCups += x.qty;
      else if (/เย็น|ปั่น|โซดา|สมูทตี้|สมูตตี้/.test(nm)) coldCups += x.qty;
    });
    lines.push('');
    lines.push('🥤 แก้วเย็น: ' + coldCups + ' แก้ว');
    lines.push('☕ แก้วร้อน: ' + hotCups + ' แก้ว');
    lines.push('🎁 แก้วฟรี: ' + freeCups + ' แก้ว');
  } else {
    lines.push('💰 วันนี้ยังไม่มียอดขาย');
  }

  // ---- วัตถุดิบที่ต้องสั่ง (กรองเฉพาะ productType=METERIAL ที่สต็อกต่ำ/หมด/ติดลบ) ----
  // เมนูเครื่องดื่ม/อาหาร (productType=SINGLE) ที่สต็อก 0 เป็นเรื่องปกติ → ไม่นับ
  const invCand = [
    cap.queryInvSpuListManage && cap.queryInvSpuListManage.lowStock,
    cap.queryInvSpuListManage && cap.queryInvSpuListManage.todayResponse,
    cap.queryInvSpuListManage && cap.queryInvSpuListManage.response
  ].find(a => a && a.success && a.data && (a.data.list || a.data.records));
  const invList = (invCand && (invCand.data.list || invCand.data.records)) || [];

  // สถานะสต็อกอยู่ใน skuList[0].stockStatus: FULL(พอ) / LOW(ต่ำ) / EMPTY(หมด=0) / NEGATIVE(ติดลบ)
  const RANK = { NEGATIVE: 0, EMPTY: 1, LOW: 2 };  // เรียงความเร่งด่วน (ติดลบ→หมด→ต่ำ)
  const mats = invList
    .filter(it => it && it.productType === 'METERIAL')
    .map(it => {
      const sku = (it.skuList && it.skuList[0]) || {};
      return { name: it.productName || '-', status: sku.stockStatus, stock: Number(it.stock != null ? it.stock : sku.stock) };
    })
    .filter(m => m.status in RANK)   // เอาเฉพาะ 3 สถานะที่ต้องสั่ง
    .sort((a, b) => (RANK[a.status] - RANK[b.status]) || (a.stock - b.stock));

  lines.push('');
  lines.push('⚠️ วัตถุดิบที่ต้องสั่ง: ' + mats.length + ' รายการ');
  const label = m => m.status === 'NEGATIVE' ? 'ติดลบ ' + m.stock
    : m.status === 'EMPTY' ? 'หมด'
    : 'เหลือ ' + m.stock;
  mats.slice(0, 10).forEach(m => lines.push('• ' + m.name + ' (' + label(m) + ')'));
  if (mats.length > 10) lines.push('…และอีก ' + (mats.length - 10) + ' รายการ (ดูทั้งหมดใน GPOS)');

  return lines.join('\n');
}

/** ดึงเวลาเข้า-ออกพนักงานวันนี้ จาก Attendance API (Apps Script) แล้วประกอบเป็นข้อความ */
async function getStaffSection() {
  const url = process.env.ATTENDANCE_API_URL;
  if (!url) return '';   // ยังไม่ตั้งค่า → ข้าม
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const j = await res.json();
    if (!j || !Array.isArray(j.staff) || j.staff.length === 0) {
      return '👥 พนักงานวันนี้:\n- ยังไม่มีข้อมูลการเข้างาน';
    }
    const lines = ['👥 พนักงานวันนี้ (' + j.count + ' คน):'];
    j.staff.forEach(s => {
      lines.push('- ' + s.name + ': ' + (s.inTime || '-') + ' - ' + (s.outTime || 'ยังไม่ออก'));
    });
    return lines.join('\n');
  } catch (e) {
    log('ดึงเวลาพนักงานไม่ได้:', e.message);
    return '👥 พนักงานวันนี้: (ดึงข้อมูลไม่ได้)';
  }
}

/** นับจำนวนสินค้าวันนี้ตามหมวด NerdDoc: {cold,hot,free,cake,sandwich} จาก querySalesItemReport
 *  เย็น = เย็น/ปั่น/โซดา/สมูทตี้ · ร้อน = ร้อน · ฟรี = ฟรี · แซนวิช/เค้ก = ตามชื่อ (ที่ไม่ใช่เครื่องดื่ม) */
function computeQuantities(cap) {
  const sales = (cap.querySalesItemReport && (cap.querySalesItemReport.todayResponse || cap.querySalesItemReport.response)) || null;
  const data = sales && sales.data;
  const list = (data && (data.list || data.salesReportModelList)) || [];
  const q = { cold: 0, hot: 0, free: 0, cake: 0, sandwich: 0 };
  if (!Array.isArray(list)) return q;
  list.forEach(it => {
    const nm = String(it.itemTitle || '');
    const qty = Number(it.sales || 0);
    if (nm.indexOf('ฟรี') >= 0) q.free += qty;
    else if (nm.indexOf('ร้อน') >= 0) q.hot += qty;
    else if (/เย็น|ปั่น|โซดา|สมูทตี้|สมูตตี้/.test(nm)) q.cold += qty;
    else if (nm.indexOf('แซนวิช') >= 0) q.sandwich += qty;
    else if (nm.indexOf('เค้ก') >= 0) q.cake += qty;
  });
  return q;
}

/** เขียนจำนวนสินค้าวันนี้ลง NerdDoc ผ่าน Apps Script (type=nerdfill) — แถวจำนวนเท่านั้น */
async function pushNerdFill(cap, range) {
  if (!LEDGER_URL || !LEDGER_TOKEN) { log('ข้ามเขียน NerdDoc — ยังไม่ตั้ง LEDGER_URL / LEDGER_TOKEN'); return; }
  try {
    const q = computeQuantities(cap);
    const date = new Date(range.startTime + TZ_OFFSET_MS).toISOString().slice(0, 10);
    const r = await fetch(LEDGER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: LEDGER_TOKEN, type: 'nerdfill', date: date, qty: q }),
      redirect: 'follow'
    });
    const t = await r.text().catch(() => '');
    log('เขียน NerdDoc:', r.status, '| date', date, '| qty', JSON.stringify(q), '| resp', String(t).slice(0, 120));
  } catch (e) { log('เขียน NerdDoc ไม่ได้:', e.message); }
}

/** ส่งข้อความเข้า LINE ผ่าน Messaging API (push ทีละผู้รับ) */
async function sendLine(text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const to = (process.env.LINE_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!token || to.length === 0) { log('ข้ามส่ง LINE — ยังไม่ตั้ง LINE_CHANNEL_ACCESS_TOKEN / LINE_TO'); return; }
  for (const uid of to) {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ to: uid, messages: [{ type: 'text', text }] })
    });
    if (!r.ok) log('LINE push error สำหรับ ' + uid + ':', r.status, await r.text());
  }
}

main().catch(err => { console.error('[gpos] ERROR:', err); process.exit(1); });
