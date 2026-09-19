// WDW Trip Planner — Itinerary Builder. Vanilla JS, no build step.
// State is user-entered and persisted to localStorage so it survives a refresh.

const STORAGE_KEY = "wdw-itinerary-v1";

const $ = (id) => document.getElementById(id);

function fmtUSD(n) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function parseISO(s) { return new Date(s + "T00:00:00"); }
function fmtDate(iso) {
  if (!iso) return "";
  return parseISO(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
// Display a start/end pair. Collapses to a single date when there's no valid range.
function fmtDateRange(start, end) {
  if (!start) return "";
  if (end && end > start) return `${fmtDate(start)} → ${fmtDate(end)}`;
  return fmtDate(start);
}
// Per-person amount string, or "" when it wouldn't add information (0/1 person, or free).
function perPersonText(cost, people) {
  if (!people || people <= 1 || !cost) return "";
  return `${fmtUSD(Math.round(cost / people))}/person`;
}

// type key -> { icon, label } for display and grouping.
const TYPES = {
  flight:      { icon: "✈️", label: "Flight" },
  stay:        { icon: "🏨", label: "Stay" },
  car:         { icon: "🚗", label: "Car rental" },
  reservation: { icon: "🍽️", label: "Reservation" },
  ticket:      { icon: "🎟️", label: "Ticket" },
  other:       { icon: "📌", label: "Other" },
};
const TYPE_ORDER = ["flight", "stay", "car", "reservation", "ticket", "other"];

// state = { title, sort, items:[{id,type,title,cost,date,endDate,optional,included,group}],
//           groupSel:{name:itemId}, groupOff:{name:bool}, lastDate, lastEndDate }
// groupSel always holds a valid chosen option; groupOff marks a group as skipped
// (contributes $0) while remembering the selection for when it's turned back on.
// lastDate/lastEndDate remember the most recently entered range so new items default
// to the same timeframe — this keeps the calendar opening on the trip's months.
let state = { title: "", sort: "type", items: [], households: [], splitBasis: "people", groupSel: {}, groupOff: {}, lastDate: "", lastEndDate: "", lastPeople: "", cloudId: "", published: false };

const SUPABASE = window.SUPABASE || {};

// Id of the item currently being edited inline (null when none).
let editingId = null;

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const defaults = { title: "", sort: "type", items: [], households: [], splitBasis: "people", groupSel: {}, groupOff: {}, lastDate: "", lastEndDate: "", lastPeople: "", cloudId: "", published: false };
    if (Array.isArray(parsed)) {
      // Migrate v1 format (bare items array) into the state object.
      state = Object.assign(defaults, { items: parsed });
    } else {
      state = Object.assign(defaults, parsed);
    }
    // Backfill fields that may be missing on older items.
    for (const it of state.items) {
      if (typeof it.date !== "string") it.date = "";
      if (typeof it.endDate !== "string") it.endDate = "";
      if (typeof it.people !== "number") it.people = 0; // 0 = unspecified
      // Booking fields — added when the trip went from guesses to real reservations.
      if (!("actual" in it)) it.actual = null;        // null until real money is known
      if (typeof it.status !== "string") it.status = "est";
      if (typeof it.conf !== "string") it.conf = "";
      if (typeof it.vendor !== "string") it.vendor = "";
      if (typeof it.payer !== "string") it.payer = "";
      if (typeof it.notes !== "string") it.notes = "";
      if (typeof it.url !== "string") it.url = "";
      if (!Array.isArray(it.shares)) it.shares = [];  // empty = split across everyone
      if (typeof it.priceMode !== "string") it.priceMode = "total";
      if (typeof it.group !== "string") it.group = "";
      if (typeof it.optional !== "boolean") it.optional = false;
      if (typeof it.included !== "boolean") it.included = true;
    }
  } catch (e) {
    state = { title: "", sort: "type", items: [], groupSel: {} };
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    // Storage full or blocked (e.g. private mode) — the app still works this session.
  }
  scheduleCloudSync();
}

// --- Cloud sync (Supabase) ------------------------------------------------
let syncTimer = null;

function sbHeaders(extra) {
  return Object.assign({
    "apikey": SUPABASE.anon,
    "Authorization": "Bearer " + SUPABASE.anon,
    "Content-Type": "application/json",
  }, extra || {});
}

// Short, hard-to-guess id so a link reveals only that one plan.
function newId() {
  const bytes = new Uint8Array(8);
  (window.crypto || window.msCrypto).getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += b.toString(36);
  s = s.replace(/[^a-z0-9]/g, "");
  return (s + "0000000000").slice(0, 10);
}

// Save via the save_plan() function (insert-or-update, runs with elevated rights so
// it isn't blocked by the table's locked-down policies).
async function cloudSave(id, payload) {
  const res = await fetch(SUPABASE.url + "/rpc/save_plan", {
    method: "POST",
    headers: sbHeaders(),
    body: JSON.stringify({ pid: id, payload: payload }),
  });
  if (!res.ok) throw new Error("cloud save failed: " + res.status);
}

function setSyncStatus(kind) {
  const el = $("syncStatus");
  if (!el) return;
  const map = {
    saving: ["Saving…", "muted"],
    synced: ["Shared link updated ✓", "ok"],
    error: ["Couldn't sync — will retry on your next change", "err"],
    "": ["", ""],
  };
  const [txt, cls] = map[kind] || ["", ""];
  el.textContent = txt;
  el.className = "sync-status " + cls;
}

// Once a plan is published, push edits to the cloud (debounced) so its link stays current.
function scheduleCloudSync() {
  if (!(state.published && state.cloudId && SUPABASE.url)) return;
  setSyncStatus("saving");
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    cloudSave(state.cloudId, currentPayload())
      .then(() => setSyncStatus("synced"))
      .catch(() => setSyncStatus("error"));
  }, 1200);
}

// Ordered list of distinct group names, by first appearance.
function groupNames() {
  const seen = [];
  for (const it of state.items) {
    if (it.group && !seen.includes(it.group)) seen.push(it.group);
  }
  return seen;
}

// Make sure every group has exactly one valid selection (defaults to first member).
function ensureGroupSelections() {
  const names = groupNames();
  // Drop selection / on-off state for groups that no longer exist.
  for (const key of Object.keys(state.groupSel)) {
    if (!names.includes(key)) delete state.groupSel[key];
  }
  for (const key of Object.keys(state.groupOff)) {
    if (!names.includes(key)) delete state.groupOff[key];
  }
  for (const name of names) {
    const members = state.items.filter((it) => it.group === name);
    const sel = state.groupSel[name];
    if (!sel || !members.some((m) => m.id === sel)) {
      state.groupSel[name] = members[0].id;
    }
  }
}

