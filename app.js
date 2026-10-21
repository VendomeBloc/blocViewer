import { firebaseConfig } from "./firebase-config.js";

const FIREBASE_URL = "https://www.gstatic.com/firebasejs/10.14.1";
const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_GRADE = 1;
const MAX_GRADE = 10;
const DEFAULT_AVERAGE = 10; // shown for a boulder nobody has graded yet
const NAME_MAX = 20;
const NAME_STORAGE_KEY = "blocs.name";
const REFRESH_AFTER_MS = 15000;
const ERROR_NETWORK = "Impossible de joindre la base de données. Vérifie ta connexion et réessaie.";

const state = {
  zones: [],
  boulders: [],
  zone: "all", // "all" or a zone id (number)
  min: MIN_GRADE,
  max: MAX_GRADE,
  votes: null, // { boulderId: { nameKey: { name, grade } } }, null = not loaded
  lastFetch: 0,
  currentId: null, // boulder shown in the detail view
  selectedBar: null, // grade selected in the chart
};

const $ = (id) => document.getElementById(id);

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to load ${path}`);
  return response.json();
}

/* ---------- Local storage (remembered name) ---------- */

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

/* ---------- Database (Firestore, one document: grades/all) ---------- */

let fb = null; // set once the Firebase SDK is loaded

async function connectFirebase() {
  const [appModule, fsModule] = await Promise.all([
    import(`${FIREBASE_URL}/firebase-app.js`),
    import(`${FIREBASE_URL}/firebase-firestore.js`),
  ]);
  const db = fsModule.getFirestore(appModule.initializeApp(firebaseConfig));
  fb = {
    ref: fsModule.doc(db, "grades", "all"),
    getDoc: fsModule.getDoc,
    setDoc: fsModule.setDoc,
    updateDoc: fsModule.updateDoc,
    deleteField: fsModule.deleteField,
    FieldPath: fsModule.FieldPath,
  };
}

// Reads all grades (one document read). Returns true on success.
async function fetchVotes() {
  try {
    if (!fb) await connectFirebase();
    const snapshot = await fb.getDoc(fb.ref);
    state.votes = snapshot.exists() ? snapshot.data() : {};
    state.lastFetch = Date.now();
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

let inflight = null;

function refreshVotes() {
  if (inflight) return inflight;
  if (state.votes && Date.now() - state.lastFetch < REFRESH_AFTER_MS) return Promise.resolve(true);
  inflight = fetchVotes()
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
  $("notice").hidden = state.votes !== null;
  render();
  if (state.currentId) renderGrades();
}

/* ---------- Grade statistics ---------- */

function nameKey(name) {
  return `u_${name.normalize("NFC").toLocaleLowerCase("fr")}`;
}

function cleanName(raw) {
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= NAME_MAX ? name : "";
}

function isValidGrade(value) {
  return Number.isInteger(value) && value >= MIN_GRADE && value <= MAX_GRADE;
}

function statsFor(boulderId) {
  const entries = state.votes ? Object.values(state.votes[boulderId] || {}) : [];
  const counts = new Array(MAX_GRADE + 1).fill(0);
  const names = Array.from({ length: MAX_GRADE + 1 }, () => []);
  let sum = 0;
  let n = 0;
  for (const vote of entries) {
    if (!vote || !isValidGrade(vote.grade)) continue;
    counts[vote.grade] += 1;
    names[vote.grade].push(String(vote.name));
    sum += vote.grade;
    n += 1;
  }
  for (const list of names) list.sort((a, b) => a.localeCompare(b, "fr"));
  let avg = null; // null = grades not available
  if (n > 0) avg = sum / n;
  else if (state.votes) avg = DEFAULT_AVERAGE;
  return { n, avg, counts, names };
}

function formatAverage(avg) {
  return avg === null ? "–" : avg.toFixed(1);
}

/* ---------- Colors ---------- */

// Solid color, or diagonal stripes when the boulder has a second color.
function colorBackground(boulder, stripe) {
  if (!boulder.color2) return boulder.color;
  return `repeating-linear-gradient(45deg, ${boulder.color} 0 ${stripe}px, ${boulder.color2} ${stripe}px ${stripe * 2}px)`;
}

/* ---------- Init ---------- */

async function init() {
  try {
    const [zoneData, boulders] = await Promise.all([
      loadJson("data/zones.json"),
      loadJson("data/boulders.json"),
    ]);
    state.zones = zoneData.zones;
    state.boulders = boulders;
    buildMap(zoneData);
    buildGradeControls();
    buildRateGrid();
    bindDialogs();
    window.addEventListener("hashchange", syncDetailWithHash);
    syncUI();
    syncDetailWithHash();
    refreshVotes();
  } catch (error) {
    console.error(error);
    $("list").innerHTML = "";
    $("empty").hidden = false;
    $("empty").textContent = "Impossible de charger les données.";
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
    for (let grade = MIN_GRADE; grade <= MAX_GRADE; grade++) {
      select.add(new Option(String(grade), String(grade)));
    }
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
    state.min = MIN_GRADE;
    state.max = MAX_GRADE;
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
    .map((boulder) => ({ boulder, stats: statsFor(boulder.id) }))
    .filter(({ boulder }) => state.zone === "all" || boulder.zone === state.zone)
    .filter(({ stats }) => stats.avg === null || (Math.round(stats.avg) >= state.min && Math.round(stats.avg) <= state.max))
    .sort((a, b) => {
      const gradeA = a.stats.avg ?? DEFAULT_AVERAGE;
      const gradeB = b.stats.avg ?? DEFAULT_AVERAGE;
      return gradeA - gradeB || a.boulder.zone - b.boulder.zone || a.boulder.id.localeCompare(b.boulder.id);
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

  const items = visibleBoulders();
  $("count").textContent = `(${items.length})`;
  $("empty").hidden = items.length > 0;
  $("empty").textContent = "Aucun bloc ne correspond à ces filtres.";
  $("list").replaceChildren(...items.map(({ boulder, stats }) => renderItem(boulder, stats)));
}

function renderItem(boulder, stats) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "item";
  button.addEventListener("click", () => openDetail(boulder.id));

  const swatch = document.createElement("span");
  swatch.className = "swatch";
  swatch.style.background = colorBackground(boulder, 6);

  const main = document.createElement("span");
  main.className = "item-main";
  const title = document.createElement("div");
  title.className = "item-title";
  title.textContent = boulder.colorName;
  const sub = document.createElement("div");
  sub.className = "item-sub";
  const votes = stats.n === 0 ? "pas encore noté" : `${stats.n} note${stats.n > 1 ? "s" : ""}`;
  sub.textContent = stats.avg === null ? zoneName(boulder.zone) : `${zoneName(boulder.zone)} · ${votes}`;
  main.append(title, sub);

  const grade = document.createElement("span");
  grade.className = "grade";
  const gradeLabel = document.createElement("small");
  gradeLabel.textContent = "Niveau";
  const gradeValue = document.createElement("strong");
  gradeValue.textContent = formatAverage(stats.avg);
  grade.append(gradeLabel, gradeValue);

  button.append(swatch, main, grade);
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
  if ($("player").open) $("player").close();
  if ($("name-dialog").open) $("name-dialog").close();
  $("beta-videos").replaceChildren();
  state.currentId = null;
  state.selectedBar = null;
  if (location.hash) {
    history.replaceState(null, "", location.pathname + location.search);
  }
}

function currentBoulder() {
  return state.boulders.find((b) => b.id === state.currentId);
}

function syncDetailWithHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  const dialog = $("detail");
  const boulder = state.boulders.find((b) => b.id === id);
  if (!boulder) {
    if (dialog.open) dialog.close();
    return;
  }
  if (state.currentId !== boulder.id) state.selectedBar = null;
  state.currentId = boulder.id;
  $("rate-status").textContent = "";
  fillDetail(boulder);
  if (!dialog.open) dialog.showModal();
  refreshVotes();
}

function fillDetail(boulder) {
  const zone = zoneName(boulder.zone);
  $("detail-title").textContent = `${boulder.colorName} - ${zone}`;
  $("detail-photo").replaceChildren(buildPhoto(boulder));
  renderGrades();
  fillBeta(boulder, zone);
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

/* ---------- Grades: chart and rating buttons ---------- */

function renderGrades() {
  const boulder = currentBoulder();
  if (!boulder) return;
  const stats = statsFor(boulder.id);

  if (stats.avg === null) {
    $("detail-grade").textContent = "Niveau –";
  } else {
    const votes = stats.n === 0 ? "pas encore noté" : `${stats.n} note${stats.n > 1 ? "s" : ""}`;
    $("detail-grade").textContent = `Niveau ${formatAverage(stats.avg)} · ${votes}`;
  }

  renderChart(stats);
  renderVoters(stats);
  renderMyVote(boulder.id);
}

function renderChart(stats) {
  const tallest = Math.max(1, ...stats.counts.slice(MIN_GRADE));
  const columns = [];
  for (let grade = MIN_GRADE; grade <= MAX_GRADE; grade++) {
    const count = stats.counts[grade];
    const column = document.createElement("button");
    column.type = "button";
    column.className = "bar-col";
    column.classList.toggle("selected", state.selectedBar === grade);
    column.setAttribute("aria-pressed", String(state.selectedBar === grade));
    column.setAttribute("aria-label", `Niveau ${grade} : ${count} grimpeur${count > 1 ? "s" : ""}`);
    column.addEventListener("click", () => {
      state.selectedBar = state.selectedBar === grade ? null : grade;
      renderGrades();
    });

    const countLabel = document.createElement("span");
    countLabel.className = "bar-count";
    countLabel.textContent = count > 0 ? String(count) : "";

    const track = document.createElement("span");
    track.className = "bar-track";
    const fill = document.createElement("span");
    fill.className = "bar-fill";
    fill.style.height = count > 0 ? `${Math.max(10, (count / tallest) * 100)}%` : "3px";
    track.appendChild(fill);

    const gradeLabel = document.createElement("span");
    gradeLabel.className = "bar-grade";
    gradeLabel.textContent = String(grade);

    column.append(countLabel, track, gradeLabel);
    columns.push(column);
  }
  $("chart").replaceChildren(...columns);
}

function renderVoters(stats) {
  const grade = state.selectedBar;
  const voters = $("voters");
  if (grade === null) {
    voters.textContent = state.votes ? "" : "Notes indisponibles pour le moment.";
    return;
  }
  const names = stats.names[grade];
  voters.textContent = names.length
    ? `Niveau ${grade} : ${names.join(", ")}`
    : `Personne n'a donné le niveau ${grade}.`;
}

