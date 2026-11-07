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
  'queryInvSpuListManage',      // รายการสินค้า (แท็บแจ้งเตือนสต็อก = สต็อกต่ำ)
  'queryStoreSalesSettledDetailReport', // รายการบิล (วิธีชำระเงินต่อบิล, ส่วนลดต่อบิล) — หน้า สรุปยอดขายตามใบเสร็จ
  'queryStoreOrderSettledInfo'          // รายละเอียดบิล (สินค้าในบิล + ส่วนลดต่อบรรทัด) → นับแก้วฟรี
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

    // หน้าสรุปยอดขายตามใบเสร็จ → ดักแม่แบบ request ของรายการบิล + รายละเอียดบิล (ใช้ตอนเขียน NerdDoc 2027)
    if (process.env.WRITE_SHEET === '1') {
      log('เปิดหน้าสรุปยอดขายตามใบเสร็จ…');
      await page.goto(WEB + '/branch/reports_sales_statistics', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(2500);
      try {
        const waitDet = page.waitForResponse(r => r.url().includes('queryStoreOrderSettledInfo'), { timeout: 15000 }).catch(() => null);
        await page.getByText('รายละเอียด', { exact: true }).first().click({ timeout: 4000 });
        await waitDet;
        await page.keyboard.press('Escape').catch(() => {});
      } catch (e) { log('  (เปิดรายละเอียดบิลไม่ได้: ' + e.message + ')'); }
    }

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

    // ---------- 3.1) ดึงย้อนหลังทีละวัน (BACKFILL_FROM..BACKFILL_TO) → NerdDoc 2027 แล้วจบ ----------
    if (process.env.BACKFILL_FROM) {
      const from = process.env.BACKFILL_FROM, to = process.env.BACKFILL_TO || from;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('BACKFILL_FROM/TO ต้องเป็น YYYY-MM-DD');
      const rangeFor = d => { const [y, m, dd] = d.split('-').map(Number);
        return { startTime: Date.UTC(y, m - 1, dd, 0, 0, 0) - TZ_OFFSET_MS, endTime: Date.UTC(y, m - 1, dd, 23, 59, 59) - TZ_OFFSET_MS }; };
      const next = d => new Date(Date.UTC(...d.split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v))) + 864e5).toISOString().slice(0, 10);
      let done = 0, empty = 0, fail = 0;
      for (let d = from; d <= to; d = next(d)) {
        try {
          const r = rangeFor(d);
          await replay('querySalesItemReport', { startTime: r.startTime, endTime: r.endTime, storeId: STORE, pageNum: 1, pageSize: 500 });
          const n = await collectNerd27(ctx, r);
          if (!n.bills) { empty++; log('ย้อนหลัง ' + d + ': ไม่มีบิลใน GPOS — ข้าม'); continue; }
          delete n.catalog;                      // ไม่ต้องอัปเดตรายการเมนูทุกวัน
          await pushNerd27(n); done++;
          log('ย้อนหลัง ' + d + ': ' + n.bills + ' บิล ✓');
        } catch (e) { fail++; log('ย้อนหลัง ' + d + ' ไม่สำเร็จ:', e.message); }
      }
      log('ดึงย้อนหลังเสร็จ: เขียน ' + done + ' วัน · ไม่มีบิล ' + empty + ' วัน · ไม่สำเร็จ ' + fail + ' วัน');
      return;
    }

    // ---------- 3.5) บิลของวันนี้ + รายละเอียดบิลที่มีส่วนลด (NerdDoc 2027) ----------
    let nerd27 = null;
    if (process.env.WRITE_SHEET === '1' || process.env.SEND_LINE === '1') {
      try { nerd27 = await collectNerd27(ctx, range); }
      catch (e) { log('เก็บข้อมูล NerdDoc 2027 ไม่ได้:', e.message); }
    }

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
    dump.nerd27 = nerd27;
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
      let msg;
      try { msg = await buildMessage27(ctx, captures, range, nerd27); }
      catch (e) { log('สร้างข้อความแบบใหม่ไม่ได้ — ใช้แบบเดิม:', e.message); msg = buildMessage(captures, range, nerd27); }
      const staffSection = await getStaffSection(true);  // Attendance API (ถ้าตั้งไว้)
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
      if (nerd27) await pushNerd27(nerd27);
    } else {
      log('ข้ามเขียน NerdDoc (WRITE_SHEET != 1)');
    }

  } finally {
    await browser.close();
  }
}