function isGroupOn(name) { return !state.groupOff[name]; }

function toggleGroupOn(name) {
  state.groupOff[name] = isGroupOn(name); // flip: on -> true(off), off -> false(on)
  save();
  render();
}

// The shared date range for a group (taken from its first member), or null if empty.
function groupDatesFor(name) {
  const first = state.items.find((it) => it.group === name);
  return first ? { date: first.date, endDate: first.endDate } : null;
}

// Apply a date range to every member of a group so they always stay in sync.
function setGroupDates(name, date, endDate) {
  for (const it of state.items) {
    if (it.group === name) { it.date = date; it.endDate = endDate; }
  }
}

// An item is counted if: it's the selected option in its group, or (no group) it's
// fixed, or it's optional-and-included.
function isCounted(item) {
  if (item.group) {
    if (!isGroupOn(item.group)) return false; // whole group skipped
    return state.groupSel[item.group] === item.id;
  }
  if (item.optional) return item.included;
  return true;
}

function currentMode() {
  return (document.querySelector('input[name="countMode"]:checked') || {}).value || "always";
}

function syncGroupNameVisibility() {
  $("groupNameWrap").classList.toggle("show", currentMode() === "group");
  fillFormDatesFromGroup();
}

// Keep the end-date picker from opening on today: anchor it to the chosen start.
function syncEndMin() {
  $("itemEndDate").min = $("itemDate").value || "";
}

// When the add form targets an existing group, show that group's shared dates so
// the user doesn't re-enter them (grouped items always share one range).
function fillFormDatesFromGroup() {
  if (currentMode() !== "group") return;
  const name = $("groupName").value.trim();
  if (!name) return;
  const dates = groupDatesFor(name);
  if (dates) {
    $("itemDate").value = dates.date || "";
    $("itemEndDate").value = dates.endDate || "";
    syncEndMin();
  }
}

function refreshGroupDatalist() {
  const dl = $("groupList");
  dl.innerHTML = "";
  for (const name of groupNames()) {
    const opt = document.createElement("option");
    opt.value = name;
    dl.appendChild(opt);
  }
}

function addItem() {
  const type = $("itemType").value;
  const title = $("itemTitle").value.trim();
  const cost = Math.max(0, parseFloat($("itemCost").value) || 0);
  const people = Math.max(0, parseInt($("itemPeople").value, 10) || 0);
  let date = $("itemDate").value || "";
  let endDate = $("itemEndDate").value || "";
  const mode = currentMode();

  if (!title) { $("itemTitle").focus(); return; }

  let group = "";
  if (mode === "group") {
    group = $("groupName").value.trim();
    if (!group) { $("groupName").focus(); return; }
    // Joining an existing group? Inherit its shared dates rather than the typed ones.
    const shared = groupDatesFor(group);
    if (shared) { date = shared.date; endDate = shared.endDate; }
  }

  const item = {
    id: "i" + Date.now() + Math.floor(Math.random() * 1000),
    type, title, cost, people, date, endDate,
    optional: mode === "optional",
    included: true,
    group,
    // Everything starts as an estimate; booking details get filled in once it's real.
    actual: null, status: "est", conf: "", vendor: "", payer: "", notes: "", url: "", shares: [], priceMode: "total",
  };
  state.items.push(item);
  // Remember these so the next item defaults to the same timeframe and party size.
  state.lastDate = date;
  state.lastEndDate = endDate;
  state.lastPeople = people ? String(people) : "";
  ensureGroupSelections();
  save();
  render();

  // Reset for the next entry; keep type + mode + group name AND the dates, so entering
  // several activities around the same days doesn't mean re-navigating the calendar.
  $("itemTitle").value = "";
  $("itemCost").value = "";
  $("itemPeople").value = people ? String(people) : "";
  $("itemDate").value = date;
  $("itemEndDate").value = endDate;
  syncEndMin();
  $("itemTitle").focus();
}

function deleteItem(id) {
  state.items = state.items.filter((it) => it.id !== id);
  ensureGroupSelections();
  save();
  render();
}

function toggleIncluded(id) {
  const item = state.items.find((it) => it.id === id);
  if (item) { item.included = !item.included; save(); render(); }
}

function selectGroup(name, id) {
  state.groupSel[name] = id;
  save();
  render();
}

function startEdit(id) {
  editingId = id;
  render();
  const titleInput = document.querySelector(".edit-row .edit-title");
  if (titleInput) titleInput.focus();
}

function cancelEdit() {
  editingId = null;
  render();
}

function saveEdit(id) {
  const item = state.items.find((it) => it.id === id);
  if (!item) { editingId = null; render(); return; }
  const title = document.querySelector(".edit-row .edit-title").value.trim();
  const cost = document.querySelector(".edit-row .edit-cost").value;
  const people = document.querySelector(".edit-row .edit-people").value;
  const date = document.querySelector(".edit-row .edit-start").value;
  const endDate = document.querySelector(".edit-row .edit-end").value;
  if (title) item.title = title;
  item.cost = Math.max(0, parseFloat(cost) || 0);
  item.people = Math.max(0, parseInt(people, 10) || 0);
  if (item.group) {
    // Grouped items share one range — apply the edit to every member.
    setGroupDates(item.group, date || "", endDate || "");
  } else {
    item.date = date || "";
    item.endDate = endDate || "";
  }
  editingId = null;
  save();
  render();
}

function buildEditRow(item) {
  const row = document.createElement("div");
  row.className = "item-row edit-row";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "edit-title";
  titleInput.value = item.title;
  titleInput.placeholder = "Title";

  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.className = "edit-date edit-start";
  dateInput.value = item.date || "";
  dateInput.title = "Start date";

  const arrow = document.createElement("span");
  arrow.className = "arrow";
  arrow.textContent = "→";

  const endInput = document.createElement("input");
  endInput.type = "date";
  endInput.className = "edit-date edit-end";
  endInput.value = item.endDate || "";
  endInput.title = "End date (optional)";

  const costInput = document.createElement("input");
  costInput.type = "number";
  costInput.className = "edit-cost";
  costInput.min = "0";
  costInput.step = "1";
  costInput.value = item.cost;

  const peopleInput = document.createElement("input");
  peopleInput.type = "number";
  peopleInput.className = "edit-people";
  peopleInput.min = "0";
  peopleInput.step = "1";
  peopleInput.placeholder = "# ppl";
  peopleInput.title = "How many people this is for";
  peopleInput.value = item.people ? String(item.people) : "";

  const saveBtn = document.createElement("button");
  saveBtn.className = "edit-save";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => saveEdit(item.id));

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "icon-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", cancelEdit);

  // Enter saves, Escape cancels, from any field.
  for (const inp of [titleInput, dateInput, endInput, costInput, peopleInput]) {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); saveEdit(item.id); }
      else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
    });
  }

  row.append(titleInput, dateInput, arrow, endInput, costInput, peopleInput, saveBtn, cancelBtn);
  return row;
}

