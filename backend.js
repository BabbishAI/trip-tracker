// How the site talks to its backend: a Google Apps Script web app in front of a
// private Google Sheet.
//
// Shared by the group view and the editor. It lives in one file on purpose — the
// Content-Type below is load-bearing and easy to "tidy up" into something that breaks
// only in a browser, which is the one place it is hard to notice.
//
// WHY text/plain FOR A JSON BODY
// Apps Script does not answer the CORS preflight OPTIONS request. A POST carrying
// Content-Type: application/json is not a "simple request", so the browser sends that
// preflight first, gets nothing usable back, and blocks the POST before it leaves the
// machine. text/plain IS a simple request, so there is no preflight. The body is still
// JSON and the backend parses it as JSON.
//
// Apps Script also serves its answer from a redirect, so redirects must be followed.

(function () {
  const BACKEND = window.BACKEND || {};

  async function backendCall(op, body) {
    if (!BACKEND.url || BACKEND.url.indexOf("PASTE") === 0) {
      throw new Error("the backend is not set up yet (see apps-script/SETUP.md)");
    }

    const res = await fetch(BACKEND.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ op: op }, body || {})),
      redirect: "follow",
    });
    if (!res.ok) throw new Error(op + " failed: HTTP " + res.status);

    const out = await res.json();

    // The backend answers HTTP 200 with {ok:false, error} for its own refusals — a
    // busy sheet, a bad payload, an unknown version. So a failure has to be read out
    // of the body, not the status code. Reading only res.ok would make a refused save
    // look like a successful one, which is the exact failure this app must never have.
    if (!out || out.ok !== true) {
      throw new Error((out && out.error) || "the backend refused the request");
    }
    return out.data;
  }

  window.tripBackend = {
    call: backendCall,

    // The stored plan object, or null when the id isn't found. There is deliberately
    // no "list plans" operation: the plan id is the password, so an id is the only
    // way to reach anything.
    get: (id) => backendCall("get", { pid: id }),

    save: (id, payload) => backendCall("save", { pid: id, payload: payload }),

    // Present for recovery from the browser console if the group ever wipes the plan:
    //   tripBackend.versions('<plan id>').then(console.log)
    //   tripBackend.restore('<plan id>', <version id>)
    versions: (id) => backendCall("versions", { pid: id }),
    restore: (id, vid) => backendCall("restore", { pid: id, vid: vid }),

    // Note that this device opened the plan. Deliberately swallows every failure:
    // it runs on page load, and nobody's trip should fail to render because a piece
    // of bookkeeping did not.
    visit: (id, device, who) =>
      backendCall("visit", { pid: id, device: device, who: who || "" }).catch(() => null),

    visitors: (id) => backendCall("visitors", { pid: id }),

    configured: () => !!(BACKEND.url && BACKEND.url.indexOf("PASTE") !== 0),
  };
})();
