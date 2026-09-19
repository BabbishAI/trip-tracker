// WDW Trip Planner — shared, view-only itinerary for non-planners.
// The whole plan travels in the URL hash (base64url-encoded JSON) so no server is
// needed. Choice groups render as dropdowns; picking "None" drops the group.

const $ = (sel) => document.querySelector(sel);

const SUPABASE = window.SUPABASE || {};

// Fetch a plan by id via the get_plan() function (reads are limited to exact-id lookups).
async function cloudFetch(id) {
  const res = await fetch(SUPABASE.url + "/rpc/get_plan", {
    method: "POST",
    headers: {
      "apikey": SUPABASE.anon,
      "Authorization": "Bearer " + SUPABASE.anon,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pid: id }),
  });
  if (!res.ok) throw new Error("load failed: " + res.status);
  return res.json(); // the stored plan object, or null if the id isn't found
}

function fmtUSD(n) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function parseISO(s) { return new Date(s + "T00:00:00"); }
function fmtDate(iso) {
  if (!iso) return "";
  return parseISO(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
function fmtDateRange(start, end) {
  if (!start) return "";
  if (end && end > start) return `${fmtDate(start)} → ${fmtDate(end)}`;
  return fmtDate(start);
}
function perPersonText(cost, people) {
  if (!people || people <= 1 || !cost) return "";
  return `${fmtUSD(Math.round(cost / people))}/person`;
}
function escapeHTML(s) {
  const div = document.createElement("div");
  div.textContent = s == null ? "" : String(s);
  return div.innerHTML;
}

const TYPES = {
  flight:      { icon: "✈️", label: "Flight" },
  stay:        { icon: "🏨", label: "Stay" },
  car:         { icon: "🚗", label: "Car rental" },
  reservation: { icon: "🍽️", label: "Reservation" },
  ticket:      { icon: "🎟️", label: "Ticket" },
  other:       { icon: "📌", label: "Other" },
};

// --- URL payload decoding -------------------------------------------------
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return decodeURIComponent(escape(atob(s)));
}
function readPayload() {
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return null;
  try {
    return JSON.parse(b64urlDecode(hash));
  } catch (e) {
    return null;
  }
}

// --- State ----------------------------------------------------------------
let plan = null;      // decoded payload: { title, items, households, splitBasis, groupSel, groupOff }
let planId = "";      // the ?id= of a cloud plan, used to scope this viewer's own settings
let vSel = {};        // group name -> chosen item id, or "" for none
// Whether an item counts toward the trip. Every item can be switched off without
// being deleted — the group decides against something but keeps the price, the
// confirmation number and the notes on the page. Unset means in, so nothing written
// before this field existed changes.
function isIncluded(item) {
  return !item || item.included !== false;
}

function groupNames() {
  const seen = [];
  for (const it of plan.items) {
    if (it.group && !seen.includes(it.group)) seen.push(it.group);
  }
  return seen;
}
function groupMembers(name) { return plan.items.filter((it) => it.group === name); }
function groupDates(name) {
  const first = groupMembers(name)[0];
  return first ? { date: first.date || "", endDate: first.endDate || "" } : { date: "", endDate: "" };
}

function initSelections() {
  const sel = plan.groupSel || {};
  const off = plan.groupOff || {};
  for (const name of groupNames()) {
    const members = groupMembers(name);
    if (off[name]) {
      vSel[name] = ""; // planner had this group skipped by default
    } else {
      const planned = sel[name];
      vSel[name] = members.some((m) => m.id === planned) ? planned : members[0].id;
    }
  }
  for (const it of plan.items) {
  }
}

// --- Totals ---------------------------------------------------------------
function costOf(id) {
  const it = plan.items.find((x) => x.id === id);
  return it ? Booking.effCost(plan, it) : 0;
}
function computeTotal() {
  let total = 0;
  for (const it of plan.items) {
    if (it.group) continue; // groups handled below
    if (isIncluded(it)) total += Booking.effCost(plan, it);
  }
  for (const name of groupNames()) {
    if (vSel[name]) total += costOf(vSel[name]);
  }
  return total;
}

// --- Rendering ------------------------------------------------------------
function isRange(item) { return !!(item.endDate && item.endDate > item.date); }

// Everything the group needs to reference about one booking: where it stands, its
// confirmation code, who it's with, the notes, and each family's share of it.
function buildItemDetail(item) {
  const wrap = document.createElement("div");
  wrap.className = "v-detail";

  const chips = document.createElement("div");
  chips.className = "v-chips";

  const st = Booking.STATUS[Booking.statusOf(item)];
  const badge = document.createElement("span");
  badge.className = "v-badge " + st.cls;
  badge.textContent = st.label;
  chips.appendChild(badge);

  if (item.category) {
    const c = document.createElement("span");
    c.className = "v-chip v-cat";
    c.textContent = item.category;
    chips.appendChild(c);
  }

  if (item.vendor) {
    const v = document.createElement("span");
    v.className = "v-chip";
    v.textContent = item.vendor;
    chips.appendChild(v);
  }

  // The confirmation code, with a copy button — these get typed into airline and
  // rental apps on a phone, often one-handed at a counter.
  if (item.conf) {
    const box = document.createElement("span");
    box.className = "v-confbox";
    const code = document.createElement("span");
    code.className = "v-conf";
    code.textContent = item.conf;
    const copy = document.createElement("button");
    copy.className = "v-copy";
    copy.type = "button";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      const text = item.conf;
      const done = () => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1400); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
      } else {
        fallbackCopy(text, done);
      }
    });
    box.append(code, copy);
    chips.appendChild(box);
  }

  if (item.payer) {
    const who = Booking.householdName(plan, item.payer);
    if (who) {
      const p = document.createElement("span");
      p.className = "v-chip";
      p.textContent = "paid by " + who;
      chips.appendChild(p);
    }
  }
  if (chips.children.length) wrap.appendChild(chips);

  if (item.url) {
    const a = document.createElement("a");
    a.className = "v-link";
    a.href = item.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Open booking \u2197";
    wrap.appendChild(a);
  }

  if (item.notes) wrap.appendChild(buildNotes(item.notes));

  // Who is in on this expense, and what it costs them. On a shared cloud plan these
  // are live toggles — clicking one re-splits the bill for all four families.
  const shareEl = canEdit() ? buildShareToggles(item) : buildShareReadout(item);
  if (shareEl) wrap.appendChild(shareEl);

  return wrap;
}