function buildRow(item) {
  if (editingId === item.id) return buildEditRow(item);

  const row = document.createElement("div");
  const excluded = !isCounted(item);
  row.className = "item-row" + (excluded ? " excluded" : "");

  // First cell: group radio / optional checkbox / fixed lock.
  let control;
  if (item.group) {
    control = document.createElement("input");
    control.type = "radio";
    control.className = "item-check";
    control.name = "grp-" + item.group;
    control.checked = state.groupSel[item.group] === item.id;
    control.disabled = !isGroupOn(item.group); // can't pick within a skipped group
    control.title = `Choose this option for "${item.group}"`;
    control.addEventListener("change", () => selectGroup(item.group, item.id));
  } else if (item.optional) {
    control = document.createElement("input");
    control.type = "checkbox";
    control.className = "item-check";
    control.checked = item.included;
    control.title = "Include this in the total";
    control.addEventListener("change", () => toggleIncluded(item.id));
  } else {
    control = document.createElement("span");
    control.className = "fixed-dot";
    control.textContent = "🔒";
    control.title = "Always counted";
  }

  const meta = TYPES[item.type] || TYPES.other;
  const main = document.createElement("div");
  main.className = "item-main";
  // Grouped members live inside a card whose header already shows the group name and
  // shared dates, so we omit the badge and date here to avoid repeating them.
  const subParts = [meta.label];
  if (!item.group) {
    const dateText = fmtDateRange(item.date, item.endDate);
    if (dateText) subParts.push(`<span class="item-date">${dateText}</span>`);
  }
  if (item.people) subParts.push(`for ${item.people}`);
  const st = Booking.STATUS[Booking.statusOf(item)];
  subParts.push(`<span class="badge ${st.cls}">${st.label}</span>`);
  if (item.conf) subParts.push(`<span class="conf">#${escapeHTML(item.conf)}</span>`);
  if (item.payer) {
    const payerName = Booking.householdName(state, item.payer);
    if (payerName) subParts.push(`paid by ${escapeHTML(payerName)}`);
  }
  main.innerHTML =
    `<span class="item-title"><span class="item-icon">${meta.icon}</span>${escapeHTML(item.title)}</span>` +
    `<span class="item-sub">${subParts.join(" · ")}</span>`;

  const costCell = document.createElement("div");
  costCell.className = "item-cost";
  const eff = Booking.effCost(state, item);
  const units = Booking.unitsFor(state, item);
  const mode = Booking.priceMode(item);
  let costHTML = fmtUSD(eff);
  // For a scaled price, show the arithmetic rather than a bare total.
  if (mode !== "total" && units > 1) {
    const what = mode === "person" ? (units === 1 ? "person" : "people") : (units === 1 ? "family" : "families");
    costHTML += `<span class="per-person">${fmtUSD(Booking.unitPrice(item))} \u00d7 ${units} ${what}</span>`;
  } else {
    const perPerson = perPersonText(eff, item.people);
    if (perPerson) costHTML += `<span class="per-person">${perPerson}</span>`;
  }
  if (Booking.hasActual(item)) {
    const v = Booking.variance(state, item);
    if (Math.abs(v) < 1) costHTML += '<span class="var on">on estimate</span>';
    else costHTML += `<span class="var ${v > 0 ? "over" : "under"}">${v > 0 ? "+" : "\u2212"}${fmtUSD(Math.abs(v))} vs est</span>`;
  }
  costCell.innerHTML = costHTML;

  const actions = document.createElement("div");
  actions.className = "item-actions";
  const editBtn = document.createElement("button");
  editBtn.className = "icon-btn";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", () => startEdit(item.id));
  const delBtn = document.createElement("button");
  delBtn.className = "icon-btn danger";
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", () => deleteItem(item.id));
  const bookBtn = document.createElement("button");
  bookBtn.className = "icon-btn" + (openBookingId === item.id ? " on" : "");
  bookBtn.textContent = Booking.hasActual(item) || item.conf ? "Booking \u2713" : "Booking";
  bookBtn.title = "Confirmation number, what was really charged, who paid, who splits it";
  bookBtn.addEventListener("click", () => toggleBooking(item.id));
  actions.append(editBtn, bookBtn, delBtn);

  // Who is in on this expense, and what it costs them. Click a family to toggle.
  const houses = Booking.households(state);
  if (houses.length > 1) main.appendChild(buildWhosIn(item));

  row.append(control, main, costCell, actions);
  if (openBookingId !== item.id) return row;

  // The booking panel expands underneath the row it belongs to.
  const wrap = document.createElement("div");
  wrap.className = "item-wrap";
  wrap.append(row, buildBookingPanel(item));
  return wrap;
}

// The per-item participation row: one clickable chip per family.
function buildWhosIn(item) {
  const houses = Booking.households(state);
  const split = Booking.splitItem(state, item);
  const inIds = new Set(Booking.sharersFor(state, item).map((h) => h.id));

  const row = document.createElement("div");
  row.className = "row-split";

  const label = document.createElement("span");
  label.className = "row-split-label";
  label.textContent = inIds.size === houses.length ? "Everyone:" : "Who's in:";
  row.appendChild(label);

  for (const h of houses) {
    const on = inIds.has(h.id);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "shr-chip" + (on ? " on" : "");
    chip.title = on
      ? `${h.name} is in — click to take them off this expense`
      : `${h.name} is sitting this one out — click to add them`;
    chip.innerHTML = `<span class="n">${escapeHTML(h.name)}</span>` +
      (on ? `<span class="a">${fmtUSD(Math.round(split[h.id] || 0))}</span>` : '<span class="a out">out</span>');
    chip.addEventListener("click", () => toggleSharer(item.id, h.id));
    row.appendChild(chip);
  }
  return row;
}

// Add or remove one household from an expense. An empty shares list means everyone,
// so collapse back to that when all are in rather than storing every id.
function toggleSharer(itemId, houseId) {
  const item = state.items.find((it) => it.id === itemId);
  if (!item) return;
  const all = Booking.households(state).map((h) => h.id);
  let cur = Array.isArray(item.shares) && item.shares.length ? item.shares.slice() : all.slice();

  if (cur.includes(houseId)) {
    // Never leave an expense with nobody paying for it — the cost would land nowhere.
    if (cur.length === 1) {
      window.alert("Someone has to be in on this expense. Delete the line instead if nobody is doing it.");
      return;
    }
    cur = cur.filter((x) => x !== houseId);
  } else {
    cur.push(houseId);
  }

  item.shares = cur.length === all.length ? [] : cur;
  save();
  render();
}

