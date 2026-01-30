const PRAYER_NAMES = ["Fajr", "Sunrise", "Dhuhr", "Asr", "Maghrib", "Isha"];
const COUNTDOWN_NAMES = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
const SOURCE_URL = "https://sajda.com/en/prayer-times/denmark/north-denmark-aalborg/2624886?asr=standard";
const NAMES_URL = "names.json";
const CACHE_KEY = "prayerTimesCache";
let currentTimes = null;
let countdownTimer = null;

function setStatus(message) {
  const statusEl = document.getElementById("status");
  statusEl.textContent = message;
  statusEl.hidden = false;
  document.getElementById("times").hidden = true;
}

function setTimes(times) {
  for (const name of PRAYER_NAMES) {
    const el = document.getElementById(name);
    el.textContent = times[name] || "—";
  }
  document.getElementById("status").hidden = true;
  document.getElementById("times").hidden = false;
  document.getElementById("next").hidden = false;
}

function updateDate() {
  const dateEl = document.getElementById("date");
  const today = new Date();
  dateEl.textContent = today.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

function normalize(text) {
  return text.replace(/\s+/g, " ").trim();
}

function extractTime(text) {
  // Parsing assumption: time values appear in the HTML as HH:MM (24h or 12h) strings.
  const match = text.match(/\b\d{1,2}:\d{2}\b/);
  return match ? match[0] : "";
}

function parseTimesFromHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const result = {};

  // Parsing assumption: prayer times are listed in table rows with prayer name and time in adjacent cells.
  const rows = Array.from(doc.querySelectorAll("tr"));
  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll("th, td"));
    if (cells.length < 2) continue;

    const cellTexts = cells.map((cell) => normalize(cell.textContent || ""));
    for (const name of PRAYER_NAMES) {
      const idx = cellTexts.findIndex((text) => text.toLowerCase() === name.toLowerCase());
      if (idx !== -1) {
        const timeText = extractTime(cellTexts[idx + 1] || "");
        if (timeText) result[name] = timeText;
      }
    }
  }

  // Fallback: look for elements that contain both the prayer name and a time string.
  if (Object.keys(result).length === 0) {
    const elements = Array.from(doc.querySelectorAll("*[data-prayer], .prayer, .prayer-time, .prayer-times, li, div"));
    for (const el of elements) {
      const text = normalize(el.textContent || "");
      for (const name of PRAYER_NAMES) {
        if (text.toLowerCase().includes(name.toLowerCase())) {
          const timeText = extractTime(text);
          if (timeText) result[name] = timeText;
        }
      }
    }
  }

  return result;
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

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function updateCountdown() {
  if (!currentTimes) return;
  const now = new Date();
  let nextName = null;
  let nextTime = null;

  for (const name of COUNTDOWN_NAMES) {
    const timeText = currentTimes[name];
    const timeDate = parseTimeToDate(timeText, now);
    if (timeDate && timeDate > now) {
      nextName = name;
      nextTime = timeDate;
      break;
    }
  }

  if (!nextTime) {
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    nextName = "Fajr";
    nextTime = parseTimeToDate(currentTimes.Fajr, tomorrow);
  }

  const nameEl = document.getElementById("next-name");
  const countdownEl = document.getElementById("next-countdown");
  nameEl.textContent = nextName || "Next";
  countdownEl.textContent = nextTime ? formatCountdown(nextTime - now) : "—";
}

function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date - start;
  return Math.floor(diff / 86400000);
}

function getTodayKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function readCachedTimes() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.date !== getTodayKey()) return null;
    if (!parsed.times || typeof parsed.times !== "object") return null;
    return parsed.times;
  } catch {
    return null;
  }
}

function saveCachedTimes(times) {
  const payload = {
    date: getTodayKey(),
    times
  };
  localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
}

async function loadNameOfAllah() {
  try {
    const url = chrome.runtime.getURL(NAMES_URL);
    const response = await fetch(url);
    if (!response.ok) throw new Error("HTTP " + response.status);
    const names = await response.json();
    if (!Array.isArray(names) || names.length === 0) throw new Error("No names");

    const today = new Date();
    const index = (dayOfYear(today) - 1) % names.length;
    const entry = names[index] || names[0];

    document.getElementById("name-translit").textContent = entry.transliteration || "—";
    document.getElementById("name-meaning").textContent = entry.meaning || "—";
  } catch (err) {
    document.getElementById("name-translit").textContent = "—";
    document.getElementById("name-meaning").textContent = "—";
  }
}

async function loadTimes() {
  const cached = readCachedTimes();
  if (cached) {
    currentTimes = cached;
    setTimes(cached);
    updateCountdown();
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(updateCountdown, 1000);
    return;
  }

  try {
    const response = await fetch(SOURCE_URL, { credentials: "omit" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const html = await response.text();
    const times = parseTimesFromHtml(html);

    const hasAll = PRAYER_NAMES.every((name) => times[name]);
    if (!hasAll) throw new Error("Missing times");

    currentTimes = times;
    saveCachedTimes(times);
    setTimes(times);
    updateCountdown();
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(updateCountdown, 1000);
  } catch (err) {
    setStatus("Failed to load times");
    document.getElementById("next").hidden = true;
  }
}

updateDate();
loadTimes();
loadNameOfAllah();
