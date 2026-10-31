// WDW Trip Planner — shared, view-only itinerary for non-planners.
// The whole plan travels in the URL hash (base64url-encoded JSON) so no server is
// needed. Choice groups render as dropdowns; picking "None" drops the group.

const $ = (sel) => document.querySelector(sel);

// Transport lives in backend.js, shared with the editor.
const BACKEND = window.tripBackend;

// Fetch a plan by id. Reads are limited to exact-id lookups — there is no listing
// operation, so the id remains the only way in.
async function cloudFetch(id) {
  return BACKEND.get(id); // the stored plan, or null if the id isn't found
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

// The gift, expressed as a line on the bill.
//
// It is NOT a payment. A payment moves money between two families and changes who
// owes whom; it never changes what the holiday costs. A gift is money arriving from
// outside the shared pot, so the trip genuinely costs less and every family's share
// of it falls. Modelling it as a negative "total" item means the existing split
// rules do the work: a total is apportioned by the trip's share basis, so the credit
// comes off each household in the same proportion their share went on.
//
// Built on the fly and never stored in plan.items, so it cannot be edited, deleted
// or dragged about like a booking — the gift form is the only way to change it.
//
// payer is left empty deliberately. Setting a payer would add the negative to that
// household's "paid" column and push it through the settle-up, which is exactly the
// "treat it as a payment" behaviour this is meant to avoid. No money has moved
// between families, so nobody's transfer changes.
function giftCreditItem() {
  const g = planGift();
  if (!g) return null;
  const who = giverName(g);
  return {
    id: "__gift_credit",
    title: who ? "Gift from the " + who : "Gift toward the trip",
    cost: -Math.abs(Number(g.amount)),
    actual: null,
    priceMode: "total",
    shares: [],
    included: true,
    status: "credit",
    payer: "",
    conf: "", vendor: "", notes: g.message || "", url: "",
    date: "", endDate: "", group: "", optional: false,
    isCredit: true,
  };
}
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
  const credit = giftCreditItem();
  if (credit) total += Booking.effCost(plan, credit);   // negative, so it comes off
  return total;
}