// Id of the item whose booking details are expanded (null when none).
let openBookingId = null;

function toggleBooking(id) {
  openBookingId = openBookingId === id ? null : id;
  render();
}

// Editor for everything that turns an estimate into a real reservation.
function buildBookingPanel(item) {
  const panel = document.createElement("div");
  panel.className = "booking-panel";
  // Every control saves and re-renders on change, so there's no separate save step.
  const commit = (fn) => () => { fn(); save(); render(); };

  function field(label, hint, wide) {
    const w = document.createElement("label");
    w.className = "bk-field" + (wide ? " bk-wide" : "");
    w.innerHTML = `<span class="bk-label">${label}${hint ? ` <em>${hint}</em>` : ""}</span>`;
    return w;
  }

  // How the price was quoted — decides whether it scales with the group.
  const modeWrap = field("Price is");
  const modeSel = document.createElement("select");
  for (const key of Booking.PRICE_ORDER) {
    const o = document.createElement("option");
    o.value = key;
    o.textContent = Booking.PRICE_MODES[key].label;
    o.selected = Booking.priceMode(item) === key;
    modeSel.appendChild(o);
  }
  modeSel.addEventListener("change", commit(() => { item.priceMode = modeSel.value; }));
  modeWrap.appendChild(modeSel);
  const modeNote = document.createElement("div");
  modeNote.className = "bk-note";
  modeNote.textContent = Booking.PRICE_MODES[Booking.priceMode(item)].hint;
  modeWrap.appendChild(modeNote);

  // Status — where this sits between "we think" and "money has left the account".
  const statusWrap = field("Status");
  const statusSel = document.createElement("select");
  for (const key of Booking.STATUS_ORDER) {
    const o = document.createElement("option");
    o.value = key;
    o.textContent = Booking.STATUS[key].label;
    o.selected = Booking.statusOf(item) === key;
    statusSel.appendChild(o);
  }
  statusSel.addEventListener("change", commit(() => { item.status = statusSel.value; }));
  statusWrap.appendChild(statusSel);

  // Actual charged — blank means this is still just an estimate.
  const unitLabel = Booking.PRICE_MODES[Booking.priceMode(item)].unit;
  const actualWrap = field(
    "Actual charged" + (unitLabel ? " (" + unitLabel + ")" : ""),
    "blank = still an estimate");
  const actualInput = document.createElement("input");
  actualInput.type = "number";
  actualInput.min = "0";
  actualInput.step = "0.01";
  actualInput.placeholder = `est ${fmtUSD(item.cost || 0)}`;
  actualInput.value = Booking.hasActual(item) ? String(item.actual) : "";
  actualInput.addEventListener("change", commit(() => {
    const raw = actualInput.value.trim();
    item.actual = raw === "" ? null : Math.max(0, parseFloat(raw) || 0);
    // Entering real money implies it's at least booked.
    if (item.actual !== null && item.status === "est") item.status = "booked";
  }));
  actualWrap.appendChild(actualInput);

  function textField(label, key, placeholder, hint) {
    const w = field(label, hint);
    const inp = document.createElement("input");
    inp.type = "text";
    inp.placeholder = placeholder;
    inp.value = item[key] || "";
    inp.addEventListener("change", commit(() => { item[key] = inp.value.trim(); }));
    w.appendChild(inp);
    return w;
  }

  // Who fronted the money — drives the settle-up.
  const payerWrap = field("Paid by");
  const payerSel = document.createElement("select");
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "\u2014 nobody yet \u2014";
  noneOpt.selected = !item.payer;
  payerSel.appendChild(noneOpt);
  for (const h of Booking.households(state)) {
    const o = document.createElement("option");
    o.value = h.id;
    o.textContent = h.name;
    o.selected = item.payer === h.id;
    payerSel.appendChild(o);
  }
  payerSel.addEventListener("change", commit(() => { item.payer = payerSel.value; }));
  payerWrap.appendChild(payerSel);

  panel.append(
    modeWrap,
    statusWrap,
    actualWrap,
    textField("Confirmation #", "conf", "e.g. HMKQ4X2B"),
    textField("Booked with", "vendor", "e.g. JetBlue, Airbnb"),
    payerWrap,
    textField("Link", "url", "https://\u2026")
  );

  // Who splits it. Nothing checked means the whole group is in on it.
  const houses = Booking.households(state);
  const splitWrap = field("Split between", "none checked = everyone", true);
  if (houses.length === 0) {
    const note = document.createElement("div");
    note.className = "bk-note";
    note.textContent = "Add the families travelling with you up top, then you can split this between them.";
    splitWrap.appendChild(note);
  } else {
    const boxes = document.createElement("div");
    boxes.className = "bk-boxes";
    for (const h of houses) {
      const lab = document.createElement("span");
      lab.className = "bk-box";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = Array.isArray(item.shares) && item.shares.includes(h.id);
      cb.addEventListener("change", commit(() => {
        const picked = new Set(Array.isArray(item.shares) ? item.shares : []);
        if (cb.checked) picked.add(h.id); else picked.delete(h.id);
        item.shares = [...picked];
      }));
      const text = document.createElement("span");
      text.textContent = ` ${h.name} (${Booking.headsOf(h)})`;
      lab.append(cb, text);
      boxes.appendChild(lab);
    }
    splitWrap.appendChild(boxes);
    // Show the resulting damage per household so the split is never a mystery.
    const split = Booking.splitItem(state, item);
    const parts = Object.keys(split)
      .map((id) => `${Booking.householdName(state, id)} ${fmtUSD(Math.round(split[id]))}`)
      .join(" \u00b7 ");
    if (parts) {
      const out = document.createElement("div");
      out.className = "bk-note";
      out.textContent = `Each household's share: ${parts}`;
      splitWrap.appendChild(out);
    }
  }
  panel.appendChild(splitWrap);

  const notesWrap = field("Notes", "flight numbers, check-in time, door code\u2026", true);
  const notes = document.createElement("textarea");
  notes.rows = 2;
  notes.value = item.notes || "";
  notes.addEventListener("change", commit(() => { item.notes = notes.value.trim(); }));
  notesWrap.appendChild(notes);
  panel.appendChild(notesWrap);

  return panel;
}