// Notes carry the useful detail — addresses, door codes, why a decision was made —
// but printed in full they bury the itinerary. Lead with the first sentence and let
// people open the rest. Short notes render plainly, with nothing to click.
function buildNotes(text) {
  const full = String(text).trim();
  const lead = firstSentence(full);

  if (lead.length >= full.length) {
    const n = document.createElement("div");
    n.className = "v-notes";
    n.textContent = full;
    return n;
  }

  const det = document.createElement("details");
  det.className = "v-notes-wrap";
  const sum = document.createElement("summary");
  sum.className = "v-notes-lead";
  sum.textContent = lead;
  const rest = document.createElement("div");
  rest.className = "v-notes";
  rest.textContent = full;
  det.append(sum, rest);
  return det;
}

// First sentence, or a clean word-boundary trim if that first sentence is itself long.
function firstSentence(text) {
  const MAX = 90;
  const m = text.match(/^[\s\S]*?[.!?](?=\s|$)/);
  let lead = m ? m[0].trim() : text;
  if (lead.length > MAX) {
    const cut = lead.slice(0, MAX);
    const sp = cut.lastIndexOf(" ");
    lead = (sp > 40 ? cut.slice(0, sp) : cut).trim() + "\u2026";
  }
  return lead;
}

// Clipboard fallback for browsers that block the async clipboard API.
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); done(); } catch (e) {}
  ta.remove();
}

function buildItemRow(item) {
  const meta = TYPES[item.type] || TYPES.other;
  const included = isIncluded(item);
  const row = document.createElement("div");
  row.className = "v-row" + (included ? "" : " excluded");

  // Every item gets the switch, not just the ones flagged optional. Deciding against
  // something and deleting it are different acts: the first should keep the record.
  const control = document.createElement("input");
  control.type = "checkbox";
  control.className = "v-check";
  control.checked = included;
  control.title = included
    ? "Counting toward the trip — untick to drop it without deleting it"
    : "Not counting toward the trip — tick to put it back";
  control.addEventListener("change", function () {
    item.included = control.checked;
    saveSoon(item.id);
    render();
  });
  const main = document.createElement("div");
  const dateText = fmtDateRange(item.date, item.endDate);
  const sub = [meta.label];
  if (dateText) sub.push(dateText);
  if (item.people) sub.push(`for ${item.people}`);
  if (!isIncluded(item)) sub.push("not doing this");
  main.innerHTML =
    `<span class="v-title"><span class="v-icon">${meta.icon}</span>${escapeHTML(item.title)}</span>` +
    `<span class="v-sub">${sub.join(" · ")}</span>`;

  const cost = document.createElement("div");
  cost.className = "v-cost";
  const eff = Booking.effCost(plan, item);
  const units = Booking.unitsFor(plan, item);
  const mode = Booking.priceMode(item);
  let costHTML = fmtUSD(eff);
  if (mode !== "total" && units > 1) {
    const what = mode === "person" ? "people" : "families";
    costHTML += `<span class="v-perperson">${fmtUSD(Booking.unitPrice(item))} \u00d7 ${units} ${what}</span>`;
  } else {
    const perPerson = perPersonText(eff, item.people);
    if (perPerson) costHTML += `<span class="v-perperson">${perPerson}</span>`;
  }
  if (Booking.hasActual(item)) {
    const dv = Booking.variance(plan, item);
    if (Math.abs(dv) >= 1) {
      costHTML += `<span class="v-var ${dv > 0 ? "over" : "under"}">${dv > 0 ? "+" : "\u2212"}${fmtUSD(Math.abs(dv))} vs est</span>`;
    }
  }
  cost.innerHTML = costHTML;

  main.appendChild(buildItemDetail(item));

  if (canEdit()) {
    const tools = document.createElement("div");
    tools.className = "v-tools";
    tools.appendChild(buildEditButton(item));
    tools.appendChild(buildRemoveButton(item));
    main.appendChild(tools);
    if (editingId === item.id) main.appendChild(buildEditPanel(item));
  }
  row.append(control, main, cost);
  return row;
}

function buildGroupCard(name) {
  const members = groupMembers(name);
  const chosen = vSel[name];
  const card = document.createElement("div");
  card.className = "v-group" + (chosen ? "" : " none");

  const dates = groupDates(name);
  const dateText = fmtDateRange(dates.date, dates.endDate);
  const meta = TYPES[(members[0] || {}).type] || TYPES.other;

  const head = document.createElement("div");
  head.className = "v-group-head";
  const metaBits = ["choose one"];
  if (dateText) metaBits.push(dateText);
  head.innerHTML =
    `<span class="v-group-title"><span class="v-icon">${meta.icon}</span>${escapeHTML(name)}` +
    `<span class="v-group-meta">${metaBits.join(" · ")}</span></span>`;

  const rowEl = document.createElement("div");
  rowEl.className = "v-group-row";

  const select = document.createElement("select");
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "— None (skip) —";
  select.appendChild(noneOpt);
  for (const m of members) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = `${m.title} — ${fmtUSD(m.cost)}` + (m.people ? ` (for ${m.people})` : "");
    select.appendChild(opt);
  }
  select.value = chosen || "";
  select.addEventListener("change", () => { vSel[name] = select.value; render(); });

  const costEl = document.createElement("div");
  if (chosen) {
    const m = plan.items.find((x) => x.id === chosen);
    const perPerson = m ? perPersonText(m.cost, m.people) : "";
    costEl.className = "v-group-cost";
    costEl.innerHTML = fmtUSD(costOf(chosen)) + (perPerson ? `<span class="v-perperson">${perPerson}</span>` : "");
  } else {
    costEl.className = "v-group-cost none";
    costEl.textContent = "Not included";
  }

  rowEl.append(select, costEl);
  card.append(head, rowEl);
  return card;
}

// Build one chronological timeline of items + group cards.
function buildTimeline() {
  const frag = document.createDocumentFragment();
  const entries = [];
  for (const name of groupNames()) {
    const d = groupDates(name);
    entries.push({
      date: d.date || "9999-12-31",
      range: !!(d.endDate && d.endDate > d.date),
      title: name,
      node: buildGroupCard(name),
    });
  }
  for (const item of plan.items) {
    if (item.group) continue;
    entries.push({
      date: item.date || "9999-12-31",
      range: isRange(item),
      title: item.title,
      node: buildItemRow(item),
    });
  }
  entries.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const ar = a.range ? 1 : 0, br = b.range ? 1 : 0;
    if (ar !== br) return ar - br;
    return a.title.localeCompare(b.title);
  });
  for (const e of entries) frag.appendChild(e.node);
  return frag;
}

// Which household this viewer says they are. Stored per plan, in this browser only.
function meKey() { return "wdw-me-" + (planId || "hash"); }
function getMe() {
  try { return localStorage.getItem(meKey()) || ""; } catch (e) { return ""; }
}
function setMe(id) {
  try { id ? localStorage.setItem(meKey(), id) : localStorage.removeItem(meKey()); } catch (e) {}
  render();
}

