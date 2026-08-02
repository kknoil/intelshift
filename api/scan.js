// netlify/functions/scan.js
// ดึง CoinGecko + คำนวณ CDC/EMA/ATR ทั้งหมดบนเซิร์ฟเวอร์ แล้วส่งผลสำเร็จรูปกลับมือถือ
// มือถือยิงแค่ครั้งเดียว -> ไม่มีปัญหาจอดับ เน็ตหลุด หรือ Safari ตัดการเชื่อมต่อกลางคัน
//
// ตั้ง environment variable ชื่อ CG_KEY ใน Netlify (Site settings -> Environment variables)
// ห้ามใส่คีย์ตรงๆ ในไฟล์นี้ เพราะ repo เป็น public

const CG = 'https://api.coingecko.com/api/v3';
const KEY = process.env.CG_KEY || '';

// แคชในหน่วยความจำ อยู่ได้ตราบที่ instance ยังอุ่น
const cache = { markets: null, charts: new Map() };
const MARKETS_TTL = 5 * 60 * 1000;        // ราคาเปลี่ยนตลอด เก็บสั้น
const CHART_TTL = 6 * 3600 * 1000;        // แท่งรายวันเปลี่ยนวันละครั้ง เก็บยาวได้

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cgGet(path, tries = 3) {
  const url = CG + path;
  for (let t = 0; t < tries; t++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(url, {
        signal: ctrl.signal,
        headers: KEY ? { 'x-cg-demo-api-key': KEY } : {}
      });
      clearTimeout(timer);
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (t + 1)); continue; }
      return null;
    } catch (e) {
      if (t === tries - 1) return null;
      await sleep(1000 * (t + 1));
    }
  }
  return null;
}

async function getChart(id) {
  const hit = cache.charts.get(id);
  if (hit && Date.now() - hit.t < CHART_TTL) return hit.d;
  const d = await cgGet('/coins/' + id + '/market_chart?vs_currency=usd&days=365');
  if (d && d.prices && d.prices.length) {
    cache.charts.set(id, { t: Date.now(), d });
    return d;
  }
  return hit ? hit.d : null;   // ของเก่าดีกว่าไม่มีเลย
}

/* ---------- ตัวชี้วัด (ยกมาจาก index.html ให้ตรงกันเป๊ะ) ---------- */
// กรองจุดข้อมูลตัวสุดท้ายออก ถ้ายังไม่ใช่แท่ง Daily ที่ปิดจริง
// CoinGecko: จุดล่าสุดสุดจะเป็นราคาสดที่อัปเดตทุก 30 วินาที ไม่ใช่ราคาปิด
// ถ้าเอามาคำนวณ EMA/CDC ตรงๆ จะได้สัญญาณหลอกที่ยัง "ไม่ยืนยัน" จริง
// ขัดกับกฎเหล็ก "รอปิดแท่ง Daily ก่อนเข้า"
function filterConfirmedCloses(pricePairs) {
  if (!pricePairs || !pricePairs.length) return [];
  const DAY_MS = 86400000;
  const CONFIRM_BUFFER_MS = 10 * 60 * 1000; // CoinGecko ยืนยันแท่งที่ปิดแล้วหลังเที่ยงคืน UTC ~10 นาที
  const out = pricePairs.slice();
  const lastTs = out[out.length - 1][0];
  const alignedToMidnightUTC = (lastTs % DAY_MS) === 0;
  const enoughTimePassed = (Date.now() - lastTs) >= CONFIRM_BUFFER_MS;
  if (!(alignedToMidnightUTC && enoughTimePassed)) out.pop();
  return out;
}
function calcEMA(values, period) {
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = new Array(period - 1).fill(null);
  out.push(e);
  for (let i = period; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); }
  return out;
}

