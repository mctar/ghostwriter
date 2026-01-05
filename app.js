const DB_NAME = "ghostwriter";
const DB_VERSION = 1;
const DOC_ID = "current";
const SAVE_DEBOUNCE_MS = 1200;
const SNAPSHOT_INTERVAL_MS = 30000;
const IDLE_SNAPSHOT_MS = 6000;
const MAX_ROLLING = 200;
const MAX_DAILY = 30;
const FILE_HANDLE_KEY = "fileHandle";
const FILE_TYPES = [
  {
    description: "Text files",
    accept: {
      "text/plain": [".txt", ".md", ".text"],
    },
  },
];

const editor = document.getElementById("editor");
const statusEl = document.getElementById("status");
const menuButton = document.getElementById("menu-button");
const menuPanel = document.getElementById("menu-panel");
const saveButton = document.getElementById("save-button");
const loadButton = document.getElementById("load-button");
const restoreButton = document.getElementById("restore-button");
const settingsButton = document.getElementById("settings-button");
const fileInput = document.getElementById("file-input");

const restoreBackdrop = document.getElementById("restore-backdrop");
const restoreClose = document.getElementById("restore-close");
const restoreCancel = document.getElementById("restore-cancel");
const restoreApply = document.getElementById("restore-apply");
const snapshotList = document.getElementById("snapshot-list");
const snapshotPreview = document.getElementById("snapshot-preview");

const settingsBackdrop = document.getElementById("settings-backdrop");
const settingsClose = document.getElementById("settings-close");
const settingsDone = document.getElementById("settings-done");
const fontSizeInput = document.getElementById("font-size");
const lineWidthSelect = document.getElementById("line-width");
const fontFamilySelect = document.getElementById("font-family");

let saveTimer;
let snapshotInterval;
let idleSnapshotTimer;
let needsSnapshot = false;
let lastInputAt = 0;
let selectedSnapshot = null;
let saveQueue = Promise.resolve();
let snapshotQueue = Promise.resolve();
let lastDailySnapshotDay = null;
let statusTimer;
let fileHandle = null;

init();

async function init() {
  await openDb();
  requestPersistentStorage();
  attachEventListeners();
  await loadSettings();
  await loadDocument();
  await maybeOfferRestore();
  editor.focus({ preventScroll: true });
  registerServiceWorker();
}

function attachEventListeners() {
  editor.addEventListener("input", onInput);
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("keydown", handleKeydown);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pagehide", handlePageHide);

  menuButton.addEventListener("click", () => toggleMenu());
  saveButton.addEventListener("click", handleSave);
  loadButton.addEventListener("click", handleLoad);
  restoreButton.addEventListener("click", () => openRestoreDialog(false));
  settingsButton.addEventListener("click", openSettingsDialog);

  restoreClose.addEventListener("click", closeRestoreDialog);
  restoreCancel.addEventListener("click", closeRestoreDialog);
  restoreApply.addEventListener("click", applyRestore);

  settingsClose.addEventListener("click", closeSettingsDialog);
  settingsDone.addEventListener("click", closeSettingsDialog);

  fileInput.addEventListener("change", handleLoadFromInput);
  fontSizeInput.addEventListener("input", handleFontSizeChange);
  lineWidthSelect.addEventListener("change", handleLineWidthChange);
  fontFamilySelect.addEventListener("change", handleFontFamilyChange);
}

function handleDocumentClick(event) {
  if (!menuPanel.classList.contains("open")) {
    return;
  }
  if (menuPanel.contains(event.target) || menuButton.contains(event.target)) {
    return;
  }
  closeMenu();
}

function handleKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    handleSave();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    handleLoad();
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "r") {
    event.preventDefault();
    openRestoreDialog(false);
  }
  if (event.key === "Escape") {
    closeMenu();
    closeRestoreDialog();
    closeSettingsDialog();
  }
}

function onInput() {
  needsSnapshot = true;
  lastInputAt = Date.now();
  scheduleSave();
  startSnapshotLoop();
  scheduleIdleSnapshot();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    queueSave("autosave");
  }, SAVE_DEBOUNCE_MS);
}

