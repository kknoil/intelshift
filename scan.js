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
  return (sum / period) * 1.4;
}

function buildLevels(price, atr, ema12, ema26, status) {
  if (!atr || !price) return null;
  const short = (status === 'FRESH_RED' || status === 'RED');
  const s = short ? -1 : 1;
  const e1 = price - s * (0.3 * atr);
  const e2 = price + s * (0.5 * atr);
  const avg = (e1 + e2) / 2;
  const structural = short ? Math.max(ema26, price) + 1.2 * atr : Math.min(ema26, price) - 1.2 * atr;
  const capped = avg - s * (2.5 * atr);
  const sl = short ? Math.min(structural, capped) : Math.max(structural, capped);
  const risk = Math.abs(avg - sl);
  return {
    entry1: +e1.toPrecision(6), entry2: +e2.toPrecision(6), sl: +sl.toPrecision(6),
    tp1: +(avg + s * 1.8 * risk).toPrecision(6), tp2: +(avg + s * 3.0 * risk).toPrecision(6),
    be: +avg.toPrecision(6), rr1: 1.8, rr2: 3.0,
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

function classifyTrend(dailyStatus, wk) {
  const dailyBull = dailyStatus === 'FRESH_GREEN' || dailyStatus === 'GREEN' || dailyStatus === 'NEAR_CROSS';
  if (!wk || wk.status === 'INSUFFICIENT_DATA') return { tag: 'UNKNOWN_TREND', sizeFactor: 0.5, note: 'ข้อมูล weekly ไม่พอ (เหรียญใหม่) — ไม้ครึ่งเดียว' };
  if (dailyBull && wk.status === 'GREEN') return { tag: 'WITH_TREND', sizeFactor: 1.0, note: 'Weekly เขียวด้วย (ยืนมา ' + wk.barsSince + ' สัปดาห์) — เทรนด์ใหญหนุน ถือตามแผนได้' };
  if (dailyBull && wk.status === 'RED') return { tag: 'COUNTER_TREND', sizeFactor: 0.5, note: 'Daily เขียวแต่ Weekly ยังแดง (gap ' + wk.gap + '%) — แค่เด้งสวนเทรนด์ใหญ่ ไม้ครึ่งเดียว TP ใกล้ลง ออกไว' };
  if (dailyStatus === 'FRESH_RED' && wk.status === 'RED') return { tag: 'WITH_TREND', sizeFactor: 1.0, note: 'Weekly แดงด้วย — Short สอดคล้องเทรนด์ใหญ่' };
  if (dailyStatus === 'FRESH_RED' && wk.status === 'GREEN') return { tag: 'COUNTER_TREND', sizeFactor: 0.5, note: 'Daily เพิงตัดลงแต่ Weekly ยังเขียว — Short สวนเทรนด์ใหญ่ ไม้ครึ่งเดียว ออกไว' };
  return { tag: 'NEUTRAL', sizeFactor: 1.0, note: '' };
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

exports.handler = async function () {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  };

  try {
    // 1) ตลาด
    let markets = cache.markets;
    if (!markets || Date.now() - markets.t > MARKETS_TTL) {
      const m = await cgGet('/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=150&page=1&price_change_percentage=24h%2C7d');
      if (!m || !Array.isArray(m)) {
        if (!markets) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'ดึงข้อมูลตลาดจาก CoinGecko ไม่ได้' }) };
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
      const c = cdcStatus(btcChart.prices.map(p => p[1]));
      const w = weeklyTrend(btcChart.prices);
      if (c) { c.weekly = w ? w.status : null; btc = c; }
    }

    let gold = null;
    if (goldChart) {
      const closes = goldChart.prices.map(p => p[1]);
      const c = cdcStatus(closes);
      if (c) {
        const cur = +closes[closes.length - 1].toFixed(1);
        gold = {
          cur, cdc: c,
          weekly: weeklyTrend(goldChart.prices),
          levels: buildLevels(cur, calcATR(closes, 14), c.ema12, c.ema26, c.status)
        };
      }
    }

    // 3) เหรียญผู้สมัคร — 4 ตัวพร้อมกัน
    const results = await mapLimit(candidates, 4, async (c) => {
      const chart = await getChart(c.id);
      if (!chart) return { id: c.id, failed: true };
      const closes = chart.prices.map(p => p[1]);
      const cdc = cdcStatus(closes);
      if (!cdc) return { id: c.id, noCdc: true };
      const wk = weeklyTrend(chart.prices);
      const trend = classifyTrend(cdc.status, wk);
      const lv = buildLevels(c.current_price, calcATR(closes, 14), cdc.ema12, cdc.ema26, cdc.status);
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

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ok: true, ts: Date.now(),
        universe, shortlist: candidates.length,
        fetched: candidates.length - failed, failed, noCdc,
        btc, gold, coins
      })
    };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: String(e && e.message || e) }) };
  }
};
