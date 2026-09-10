import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";

const ROOT = process.cwd();
const OUT_PATH = path.join(ROOT, "latest.json");

const LOOKBACK = {
  FSC_REPORT: 14,
  FSS_REPORT: 14,
  FIU_REPORT: 14,
  FIU_NOTICE: 14,
  FIU_SANCTIONS: 7,
};

const URLS = {
  FSC_REPORT: "https://www.fsc.go.kr/no010101",
  FSS_REPORT: "https://www.fss.or.kr/fss/bbs/B0000188/list.do?menuNo=200218",

  FIU_REPORT:
    "https://www.kofiu.go.kr/cmn/board/selectBoardListFile.do?selScope=&subSech=&size=20&page=1&seCd=0001&ntcnYardOrdrNo=",
  FIU_NOTICE:
    "https://www.kofiu.go.kr/cmn/board/selectBoardListFile.do?ntcnYardOrdrNo=&page=1&seCd=0007&selScope=&size=20&subSech=",
  FIU_SANCTIONS:
    "https://www.kofiu.go.kr/cmn/board/selectBoardListFile.do?ntcnYardOrdrNo=&page=1&seCd=0022&selScope=&size=20&subSech="
};

const VIEW_URLS = {
  FIU_REPORT: (id) =>
    `https://www.kofiu.go.kr/kor/notification/report_view.do?ntcnYardOrdrNo=${id}&seCd=0001`,
  FIU_NOTICE: (id) =>
    `https://www.kofiu.go.kr/kor/notification/notice_view.do?ntcnYardOrdrNo=${id}&seCd=0007`,
  FIU_SANCTIONS: (id) =>
    `https://www.kofiu.go.kr/kor/notification/sanctions_view.do?ntcnYardOrdrNo=${id}&seCd=0022`,
};

const FULL_LIST_URL = "https://github.com/ythan327/fiu-monitor-feed";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

async function main() {
  const prev = await readPrevFeed();

  const browser = await chromium.launch({ headless: true });
  try {
    const results = await Promise.allSettled([
      collectFsc(browser),
      collectFss(browser),
      collectFiuReport(),
      collectFiuNotice(),
      collectFiuSanctions(),
    ]);

    const sourceStates = {};
    const allItems = [];

    applyResult(results[0], "FSC", "금융위", sourceStates, allItems);
    applyResult(results[1], "FSS", "금감원", sourceStates, allItems);
    applyResult(results[2], "FIU_REPORT", "FIU 보도자료", sourceStates, allItems);
    applyResult(results[3], "FIU_NOTICE", "FIU 공지사항", sourceStates, allItems);
    applyResult(results[4], "FIU_SANCTIONS", "FIU 제재공시", sourceStates, allItems);

    const deduped = dedupeItems(allItems).sort((a, b) => {
      return Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0);
    });

    if (!deduped.length) {
      throw new Error("수집 결과가 0건입니다. latest.json을 덮어쓰지 않기 위해 중단합니다.");
    }

    const prevIds = new Set((prev.items || []).map((x) => String(x.id)));
    let newCount = 0;
    for (const item of deduped) {
      item.isNew = !prevIds.has(String(item.id));
      if (item.isNew) newCount++;
    }

    const overall = Object.values(sourceStates).every((s) => s.status === "ok")
      ? "ok"
      : Object.values(sourceStates).some((s) => s.status === "ok")
      ? "partial"
      : "stale";

    const feed = {
      schemaVersion: 1,
      generatedAt: nowIsoKst(),
      fullListURL: FULL_LIST_URL,
      status: {
        overall,
        sources: sourceStates,
      },
      counts: {
        newSinceLastFeed: newCount,
        totalVisible: deduped.length,
      },
      items: deduped,
    };

    await fs.writeFile(OUT_PATH, JSON.stringify(feed, null, 2), "utf8");
    console.log(`latest.json updated: ${deduped.length} items / new ${newCount}`);
  } finally {
    await browser.close();
  }
}

function applyResult(result, key, label, sourceStates, allItems) {
  if (result.status === "fulfilled") {
    const items = result.value || [];
    sourceStates[key] = {
      status: "ok",
      label,
      lastSuccessAt: nowIsoKst(),
      itemCount: items.length,
    };
    allItems.push(...items);
  } else {
    sourceStates[key] = {
      status: "error",
      label,
      lastAttemptAt: nowIsoKst(),
      message: String(result.reason?.message || result.reason || "unknown error"),
    };
    console.error(`[${key}] failed:`, result.reason);
  }
}