// Only the items this viewer's selections actually count toward the trip.
function countedItems() {
  const out = [];
  for (const it of plan.items) {
    if (it.group) { if (vSel[it.group] === it.id) out.push(it); }
    else if (isIncluded(it)) out.push(it);
  }
  return out;
}

// One place the whole group can find every confirmation code, without scrolling
// the itinerary. This is the thing people open at a check-in desk.
function buildConfirmationPanel() {
  const booked = plan.items.filter((it) => it.conf);
  if (booked.length === 0) return null;

  const panel = document.createElement("div");
  panel.className = "panel";
  const det = document.createElement("details");
  det.className = "v-refs";
  det.open = true;

  let html = `<summary>All confirmation numbers <span class="v-count">${booked.length}</span></summary><table class="v-reftable"><tbody>`;
  for (const it of booked) {
    const meta = TYPES[it.type] || TYPES.other;
    const when = fmtDateRange(it.date, it.endDate);
    html += `<tr><td class="w"><span class="v-icon">${meta.icon}</span>${escapeHTML(it.title)}` +
      (when ? `<span class="v-refwhen">${when}</span>` : "") +
      `</td><td class="c"><span class="v-conf">${escapeHTML(it.conf)}</span></td></tr>`;
  }
  html += "</tbody></table>";
  det.innerHTML = html;
  panel.appendChild(det);
  return panel;
}

// "Which family are you?" — plus, once answered, that family's own bottom line.
function buildYouPanel() {
  const houses = Booking.households(plan);
  if (houses.length === 0) return null;

  const panel = document.createElement("div");
  panel.className = "panel";
  const me = getMe();

  const head = document.createElement("div");
  head.className = "you-head";
  head.textContent = me ? "Your share" : "Which family are you?";
  panel.appendChild(head);

  const pick = document.createElement("select");
  pick.className = "you-pick";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "— choose your family —";
  none.selected = !me;
  pick.appendChild(none);
  for (const h of houses) {
    const o = document.createElement("option");
    o.value = h.id;
    const kids = Booking.kidsOf(h);
    o.textContent = h.name + " (" + Booking.adultsOf(h) + " adult" + (Booking.adultsOf(h) === 1 ? "" : "s") +
      (kids ? ", " + kids + " kid" + (kids === 1 ? "" : "s") : "") + ")";
    o.selected = me === h.id;
    pick.appendChild(o);
  }
  pick.addEventListener("change", () => setMe(pick.value));
  panel.appendChild(pick);

  if (!me) {
    const hint = document.createElement("div");
    hint.className = "you-note";
    hint.textContent = "Pick your family and this page will show what your household owes, and what you've already paid. It's remembered on this device only — nobody else sees your choice.";
    panel.appendChild(hint);
    return panel;
  }

  const counted = countedItems();
  const rows = Booking.ledger(plan, counted);
  const mine = rows.find((r) => r.id === me);
  if (!mine) return panel;

  const net = Math.round(mine.net);
  const netText = net === 0
    ? "You're square with the group."
    : net > 0
      ? `The group owes you ${fmtUSD(net)}.`
      : `You owe the group ${fmtUSD(-net)}.`;

  const body = document.createElement("div");
  body.className = "you-body";
  body.innerHTML =
    `<div class="you-big ${net < 0 ? "neg" : net > 0 ? "pos" : ""}">${netText}</div>` +
    `<div class="total-row"><span class="label">Your share of the trip</span><span class="val">${fmtUSD(Math.round(mine.owes))}</span></div>` +
    `<div class="total-row"><span class="label">You've already paid</span><span class="val">${fmtUSD(Math.round(mine.paid))}</span></div>`;
  panel.appendChild(body);

  // Line-by-line, so the number above is never a black box.
  const lines = counted
    .map((it) => ({ it, amt: Booking.splitItem(plan, it)[me] || 0 }))
    .filter((r) => r.amt >= 0.5);
  if (lines.length) {
    let html = '<table class="you-lines"><tbody>';
    for (const r of lines) {
      html += `<tr><td>${escapeHTML(r.it.title)}</td><td class="amt">${fmtUSD(Math.round(r.amt))}</td></tr>`;
    }
    html += "</tbody></table>";
    const det = document.createElement("details");
    det.className = "you-detail";
    det.innerHTML = "<summary>How your share breaks down</summary>" + html;
    panel.appendChild(det);
  }

  const basis = Booking.SPLIT_BASES[Booking.splitBasis(plan)];
  if (basis) {
    const note = document.createElement("div");
    note.className = "you-note";
    note.textContent = "Shared costs are split " + basis.label.toLowerCase() + ".";
    panel.appendChild(note);
  }
  return panel;
}

// The whole group's books, so nobody has to take the organiser's word for it.
function buildLedgerPanel() {
  const houses = Booking.households(plan);
  if (houses.length === 0) return null;
  const counted = countedItems();
  const rows = Booking.ledger(plan, counted);
  const owedToVendors = Booking.unfunded(plan, counted);
  const me = getMe();

  const panel = document.createElement("div");
  panel.className = "panel";
  let html = '<div class="you-head">Everyone\u2019s share</div>';
  html += '<table class="v-ledger"><thead><tr><th>Household</th><th>Share of trip</th><th>Paid so far</th><th>Owes the group</th></tr></thead><tbody>';
  for (const r of rows) {
    const net = Math.round(r.net);
    const cls = net > 0 ? "pos" : net < 0 ? "neg" : "";
    const netText = net === 0 ? "even" : net > 0 ? `owed ${fmtUSD(net)}` : `owes ${fmtUSD(-net)}`;
    html += `<tr${r.id === me ? ' class="is-me"' : ""}><td>${escapeHTML(r.name)}</td>` +
      `<td>${fmtUSD(Math.round(r.owes))}</td><td>${fmtUSD(Math.round(r.paid))}</td>` +
      `<td class="net ${cls}">${netText}</td></tr>`;
  }
  html += "</tbody></table>";

  const transfers = Booking.settle(rows);
  if (transfers.length) {
    html += '<div class="you-head" style="margin-top:14px;">Settling up</div><ul class="settle">';
    for (const t of transfers) {
      const mineFlag = t.fromId === me || t.toId === me;
      html += `<li${mineFlag ? ' class="is-me"' : ""}><strong>${escapeHTML(t.from)}</strong> pays <strong>${escapeHTML(t.to)}</strong> <span class="amt">${fmtUSD(Math.round(t.amount))}</span></li>`;
    }
    html += "</ul>";
  }
  if (owedToVendors >= 1) {
    html += `<div class="you-note"><strong>${fmtUSD(Math.round(owedToVendors))}</strong> of the trip hasn\u2019t been paid by anyone yet, so it isn\u2019t in the settling-up above \u2014 that money is still owed to airlines, hosts and parks.</div>`;
  }
  panel.innerHTML = html;
  return panel;
}

