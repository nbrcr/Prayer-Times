const PRAYER_NAMES = ["Fajr", "Sunrise", "Dhuhr", "Asr", "Maghrib", "Isha"];
const COUNTDOWN_NAMES = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
const DEFAULT_SOURCE_GUID = "1820245c-9db2-4b80-b9b7-d93dbb7879ef";
const MASJID_GUID_KEY = "masjidSourceGuid";
const SOURCE_URL_PREFIX = "https://time.my-masjid.com/api/TimingsInfoScreen/GetMasjidTimings?GuidId=";
const NAMES_URL = "names.json";
const CACHE_KEY = "prayerTimesCache";
const CACHE_VERSION = 2;
const REQUEST_TIMEOUT_MS = 4500;
const RETRY_DELAYS_MS = [300, 900];
const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUID_FINDER_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DASH = "--";
const extensionApi = globalThis.browser ?? globalThis.chrome;

let currentData = null;
let countdownTimer = null;

function getEl(id) {
  return document.getElementById(id);
}

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
  const result = await extensionApi.storage.local.get(MASJID_GUID_KEY);
  return normalizeGuid(result[MASJID_GUID_KEY]) || DEFAULT_SOURCE_GUID;
}

async function setStoredSourceGuid(guid) {
  await extensionApi.storage.local.set({ [MASJID_GUID_KEY]: guid });
}

function setStatus(message, options = {}) {
  const { hideTimes = true } = options;
  const statusEl = getEl("status");
  const timesEl = getEl("times");
  if (!statusEl || !timesEl) return;

  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = "";
    return;
  }

  statusEl.textContent = message;
  statusEl.hidden = false;
  if (hideTimes) {
    timesEl.hidden = true;
  }
}

function setConfigStatus(message, type = "info") {
  const statusEl = getEl("masjid-config-status");
  if (!statusEl) return;

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
  if (!data || !data.times) return;
  const { times } = data;

  for (const name of PRAYER_NAMES) {
    const el = getEl(name);
    if (el) el.textContent = times[name] || DASH;
  }

  const locationEl = getEl("location");
  if (locationEl) locationEl.textContent = data.locationLabel || "Aalborg, Denmark";

  const jumuahMeta = getEl("jumuah-meta");
  const jumuahEl = getEl("Jumuah");
  if (jumuahMeta && jumuahEl) {
    if (data.jumuahTime) {
      jumuahEl.textContent = data.jumuahTime;
      jumuahMeta.hidden = false;
    } else {
      jumuahEl.textContent = DASH;
      jumuahMeta.hidden = true;
    }
  }

  const statusEl = getEl("status");
  const timesEl = getEl("times");
  const nextEl = getEl("next");
  if (statusEl) statusEl.hidden = true;
  if (timesEl) timesEl.hidden = false;
  if (nextEl) nextEl.hidden = false;
}