function escapeHTML(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// True when an item spans more than one day (a real end date after its start).
function isRange(item) {
  return !!(item.endDate && item.endDate > item.date);
}

// Order by start date (undated last); on the same day, single-day activities come
// before multi-day ranges that begin that day; then by title.
function byDateThenTitle(a, b) {
  const ak = a.date || "9999-12-31";
  const bk = b.date || "9999-12-31";
  if (ak !== bk) return ak < bk ? -1 : 1;
  const ar = isRange(a) ? 1 : 0;
  const br = isRange(b) ? 1 : 0;
  if (ar !== br) return ar - br;
  return a.title.localeCompare(b.title);
}

function buildGroupCard(name) {
  const members = state.items.filter((it) => it.group === name);
  const on = isGroupOn(name);

  const card = document.createElement("div");
  card.className = "group-card" + (on ? "" : " off");

  const header = document.createElement("div");
  header.className = "gc-header";

  const dates = groupDatesFor(name);
  const dateText = dates ? fmtDateRange(dates.date, dates.endDate) : "";
  const metaBits = [`pick one of ${members.length}`];
  if (dateText) metaBits.push(dateText);
  const titleEl = document.createElement("div");
  titleEl.className = "gc-title";
  titleEl.innerHTML =
    `<span class="gc-icon">🔀</span>${escapeHTML(name)}` +
    `<span class="gc-meta">${metaBits.join(" · ")}</span>`;

  const includeLabel = document.createElement("label");
  includeLabel.className = "gc-include";
  const includeCb = document.createElement("input");
  includeCb.type = "checkbox";
  includeCb.checked = on;
  includeCb.title = "Uncheck to skip this whole group (counts as $0)";
  includeCb.addEventListener("change", () => toggleGroupOn(name));
  includeLabel.append(includeCb, document.createTextNode("Include this group"));

  header.append(titleEl, includeLabel);
  card.append(header);

  for (const m of members) card.append(buildRow(m));
  return card;
}

// Shared start date + whether the group's range spans multiple days, for sorting.
function groupSortInfo(name) {
  const d = groupDatesFor(name) || { date: "", endDate: "" };
  return { date: d.date || "9999-12-31", range: !!(d.endDate && d.endDate > d.date) };
}

// Order groups by their shared start date, keeping creation order as the tiebreak.
function orderedGroupNames() {
  return groupNames()
    .map((name, i) => ({ name, i, key: (groupDatesFor(name)?.date) || "9999-12-31" }))
    .sort((a, b) => (a.key !== b.key ? (a.key < b.key ? -1 : 1) : a.i - b.i))
    .map((o) => o.name);
}

function render() {
  ensureGroupSelections();
  refreshGroupDatalist();
  renderHouseholds();
  const list = $("itineraryList");
  list.innerHTML = "";

  if (state.items.length === 0) {
    list.innerHTML = '<div class="empty">Nothing added yet. Use the form above to add your first activity.</div>';
    renderTotals();
    return;
  }

  const ungrouped = state.items.filter((it) => !it.group);

  if (state.sort === "date") {
    // One timeline: group cards and individual items interleaved by date, with
    // single-day activities ahead of ranges that begin the same day.
    const entries = [];
    for (const name of groupNames()) {
      const info = groupSortInfo(name);
      entries.push({ date: info.date, range: info.range, title: name, node: buildGroupCard(name) });
    }
    for (const item of ungrouped) {
      entries.push({ date: item.date || "9999-12-31", range: isRange(item), title: item.title, node: buildRow(item) });
    }
    entries.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      const ar = a.range ? 1 : 0, br = b.range ? 1 : 0;
      if (ar !== br) return ar - br;
      return a.title.localeCompare(b.title);
    });
    for (const e of entries) list.appendChild(e.node);
  } else {
    // Group-by-type: choice groups first, then a section per activity type.
    const groups = orderedGroupNames();
    if (groups.length) {
      const heading = document.createElement("div");
      heading.className = "area-heading";
      heading.textContent = "Choice groups";
      list.appendChild(heading);
      for (const name of groups) list.appendChild(buildGroupCard(name));
    }
    for (const type of TYPE_ORDER) {
      const inType = ungrouped.filter((it) => it.type === type).sort(byDateThenTitle);
      if (inType.length === 0) continue;
      const heading = document.createElement("div");
      heading.className = "area-heading";
      heading.textContent = (TYPES[type] || TYPES.other).label;
      list.appendChild(heading);
      for (const item of inType) list.appendChild(buildRow(item));
    }
  }

  renderTotals();
}

function renderTotals() {
  // Every total runs on the effective cost: real money where we have it, estimate elsewhere.
  const counted = state.items.filter(isCounted);
  let fixed = 0, choices = 0, optionalInc = 0;
  let optionalCount = 0, optionalOn = 0;
  for (const item of state.items) {
    const c = Booking.effCost(state, item);
    if (item.group) {
      if (isCounted(item)) choices += c;
    } else if (item.optional) {
      optionalCount++;
      if (item.included) { optionalInc += c; optionalOn++; }
    } else {
      fixed += c;
    }
  }
  const grand = fixed + choices + optionalInc;

  const lines = [];
  const hasFixed = state.items.some((it) => !it.group && !it.optional);
  const hasGroups = groupNames().length > 0;
  if (hasFixed) lines.push(["Committed (always counted)", fixed]);
  if (hasGroups) lines.push(["Selected choices", choices]);
  if (optionalCount > 0) lines.push(["Optional items included", optionalInc]);

  $("totalLines").innerHTML = lines.map(
    ([label, val]) => `<div class="total-row"><span class="label">${label}</span><span class="val">${fmtUSD(val)}</span></div>`
  ).join("");
  $("grandTotal").textContent = fmtUSD(grand);

  let note = "";
  if (state.items.length > 0) {
    note = `${counted.length} of ${state.items.length} item${state.items.length === 1 ? "" : "s"} counted`;
    if (optionalCount > 0) note += ` · ${optionalOn}/${optionalCount} optional on`;
    if (hasGroups) note += ` · ${groupNames().length} choice group${groupNames().length === 1 ? "" : "s"}`;
  }
  $("totalNote").textContent = note;

  renderReality(counted);
  renderLedger(counted);
}