function renderMyVote(boulderId) {
  const element = $("my-vote");
  const name = loadName();
  const mine = name && state.votes && state.votes[boulderId] && state.votes[boulderId][nameKey(name)];
  if (mine && isValidGrade(mine.grade)) {
    element.textContent = `Ta note (${mine.name}) : niveau ${mine.grade}`;
    element.hidden = false;
  } else {
    element.hidden = true;
  }
}

function buildRateGrid() {
  const buttons = [];
  for (let grade = MIN_GRADE; grade <= MAX_GRADE; grade++) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rate-btn";
    button.textContent = String(grade);
    button.setAttribute("aria-label", `Donner le niveau ${grade}`);
    button.addEventListener("click", () => startRating(grade));
    buttons.push(button);
  }
  $("rate-grid").replaceChildren(...buttons);
}

let statusTimer = null;

function flashStatus(message) {
  $("rate-status").textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    $("rate-status").textContent = "";
  }, 3000);
}

/* ---------- Rating flow: name prompt, then save / update / delete ---------- */

let pending = null; // { boulderId, grade, name, key }

function bindDialogs() {
  $("close").addEventListener("click", closeDetail);
  $("detail").addEventListener("close", onDetailClosed);

  $("player-close").addEventListener("click", () => $("player").close());
  $("player").addEventListener("close", () => $("player-frame").replaceChildren());

  const nameDialog = $("name-dialog");
  nameDialog.addEventListener("close", () => {
    pending = null;
  });
  $("name-form").addEventListener("submit", onNameSubmit);
  $("name-cancel").addEventListener("click", () => nameDialog.close());
  $("choice-cancel").addEventListener("click", () => nameDialog.close());
  $("choice-update").addEventListener("click", () => commitVote("save"));
  $("choice-delete").addEventListener("click", () => commitVote("delete"));
  $("choice-other").addEventListener("click", () => {
    showNameStep();
    $("name-input").value = "";
    $("name-input").focus();
  });
}