function render() {
  const root = $("#viewRoot");
  const title = plan.title || "Trip Itinerary";
  document.title = title;

  const total = computeTotal();
  const chosenGroups = groupNames().filter((n) => vSel[n]).length;
  const totalGroups = groupNames().length;

  root.innerHTML = "";

  const h1 = document.createElement("h1");
  h1.textContent = title;
  const sub = document.createElement("p");
  sub.className = "sub";
  sub.textContent = canEdit()
    ? "Shared plan — anything you change here changes it for all four families, straight away."
    : "Shared plan — pick your options below to see the estimated total. Nothing you change here is saved.";
  root.append(h1, sub);
  root.appendChild(buildCategoryList());

  if (canEdit()) {
    const save = document.createElement("div");
    save.id = "saveState";
    save.className = "v-save";
    root.appendChild(save);
  }
  paintSaveState();

  const listPanel = document.createElement("div");
  listPanel.className = "panel";
  if (plan.items.length === 0) {
    listPanel.innerHTML = '<div class="empty">This itinerary is empty.</div>';
  } else {
    listPanel.appendChild(buildTimeline());
  }
  if (canEdit()) listPanel.appendChild(buildAddForm());
  root.appendChild(listPanel);

  const totalPanel = document.createElement("div");
  totalPanel.className = "panel total-panel";
  let note = "";
  if (totalGroups > 0) note = `${chosenGroups} of ${totalGroups} choice group${totalGroups === 1 ? "" : "s"} selected`;
  totalPanel.innerHTML =
    `<div class="total-row grand"><span class="label">Estimated trip total</span>` +
    `<span class="val">${fmtUSD(total)}</span></div>` +
    (note ? `<div class="total-note">${note}</div>` : "");
  root.appendChild(totalPanel);

  const refs = buildConfirmationPanel();
  if (refs) root.appendChild(refs);

  const cats = buildCategoryPanel();
  if (cats) root.appendChild(cats);

  const you = buildYouPanel();
  if (you) root.appendChild(you);
  const ledger = buildLedgerPanel();
  if (ledger) root.appendChild(ledger);

  const gift = buildGiftPanel();
  if (gift) root.appendChild(gift);
}

function renderEmpty() {
  $("#viewRoot").innerHTML =
    '<div class="empty"><h1 style="font-size:1.3rem;">No itinerary found</h1>' +
    "<p>This link doesn't point to a shared plan. Ask whoever sent it to share the link again, " +
    'or <a href="edit.html">open the editor</a>.</p></div>';
}

function renderMessage(html) {
  $("#viewRoot").innerHTML = '<div class="empty">' + html + "</div>";
}

function startPlan() {
  if (!plan || !Array.isArray(plan.items)) { renderEmpty(); return; }
  for (const it of plan.items) {
    it.date = it.date || "";
    it.endDate = it.endDate || "";
    it.people = it.people || 0;
    it.group = it.group || "";
  }
  initSelections();
  render();
}

async function init() {
  const id = new URLSearchParams(location.search).get("id");
  planId = id || "";
  if (id) {
    // Baked-in plans are served instantly and never depend on the cloud DB.
    const local = (window.LOCAL_PLANS || {})[id];
    if (local) { plan = local; startPlan(); return; }

    renderMessage("Loading itinerary…");
    try {
      plan = await cloudFetch(id);
    } catch (e) {
      renderMessage(
        '<h1 style="font-size:1.3rem;">Couldn\'t load this itinerary</h1>' +
        "<p>The plan couldn't be reached right now. It may be waking up — wait a moment and refresh. " +
        "If it keeps failing, ask the planner to re-share the link.</p>"
      );
      return;
    }
    startPlan();
  } else {
    // Legacy links that carry the whole plan in the hash.
    plan = readPayload();
    startPlan();
  }
}

init();

// --- Shared editing -------------------------------------------------------
// Everyone holding this link can change the plan, and every change is written back
// to the single shared copy. There is no personal draft: removing an item removes it
// for all fourteen people. That is deliberate — the group chose a shared ledger over
// per-person sandboxes — so the UI says so plainly before it writes.

let saveTimer = null;
let saveMsg = "";      // last status text, replayed after each re-render
let saveCls = "";

// Editing needs a cloud id to write back to. A legacy hash link carries the whole
// plan in the URL with nowhere to save, so it stays read-only.
function canEdit() { return !!planId; }

function newItemId() {
  return "i" + Date.now() + Math.floor(Math.random() * 1000);
}

// Mirror of the editor's payload. The roster has to travel with the plan or a second
// device rebuilds households with fresh ids and the ledger renders confidently wrong.
function currentPayload() {
  return {
    v: 2,
    title: plan.title,
    items: plan.items,
    households: plan.households,
    splitBasis: plan.splitBasis,
    groupSel: plan.groupSel,
    groupOff: plan.groupOff,
  };
}

// Which parts of the plan this browser has changed since its last successful save.
// A save writes the whole document, so without this a page that loaded ten minutes
// ago would push its stale copy over everything anyone else has done since — the
// change disappears with no error, which is the worst way to lose a number in a
// ledger fourteen people are relying on.
let dirtyItems = new Set();   // item ids touched here (including ones deleted here)
let dirtyStructure = false;   // title, roster, split basis, choice-group selections

function markItem(id) {
  if (id) dirtyItems.add(id);
}
function markStructure() {
  dirtyStructure = true;
}

// Fold this browser's changes into whatever is stored right now, rather than
// replacing it. Two people editing different items no longer overwrite each other;
// two people editing the SAME item still resolve last-write-wins, which is honest
// and rare enough to live with.
function mergeInto(stored) {
  const base = stored && Array.isArray(stored.items)
    ? JSON.parse(JSON.stringify(stored))
    : currentPayload();

  const mine = {};
  for (const it of plan.items) mine[it.id] = it;

  for (const id of dirtyItems) {
    const localItem = mine[id];
    const at = base.items.findIndex(function (x) { return x.id === id; });
    if (!localItem) {
      // Deleted here. Drop it from the stored copy too.
      if (at >= 0) base.items.splice(at, 1);
    } else if (at >= 0) {
      base.items[at] = JSON.parse(JSON.stringify(localItem));
    } else {
      base.items.push(JSON.parse(JSON.stringify(localItem)));
    }
  }

  if (dirtyStructure) {
    base.title = plan.title;
    base.households = plan.households;
    base.splitBasis = plan.splitBasis;
    base.groupSel = plan.groupSel;
    base.groupOff = plan.groupOff;
  }
  base.v = 2;
  return base;
}