// The estimate-vs-reality bar: how much of the trip is locked in, and whether the
// real charges are landing above or below what we budgeted.
function renderReality(counted) {
  const box = $("realityBox");
  if (!box) return;
  const r = Booking.rollup(state, counted);
  if (counted.length === 0) { box.innerHTML = ""; return; }

  const pct = r.eff > 0 ? Math.round((r.locked / r.eff) * 100) : 0;
  let varLine = "";
  if (r.nLocked > 0) {
    if (Math.abs(r.variance) < 1) {
      varLine = '<span class="var on">Real costs are landing exactly on the estimate.</span>';
    } else {
      const over = r.variance > 0;
      varLine = `<span class="var ${over ? "over" : "under"}">Real costs are landing ${fmtUSD(Math.abs(r.variance))} ${over ? "OVER" : "UNDER"} the original estimate.</span>`;
    }
  }

  box.innerHTML =
    '<div class="reality-head">Estimated vs actual</div>' +
    '<div class="reality-bar" title="Share of the trip total that is real, booked money">' +
      `<span class="bar-locked" style="width:${pct}%"></span>` +
    '</div>' +
    '<div class="reality-rows">' +
      `<div class="total-row"><span class="label"><span class="key-dot locked"></span>Booked / paid ${r.nLocked ? `(${r.nLocked} item${r.nLocked === 1 ? "" : "s"})` : ""}</span><span class="val">${fmtUSD(r.locked)}</span></div>` +
      `<div class="total-row"><span class="label"><span class="key-dot open"></span>Still estimated ${r.nOpen ? `(${r.nOpen} item${r.nOpen === 1 ? "" : "s"})` : ""}</span><span class="val">${fmtUSD(r.open)}</span></div>` +
      `<div class="total-row muted"><span class="label">Original estimate for the same items</span><span class="val">${fmtUSD(r.est)}</span></div>` +
    '</div>' +
    `<div class="reality-note">${pct}% of the trip is locked in. ${varLine}</div>`;
}

// Per-household books plus the shortest set of transfers that squares everyone up.
function renderLedger(counted) {
  const box = $("ledgerBox");
  if (!box) return;
  const houses = Booking.households(state);
  if (houses.length === 0 || counted.length === 0) { box.innerHTML = ""; return; }

  const rows = Booking.ledger(state, counted);
  const heads = Booking.totalPeople(state);
  const owedToVendors = Booking.unfunded(state, counted);

  let html = `<div class="reality-head">Who owes what · ${houses.length} households, ${heads} ${heads === 1 ? "person" : "people"}</div>`;
  html += '<table class="ledger"><thead><tr>' +
    '<th>Household</th>' +
    '<th title="Their share of the whole trip">Share of trip</th>' +
    '<th title="What this household has already laid out">Fronted</th>' +
    '<th title="Settling up only moves money somebody actually paid">Owes the group</th>' +
    '</tr></thead><tbody>';
  for (const r of rows) {
    const net = Math.round(r.net);
    const cls = net > 0 ? "pos" : net < 0 ? "neg" : "zero";
    const netText = net === 0 ? "even" : net > 0 ? `owed ${fmtUSD(net)}` : `owes ${fmtUSD(-net)}`;
    html += `<tr><td>${escapeHTML(r.name)} <span class="hh-size">${r.size}</span></td>` +
      `<td>${fmtUSD(Math.round(r.owes))}</td>` +
      `<td>${fmtUSD(Math.round(r.paid))}</td>` +
      `<td class="net ${cls}">${netText}</td></tr>`;
  }
  html += "</tbody></table>";

  const transfers = Booking.settle(rows);
  if (transfers.length === 0) {
    html += '<div class="reality-note">Nobody owes anybody yet — set "Paid by" on an expense and the settle-up will appear here.</div>';
  } else {
    html += `<div class="settle-head">Settle up in ${transfers.length} payment${transfers.length === 1 ? "" : "s"}</div><ul class="settle">`;
    for (const t of transfers) {
      html += `<li><strong>${escapeHTML(t.from)}</strong> pays <strong>${escapeHTML(t.to)}</strong> <span class="amt">${fmtUSD(Math.round(t.amount))}</span></li>`;
    }
    html += "</ul>";
  }

  // The gap between "share of trip" and the settle-up: costs still owed to airlines,
  // hosts and parks rather than to another family.
  if (owedToVendors >= 1) {
    html += `<div class="reality-note"><strong>${fmtUSD(Math.round(owedToVendors))}</strong> of the trip has no payer recorded yet, so it isn't in the settle-up above — that money is still owed to airlines, hosts and parks, not to another family. Each household's "share of trip" already includes their part of it.</div>`;
  }

  box.innerHTML = html;
}

// --- Households ------------------------------------------------------------
// The families travelling together. Sizes drive the weighted split, so a family of
// five carries more of a shared house than a couple does.
function addHousehold() {
  const nameEl = $("hhName"), adultsEl = $("hhAdults"), kidsEl = $("hhKids");
  const name = nameEl.value.trim();
  if (!name) { nameEl.focus(); return; }
  const adults = Math.max(0, parseInt(adultsEl.value, 10) || 0);
  const kids = Math.max(0, parseInt(kidsEl.value, 10) || 0);
  state.households.push({
    id: "h" + Date.now() + Math.floor(Math.random() * 1000),
    name, adults, kids,
    share: 1,              // full share until the organiser says otherwise
    size: adults + kids,   // kept so older code paths and saved plans still read a size
  });
  nameEl.value = "";
  adultsEl.value = "";
  kidsEl.value = "";
  save();
  render();
  nameEl.focus();
}

function deleteHousehold(id) {
  const h = Booking.householdById(state, id);
  const name = h ? h.name : "this household";
  if (!confirm(`Remove ${name}? Any expense they were paying for or splitting will be unassigned.`)) return;
  state.households = state.households.filter((x) => x.id !== id);
  // Clean up references so no item points at a household that no longer exists.
  for (const it of state.items) {
    if (it.payer === id) it.payer = "";
    if (Array.isArray(it.shares)) it.shares = it.shares.filter((x) => x !== id);
  }
  save();
  render();
}