function cdcStatus(closes) {
  if (!closes || closes.length < 30) return null;
  const e12 = calcEMA(closes, 12), e26 = calcEMA(closes, 26);
  const n = closes.length - 1;
  const green = e12[n] > e26[n];
  let cross = -1;
  for (let i = n; i > 26; i--) {
    if ((e12[i] > e26[i]) !== (e12[i-1] > e26[i-1])) { cross = i; break; }
  }
  const barsSince = cross === -1 ? 999 : (n - cross);
  const gap = ((e12[n] - e26[n]) / e26[n]) * 100;
  let status;
  if (green && barsSince <= 3) status = 'FRESH_GREEN';
  else if (green && barsSince <= 8) status = 'GREEN';
  else if (green) status = 'OLD_GREEN';
  else if (!green && barsSince <= 3) status = 'FRESH_RED';
  else if (!green && gap > -1 && e12[n] > e12[n-2]) status = 'NEAR_CROSS';
  else status = 'RED';
  return { status, barsSince: barsSince === 999 ? null : barsSince, ema12: +e12[n].toFixed(6), ema26: +e26[n].toFixed(6), gap: +gap.toFixed(2) };
}

function calcATR(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  const seg = closes.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < seg.length; i++) sum += Math.abs(seg[i] - seg[i-1]);
  return (sum / period) * 1.15; // ลดจาก 1.4 — ของเดิมบวม SL/TP ไกลเกินจำเป็น
}

// หา swing high/low (pivot point) จริงจากราคาปิดย้อนหลัง — ใช้เป็นฐาน SL แทน EMA26
// pivot high = จุดที่ราคาสูงกว่าเพื่อนบ้านซ้าย-ขวา (สัญญาณว่าเคยมีแรงขายกลับตัวที่นี่)
// pivot low = จุดที่ราคาต่ำกว่าเพื่อนบ้านซ้าย-ขวา (สัญญาณว่าเคยมีแรงซื้อกลับตัวที่นี่)
function findSwingLevel(closes, isHigh, lookback, pivotWindow) {
  lookback = lookback || 30;
  pivotWindow = pivotWindow || 2;
  const n = closes.length - 1;
  const start = Math.max(pivotWindow, n - lookback);
  for (let i = n - pivotWindow; i >= start; i--) {
    let isPivot = true;
    for (let k = 1; k <= pivotWindow; k++) {
      if (isHigh) {
        if (!(closes[i] > closes[i - k] && closes[i] > closes[i + k])) { isPivot = false; break; }
      } else {
        if (!(closes[i] < closes[i - k] && closes[i] < closes[i + k])) { isPivot = false; break; }
      }
    }
    if (isPivot) return { level: closes[i], found: true, barsAgo: n - i };
  }
  // ไม่เจอ pivot ชัดเจน — ใช้จุดสูงสุด/ต่ำสุดในช่วง lookback แทน (เผื่อไว้)
  const seg = closes.slice(Math.max(0, n - lookback), n + 1);
  return { level: isHigh ? Math.max(...seg) : Math.min(...seg), found: false, barsAgo: null };
}