// What the trip costs before the gift is taken off — needed so the Trip tab can show
// the credit doing something rather than just quoting a smaller number.
function computeTotalBeforeGift() {
  const credit = giftCreditItem();
  return computeTotal() - (credit ? Booking.effCost(plan, credit) : 0);
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

// Which rows are expanded. A trip this size is a wall of text if every booking shows
// its confirmation code, notes and four family chips at once, so a row opens to the
// detail only when someone asks for it. Module-level, because every edit re-renders.
let openRows = new Set();

function isRowOpen(item) {
  // A row being edited is always open — collapsing the panel out from under someone
  // mid-edit would look like the page had thrown their work away.
  return openRows.has(item.id) || editingId === item.id;
}

function toggleRow(id) {
  if (openRows.has(id)) openRows.delete(id);
  else openRows.add(id);
  render();
}

function buildItemRow(item) {
  const meta = TYPES[item.type] || TYPES.other;
  const included = isIncluded(item);
  const open = isRowOpen(item);
  const row = document.createElement("div");
  row.className = "v-row" + (included ? "" : " excluded") + (open ? " open" : " closed");

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
  if (!included) sub.push("not doing this");

  // Status rides in the header rather than the detail: whether money has actually
  // moved is the one thing worth seeing on every row without opening it.
  const st = Booking.STATUS[Booking.statusOf(item)];

  const head = document.createElement("button");
  head.type = "button";
  head.className = "v-rowhead";
  head.setAttribute("aria-expanded", open ? "true" : "false");
  head.innerHTML =
    `<span class="v-title"><span class="v-icon">${meta.icon}</span>${escapeHTML(item.title)}` +
    `<span class="v-badge ${st.cls}">${st.label}</span></span>` +
    `<span class="v-sub">${sub.join(" · ")}<span class="v-chev">${open ? "▾" : "▸"}</span></span>`;
  head.addEventListener("click", function () { toggleRow(item.id); });
  main.appendChild(head);

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

  if (open) {
    main.appendChild(buildItemDetail(item));

    if (canEdit()) {
      const tools = document.createElement("div");
      tools.className = "v-tools";
      tools.appendChild(buildEditButton(item));
      tools.appendChild(buildRemoveButton(item));
      main.appendChild(tools);
      if (editingId === item.id) main.appendChild(buildEditPanel(item));
    }
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
  // The gift is deliberately NOT added here. It used to be, which spread it across
  // every household by the trip's share basis — including the givers, who then part
  // funded their own present. It is now applied by giftAllocation() after the raw
  // shares are known, because the rule is not a split: it clears the giver's share
  // first and spreads what is left evenly across the rest.
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

  // The same subtraction the group table shows, for the one household reading it.
  // Seeing "your share" without the gift in it, while the table below shows it
  // applied, is the sort of small inconsistency that makes people distrust the lot.
  const myBase = {};
  rows.forEach(function (r) { myBase[r.id] = r.owes; });
  const myAlloc = giftAllocation(myBase);
  const myCredit = myAlloc.credit[me] || 0;
  const myAfter = Math.max(0, mine.owes - myCredit);
  const giftHere = planGift();

  const body = document.createElement("div");
  body.className = "you-body";
  body.innerHTML =
    `<div class="you-big ${net < 0 ? "neg" : net > 0 ? "pos" : ""}">${netText}</div>` +
    // The headline is about money other families have already laid out; the rows
    // below are about the share of the trip. With a gift in play those two numbers
    // pull apart hard, and the headline is the loudest thing on the panel.
    (giftHere && myCredit >= 0.5 && Math.abs(net) >= 1
      ? `<div class="you-sub">That is what other families have already laid out for you — ` +
        `the gift below has not been handed over yet, so it has not reached this figure.</div>`
      : "") +
    `<div class="total-row"><span class="label">Your share of the trip</span><span class="val">${fmtUSD(Math.round(mine.owes))}</span></div>` +
    (giftHere && myCredit >= 0.5
      ? `<div class="total-row gift-line"><span class="label">${escapeHTML(giftHere.from === me ? "Your gift, against your own share" : "Gift from the " + (giverName(giftHere) || "family"))}</span>` +
        `<span class="val">−${fmtUSD(Math.round(myCredit))}</span></div>` +
        `<div class="total-row after-line"><span class="label">Your share after the gift</span>` +
        `<span class="val">${fmtUSD(Math.round(myAfter))}</span></div>`
      : "") +
    `<div class="total-row"><span class="label">You've already paid</span><span class="val">${fmtUSD(Math.round(mine.paid))}</span></div>`;
  if (mine.sent >= 1 || mine.received >= 1) {
    let extra = "";
    if (mine.sent >= 1) extra += `<div class="total-row"><span class="label">You've paid other families</span><span class="val">${fmtUSD(Math.round(mine.sent))}</span></div>`;
    if (mine.received >= 1) extra += `<div class="total-row"><span class="label">Other families have paid you</span><span class="val">${fmtUSD(Math.round(mine.received))}</span></div>`;
    body.innerHTML += extra;
  }
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
    // The breakdown has to end where the summary above ends, or it stops being a
    // breakdown of anything.
    if (giftHere && myCredit >= 0.5) {
      html += `<tr class="gift-line"><td>${escapeHTML(giftHere.from === me ? "Your gift, against your own share" : "Gift from the " + (giverName(giftHere) || "family"))}</td>` +
        `<td class="amt">−${fmtUSD(Math.round(myCredit))}</td></tr>`;
      html += `<tr class="after-line"><td>Your share after the gift</td>` +
        `<td class="amt">${fmtUSD(Math.round(myAfter))}</td></tr>`;
    }
    html += "</tbody></table>";
    const det = document.createElement("details");
    det.className = "you-detail";
    det.innerHTML = "<summary>How your share breaks down</summary>" + html;
    panel.appendChild(det);
  }

  if (isContributor(me)) {
    const gift = buildGiftSection(me);
    if (gift) panel.appendChild(gift);
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
  // The gift gets columns of its own rather than being folded silently into the
  // share. Three figures that visibly subtract are worth more than one number nobody
  // can derive.
  const baseOwes = {};
  rows.forEach(function (r) { baseOwes[r.id] = r.owes; });
  const alloc = giftAllocation(baseOwes);
  const giftOn = !!planGift();

  let html = '<div class="you-head">Everyone\u2019s share</div>';
  html += '<div class="ledger-scroll"><table class="v-ledger' + (giftOn ? " has-gift" : "") + '"><thead><tr>' +
    "<th>Household</th><th>Share of trip</th>" +
    (giftOn ? "<th>Gift</th><th>After gift</th>" : "") +
    "<th>Paid so far</th><th>Owes the group</th></tr></thead><tbody>";

  for (const r of rows) {
    const net = Math.round(r.net);
    const cls = net > 0 ? "pos" : net < 0 ? "neg" : "";
    const netText = net === 0 ? "even" : net > 0 ? `owed ${fmtUSD(net)}` : `owes ${fmtUSD(-net)}`;
    const credited = alloc.credit[r.id] || 0;
    const after = Math.max(0, r.owes - credited);

    html += `<tr${r.id === me ? ' class="is-me"' : ""}><td>${escapeHTML(r.name)}</td>` +
      `<td>${fmtUSD(Math.round(r.owes))}</td>` +
      (giftOn
        ? `<td class="gift-col">${credited > 0.5 ? "\u2212" + fmtUSD(Math.round(credited)) : "\u2014"}</td>` +
          `<td class="after-col">${fmtUSD(Math.round(after))}</td>`
        : "") +
      `<td>${fmtUSD(Math.round(r.paid))}</td>` +
      `<td class="net ${cls}">${netText}</td></tr>`;
  }
  html += "</tbody></table></div>";

  if (giftOn) {
    const giver = giverName(planGift());
    html += '<div class="you-note">The gift covers the ' + escapeHTML(giver || "giving household") +
      "\u2019s own share first, and what is left is divided evenly between the other " +
      (rows.length - 1) + " families." +
      (alloc.unused > 0.5
        ? " <strong>" + fmtUSD(Math.round(alloc.unused)) +
          "</strong> of it is more than the trip costs, so it is not applied to anyone."
        : "") +
      "</div>";
  }

  const transfers = Booking.settle(rows);
  if (transfers.length) {
    html += '<div class="you-head" style="margin-top:14px;">Settling up</div><ul class="settle">';
    for (const t of transfers) {
      const mineFlag = t.fromId === me || t.toId === me;
      html += `<li${mineFlag ? ' class="is-me"' : ""}><strong>${escapeHTML(t.from)}</strong> pays <strong>${escapeHTML(t.to)}</strong> <span class="amt">${fmtUSD(Math.round(t.amount))}</span></li>`;
    }
    html += "</ul>";
  }
  // Without this, the two halves of the panel look like they contradict each other:
  // a family's share of the trip has dropped because of the gift, while the transfer
  // below has not moved an inch. Both are right, for different reasons, and the only
  // way to know that is to be told.
  // The settling-up is the one place the gift deliberately does NOT reach, and that
  // needs saying: "After gift" above and "owes the group" below are different
  // questions, and without this they read as a contradiction.
  const giftNow = planGift();
  if (giftNow) {
    html += '<div class="you-note">Settling up is separate from the gift. It only ' +
      "moves money people have actually laid out for each other, and no gift money " +
      "has changed hands yet — so these transfers are unchanged. When it does " +
      "change hands, record it as a payment and they will drop.</div>";
  }

  if (owedToVendors >= 1) {
    html += `<div class="you-note"><strong>${fmtUSD(Math.round(owedToVendors))}</strong> of the trip hasn\u2019t been paid by anyone yet, so it isn\u2019t in the settling-up above \u2014 that money is still owed to airlines, hosts and parks.</div>`;
  }
  panel.innerHTML = html;

  const pays = buildPaymentsSection();
  if (pays) panel.appendChild(pays);
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

  // Invisible, and needed by the category inputs on more than one tab, so it is not
  // part of any tab's content.
  root.appendChild(buildCategoryList());

  root.appendChild(buildTabBar());

  if (canEdit()) {
    const save = document.createElement("div");
    save.id = "saveState";
    save.className = "v-save";
    root.appendChild(save);
  }
  paintSaveState();

  const tab = getTab();

  if (tab === "trip") {
    const listPanel = document.createElement("div");
    listPanel.className = "panel";
    if (plan.items.length === 0) {
      listPanel.innerHTML = '<div class="empty">This itinerary is empty.</div>';
    } else {
      const bar = buildExpandBar();
      if (bar) listPanel.appendChild(bar);
      listPanel.appendChild(buildTimeline());
    }
    // The credit sits under the bookings rather than among them: it is not something
    // the group booked, it is something taken off the bottom of what they booked.
    const creditRow = buildCreditRow();
    if (creditRow) listPanel.appendChild(creditRow);

    if (canEdit()) listPanel.appendChild(buildAddForm());
    root.appendChild(listPanel);

    const totalPanel = document.createElement("div");
    totalPanel.className = "panel total-panel";
    let note = "";
    if (totalGroups > 0) note = `${chosenGroups} of ${totalGroups} choice group${totalGroups === 1 ? "" : "s"} selected`;

    const credit = giftCreditItem();
    let totalHtml = "";
    if (credit) {
      // Showing only the smaller number would hide the gift doing its work. The
      // subtraction is the point.
      const before = computeTotalBeforeGift();
      totalHtml =
        `<div class="total-row sub"><span class="label">Bookings and plans</span>` +
        `<span class="val">${fmtUSD(before)}</span></div>` +
        `<div class="total-row sub credit"><span class="label">${escapeHTML(credit.title)}</span>` +
        `<span class="val">−${fmtUSD(Math.abs(credit.cost))}</span></div>`;
    }
    totalPanel.innerHTML =
      totalHtml +
      `<div class="total-row grand"><span class="label">Estimated trip total</span>` +
      `<span class="val">${fmtUSD(total)}</span></div>` +
      (note ? `<div class="total-note">${note}</div>` : "");
    root.appendChild(totalPanel);

    const refs = buildConfirmationPanel();
    if (refs) root.appendChild(refs);

  } else if (tab === "schedule") {
    const sched = buildSchedulePanel();
    if (sched) root.appendChild(sched);

  } else {
    const giftPanel = buildGiftPanel();
    if (giftPanel) root.appendChild(giftPanel);

    const you = buildYouPanel();
    if (you) root.appendChild(you);
    const ledger = buildLedgerPanel();
    if (ledger) root.appendChild(ledger);
    const cats = buildCategoryPanel();
    if (cats) root.appendChild(cats);
  }
}

// --- Tabs -------------------------------------------------------------------
//
// Everything used to be one column: itinerary, total, schedule, confirmation
// numbers, every family's share, the settle-up and the category breakdown, in that
// order. On a phone that is a very long scroll to answer "what do I owe", and the
// deadlines were buried in the middle of it.
//
// Three tabs, because there are three questions the group actually asks: what are we
// doing, what still has to be done, and who owes what.

const TABS = [
  { v: "trip", label: "Trip" },
  { v: "schedule", label: "Schedule" },
  { v: "money", label: "Money" },
];

let activeTab = "";

// Remembered per plan and per device. This is a viewer's own convenience, not part of
// the shared document — which tab you had open is nobody else's business, and writing
// it to the plan would broadcast it to thirteen other people.
function tabKey() { return "tt-tab-" + (planId || "hash"); }

function getTab() {
  if (activeTab) return activeTab;

  // ?tab=schedule makes a tab linkable, so "look at the schedule" can be a link.
  // The URL hash is NOT used: a legacy share link carries the whole plan there.
  const asked = new URLSearchParams(location.search).get("tab");
  if (asked && TABS.some(function (t) { return t.v === asked; })) return (activeTab = asked);

  try {
    const saved = localStorage.getItem(tabKey());
    if (saved && TABS.some(function (t) { return t.v === saved; })) return (activeTab = saved);
  } catch (e) { /* private mode — fall through to the default */ }

  return (activeTab = "trip");
}

function setTab(v) {
  if (activeTab === v) return;
  activeTab = v;
  try { localStorage.setItem(tabKey(), v); } catch (e) {}
  render();
  // Land at the top. Switching tabs halfway down the old one and staying at that
  // scroll position looks like the page failed to change.
  window.scrollTo(0, 0);
}

// The one count worth showing without opening the tab: something is late, or due
// shortly. A badge that just repeats "9 tasks" earns nothing.
function scheduleBadge() {
  if (!Array.isArray(plan.tasks) || !plan.tasks.length) return null;
  let over = 0, asap = 0, soon = 0;
  plan.tasks.forEach(function (t) {
    const u = taskUrgency(t);
    if (u === "overdue") over++;
    else if (u === "asap") asap++;
    else if (u === "soon") soon++;
  });
  if (over) return { text: String(over), cls: "over", title: over + " overdue" };
  if (asap) return { text: String(asap), cls: "asap", title: asap + " to do as soon as possible" };
  if (soon) return { text: String(soon), cls: "soon", title: soon + " due soon" };
  return null;
}

function buildTabBar() {
  const nav = document.createElement("div");
  nav.className = "tabs";
  nav.setAttribute("role", "tablist");

  const current = getTab();
  TABS.forEach(function (t) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tab" + (t.v === current ? " on" : "");
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", t.v === current ? "true" : "false");
    b.textContent = t.label;

    if (t.v === "schedule") {
      const badge = scheduleBadge();
      if (badge) {
        const s = document.createElement("span");
        s.className = "tab-badge " + badge.cls;
        s.textContent = badge.text;
        s.title = badge.title;
        b.appendChild(s);
      }
    }

    b.addEventListener("click", function () { setTab(t.v); });
    nav.appendChild(b);
  });

  return nav;
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

// A stable, meaningless id for this browser, so repeat visits from one phone count
// as one visitor rather than twenty. It identifies a device, not a person — the name
// attached to it, if any, is whichever household that device claimed on the Money
// tab, which the viewer chose themselves.
function deviceId() {
  try {
    let id = localStorage.getItem("tt-device");
    if (!id) {
      id = "d" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
      localStorage.setItem("tt-device", id);
    }
    return id;
  } catch (e) {
    return ""; // private mode: the backend refuses a blank id, which is fine
  }
}

// Fire-and-forget, once per page load. Never awaited and never allowed to throw:
// the trip renders whether or not this works.
let visitNoted = false;
function noteVisit() {
  if (visitNoted || !planId || !BACKEND.configured()) return;
  visitNoted = true;
  const id = deviceId();
  if (!id) return;
  try {
    BACKEND.visit(planId, id, getMe());
  } catch (e) { /* nothing here is worth interrupting a page load for */ }
}

function startPlan() {
  if (!plan || !Array.isArray(plan.items)) { renderEmpty(); return; }
  if (!Array.isArray(plan.tasks)) plan.tasks = [];
  noteVisit();
  // Every time anyone opens the site, by request — not once per device. It is still
  // dismissable on the first click, so it costs a tap rather than a wait.
  setTimeout(function () { playGiftReveal(true); }, 350);
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
    payments: plan.payments,
    tasks: plan.tasks,
    gift: plan.gift,
  };
}

// Which parts of the plan this browser has changed since its last successful save.
// A save writes the whole document, so without this a page that loaded ten minutes
// ago would push its stale copy over everything anyone else has done since — the
// change disappears with no error, which is the worst way to lose a number in a
// ledger fourteen people are relying on.
let dirtyItems = new Set();   // item ids touched here (including ones deleted here)
let dirtyPayments = new Set();  // payment ids touched here (including ones deleted here)
let dirtyTasks = new Set();     // schedule task ids touched here (including ones deleted here)
let dirtyGift = false;          // the contribution card: submitted, edited or withdrawn here
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

  const basePayments = Array.isArray(base.payments) ? base.payments : (base.payments = []);
  const minePayments = {};
  for (const p of planPayments()) minePayments[p.id] = p;
  for (const id of dirtyPayments) {
    const local = minePayments[id];
    const at = basePayments.findIndex(function (x) { return x.id === id; });
    if (!local) {
      if (at >= 0) basePayments.splice(at, 1);
    } else if (at >= 0) {
      basePayments[at] = JSON.parse(JSON.stringify(local));
    } else {
      basePayments.push(JSON.parse(JSON.stringify(local)));
    }
  }

  const baseTasks = Array.isArray(base.tasks) ? base.tasks : (base.tasks = []);
  const myTasks = {};
  for (const t of planTasks()) myTasks[t.id] = t;
  for (const id of dirtyTasks) {
    const local = myTasks[id];
    const at = baseTasks.findIndex(function (x) { return x.id === id; });
    if (!local) {
      if (at >= 0) baseTasks.splice(at, 1);
    } else if (at >= 0) {
      baseTasks[at] = JSON.parse(JSON.stringify(local));
    } else {
      baseTasks.push(JSON.parse(JSON.stringify(local)));
    }
  }

  // Whole-value, not per-record: there is one gift. Withdrawing it has to survive the
  // merge as deliberately as submitting it, so a null is written rather than skipped.
  if (dirtyGift) base.gift = plan.gift ? JSON.parse(JSON.stringify(plan.gift)) : null;

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

  // A null here means "no plan under that id". For a plan we are LOOKING AT, that is
  // not a fact about the world — it is a symptom. The backend answers null for a read
  // that lands while another phone's save is mid-rewrite, and mergeInto treats a null
  // base as "nothing stored yet" and falls back to this browser's whole document. The
  // result would be one tab silently restoring its own stale copy over everyone
  // else's work: exactly the bug the per-item merge was written to stop.
  //
  // So: read once more before believing it, and refuse to write if it is still null.
  if (stored === null && plan && Array.isArray(plan.items) && plan.items.length) {
    try {
      stored = await cloudFetch(planId);
    } catch (e) {
      throw new Error("could not read the current plan before saving");
    }
    if (stored === null) {
      throw new Error(
        "the plan could not be read just now, so nothing was written — " +
        "wait a moment and try again"
      );
    }
  }

  const merged = mergeInto(stored);

  await BACKEND.save(planId, merged);

  // Adopt the merged result so this page now shows everyone else's changes too.
  const hadOthers = stored && JSON.stringify(stored) !== JSON.stringify(merged);
  plan = merged;
  dirtyItems = new Set();
  dirtyPayments = new Set();
  dirtyTasks = new Set();
  dirtyGift = false;
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

// --- "What if we chip in" -------------------------------------------------
// Lives inside the viewer's own "Your share" panel, and only for a household marked
// as contributing. It is a private question — what could we afford to take on? — and
// it belongs next to that family's own numbers rather than as a section of the
// itinerary aimed at everybody.
//
// The number entered is the TOTAL that household pays toward the trip, not an extra
// on top of their share. Saying "we'll put in nine thousand" means their bill is nine
// thousand; the contribution is whatever part of that sits above what they owed
// anyway.
//
// Nothing here is saved and nothing is visible to anyone else. Working out what you
// can afford is not a decision yet, and nobody should have to broadcast a half-formed
// offer to thirteen other people while they think about it.

let giftTotal = null;  // what the viewer's household would pay in total; null = unset

// A household is offered this tool only when the group has marked them as chipping
// in. A flag rather than a hard-coded family name: the grandparents are the ones
// funding this trip, but the next trip will be somebody else, and a name buried in
// the code would quietly stop matching the day anyone edits the roster.
function isContributor(hid) {
  const h = Booking.householdById(plan, hid);
  return !!(h && h.contributes);
}

function baseOwed() {
  const base = {};
  for (const r of Booking.ledger(plan, countedItems())) base[r.id] = r.owes;
  return base;
}

// The contribution is spread across the other households by the trip's own split
// basis, so help lands the way the costs did.
//
// Nobody is reduced below zero: money beyond what the others owe between them has
// nothing left to pay off, so it is reported as unused. The reverse is modelled too —
// paying in less than your own share does not make the money disappear, the others
// have to cover it, and the table says so.
function giftPreview(fromId, totalPaid) {
  const base = baseOwed();
  const baseline = base[fromId] || 0;
  const contribution = totalPaid - baseline;

  const others = Booking.households(plan).filter(function (h) { return h.id !== fromId; });
  const totalWeight = others.reduce(function (n, h) { return n + Booking.weightOf(plan, h); }, 0);
  function portionFor(h, amount) {
    return totalWeight > 0
      ? amount * (Booking.weightOf(plan, h) / totalWeight)
      : amount / (others.length || 1);
  }

  const rows = [];
  let moved = 0;

  if (contribution >= 0) {
    for (const h of others) {
      const owed = base[h.id] || 0;
      const cut = Math.min(portionFor(h, contribution), owed);
      moved += cut;
      rows.push({ name: h.name, before: owed, after: owed - cut, change: -cut });
    }
  } else {
    for (const h of others) {
      const owed = base[h.id] || 0;
      const add = portionFor(h, -contribution);
      moved -= add;
      rows.push({ name: h.name, before: owed, after: owed + add, change: add });
    }
  }

  rows.unshift({
    name: Booking.householdName(plan, fromId),
    before: baseline,
    after: baseline + moved,
    change: moved,
    giver: true,
  });

  return {
    rows: rows,
    baseline: baseline,
    contribution: contribution,
    unused: contribution > 0 ? Math.max(0, contribution - moved) : 0,
    shortfall: contribution < 0 ? -contribution : 0,
  };
}

function renderGiftTable(box, hid) {
  const baseline = baseOwed()[hid] || 0;
  const total = giftTotal === null ? baseline : Math.max(0, giftTotal);
  const p = giftPreview(hid, total);

  let head;
  if (p.contribution >= 1) {
    head = '<div class="gift-head">Your share is <strong>' + fmtUSD(Math.round(p.baseline)) +
      "</strong>, so paying <strong>" + fmtUSD(Math.round(total)) + "</strong> contributes <strong>" +
      fmtUSD(Math.round(p.contribution)) + "</strong> toward the other families.</div>";
  } else if (p.shortfall >= 1) {
    head = '<div class="gift-head warn">That is <strong>' + fmtUSD(Math.round(p.shortfall)) +
      "</strong> less than your own share, so the other families have to cover the difference.</div>";
  } else {
    head = '<div class="gift-head">That is exactly your own share — nothing changes for anyone else.</div>';
  }

  let html = head + '<table class="gift-table"><thead><tr><th>Family</th><th class="n">Now</th>' +
    '<th class="n">After</th></tr></thead><tbody>';
  for (const r of p.rows) {
    const delta = Math.abs(r.change) >= 1
      ? '<span class="gift-delta ' + (r.change > 0 ? "up" : "down") + '">' +
        (r.change > 0 ? "+" : "−") + fmtUSD(Math.round(Math.abs(r.change))) + "</span>"
      : "";
    html += '<tr class="' + (r.giver ? "giver" : "") + '"><td>' + escapeHTML(r.name) +
      (r.giver ? ' <span class="gift-tag">you</span>' : "") +
      '</td><td class="n">' + fmtUSD(Math.round(r.before)) + "</td>" +
      '<td class="n">' + fmtUSD(Math.round(r.after)) + delta + "</td></tr>";
  }
  html += "</tbody></table>";

  if (p.unused >= 1) {
    html += '<div class="gift-note warn">' + fmtUSD(Math.round(p.unused)) +
      " of that is more than the rest of the trip costs, so it has nothing left to pay off.</div>";
  }
  html += '<div class="gift-note">Nothing here is saved or shared — it is a calculator, not a change to the plan.</div>';
  box.innerHTML = html;
}

// Folded into the viewer's own panel, collapsed until they open it.
function buildGiftSection(hid) {
  if (Booking.households(plan).length < 2) return null;

  const wrap = document.createElement("details");
  wrap.className = "you-gift";
  if (giftTotal !== null) wrap.open = true;

  const sum = document.createElement("summary");
  sum.textContent = "What if you chip in more?";
  wrap.appendChild(sum);

  const baseline = baseOwed()[hid] || 0;
  if (giftTotal === null) giftTotal = Math.round(baseline);

  const field = document.createElement("label");
  field.className = "gift-field";
  field.innerHTML = '<span class="gift-lab">What you pay in total</span>';
  const amt = document.createElement("input");
  amt.type = "number";
  amt.min = "0";
  amt.step = "100";
  amt.value = String(giftTotal);
  field.appendChild(amt);
  wrap.appendChild(field);

  const quick = document.createElement("div");
  quick.className = "gift-quick";
  const box = document.createElement("div");
  box.className = "gift-out";

  // Recompute in place rather than re-rendering the page: a full render on every
  // keystroke would close the keyboard mid-number on a phone.
  function refresh() { renderGiftTable(box, hid); }

  // Steps above their own share, which is how an offer gets described out loud.
  for (const v of [1000, 2500, 5000, 10000]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "gift-preset";
    b.textContent = "+" + fmtUSD(v);
    b.title = "Your share plus " + fmtUSD(v);
    b.addEventListener("click", function () {
      giftTotal = Math.round(baseline + v);
      amt.value = String(giftTotal);
      refresh();
    });
    quick.appendChild(b);
  }
  amt.addEventListener("input", function () {
    giftTotal = amt.value === "" ? null : (parseFloat(amt.value) || 0);
    refresh();
  });

  wrap.append(quick, box);
  refresh();
  return wrap;
}

// One control for the whole list, because opening fourteen rows one at a time to
// scan confirmation numbers is worse than the wall of text it replaced.
function buildExpandBar() {
  const ids = plan.items.filter(function (it) { return !it.group; }).map(function (it) { return it.id; });
  if (ids.length < 2) return null;
  const allOpen = ids.every(function (id) { return openRows.has(id); });

  const bar = document.createElement("div");
  bar.className = "v-expandbar";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "v-expandall";
  btn.textContent = allOpen ? "Collapse all" : "Expand all";
  btn.addEventListener("click", function () {
    if (allOpen) openRows = new Set();
    else openRows = new Set(ids);
    render();
  });
  bar.appendChild(btn);
  return bar;
}

// --- Payments between families --------------------------------------------
// Fronting a booking and being paid back for it are separate events. The flights were
// bought ten months out; the money comes back in dribs over the following year, not in
// one reckoning at the kitchen table. Each transfer is recorded as it happens, and the
// settle-up shows only what is still outstanding.

function newPaymentId() {
  return "p" + Date.now() + Math.floor(Math.random() * 1000);
}

function planPayments() {
  return Array.isArray(plan.payments) ? plan.payments : (plan.payments = []);
}

function addPayment(fields) {
  const p = {
    id: newPaymentId(),
    from: fields.from,
    to: fields.to,
    amount: fields.amount,
    date: fields.date || "",
    note: fields.note || "",
  };
  planPayments().push(p);
  savePaymentSoon(p.id);
  render();
}

function deletePayment(id) {
  plan.payments = planPayments().filter(function (p) { return p.id !== id; });
  savePaymentSoon(id);
  render();
}

function buildPaymentsSection() {
  const houses = Booking.households(plan);
  if (houses.length < 2) return null;

  const wrap = document.createElement("div");
  wrap.className = "pay-wrap";

  const paid = planPayments().slice().sort(function (a, b) {
    return String(b.date || "").localeCompare(String(a.date || ""));
  });

  const head = document.createElement("div");
  head.className = "you-head";
  head.style.marginTop = "16px";
  head.textContent = "Money already paid back";
  wrap.appendChild(head);

  if (!paid.length) {
    const empty = document.createElement("div");
    empty.className = "you-note";
    empty.textContent = "Nothing recorded yet. When someone pays their share of a booking to whoever fronted it, record it here and the settling-up above will drop by that much.";
    wrap.appendChild(empty);
  } else {
    const list = document.createElement("ul");
    list.className = "pay-list";
    for (const p of paid) {
      const li = document.createElement("li");
      const when = p.date ? fmtDate(p.date) : "";
      const main = document.createElement("div");
      main.className = "pay-main";
      main.innerHTML =
        "<div><strong>" + escapeHTML(Booking.householdName(plan, p.from) || "?") + "</strong> paid <strong>" +
        escapeHTML(Booking.householdName(plan, p.to) || "?") + "</strong> " +
        '<span class="amt">' + fmtUSD(Math.round(Booking.paymentAmount(p))) + "</span></div>" +
        (when || p.note
          ? '<div class="pay-sub">' + escapeHTML([when, p.note].filter(Boolean).join(" · ")) + "</div>"
          : "");
      li.appendChild(main);

      if (canEdit()) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "v-del";
        del.textContent = "Remove";
        let armed = false;
        del.addEventListener("click", function () {
          if (!armed) {
            armed = true;
            del.textContent = "Remove for everyone?";
            del.classList.add("armed");
            setTimeout(function () {
              if (!armed) return;
              armed = false;
              del.textContent = "Remove";
              del.classList.remove("armed");
            }, 8000);
            return;
          }
          deletePayment(p.id);
        });
        li.appendChild(del);
      }
      list.appendChild(li);
    }
    wrap.appendChild(list);
  }

  if (!canEdit()) return wrap;

  const form = document.createElement("form");
  form.className = "pay-form";

  function houseOptions(selected) {
    return '<option value="">— choose —</option>' + houses.map(function (h) {
      return '<option value="' + h.id + '"' + (h.id === selected ? " selected" : "") + ">" +
        escapeHTML(h.name) + "</option>";
    }).join("");
  }

  form.innerHTML =
    '<label>Who paid<select name="from">' + houseOptions(getMe()) + "</select></label>" +
    '<label>Who they paid<select name="to">' + houseOptions("") + "</select></label>" +
    '<label>How much<input name="amount" type="number" min="0" step="0.01" placeholder="0.00" required></label>' +
    '<label>When<input name="date" type="date"></label>' +
    '<label class="pay-wide">What for <span class="opt">optional</span>' +
    '<input name="note" type="text" placeholder="e.g. their share of the flights"></label>' +
    '<div class="pay-actions"><button type="submit">Record this payment</button>' +
    '<span class="pay-msg"></span></div>';

  const msg = form.querySelector(".pay-msg");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const from = form.from.value;
    const to = form.to.value;
    const amount = parseFloat(form.amount.value);
    // Guard rails, because a payment recorded the wrong way round quietly doubles a
    // debt instead of clearing it, and nothing on the page would look obviously wrong.
    if (!from || !to) { msg.textContent = "Pick who paid and who they paid."; return; }
    if (from === to) { msg.textContent = "A family can't pay itself."; return; }
    if (!isFinite(amount) || amount <= 0) { msg.textContent = "Enter an amount."; return; }
    msg.textContent = "";
    addPayment({ from: from, to: to, amount: amount, date: form.date.value, note: form.note.value.trim() });
  });

  const det = document.createElement("details");
  det.className = "pay-add";
  const sum = document.createElement("summary");
  sum.textContent = "+ Record a payment";
  det.append(sum, form);
  wrap.appendChild(det);

  return wrap;
}