function startSnapshotLoop() {
  if (snapshotInterval) {
    return;
  }
  snapshotInterval = setInterval(() => {
    if (needsSnapshot) {
      queueSnapshot("rolling");
    }
  }, SNAPSHOT_INTERVAL_MS);
}

function stopSnapshotLoop() {
  if (!snapshotInterval) {
    return;
  }
  clearInterval(snapshotInterval);
  snapshotInterval = null;
}

function scheduleIdleSnapshot() {
  clearTimeout(idleSnapshotTimer);
  idleSnapshotTimer = setTimeout(() => {
    if (Date.now() - lastInputAt >= IDLE_SNAPSHOT_MS && needsSnapshot) {
      queueSnapshot("rolling");
    }
    stopSnapshotLoop();
  }, IDLE_SNAPSHOT_MS);
}

function handleVisibilityChange() {
  if (document.visibilityState === "hidden") {
    flushSaveAndSnapshot();
  }
}

function handlePageHide() {
  flushSaveAndSnapshot();
}

function flushSaveAndSnapshot() {
  queueSave("visibility");
  if (needsSnapshot) {
    queueSnapshot("rolling");
  }
}

function toggleMenu(forceOpen) {
  const shouldOpen = forceOpen ?? !menuPanel.classList.contains("open");
  if (shouldOpen) {
    menuPanel.classList.add("open");
    menuPanel.setAttribute("aria-hidden", "false");
    menuButton.setAttribute("aria-expanded", "true");
    return;
  }
  closeMenu();
}

function closeMenu() {
  menuPanel.classList.remove("open");
  menuPanel.setAttribute("aria-hidden", "true");
  menuButton.setAttribute("aria-expanded", "false");
}

async function handleSave() {
  closeMenu();
  await queueSave("silent");
  const text = editor.value;
  if (supportsFileSystemAccess()) {
    try {
      const handle = await getWritableHandle();
      if (!handle) {
        return;
      }
      await writeTextToHandle(handle, text);
      flashStatus(`Saved to file - ${formatTime(Date.now())}`);
      return;
    } catch (error) {
      if (error && error.name === "AbortError") {
        return;
      }
    }
  }
  downloadText(text);
  flashStatus(`Saved file - ${formatTime(Date.now())}`);
}

async function handleLoad() {
  closeMenu();
  if (supportsOpenPicker()) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: FILE_TYPES,
        multiple: false,
      });
      if (!handle) {
        return;
      }
      fileHandle = handle;
      await storeFileHandle(handle);
      const file = await handle.getFile();
      await applyLoadedText(await file.text());
      return;
    } catch (error) {
      if (error && error.name === "AbortError") {
        return;
      }
    }
  }
  fileInput.click();
}

function handleLoadFromInput(event) {
  const file = event.target.files[0];
  if (!file) {
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    await applyLoadedText(reader.result);
  };
  reader.readAsText(file);
  event.target.value = "";
}

async function applyLoadedText(text) {
  editor.value = text;
  needsSnapshot = true;
  await queueSave("load");
  await queueSnapshot("rolling");
}

async function openRestoreDialog(autoSelectLatest) {
  closeMenu();
  await renderSnapshots();
  openDialog(restoreBackdrop);
  if (autoSelectLatest && selectedSnapshot) {
    restoreApply.focus();
  }
}

function closeRestoreDialog() {
  closeDialog(restoreBackdrop);
  selectedSnapshot = null;
  restoreApply.disabled = true;
  snapshotPreview.textContent = "Select a backup to preview.";
}

async function applyRestore() {
  if (!selectedSnapshot) {
    return;
  }
  editor.value = selectedSnapshot.text;
  needsSnapshot = false;
  await queueSave("restore");
  await queueSnapshot("rolling");
  closeRestoreDialog();
}

async function openSettingsDialog() {
  closeMenu();
  openDialog(settingsBackdrop);
}

function closeSettingsDialog() {
  closeDialog(settingsBackdrop);
}

function openDialog(backdrop) {
  backdrop.classList.add("open");
  backdrop.setAttribute("aria-hidden", "false");
}

function closeDialog(backdrop) {
  backdrop.classList.remove("open");
  backdrop.setAttribute("aria-hidden", "true");
}