/** ประกอบข้อความสรุป — ใช้ field จริงจาก JSON ที่ดักได้ */
function buildMessage(cap, range, n27) {
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
    // แก้วฟรีจริง = บรรทัดในบิลที่ลดเต็มราคา (นับรวมอยู่ในแก้วเย็น/ร้อนแล้ว — แสดงไว้ให้รู้เฉย ๆ)
    if (n27 && n27.gpos) freeCups = n27.gpos.free;
    lines.push('🎁 แก้วฟรี: ' + freeCups + ' แก้ว' + (n27 && n27.freeItems && n27.freeItems.length ? ' (' + n27.freeItems.join(', ') + ')' : ''));
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
  if (!invCand) {
    lines.push('');
    lines.push('⚠️ วัตถุดิบที่ต้องสั่ง: (ดึงข้อมูลสต็อกไม่ได้ — เช็คใน GPOS)');
    return lines.join('\n');
  }

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

/** ดึงเวลาเข้า-ออกพนักงานวันนี้ จาก Attendance API (Apps Script) แล้วประกอบเป็นข้อความ
 *  + แสดง 🔴 สาย X นาที ถ้าเข้าหลัง 08:00:00 (ปัดนาทีขึ้น) — กติกาเดียวกับชีท */
const ATT_LATE_CUTOFF = '08:00:00';

function normTime(s) {
  s = String(s == null ? '' : s).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!m) return s;
  let h = parseInt(m[1], 10);
  const ap = (m[4] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return String(h).padStart(2, '0') + ':' + m[2] + ':' + (m[3] || '00');
}

function lateMinutes(inTime) {
  const t = normTime(inTime);
  if (!/^\d{2}:\d{2}:\d{2}$/.test(t)) return 0;
  const sec = x => { const p = x.split(':').map(Number); return p[0] * 3600 + p[1] * 60 + p[2]; };
  const diff = sec(t) - sec(ATT_LATE_CUTOFF);
  return diff > 0 ? Math.ceil(diff / 60) : 0;
}

async function getStaffSection(compact) {
  const url = process.env.ATTENDANCE_API_URL;
  if (!url) return '';   // ยังไม่ตั้งค่า → ข้าม
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const j = await res.json();
    if (!j || !Array.isArray(j.staff) || j.staff.length === 0) {
      return '👥 พนักงานวันนี้:\n- ยังไม่มีข้อมูลการเข้างาน';
    }
    const lines = ['👥 พนักงานวันนี้ (' + j.count + ' คน)'];
    const hm = t => compact ? String(t).slice(0, 5) : t;
    j.staff.forEach(s => {
      const inT  = s.inTime  ? hm(normTime(s.inTime))  : '-';
      const outT = s.outTime ? hm(normTime(s.outTime)) : 'ยังไม่ออก';
      const late = lateMinutes(s.inTime);
      lines.push((compact ? '   ' : '- ') + s.name + ' ' + inT + '–' + outT + (late > 0 ? ' 🔴 สาย ' + late + ' นาที' : ''));
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

/* ======================= NerdDoc 2027 (ขั้น 2) ======================= */

// แก้ค่าใน body ของ request แม่แบบ (เดินทุกชั้น): ช่วงเวลา / หน้า / storeId / orderId
function patchBody(obj, f) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) patchBody(v, f);
    else { const nv = f(k, v); if (nv !== undefined) obj[k] = nv; }
  }
}

// ยิง service ซ้ำด้วย headers + envelope จริงที่ดักได้ (มี token ครบ) แล้วแก้ค่าใน body ตาม patcher
// body เริ่มต้นของ service ที่หน้าเว็บอาจไม่ได้ยิงให้ดัก (CI เลือกร้านไม่ได้ → หน้ารายงานบิลไม่โหลด)
// รูปแบบดูจากหน้าเว็บจริง (พ.ย. 2026)
const DEFAULT_BODY = {
  queryStoreSalesSettledDetailReport: { startTime: 0, endTime: 0, startHour: -1, endHour: -1, pageSize: 200, pageNum: 1, storeId: STORE },
  queryStoreOrderSettledInfo: { orderId: '', storeId: STORE }
};

// ถ้าไม่มีแม่แบบของ service นี้ → สร้างจากแม่แบบของ querySalesItemReport (envelope/headers/token ชุดเดียวกัน แค่เปลี่ยนชื่อ service)
function templateFor(svc) {
  const cap = captures[svc];
  if (cap && cap.request && cap.request.body) return { headers: cap.request.headers, body: JSON.parse(JSON.stringify(cap.request.body)) };
  const base = captures.querySalesItemReport;
  if (!base || !base.request || !base.request.body || !DEFAULT_BODY[svc]) throw new Error('ไม่มีแม่แบบ request ของ ' + svc);
  const swap = x => JSON.parse(JSON.stringify(x).split('querySalesItemReport').join(svc));
  const body = swap(base.request.body);
  if (body.httpData) body.httpData.body = JSON.parse(JSON.stringify(DEFAULT_BODY[svc]));
  const headers = swap(base.request.headers);
  return { headers, body };
}

async function replayWith(ctx, svc, patcher) {
  const t = templateFor(svc), env = t.body;
  patchBody(env.httpData && env.httpData.body ? env.httpData.body : env, patcher);
  const resp = await ctx.request.post('https://api-th1.biot-apps.com/?serviceName=' + svc, { headers: t.headers, data: env });
  const j = await resp.json();
  if (j && j.success === false) log('  ' + svc + ' ตอบ error:', JSON.stringify(j).slice(0, 200));
  return j;
}

const amt = x => Number(x && typeof x === 'object' ? x.amount : x || 0) / 1000;   // GPOS เก็บเงินเป็น 1/1000 บาท
const r2  = n => Math.round(n * 100) / 100;
const LMS_RE = /line\s*man|lineman|shopee|ไลน์แมน|ช้อปปี้/i;

async function collectNerd27(ctx, range) {
  // 1) รายการบิลทั้งหมดของวัน (แบ่งหน้า)
  const bills = [];
  for (let pg = 1; pg <= 10; pg++) {
    const j = await replayWith(ctx, 'queryStoreSalesSettledDetailReport', (k, v) => {
      const isT = /^\d{12,}$/.test(String(v));   // epoch ms เท่านั้น (ไม่แตะ startHour/endHour = -1)
      if (/^(start|begin)/i.test(k) && (isT || v === 0)) return typeof v === 'string' ? String(range.startTime) : range.startTime;
      if (/^end/i.test(k) && (isT || v === 0)) return typeof v === 'string' ? String(range.endTime) : range.endTime;
      if (/pageSize/i.test(k)) return 200;
      if (/pageNum|^current$|^page$/i.test(k)) return pg;
      if (k === 'storeId') return STORE;
    });
    const list = (j && j.data && (j.data.list || j.data.records)) || [];
    bills.push(...list);
    if (list.length < 200) break;
  }
  log('NerdDoc 2027: บิลวันนี้', bills.length, 'ใบ');

  // 2) เงินแยกวิธีชำระ (จาก payMethodInfo ของแต่ละบิล)
  const money = { cash: 0, pp: 0, tr: 0, grab: 0, other: 0, grabN: 0, lms: 0, lmsN: 0 };
  const lmsBills = [];
  bills.forEach(b => {
    const pays = (b.payMethodInfo && b.payMethodInfo.length) ? b.payMethodInfo : [{ payMethodName: b.payMethodName, amount: b.realAmount || b.amount }];
    // LINE MAN / Shopee: กดจ่ายด้วยปุ่ม "LINE MAN · Shopee" ใน GPOS (เริ่ม 5 พ.ย. 2026) ราคาเป็นราคาในแอป
    if (pays.some(p => LMS_RE.test(String(p.payMethodName || '')))) {
      money.lmsN++; money.lms += pays.reduce((s, p) => s + amt(p.amount), 0); lmsBills.push(b); return;
    }
    const isGrab = /grab/i.test(String(b.platform || '') + ' ' + String(b.subPlatform || '') + ' ' + pays.map(p => p.payMethodName).join(' '));
    if (isGrab) {
      // Grab: ใช้ยอดขายที่ไม่รวมค่าจัดส่ง ให้ตรงกับ Grab Merchant (GPOS บวกค่าจัดส่งเล็กน้อยไว้ในบางบิล)
      money.grabN++;
      // ยอดที่ Grab จ่าย (payMethodInfo) − ค่าจัดส่ง = ยอดขายสุทธิใน Grab Merchant
      // (amount/realAmount ของบิลหักส่วนลดโปรโมชันไปแล้ว → ต่ำกว่า Grab Merchant)
      money.grab += Math.max(0, pays.reduce((s, p) => s + amt(p.amount), 0) - amt(b.deliveryFee));
      return;
    }
    pays.forEach(p => {
      const n = String(p.payMethodName || '').toLowerCase(), a = amt(p.amount);
      if (n.includes('cash') || n.includes('เงินสด')) money.cash += a;
      else if (n.includes('promptpay') || n.includes('พร้อมเพย์')) money.pp += a;
      else if (n.includes('โอน')) money.tr += a;
      else if (n.includes('grab')) money.grab += a;
      else money.other += a;
    });
  });
  Object.keys(money).forEach(k => { if (k !== 'grabN' && k !== 'lmsN') money[k] = r2(money[k]); });

  // 3) แก้วฟรี (เฉพาะบิลหน้าร้าน) — เปิดดูทุกบิลที่จ่ายจริงน้อยกว่าราคาเต็ม (ส่วนลด/คูปอง/โปร) แล้วนับบรรทัดที่
  //    (ก) จ่ายจริงเป็น 0 ทั้งที่ราคาเต็ม > 0  หรือ  (ข) ส่วนลด = ราคาเต็มพอดี (เป็นจำนวนเต็มแก้ว)
  let free = 0; const freeItems = [];
  const DBG = !!process.env.BACKFILL_FROM || process.env.DEBUG_FREE === '1';
  const pick = o => { const x = {}; Object.keys(o || {}).forEach(k => { const v = o[k];
    if (/amount|disc|coupon|promo|voucher|price|real|pay|free|gift/i.test(k) && (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v))) && Number(v) !== 0) x[k] = v; }); return x; };
  const promoKeys = b => Object.keys(b).some(k => /coupon|promo|voucher|gift/i.test(k) && Number(b[k]) > 0);
  const discBills = bills.filter(b => {
    const pays = (b.payMethodInfo || []).map(p => p.payMethodName).join(' ');
    if (/grab/i.test(String(b.platform || '') + ' ' + String(b.subPlatform || '') + ' ' + pays) || LMS_RE.test(pays)) return false;
    const paid = (b.payMethodInfo && b.payMethodInfo.length) ? b.payMethodInfo.reduce((t, p) => t + amt(p.amount), 0) : amt(b.realAmount);
    return amt(b.discountAmount) > 0 || amt(b.realAmount) < amt(b.amount) - 0.009 || paid < amt(b.amount) - 0.009 || promoKeys(b);
  });
  for (const b of discBills) {
    try {
      const j = await replayWith(ctx, 'queryStoreOrderSettledInfo', (k) => { if (/orderId/i.test(k)) return b.orderId; });
      const lines = (j && j.data && j.data.orderDetail) || [];
      if (DBG) log('  [ตรวจแก้วฟรี] บิล', b.orderId, JSON.stringify(pick(b)), '| ระดับบิล(detail):', JSON.stringify(pick(j && j.data)));
      lines.forEach(l => {
        if (l.isRefund) return;
        const unit = amt(l.price), disc = amt(l.discountAmount), q = Number(l.quantity || 0);
        const hasActual = l.actualAmount !== undefined && l.actualAmount !== null && l.actualAmount !== '';
        const actual = hasActual ? amt(l.actualAmount) : null;
        let n = 0;
        if (unit > 0 && hasActual && actual <= 0.009) n = q;                                                      // (ก) ราคาเป็น 0 / คูปองหักเต็ม
        else if (unit > 0 && disc > 0 && Math.abs(disc / unit - Math.round(disc / unit)) < 1e-6) n = Math.min(q, Math.round(disc / unit));   // (ข)
        if (DBG) log('    - ' + (l.orderDetailName || l.spuName) + ' ' + (l.skuName || '') + ' ×' + q, JSON.stringify(pick(l)), n ? '→ ฟรี ' + n : '');
        if (n > 0) { free += n; freeItems.push((l.orderDetailName || l.spuName) + ' ×' + n); }
      });
    } catch (e) { log('  อ่านรายละเอียดบิล ' + b.orderId + ' ไม่ได้:', e.message); }
  }

  // 4) จำนวนแก้ว/อาหาร + ยอดรายเมนู จาก querySalesItemReport (รายงานรายสินค้าของวันนี้)
  const sales = captures.querySalesItemReport && captures.querySalesItemReport.todayResponse;
  const list = (sales && sales.data && (sales.data.list || sales.data.salesReportModelList)) || [];
  const c = { cold: 0, hot: 0, cake: 0, sandwich: 0, toast: 0, wrap: 0, salad: 0 };
  const menu = [];
  list.forEach(it => {
    const nm = String(it.itemTitle || ''), q = Number(it.sales || 0);
    if (/ร้อน/.test(nm)) c.hot += q;
    else if (/เย็น|ปั่น|โซดา|สมูทตี้|สมูตตี้/.test(nm)) c.cold += q;
    else if (/แซนวิช|sandwich/i.test(nm)) c.sandwich += q;
    else if (/โทส|toast/i.test(nm)) c.toast += q;
    else if (/แรป|wrap/i.test(nm)) c.wrap += q;
    else if (/สลัด|salad/i.test(nm)) c.salad += q;
    else if (/เค้ก|cake|บราวนี่|brownie/i.test(nm)) c.cake += q;
    const pf = String(it.platform || '').toUpperCase();
    menu.push({ ch: pf.includes('GRAB') ? 'Grab' : (pf === 'POS' || !pf ? 'หน้าร้าน' : pf), name: nm, qty: q, amt: r2(amt(it.salesPrice)) });
  });
  // ย้ายเมนูของบิล LINE MAN/Shopee ออกจาก "หน้าร้าน" ไปเป็นช่องทางของตัวเอง (รายงานรายสินค้าของ GPOS รวมไว้เป็น POS)
  if (lmsBills.length) {
    const lm = {};
    for (const b of lmsBills) {
      try {
        const j = await replayWith(ctx, 'queryStoreOrderSettledInfo', (k) => { if (/orderId/i.test(k)) return b.orderId; });
        ((j && j.data && j.data.orderDetail) || []).forEach(l => {
          if (l.isRefund) return;
          const nm = String(l.orderDetailName || l.spuName || ''), q = Number(l.quantity || 0);
          const a = (l.actualAmount !== undefined && l.actualAmount !== null && l.actualAmount !== '') ? amt(l.actualAmount) : amt(l.price) * q;
          if (!lm[nm]) lm[nm] = { qty: 0, amt: 0 }; lm[nm].qty += q; lm[nm].amt += a;
        });
      } catch (e) { log('  อ่านบิล LINE MAN/Shopee ' + b.orderId + ' ไม่ได้:', e.message); }
    }
    Object.keys(lm).forEach(nm => {
      const st = menu.find(m => m.ch === 'หน้าร้าน' && m.name === nm);
      if (st) { const ratio = st.qty ? Math.min(1, lm[nm].qty / st.qty) : 0; st.amt = r2(st.amt * (1 - ratio)); st.qty = Math.max(0, st.qty - lm[nm].qty); }
      menu.push({ ch: 'LINE MAN/Shopee', name: nm, qty: lm[nm].qty, amt: r2(lm[nm].amt) });
    });
    for (let i = menu.length - 1; i >= 0; i--) if (!menu[i].qty) menu.splice(i, 1);
    log('NerdDoc 2027: LINE MAN/Shopee ใน GPOS', lmsBills.length, 'บิล =', r2(money.lms), '·', Object.keys(lm).map(n => n + ' ×' + lm[n].qty).join(', '));
  }

  // 5) รายชื่อเมนูทั้งหมดใน GPOS (ไว้หาเมนูที่ไม่เคยขาย) — จากรายการสินค้า ไม่เอาวัตถุดิบ (METERIAL)
  const invC = [captures.queryInvSpuListManage && captures.queryInvSpuListManage.todayResponse,
                captures.queryInvSpuListManage && captures.queryInvSpuListManage.response]
    .find(a => a && a.data && (a.data.list || a.data.records));
  const catalog = invC ? [...new Set((invC.data.list || invC.data.records)
    .filter(it => it && it.productName && it.productType !== 'METERIAL').map(it => String(it.productName).trim()))] : [];

  const date = new Date(range.startTime + TZ_OFFSET_MS).toISOString().slice(0, 10);
  const out = { date, gpos: Object.assign({}, money, c, { free }), menu, catalog, freeItems, bills: bills.length };
  log('NerdDoc 2027:', JSON.stringify(out.gpos), '| ฟรี:', freeItems.join(', ') || '-');
  return out;
}