async function readPrevFeed() {
  try {
    const txt = await fs.readFile(OUT_PATH, "utf8");
    const json = JSON.parse(txt);
    return json && typeof json === "object" ? json : { items: [] };
  } catch {
    return { items: [] };
  }
}

async function collectFiuReport() {
  return await collectFiuBoard({
    apiUrl: URLS.FIU_REPORT,
    viewUrl: VIEW_URLS.FIU_REPORT,
    source: "FIU",
    sourceLabel: "FIU",
    category: "REPORT",
    categoryLabel: "보도자료",
    lookbackDays: LOOKBACK.FIU_REPORT,
  });
}

async function collectFiuNotice() {
  return await collectFiuBoard({
    apiUrl: URLS.FIU_NOTICE,
    viewUrl: VIEW_URLS.FIU_NOTICE,
    source: "FIU",
    sourceLabel: "FIU",
    category: "NOTICE",
    categoryLabel: "공지사항",
    lookbackDays: LOOKBACK.FIU_NOTICE,
  });
}

async function collectFiuSanctions() {
  return await collectFiuBoard({
    apiUrl: URLS.FIU_SANCTIONS,
    viewUrl: VIEW_URLS.FIU_SANCTIONS,
    source: "FIU",
    sourceLabel: "FIU",
    category: "SANCTIONS",
    categoryLabel: "제재공시",
    lookbackDays: LOOKBACK.FIU_SANCTIONS,
  });
}

async function collectFiuBoard({
  apiUrl,
  viewUrl,
  source,
  sourceLabel,
  category,
  categoryLabel,
  lookbackDays,
}) {
  const data = await fetchJson(apiUrl);
  const rows = Array.isArray(data?.result) ? data.result : [];
  const out = [];

  for (const row of rows) {
    const id = String(row.ntcnYardOrdrNo || "").trim();
    if (!id) continue;

    const rawDate = normalizeFiuDate(row);
    const publishedAt = toIsoKst(rawDate);
    if (!publishedAt) continue;
    if (!withinLookback(publishedAt, lookbackDays)) continue;

    const title = cleanTitle(row.ntcnYardSjNm || "");
    if (!title) continue;

    out.push({
      id: `FIU-${category}-${id}`,
      source,
      sourceLabel,
      category,
      categoryLabel,
      title,
      url: viewUrl(id),
      publishedAt,
      displayDate: formatDisplayDate(publishedAt),
      dept: "",
      isNew: false,
      attachments: Array.isArray(row.fileList)
        ? row.fileList.map((f) => ({
            name: String(f.atchmnflOrginlNm || "").trim(),
            type: String(f.atchmnflTyNm || "").trim(),
            size: Number(f.atchmnflSzVal || 0),
          }))
        : [],
      hash: stableHash(`${category}|${id}|${title}|${publishedAt}`),
    });
  }

  return out;
}

function normalizeFiuDate(row) {
  const rgi = String(row.ntcnYardRgiDt || "").trim();
  const chg = String(row.ntcnYardChangeDt || "").trim();
  if (rgi.startsWith("9999-")) return chg || rgi;
  return rgi || chg;
}

async function collectFsc(browser) {
  const items = await collectVisibleAnchors(browser, {
    url: URLS.FSC_REPORT,
    hrefPattern: /^\/no010101\/\d+/,
    source: "FSC",
    sourceLabel: "금융위",
    category: "REPORT",
    categoryLabel: "보도자료",
    lookbackDays: LOOKBACK.FSC_REPORT,
    deptRegex: /담당부서\s*:\s*([^\n]+?)(?:조회수|등록일|$)/,
  });

  return items;
}

async function collectFss(browser) {
  const items = await collectVisibleAnchors(browser, {
    url: URLS.FSS_REPORT,
    hrefPattern: /\/fss\/bbs\/B0000188\/view\.do\?nttId=\d+/,
    source: "FSS",
    sourceLabel: "금감원",
    category: "REPORT",
    categoryLabel: "보도자료",
    lookbackDays: LOOKBACK.FSS_REPORT,
    deptRegex: /담당부서\s*([^\n]+?)(?:등록일|첨부파일|조회수|$)/,
  });

  return items;
}

