import { firebaseConfig } from "./firebase-config.js";

const FIREBASE_URL = "https://www.gstatic.com/firebasejs/10.14.1";
const SVG_NS = "http://www.w3.org/2000/svg";

// French boulder scale, easiest to hardest.
const GRADES = [
  "2", "3", "4a", "4b", "4c", "5a", "5b", "5c",
  "6a", "6a+", "6b", "6b+", "6c", "6c+",
  "7a", "7a+", "7b", "7b+", "7c", "7c+",
];
const LAST_GRADE = GRADES.length - 1;
// The level filter works on groups of grades (all the 5s, all the 6s...).
const GRADE_GROUPS = [
  { label: "2", from: 0, to: 0 },
  { label: "3", from: 1, to: 1 },
  { label: "4", from: 2, to: 4 },
  { label: "5", from: 5, to: 7 },
  { label: "6", from: 8, to: 13 },
  { label: "7", from: 14, to: 19 },
];
const VOTE_WINDOW = 3; // a vote can differ from the set grade by at most 3 grades

const ADMIN_NAME = "admin"; // always a power user, cannot be removed
const NAME_MAX = 20;
const NAME_STORAGE_KEY = "blocs.name";
const CACHE_KEY = "blocs.cache.boulders";
const REQUEST_TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 3000;
const REFRESH_AFTER_MS = 15000;
const ERROR_NETWORK = "Impossible de joindre la base de données. Vérifie ta connexion et réessaie.";

const state = {
  zones: [],
  boulders: null, // null while nothing is known yet
  zone: "all", // "all" or a zone id (number)
  grade: -1, // grade group filter: index in GRADE_GROUPS, -1 = all grades
  records: null, // { boulderId: { nameKey: { name, vote? } } }, null = not loaded
  lastFetch: 0,
  status: "loading", // "loading" | "ok" | "failed"
  user: "", // signed-in name, "" = guest
  signInThen: null, // action to run once the user has signed in
  currentId: null, // boulder shown in the detail view
  selectedBar: null, // grade index selected in the chart
  voting: false, // the +/- prompt is open
  busy: false, // a record is being written
  power: null, // names of the power users, null = unknown (not loaded)
};