async function pushNerd27(d) {
  if (!LEDGER_URL || !LEDGER_TOKEN) { log('ข้าม NerdDoc 2027 — ยังไม่ตั้ง LEDGER_URL / LEDGER_TOKEN'); return; }
  try {
    const r = await fetch(LEDGER_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
      body: JSON.stringify({ token: LEDGER_TOKEN, type: 'nerd27', date: d.date, gpos: d.gpos, menu: d.menu, catalog: d.catalog })
    });
    const t = await r.text().catch(() => '');
    log('เขียน NerdDoc 2027:', r.status, '| resp', String(t).slice(0, 160));
  } catch (e) { log('เขียน NerdDoc 2027 ไม่ได้:', e.message); }
}

/* ======================= ข้อความสรุป LINE แบบใหม่ (พ.ย. 2026) ======================= */
async function fetchSummary27(date) {
  if (!LEDGER_URL || !LEDGER_TOKEN) return null;
  try {
    const r = await fetch(LEDGER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
      body: JSON.stringify({ token: LEDGER_TOKEN, type: 'summary27', date }) });
    const j = await r.json();
    return j && j.ok ? j.data : null;
  } catch (e) { log('ดึงข้อมูลปิดยอดไม่ได้:', e.message); return null; }
}

// ยอดขายรวมจากรายการบิล (วิธีเดียวกับยอดวันนี้: payMethodInfo − ค่าจัดส่ง Grab) — ใช้เทียบกับวันเดียวกันสัปดาห์ก่อน
function billsTotal(bills) {
  let t = 0;
  bills.forEach(b => {
    const pays = (b.payMethodInfo && b.payMethodInfo.length) ? b.payMethodInfo : [{ payMethodName: b.payMethodName, amount: b.realAmount || b.amount }];
    const s = pays.reduce((x, p) => x + amt(p.amount), 0);
    const isGrab = /grab/i.test(String(b.platform || '') + ' ' + String(b.subPlatform || '') + ' ' + pays.map(p => p.payMethodName).join(' '));
    t += isGrab ? Math.max(0, s - amt(b.deliveryFee)) : s;
  });
  return r2(t);
}
async function gposSalesFor(ctx, start, end) {
  const bills = [];
  for (let pg = 1; pg <= 10; pg++) {
    const j = await replayWith(ctx, 'queryStoreSalesSettledDetailReport', (k, v) => {
      const isT = /^\d{12,}$/.test(String(v));
      if (/^(start|begin)/i.test(k) && (isT || v === 0)) return typeof v === 'string' ? String(start) : start;
      if (/^end/i.test(k) && (isT || v === 0)) return typeof v === 'string' ? String(end) : end;
      if (/pageSize/i.test(k)) return 200;
      if (/pageNum|^current$|^page$/i.test(k)) return pg;
      if (k === 'storeId') return STORE;
    });
    const list = (j && j.data && (j.data.list || j.data.records)) || [];
    bills.push(...list);
    if (list.length < 200) break;
  }
  const t = billsTotal(bills);
  log('ยอดสัปดาห์ก่อน (วันเดียวกัน):', bills.length, 'บิล =', t);
  return bills.length ? t : null;
}