async function cloudSave() {
  // Read the current stored copy first so other people's edits survive this write.
  let stored = null;
  try {
    stored = await cloudFetch(planId);
  } catch (e) {
    // Could not read. Writing our whole copy now could silently revert someone;
    // better to fail and say so than to destroy a change we cannot see.
    throw new Error("could not read the current plan before saving");
  }

  const merged = mergeInto(stored);

  const res = await fetch(SUPABASE.url + "/rpc/save_plan", {
    method: "POST",
    headers: {
      "apikey": SUPABASE.anon,
      "Authorization": "Bearer " + SUPABASE.anon,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pid: planId, payload: merged }),
  });
  if (!res.ok) throw new Error("save failed: " + res.status);

  // Adopt the merged result so this page now shows everyone else's changes too.
  const hadOthers = stored && JSON.stringify(stored) !== JSON.stringify(merged);
  plan = merged;
  dirtyItems = new Set();
  dirtyStructure = false;
  return hadOthers;
}

function saveSoon(itemId) {
  if (!canEdit()) return;
  if (itemId) markItem(itemId); else markStructure();
  setSaveState("Saving…", "pending");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async function () {
    try {
      await cloudSave();
      setSaveState("Saved for everyone", "ok");
      render();
    } catch (e) {
      setSaveState("NOT SAVED — " + e.message + ". Your change is still on screen; try again.", "bad");
    }
  }, 700);
}

function setSaveState(text, cls) {
  saveMsg = text;
  saveCls = cls || "";
  paintSaveState();
}

// Every edit re-renders the page, which throws the indicator away. Repaint it from
// the remembered state so a failed save does not silently vanish.
function paintSaveState() {
  const el = $("#saveState");
  if (!el) return;
  el.textContent = saveMsg;
  el.className = "v-save " + saveCls;
}

// Coalesce rapid edits into one write. A failed save has to be loud: otherwise the
// person makes a change, walks away, and assumes the group can see it.

// Drop an item and repair any viewer selections that pointed at it.
function deleteItem(item) {
  plan.items = plan.items.filter(function (x) { return x.id !== item.id; });
  for (const name of Object.keys(vSel)) {
    if (vSel[name] === item.id) {
      const left = groupMembers(name);
      vSel[name] = left.length ? left[0].id : "";
    }
  }
  saveSoon(item.id);
  render();
}

// Add or remove one household from an expense. An empty list means everyone, so the
// last household cannot be unchecked — that would read as "nobody" but compute as
// "everyone", the kind of silent inversion that makes a ledger lie.
function toggleShare(item, hid) {
  const all = Booking.households(plan).map(function (h) { return h.id; });
  let cur = Array.isArray(item.shares) && item.shares.length ? item.shares.slice() : all.slice();
  if (cur.includes(hid)) {
    if (cur.length === 1) {
      setSaveState("At least one family has to be on an expense — remove the item instead", "bad");
      return;
    }
    cur = cur.filter(function (x) { return x !== hid; });
  } else {
    cur = cur.concat([hid]);
  }
  item.shares = cur.length === all.length ? [] : cur;
  saveSoon(item.id);
  render();
}

function addItem(fields) {
  const item = {
    id: newItemId(),
    type: fields.type || "other",
    category: fields.category || "",
    title: fields.title,
    cost: fields.cost,
    priceMode: fields.priceMode || "total",
    date: fields.date || "",
    endDate: fields.endDate || "",
    people: 0,
    group: "",
    optional: false,
    included: true,
    actual: null,
    status: "est",
    conf: "",
    vendor: "",
    payer: "",
    notes: "",
    url: "",
    shares: Array.isArray(fields.shares) ? fields.shares : [],
  };
  plan.items.push(item);
  saveSoon(item.id);
  render();
}

// A two-step button instead of confirm(): a native dialog blocks the page, and on a
// phone it is the easiest thing in the world to tap through without reading.
function buildRemoveButton(item) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "v-del";
  btn.textContent = "Remove";
  btn.title = "Remove this from the shared plan";
  let armed = false;
  btn.addEventListener("click", function () {
    if (!armed) {
      armed = true;
      btn.textContent = "Remove for everyone?";
      btn.classList.add("armed");
      setTimeout(function () {
        if (!armed) return;
        armed = false;
        btn.textContent = "Remove";
        btn.classList.remove("armed");
      }, 8000);
      return;
    }
    deleteItem(item);
  });
  return btn;
}

// The families splitting one expense, as toggles. Clicking one changes the shared
// plan for all four families, not just this viewer's arithmetic.
function buildShareToggles(item) {
  const houses = Booking.households(plan);
  if (houses.length < 2) return null;
  const split = Booking.splitItem(plan, item);
  const inOn = new Set(Booking.sharersFor(plan, item).map(function (h) { return h.id; }));
  // For a per-person price the family name alone is ambiguous — two of the four is a
  // different bill from all four, so the chip carries the count.
  const counts = Booking.priceMode(item) === "person" ? Booking.headCounts(plan, item) : null;

  const d = document.createElement("div");
  d.className = "v-split v-split-edit";
  for (const h of houses) {
    const on = inOn.has(h.id);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "v-shrtog" + (on ? " on" : "");
    chip.title = on
      ? h.name + " is in — click to take them off"
      : h.name + " is out — click to add them";
    chip.innerHTML =
      '<span class="mark">' + (on ? "✓" : "✕") + "</span>" +
      '<span class="n">' + escapeHTML(h.name) + "</span>" +
      (on && counts ? '<span class="cnt">×' + (counts[h.id] || 0) + "</span>" : "") +
      (on ? '<span class="amt">' + fmtUSD(Math.round(split[h.id] || 0)) + "</span>" : "");
    chip.addEventListener("click", function () { toggleShare(item, h.id); });
    d.appendChild(chip);
  }
  return d;
}

const ADD_TYPES = ["flight", "stay", "car", "reservation", "ticket", "other"];

