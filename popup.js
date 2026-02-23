const PRAYER_NAMES = ["Fajr", "Sunrise", "Dhuhr", "Asr", "Maghrib", "Isha"];
const COUNTDOWN_NAMES = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
const DEFAULT_SOURCE_GUID = "1820245c-9db2-4b80-b9b7-d93dbb7879ef";
const MASJID_GUID_KEY = "masjidSourceGuid";
const SOURCE_URL_PREFIX = "https://time.my-masjid.com/api/TimingsInfoScreen/GetMasjidTimings?GuidId=";
const NAMES_URL = "names.json";
const CACHE_KEY = "prayerTimesCache";
const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUID_FINDER_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
let currentData = null;
let countdownTimer = null;

function buildSourceUrl(guid) {
  return `${SOURCE_URL_PREFIX}${guid}`;
}

function buildTimingsScreenUrl(guid) {
  return `https://time.my-masjid.com/timingscreen/${guid}`;
}

function normalizeGuid(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!GUID_REGEX.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function extractGuidFromInput(inputText) {
  if (typeof inputText !== "string") return null;
  const text = inputText.trim();
  if (!text) return null;

  const directGuid = normalizeGuid(text);
  if (directGuid) return directGuid;

  try {
    const url = new URL(text);
    const queryKeys = ["GuidId", "guidId", "guid", "id"];
    for (const key of queryKeys) {
      const queryGuid = normalizeGuid(url.searchParams.get(key) || "");
      if (queryGuid) return queryGuid;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    for (const segment of segments) {
      const segmentGuid = normalizeGuid(segment);
      if (segmentGuid) return segmentGuid;
    }
  } catch {
    // Ignore URL parse errors and continue with regex extraction.
  }

  const embedded = text.match(GUID_FINDER_REGEX);
  return normalizeGuid(embedded ? embedded[0] : "");
}

async function getStoredSourceGuid() {
  const result = await chrome.storage.local.get(MASJID_GUID_KEY);
  return normalizeGuid(result[MASJID_GUID_KEY]) || DEFAULT_SOURCE_GUID;
}

async function setStoredSourceGuid(guid) {
  await chrome.storage.local.set({ [MASJID_GUID_KEY]: guid });
}

function setStatus(message) {
  const statusEl = document.getElementById("status");
  statusEl.textContent = message;
  statusEl.hidden = false;
  document.getElementById("times").hidden = true;
}

function setConfigStatus(message, type = "info") {
  const statusEl = document.getElementById("masjid-config-status");
  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = "";
    statusEl.dataset.type = "";
    return;
  }

  statusEl.textContent = message;
  statusEl.dataset.type = type;
  statusEl.hidden = false;
}

function setTimes(data) {
  const { times } = data;

  for (const name of PRAYER_NAMES) {
    const el = document.getElementById(name);
    el.textContent = times[name] || "—";
  }

  const locationEl = document.getElementById("location");
  locationEl.textContent = data.locationLabel || "Aalborg, Denmark";

  const jumuahMeta = document.getElementById("jumuah-meta");
  const jumuahEl = document.getElementById("Jumuah");
  if (data.jumuahTime) {
    jumuahEl.textContent = data.jumuahTime;
    jumuahMeta.hidden = false;
  } else {
    jumuahEl.textContent = "—";
    jumuahMeta.hidden = true;
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

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
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

function getNextPrayer(times, now = new Date()) {
  const schedule = buildSchedule(times, now);
  for (const item of schedule) {
    if (item.time > now) {
      return item;
    }
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const fajr = parseTimeToDate(times.Fajr, tomorrow);
  if (!fajr) return null;

  return { name: "Fajr", time: fajr };
}

function updateCountdown() {
  if (!currentData || !currentData.times) return;

  const now = new Date();
  const next = getNextPrayer(currentData.times, now);

  const nameEl = document.getElementById("next-name");
  const countdownEl = document.getElementById("next-countdown");
  if (!next || !next.time) {
    nameEl.textContent = "Next";
    countdownEl.textContent = "—";
    return;
  }

  nameEl.textContent = next.name || "Next";
  countdownEl.textContent = formatCountdown(next.time - now);
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

function isValidData(data) {
  if (!data || typeof data !== "object") return false;
  if (!isValidTimes(data.times)) return false;
  if (data.jumuahTime !== null && data.jumuahTime !== undefined && !normalizeTimeValue(data.jumuahTime)) {
    return false;
  }
  return true;
}

function readCachedData(sourceGuid) {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.date !== getTodayKey()) return null;
    if (normalizeGuid(parsed.guid || "") !== sourceGuid) return null;
    if (!isValidData(parsed.data)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function saveCachedData(sourceGuid, data) {
  const payload = {
    date: getTodayKey(),
    guid: sourceGuid,
    data
  };
  localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
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

function buildDataFromPayload(payload, now = new Date()) {
  const model = payload?.model;
  const today = getTodaySalahEntry(model, now);
  if (!today) return null;

  const times = {
    Fajr: normalizeTimeValue(today.fajr),
    Sunrise: normalizeTimeValue(today.shouruq),
    Dhuhr: normalizeTimeValue(today.zuhr),
    Asr: normalizeTimeValue(today.asr),
    Maghrib: normalizeTimeValue(today.maghrib),
    Isha: normalizeTimeValue(today.isha)
  };

  const masjidSettings = model?.masjidSettings || {};
  const jumuahTime = masjidSettings.showJumahTime ? normalizeTimeValue(masjidSettings.jumahTime) : null;

  const masjidDetails = model?.masjidDetails || {};
  let locationLabel = "";
  if (typeof masjidDetails.name === "string" && masjidDetails.name.trim()) {
    locationLabel = masjidDetails.name.trim();
  } else if (masjidDetails.city && masjidDetails.country) {
    locationLabel = `${masjidDetails.city}, ${masjidDetails.country}`;
  } else {
    locationLabel = "Aalborg, Denmark";
  }

  return {
    times,
    jumuahTime,
    locationLabel
  };
}

function startCountdownTimer() {
  updateCountdown();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(updateCountdown, 1000);
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
  } catch {
    document.getElementById("name-translit").textContent = "—";
    document.getElementById("name-meaning").textContent = "—";
  }
}

async function loadTimes(forceRefresh = false) {
  const sourceGuid = await getStoredSourceGuid();

  if (!forceRefresh) {
    const cached = readCachedData(sourceGuid);
    if (cached) {
      currentData = cached;
      setTimes(cached);
      startCountdownTimer();
      return;
    }
  }

  try {
    const response = await fetch(buildSourceUrl(sourceGuid), { credentials: "omit", cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const payload = await response.json();
    const data = buildDataFromPayload(payload);
    if (!isValidData(data)) throw new Error("Missing times");

    currentData = data;
    saveCachedData(sourceGuid, data);
    setTimes(data);
    startCountdownTimer();
  } catch {
    setStatus("Failed to load times");
    document.getElementById("next").hidden = true;
  }
}

async function saveMasjidSource() {
  const inputEl = document.getElementById("masjid-link");
  const saveButtonEl = document.getElementById("save-masjid");
  const sourceGuid = extractGuidFromInput(inputEl.value);

  if (!sourceGuid) {
    setConfigStatus("Paste a valid My-Masjid link or UUID.", "error");
    return;
  }

  saveButtonEl.disabled = true;
  try {
    const currentGuid = await getStoredSourceGuid();
    if (sourceGuid === currentGuid) {
      setConfigStatus("This masjid is already selected.", "info");
      inputEl.value = buildTimingsScreenUrl(sourceGuid);
      return;
    }

    await setStoredSourceGuid(sourceGuid);
    localStorage.removeItem(CACHE_KEY);
    inputEl.value = buildTimingsScreenUrl(sourceGuid);
    setConfigStatus("Masjid updated. Reloading times...", "success");
    await loadTimes(true);
  } catch {
    setConfigStatus("Could not save masjid link.", "error");
  } finally {
    saveButtonEl.disabled = false;
  }
}

async function initSourceForm() {
  const inputEl = document.getElementById("masjid-link");
  const saveButtonEl = document.getElementById("save-masjid");
  const sourceGuid = await getStoredSourceGuid();

  inputEl.value = buildTimingsScreenUrl(sourceGuid);
  saveButtonEl.addEventListener("click", () => {
    saveMasjidSource();
  });
  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveMasjidSource();
    }
  });
}

updateDate();
initSourceForm();
loadTimes();
loadNameOfAllah();