// Same debounce and failure handling as an item edit; only the dirty channel differs.
function savePaymentSoon(id) {
  if (!canEdit()) return;
  if (id) dirtyPayments.add(id);
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

// --- The schedule: what still has to be done, and by when --------------------
//
// The cost tracker above records what a thing COSTS. It says nothing about the fact
// that somebody has to ring the host by a date, or that a deposit is due before a
// cancellation window shuts. Fourteen people were holding that in their heads.
//
// Tasks live in the plan, next to the items, for the same reason everything else
// does: they are shared, they merge per record, they are versioned by the backend and
// they ride along in every backup. A private list in a spreadsheet would be invisible
// to the thirteen other people the deadlines belong to.

const TASK_KINDS = [
  { v: "payment", label: "Payment" },
  { v: "booking", label: "Booking" },
  { v: "reimbursement", label: "Reimbursement" },
  { v: "admin", label: "Admin" },
];

const TASK_STATUSES = [
  { v: "todo", label: "Not started" },
  { v: "doing", label: "In progress" },
  { v: "waiting", label: "Waiting on someone" },
  { v: "done", label: "Done" },
  { v: "skip", label: "Not doing" },
];

// "soon" is a fortnight. Long enough to act on a booking, short enough that the
// amber band stays small enough to mean something.
const SOON_DAYS = 14;

let scheduleView = "list";   // "list" | "calendar"
let calCursor = "";          // "YYYY-MM" currently shown in the calendar
let calSelected = "";        // "YYYY-MM-DD" day whose tasks are listed under the grid
let editingTaskId = null;

function planTasks() {
  return Array.isArray(plan.tasks) ? plan.tasks : (plan.tasks = []);
}

function newTaskId() {
  return "t" + Date.now() + Math.floor(Math.random() * 1000);
}

function todayISO() {
  const d = new Date();
  return (
    d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

function isTaskClosed(t) {
  return t.status === "done" || t.status === "skip";
}

function daysUntil(iso) {
  if (!iso) return null;
  const MS = 86400000;
  return Math.round((parseISO(iso) - parseISO(todayISO())) / MS);
}

// Drives both the grouping in the list and the colour in the calendar, so the two
// views can never disagree about what counts as urgent.
//
// ASAP exists because plenty of real jobs are urgent without having a deadline —
// ring the host, decide about the second car, chase someone for a number. Those had
// no date, so they sank to the bottom under "No date yet", which is the opposite of
// what they need. The flag raises urgency; it does not replace the date, so a task
// can be both "as soon as you can" and "by the 18th at the latest".
//
// Genuinely overdue still outranks it: a date you have already missed is worse news
// than a job you have not started.
function taskUrgency(t) {
  if (isTaskClosed(t)) return "closed";
  if (t.due && daysUntil(t.due) < 0) return "overdue";
  if (t.asap) return "asap";
  if (!t.due) return "undated";
  return daysUntil(t.due) <= SOON_DAYS ? "soon" : "later";
}

function taskOwnerName(t) {
  if (t.owner === "all") return "Everyone";
  const h = (plan.households || []).find(function (x) { return x.id === t.owner; });
  return h ? h.name : "";
}

function labelFor(list, v, fallback) {
  const hit = list.find(function (x) { return x.v === v; });
  return hit ? hit.label : fallback;
}

function addTask(fields) {
  const t = {
    id: newTaskId(),
    title: fields.title,
    kind: fields.kind || "admin",
    owner: fields.owner || "",
    due: fields.due || "",
    amount: fields.amount === "" || fields.amount == null ? "" : Number(fields.amount),
    asap: !!fields.asap,
    status: "todo",
    doneOn: "",
    linked: fields.linked || "",
    notes: fields.notes || "",
  };
  planTasks().push(t);
  saveTaskSoon(t.id);
  render();
}

function deleteTask(id) {
  plan.tasks = planTasks().filter(function (t) { return t.id !== id; });
  if (editingTaskId === id) editingTaskId = null;
  saveTaskSoon(id);
  render();
}

// Same debounce and loud-failure handling as an item edit; only the dirty channel
// differs, so a task edit can never quietly overwrite someone's booking change.
function saveTaskSoon(id) {
  if (!canEdit()) return;
  if (id) dirtyTasks.add(id);
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

// Ticking something off stamps the date it happened, so "what did we do and when"
// survives. Un-ticking clears it rather than leaving a date that contradicts status.
function setTaskStatus(t, status) {
  t.status = status;
  if (status === "done") {
    if (!t.doneOn) t.doneOn = todayISO();
  } else {
    t.doneOn = "";
  }
  saveTaskSoon(t.id);
  render();
}

// Type order is TASK_KINDS order, not alphabetical, and that order is deliberate:
// payment, booking, reimbursement, admin — roughly what it costs you to be late.
// Missing a payment date has a price; an admin job slipping a week usually does not.
// Keeping it tied to TASK_KINDS means the dropdown and the sort can never disagree.
function kindRank(t) {
  const i = TASK_KINDS.findIndex(function (k) { return k.v === (t.kind || "admin"); });
  return i < 0 ? TASK_KINDS.length : i;
}

function sortedTasks() {
  // Date first, because that is the thing with consequences. Then type, which is what
  // actually does the work in the ASAP band and anywhere several things fall on one
  // day — there, every date is equal, so without this the order was effectively
  // whatever got typed in first. Title last, so the result is stable.
  //
  // Undated sinks to the bottom rather than the top, where a blank date would
  // otherwise read as "due first".
  return planTasks().slice().sort(function (a, b) {
    const ad = a.due || "9999-12-31";
    const bd = b.due || "9999-12-31";
    if (ad !== bd) return ad < bd ? -1 : 1;

    const ar = kindRank(a), br = kindRank(b);
    if (ar !== br) return ar - br;

    return (a.title || "").localeCompare(b.title || "");
  });
}

function buildSchedulePanel() {
  const tasks = planTasks();
  if (!tasks.length && !canEdit()) return null;

  const panel = document.createElement("div");
  panel.className = "panel sched";

  const head = document.createElement("div");
  head.className = "sched-head";
  head.innerHTML = '<div class="sched-title">What needs doing</div>';

  const toggle = document.createElement("div");
  toggle.className = "sched-toggle";
  [["list", "List"], ["calendar", "Calendar"]].forEach(function (pair) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = pair[1];
    b.className = scheduleView === pair[0] ? "on" : "";
    b.addEventListener("click", function () {
      scheduleView = pair[0];
      render();
    });
    toggle.appendChild(b);
  });
  head.appendChild(toggle);
  panel.appendChild(head);

  const counts = { overdue: 0, asap: 0, soon: 0, later: 0, undated: 0, closed: 0 };
  tasks.forEach(function (t) { counts[taskUrgency(t)]++; });

  const bits = [];
  if (counts.overdue) bits.push('<span class="s-over">' + counts.overdue + " overdue</span>");
  if (counts.asap) bits.push('<span class="s-asap">' + counts.asap + " to do now</span>");
  if (counts.soon) bits.push('<span class="s-soon">' + counts.soon + " due soon</span>");
  if (counts.later) bits.push(counts.later + " later");
  if (counts.undated) bits.push(counts.undated + " with no date");
  if (counts.closed) bits.push(counts.closed + " done");

  const sum = document.createElement("div");
  sum.className = "sched-sum";
  sum.innerHTML = bits.length ? bits.join(" · ") : "Nothing on the list yet.";
  panel.appendChild(sum);

  panel.appendChild(scheduleView === "calendar" ? buildTaskCalendar() : buildTaskList());

  if (canEdit()) panel.appendChild(buildTaskAddForm());
  return panel;
}

// --- List view --------------------------------------------------------------

function buildTaskList() {
  const wrap = document.createElement("div");
  const all = sortedTasks();
  if (!all.length) return wrap;

  const bands = [
    { key: "overdue", label: "Overdue" },
    { key: "asap", label: "As soon as possible" },
    { key: "soon", label: "Next " + SOON_DAYS + " days" },
    { key: "later", label: "Later" },
    { key: "undated", label: "No date yet" },
    { key: "closed", label: "Done" },
  ];

  bands.forEach(function (band) {
    const inBand = all.filter(function (t) { return taskUrgency(t) === band.key; });
    if (!inBand.length) return;
    const h = document.createElement("div");
    h.className = "sched-band " + band.key;
    h.textContent = band.label + " (" + inBand.length + ")";
    wrap.appendChild(h);
    inBand.forEach(function (t) { wrap.appendChild(buildTaskRow(t)); });
  });

  return wrap;
}

function buildTaskRow(t) {
  const row = document.createElement("div");
  row.className = "task " + taskUrgency(t) + (isTaskClosed(t) ? " is-closed" : "");

  const tick = document.createElement("input");
  tick.type = "checkbox";
  tick.className = "task-tick";
  tick.checked = t.status === "done";
  tick.disabled = !canEdit();
  tick.title = t.status === "done" ? "Mark as not done" : "Mark as done";
  tick.addEventListener("change", function () {
    setTaskStatus(t, tick.checked ? "done" : "todo");
  });
  row.appendChild(tick);
  row.appendChild(buildWhenBlock(t));

  const main = document.createElement("div");
  main.className = "task-main";

  let meta = '<span class="task-kind k-' + escapeHTML(t.kind || "admin") + '">' +
    escapeHTML(labelFor(TASK_KINDS, t.kind, "Admin")) + "</span>";

  // Shown even once it is done, so the record of what was urgent survives.
  if (t.asap) meta += '<span class="task-asap">ASAP</span>';

  const owner = taskOwnerName(t);
  if (owner) meta += '<span class="task-who">' + escapeHTML(owner) + "</span>";

  if (t.due) {
    const d = daysUntil(t.due);
    const day = parseISO(t.due).toLocaleDateString(undefined, { weekday: "long" });
    let when = day;
    if (!isTaskClosed(t)) {
      if (d < 0) when += " · " + Math.abs(d) + (Math.abs(d) === 1 ? " day late" : " days late");
      else if (d === 0) when += " · due today";
      else if (d === 1) when += " · due tomorrow";
      else when += " · in " + d + " days";
    }
    meta += '<span class="task-due">' + escapeHTML(when) + "</span>";
  }

  if (t.status !== "todo" && t.status !== "done") {
    meta += '<span class="task-state">' + escapeHTML(labelFor(TASK_STATUSES, t.status, "")) + "</span>";
  }
  if (t.status === "done" && t.doneOn) {
    meta += '<span class="task-state">done ' + escapeHTML(fmtDate(t.doneOn)) + "</span>";
  }

  main.innerHTML =
    '<div class="task-title">' + escapeHTML(t.title || "(untitled)") + "</div>" +
    '<div class="task-meta">' + meta + "</div>" +
    (t.linked ? '<div class="task-link">for: ' + escapeHTML(t.linked) + "</div>" : "") +
    (t.notes ? '<div class="task-notes">' + escapeHTML(t.notes) + "</div>" : "");
  row.appendChild(main);

  const right = document.createElement("div");
  right.className = "task-right";
  if (t.amount !== "" && t.amount != null && !isNaN(Number(t.amount))) {
    right.innerHTML = '<span class="task-amt">' + fmtUSD(Math.round(Number(t.amount))) + "</span>";
  }
  if (canEdit()) {
    const ed = document.createElement("button");
    ed.type = "button";
    ed.className = "task-edit";
    ed.textContent = editingTaskId === t.id ? "Close" : "Edit";
    ed.addEventListener("click", function () {
      editingTaskId = editingTaskId === t.id ? null : t.id;
      render();
    });
    right.appendChild(ed);
  }
  row.appendChild(right);

  if (editingTaskId === t.id && canEdit()) {
    const panel = buildTaskEditor(t);
    const holder = document.createElement("div");
    holder.className = "task-edwrap";
    holder.appendChild(panel);
    row.appendChild(holder);
  }

  return row;
}

/**
 * The date, as a block in its own column.
 *
 * It used to sit mid-sentence in the grey meta line, between the type chip and the
 * notes, at the same size as everything around it — so "when is this due" could not
 * be answered by scanning, only by reading each row. A fixed-width column of dates
 * can be run down with your eye, and the colour says how worried to be before you
 * have read a single word.
 *
 * Every task gets a block, including undated ones, because a column with gaps in it
 * stops being a column.
 */
function buildWhenBlock(t) {
  const el = document.createElement("div");
  el.className = "task-when " + taskUrgency(t);

  if (!t.due) {
    el.innerHTML = t.asap
      ? '<span class="w-asap">ASAP</span>'
      : '<span class="w-none">no<br>date</span>';
    return el;
  }

  const d = parseISO(t.due);
  const mon = d.toLocaleDateString(undefined, { month: "short" }).toUpperCase();

  // The trip straddles two years, so a bare "MAR 18" is genuinely ambiguous. The year
  // shows only when it is not the current one, to keep the block quiet the rest of
  // the time.
  const thisYear = new Date().getFullYear();
  const yr = d.getFullYear() !== thisYear
    ? "<span class=\"w-yr\">'" + String(d.getFullYear()).slice(2) + "</span>"
    : "";

  el.innerHTML =
    '<span class="w-mon">' + escapeHTML(mon) + "</span>" +
    '<span class="w-day">' + d.getDate() + "</span>" + yr;

  el.title = fmtDate(t.due);
  return el;
}

// Fields commit on BLUR, not on every keystroke. A re-render mid-typing steals the
// keyboard on a phone, which is how the item editor had to be fixed too.
function buildTaskEditor(t) {
  const box = document.createElement("div");
  box.className = "task-ed";

  function field(label, el) {
    const w = document.createElement("label");
    w.className = "task-edf";
    w.innerHTML = "<span>" + escapeHTML(label) + "</span>";
    w.appendChild(el);
    return w;
  }

  function text(value, placeholder, type) {
    const i = document.createElement("input");
    i.type = type || "text";
    i.value = value == null ? "" : value;
    if (placeholder) i.placeholder = placeholder;
    return i;
  }

  const title = text(t.title, "What has to happen");
  title.addEventListener("blur", function () {
    const v = title.value.trim();
    if (v !== t.title) { t.title = v; saveTaskSoon(t.id); render(); }
  });

  const due = text(t.due, "", "date");
  due.addEventListener("change", function () {
    if (due.value !== t.due) { t.due = due.value; saveTaskSoon(t.id); render(); }
  });

  const amount = text(t.amount, "optional", "number");
  amount.step = "0.01";
  amount.addEventListener("blur", function () {
    const v = amount.value.trim() === "" ? "" : Number(amount.value);
    if (v !== t.amount) { t.amount = v; saveTaskSoon(t.id); render(); }
  });

  const kind = document.createElement("select");
  TASK_KINDS.forEach(function (k) {
    const o = document.createElement("option");
    o.value = k.v; o.textContent = k.label;
    if ((t.kind || "admin") === k.v) o.selected = true;
    kind.appendChild(o);
  });
  kind.addEventListener("change", function () { t.kind = kind.value; saveTaskSoon(t.id); render(); });

  const status = document.createElement("select");
  TASK_STATUSES.forEach(function (s) {
    const o = document.createElement("option");
    o.value = s.v; o.textContent = s.label;
    if ((t.status || "todo") === s.v) o.selected = true;
    status.appendChild(o);
  });
  status.addEventListener("change", function () { setTaskStatus(t, status.value); });

  const owner = document.createElement("select");
  const ownerOpts = [{ v: "", label: "Nobody yet" }, { v: "all", label: "Everyone" }].concat(
    (plan.households || []).map(function (h) { return { v: h.id, label: h.name }; })
  );
  ownerOpts.forEach(function (o) {
    const el = document.createElement("option");
    el.value = o.v; el.textContent = o.label;
    if ((t.owner || "") === o.v) el.selected = true;
    owner.appendChild(el);
  });
  owner.addEventListener("change", function () { t.owner = owner.value; saveTaskSoon(t.id); render(); });

  const linked = document.createElement("select");
  const linkOpts = [{ v: "", label: "Not linked" }].concat(
    plan.items.map(function (it) { return { v: it.title, label: it.title }; })
  );
  linkOpts.forEach(function (o) {
    const el = document.createElement("option");
    el.value = o.v; el.textContent = o.label;
    if ((t.linked || "") === o.v) el.selected = true;
    linked.appendChild(el);
  });
  linked.addEventListener("change", function () { t.linked = linked.value; saveTaskSoon(t.id); render(); });

  const notes = document.createElement("textarea");
  notes.rows = 2;
  notes.value = t.notes || "";
  notes.placeholder = "Anything worth remembering — a reference, who to ring, what to check";
  notes.addEventListener("blur", function () {
    const v = notes.value.trim();
    if (v !== t.notes) { t.notes = v; saveTaskSoon(t.id); render(); }
  });

  const grid = document.createElement("div");
  grid.className = "task-edgrid";
  grid.append(
    field("Task", title),
    field("Due", due),
    field("Type", kind),
    field("Amount", amount),
    field("Who's doing it", owner),
    field("Status", status),
    field("For which booking", linked)
  );
  box.appendChild(grid);

  // A checkbox rather than another entry in the status dropdown: "as soon as
  // possible" is about WHEN, not about how far along it is, and a job can be both
  // urgent and already in progress.
  const asap = document.createElement("label");
  asap.className = "task-asapbox";
  const asapTick = document.createElement("input");
  asapTick.type = "checkbox";
  asapTick.checked = !!t.asap;
  asapTick.addEventListener("change", function () {
    t.asap = asapTick.checked;
    saveTaskSoon(t.id);
    render();
  });
  asap.appendChild(asapTick);
  asap.appendChild(document.createTextNode(" Do this as soon as possible"));
  const hint = document.createElement("span");
  hint.className = "task-asaphint";
  hint.textContent = "Moves it to the top of the list. Works with or without a due date.";
  asap.appendChild(hint);
  box.appendChild(asap);

  const nf = field("Notes", notes);
  nf.className = "task-edf wide";
  box.appendChild(nf);

  const foot = document.createElement("div");
  foot.className = "task-edfoot";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "task-del";
  del.textContent = "Remove this task";
  let armed = false;
  let armTimer = null;
  del.addEventListener("click", function () {
    if (!armed) {
      armed = true;
      del.textContent = "Tap again to remove";
      del.classList.add("armed");
      armTimer = setTimeout(function () {
        armed = false;
        del.textContent = "Remove this task";
        del.classList.remove("armed");
      }, 8000);
      return;
    }
    clearTimeout(armTimer);
    deleteTask(t.id);
  });
  foot.appendChild(del);
  box.appendChild(foot);

  return box;
}

function buildTaskAddForm() {
  const wrap = document.createElement("details");
  wrap.className = "task-add";
  const sum = document.createElement("summary");
  sum.textContent = "+ Add something that needs doing";
  wrap.appendChild(sum);

  const form = document.createElement("form");
  form.className = "task-addform";
  form.innerHTML =
    '<input name="title" type="text" placeholder="What has to happen" required>' +
    '<input name="due" type="date">' +
    '<select name="kind">' + TASK_KINDS.map(function (k) {
      return '<option value="' + k.v + '">' + k.label + "</option>";
    }).join("") + "</select>" +
    '<input name="amount" type="number" step="0.01" placeholder="Amount (optional)">' +
    '<select name="owner"><option value="">Nobody yet</option><option value="all">Everyone</option>' +
    (plan.households || []).map(function (h) {
      return '<option value="' + escapeHTML(h.id) + '">' + escapeHTML(h.name) + "</option>";
    }).join("") + "</select>" +
    '<label class="task-addasap"><input type="checkbox" name="asap"> ' +
    "Do this as soon as possible — no fixed deadline needed</label>" +
    '<button type="submit">Add it</button>';

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const title = form.title.value.trim();
    if (!title) return;
    addTask({
      title: title,
      due: form.due.value,
      kind: form.kind.value,
      amount: form.amount.value,
      owner: form.owner.value,
      asap: form.asap.checked,
    });
    form.reset();
  });

  wrap.appendChild(form);
  return wrap;
}

// --- Calendar view ----------------------------------------------------------

function monthOf(iso) { return iso ? iso.slice(0, 7) : ""; }

function shiftMonth(ym, delta) {
  let y = Number(ym.slice(0, 4));
  let m = Number(ym.slice(5, 7)) + delta;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return y + "-" + String(m).padStart(2, "0");
}

// Open on the month that actually has the next thing due, not on today — for a trip
// six months out, "today" is an empty grid and looks broken.
function defaultCalMonth() {
  const open = sortedTasks().filter(function (t) { return t.due && !isTaskClosed(t); });
  if (open.length) {
    const overdue = open.filter(function (t) { return daysUntil(t.due) < 0; });
    const next = overdue.length ? overdue[0] : open[0];
    return monthOf(next.due);
  }
  const dated = sortedTasks().filter(function (t) { return t.due; });
  return dated.length ? monthOf(dated[0].due) : monthOf(todayISO());
}

function buildTaskCalendar() {
  if (!calCursor) calCursor = defaultCalMonth();

  const wrap = document.createElement("div");
  wrap.className = "cal";

  const year = Number(calCursor.slice(0, 4));
  const month = Number(calCursor.slice(5, 7));

  // Built from sortedTasks(), not storage order, so several things falling on one day
  // appear in the same type order as the list — in the grid's two visible pills and in
  // the detail under it. Two views disagreeing about what comes first is the kind of
  // small wrongness that makes people stop trusting the page.
  const byDay = {};
  sortedTasks().forEach(function (t) {
    if (!t.due) return;
    (byDay[t.due] = byDay[t.due] || []).push(t);
  });

  // The trip itself, not the to-do list. A stay or a park day is not a task and has no
  // business in the schedule list, but it is exactly what you want to see on a
  // calendar: the shape of the week the deadlines are leading up to.
  //
  // A range fills every day it covers, so a house booked the 17th to the 19th appears
  // on all three. That means a changeover day shows both houses, which is correct and
  // is precisely the day worth looking at twice.
  const stayByDay = {};
  let skippedItems = 0;
  (plan.items || []).forEach(function (it) {
    if (!it.date) return;
    if (!isIncluded(it)) { skippedItems++; return; }

    const end = (it.endDate && it.endDate > it.date) ? it.endDate : it.date;
    const cursor = parseISO(it.date);
    const stop = parseISO(end);

    // A mistyped year could otherwise ask the browser to walk a few thousand days.
    for (var guard = 0; cursor <= stop && guard < 400; guard++) {
      const key = cursor.getFullYear() + "-" +
        String(cursor.getMonth() + 1).padStart(2, "0") + "-" +
        String(cursor.getDate()).padStart(2, "0");
      (stayByDay[key] = stayByDay[key] || []).push({
        item: it,
        first: key === it.date,
        last: key === end,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
  });

  const nav = document.createElement("div");
  nav.className = "cal-nav";
  const prev = document.createElement("button");
  prev.type = "button"; prev.textContent = "‹";
  prev.setAttribute("aria-label", "Previous month");
  prev.addEventListener("click", function () { calCursor = shiftMonth(calCursor, -1); calSelected = ""; render(); });
  const next = document.createElement("button");
  next.type = "button"; next.textContent = "›";
  next.setAttribute("aria-label", "Next month");
  next.addEventListener("click", function () { calCursor = shiftMonth(calCursor, 1); calSelected = ""; render(); });
  const label = document.createElement("div");
  label.className = "cal-month";
  label.textContent = new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  nav.append(prev, label, next);
  wrap.appendChild(nav);

  const grid = document.createElement("div");
  grid.className = "cal-grid";
  ["S", "M", "T", "W", "T", "F", "S"].forEach(function (d, i) {
    const h = document.createElement("div");
    h.className = "cal-dow";
    h.textContent = d;
    h.setAttribute("aria-label", ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][i]);
    grid.appendChild(h);
  });

  const first = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let i = 0; i < first.getDay(); i++) {
    const pad = document.createElement("div");
    pad.className = "cal-cell pad";
    grid.appendChild(pad);
  }

  const today = todayISO();
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = calCursor + "-" + String(day).padStart(2, "0");
    const here = byDay[iso] || [];
    const stays = stayByDay[iso] || [];
    const cell = document.createElement("div");
    cell.className = "cal-cell" +
      (iso === today ? " is-today" : "") +
      (iso === calSelected ? " is-sel" : "") +
      (here.length || stays.length ? " has" : "") +
      (stays.length ? " has-trip" : "") +
      (here.length ? " has-task" : "");

    const RANK = { overdue: 4, asap: 3, soon: 2, later: 1 };
    let worst = "", worstRank = 0;
    here.forEach(function (t) {
      const u = taskUrgency(t);
      const r = RANK[u] || 0;
      if (r > worstRank) { worstRank = r; worst = u; }
    });
    if (worst) cell.classList.add("u-" + worst);
    if (here.length && here.every(isTaskClosed)) cell.classList.add("u-closed");

    // The trip comes first: it is what the day IS, where a task is something to do
    // about it. Three pills is what fits before a cell starts scrolling.
    let inner = '<div class="cal-num">' + day + "</div>";
    let shown = 0;
    const ROOM = 3;

    stays.forEach(function (s) {
      if (shown >= ROOM) return;
      shown++;
      // Every day names what is happening on it, including the middle of a stay.
      // A blank continuation bar looked tidy in the abstract and read as a mystery
      // blue strip in practice — someone looking at the 21st wants to be told
      // "Bradenton Beach house", not left to trace the bar back to the 19th.
      const edge = (s.first ? " first" : "") + (s.last ? " last" : "") +
        (s.first ? "" : " cont");
      inner += '<div class="cal-trip' + edge + '">' + escapeHTML(s.item.title || "") + "</div>";
    });

    here.forEach(function (t) {
      if (shown >= ROOM) return;
      shown++;
      inner += '<div class="cal-pill ' + taskUrgency(t) + '">' + escapeHTML(t.title || "") + "</div>";
    });

    const hidden = (stays.length + here.length) - shown;
    if (hidden > 0) inner += '<div class="cal-more">+' + hidden + " more</div>";
    cell.innerHTML = inner;

    if (here.length || stays.length) {
      cell.setAttribute("role", "button");
      cell.tabIndex = 0;
      const open = function () { calSelected = calSelected === iso ? "" : iso; render(); };
      cell.addEventListener("click", open);
      cell.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
    }
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);

  // A calendar can only show things that have a date. An ASAP job with no deadline is
  // the most urgent thing on the list and would be the one item the grid silently
  // omits, so it gets its own strip rather than being left to the footnote.
  const asapNoDate = sortedTasks().filter(function (t) {
    return t.asap && !t.due && !isTaskClosed(t);
  });
  if (asapNoDate.length) {
    const strip = document.createElement("div");
    strip.className = "cal-asap";
    const h = document.createElement("div");
    h.className = "cal-asaphead";
    h.textContent = "As soon as possible — no fixed date";
    strip.appendChild(h);
    asapNoDate.forEach(function (t) { strip.appendChild(buildTaskRow(t)); });
    wrap.insertBefore(strip, wrap.firstChild);
  }

  // The grid can only ever show a truncated title. Anything with a date that is not
  // in view this month would otherwise be invisible, so say so rather than imply the
  // month is the whole list.
  const elsewhere = planTasks().filter(function (t) { return t.due && monthOf(t.due) !== calCursor; }).length;
  const undated = planTasks().filter(function (t) { return !t.due; }).length - asapNoDate.length;
  const notes = [];
  if (elsewhere) notes.push(elsewhere + (elsewhere === 1 ? " task is" : " tasks are") + " in other months");
  if (undated) notes.push(undated + (undated === 1 ? " task has" : " tasks have") + " no date");
  // Switched-off items are left off the grid on purpose, but silently dropping them
  // would make the calendar quietly disagree with the Trip tab.
  if (skippedItems) {
    notes.push(skippedItems + (skippedItems === 1 ? " booking is" : " bookings are") + " switched off and not shown");
  }
  if (notes.length) {
    const n = document.createElement("div");
    n.className = "cal-note";
    n.textContent = notes.join(" · ") + " — switch to List to see everything.";
    wrap.appendChild(n);
  }

  // The calendar opens on whatever is due next, which for a trip still months away is
  // a long way from the trip. Rather than make someone press the arrow five times.
  const tripStart = (plan.items || [])
    .filter(function (it) { return it.date && isIncluded(it); })
    .map(function (it) { return it.date; })
    .sort()[0];

  if (tripStart && monthOf(tripStart) !== calCursor) {
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "cal-jump";
    jump.textContent = "Jump to the trip — " +
      parseISO(tripStart).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    jump.addEventListener("click", function () {
      calCursor = monthOf(tripStart);
      calSelected = "";
      render();
    });
    wrap.appendChild(jump);
  }

  if (calSelected && (byDay[calSelected] || stayByDay[calSelected])) {
    const day = document.createElement("div");
    day.className = "cal-day";
    const h = document.createElement("div");
    h.className = "cal-dayhead";
    h.textContent = fmtDate(calSelected);
    day.appendChild(h);

    (stayByDay[calSelected] || []).forEach(function (s) {
      const r = document.createElement("div");
      r.className = "cal-dayitem";
      const span = isRange(s.item)
        ? fmtDateRange(s.item.date, s.item.endDate)
        : fmtDate(s.item.date);
      r.innerHTML =
        '<span class="di-title">' + escapeHTML(s.item.title || "") + "</span>" +
        '<span class="di-when">' + escapeHTML(span) + "</span>";
      day.appendChild(r);
    });

    (byDay[calSelected] || []).forEach(function (t) { day.appendChild(buildTaskRow(t)); });
    wrap.appendChild(day);
  }

  return wrap;
}

// --- A contribution, announced properly -------------------------------------
//
// There has long been a calculator here that lets a contributing household model
// "what if I put in X" — deliberately private, never written to the shared plan,
// because exploring an offer should not broadcast a half-formed number to thirteen
// people. What was missing was the other end: actually saying it, once decided.
//
// So this is two things. A pledge the contributing household submits — an amount and
// a message in their own words — and the way everyone else finds out, which is a
// wrapped envelope that unties itself and opens into a card.
//
// WHAT IT DOES NOT DO: move anybody's share. The ledger follows money that has
// actually been laid out, tracked through payers and repayments. A pledge that
// quietly reduced what families owe would double-count the moment the money really
// changed hands, and the settle-up would stop agreeing with reality. The card says
// what was promised; the Money tab keeps saying what is owed.

function planGift() {
  const g = plan.gift;
  return g && typeof g === "object" && Number(g.amount) > 0 ? g : null;
}

// Keyed on the submission time, so editing the amount or the message makes it a new
// gift and it plays again for everyone. Per device, like every other viewer setting.
function giftSeenKey() {
  const g = planGift();
  return "tt-gift-" + (planId || "hash") + "-" + (g ? g.at || "" : "");
}
function giftSeen() {
  try { return !!localStorage.getItem(giftSeenKey()); } catch (e) { return true; }
}
function markGiftSeen() {
  try { localStorage.setItem(giftSeenKey(), "1"); } catch (e) {}
}

// Only the household flagged as contributing, and only on the device where someone
// has claimed it. Gated on the flag rather than a name so it survives a rename.
function canPledge() {
  if (!canEdit()) return false;
  const me = getMe();
  const h = (plan.households || []).find(function (x) { return x.id === me; });
  return !!(h && h.contributes);
}

function giverName(g) {
  const h = (plan.households || []).find(function (x) { return x.id === (g || {}).from; });
  return h ? h.name : "";
}

function saveGiftSoon() {
  if (!canEdit()) return;
  dirtyGift = true;
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

// --- The panel on the Money tab ---------------------------------------------

function buildGiftPanel() {
  const g = planGift();
  const mine = canPledge();
  if (!g && !mine) return null;

  const panel = document.createElement("div");
  panel.className = "panel";

  if (g) {
    const who = giverName(g);
    panel.innerHTML =
      '<div class="area-heading">A gift toward the trip</div>' +
      '<div class="gp-card">' +
      '<div class="gp-amt">' + fmtUSD(Math.round(Number(g.amount))) + "</div>" +
      (who ? '<div class="gp-from">from the ' + escapeHTML(who) + "</div>" : "") +
      (g.message ? '<div class="gp-msg">' + escapeHTML(g.message) + "</div>" : "") +
      "</div>";

    const again = document.createElement("button");
    again.type = "button";
    again.className = "gp-replay";
    again.textContent = "Play the card again";
    again.addEventListener("click", function () { playGiftReveal(true); });
    panel.appendChild(again);

    const note = document.createElement("div");
    note.className = "gp-note";
    note.innerHTML =
      "This comes off the trip before anyone's share is worked out, so it shows as a " +
      "credit on the Trip tab and every family below owes less. It is <strong>not</strong> " +
      "treated as a payment between families, so nobody's settling-up transfer changes." +
      "<br><br>Because it comes off the whole trip, the " +
      escapeHTML(giverName(planGift()) || "giving household") +
      "’s own share falls a little too. If the intention is to cover only the " +
      "other families' shares, say so and it can work that way instead.";
    panel.appendChild(note);
  }

  if (mine) panel.appendChild(buildPledgeForm(g));
  return panel;
}

function buildPledgeForm(g) {
  const wrap = document.createElement("details");
  wrap.className = "gp-form";
  const sum = document.createElement("summary");
  sum.textContent = g ? "Change your gift" : "Give a gift toward the trip";
  wrap.appendChild(sum);

  const form = document.createElement("form");
  form.className = "gp-fields";
  form.innerHTML =
    '<label><span>Amount</span><input name="amount" type="number" step="1" min="1" ' +
    'placeholder="e.g. 5000" value="' + (g ? escapeHTML(String(g.amount)) : "") + '" required></label>' +
    '<label class="wide"><span>Your message</span><textarea name="message" rows="3" ' +
    'placeholder="Say something to the family — this is what the card will read.">' +
    (g ? escapeHTML(g.message || "") : "") + "</textarea></label>" +
    '<div class="gp-actions"><button type="submit">' +
    (g ? "Update the card" : "Wrap it up") + "</button>" +
    (g ? '<button type="button" class="gp-remove">Take it back</button>' : "") +
    '<span class="gp-hint">Everyone sees this, with your message, the next time they open the site.</span></div>';

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const amount = Number(form.amount.value);
    if (!(amount > 0)) return;
    plan.gift = {
      from: getMe(),
      amount: amount,
      message: form.message.value.trim(),
      // Doubles as the version: change either field and the card plays again.
      at: new Date().toISOString(),
    };
    saveGiftSoon();
    render();
    playGiftReveal(true);
  });

  const remove = form.querySelector(".gp-remove");
  if (remove) {
    let armed = false, timer = null;
    remove.addEventListener("click", function () {
      if (!armed) {
        armed = true;
        remove.textContent = "Tap again to remove it";
        remove.classList.add("armed");
        timer = setTimeout(function () {
          armed = false;
          remove.textContent = "Take it back";
          remove.classList.remove("armed");
        }, 8000);
        return;
      }
      clearTimeout(timer);
      plan.gift = null;
      saveGiftSoon();
      render();
    });
  }

  wrap.appendChild(form);
  return wrap;
}