let voteIndex = 0;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to load ${path}`);
  return response.json();
}

/* ---------- No zoom (pinch and double-tap) ---------- */

// The viewport tag and CSS handle most browsers; iOS Safari needs these as well.
document.addEventListener("gesturestart", (event) => event.preventDefault());
document.addEventListener("gesturechange", (event) => event.preventDefault());
document.addEventListener(
  "touchmove",
  (event) => {
    if (event.touches.length > 1) event.preventDefault();
  },
  { passive: false },
);

/* ---------- Grades and their colors ---------- */

function gradeIndex(grade) {
  return GRADES.indexOf(grade);
}

// Blue (easiest) -> green -> yellow -> orange -> red -> purple -> black (hardest).
const GRADE_ANCHORS = ["#2563eb", "#16a34a", "#facc15", "#f97316", "#dc2626", "#7e22ce", "#111111"];

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

const GRADE_STYLES = GRADES.map((_, index) => {
  const position = (index / LAST_GRADE) * (GRADE_ANCHORS.length - 1);
  const segment = Math.min(Math.floor(position), GRADE_ANCHORS.length - 2);
  const t = position - segment;
  const from = hexToRgb(GRADE_ANCHORS[segment]);
  const to = hexToRgb(GRADE_ANCHORS[segment + 1]);
  const [r, g, b] = from.map((channel, i) => Math.round(channel + (to[i] - channel) * t));
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return { bg: `rgb(${r}, ${g}, ${b})`, fg: brightness >= 150 ? "#111827" : "#ffffff" };
});

function gradeChip(grade, extraClass = "") {
  const chip = document.createElement("span");
  chip.className = `chip ${extraClass}`.trim();
  const index = gradeIndex(grade);
  if (index < 0) {
    chip.textContent = "?";
    chip.classList.add("unknown");
  } else {
    chip.textContent = GRADES[index];
    chip.style.background = GRADE_STYLES[index].bg;
    chip.style.color = GRADE_STYLES[index].fg;
  }
  return chip;
}

function voteWindow(baseIndex) {
  return [Math.max(0, baseIndex - VOTE_WINDOW), Math.min(LAST_GRADE, baseIndex + VOTE_WINDOW)];
}

/* ---------- Boulder colors (the holds), stripes for two-color boulders ---------- */

function colorBackground(boulder, stripe) {
  if (!boulder.color2) return boulder.color;
  return `repeating-linear-gradient(45deg, ${boulder.color} 0 ${stripe}px, ${boulder.color2} ${stripe}px ${stripe * 2}px)`;
}

/* ---------- Local storage (remembered name, cached boulder list) ---------- */

function loadName() {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function saveName(name) {
  try {
    localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {
    /* storage unavailable: the name just won't be remembered */
  }
}

function clearName() {
  try {
    localStorage.removeItem(NAME_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

function isValidBoulder(boulder) {
  return (
    boulder &&
    typeof boulder.id === "string" &&
    Number.isInteger(boulder.zone) &&
    typeof boulder.color === "string"
  );
}

function readCache() {
  try {
    const list = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    return Array.isArray(list) ? list.filter(isValidBoulder) : null;
  } catch {
    return null;
  }
}

function writeCache(list) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: no offline copy */
  }
}

/* ---------- Database (Firestore: boulders/all and records/all) ---------- */

let fb = null; // set once the Firebase SDK is loaded

async function connectFirebase() {
  if (fb) return;
  const [appModule, fsModule] = await Promise.all([
    import(`${FIREBASE_URL}/firebase-app.js`),
    import(`${FIREBASE_URL}/firebase-firestore.js`),
  ]);
  const app = appModule.initializeApp(firebaseConfig);
  let db;
  try {
    // Some networks block Firestore's streaming connection: detect it and fall back.
    db = fsModule.initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  } catch {
    db = fsModule.getFirestore(app);
  }
  fb = {
    db,
    enableNetwork: fsModule.enableNetwork,
    disableNetwork: fsModule.disableNetwork,
    boulders: fsModule.doc(db, "boulders", "all"),
    records: fsModule.doc(db, "records", "all"),
    power: fsModule.doc(db, "config", "powerusers"),
    getDoc: fsModule.getDoc,
    setDoc: fsModule.setDoc,
    updateDoc: fsModule.updateDoc,
    deleteField: fsModule.deleteField,
    FieldPath: fsModule.FieldPath,
  };
}

// Cuts and re-opens the Firestore connection (a phone may have silently killed it).
async function resetConnection() {
  if (!fb) return;
  try {
    await withTimeout(
      (async () => {
        await fb.disableNetwork(fb.db);
        await fb.enableNetwork(fb.db);
      })(),
      4000,
    );
  } catch (error) {
    console.error(error);
  }
}

// For writes that are safe to repeat: if the first attempt fails or is too slow,
// the connection is reset and the write is tried once more before giving up.
async function withRetry(makeTask) {
  try {
    return await withTimeout(makeTask(), REQUEST_TIMEOUT_MS);
  } catch (first) {
    console.error(first);
    await resetConnection();
    await sleep(500);
    return withTimeout(makeTask(), REQUEST_TIMEOUT_MS);
  }
}

// The error message, with the technical code in brackets (useful to diagnose problems).
function errorText(error) {
  const code = error && String(error.code || error.message || "").replace(/^firestore\//, "");
  return code ? `${ERROR_NETWORK} (${code})` : ERROR_NETWORK;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function loadStaticBoulders() {
  const data = await loadJson("data/boulders.json");
  return Array.isArray(data) ? data.filter(isValidBoulder) : [];
}

function applyRecordsSnapshot(snapshot) {
  state.records = snapshot.exists() ? snapshot.data() : {};
  state.lastFetch = Date.now();
}

// Reads the boulder list and all records (two document reads).
// If the boulder document does not exist yet, it is created from data/boulders.json.
async function fetchAllUnbounded() {
  await connectFirebase();
  const [boulderSnap, recordsSnap, power] = await Promise.all([
    fb.getDoc(fb.boulders),
    fb.getDoc(fb.records),
    fetchPowerUsers(),
  ]);
  let list;
  if (boulderSnap.exists()) {
    const data = boulderSnap.data();
    list = Array.isArray(data.list) ? data.list.filter(isValidBoulder) : [];
  } else {
    list = await loadStaticBoulders();
    await fb.setDoc(fb.boulders, { list });
  }
  state.boulders = list;
  writeCache(list);
  applyRecordsSnapshot(recordsSnap);
  if (power) state.power = power;
  if (state.status === "failed") {
    state.status = "ok"; // a slow attempt finally succeeded
    syncUI();
  }
}

// The power user list lives in config/powerusers. A failure here (for example the
// security rule not published yet) must not break the rest, so it only returns null.
async function fetchPowerUsers() {
  try {
    const snapshot = await fb.getDoc(fb.power);
    if (!snapshot.exists()) {
      const seed = [ADMIN_NAME];
      await fb.setDoc(fb.power, { list: seed });
      return seed;
    }
    const list = snapshot.data().list;
    return Array.isArray(list) ? list.filter((n) => typeof n === "string") : null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function fetchAll() {
  try {
    await withTimeout(fetchAllUnbounded(), REQUEST_TIMEOUT_MS);
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

// Reads only the records (one document read).
async function fetchRecords() {
  try {
    const snapshot = await withTimeout(
      (async () => {
        await connectFirebase();
        return fb.getDoc(fb.records);
      })(),
      REQUEST_TIMEOUT_MS,
    );
    applyRecordsSnapshot(snapshot);
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

let loadingNow = false;

// The error notice only appears after two failed attempts, never while loading.
async function loadData() {
  if (loadingNow) return;
  loadingNow = true;
  state.status = "loading";
  syncUI();

  let ok = false;
  for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
    ok = await fetchAll();
    if (!ok && attempt === 1) await sleep(RETRY_DELAY_MS);
  }

  if (ok) {
    state.status = "ok";
  } else {
    state.status = "failed";
    if (!state.boulders) {
      try {
        state.boulders = await loadStaticBoulders();
      } catch {
        state.boulders = [];
      }
    }
  }
  loadingNow = false;
  syncUI();
  syncDetailWithHash();
}

let inflight = null;

function refreshRecords() {
  if (inflight) return inflight;
  if (state.records && Date.now() - state.lastFetch < REFRESH_AFTER_MS) return Promise.resolve(true);
  inflight = fetchRecords()
    .then((ok) => {
      syncUI();
      return ok;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function syncUI() {
  $("notice").hidden = state.status !== "failed";
  renderUserBar();
  renderAdmin();
  render();
  if (state.currentId) renderDetail();
  if ($("rank-dialog").open) renderRanking();
}

/* ---------- Names and records (completions and optional votes) ---------- */

function nameKey(name) {
  return `u_${name.normalize("NFC").toLocaleLowerCase("fr")}`;
}

function cleanName(raw) {
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= NAME_MAX ? name : "";
}

function byName(a, b) {
  return a.localeCompare(b, "fr");
}

function recordsInfo(boulderId) {
  if (!state.records) return null;
  const entries = Object.values(state.records[boulderId] || {}).filter((e) => e && typeof e.name === "string");
  const voteCounts = new Array(GRADES.length).fill(0);
  const voters = GRADES.map(() => []);
  let votes = 0;
  for (const entry of entries) {
    const index = gradeIndex(entry.vote);
    if (index >= 0) {
      voteCounts[index] += 1;
      voters[index].push(entry.name);
      votes += 1;
    }
  }
  voters.forEach((list) => list.sort(byName));
  return { done: entries.length, names: entries.map((e) => e.name).sort(byName), voteCounts, voters, votes };
}

// The record of the signed-in user on a boulder, or null (guests have none).
function myEntry(boulderId) {
  if (!state.user || !state.records) return null;
  return (state.records[boulderId] || {})[nameKey(state.user)] || null;
}

function completionText(count) {
  if (count === 0) return "aucune validation";
  return count === 1 ? "1 validation" : `${count} validations`;
}

/* ---------- User: guest or signed in with a name (no password) ---------- */

// If someone already used this name, reuse their capitalization.
function canonicalName(name) {
  const key = nameKey(name);
  for (const entries of Object.values(state.records || {})) {
    const entry = entries && entries[key];
    if (entry && typeof entry.name === "string") return entry.name;
  }
  return name;
}

function renderUserBar() {
  const signedIn = state.user !== "";
  $("user-avatar").textContent = signedIn ? state.user.charAt(0).toUpperCase() : "?";
  $("user-name").textContent = signedIn ? state.user : "Invité";
  $("user-hint").textContent = signedIn ? "" : "Se connecter";
  $("user-hint").hidden = signedIn;
  $("user-stats").hidden = !signedIn;
  if (!signedIn) return;

  const boulders = state.boulders || [];
  let done = 0;
  let hardest = -1;
  if (state.records) {
    for (const boulder of boulders) {
      if (!myEntry(boulder.id)) continue;
      done += 1;
      hardest = Math.max(hardest, gradeIndex(boulder.grade));
    }
  }
  const total = state.boulders ? String(boulders.length) : "–";
  $("stat-count").textContent = `${state.records ? done : "–"}/${total}`;
  $("stat-hardest").replaceChildren(hardest >= 0 ? gradeChip(GRADES[hardest], "header") : "–");
}

function openUserDialog(then = null) {
  state.signInThen = then;
  $("user-title").textContent = state.user ? "Changer de nom" : "Qui es-tu ?";
  $("user-input").value = state.user;
  $("user-signout").hidden = !state.user;
  updateUserForm();
  // The page behind must not move. The input is not focused on open (that would pop
  // up the keyboard, which makes phones scroll); the title takes the focus instead.
  pinScroll($("user-dialog"));
  $("user-dialog").showModal();
}

// Keeps the page where it was while a dialog is open (phone keyboards shift the view).
function pinScroll(dialog) {
  const { scrollX, scrollY } = window;
  const restore = () => {
    if (window.scrollX !== scrollX || window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY);
  };
  const viewport = window.visualViewport;
  window.addEventListener("scroll", restore);
  if (viewport) viewport.addEventListener("resize", restore);
  dialog.addEventListener(
    "close",
    () => {
      window.removeEventListener("scroll", restore);
      if (viewport) viewport.removeEventListener("resize", restore);
    },
    { once: true },
  );
}

function updateUserForm() {
  $("user-submit").disabled = !cleanName($("user-input").value);
}

async function onUserSubmit(event) {
  event.preventDefault();
  const name = cleanName($("user-input").value);
  if (!name) return;
  const then = state.signInThen;
  state.user = canonicalName(name);
  saveName(state.user);
  state.voting = false;
  $("user-dialog").close();
  syncUI();
  if (then === "complete") await completeBoulder();
}

function signOut() {
  state.user = "";
  state.voting = false;
  clearName();
  $("user-dialog").close();
  syncUI();
}

/* ---------- Ranking of all users ---------- */

// One row per user with at least one completed boulder: count and hardest set grade.
function computeRanking() {
  const rows = new Map();
  for (const boulder of state.boulders || []) {
    const grade = gradeIndex(boulder.grade);
    for (const [key, entry] of Object.entries((state.records || {})[boulder.id] || {})) {
      if (!entry || typeof entry.name !== "string") continue;
      const row = rows.get(key) || { key, name: entry.name, count: 0, hardest: -1 };
      row.count += 1;
      row.hardest = Math.max(row.hardest, grade);
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || b.hardest - a.hardest || byName(a.name, b.name));
}

function renderRanking() {
  const rows = computeRanking();
  $("rank-empty").hidden = rows.length > 0;
  $("rank-body").replaceChildren(
    ...rows.map((row, index) => {
      const tr = document.createElement("tr");
      tr.classList.toggle("me", !!state.user && row.key === nameKey(state.user));
      const cells = [String(index + 1), row.name, String(row.count)].map((text) => {
        const td = document.createElement("td");
        td.textContent = text;
        return td;
      });
      cells[1].className = "rank-name";
      const hardest = document.createElement("td");
      hardest.appendChild(row.hardest >= 0 ? gradeChip(GRADES[row.hardest], "small") : "–");
      tr.append(...cells, hardest);
      return tr;
    }),
  );
}

/* ---------- Deleting a user (power users): erases all of their records ---------- */

let userDelConfirmKey = null; // user whose deletion is awaiting confirmation
let userDelBusy = false;

function openUserDelete() {
  if (!canManage()) return;
  userDelConfirmKey = null;
  $("userdel-error").textContent = "";
  pinScroll($("userdel-dialog"));
  renderUserDelete();
  $("userdel-dialog").showModal();
}

function renderUserDelete() {
  const rows = computeRanking().sort((a, b) => byName(a.name, b.name));
  $("userdel-empty").hidden = rows.length > 0;
  const items = rows.flatMap((row) => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "power-name";
    label.textContent = `${row.name} (${row.count})`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn small danger";
    button.textContent = "Supprimer";
    button.disabled = userDelBusy;
    button.setAttribute("aria-label", `Supprimer ${row.name}`);
    button.addEventListener("click", () => {
      userDelConfirmKey = row.key;
      $("userdel-error").textContent = "";
      renderUserDelete();
    });
    li.append(label, button);
    if (userDelConfirmKey !== row.key) return [li];

    const confirm = document.createElement("li");
    confirm.className = "userdel-confirm";
    const message = document.createElement("p");
    message.className = "delete-warning";
    message.textContent = `Effacer ${row.name} et toutes ses validations et avis ?`;
    const actions = document.createElement("div");
    actions.className = "actions";
    const no = document.createElement("button");
    no.type = "button";
    no.className = "btn secondary";
    no.textContent = "Non";
    no.disabled = userDelBusy;
    no.addEventListener("click", () => {
      userDelConfirmKey = null;
      renderUserDelete();
    });
    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "btn danger";
    yes.textContent = "Effacer";
    yes.disabled = userDelBusy;
    yes.addEventListener("click", () => deleteUserRecords(row.key));
    actions.append(no, yes);
    confirm.append(message, actions);
    return [li, confirm];
  });
  $("userdel-list").replaceChildren(...items);
}

async function deleteUserRecords(key) {
  if (userDelBusy || !canManage()) return;
  userDelBusy = true;
  renderUserDelete();
  try {
    await withRetry(() =>
      (async () => {
        await connectFirebase();
        const snapshot = await fb.getDoc(fb.records);
        const data = snapshot.exists() ? snapshot.data() : {};
        const args = [];
        for (const [boulderId, entries] of Object.entries(data)) {
          if (entries && entries[key]) args.push(new fb.FieldPath(boulderId, key), fb.deleteField());
        }
        if (args.length) await fb.updateDoc(fb.records, ...args);
        // Mirror the fresh copy locally.
        const local = {};
        for (const [boulderId, entries] of Object.entries(data)) {
          const { [key]: removed, ...rest } = entries || {};
          local[boulderId] = rest;
        }
        state.records = local;
        state.lastFetch = Date.now();
      })(),
    );
    userDelConfirmKey = null;
    flashStatus("Utilisateur supprimé.", "admin-status");
  } catch (error) {
    console.error(error);
    userDelConfirmKey = null;
    $("userdel-error").textContent = errorText(error);
  } finally {
    userDelBusy = false;
    syncUI();
    if ($("userdel-dialog").open) renderUserDelete();
  }
}

function openRanking() {
  renderRanking();
  $("rank-dialog").showModal();
  refreshRecords().then(() => {
    if ($("rank-dialog").open) renderRanking();
  });
}

/* ---------- Coming back to the page: reconnect before the user acts ---------- */

const RESUME_MIN_AWAY_MS = 3000; // shorter absences are ignored
const RESUME_RESET_AFTER_MS = 30000; // after this long, the connection is reset first
let hiddenAt = 0;
let resuming = false;

async function onResume(forceReset = false) {
  if (resuming || loadingNow) return;
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  if (!forceReset && away < RESUME_MIN_AWAY_MS) return;
  resuming = true;
  try {
    if (state.status === "failed") {
      if (fb) await loadData(); // otherwise the "Réessayer" button reloads the page
      return;
    }
    if (fb && !state.busy && !inflight && (forceReset || away > RESUME_RESET_AFTER_MS)) await resetConnection();
    state.lastFetch = 0; // a small read re-opens the connection and refreshes the records
    await refreshRecords();
  } finally {
    resuming = false;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) hiddenAt = Date.now();
  else onResume();
});
window.addEventListener("online", () => onResume(true));
window.addEventListener("pageshow", (event) => {
  if (event.persisted) onResume(true);
});

/* ---------- Init ---------- */

async function init() {
  try {
    const zoneData = await loadJson("data/zones.json");
    state.zones = zoneData.zones;
    state.boulders = readCache();
    state.user = cleanName(loadName());
    buildMap(zoneData);
    buildGradeControls();
    bindUI();
    window.addEventListener("hashchange", syncDetailWithHash);
    syncUI();
    syncDetailWithHash();
    loadData();
  } catch (error) {
    console.error(error);
    $("loading").hidden = false;
    $("loading").textContent = "Impossible de charger l'application.";
  }
}

/* ---------- Map ---------- */

function buildMap(zoneData) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", zoneData.viewBox);
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", "Plan de la salle avec les quatre zones");

  const entries = [
    { key: "all", area: zoneData.all, onSelect: () => selectAll() },
    ...state.zones.map((zone) => ({ key: String(zone.id), area: zone, onSelect: () => setZone(zone.id) })),
  ];

  for (const { key, area, onSelect } of entries) {
    const polygon = document.createElementNS(SVG_NS, "polygon");
    polygon.setAttribute("points", area.points.map((p) => p.join(",")).join(" "));
    polygon.setAttribute("class", "zone");
    polygon.setAttribute("data-zone", key);
    polygon.setAttribute("role", "button");
    polygon.setAttribute("tabindex", "0");
    polygon.setAttribute("aria-label", key === "all" ? "Toutes les zones" : area.name);
    polygon.addEventListener("click", onSelect);
    polygon.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect();
      }
    });
    svg.appendChild(polygon);

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", area.label[0]);
    label.setAttribute("y", area.label[1]);
    label.setAttribute("class", "zone-label");
    label.textContent = area.name;
    svg.appendChild(label);
  }
  $("map").appendChild(svg);
}

function selectAll() {
  state.zone = "all";
  render();
}

function setZone(zone) {
  // Tapping the already selected zone goes back to "all".
  state.zone = state.zone === zone ? "all" : zone;
  render();
}

/* ---------- Level filter ---------- */

function buildGradeControls() {
  $("grade-up").addEventListener("click", () => {
    state.grade = Math.min(GRADE_GROUPS.length - 1, state.grade + 1);
    render();
  });
  $("grade-down").addEventListener("click", () => {
    state.grade = Math.max(-1, state.grade - 1);
    render();
  });
  $("reset-grade").addEventListener("click", () => {
    state.grade = -1;
    render();
  });
}

function renderGradeFilter() {
  if (state.grade < 0) {
    const chip = document.createElement("span");
    chip.className = "chip big all";
    chip.textContent = "Tous";
    $("grade-value").replaceChildren(chip);
  } else {
    // The chip takes the color of the middle grade of the group, but shows only the number.
    const group = GRADE_GROUPS[state.grade];
    const chip = gradeChip(GRADES[Math.floor((group.from + group.to) / 2)], "big");
    chip.textContent = group.label;
    $("grade-value").replaceChildren(chip);
  }
  $("grade-down").disabled = state.grade < 0;
  $("grade-up").disabled = state.grade >= GRADE_GROUPS.length - 1;
  $("reset-grade").disabled = state.grade < 0;
}

/* ---------- List ---------- */

function zoneName(id) {
  const zone = state.zones.find((z) => z.id === id);
  return zone ? zone.name : `Zone ${id}`;
}

function visibleBoulders() {
  return state.boulders
    .filter((boulder) => state.zone === "all" || boulder.zone === state.zone)
    .filter((boulder) => {
      if (state.grade < 0) return true;
      const index = gradeIndex(boulder.grade);
      return index >= GRADE_GROUPS[state.grade].from && index <= GRADE_GROUPS[state.grade].to;
    })
    .sort((a, b) => {
      const gradeA = gradeIndex(a.grade) < 0 ? 99 : gradeIndex(a.grade);
      const gradeB = gradeIndex(b.grade) < 0 ? 99 : gradeIndex(b.grade);
      return gradeA - gradeB || a.zone - b.zone || a.id.localeCompare(b.id);
    });
}

function render() {
  renderGradeFilter();

  for (const polygon of document.querySelectorAll(".zone")) {
    const active = polygon.dataset.zone === String(state.zone);
    polygon.classList.toggle("active", active);
    polygon.setAttribute("aria-pressed", String(active));
  }

  const loading = state.boulders === null;
  $("loading").hidden = !loading;
  if (loading) {
    $("count").textContent = "";
    $("empty").hidden = true;
    $("list").replaceChildren();
    return;
  }

  const items = visibleBoulders();
  $("count").textContent = `(${items.length})`;
  $("empty").hidden = items.length > 0;
  $("empty").textContent = "Aucun bloc ne correspond à ces filtres.";
  $("list").replaceChildren(...items.map(renderItem));
}

function renderItem(boulder) {
  const info = recordsInfo(boulder.id);

  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "item";
  button.addEventListener("click", () => openDetail(boulder.id));

  const zone = document.createElement("span");
  zone.className = "zone-badge";
  const zoneLabel = document.createElement("small");
  zoneLabel.textContent = "zone";
  const zoneNumber = document.createElement("strong");
  zoneNumber.textContent = String(boulder.zone);
  zone.append(zoneLabel, zoneNumber);

  const swatch = document.createElement("span");
  swatch.className = "swatch";
  swatch.style.background = colorBackground(boulder, 6);
  if (myEntry(boulder.id)) {
    const mark = document.createElement("span");
    mark.className = "done-mark";
    mark.textContent = "✓";
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", "Validé");
    swatch.appendChild(mark);
  }

  const main = document.createElement("span");
  main.className = "item-main";
  const title = document.createElement("div");
  title.className = "item-title";
  title.textContent = boulder.colorName;
  const sub = document.createElement("div");
  sub.className = "item-sub";
  sub.textContent = info ? completionText(info.done) : "";
  main.append(title, sub);

  button.append(zone, swatch, main, gradeChip(boulder.grade));
  li.appendChild(button);
  return li;
}

/* ---------- Detail view ---------- */

function openDetail(id) {
  if (location.hash.slice(1) !== id) {
    location.hash = id; // triggers hashchange -> syncDetailWithHash
  } else {
    syncDetailWithHash();
  }
}

function closeDetail() {
  const dialog = $("detail");
  if (dialog.open) dialog.close();
}

function onDetailClosed() {
  // The "close" event arrives asynchronously: if another boulder was opened in
  // the meantime, this cleanup must not touch it.
  if ($("detail").open) return;
  const closedId = state.currentId;
  if ($("player").open) $("player").close();
  if ($("done-dialog").open) $("done-dialog").close();
  $("beta-videos").replaceChildren();
  $("record-status").textContent = "";
  $("record-error").textContent = "";
  state.currentId = null;
  state.selectedBar = null;
  state.voting = false;
  if (location.hash && decodeURIComponent(location.hash.slice(1)) === closedId) {
    history.replaceState(null, "", location.pathname + location.search);
  }
}

function currentBoulder() {
  return (state.boulders || []).find((b) => b.id === state.currentId);
}

function syncDetailWithHash() {
  const dialog = $("detail");
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) {
    if (dialog.open) dialog.close();
    return;
  }
  if (!state.boulders) return; // list not loaded yet; called again once it is
  const boulder = state.boulders.find((b) => b.id === id);
  if (!boulder) {
    if (dialog.open) dialog.close();
    return;
  }
  const fresh = state.currentId !== boulder.id || !dialog.open;
  state.currentId = boulder.id;
  if (fresh) {
    state.selectedBar = null;
    state.voting = false;
    $("record-status").textContent = "";
    $("record-error").textContent = "";
    fillDetailStatic(boulder);
  }
  renderDetail();
  if (!dialog.open) dialog.showModal();
  refreshRecords();
}

// The parts of the detail view that only change when the boulder itself changes.
function fillDetailStatic(boulder) {
  $("detail-title").textContent = `${boulder.colorName} - ${zoneName(boulder.zone)}`;
  $("detail-photo").replaceChildren(buildPhoto(boulder));
  fillBeta(boulder, zoneName(boulder.zone));
}

function renderDetail() {
  const boulder = currentBoulder();
  if (!boulder) return;
  renderMeta(boulder);
  renderDone(boulder);
  renderVotes(boulder);
}

function renderMeta(boulder) {
  const parts = [gradeChip(boulder.grade, "big")];
  if (boulder.setter) {
    const setter = document.createElement("span");
    setter.className = "setter";
    setter.textContent = `Ouvert par ${boulder.setter}`;
    parts.push(setter);
  }
  $("detail-meta").replaceChildren(...parts);
}

function buildPhoto(boulder) {
  const fallback = () => {
    const div = document.createElement("div");
    div.className = "photo-missing";
    div.style.background = colorBackground(boulder, 14);
    div.textContent = "Photo à venir";
    return div;
  };
  // An empty value or a bare folder ("photos/") means no photo yet.
  if (!boulder.photo || boulder.photo.endsWith("/")) return fallback();

  const img = document.createElement("img");
  img.src = boulder.photo;
  img.alt = `Bloc ${boulder.colorName}, ${zoneName(boulder.zone)}`;
  img.addEventListener("error", () => img.replaceWith(fallback()));
  return img;
}

/* ---------- Completions: one tap to complete, then grade or cancel ---------- */

function renderDone(boulder) {
  const info = recordsInfo(boulder.id);
  const toggle = $("done-toggle");
  toggle.textContent = info ? String(info.done) : "–";
  toggle.disabled = !info || info.done === 0;
  toggle.setAttribute("aria-label", info ? `${completionText(info.done)}, voir la liste` : "Validations");
  if ($("done-dialog").open) renderDoneList(boulder);

  const mine = myEntry(boulder.id);
  const base = gradeIndex(boulder.grade);
  const hasVote = mine && gradeIndex(mine.vote) >= 0;

  const myRecord = $("my-record");
  if (mine) {
    myRecord.textContent = `Validé${hasVote ? ` · ${mine.vote}` : ""}`;
    myRecord.hidden = false;
  } else {
    myRecord.hidden = true;
  }

  if (!mine) state.voting = false;
  $("btn-complete").hidden = !!mine;
  $("btn-complete").disabled = state.busy;
  $("completed-actions").hidden = !mine || state.voting;
  $("btn-grade").hidden = base < 0;
  $("btn-grade").disabled = state.busy;
  $("btn-cancel").disabled = state.busy;
  renderVotePrompt(boulder, mine);
}

// Pop-up list of the climbers who validated the boulder, with their opinion if any.
function renderDoneList(boulder) {
  const entries = Object.values((state.records || {})[boulder.id] || {}).filter((e) => e && typeof e.name === "string");
  entries.sort((a, b) => byName(a.name, b.name));
  const me = state.user ? nameKey(state.user) : null;
  $("done-list").replaceChildren(
    ...entries.map((entry) => {
      const li = document.createElement("li");
      li.classList.toggle("me", nameKey(entry.name) === me);
      const name = document.createElement("span");
      name.className = "power-name";
      name.textContent = entry.name;
      li.appendChild(name);
      if (gradeIndex(entry.vote) >= 0) {
        const chip = gradeChip(entry.vote, "small");
        chip.classList.add("inline");
        li.appendChild(chip);
      }
      return li;
    }),
  );
}

function renderVotePrompt(boulder, mine) {
  const base = gradeIndex(boulder.grade);
  const show = state.voting && mine && base >= 0;
  $("vote-prompt").hidden = !show;
  if (!show) return;

  const [low, high] = voteWindow(base);
  voteIndex = Math.min(high, Math.max(low, voteIndex));
  $("step-value").replaceChildren(gradeChip(GRADES[voteIndex], "big"));
  $("step-down").disabled = state.busy || voteIndex <= low;
  $("step-up").disabled = state.busy || voteIndex >= high;
  $("step-hint").textContent =
    voteIndex === base
      ? `Même niveau que le bloc (${boulder.grade})`
      : voteIndex < base
        ? `Plus facile que le bloc (${boulder.grade})`
        : `Plus dur que le bloc (${boulder.grade})`;
  $("vote-submit").disabled = state.busy;
  $("vote-close").disabled = state.busy;
  $("vote-remove").hidden = gradeIndex(mine.vote) < 0;
  $("vote-remove").disabled = state.busy;
}

async function completeBoulder() {
  const boulder = currentBoulder();
  if (!boulder) return;
  if (!state.user) {
    openUserDialog("complete"); // a record needs a name
    return;
  }
  if (myEntry(boulder.id)) {
    renderDetail(); // already completed under this name
    return;
  }
  await writeRecord(boulder.id, "complete");
}

function openVotePrompt() {
  const boulder = currentBoulder();
  const mine = boulder && myEntry(boulder.id);
  if (!mine) return;
  const existing = gradeIndex(mine.vote);
  voteIndex = existing >= 0 ? existing : Math.max(0, gradeIndex(boulder.grade));
  state.voting = true;
  renderDetail();
}

function stepVote(delta) {
  voteIndex += delta;
  renderDetail();
}

// action: "complete" | "vote" | "unvote" | "cancel". No confirmation is asked.
async function writeRecord(boulderId, action, vote = null) {
  if (state.busy || !state.user) return;
  const name = state.user;
  const key = nameKey(name);
  state.busy = true;
  $("record-error").textContent = "";
  $("record-status").textContent = "";
  renderDetail();
  try {
    if (!state.records && !(await fetchRecords())) throw new Error("records unavailable");
    await withRetry(() =>
      (async () => {
        await connectFirebase();
        const entryPath = (...rest) => new fb.FieldPath(boulderId, key, ...rest);
        if (action === "complete") {
          await fb.setDoc(fb.records, { [boulderId]: { [key]: { name } } }, { merge: true });
        } else if (action === "vote") {
          await fb.setDoc(fb.records, { [boulderId]: { [key]: { name, vote } } }, { merge: true });
        } else if (action === "unvote") {
          await fb.updateDoc(fb.records, entryPath("vote"), fb.deleteField());
        } else if (action === "cancel") {
          await fb.updateDoc(fb.records, entryPath(), fb.deleteField());
        }
      })(),
    );

    const entries = { ...(state.records[boulderId] || {}) };
    if (action === "complete") {
      entries[key] = { ...(entries[key] || {}), name };
    } else if (action === "vote") {
      entries[key] = { name, vote };
    } else if (action === "unvote") {
      const entry = { ...(entries[key] || { name }) };
      delete entry.vote;
      entries[key] = entry;
    } else if (action === "cancel") {
      delete entries[key];
    }
    state.records = { ...state.records, [boulderId]: entries };
    if (action !== "complete") state.voting = false;
  } catch (error) {
    console.error(error);
    $("record-error").textContent = errorText(error);
  } finally {
    state.busy = false;
    syncUI();
  }
}

let statusTimer = null;

function flashStatus(message, target = "record-status") {
  $(target).textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    $(target).textContent = "";
  }, 3000);
}

/* ---------- Votes chart (window of +/-3 grades around the set grade) ---------- */

function renderVotes(boulder) {
  const base = gradeIndex(boulder.grade);
  $("votes-panel").hidden = base < 0;
  if (base < 0) return;

  const info = recordsInfo(boulder.id);
  const [low, high] = voteWindow(base);
  const counts = info ? info.voteCounts : GRADES.map(() => 0);
  const tallest = Math.max(1, ...counts.slice(low, high + 1));

  const columns = [];
  for (let index = low; index <= high; index++) {
    const count = counts[index];
    const column = document.createElement("button");
    column.type = "button";
    column.className = "bar-col";
    column.classList.toggle("selected", state.selectedBar === index);
    column.classList.toggle("base", index === base);
    column.setAttribute("aria-pressed", String(state.selectedBar === index));
    column.setAttribute("aria-label", `Niveau ${GRADES[index]} : ${count} avis`);
    column.addEventListener("click", () => {
      state.selectedBar = state.selectedBar === index ? null : index;
      renderVotes(boulder);
    });

    const countLabel = document.createElement("span");
    countLabel.className = "bar-count";
    countLabel.textContent = count > 0 ? String(count) : "";

    const track = document.createElement("span");
    track.className = "bar-track";
    const fill = document.createElement("span");
    fill.className = "bar-fill";
    fill.style.background = GRADE_STYLES[index].bg;
    fill.style.height = count > 0 ? `${Math.max(10, (count / tallest) * 100)}%` : "3px";
    track.appendChild(fill);

    const tag = document.createElement("span");
    tag.className = "bar-tag";
    tag.textContent = index === base ? "bloc" : "";

    column.append(countLabel, track, gradeChip(GRADES[index], "small"), tag);
    columns.push(column);
  }
  const chart = $("chart");
  chart.style.gridTemplateColumns = `repeat(${columns.length}, 1fr)`;
  chart.replaceChildren(...columns);

  const voters = $("voters");
  if (!info) {
    voters.textContent = state.status === "failed" ? "Avis indisponibles pour le moment." : "";
  } else if (state.selectedBar !== null) {
    const list = info.voters[state.selectedBar];
    voters.textContent = list.length
      ? `${GRADES[state.selectedBar]} : ${list.join(", ")}`
      : `Personne n'a donné l'avis ${GRADES[state.selectedBar]}.`;
  } else {
    voters.textContent = info.votes === 0 ? "Pas encore d'avis." : info.votes === 1 ? "1 avis." : `${info.votes} avis.`;
  }
}

/* ---------- Event bindings ---------- */

function bindUI() {
  $("close").addEventListener("click", closeDetail);
  $("detail").addEventListener("close", onDetailClosed);
  // A failed download of the Firebase library is remembered by the browser until
  // the page reloads, so in that case "Réessayer" reloads the page.
  $("retry").addEventListener("click", () => {
    if (fb) loadData();
    else location.reload();
  });

  $("player-close").addEventListener("click", () => $("player").close());
  $("player").addEventListener("close", () => $("player-frame").replaceChildren());

  $("user-btn").addEventListener("click", () => openUserDialog());
  $("user-stats").addEventListener("click", openRanking);
  $("rank-close").addEventListener("click", () => $("rank-dialog").close());
  $("user-input").addEventListener("input", updateUserForm);
  $("user-form").addEventListener("submit", onUserSubmit);
  $("user-cancel").addEventListener("click", () => $("user-dialog").close());
  $("user-signout").addEventListener("click", signOut);
  $("user-dialog").addEventListener("close", () => {
    state.signInThen = null;
  });

  $("done-toggle").addEventListener("click", () => {
    const boulder = currentBoulder();
    if (!boulder) return;
    renderDoneList(boulder);
    $("done-dialog").showModal();
  });
  $("done-close").addEventListener("click", () => $("done-dialog").close());
  $("done-dialog").addEventListener("click", (event) => {
    if (event.target === $("done-dialog")) $("done-dialog").close(); // tap outside
  });
  $("btn-complete").addEventListener("click", completeBoulder);
  $("btn-grade").addEventListener("click", openVotePrompt);
  $("btn-cancel").addEventListener("click", () => state.currentId && writeRecord(state.currentId, "cancel"));
  $("step-down").addEventListener("click", () => stepVote(-1));
  $("step-up").addEventListener("click", () => stepVote(1));
  $("vote-close").addEventListener("click", () => {
    state.voting = false;
    renderDetail();
  });
  $("vote-submit").addEventListener("click", () => {
    if (state.currentId) writeRecord(state.currentId, "vote", GRADES[voteIndex]);
  });
  $("vote-remove").addEventListener("click", () => state.currentId && writeRecord(state.currentId, "unvote"));

  bindManagement();
}

/* ---------- Beta (videos) ---------- */

function fillBeta(boulder, zone) {
  const ids = (boulder.videos || []).map(extractYouTubeId).filter(Boolean);

  $("beta-videos").replaceChildren(...ids.map((id, index) => buildThumb(id, index + 1)));
  $("beta-empty").hidden = ids.length > 0;

  const message = `Beta pour le bloc ${boulder.colorName} - ${zone} (${boulder.id}) : `;
  $("beta-submit").href = `https://wa.me/?text=${encodeURIComponent(message)}`;
}

