"use strict";

const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_GRADE = 1;
const MAX_GRADE = 10;

const state = {
  zones: [],
  boulders: [],
  zone: "all", // "all" or a zone id (number)
  min: MIN_GRADE,
  max: MAX_GRADE,
};

const $ = (id) => document.getElementById(id);

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to load ${path}`);
  return response.json();
}

async function init() {
  try {
    const [zoneData, boulders] = await Promise.all([
      loadJson("data/zones.json"),
      loadJson("data/boulders.json"),
    ]);
    state.zones = zoneData.zones;
    state.boulders = boulders;
    buildMap(zoneData.viewBox);
    buildGradeSelects();
    $("all-zones").addEventListener("click", () => setZone("all"));
    $("close").addEventListener("click", closeDetail);
    $("detail").addEventListener("close", onDialogClosed);
    window.addEventListener("hashchange", syncDetailWithHash);
    render();
    syncDetailWithHash();
  } catch (error) {
    console.error(error);
    $("list").innerHTML = "";
    $("empty").hidden = false;
    $("empty").textContent = "Impossible de charger les données.";
  }
}

/* ---------- Map ---------- */

function buildMap(viewBox) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", "Plan de la salle avec les quatre zones");

  for (const zone of state.zones) {
    const polygon = document.createElementNS(SVG_NS, "polygon");
    polygon.setAttribute("points", zone.points.map((p) => p.join(",")).join(" "));
    polygon.setAttribute("class", "zone");
    polygon.setAttribute("data-zone", zone.id);
    polygon.setAttribute("role", "button");
    polygon.setAttribute("tabindex", "0");
    polygon.setAttribute("aria-label", zone.name);
    polygon.addEventListener("click", () => setZone(zone.id));
    polygon.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setZone(zone.id);
      }
    });
    svg.appendChild(polygon);

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", zone.label[0]);
    label.setAttribute("y", zone.label[1]);
    label.setAttribute("class", "zone-label");
    label.textContent = zone.name;
    svg.appendChild(label);
  }
  $("map").appendChild(svg);
}

function setZone(zone) {
  // Tapping the already selected zone goes back to "all".
  state.zone = state.zone === zone ? "all" : zone;
  render();
}

/* ---------- Filters ---------- */

function buildGradeSelects() {
  for (const id of ["min-grade", "max-grade"]) {
    const select = $(id);
    for (let grade = MIN_GRADE; grade <= MAX_GRADE; grade++) {
      select.add(new Option(String(grade), String(grade)));
    }
  }
  $("min-grade").value = String(state.min);
  $("max-grade").value = String(state.max);

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
}

/* ---------- List ---------- */

function visibleBoulders() {
  return state.boulders
    .filter((b) => state.zone === "all" || b.zone === state.zone)
    .filter((b) => b.grade >= state.min && b.grade <= state.max)
    .sort((a, b) => a.grade - b.grade || a.zone - b.zone || a.id.localeCompare(b.id));
}

function zoneName(id) {
  const zone = state.zones.find((z) => z.id === id);
  return zone ? zone.name : `Zone ${id}`;
}

function render() {
  $("min-grade").value = String(state.min);
  $("max-grade").value = String(state.max);

  for (const polygon of document.querySelectorAll(".zone")) {
    const active = state.zone !== "all" && Number(polygon.dataset.zone) === state.zone;
    polygon.classList.toggle("active", active);
    polygon.setAttribute("aria-pressed", String(active));
  }
  $("all-zones").setAttribute("aria-pressed", String(state.zone === "all"));

  const items = visibleBoulders();
  $("count").textContent = `(${items.length})`;
  $("empty").hidden = items.length > 0;
  $("empty").textContent = "Aucun bloc ne correspond à ces filtres.";

  const list = $("list");
  list.replaceChildren(...items.map(renderItem));
}

function renderItem(boulder) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "item";
  button.addEventListener("click", () => openDetail(boulder.id));

  const swatch = document.createElement("span");
  swatch.className = "swatch";
  swatch.style.background = boulder.color;

  const main = document.createElement("span");
  main.className = "item-main";
  const title = document.createElement("div");
  title.className = "item-title";
  title.textContent = boulder.colorName;
  const sub = document.createElement("div");
  sub.className = "item-sub";
  sub.textContent = zoneName(boulder.zone);
  main.append(title, sub);

  const grade = document.createElement("span");
  grade.className = "grade";
  grade.textContent = boulder.grade;
  grade.setAttribute("aria-label", `Niveau ${boulder.grade}`);

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

function onDialogClosed() {
  $("detail-video").replaceChildren(); // stops the video
  if (location.hash) {
    history.replaceState(null, "", location.pathname + location.search);
  }
}

function syncDetailWithHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  const dialog = $("detail");
  const boulder = state.boulders.find((b) => b.id === id);
  if (!boulder) {
    if (dialog.open) dialog.close();
    return;
  }
  fillDetail(boulder);
  if (!dialog.open) dialog.showModal();
}

function fillDetail(boulder) {
  $("detail-title").textContent = `${boulder.colorName} · niveau ${boulder.grade}`;
  $("detail-meta").textContent = zoneName(boulder.zone);

  const photo = $("detail-photo");
  photo.replaceChildren(buildPhoto(boulder));

  const video = $("detail-video");
  video.replaceChildren();
  const videoId = extractYouTubeId(boulder.video);
  if (videoId) {
    const iframe = document.createElement("iframe");
    iframe.src = `https://www.youtube-nocookie.com/embed/${videoId}`;
    iframe.title = `Solution du bloc ${boulder.colorName}`;
    iframe.loading = "lazy";
    iframe.allow = "accelerometer; encrypted-media; gyroscope; picture-in-picture";
    iframe.allowFullscreen = true;
    video.appendChild(iframe);
  }
}

function buildPhoto(boulder) {
  const fallback = () => {
    const div = document.createElement("div");
    div.className = "photo-missing";
    div.style.background = boulder.color;
    div.textContent = "Photo à venir";
    return div;
  };
  if (!boulder.photo) return fallback();

  const img = document.createElement("img");
  img.src = boulder.photo;
  img.alt = `Bloc ${boulder.colorName}, ${zoneName(boulder.zone)}`;
  img.addEventListener("error", () => img.replaceWith(fallback()));
  return img;
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