function buildLevels(price, atr, ema12, ema26, status, closes) {
  if (!atr || !price) return null;
  const short = (status === 'FRESH_RED' || status === 'RED');
  const s = short ? -1 : 1;
  const e1 = price - s * (0.3 * atr);
  const e2 = price + s * (0.5 * atr);
  const avg = (e1 + e2) / 2;

  // ฐาน SL: หา swing high/low จริงจากกราฟ (ถ้าข้อมูลพอ) แทน EMA26
  let swing = null;
  if (closes && closes.length >= 35) swing = findSwingLevel(closes, short, 30, 2);
  const structuralBuffer = swing ? 0.3 : 0.7; // swing จริงแล้วไม่ต้องกันเผื่อเยอะเท่า EMA (ซึ่งเป็นแค่ค่าเฉลี่ย)
  const structural = short
    ? Math.max(swing ? swing.level : Math.max(ema26, price), price) + structuralBuffer * atr
    : Math.min(swing ? swing.level : Math.min(ema26, price), price) - structuralBuffer * atr;

  const capped = avg - s * (2.0 * atr); // ลดจาก 2.5x
  const sl = short ? Math.min(structural, capped) : Math.max(structural, capped);
  const risk = Math.abs(avg - sl);
  const tp1 = avg + s * 1.8 * risk;

  // RR จริงของแต่ละไม้แยกกัน — ไม้ 1 กับไม้ 2 เข้าคนละราคา จึงมี RR ไม่เท่ากัน
  // ถ้าไม้ 1 ไม่โดน fill แล้วเข้าแต่ไม้ 2 อย่างเดียว RR รวมที่โฆษณาไว้ (1.8) จะไม่ตรงจริง
  const rrEntry1 = +(Math.abs(tp1 - e1) / Math.abs(sl - e1)).toFixed(2);
  const rrEntry2 = +(Math.abs(tp1 - e2) / Math.abs(sl - e2)).toFixed(2);
  const MIN_ACCEPTABLE_RR = 1.3;

  return {
    entry1: +e1.toPrecision(6), entry2: +e2.toPrecision(6), sl: +sl.toPrecision(6),
    tp1: +tp1.toPrecision(6), tp2: +(avg + s * 3.0 * risk).toPrecision(6),
    be: +avg.toPrecision(6), rr1: 1.8, rr2: 3.0,
    entry1_rr: rrEntry1, entry2_rr: rrEntry2,
    entry2_rr_warning: rrEntry2 < MIN_ACCEPTABLE_RR
      ? ('RR จริงของไม้ 2 เพียง ' + rrEntry2 + ':1 (ต่ำกว่าเกณฑ์ ' + MIN_ACCEPTABLE_RR + ') — ถ้าไม้ 1 ไม่โดน fill แล้วเข้าแต่ไม้ 2 อย่างเดียว ไม่คุ้มเสี่ยง')
      : null,
    sl_source: swing ? (swing.found ? 'swing_' + (short ? 'high' : 'low') + '_' + swing.barsAgo + 'd_ago' : 'range_extreme_fallback') : 'ema26_fallback',
    atr: +atr.toPrecision(4), atr_pct: +((atr / price) * 100).toFixed(2),
    direction: short ? 'SHORT' : 'LONG'
  };
}

function toWeeklyCloses(pricePairs) {
  if (!pricePairs || !pricePairs.length) return [];
  const weeks = new Map();
  for (const [ts, price] of pricePairs) {
    const d = new Date(ts);
    const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((tmp - yearStart) / 86400000 + 1) / 7);
    weeks.set(tmp.getUTCFullYear() + '-' + String(weekNo).padStart(2, '0'), price);
  }
  return Array.from(weeks.values());
}

function weeklyTrend(pricePairs) {
  const wk = toWeeklyCloses(pricePairs);
  if (wk.length < 40) return { status: 'INSUFFICIENT_DATA', weeks: wk.length };
  const e12 = calcEMA(wk, 12), e26 = calcEMA(wk, 26);
  const n = wk.length - 1;
  const status = e12[n] > e26[n] ? 'GREEN' : 'RED';
  const gap = +(((e12[n] - e26[n]) / e26[n]) * 100).toFixed(2);
  let barsSince = 0;
  for (let i = n; i >= 26; i--) { if ((e12[i] > e26[i]) === (status === 'GREEN')) barsSince = n - i; else break; }
  return { status, gap, barsSince };
}

const ATR_WATCH_THRESHOLD = 3.5; // % — ATR เกินนี้ถือว่าผันผวนสูงเกินไป ให้เฝ้าดูก่อน ไม่ใช่สัญญาณเข้าเต็มรูปแบบ