function buildThumb(videoId, number) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "thumb";
  button.setAttribute("aria-label", `Regarder la vidéo ${number} en plein écran`);

  const img = document.createElement("img");
  img.src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  img.alt = "";
  img.loading = "lazy";
  img.addEventListener("error", () => img.remove());

  const play = document.createElement("span");
  play.className = "play";

  button.append(img, play);
  button.addEventListener("click", () => openPlayer(videoId));
  return button;
}

function openPlayer(videoId) {
  const iframe = document.createElement("iframe");
  iframe.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&playsinline=1&rel=0`;
  iframe.title = "Vidéo de résolution du bloc";
  iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  iframe.allowFullscreen = true;
  $("player-frame").replaceChildren(iframe);
  $("player").showModal();
}

function extractYouTubeId(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    let id = null;
    if (parsed.hostname === "youtu.be") {
      id = parsed.pathname.slice(1);
    } else if (parsed.hostname.endsWith("youtube.com")) {
      id = parsed.searchParams.get("v") || parsed.pathname.split("/").pop();
    }
    return id && /^[\w-]{6,}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/* ---------- Power users and boulder management ---------- */

// Power users only see the management buttons. This is not a security measure:
// the database rules stay open, as for everything else on this site.

function isPowerUser() {
  if (!state.user || !state.power) return false;
  const key = nameKey(state.user);
  return state.power.some((name) => nameKey(name) === key);
}

function canManage() {
  return isPowerUser() && state.status === "ok";
}

function renderAdmin() {
  const allowed = canManage();
  $("admin-section").hidden = !allowed;
  $("detail-admin").hidden = !allowed;
}

// Read-modify-write on the freshest copy of a document, so two editors rarely clash.
// With { retry: false } (adding a boulder) a failed attempt is never repeated, because the
// first one may still arrive and the boulder would be added twice.
async function mutateBoulders(change, { retry = true } = {}) {
  const run = retry ? withRetry : (makeTask) => withTimeout(makeTask(), REQUEST_TIMEOUT_MS);
  return run(() =>
    (async () => {
      await connectFirebase();
      const snapshot = await fb.getDoc(fb.boulders);
      const data = snapshot.exists() ? snapshot.data() : null;
      const current = data && Array.isArray(data.list) ? data.list.filter(isValidBoulder) : state.boulders || [];
      const result = change(current);
      await fb.setDoc(fb.boulders, { list: result.list });
      return result;
    })(),
  );
}

async function mutatePower(change) {
  return withRetry(() =>
    (async () => {
      await connectFirebase();
      const snapshot = await fb.getDoc(fb.power);
      const data = snapshot.exists() ? snapshot.data() : null;
      const current = data && Array.isArray(data.list) ? data.list.filter((n) => typeof n === "string") : [ADMIN_NAME];
      let list = change(current);
      if (!list.some((name) => nameKey(name) === nameKey(ADMIN_NAME))) list = [ADMIN_NAME, ...list];
      await fb.setDoc(fb.power, { list });
      return list;
    })(),
  );
}

/* --- Power user list --- */

let powerBusy = false;

function openPowerDialog() {
  if (!canManage()) return;
  pinScroll($("power-dialog"));
  $("power-error").textContent = "";
  $("power-input").value = "";
  updatePowerForm();
  renderPowerList();
  $("power-dialog").showModal();
}

function updatePowerForm() {
  $("power-add").disabled = powerBusy || !cleanName($("power-input").value);
}

function renderPowerList() {
  const rows = (state.power || []).map((name) => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "power-name";
    label.textContent = name;
    li.appendChild(label);
    if (nameKey(name) === nameKey(ADMIN_NAME)) {
      const fixed = document.createElement("small");
      fixed.textContent = "toujours présent";
      li.appendChild(fixed);
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn small danger";
      button.textContent = "Retirer";
      button.disabled = powerBusy;
      button.setAttribute("aria-label", `Retirer ${name}`);
      button.addEventListener("click", () => removePowerUser(name));
      li.appendChild(button);
    }
    return li;
  });
  $("power-list").replaceChildren(...rows);
}

async function changePowerList(change) {
  powerBusy = true;
  $("power-error").textContent = "";
  renderPowerList();
  updatePowerForm();
  try {
    state.power = await mutatePower(change);
    $("power-input").value = "";
  } catch (error) {
    console.error(error);
    $("power-error").textContent = errorText(error);
  } finally {
    powerBusy = false;
    renderPowerList();
    updatePowerForm();
    syncUI();
    if (!canManage() && $("power-dialog").open) $("power-dialog").close(); // removed oneself
  }
}

async function addPowerUser(event) {
  event.preventDefault();
  const name = cleanName($("power-input").value);
  if (!name || powerBusy) return;
  if ((state.power || []).some((n) => nameKey(n) === nameKey(name))) {
    $("power-error").textContent = "Ce nom est déjà dans la liste.";
    return;
  }
  await changePowerList((list) => (list.some((n) => nameKey(n) === nameKey(name)) ? list : [...list, name]));
}

async function removePowerUser(name) {
  if (powerBusy || nameKey(name) === nameKey(ADMIN_NAME)) return;
  await changePowerList((list) => list.filter((n) => nameKey(n) !== nameKey(name)));
}

/* --- Boulder form (add and edit) --- */

const DEFAULT_COLOR = "#e53935";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const formState = { mode: "add", id: null, photo: "", videos: [], busy: false };

function openBoulderForm(boulder) {
  if (!canManage()) return;
  const editing = !!boulder;
  formState.mode = editing ? "edit" : "add";
  formState.id = editing ? boulder.id : null;
  formState.busy = false;
  formState.photo = editing ? boulder.photo || "" : "";
  formState.videos = editing ? [...(boulder.videos || [])] : [];

  $("boulder-title").textContent = editing ? "Modifier le bloc" : "Nouveau bloc";
  $("f-zone").value = String(editing ? boulder.zone : typeof state.zone === "number" ? state.zone : 1);
  $("f-grade").value = editing && gradeIndex(boulder.grade) >= 0 ? boulder.grade : "5a";
  $("f-color").value = editing && HEX_COLOR.test(boulder.color) ? boulder.color.toLowerCase() : DEFAULT_COLOR;
  $("f-colorname").value = editing ? boulder.colorName || "" : "";
  const two = editing && !!boulder.color2;
  $("f-two").checked = two;
  $("f-color2").value = two && HEX_COLOR.test(boulder.color2) ? boulder.color2.toLowerCase() : "#ffffff";
  $("f-color2-row").hidden = !two;
  $("f-setter").value = editing ? boulder.setter || "" : "";
  $("boulder-error").textContent = "";
  $("photo-picker").hidden = true;
  $("delete-zone").hidden = !editing;
  $("delete-confirm").hidden = true;
  $("boulder-delete").hidden = false;
  renderPhotoPreview();
  renderVideoFields();
  setFormBusy(false);
  $("boulder-dialog").showModal();
}

function setFormBusy(busy) {
  formState.busy = busy;
  for (const id of ["boulder-save", "boulder-cancel", "boulder-delete", "delete-yes", "delete-no"]) {
    $(id).disabled = busy;
  }
}

function renderPhotoPreview() {
  const box = $("f-photo-preview");
  $("f-photo-clear").hidden = !formState.photo;
  if (!formState.photo) {
    box.className = "photo-preview empty";
    box.textContent = "Aucune photo";
    return;
  }
  box.className = "photo-preview";
  const img = document.createElement("img");
  img.src = formState.photo;
  img.alt = "";
  img.addEventListener("error", () => img.remove());
  const path = document.createElement("small");
  path.textContent = formState.photo;
  box.replaceChildren(img, path);
}

let photoIndexPromise = null;

// photos/index.json is a list of file names, kept by hand (GitHub Pages cannot list a folder).
function loadPhotoIndex() {
  if (!photoIndexPromise) {
    photoIndexPromise = loadJson("photos/index.json")
      .then((list) => (Array.isArray(list) ? list.filter((n) => typeof n === "string" && n && !n.includes("..")) : []))
      .catch((error) => {
        photoIndexPromise = null;
        throw error;
      });
  }
  return photoIndexPromise;
}

async function togglePhotoPicker() {
  const picker = $("photo-picker");
  if (!picker.hidden) {
    picker.hidden = true;
    return;
  }
  picker.hidden = false;
  picker.textContent = "Chargement…";
  try {
    const names = await loadPhotoIndex();
    if (names.length === 0) {
      picker.textContent = "Aucune photo dans photos/index.json.";
      return;
    }
    const buttons = names.map((name) => {
      const path = `photos/${name}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "photo-choice";
      button.classList.toggle("selected", path === formState.photo);
      button.setAttribute("aria-label", name);
      const img = document.createElement("img");
      img.src = path;
      img.alt = "";
      img.loading = "lazy";
      const label = document.createElement("small");
      label.textContent = name;
      button.append(img, label);
      button.addEventListener("click", () => {
        formState.photo = path;
        picker.hidden = true;
        renderPhotoPreview();
      });
      return button;
    });
    picker.replaceChildren(...buttons);
  } catch (error) {
    console.error(error);
    picker.textContent = "Liste des photos introuvable (photos/index.json).";
  }
}

