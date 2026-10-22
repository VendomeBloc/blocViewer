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
const VOTE_WINDOW = 3; // a vote can differ from the set grade by at most 3 grades

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
  min: 0, // index in GRADES
  max: LAST_GRADE,
  records: null, // { boulderId: { nameKey: { name, vote? } } }, null = not loaded
  lastFetch: 0,
  status: "loading", // "loading" | "ok" | "failed"
  user: "", // signed-in name, "" = guest
  signInThen: null, // action to run once the user has signed in
  currentId: null, // boulder shown in the detail view
  selectedBar: null, // grade index selected in the chart
  voting: false, // the +/- prompt is open
  busy: false, // a record is being written
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
  const db = fsModule.getFirestore(appModule.initializeApp(firebaseConfig));
  fb = {
    boulders: fsModule.doc(db, "boulders", "all"),
    records: fsModule.doc(db, "records", "all"),
    getDoc: fsModule.getDoc,
    setDoc: fsModule.setDoc,
    updateDoc: fsModule.updateDoc,
    deleteField: fsModule.deleteField,
    FieldPath: fsModule.FieldPath,
  };
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
  const [boulderSnap, recordsSnap] = await Promise.all([fb.getDoc(fb.boulders), fb.getDoc(fb.records)]);
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
  if (state.status === "failed") {
    state.status = "ok"; // a slow attempt finally succeeded
    syncUI();
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
  render();
  if (state.currentId) renderDetail();
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
  if (count === 0) return "aucune réussite";
  return count === 1 ? "1 réussite" : `${count} réussites`;
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
  $("user-intro").textContent =
    then === "complete"
      ? "Entre ton nom pour enregistrer ta réussite."
      : "Entre ton nom pour suivre tes réussites. Pas de mot de passe : le même nom retrouve les mêmes réussites.";
  $("user-input").value = state.user;
  $("user-signout").hidden = !state.user;
  updateUserForm();
  $("user-dialog").showModal();
  $("user-input").select();
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
  for (const id of ["min-grade", "max-grade"]) {
    const select = $(id);
    GRADES.forEach((grade, index) => select.add(new Option(grade, String(index))));
  }
  $("min-grade").addEventListener("change", (event) => {
    state.min = Number(event.target.value);
    if (state.max < state.min) state.max = state.min;
    render();
  });
  $("max-grade").addEventListener("change", (event) => {
    state.max = Number(event.target.value);
    if (state.min > state.max) state.min = state.max;
    render();
  });
  $("reset-grade").addEventListener("click", () => {
    state.min = 0;
    state.max = LAST_GRADE;
    render();
  });
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
      const index = gradeIndex(boulder.grade);
      return index < 0 || (index >= state.min && index <= state.max);
    })
    .sort((a, b) => {
      const gradeA = gradeIndex(a.grade) < 0 ? 99 : gradeIndex(a.grade);
      const gradeB = gradeIndex(b.grade) < 0 ? 99 : gradeIndex(b.grade);
      return gradeA - gradeB || a.zone - b.zone || a.id.localeCompare(b.id);
    });
}

function render() {
  $("min-grade").value = String(state.min);
  $("max-grade").value = String(state.max);

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
    mark.setAttribute("aria-label", "Réussi");
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
    $("detail-title").textContent = `${boulder.colorName} - ${zoneName(boulder.zone)}`;
    $("detail-photo").replaceChildren(buildPhoto(boulder));
    fillBeta(boulder, zoneName(boulder.zone));
  }
  renderDetail();
  if (!dialog.open) dialog.showModal();
  refreshRecords();
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
  const count = $("done-count");
  const names = $("done-names");
  if (!info) {
    count.textContent = state.status === "failed" ? "Réussites indisponibles pour le moment." : "Chargement…";
    names.textContent = "";
  } else if (info.done === 0) {
    count.textContent = "Personne n'a encore réussi ce bloc.";
    names.textContent = "";
  } else {
    count.textContent = info.done === 1 ? "1 grimpeur a réussi ce bloc." : `${info.done} grimpeurs ont réussi ce bloc.`;
    names.textContent = info.names.join(", ");
  }

  const mine = myEntry(boulder.id);
  const base = gradeIndex(boulder.grade);
  const hasVote = mine && gradeIndex(mine.vote) >= 0;

  const myRecord = $("my-record");
  if (mine) {
    myRecord.textContent = `Tu as réussi ce bloc (${state.user})${hasVote ? ` · ton avis : ${mine.vote}` : ""}`;
    myRecord.hidden = false;
  } else {
    myRecord.hidden = true;
  }

  if (!mine) state.voting = false;
  $("btn-complete").hidden = !!mine;
  $("btn-complete").disabled = state.busy;
  $("completed-actions").hidden = !mine || state.voting;
  $("btn-grade").hidden = base < 0;
  $("btn-grade").textContent = hasVote ? "Modifier mon avis" : "Donner mon avis";
  $("btn-grade").disabled = state.busy;
  $("btn-cancel").disabled = state.busy;
  renderVotePrompt(boulder, mine);
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

const SUCCESS_MESSAGES = {
  complete: "Réussite enregistrée.",
  vote: "Avis enregistré.",
  unvote: "Avis retiré.",
  cancel: "Réussite annulée.",
};

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
    await withTimeout(
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
      REQUEST_TIMEOUT_MS,
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
    flashStatus(SUCCESS_MESSAGES[action]);
  } catch (error) {
    console.error(error);
    $("record-error").textContent = ERROR_NETWORK;
  } finally {
    state.busy = false;
    syncUI();
  }
}

let statusTimer = null;

function flashStatus(message) {
  $("record-status").textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    $("record-status").textContent = "";
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
  $("user-input").addEventListener("input", updateUserForm);
  $("user-form").addEventListener("submit", onUserSubmit);
  $("user-cancel").addEventListener("click", () => $("user-dialog").close());
  $("user-signout").addEventListener("click", signOut);
  $("user-dialog").addEventListener("close", () => {
    state.signInThen = null;
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

init();