function buildAddForm() {
  const wrap = document.createElement("details");
  wrap.className = "v-addwrap";
  const sum = document.createElement("summary");
  sum.textContent = "+ Add something to the trip";
  wrap.appendChild(sum);

  // Default to "Other": most things a family adds on the fly are incidentals, and a
  // wrong Kind silently changes the icon and sort order of their entry.
  const typeOpts = ADD_TYPES.map(function (t) {
    const sel = t === "other" ? " selected" : "";
    return '<option value="' + t + '"' + sel + ">" + (TYPES[t] || TYPES.other).label + "</option>";
  }).join("");
  const modeOpts = Booking.PRICE_ORDER.map(function (k) {
    return '<option value="' + k + '">' + Booking.PRICE_MODES[k].label + "</option>";
  }).join("");

  const form = document.createElement("form");
  form.className = "v-addform";
  form.innerHTML =
    '<label>What is it?<input name="title" type="text" placeholder="Golf cart rental" required></label>' +
    '<label>Kind<select name="type">' + typeOpts + "</select></label>" +
    '<label>Category<input name="category" type="text" list="catlist" placeholder="Pick one or type a new one"></label>' +
    '<label>Cost<input name="cost" type="number" min="0" step="0.01" placeholder="0.00" required></label>' +
    '<label>That price is<select name="priceMode">' + modeOpts + "</select></label>" +
    '<label>Starts<input name="date" type="date"></label>' +
    '<label>Ends <span class="opt">optional</span><input name="endDate" type="date"></label>' +
    '<div class="v-addfams"><span class="lbl">Who is in?</span><div class="fams"></div></div>' +
    '<div class="v-addhint"></div>' +
    '<div class="v-addactions"><button type="submit">Add for everyone</button>' +
    '<span class="v-addnote">Adds it to the shared plan all four families see.</span></div>';

  // Participation defaults to the whole group; unticking here writes a share list.
  const fams = form.querySelector(".fams");
  const houses = Booking.households(plan);
  for (const h of houses) {
    const lab = document.createElement("label");
    lab.className = "fam";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.value = h.id;
    lab.append(cb, document.createTextNode(h.name));
    fams.appendChild(lab);
  }

  const modeSel = form.querySelector('select[name="priceMode"]');
  const hint = form.querySelector(".v-addhint");
  hint.textContent = Booking.PRICE_MODES.total.hint;
  modeSel.addEventListener("change", function () {
    hint.textContent = Booking.PRICE_MODES[modeSel.value].hint;
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const title = form.title.value.trim();
    const cost = parseFloat(form.cost.value);
    if (!title || !isFinite(cost)) return;
    const picked = [].slice.call(fams.querySelectorAll("input:checked")).map(function (c) { return c.value; });
    const all = houses.map(function (h) { return h.id; });
    if (picked.length === 0) {
      setSaveState("Pick at least one family for this expense", "bad");
      return;
    }
    addItem({
      title: title,
      cost: cost,
      type: form.type.value,
      category: normalizeCategory(form.category.value),
      priceMode: form.priceMode.value,
      date: form.date.value,
      endDate: form.endDate.value,
      // An empty list already means everyone, so only store a subset.
      shares: picked.length < all.length ? picked : [],
    });
  });

  wrap.appendChild(form);
  return wrap;
}

// The same per-household split, but static — used for legacy hash links, which have
// no cloud id to write a change back to.
function buildShareReadout(item) {
  const houses = Booking.households(plan);
  if (houses.length < 2) return null;
  const split = Booking.splitItem(plan, item);
  const parts = houses
    .filter(function (h) { return split[h.id] >= 0.5; })
    .map(function (h) {
      return '<span class="v-shr"><span class="n">' + escapeHTML(h.name) + "</span> " +
        fmtUSD(Math.round(split[h.id])) + "</span>";
    });
  if (!parts.length) return null;
  const d = document.createElement("div");
  d.className = "v-split";
  d.innerHTML = parts.join("");
  return d;
}

// --- Per-item editing -----------------------------------------------------
// Everything about one booking, editable in place. The group view is where the
// families actually live, so it has to hold the whole record — not just the parts
// that were cheap to expose.

// Which row is open. Module-level because every edit re-renders the page, and the
// panel has to still be there afterwards.
let editingId = "";

// Fields commit on change (blur), never on keystroke: a re-render mid-typing would
// take the keyboard away, which on a phone means losing the entry.
function commitEdit(fn) {
  return function () {
    fn();
    // Panel edits always act on the row that is open.
    saveSoon(editingId);
    render();
  };
}

function edField(labelText, el, hint) {
  const lab = document.createElement("label");
  lab.className = "ed-field";
  const span = document.createElement("span");
  span.className = "ed-lab";
  span.textContent = labelText;
  lab.append(span, el);
  if (hint) {
    const h = document.createElement("span");
    h.className = "ed-hint";
    h.textContent = hint;
    lab.appendChild(h);
  }
  return lab;
}

function edInput(type, value, placeholder) {
  const el = document.createElement("input");
  el.type = type;
  el.value = value == null ? "" : value;
  if (placeholder) el.placeholder = placeholder;
  if (type === "number") { el.min = "0"; el.step = "0.01"; }
  return el;
}

function edSelect(options, selected) {
  const el = document.createElement("select");
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    opt.selected = o.value === selected;
    el.appendChild(opt);
  }
  return el;
}