function updateDate() {
  const dateEl = getEl("date");
  if (!dateEl) return;

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

function shiftTimeValue(timeText, minutesToAdd) {
  const minutes = parseTimeToMinutes(timeText);
  if (minutes === null) return null;

  const shifted = ((minutes + minutesToAdd) % 1440 + 1440) % 1440;
  const hours = Math.floor(shifted / 60);
  const minutesPart = shifted % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutesPart).padStart(2, "0")}`;
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

  const nameEl = getEl("next-name");
  const countdownEl = getEl("next-countdown");
  if (!nameEl || !countdownEl) return;

  if (!next || !next.time) {
    nameEl.textContent = "Next";
    countdownEl.textContent = DASH;
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
    if (parsed.version !== CACHE_VERSION) return null;
    if (normalizeGuid(parsed.guid || "") !== sourceGuid) return null;
    if (!isValidData(parsed.data)) return null;

    return {
      data: parsed.data,
      isFresh: parsed.date === getTodayKey()
    };
  } catch {
    return null;
  }
}

function saveCachedData(sourceGuid, data) {
  try {
    const payload = {
      version: CACHE_VERSION,
      date: getTodayKey(),
      guid: sourceGuid,
      data
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage write failures.
  }
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
  const dstOffset = model?.masjidSettings?.isDstOn ? 60 : 0;

  const times = {
    Fajr: shiftTimeValue(today.fajr, dstOffset),
    Sunrise: shiftTimeValue(today.shouruq, dstOffset),
    Dhuhr: shiftTimeValue(today.zuhr, dstOffset),
    Asr: shiftTimeValue(today.asr, dstOffset),
    Maghrib: shiftTimeValue(today.maghrib, dstOffset),
    Isha: shiftTimeValue(today.isha, dstOffset)
  };

  const masjidSettings = model?.masjidSettings || {};
  const jumuahTime = masjidSettings.showJumahTime ? shiftTimeValue(masjidSettings.jumahTime, dstOffset) : null;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPayloadWithTimeout(sourceGuid) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(buildSourceUrl(sourceGuid), {
      credentials: "omit",
      signal: controller.signal
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchLatestData(sourceGuid) {
  let lastError = null;
  const attempts = RETRY_DELAYS_MS.length + 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const payload = await fetchPayloadWithTimeout(sourceGuid);
      const data = buildDataFromPayload(payload);
      if (!isValidData(data)) throw new Error("Missing times");
      return data;
    } catch (error) {
      lastError = error;
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  throw lastError || new Error("Failed to load times");
}

async function loadNameOfAllah() {
  const translitEl = getEl("name-translit");
  const meaningEl = getEl("name-meaning");
  if (!translitEl || !meaningEl) return;

  try {
    const url = extensionApi.runtime.getURL(NAMES_URL);
    const response = await fetch(url);
    if (!response.ok) throw new Error("HTTP " + response.status);
    const names = await response.json();
    if (!Array.isArray(names) || names.length === 0) throw new Error("No names");

    const today = new Date();
    const index = (dayOfYear(today) - 1) % names.length;
    const entry = names[index] || names[0];

    translitEl.textContent = entry.transliteration || DASH;
    meaningEl.textContent = entry.meaning || DASH;
  } catch {
    translitEl.textContent = DASH;
    meaningEl.textContent = DASH;
  }
}

async function loadTimes(options = {}) {
  const { forceRefresh = false, sourceGuid: suppliedGuid } = options;
  let sourceGuid = suppliedGuid;
  if (!sourceGuid) {
    try {
      sourceGuid = await getStoredSourceGuid();
    } catch {
      sourceGuid = DEFAULT_SOURCE_GUID;
    }
  }
  const cachedEntry = readCachedData(sourceGuid);

  if (cachedEntry) {
    currentData = cachedEntry.data;
    setTimes(cachedEntry.data);
    startCountdownTimer();

    if (!forceRefresh && cachedEntry.isFresh) return;
    setStatus("Refreshing prayer times...", { hideTimes: false });
  } else {
    setStatus("Loading prayer times...");
    const nextEl = getEl("next");
    if (nextEl) nextEl.hidden = true;
  }

  try {
    const data = await fetchLatestData(sourceGuid);
    currentData = data;
    saveCachedData(sourceGuid, data);
    setTimes(data);
    startCountdownTimer();
  } catch {
    if (cachedEntry) {
      setStatus("Showing saved times (update failed).", { hideTimes: false });
      return;
    }

    setStatus("Failed to load times");
    const nextEl = getEl("next");
    if (nextEl) nextEl.hidden = true;
  }
}

async function saveMasjidSource() {
  const inputEl = getEl("masjid-link");
  const saveButtonEl = getEl("save-masjid");
  if (!inputEl || !saveButtonEl) return;

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
    await loadTimes({ forceRefresh: true, sourceGuid });
  } catch {
    setConfigStatus("Could not save masjid link.", "error");
  } finally {
    saveButtonEl.disabled = false;
  }
}

function initSourceForm(sourceGuid) {
  const inputEl = getEl("masjid-link");
  const saveButtonEl = getEl("save-masjid");
  if (!inputEl || !saveButtonEl) return;

  inputEl.value = buildTimingsScreenUrl(sourceGuid);
  saveButtonEl.addEventListener("click", () => {
    void saveMasjidSource();
  });
  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveMasjidSource();
    }
  });
}

async function init() {
  updateDate();
  void loadNameOfAllah();

  let sourceGuid = DEFAULT_SOURCE_GUID;
  try {
    sourceGuid = await getStoredSourceGuid();
  } catch {
    // Keep default GUID when storage is unavailable.
  }
  initSourceForm(sourceGuid);
  await loadTimes({ sourceGuid });
}

void init();