function startRating(grade) {
  const boulder = currentBoulder();
  if (!boulder) return;
  pending = { boulderId: boulder.id, grade, name: "", key: "" };
  $("name-intro").textContent = `Niveau ${grade} pour ${boulder.colorName} - ${zoneName(boulder.zone)}.`;
  $("name-input").value = loadName();
  showNameStep();
  $("name-dialog").showModal();
  $("name-input").select();
}

function showNameStep() {
  $("name-form").hidden = false;
  $("choice").hidden = true;
  $("name-error").textContent = "";
}

function showChoiceStep(existing) {
  $("name-form").hidden = true;
  $("choice").hidden = false;
  $("name-error").textContent = "";
  $("choice-text").textContent = `« ${existing.name} » a déjà noté ce bloc : niveau ${existing.grade}.`;
  $("choice-update").textContent =
    existing.grade === pending.grade
      ? `Garder le niveau ${pending.grade}`
      : `Mettre à jour : ${existing.grade} → ${pending.grade}`;
}

function setBusy(busy) {
  for (const element of $("name-dialog").querySelectorAll("button, input")) {
    element.disabled = busy;
  }
}

async function onNameSubmit(event) {
  event.preventDefault();
  if (!pending) return;
  const name = cleanName($("name-input").value);
  if (!name) {
    $("name-error").textContent = `Entre un nom (${NAME_MAX} caractères maximum).`;
    return;
  }

  setBusy(true);
  $("name-error").textContent = "";
  const ok = await fetchVotes(); // always check against fresh data
  setBusy(false);
  if (!pending) return; // dialog was closed meanwhile
  syncUI();
  if (!ok) {
    $("name-error").textContent = ERROR_NETWORK;
    return;
  }

  pending.name = name;
  pending.key = nameKey(name);
  const existing = state.votes[pending.boulderId]?.[pending.key];
  if (existing && isValidGrade(existing.grade)) {
    pending.name = existing.name || name; // keep the capitalization first used
    showChoiceStep({ name: pending.name, grade: existing.grade });
  } else {
    await commitVote("save");
  }
}

async function commitVote(action) {
  if (!pending) return;
  const { boulderId, grade, name, key } = pending;
  setBusy(true);
  $("name-error").textContent = "";
  try {
    if (action === "delete") {
      await fb.updateDoc(fb.ref, new fb.FieldPath(boulderId, key), fb.deleteField());
      if (state.votes[boulderId]) delete state.votes[boulderId][key];
    } else {
      await fb.setDoc(fb.ref, { [boulderId]: { [key]: { name, grade } } }, { merge: true });
      state.votes[boulderId] = { ...(state.votes[boulderId] || {}), [key]: { name, grade } };
    }
    saveName(name);
    setBusy(false);
    $("name-dialog").close();
    syncUI();
    flashStatus(action === "delete" ? "Note supprimée." : "Note enregistrée.");
  } catch (error) {
    console.error(error);
    setBusy(false);
    $("name-error").textContent = ERROR_NETWORK;
  }
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