function buildEditPanel(item) {
  const p = document.createElement("div");
  p.className = "ed-panel";

  // --- What it is -------------------------------------------------------
  const title = edInput("text", item.title);
  title.addEventListener("change", commitEdit(function () {
    const v = title.value.trim();
    if (v) item.title = v;   // an empty title would render an unclickable blank row
  }));

  const cat = categoryInput(item.category);
  cat.addEventListener("change", commitEdit(function () {
    item.category = normalizeCategory(cat.value);
  }));

  const kind = edSelect(ADD_TYPES.map(function (t) {
    return { value: t, label: (TYPES[t] || TYPES.other).label };
  }), item.type);
  kind.addEventListener("change", commitEdit(function () { item.type = kind.value; }));

  // --- When, which is also where it appears in the list ------------------
  const start = edInput("date", item.date);
  start.addEventListener("change", commitEdit(function () { item.date = start.value; }));
  const end = edInput("date", item.endDate);
  end.addEventListener("change", commitEdit(function () { item.endDate = end.value; }));

  // --- Money ------------------------------------------------------------
  const est = edInput("number", item.cost, "0.00");
  est.addEventListener("change", commitEdit(function () {
    item.cost = Math.max(0, parseFloat(est.value) || 0);
  }));

  const actual = edInput("number", Booking.hasActual(item) ? item.actual : "", "not charged yet");
  actual.addEventListener("change", commitEdit(function () {
    const raw = actual.value.trim();
    item.actual = raw === "" ? null : Math.max(0, parseFloat(raw) || 0);
    // A real charge means it is no longer a guess. Nudge the status rather than
    // leaving a line that reads "Estimate" next to money that has actually moved.
    if (item.actual !== null && Booking.statusOf(item) === "est") item.status = "booked";
  }));

  const mode = edSelect(Booking.PRICE_ORDER.map(function (k) {
    return { value: k, label: Booking.PRICE_MODES[k].label };
  }), Booking.priceMode(item));
  mode.addEventListener("change", commitEdit(function () { item.priceMode = mode.value; }));

  // --- Where it stands ---------------------------------------------------
  const status = edSelect(Booking.STATUS_ORDER.map(function (k) {
    return { value: k, label: Booking.STATUS[k].label };
  }), Booking.statusOf(item));
  status.addEventListener("change", commitEdit(function () { item.status = status.value; }));

  const payerOpts = [{ value: "", label: "Nobody yet — still owed to the vendor" }];
  for (const h of Booking.households(plan)) payerOpts.push({ value: h.id, label: h.name });
  const payer = edSelect(payerOpts, item.payer || "");
  payer.addEventListener("change", commitEdit(function () { item.payer = payer.value; }));

  // --- Reference ---------------------------------------------------------
  const conf = edInput("text", item.conf, "e.g. ABC123");
  conf.addEventListener("change", commitEdit(function () { item.conf = conf.value.trim(); }));

  const vendor = edInput("text", item.vendor, "e.g. JetBlue, Airbnb");
  vendor.addEventListener("change", commitEdit(function () { item.vendor = vendor.value.trim(); }));

  const notes = document.createElement("textarea");
  notes.rows = 3;
  notes.value = item.notes || "";
  notes.placeholder = "Address, door code, why you picked it…";
  notes.addEventListener("change", commitEdit(function () { item.notes = notes.value.trim(); }));

  const grid = document.createElement("div");
  grid.className = "ed-grid";
  grid.append(
    edField("Name", title),
    edField("Kind", kind),
    edField("Category", cat, "Pick one already in use, or type a new one."),
    edField("Starts", start, "The date sets where this sits in the list"),
    edField("Ends", end, "Leave blank for a single day"),
    edField("Estimate", est, "What you expected it to cost"),
    edField("Actually charged", actual, "Leave blank until the money moves"),
    edField("That price is", mode, Booking.PRICE_MODES[Booking.priceMode(item)].hint),
    edField("Status", status),
    edField("Paid by", payer, "Only a paid-by family gets money back at settle-up"),
    edField("Confirmation number", conf),
    edField("Booked with", vendor)
  );

  if (Booking.priceMode(item) === "person") {
    const heads = buildHeadCountRow(item);
    if (heads) {
      const hf = edField("How many people are doing it?", heads,
        "Only the people actually taking part — not everyone in the family.");
      hf.classList.add("ed-wide");
      grid.appendChild(hf);
    }
  }

  const notesField = edField("Notes", notes);
  notesField.classList.add("ed-wide");
  grid.appendChild(notesField);

  p.appendChild(grid);

  const foot = document.createElement("div");
  foot.className = "ed-foot";
  const done = document.createElement("button");
  done.type = "button";
  done.className = "ed-done";
  done.textContent = "Done";
  done.addEventListener("click", function () { editingId = ""; render(); });
  const note = document.createElement("span");
  note.className = "ed-footnote";
  note.textContent = "Changes save as you go, for all four families.";
  foot.append(done, note);
  p.appendChild(foot);

  return p;
}

function buildEditButton(item) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "v-edit" + (editingId === item.id ? " open" : "");
  btn.textContent = editingId === item.id ? "Close" : "Edit";
  btn.addEventListener("click", function () {
    editingId = editingId === item.id ? "" : item.id;
    render();
  });
  return btn;
}

// How many people from each participating family are actually doing this. Only
// meaningful for a per-person price — for a flat total or a per-family rate the
// head count changes nothing, so showing the control would just invite fiddling.
function buildHeadCountRow(item) {
  const sharers = Booking.sharersFor(plan, item);
  if (!sharers.length) return null;
  const counts = Booking.headCounts(plan, item);

  const wrap = document.createElement("div");
  wrap.className = "ed-heads";

  for (const h of sharers) {
    const box = document.createElement("label");
    box.className = "ed-head";

    const name = document.createElement("span");
    name.className = "ed-headname";
    name.textContent = h.name;

    const n = document.createElement("input");
    n.type = "number";
    n.min = "0";
    n.step = "1";
    n.max = String(Booking.headsOf(h));
    n.value = String(counts[h.id]);
    n.addEventListener("change", commitEdit(function () {
      // Freeze every family's current count, then change this one. Writing a lone
      // entry would leave the others implicit, so a later roster change would move
      // their numbers without anyone touching the item.
      const next = {};
      const live = Booking.headCounts(plan, item);
      for (const id in live) next[id] = live[id];
      const v = parseInt(n.value, 10);
      next[h.id] = isFinite(v) && v >= 0 ? v : 0;
      item.heads = next;
    }));

    const cap = document.createElement("span");
    cap.className = "ed-headcap";
    cap.textContent = "of " + Booking.headsOf(h);

    box.append(name, n, cap);
    wrap.appendChild(box);
  }
  return wrap;
}

// --- Categories -----------------------------------------------------------
// Free-form and created on the spot: whatever the group starts typing becomes the
// list everyone else picks from. No fixed taxonomy, because every trip invents its
// own — "Disney days", "boat stuff", "the thing we argue about".

function allCategories() {
  const seen = {};
  for (const it of plan.items) {
    const c = (it.category || "").trim();
    if (c) seen[c.toLowerCase()] = c;
  }
  return Object.keys(seen).sort().map(function (k) { return seen[k]; });
}

// Fourteen people typing freely would otherwise produce "Food", "food" and "FOOD"
// as three separate categories. Match an existing one case-insensitively and adopt
// its spelling; only a genuinely new word starts a new category.
function normalizeCategory(value) {
  const v = (value || "").trim();
  if (!v) return "";
  for (const c of allCategories()) {
    if (c.toLowerCase() === v.toLowerCase()) return c;
  }
  return v;
}

// One list, shared by every category box on the page.
function buildCategoryList() {
  const dl = document.createElement("datalist");
  dl.id = "catlist";
  for (const c of allCategories()) {
    const o = document.createElement("option");
    o.value = c;
    dl.appendChild(o);
  }
  return dl;
}

function categoryInput(value) {
  const el = document.createElement("input");
  el.type = "text";
  el.setAttribute("list", "catlist");
  el.value = value || "";
  el.placeholder = "Pick one or type a new one";
  return el;
}