function renderHouseholds() {
  const box = $("householdList");
  if (!box) return;
  box.innerHTML = "";
  const houses = Booking.households(state);
  if (houses.length === 0) {
    box.innerHTML = '<div class="empty small">No families added yet. Add each household travelling with you — the head count drives how shared costs get split.</div>';
    return;
  }
  for (const h of houses) {
    const row = document.createElement("div");
    row.className = "hh-row";

    const name = document.createElement("input");
    name.type = "text";
    name.className = "hh-name";
    name.value = h.name;
    name.addEventListener("change", () => { h.name = name.value.trim() || h.name; save(); render(); });

    function counter(value, label, apply) {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.className = "hh-count";
      inp.min = "0";
      inp.step = "1";
      inp.value = String(value);
      inp.title = label;
      inp.addEventListener("change", () => {
        apply(Math.max(0, parseInt(inp.value, 10) || 0));
        h.size = Booking.headsOf(h);   // keep the flat size in step
        save();
        render();
      });
      return inp;
    }
    const adults = counter(Booking.adultsOf(h), "Adults in this household", (v) => { h.adults = v; });
    const kids = counter(Booking.kidsOf(h), "Children in this household", (v) => { h.kids = v; });

    const del = document.createElement("button");
    del.className = "icon-btn danger";
    del.textContent = "Remove";
    del.addEventListener("click", () => deleteHousehold(h.id));

    row.append(name, adults, kids);
    if (Booking.splitBasis(state) === "shares") {
      const share = document.createElement("input");
      share.type = "number";
      share.className = "hh-count hh-share";
      share.min = "0";
      share.step = "0.25";
      share.value = String(Booking.shareOf(h));
      share.title = "This household's share of a shared cost (1 = a full share)";
      share.addEventListener("change", () => {
        const n = parseFloat(share.value);
        h.share = isFinite(n) && n >= 0 ? n : 1;
        save();
        render();
      });
      row.appendChild(share);
    }
    row.appendChild(del);
    box.appendChild(row);
  }
  const heads = Booking.totalPeople(state);
  const kids = Booking.totalKids(state);
  const tally = document.createElement("div");
  tally.className = "hh-tally";
  tally.textContent =
    `${houses.length} household${houses.length === 1 ? "" : "s"} · ${heads} ${heads === 1 ? "person" : "people"} total` +
    (kids ? ` (${Booking.totalAdults(state)} adults, ${kids} ${kids === 1 ? "child" : "children"})` : "");
  box.appendChild(tally);

  // How a share is weighted is a group decision, so surface it right next to the roster.
  const basisWrap = document.createElement("div");
  basisWrap.className = "basis-wrap";
  const basisLabel = document.createElement("label");
  basisLabel.className = "bk-label";
  basisLabel.textContent = "Split shared costs";
  const basisSel = document.createElement("select");
  basisSel.id = "splitBasis";
  for (const key of Booking.SPLIT_ORDER) {
    const o = document.createElement("option");
    o.value = key;
    o.textContent = Booking.SPLIT_BASES[key].label;
    o.selected = Booking.splitBasis(state) === key;
    basisSel.appendChild(o);
  }
  basisSel.addEventListener("change", () => { state.splitBasis = basisSel.value; save(); render(); });
  const basisNote = document.createElement("div");
  basisNote.className = "bk-note";
  basisNote.textContent = Booking.SPLIT_BASES[Booking.splitBasis(state)].note;
  if (Booking.splitBasis(state) === "shares") {
    const totalShares = houses.reduce((n, x) => n + Booking.shareOf(x), 0);
    basisNote.textContent +=
      ` Currently ${totalShares} share${totalShares === 1 ? "" : "s"} across ${houses.length} household${houses.length === 1 ? "" : "s"} — the "share" box on each row sets it.`;
  }
  basisWrap.append(basisLabel, basisSel, basisNote);
  box.appendChild(basisWrap);
}

// --- Sharing --------------------------------------------------------------
// Encode the plan into the URL of a view-only page so it can be sent as a link.
function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return decodeURIComponent(escape(atob(s)));
}

// The published pages. Used when the planner is opened from a local file so links
// still point at URLs that work on other people's devices.
const LIVE_VIEW_URL = "https://babbishai.github.io/trip-tracker/index.html";
const LIVE_BUILDER_URL = "https://babbishai.github.io/trip-tracker/edit.html";

function currentPayload() {
  return {
    v: 2,
    title: state.title,
    items: state.items,
    // The roster has to travel with the plan. Without it a second device rebuilds
    // households with fresh ids, so item.payer and item.shares match nobody and the
    // settle-up renders confidently wrong instead of visibly empty.
    households: state.households,
    splitBasis: state.splitBasis,
    groupSel: state.groupSel,
    groupOff: state.groupOff,
  };
}

// Resolve a published page URL: relative on the live site, absolute from a local file.
function publishedBase(fileName, liveUrl) {
  const isWeb = location.protocol === "http:" || location.protocol === "https:";
  return isWeb ? new URL(fileName, location.href).href : liveUrl;
}

// Short, STABLE links backed by the cloud id (contents live in Supabase).
function viewLinkFor(id) {
  return publishedBase("index.html", LIVE_VIEW_URL) + "?id=" + encodeURIComponent(id);
}
function editLinkFor(id) {
  return publishedBase("edit.html", LIVE_BUILDER_URL) + "?id=" + encodeURIComponent(id);
}

async function cloudFetch(id) {
  const res = await fetch(SUPABASE.url + "/rpc/get_plan", {
    method: "POST",
    headers: sbHeaders(),
    body: JSON.stringify({ pid: id }),
  });
  if (!res.ok) throw new Error("cloud load failed: " + res.status);
  return res.json(); // stored plan object, or null
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject();
}

// Ensure the plan exists in the cloud under a stable id, and return that id.
async function ensurePublished() {
  if (!state.cloudId) state.cloudId = newId();
  await cloudSave(state.cloudId, currentPayload());
  state.published = true;
  save(); // persist cloudId + published
  setSyncStatus("synced");
  return state.cloudId;
}

// Show a cloud-backed link in the share box: publish (if needed), then present + copy.
async function presentCloudLink(label, linkFor, copiedMsg, workingMsg) {
  $("shareBoxLabel").textContent = label;
  $("shareBox").hidden = false;
  if (state.items.length === 0) {
    $("shareLink").value = "";
    $("copyMsg").textContent = "Add at least one activity first.";
    return;
  }
  if (!SUPABASE.url) {
    $("shareLink").value = "";
    $("copyMsg").textContent = "Cloud storage isn't configured.";
    return;
  }
  $("copyMsg").textContent = workingMsg;
  try {
    const id = await ensurePublished();
    const link = linkFor(id);
    $("shareLink").value = link;
    $("shareLink").select();
    copyToClipboard(link)
      .then(() => { $("copyMsg").textContent = copiedMsg; })
      .catch(() => { $("copyMsg").textContent = "Ready! Select the link above and copy it (Ctrl+C)."; });
  } catch (e) {
    $("copyMsg").textContent = "Couldn't reach the cloud — check your connection and try again.";
  }
}

// View-only link for the group.
function publishShare() {
  return presentCloudLink(
    "Anyone with this link can view your itinerary. It stays the same and updates automatically as you edit:",
    viewLinkFor,
    "Published & link copied — it stays the same and always shows your latest changes.",
    "Publishing…"
  );
}