function renderVideoFields() {
  const rows = formState.videos.map((url, index) => {
    const row = document.createElement("div");
    row.className = "video-row";
    const input = document.createElement("input");
    input.type = "url";
    input.value = url;
    input.placeholder = "https://www.youtube.com/watch?v=…";
    input.setAttribute("aria-label", `Lien de la vidéo ${index + 1}`);
    input.autocapitalize = "off";
    input.addEventListener("input", () => {
      formState.videos[index] = input.value;
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn small danger";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Retirer la vidéo ${index + 1}`);
    remove.addEventListener("click", () => {
      formState.videos.splice(index, 1);
      renderVideoFields();
    });
    row.append(input, remove);
    return row;
  });
  $("f-videos").replaceChildren(...rows);
}

function nextBoulderId(list, zone) {
  const pattern = new RegExp(`^z${zone}-(\\d+)$`);
  let max = 0;
  for (const boulder of list) {
    const match = pattern.exec(boulder.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  let number = max + 1;
  let id;
  do {
    id = `z${zone}-${String(number).padStart(2, "0")}`;
    number += 1;
  } while (list.some((boulder) => boulder.id === id));
  return id;
}

// Reads and checks the form. Returns { error } or { fields }.
function readBoulderForm() {
  const colorName = $("f-colorname").value.replace(/\s+/g, " ").trim();
  if (!colorName) return { error: "Donne un nom à la couleur (ex. Rouge)." };

  const videos = [];
  for (const raw of formState.videos) {
    const url = raw.trim();
    if (!url) continue;
    if (!extractYouTubeId(url)) return { error: `Lien YouTube non reconnu : ${url}` };
    videos.push(url);
  }

  const fields = {
    color: $("f-color").value.toLowerCase(),
    colorName,
    zone: Number($("f-zone").value),
    grade: $("f-grade").value,
    setter: $("f-setter").value.replace(/\s+/g, " ").trim(),
    photo: formState.photo,
    videos,
  };
  if ($("f-two").checked) fields.color2 = $("f-color2").value.toLowerCase();
  return { fields };
}

async function saveBoulder(event) {
  event.preventDefault();
  if (formState.busy || !canManage()) return;
  const { fields, error } = readBoulderForm();
  const errorBox = $("boulder-error");
  errorBox.textContent = error || "";
  if (error) return;

  setFormBusy(true);
  try {
    let saved;
    const result = await mutateBoulders((list) => {
      if (formState.mode === "add") {
        saved = { id: nextBoulderId(list, fields.zone), ...fields };
        return { list: [...list, saved] };
      }
      const existing = list.find((b) => b.id === formState.id);
      if (!existing) throw new Error("missing");
      saved = { ...existing, ...fields };
      if (!fields.color2) delete saved.color2;
      return { list: list.map((b) => (b.id === formState.id ? saved : b)) };
    }, { retry: formState.mode !== "add" });
    state.boulders = result.list;
    writeCache(result.list);
    $("boulder-dialog").close();
    syncUI();
    if (formState.mode === "add") {
      flashStatus(`Bloc ajouté : ${saved.colorName} - ${zoneName(saved.zone)} (${saved.id}).`, "admin-status");
    } else {
      if (state.currentId === saved.id) fillDetailStatic(saved);
      flashStatus("Bloc modifié.");
    }
  } catch (caught) {
    console.error(caught);
    errorBox.textContent = caught.message === "missing" ? "Ce bloc n'existe plus." : errorText(caught);
  } finally {
    setFormBusy(false);
  }
}

async function deleteBoulder() {
  if (formState.busy || formState.mode !== "edit" || !canManage()) return;
  const id = formState.id;
  setFormBusy(true);
  try {
    const result = await mutateBoulders((list) => ({ list: list.filter((b) => b.id !== id) }));
    state.boulders = result.list;
    writeCache(result.list);
    // The boulder's completions and opinions go with it (best effort).
    try {
      await withTimeout(
        (async () => {
          await connectFirebase();
          await fb.updateDoc(fb.records, new fb.FieldPath(id), fb.deleteField());
        })(),
        REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      console.error(error);
    }
    if (state.records && state.records[id]) {
      const { [id]: removed, ...rest } = state.records;
      state.records = rest;
    }
    $("boulder-dialog").close();
    closeDetail();
    syncUI();
    flashStatus("Bloc supprimé.", "admin-status");
  } catch (error) {
    console.error(error);
    $("boulder-error").textContent = errorText(error);
    $("delete-confirm").hidden = true;
    $("boulder-delete").hidden = false;
  } finally {
    setFormBusy(false);
  }
}

function bindManagement() {
  $("f-zone").replaceChildren(...state.zones.map((zone) => new Option(zone.name, String(zone.id))));
  $("f-grade").replaceChildren(...GRADES.map((grade) => new Option(grade, grade)));

  $("btn-add").addEventListener("click", () => openBoulderForm(null));
  $("btn-power").addEventListener("click", openPowerDialog);
  $("btn-userdel").addEventListener("click", openUserDelete);
  $("userdel-close").addEventListener("click", () => $("userdel-dialog").close());
  $("btn-edit").addEventListener("click", () => openBoulderForm(currentBoulder()));

  $("power-close").addEventListener("click", () => $("power-dialog").close());
  $("power-input").addEventListener("input", updatePowerForm);
  $("power-form").addEventListener("submit", addPowerUser);

  $("boulder-dialog").addEventListener("close", () => {
    // Back on the boulder view: focus its title (no visible focus ring), not the button.
    if ($("detail").open) $("detail-title").focus({ preventScroll: true });
  });
  $("boulder-close").addEventListener("click", () => $("boulder-dialog").close());
  $("boulder-cancel").addEventListener("click", () => $("boulder-dialog").close());
  $("boulder-form").addEventListener("submit", saveBoulder);
  $("f-two").addEventListener("change", () => {
    $("f-color2-row").hidden = !$("f-two").checked;
  });
  $("f-photo-pick").addEventListener("click", togglePhotoPicker);
  $("f-photo-clear").addEventListener("click", () => {
    formState.photo = "";
    $("photo-picker").hidden = true;
    renderPhotoPreview();
  });
  $("f-video-add").addEventListener("click", () => {
    formState.videos.push("");
    renderVideoFields();
    const inputs = $("f-videos").querySelectorAll("input");
    inputs[inputs.length - 1].focus({ preventScroll: false });
  });
  $("boulder-delete").addEventListener("click", () => {
    $("boulder-delete").hidden = true;
    $("delete-confirm").hidden = false;
  });
  $("delete-no").addEventListener("click", () => {
    $("delete-confirm").hidden = true;
    $("boulder-delete").hidden = false;
  });
  $("delete-yes").addEventListener("click", deleteBoulder);
}

init();