async function collectVisibleAnchors(
  browser,
  { url, hrefPattern, source, sourceLabel, category, categoryLabel, lookbackDays, deptRegex }
) {
  const page = await browser.newPage({
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 1800 },
    locale: "ko-KR",
  });

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

    const patternSource = hrefPattern.source;
    const patternFlags = hrefPattern.flags;

    const rows = await page.evaluate(
      ({ patternSource, patternFlags }) => {
        const re = new RegExp(patternSource, patternFlags);
        const anchors = Array.from(document.querySelectorAll("a[href]"));
        const seen = new Set();
        const out = [];

        function normalizeText(s) {
          return String(s || "")
            .replace(/\u00A0/g, " ")
            .replace(/\s+\n/g, "\n")
            .replace(/\n\s+/g, "\n")
            .replace(/[ \t]+/g, " ")
            .replace(/\n+/g, "\n")
            .trim();
        }

        for (const a of anchors) {
          const href = a.getAttribute("href") || "";
          if (!re.test(href)) continue;

          const title = normalizeText(a.textContent || "");
          if (!title || title.length < 3) continue;

          const abs = new URL(href, location.origin).href;
          const key = `${abs}|${title}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const box =
            a.closest("tr") ||
            a.closest("li") ||
            a.closest("article") ||
            a.closest("section") ||
            a.parentElement;

          const context = normalizeText(box?.innerText || a.parentElement?.innerText || title);

          out.push({
            href: abs,
            title,
            context,
          });
        }

        return out;
      },
      { patternSource, patternFlags }
    );

    const out = [];
    for (const row of rows) {
      const title = cleanTitle(row.title);
      if (!title) continue;

      const publishedAt = parseIsoFromText(row.context);
      if (!publishedAt) continue;
      if (!withinLookback(publishedAt, lookbackDays)) continue;

      const deptMatch = row.context.match(deptRegex);
      const dept = deptMatch ? cleanText(deptMatch[1]) : "";

      out.push({
        id: `${source}-${stableHash(row.href).slice(0, 16)}`,
        source,
        sourceLabel,
        category,
        categoryLabel,
        title,
        url: row.href,
        publishedAt,
        displayDate: formatDisplayDate(publishedAt),
        dept,
        isNew: false,
        attachments: [],
        hash: stableHash(`${row.href}|${title}|${publishedAt}`),
      });
    }

    return dedupeItems(out);
  } finally {
    await page.close();
  }
}

function dedupeItems(items) {
  const map = new Map();

  for (const item of items) {
    const key = String(item.id || item.url || item.title);
    if (!map.has(key)) {
      map.set(key, item);
      continue;
    }

    const prev = map.get(key);
    if ((item.attachments?.length || 0) > (prev.attachments?.length || 0)) {
      map.set(key, item);
    }
  }

  return Array.from(map.values());
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json,text/plain,*/*",
      "Cache-Control": "no-cache",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  const text = await res.text();
  return JSON.parse(text);
}

function parseIsoFromText(text) {
  const s = cleanText(text);
  const m =
    s.match(/\b(\d{4}-\d{2}-\d{2})\b/) ||
    s.match(/\b(\d{4}\.\d{2}\.\d{2})\b/) ||
    s.match(/\b(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)\b/);

  if (!m) return "";

  const raw = m[1].replace(/\./g, "-");
  return toIsoKst(raw);
}

function toIsoKst(v) {
  const s = cleanText(v);
  if (!s) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return `${s}T00:00:00+09:00`;
  }
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(s)) {
    return s.replace(" ", "T") + ":00+09:00";
  }
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(s)) {
    return s.replace(" ", "T") + "+09:00";
  }
  return "";
}

function withinLookback(iso, days) {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return false;
  const diff = Date.now() - ts;
  return diff >= 0 && diff <= days * 24 * 60 * 60 * 1000;
}

function cleanTitle(s) {
  return cleanText(s)
    .replace(/^\[(보도자료|공지|공지사항)\]\s*/i, "")
    .trim();
}

function cleanText(s) {
  return String(s || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDisplayDate(iso) {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nowIsoKst() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value || "00";

  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+09:00`;
}

function stableHash(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