function classifyTrend(dailyStatus, wk, atrPct) {
  const dailyBull = dailyStatus === 'FRESH_GREEN' || dailyStatus === 'GREEN' || dailyStatus === 'NEAR_CROSS';
  let base;
  if (!wk || wk.status === 'INSUFFICIENT_DATA') base = { tag: 'UNKNOWN_TREND', sizeFactor: 0.5, note: 'ข้อมูล weekly ไม่พอ (เหรียญใหม่) — ไม้ครึ่งเดียว' };
  else if (dailyBull && wk.status === 'GREEN') base = { tag: 'WITH_TREND', sizeFactor: 1.0, note: 'Weekly เขียวด้วย (ยืนมา ' + wk.barsSince + ' สัปดาห์) — เทรนด์ใหญหนุน ถือตามแผนได้' };
  else if (dailyBull && wk.status === 'RED') base = { tag: 'COUNTER_TREND', sizeFactor: 0.5, note: 'Daily เขียวแต่ Weekly ยังแดง (gap ' + wk.gap + '%) — แค่เด้งสวนเทรนด์ใหญ่ ไม้ครึ่งเดียว TP ใกล้ลง ออกไว' };
  else if (dailyStatus === 'FRESH_RED' && wk.status === 'RED') base = { tag: 'WITH_TREND', sizeFactor: 1.0, note: 'Weekly แดงด้วย — Short สอดคล้องเทรนด์ใหญ่' };
  else if (dailyStatus === 'FRESH_RED' && wk.status === 'GREEN') base = { tag: 'COUNTER_TREND', sizeFactor: 0.5, note: 'Daily เพิงตัดลงแต่ Weekly ยังเขียว — Short สวนเทรนด์ใหญ่ ไม้ครึ่งเดียว ออกไว' };
  else base = { tag: 'NEUTRAL', sizeFactor: 1.0, note: '' };

  // ATR สูงเกินไป — ลด sizeFactor ลงอีกครึ่งหนึ่ง และติดป้ายเฝ้าดู ไม่ใช่สัญญาณเข้าเต็มรูปแบบ
  if (atrPct != null && atrPct > ATR_WATCH_THRESHOLD) {
    return {
      tag: 'HIGH_VOL_WATCH',
      sizeFactor: Math.min(base.sizeFactor, 0.5) * 0.5,
      watchOnly: true,
      note: 'ATR ' + atrPct.toFixed(2) + '% สูงเกิน ' + ATR_WATCH_THRESHOLD + '% — ผันผวนมากเกินไป จัดเป็นเฝ้าดูเท่านั้น ไม่ใช่สัญญาณเข้าเต็มรูปแบบ รอ ATR ลดลงก่อน'
    };
  }
  return base;
}

/* ---------- คัดเหรียญ (ตรรกะเดียวกับฝั่งมือถือ) ---------- */
const SKIP = ['usdt','usdc','dai','busd','tusd','usde','fdusd','wbtc','weth','wsteth','steth','cbbtc','reth','usds','pyusd','usdd','usdt0','bsc-usd','usd1','usdf','gho','frax','lusd','crvusd','usdx','susds'];

function pickCandidates(all) {
  const notStable = all.filter(c => !SKIP.includes((c.symbol || '').toLowerCase()));
  const inRange = c => { const d7 = c.price_change_percentage_7d_in_currency || 0; return d7 > -30 && d7 < 50; };
  const bigCaps = notStable.filter(c => (c.market_cap_rank || 999) <= 20).filter(inRange).slice(0, 6);
  const others = notStable
    .filter(c => (c.market_cap_rank || 999) > 20)
    .filter(c => {
      const d7 = c.price_change_percentage_7d_in_currency || 0;
      const move = Math.abs(c.price_change_percentage_24h_in_currency || 0) + Math.abs(d7);
      return inRange(c) && move > 3;
    })
    .sort((a, b) => (b.total_volume / b.market_cap) - (a.total_volume / a.market_cap))
    .slice(0, 8);
  return { universe: notStable.length, candidates: bigCaps.concat(others) };
}

