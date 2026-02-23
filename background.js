const PRAYER_NAMES = ["Fajr", "Sunrise", "Dhuhr", "Asr", "Maghrib", "Isha"];
const COUNTDOWN_NAMES = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
const SOURCE_GUID = "1820245c-9db2-4b80-b9b7-d93dbb7879ef";
const SOURCE_URL = `https://time.my-masjid.com/api/TimingsInfoScreen/GetMasjidTimings?GuidId=${SOURCE_GUID}`;
const CACHE_KEY = "prayerTimesCache";
const BADGE_ALARM = "updateBadge";

function normalizeTimeValue(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function parseTimeToMinutes(timeText) {
  const normalized = normalizeTimeValue(timeText);
  if (!normalized) return null;
  const [hoursText, minutesText] = normalized.split(":");
  return Number(hoursText) * 60 + Number(minutesText);
}

function parseTimeToDate(timeText, baseDate) {
  const minutes = parseTimeToMinutes(timeText);
  if (minutes === null) return null;

  const date = new Date(baseDate);
  date.setHours(0, 0, 0, 0);
  date.setMinutes(minutes);
  return date;
}

function getTodaySalahEntry(model, now = new Date()) {
  if (!model || typeof model !== "object") return null;
  if (!Array.isArray(model.salahTimings)) return null;

  const month = now.getMonth() + 1;
  const day = now.getDate();

  return (
    model.salahTimings.find((entry) => Number(entry?.month) === month && Number(entry?.day) === day) || null
  );
}

function parseTimesFromPayload(payload, now = new Date()) {
  const model = payload?.model;
  const today = getTodaySalahEntry(model, now);
  if (!today) return null;

  return {
    Fajr: normalizeTimeValue(today.fajr),
    Sunrise: normalizeTimeValue(today.shouruq),
    Dhuhr: normalizeTimeValue(today.zuhr),
    Asr: normalizeTimeValue(today.asr),
    Maghrib: normalizeTimeValue(today.maghrib),
    Isha: normalizeTimeValue(today.isha)
  };
}

function isValidTimes(times) {
  if (!times || typeof times !== "object") return false;
  if (!PRAYER_NAMES.every((name) => times[name])) return false;

  let dayOffset = 0;
  let lastMinutes = -1;
  for (const name of PRAYER_NAMES) {
    const timeMinutes = parseTimeToMinutes(times[name]);
    if (timeMinutes === null) return false;

    let absoluteMinutes = timeMinutes + dayOffset * 1440;
    if (absoluteMinutes <= lastMinutes) {
      dayOffset += 1;
      absoluteMinutes = timeMinutes + dayOffset * 1440;
    }
    if (absoluteMinutes <= lastMinutes) return false;
    lastMinutes = absoluteMinutes;
  }

  return true;
}

function buildSchedule(times, baseDate) {
  const start = new Date(baseDate);
  start.setHours(0, 0, 0, 0);

  const schedule = [];
  let dayOffset = 0;
  let lastMinutes = -1;

  for (const name of COUNTDOWN_NAMES) {
    const minutes = parseTimeToMinutes(times[name]);
    if (minutes === null) continue;

    let absoluteMinutes = minutes + dayOffset * 1440;
    if (absoluteMinutes <= lastMinutes) {
      dayOffset += 1;
      absoluteMinutes = minutes + dayOffset * 1440;
    }

    const time = new Date(start);
    time.setMinutes(absoluteMinutes);
    schedule.push({ name, time });
    lastMinutes = absoluteMinutes;
  }

  return schedule;
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
  const schedule = buildSchedule(times, now);
  for (const item of schedule) {
    if (item.time > now) {
      return item;
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

  const response = await fetch(SOURCE_URL, { credentials: "omit", cache: "no-store" });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const payload = await response.json();
  const times = parseTimesFromPayload(payload);
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