async function renderSnapshots() {
  const snapshots = await dbGetAll("snapshots");
  snapshots.sort((a, b) => b.createdAt - a.createdAt);
  snapshotList.innerHTML = "";
  selectedSnapshot = null;
  restoreApply.disabled = true;
  if (snapshots.length === 0) {
    snapshotList.innerHTML = "<div class=\"snapshot-item\">No backups yet.</div>";
    snapshotPreview.textContent = "Backups will appear as you write.";
    return;
  }
  snapshots.forEach((snapshot, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "snapshot-item";
    item.dataset.createdAt = snapshot.createdAt;
    const label = snapshot.type === "daily" ? "daily" : "auto";
    item.innerHTML = `<span>${formatTimestamp(snapshot.createdAt)}</span><span>${label}</span>`;
    item.addEventListener("click", () => selectSnapshot(snapshot, item));
    snapshotList.appendChild(item);
    if (index === 0) {
      selectSnapshot(snapshot, item);
    }
  });
}

function selectSnapshot(snapshot, element) {
  snapshotList.querySelectorAll(".snapshot-item").forEach((item) => {
    item.classList.remove("selected");
  });
  element.classList.add("selected");
  selectedSnapshot = snapshot;
  restoreApply.disabled = false;
  snapshotPreview.textContent = buildPreview(snapshot.text);
}

function buildPreview(text) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "(empty)";
  }
  return cleaned.slice(0, 240);
}

function handleFontSizeChange(event) {
  const value = Number(event.target.value);
  document.documentElement.style.setProperty("--font-size", `${value}px`);
  setSetting("fontSize", value);
}

function handleLineWidthChange(event) {
  const value = Number(event.target.value);
  document.documentElement.style.setProperty("--line-width", `${value}px`);
  setSetting("lineWidth", value);
}

function handleFontFamilyChange(event) {
  const value = event.target.value;
  document.body.setAttribute("data-font", value);
  setSetting("fontFamily", value);
}

function buildSaveName() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `ghostwriter-${timestamp}.txt`;
}

function downloadText(text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = buildSaveName();
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function supportsFileSystemAccess() {
  return "showSaveFilePicker" in window;
}

function supportsOpenPicker() {
  return "showOpenFilePicker" in window;
}

async function getWritableHandle() {
  if (fileHandle) {
    const granted = await ensureWritePermission(fileHandle);
    if (granted) {
      return fileHandle;
    }
  }
  if (!supportsFileSystemAccess()) {
    return null;
  }
  const handle = await window.showSaveFilePicker({
    suggestedName: buildSaveName(),
    types: FILE_TYPES,
  });
  fileHandle = handle;
  await storeFileHandle(handle);
  return handle;
}

async function writeTextToHandle(handle, text) {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function ensureWritePermission(handle) {
  if (!handle.queryPermission || !handle.requestPermission) {
    return true;
  }
  const options = { mode: "readwrite" };
  const status = await handle.queryPermission(options);
  if (status === "granted") {
    return true;
  }
  const request = await handle.requestPermission(options);
  return request === "granted";
}

async function storeFileHandle(handle) {
  try {
    await setSetting(FILE_HANDLE_KEY, handle);
  } catch (error) {
    // Ignore if the browser blocks storing file handles.
  }
}

function flashStatus(message) {
  statusEl.textContent = message;
  statusEl.classList.add("visible");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.classList.remove("visible");
  }, 2200);
}

