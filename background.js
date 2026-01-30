const PRAYER_NAMES = ["Fajr", "Sunrise", "Dhuhr", "Asr", "Maghrib", "Isha"];
const COUNTDOWN_NAMES = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
const SOURCE_URL = "https://sajda.com/en/prayer-times/denmark/north-denmark-aalborg/2624886?asr=standard";
const CACHE_KEY = "prayerTimesCache";
const BADGE_ALARM = "updateBadge";

function parseTimesFromHtml(html) {
  const result = {};
  let sourceText = html;
  const anchorIndex = html.search(/What are the prayer times/i);
  if (anchorIndex !== -1) {
    sourceText = html.slice(anchorIndex, anchorIndex + 2500);
  }

  const text = sourceText.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const regex = /\b(Fajr|Sunrise|Dhuhr|Asr|Maghrib|Isha)\b\s*(\d{1,2}:\d{2})\b/gi;
  const matches = [];
  let match;

  while ((match = regex.exec(text))) {
    matches.push({
      name: match[1],
      time: match[2],
      index: match.index
    });
  }

  const sequences = [];
  for (let i = 0; i < matches.length; i++) {
    if (matches[i].name.toLowerCase() !== "fajr") continue;
    let lastIndex = matches[i].index;
    const sequence = { Fajr: matches[i], Sunrise: null, Dhuhr: null, Asr: null, Maghrib: null, Isha: null };
    const namesToFind = ["Sunrise", "Dhuhr", "Asr", "Maghrib", "Isha"];

    for (const name of namesToFind) {
      const found = matches.find((item, idx) => idx > i && item.name === name && item.index > lastIndex);
      if (!found) {
        sequence[name] = null;
        break;
      }
      sequence[name] = found;
      lastIndex = found.index;
    }

    if (namesToFind.every((name) => sequence[name])) {
      const span = lastIndex - matches[i].index;
      sequences.push({ sequence, span });
    }
  }

  const best = sequences.sort((a, b) => a.span - b.span)[0];
  if (best) {
    for (const name of PRAYER_NAMES) {
      result[name] = best.sequence[name].time;
    }
    return result;
  }

  for (const item of matches) {
    if (!result[item.name]) result[item.name] = item.time;
  }

  return result;
}

function isValidTimes(times) {
  if (!times || typeof times !== "object") return false;
  if (!PRAYER_NAMES.every((name) => times[name])) return false;
  const order = ["Fajr", "Sunrise", "Dhuhr", "Asr", "Maghrib", "Isha"];
  let last = -1;

  for (const name of order) {
    const parsed = parseTimeToDate(times[name], new Date(2000, 0, 1));
    if (!parsed) return false;
    const minutes = parsed.getHours() * 60 + parsed.getMinutes();
    if (minutes <= last) return false;
    last = minutes;
  }

  return true;
}

function parseTimeToDate(timeText, baseDate) {
  const match = timeText.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const date = new Date(baseDate);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function getTodayKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function readCachedTimes() {
  const result = await chrome.storage.local.get(CACHE_KEY);
  const payload = result[CACHE_KEY];
  if (!payload || typeof payload !== "object") return null;
  if (payload.date !== getTodayKey()) return null;
  if (!payload.times || typeof payload.times !== "object") return null;
  if (!isValidTimes(payload.times)) return null;
  return payload.times;
}

async function saveCachedTimes(times) {
  const payload = {
    date: getTodayKey(),
    times
  };
  await chrome.storage.local.set({ [CACHE_KEY]: payload });
}

function getNextPrayer(times) {
  const now = new Date();
  for (const name of COUNTDOWN_NAMES) {
    const timeText = times[name];
    const timeDate = parseTimeToDate(timeText, now);
    if (timeDate && timeDate > now) {
      return { name, time: timeDate };
    }
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  return { name: "Fajr", time: parseTimeToDate(times.Fajr, tomorrow) };
}

function formatBadgeText(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours >= 10) return `${hours}h`;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

async function loadTimes() {
  const cached = await readCachedTimes();
  if (cached) return cached;

  const response = await fetch(SOURCE_URL, { credentials: "omit" });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const html = await response.text();
  const times = parseTimesFromHtml(html);
  if (!isValidTimes(times)) throw new Error("Missing times");
  await saveCachedTimes(times);
  return times;
}

async function updateBadge() {
  try {
    const times = await loadTimes();
    const next = getNextPrayer(times);
    if (!next.time) throw new Error("Missing next time");
    const ms = next.time - new Date();
    const badgeText = formatBadgeText(ms);
    await chrome.action.setBadgeBackgroundColor({ color: "#0f172a" });
    await chrome.action.setBadgeText({ text: badgeText });
    await chrome.action.setTitle({ title: `Next: ${next.name} in ${badgeText}` });
  } catch (err) {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "Prayer Times" });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });
  updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BADGE_ALARM) updateBadge();
});