async function buildMessage27(ctx, cap, range, n27) {
  const B = n => Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
  const N = v => (v === '' || v === null || v === undefined) ? null : Number(v);
  const LINE = '━━━━━━━━━━━━━━';
  const date = new Date(range.startTime + TZ_OFFSET_MS).toISOString().slice(0, 10);
  const dt = new Date(range.startTime + TZ_OFFSET_MS);
  const DOW = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'], MON = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const sales = cap.querySalesItemReport && (cap.querySalesItemReport.todayResponse || cap.querySalesItemReport.response);
  const sdata = sales && sales.data;
  const stat = ((sdata && sdata.statisticalData) || []).find(x => x.key === 'SALES_AMOUNT');
  const gposTotal = stat ? amt(stat.value) : 0;
  const g = (n27 && n27.gpos) || {};
  const sum = await fetchSummary27(date);
  const sv = (sum && sum.saved) || null;
  const lm = sv ? N(sv.lmSale) || 0 : 0, sp = sv ? N(sv.spSale) || 0 : 0;
  const gLms = Number(g.lms || 0);                               // ออเดอร์ LINE MAN/Shopee ที่อยู่ใน GPOS แล้ว (เริ่ม 5 พ.ย. 2026)
  const total = gLms > 0 ? gposTotal : gposTotal + lm + sp;      // มีใน GPOS แล้ว → ไม่บวกยอดที่น้องกรอกซ้ำ

  // เรื่องที่ต้องดู (รวมไว้บล็อกเดียวด้านบน)
  const alerts = [];
  let closeLine = '';
  if (sv) {
    closeLine = '✅ ปิดยอดแล้ว ' + String(sv.savedAt || '').slice(11) + (sv.staff ? ' (' + sv.staff + ')' : '');
    const diff = (label, real, sys) => {
      if (real === null || sys === null || isNaN(real) || isNaN(sys)) return alerts.push(label + 'ยังไม่ได้เช็ค');
      const d = Math.round((real - sys) * 100) / 100;
      if (d !== 0) alerts.push(label + (d > 0 ? 'เกิน ' : 'ขาด ') + B(Math.abs(d)) + ' บาท');
    };
    diff('เงินสด', N(sv.cashCount), n27 ? g.cash : null);
    diff('เงินโอน', N(sv.trReal) === null ? null : N(sv.trReal) - (N(sv.grabTP) || 0), n27 ? (g.pp || 0) + (g.tr || 0) : null);
    if (gLms > 0 && Math.abs(gLms - (lm + sp)) >= 1)
      alerts.push('LINE MAN/Shopee ใน GPOS ' + B(gLms) + ' ≠ น้องกรอก ' + B(lm + sp));
  } else alerts.push('ยังไม่ปิดยอด');

  const oos = (sum && sum.oos) || [];
  if (oos.length) alerts.push('น้องแจ้งของหมด ' + oos.length + ' อย่าง: ' + oos.slice(0, 10).join(', ') + (oos.length > 10 ? ' …+' + (oos.length - 10) : ''));
  const invCand = [cap.queryInvSpuListManage && cap.queryInvSpuListManage.todayResponse, cap.queryInvSpuListManage && cap.queryInvSpuListManage.response]
    .find(a => a && a.success && a.data && (a.data.list || a.data.records));
  let stockOk = false;
  if (invCand) {
    const mats = (invCand.data.list || invCand.data.records).filter(it => it && it.productType === 'METERIAL').map(it => {
      const sku = (it.skuList && it.skuList[0]) || {};
      return { name: it.productName || '-', status: sku.stockStatus, stock: Number(it.stock != null ? it.stock : sku.stock) };
    });
    const need = mats.filter(m => m.status === 'LOW' || m.status === 'EMPTY').sort((a, b) => a.stock - b.stock);
    const neg = mats.filter(m => m.status === 'NEGATIVE').sort((a, b) => a.stock - b.stock);
    const more = (arr) => arr.length > 8 ? ' …+' + (arr.length - 8) : '';
    if (need.length) alerts.push('ต้องสั่ง: ' + need.slice(0, 8).map(m => m.name + (m.status === 'EMPTY' ? ' (หมด)' : ' (เหลือ ' + m.stock + ')')).join(', ') + more(need));
    if (neg.length) alerts.push('สต็อกติดลบ ควรนับใหม่: ' + neg.slice(0, 8).map(m => m.name + ' (' + m.stock + ')').join(', ') + more(neg));
    stockOk = !need.length && !neg.length;
  }

  const L = ['📊 Nerd Cafe CNX · ' + DOW[dt.getUTCDay()] + ' ' + dt.getUTCDate() + ' ' + MON[dt.getUTCMonth()]];

  // 1) ยอดขาย (เด่นสุด)
  L.push(LINE);
  L.push('💰 ยอดขาย  ' + B(total) + ' บาท');
  L.push(LINE);
  const sub = [];
  if (n27) sub.push(n27.bills + ' บิล');
  if (gLms > 0) sub.push('รวม LINE MAN/Shopee ' + B(gLms) + ' (' + (g.lmsN || 0) + ')');
  else if (lm || sp) sub.push('GPOS ' + B(gposTotal) + ' + LINE MAN/Shopee ' + B(lm + sp));
  if (sub.length) L.push(sub.join(' · '));
  const cmp = [];
  if (sum && sum.goal) cmp.push(total >= sum.goal ? '🎯 ถึงเป้า ฿' + B(sum.goal) : '🎯 ต่ำกว่าเป้า ฿' + B(sum.goal - total));
  try {
    const wk = 7 * 864e5, prev = await gposSalesFor(ctx, range.startTime - wk, range.endTime - wk);
    if (prev) {
      const p = Math.round((gposTotal - prev) / prev * 100);
      cmp.push((p > 0 ? '📈 ↑ ' : p < 0 ? '📉 ↓ ' : '➖ ') + Math.abs(p) + '% จาก ' + DOW[dt.getUTCDay()] + ' ที่แล้ว (' + B(prev) + ')');
    }
  } catch (e) { log('เทียบสัปดาห์ก่อนไม่ได้:', e.message); }
  cmp.forEach(c => L.push(c));

  // 2) สถานะ: ถ้ามีเรื่องต้องดู ขึ้นบล็อก 🔴 ชัดๆ / ถ้าเรียบร้อยทั้งหมด ขึ้นบรรทัดเดียว
  L.push('');
  if (alerts.length) {
    L.push('🔴 ต้องดู ' + alerts.length + ' เรื่อง');
    alerts.forEach(a => L.push('   ▸ ' + a));
    if (closeLine) L.push(closeLine);
  } else {
    L.push(closeLine + ' 👍');
    L.push('   เงินสดตรง · เงินโอนตรง' + (stockOk ? ' · วัตถุดิบพอ' : ''));
  }

  // 3) รายละเอียด
  L.push(LINE);
  if (n27) {
    L.push('💳 เงินสด ' + B(g.cash) + ' · โอน ' + B((g.pp || 0) + (g.tr || 0)) + ' · Grab ' + B(g.grab) + ' (' + (g.grabN || 0) + ')');
    L.push('   LINE MAN ' + (sv ? B(lm) + ' (' + (N(sv.lmN) || 0) + ')' : '—') + ' · Shopee ' + (sv ? B(sp) + ' (' + (N(sv.spN) || 0) + ')' : '—'));
  }

  const ex = (sum && sum.expenses) || [];
  if (ex.length) {
    const CAT = { drink: '🥤', sandwich: '🥪', cake: '🍰' };
    L.push('');
    L.push('🧾 รายจ่ายวันนี้ ฿' + B(ex.reduce((a, x) => a + Number(x.amount || 0), 0)));
    ex.slice(0, 6).forEach(x => L.push('   • ' + (CAT[x.category] || '•') + ' ' + B(x.amount) + (x.note ? ' — ' + x.note : '') + (x.receipt ? ' 🧾' : '')));
  }

  const map = (sum && sum.menuMap) || {};
  const canon = n => map[n] !== undefined ? map[n] : String(n).replace(/\s*-\s*(เย็น|ร้อน|ปั่น)$/, '');
  const agg = {};
  (n27 ? n27.menu : []).forEach(m => { const c = canon(m.name); if (!c || c === '-') return; agg[c] = (agg[c] || 0) + Number(m.qty || 0); });
  const top = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 5);
  L.push('');
  if (top.length) {
    L.push('🏆 ขายดี');
    top.forEach(([k, v], i) => L.push('   ' + (i + 1) + '. ' + k + ' ' + v));
  }
  if (n27) L.push('🥤 เย็น ' + (g.cold || 0) + ' · ☕ ร้อน ' + (g.hot || 0) + ' · 🎁 ฟรี ' + (g.free || 0) + ' (รวม ' + ((g.cold || 0) + (g.hot || 0)) + ' แก้ว)');
  return L.join('\n');
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