function formatTimestamp(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function computeStats(text) {
  const trimmed = text.trim();
  return {
    wordCount: trimmed ? trimmed.split(/\s+/).length : 0,
    charCount: text.length,
  };
}

function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

function queueSave(reason) {
  saveQueue = saveQueue
    .then(() => saveDoc(reason))
    .catch(() => {});
  return saveQueue;
}

function queueSnapshot(type) {
  snapshotQueue = snapshotQueue
    .then(() => createSnapshot(type))
    .catch(() => {});
  return snapshotQueue;
}

async function saveDoc(reason) {
  const text = editor.value;
  const now = Date.now();
  const stats = computeStats(text);
  await dbPut("docs", {
    id: DOC_ID,
    text,
    updatedAt: now,
    wordCount: stats.wordCount,
    charCount: stats.charCount,
  });
  if (reason === "silent") {
    return;
  }
  if (reason === "restore") {
    flashStatus(`Restored - ${formatTime(now)}`);
    return;
  }
  if (reason === "load") {
    flashStatus(`Loaded - ${formatTime(now)}`);
    return;
  }
  flashStatus(`Saved - ${formatTime(now)}`);
}

async function createSnapshot(type) {
  const text = editor.value;
  if (!text && !needsSnapshot) {
    return;
  }
  const now = Date.now();
  const stats = computeStats(text);
  await dbPut("snapshots", {
    createdAt: now,
    text,
    wordCount: stats.wordCount,
    charCount: stats.charCount,
    type,
  });
  needsSnapshot = false;
  await maybeCreateDailySnapshot();
  await pruneSnapshots();
}

async function maybeCreateDailySnapshot() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastDailySnapshotDay === today) {
    return;
  }
  lastDailySnapshotDay = today;
  await setSetting("lastDailySnapshotDay", today);
  const stats = computeStats(editor.value);
  await dbPut("snapshots", {
    createdAt: Date.now(),
    text: editor.value,
    wordCount: stats.wordCount,
    charCount: stats.charCount,
    type: "daily",
  });
}

async function pruneSnapshots() {
  const snapshots = await dbGetAll("snapshots");
  const rolling = snapshots.filter((item) => item.type === "rolling");
  const daily = snapshots.filter((item) => item.type === "daily");
  if (rolling.length > MAX_ROLLING) {
    const excess = rolling.slice(0, rolling.length - MAX_ROLLING);
    for (const snapshot of excess) {
      await dbDelete("snapshots", snapshot.createdAt);
    }
  }
  if (daily.length > MAX_DAILY) {
    const excess = daily.slice(0, daily.length - MAX_DAILY);
    for (const snapshot of excess) {
      await dbDelete("snapshots", snapshot.createdAt);
    }
  }
}

async function loadDocument() {
  const doc = await dbGet("docs", DOC_ID);
  if (doc && typeof doc.text === "string") {
    editor.value = doc.text;
  }
}

async function loadSettings() {
  const fontSize = await getSetting("fontSize", 18);
  const lineWidth = await getSetting("lineWidth", 680);
  const fontFamily = await getSetting("fontFamily", "fraunces");
  lastDailySnapshotDay = await getSetting("lastDailySnapshotDay", null);
  fileHandle = await getSetting(FILE_HANDLE_KEY, null);

  fontSizeInput.value = fontSize;
  lineWidthSelect.value = String(lineWidth);
  fontFamilySelect.value = fontFamily;

  document.documentElement.style.setProperty("--font-size", `${fontSize}px`);
  document.documentElement.style.setProperty("--line-width", `${lineWidth}px`);
  document.body.setAttribute("data-font", fontFamily);
}

async function maybeOfferRestore() {
  const doc = await dbGet("docs", DOC_ID);
  const snapshots = await dbGetAll("snapshots");
  if (snapshots.length === 0) {
    return;
  }
  snapshots.sort((a, b) => b.createdAt - a.createdAt);
  const latest = snapshots[0];
  if (!doc || !doc.updatedAt || latest.createdAt > doc.updatedAt) {
    await openRestoreDialog(true);
  }
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let dbPromise;

function openDb() {
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("docs")) {
        db.createObjectStore("docs", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("snapshots")) {
        db.createObjectStore("snapshots", { keyPath: "createdAt" });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function dbGet(storeName, key) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readonly");
  const request = tx.objectStore(storeName).get(key);
  const result = await requestToPromise(request);
  await transactionDone(tx);
  return result;
}

async function dbGetAll(storeName) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readonly");
  const request = tx.objectStore(storeName).getAll();
  const result = await requestToPromise(request);
  await transactionDone(tx);
  return result;
}

async function dbPut(storeName, value) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).put(value);
  await transactionDone(tx);
}

async function dbDelete(storeName, key) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).delete(key);
  await transactionDone(tx);
}

async function getSetting(key, fallback) {
  const record = await dbGet("settings", key);
  return record && "value" in record ? record.value : fallback;
}

async function setSetting(key, value) {
  await dbPut("settings", { key, value });
}