// Short link that loads this plan into the builder on another device to keep editing.
function showEditLink() {
  return presentCloudLink(
    "Open this link in a builder on any device to keep editing this same itinerary (edits sync to the same shared link):",
    editLinkFor,
    "Edit link copied — open it where you want to edit (e.g. the published site).",
    "Preparing…"
  );
}

function copyShareLink() {
  const el = $("shareLink");
  if (!el.value) return;
  el.select();
  const done = () => { $("copyMsg").textContent = "Copied!"; };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(el.value).then(done).catch(() => { try { document.execCommand("copy"); done(); } catch (e) {} });
  } else {
    try { document.execCommand("copy"); done(); } catch (e) {}
  }
}

// If the page was opened with a plan in the URL hash (an "editable link"), offer to
// load it into this builder. Runs after load() so we can warn about overwriting.
function maybeImportFromHash() {
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return;
  let payload;
  try { payload = JSON.parse(b64urlDecode(hash)); } catch (e) { return; }
  if (!payload || !Array.isArray(payload.items)) return;

  // Always clear the hash so a later refresh doesn't re-prompt.
  const clearHash = () => history.replaceState(null, "", location.pathname + location.search);

  const incoming = payload.title ? `"${payload.title}"` : "this shared plan";
  const question = state.items.length > 0
    ? `Load ${incoming} into this builder?\n\nThis REPLACES the ${state.items.length} item(s) currently here. (Tip: use "Copy editable link" first if you want to keep the current one.)`
    : `Load ${incoming} into this builder?`;

  if (!window.confirm(question)) { clearHash(); return; }

  state = Object.assign(
    { title: "", sort: "type", items: [], households: [], splitBasis: "people", groupSel: {}, groupOff: {}, lastDate: "", lastEndDate: "", lastPeople: "", cloudId: "", published: false },
    {
      title: payload.title || "",
      items: payload.items || [],
      households: Array.isArray(payload.households) ? payload.households : [],
      splitBasis: payload.splitBasis || "people",
      groupSel: payload.groupSel || {},
      groupOff: payload.groupOff || {},
    }
  );
  // Backfill any per-item fields the payload might not carry.
  for (const it of state.items) {
    if (typeof it.date !== "string") it.date = "";
    if (typeof it.endDate !== "string") it.endDate = "";
    if (typeof it.people !== "number") it.people = 0;
    if (typeof it.group !== "string") it.group = "";
    if (typeof it.optional !== "boolean") it.optional = false;
    if (typeof it.included !== "boolean") it.included = true;
  }
  save();
  clearHash();
}

// If opened as edit.html?id=XXX, load that cloud plan into the editor.
// Adopts the cloud id so further edits sync back to the same shared link.
async function maybeLoadFromCloud() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id || !SUPABASE.url) return;
  const clearId = () => history.replaceState(null, "", location.pathname);

  // Already editing this exact plan here — nothing to load.
  if (state.cloudId === id) { clearId(); return; }

  let data;
  try {
    data = await cloudFetch(id);
  } catch (e) {
    window.alert("Couldn't load that itinerary — it may be waking up. Try the link again in a moment.");
    return;
  }
  if (!data || !Array.isArray(data.items)) {
    window.alert("That link's itinerary couldn't be found.");
    clearId();
    return;
  }

  const incoming = data.title ? `"${data.title}"` : "this itinerary";
  const proceed = state.items.length === 0
    ? true
    : window.confirm(`Load ${incoming} here to edit?\n\nThis replaces the ${state.items.length} item(s) currently in this builder.`);
  if (!proceed) { clearId(); return; }

  state = Object.assign(
    { title: "", sort: "type", items: [], households: [], splitBasis: "people", groupSel: {}, groupOff: {}, lastDate: "", lastEndDate: "", lastPeople: "", cloudId: "", published: false },
    {
      title: data.title || "",
      items: data.items || [],
      households: Array.isArray(data.households) ? data.households : [],
      splitBasis: data.splitBasis || "people",
      groupSel: data.groupSel || {},
      groupOff: data.groupOff || {},
      cloudId: id,        // adopt the id so edits sync to the same link
      published: true,
    }
  );
  for (const it of state.items) {
    if (typeof it.date !== "string") it.date = "";
    if (typeof it.endDate !== "string") it.endDate = "";
    if (typeof it.people !== "number") it.people = 0;
    if (typeof it.group !== "string") it.group = "";
    if (typeof it.optional !== "boolean") it.optional = false;
    if (typeof it.included !== "boolean") it.included = true;
  }
  save();
  clearId();
}

async function init() {
  load();
  maybeImportFromHash();
  await maybeLoadFromCloud();

  $("itineraryTitle").value = state.title || "";
  if (state.title) document.title = state.title + " — Itinerary";
  $("sortMode").value = state.sort || "type";

  // Seed the calendar to a relevant month: last entered range, else the earliest
  // date already in the itinerary. Keeps the picker off today's month for a future trip.
  const datedStarts = state.items.map((it) => it.date).filter(Boolean).sort();
  const anchor = state.lastDate || datedStarts[0] || "";
  if (anchor) $("itemDate").value = anchor;
  if (state.lastEndDate) $("itemEndDate").value = state.lastEndDate;
  if (state.lastPeople) $("itemPeople").value = state.lastPeople;
  syncEndMin();

  render();

  $("addBtn").addEventListener("click", addItem);
  $("addHhBtn").addEventListener("click", addHousehold);
  for (const id of ["hhName", "hhAdults", "hhKids"]) {
    $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") addHousehold(); });
  }
  for (const id of ["itemTitle", "itemCost", "itemPeople", "groupName"]) {
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addItem(); }
    });
  }
  for (const r of document.querySelectorAll('input[name="countMode"]')) {
    r.addEventListener("change", syncGroupNameVisibility);
  }
  $("itemDate").addEventListener("change", syncEndMin);
  $("groupName").addEventListener("input", fillFormDatesFromGroup);
  syncGroupNameVisibility();

  $("itineraryTitle").addEventListener("input", () => {
    state.title = $("itineraryTitle").value;
    document.title = state.title ? state.title + " — Itinerary" : "WDW Trip Planner — Itinerary Builder";
    save();
  });
  $("sortMode").addEventListener("change", () => {
    state.sort = $("sortMode").value;
    save();
    render();
  });

  $("shareBtn").addEventListener("click", publishShare);
  $("moveBtn").addEventListener("click", showEditLink);
  $("copyLink").addEventListener("click", copyShareLink);

  // If this plan was already published, keep its link current from the moment it loads.
  if (state.published && state.cloudId) setSyncStatus("synced");
}

init();