// What the trip costs broken down by category, over the items actually counting.
function buildCategoryPanel() {
  const items = countedItems();
  if (!items.length) return null;

  const rows = {};
  let anyCategorised = false;
  for (const it of items) {
    const c = (it.category || "").trim();
    if (c) anyCategorised = true;
    const key = c || "\u0000uncategorised";
    rows[key] = (rows[key] || 0) + Booking.effCost(plan, it);
  }
  // Nothing has been categorised yet — an empty breakdown is just noise.
  if (!anyCategorised) return null;

  const keys = Object.keys(rows).sort();
  const panel = document.createElement("div");
  panel.className = "panel";
  let html = '<div class="cat-head">Where the money goes</div><div class="cat-list">';
  for (const k of keys) {
    const label = k === "\u0000uncategorised" ? "Not categorised" : k;
    html += '<div class="cat-row"><span class="cat-name">' + escapeHTML(label) +
      '</span><span class="cat-amt">' + fmtUSD(Math.round(rows[k])) + "</span></div>";
  }
  html += "</div>";
  panel.innerHTML = html;
  return panel;
}

// --- "What if someone chips in" -------------------------------------------
// One household offering to carry more than its share is a normal thing on a family
// trip, and the question is always the same: if we put in X, what does that actually
// do for everyone else?
//
// This is the one control on the page that does NOT write to the shared plan. Working
// out what you can afford is not a decision yet, and nobody should have to broadcast a
// half-formed offer to thirteen other people while they think about it. Nothing here
// is saved, and nothing here is visible to anyone else.

let giftFrom = "";     // household id offering to contribute
let giftAmount = 0;    // how much they are considering

// A contribution takes over part of what everyone else owes. It is spread across the
// other households by the trip's own split basis, so it lands the same way the costs
// did — a family carrying a bigger share of the trip gets a bigger piece of the help.
//
// Nobody can be reduced below zero: money beyond what the others owe between them has
// nothing left to pay off, so it is reported as unused rather than quietly vanishing
// or turning into a negative bill.
function giftPreview(fromId, amount) {
  const base = {};
  for (const r of Booking.ledger(plan, countedItems())) base[r.id] = r.owes;

  const houses = Booking.households(plan);
  const others = houses.filter(function (h) { return h.id !== fromId; });
  const totalWeight = others.reduce(function (n, h) { return n + Booking.weightOf(plan, h); }, 0);

  const rows = [];
  let used = 0;
  for (const h of others) {
    const owed = base[h.id] || 0;
    const portion = totalWeight > 0
      ? amount * (Booking.weightOf(plan, h) / totalWeight)
      : amount / (others.length || 1);
    const cut = Math.min(portion, owed);
    used += cut;
    rows.push({ name: h.name, before: owed, after: owed - cut, change: -cut });
  }

  const giverOwed = base[fromId] || 0;
  rows.unshift({
    name: Booking.householdName(plan, fromId),
    before: giverOwed,
    after: giverOwed + used,
    change: used,
    giver: true,
  });

  return { rows: rows, used: used, requested: amount, unused: Math.max(0, amount - used) };
}

function renderGiftTable(box) {
  if (!giftFrom) {
    box.innerHTML = '<div class="gift-empty">Pick who is chipping in.</div>';
    return;
  }
  const p = giftPreview(giftFrom, Math.max(0, giftAmount || 0));

  let html = '<table class="gift-table"><thead><tr><th>Family</th><th class="n">Now</th>' +
    '<th class="n">After</th></tr></thead><tbody>';
  for (const r of p.rows) {
    const cls = r.giver ? "giver" : "";
    const delta = Math.abs(r.change) >= 1
      ? '<span class="gift-delta ' + (r.change > 0 ? "up" : "down") + '">' +
        (r.change > 0 ? "+" : "−") + fmtUSD(Math.round(Math.abs(r.change))) + "</span>"
      : "";
    html += '<tr class="' + cls + '"><td>' + escapeHTML(r.name) + (r.giver ? ' <span class="gift-tag">chipping in</span>' : "") +
      '</td><td class="n">' + fmtUSD(Math.round(r.before)) + "</td>" +
      '<td class="n">' + fmtUSD(Math.round(r.after)) + delta + "</td></tr>";
  }
  html += "</tbody></table>";

  if (p.unused >= 1) {
    html += '<div class="gift-note warn">' + fmtUSD(Math.round(p.unused)) +
      " of that is more than the other families owe between them, so it has nothing left to pay off.</div>";
  }
  html += '<div class="gift-note">Nothing here is saved or shared — it is a calculator, not a change to the plan.</div>';
  box.innerHTML = html;
}

function buildGiftPanel() {
  const houses = Booking.households(plan);
  if (houses.length < 2) return null;

  const panel = document.createElement("details");
  panel.className = "panel gift-panel";
  if (giftFrom) panel.open = true;

  const sum = document.createElement("summary");
  sum.textContent = "What if one family chips in?";
  panel.appendChild(sum);

  const controls = document.createElement("div");
  controls.className = "gift-controls";

  const whoWrap = document.createElement("label");
  whoWrap.className = "gift-field";
  whoWrap.innerHTML = '<span class="gift-lab">Who is chipping in</span>';
  const who = document.createElement("select");
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "— pick a family —";
  who.appendChild(none);
  for (const h of houses) {
    const o = document.createElement("option");
    o.value = h.id;
    o.textContent = h.name;
    o.selected = giftFrom === h.id;
    who.appendChild(o);
  }
  whoWrap.appendChild(who);

  const amtWrap = document.createElement("label");
  amtWrap.className = "gift-field";
  amtWrap.innerHTML = '<span class="gift-lab">How much</span>';
  const amt = document.createElement("input");
  amt.type = "number";
  amt.min = "0";
  amt.step = "100";
  amt.placeholder = "0";
  amt.value = giftAmount ? String(giftAmount) : "";
  amtWrap.appendChild(amt);

  controls.append(whoWrap, amtWrap);
  panel.appendChild(controls);

  const quick = document.createElement("div");
  quick.className = "gift-quick";
  const box = document.createElement("div");
  box.className = "gift-out";

  // Recompute in place rather than re-rendering the page: a full render on every
  // keystroke would close the keyboard mid-number on a phone.
  function refresh() {
    renderGiftTable(box);
  }
  who.addEventListener("change", function () { giftFrom = who.value; refresh(); });
  amt.addEventListener("input", function () {
    giftAmount = parseFloat(amt.value) || 0;
    refresh();
  });

  for (const v of [1000, 2500, 5000]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "gift-preset";
    b.textContent = fmtUSD(v);
    b.addEventListener("click", function () {
      giftAmount = v;
      amt.value = String(v);
      refresh();
    });
    quick.appendChild(b);
  }
  panel.appendChild(quick);
  panel.appendChild(box);
  refresh();

  return panel;
}