/* ---------- ยิงหลายตัวพร้อมกันแบบจำกัดจำนวน ---------- */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = async function (req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    // 1) ตลาด
    let markets = cache.markets;
    if (!markets || Date.now() - markets.t > MARKETS_TTL) {
      const m = await cgGet('/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=150&page=1&price_change_percentage=24h%2C7d');
      if (!m || !Array.isArray(m)) {
        if (!markets) { res.status(200).json({ ok: false, error: 'ดึงข้อมูลตลาดจาก CoinGecko ไม่ได้' }); return; }
      } else {
        markets = { t: Date.now(), d: m };
        cache.markets = markets;
      }
    }
    const all = markets.d;
    const { universe, candidates } = pickCandidates(all);

    // 2) BTC + ทอง + เหรียญ ทั้งหมดพร้อมกัน (เซิร์ฟเวอร์ไม่มีปัญหาเน็ตหลุดแบบมือถือ)
    const [btcChart, goldChart] = await Promise.all([getChart('bitcoin'), getChart('pax-gold')]);

    let btc = null;
    if (btcChart) {
      const btcConfirmed = filterConfirmedCloses(btcChart.prices);
      const c = cdcStatus(btcConfirmed.map(p => p[1]));
      const w = weeklyTrend(btcConfirmed);
      if (c) { c.weekly = w ? w.status : null; btc = c; }
    }

    let gold = null;
    if (goldChart) {
      const goldRawCloses = goldChart.prices.map(p => p[1]);
      const goldConfirmed = filterConfirmedCloses(goldChart.prices);
      const closes = goldConfirmed.map(p => p[1]);
      const c = cdcStatus(closes);
      if (c) {
        const cur = +goldRawCloses[goldRawCloses.length - 1].toFixed(1); // ราคาสด ใช้แค่แสดงผล
        gold = {
          cur, cdc: c,
          weekly: weeklyTrend(goldConfirmed),
          levels: buildLevels(cur, calcATR(closes, 14), c.ema12, c.ema26, c.status, closes)
        };
      }
    }

    // 3) เหรียญผู้สมัคร — 4 ตัวพร้อมกัน
    const results = await mapLimit(candidates, 4, async (c) => {
      const chart = await getChart(c.id);
      if (!chart) return { id: c.id, failed: true };
      const confirmed = filterConfirmedCloses(chart.prices);
      const closes = confirmed.map(p => p[1]);
      const cdc = cdcStatus(closes);
      if (!cdc) return { id: c.id, noCdc: true };
      const wk = weeklyTrend(confirmed);
      const lv = buildLevels(c.current_price, calcATR(closes, 14), cdc.ema12, cdc.ema26, cdc.status, closes);
      const trend = classifyTrend(cdc.status, wk, lv ? lv.atr_pct : null);
      let volConfirm = null;
      try {
        const vols = (chart.total_volumes || []).map(v => v[1]);
        if (vols.length > 21) {
          const last = vols[vols.length - 1];
          const avg20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
          volConfirm = +(last / avg20).toFixed(2);
        }
      } catch (e) {}
      return {
        id: c.id,
        symbol: (c.symbol || '').toUpperCase(), name: c.name, rank: c.market_cap_rank,
        price: c.current_price, lastClose: closes[closes.length - 1],
        chg24h: +(c.price_change_percentage_24h_in_currency || 0).toFixed(2),
        chg7d: +(c.price_change_percentage_7d_in_currency || 0).toFixed(2),
        vol_mcap: +((c.total_volume / c.market_cap) * 100).toFixed(1),
        cdc, trend, plan: lv, vol_confirm: volConfirm,
        atr_pct: lv ? lv.atr_pct : null
      };
    });

    const coins = results.filter(r => r && !r.failed && !r.noCdc);
    const failed = results.filter(r => r && r.failed).length;
    const noCdc = results.filter(r => r && r.noCdc).length;

    res.status(200).json({
      ok: true, ts: Date.now(), build: 'b12-swing-structure',
      universe, shortlist: candidates.length,
      fetched: candidates.length - failed, failed, noCdc,
      btc, gold, coins
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
};