// --- The reveal -------------------------------------------------------------

function playGiftReveal(force) {
  const g = planGift();
  if (!g) return;
  if (!force && giftSeen()) return;
  if (document.querySelector(".gv-wrap")) return;   // already on screen

  markGiftSeen();

  // Someone who has asked their system for less movement gets the card, not the
  // performance. The point is the message, and that still arrives.
  let calm = false;
  try {
    calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) { calm = false; }

  const who = giverName(g);
  const amount = Math.round(Number(g.amount));

  const wrap = document.createElement("div");
  wrap.className = "gv-wrap" + (calm ? " calm" : "");
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-label", "A gift toward the trip");
  wrap.innerHTML =
    '<div class="gv-stage">' +
      '<div class="gv-env">' +
        '<div class="gv-back"></div>' +
        '<div class="gv-card">' +
          (who ? '<div class="gv-from">A gift from the ' + escapeHTML(who) + "</div>" : "") +
          (g.message ? '<div class="gv-msg">' + escapeHTML(g.message) + "</div>" : "") +
          '<div class="gv-amt" data-to="' + amount + '">' + (calm ? fmtUSD(amount) : "$0") + "</div>" +
          '<div class="gv-sub">toward the trip</div>' +
        "</div>" +
        '<div class="gv-front"></div>' +
        '<div class="gv-flap"></div>' +
        '<div class="gv-ribbon v"></div>' +
        '<div class="gv-ribbon h"></div>' +
        '<div class="gv-bow"><i class="l"></i><i class="r"></i><i class="k"></i></div>' +
      "</div>" +
      '<button type="button" class="gv-close">Close</button>' +
    "</div>";

  document.body.appendChild(wrap);
  document.body.classList.add("gv-open");

  const close = function () {
    document.body.classList.remove("gv-open");
    wrap.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = function (e) { if (e.key === "Escape") close(); };

  wrap.addEventListener("click", function (e) {
    // Anywhere outside the card closes it — including mid-animation, so nobody is
    // held hostage by a bow they have already seen.
    if (!e.target.closest(".gv-card")) close();
  });
  document.addEventListener("keydown", onKey);
  wrap.querySelector(".gv-close").focus();

  if (!calm) countUp(wrap.querySelector(".gv-amt"), amount, 2200, 900);
}

// Ticks the figure up once the card is out. Pure decoration, and skipped entirely
// when the viewer has asked for reduced motion.
function countUp(el, to, delayMs, durMs) {
  if (!el) return;
  setTimeout(function () {
    const started = performance.now();
    const step = function (now) {
      const t = Math.min(1, (now - started) / durMs);
      // Ease out, so it lands softly rather than stopping dead.
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = fmtUSD(Math.round(to * eased));
      if (t < 1 && document.body.contains(el)) requestAnimationFrame(step);
      else el.textContent = fmtUSD(to);
    };
    requestAnimationFrame(step);
  }, delayMs);
}

/**
 * How a gift is applied to each household.
 *
 * The rule, in the giver's words: cover their own share first, then spread whatever
 * is left evenly across the other families. "Evenly" means equal pounds, not
 * proportional to the share basis — a gift is a gift, not a second way of splitting
 * the bill.
 *
 * Nobody can be credited more than they owe. If a family's share is smaller than its
 * even slice, the surplus flows back to the others rather than evaporating, which is
 * why this loops instead of dividing once. Anything that still cannot be used is
 * reported, so an over-large gift says so rather than quietly vanishing.
 *
 * Takes the raw shares so it can be tested on its own, and returns only numbers.
 */
function giftAllocation(baseOwes) {
  const g = planGift();
  const out = { credit: {}, unused: 0, total: 0 };
  Object.keys(baseOwes).forEach(function (id) { out.credit[id] = 0; });
  if (!g) return out;

  let remaining = Math.abs(Number(g.amount)) || 0;
  out.total = remaining;
  const giver = g.from;

  // 1. The giver's own share.
  if (giver && baseOwes[giver] != null) {
    const take = Math.min(remaining, Math.max(0, baseOwes[giver]));
    out.credit[giver] = take;
    remaining -= take;
  }

  // 2. What is left, evenly across everyone else, capped at what each still owes.
  let others = Object.keys(baseOwes).filter(function (id) {
    return id !== giver && baseOwes[id] - out.credit[id] > 0.005;
  });

  let guard = 0;
  while (remaining > 0.005 && others.length && guard++ < 50) {
    const slice = remaining / others.length;
    const stillOwing = [];
    others.forEach(function (id) {
      const room = baseOwes[id] - out.credit[id];
      const take = Math.min(slice, room);
      out.credit[id] += take;
      remaining -= take;
      if (room - take > 0.005) stillOwing.push(id);
    });
    others = stillOwing;
  }

  out.unused = Math.max(0, remaining);
  return out;
}

// The credit as it appears under the itinerary: a row, not a booking. No Edit, no
// Remove, no checkbox — it is changed through the gift form or not at all.
function buildCreditRow() {
  const credit = giftCreditItem();
  if (!credit) return null;
  const g = planGift();

  const row = document.createElement("div");
  row.className = "credit-row";
  row.innerHTML =
    '<div class="cr-main">' +
      '<div class="cr-title">' + escapeHTML(credit.title) + "</div>" +
      '<div class="cr-sub">A gift toward the trip — taken off before everyone’s share is worked out</div>' +
      (g && g.message ? '<div class="cr-msg">' + escapeHTML(g.message) + "</div>" : "") +
    "</div>" +
    '<div class="cr-amt">−' + fmtUSD(Math.abs(credit.cost)) + "</div>";
  return row;
}
