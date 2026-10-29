/*! Sabhi lead.js v1. Captures <form data-lead-form> submissions and posts them to the Sabhi ingest API.
 *  Embed: <script src="https://ingest.sabhidigital.com/lead.js" data-client="client-slug" data-lp="lp-key" defer></script>
 *  Plain ES5-friendly JavaScript, no build step. Never blocks the page if anything fails.
 */
(function () {
  "use strict";
  try {
    var script = document.currentScript || document.querySelector("script[data-lp][data-client]");
    if (!script) return;
    var CLIENT = script.getAttribute("data-client");
    var LP = script.getAttribute("data-lp");
    var BASE = script.getAttribute("data-endpoint") || new URL(script.src, location.href).origin;
    if (!CLIENT || !LP) return console.warn("[sabhi] lead.js needs data-client and data-lp");

    var ENDPOINT = BASE + "/api/ingest/" + encodeURIComponent(CLIENT) + "/" + encodeURIComponent(LP);
    var PENDING_KEY = "sabhi_pending_leads";
    var UTM_KEY = "sabhi_utm";
    var MAX_RETRIES = 10;
    var RETRY_MS = 30000;
    var TRACK_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id", "fbclid", "gclid"];

    // ---------- storage helpers (storage can be blocked; never throw) ----------
    function load(key, fallback) {
      try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
    }
    function save(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    }
    function cookie(name) {
      var m = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[.$?*|{}()[\]\\/+^]/g, "\\$&") + "=([^;]*)"));
      return m ? decodeURIComponent(m[1]) : null;
    }
    function uuid() {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
      return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
    }

    // ---------- tracking: first-touch UTMs stored on first visit ----------
    function captureTracking() {
      var params = new URLSearchParams(location.search);
      var stored = load(UTM_KEY, null);
      var found = {};
      var any = false;
      TRACK_PARAMS.forEach(function (p) {
        var v = params.get(p);
        if (v) { found[p] = v; any = true; }
      });
      if (any && !stored) { found.landing_url = location.href; save(UTM_KEY, found); stored = found; }
      return stored || {};
    }
    var firstTouch = captureTracking();

    function buildTracking() {
      var t = {};
      var params = new URLSearchParams(location.search);
      Object.keys(firstTouch).forEach(function (k) { t[k] = String(firstTouch[k]); });
      TRACK_PARAMS.forEach(function (p) { var v = params.get(p); if (v) t[p] = v; });
      var fbp = cookie("_fbp");
      var fbc = cookie("_fbc") || (t.fbclid ? "fb.1." + Date.now() + "." + t.fbclid : null);
      if (fbp) t.fbp = fbp;
      if (fbc) t.fbc = fbc;
      t.page_url = location.href;
      if (document.referrer) t.referrer = document.referrer;
      return t;
    }

    // ---------- reading the form ----------
    function labelFor(el, form) {
      if (el.getAttribute("data-label")) return el.getAttribute("data-label");
      if (el.id) {
        var l = form.querySelector('label[for="' + el.id.replace(/"/g, '\\"') + '"]');
        if (l) return l.textContent.trim();
      }
      if (el.type === "radio" || el.type === "checkbox") {
        // Group question text: fieldset legend, or a data-question wrapper.
        var group = el.closest("fieldset, [data-question]");
        if (group) {
          var legend = group.querySelector("legend, [data-question-label]");
          if (legend) return legend.textContent.trim();
          if (group.getAttribute("data-question")) return group.getAttribute("data-question");
        }
      }
      var wrap = el.closest("label");
      if (wrap) return wrap.textContent.trim();
      return el.getAttribute("placeholder") || el.getAttribute("aria-label") || el.name;
    }

    function optionText(el, form) {
      var wrap = el.closest("label");
      if (wrap) return wrap.textContent.trim() || el.value;
      if (el.id) {
        var l = form.querySelector('label[for="' + el.id.replace(/"/g, '\\"') + '"]');
        if (l) return l.textContent.trim();
      }
      return el.value;
    }

    function readFields(form) {
      var fields = [];
      var groups = {};
      var elements = form.querySelectorAll("input[name], select[name], textarea[name]");
      Array.prototype.forEach.call(elements, function (el) {
        var type = (el.tagName === "INPUT" ? el.type : el.tagName).toLowerCase();
        if (["submit", "button", "reset", "file", "password", "image"].indexOf(type) >= 0) return;
        if (el.name === "cf-turnstile-response" || el.name === "g-recaptcha-response") return;
        if (el.disabled) return;

        if (type === "radio" || type === "checkbox") {
          var g = groups[el.name];
          if (!g) {
            var all = form.querySelectorAll('input[name="' + el.name.replace(/"/g, '\\"') + '"]');
            g = groups[el.name] = {
              key: el.name,
              type: type,
              label: labelFor(el, form),
              role: el.getAttribute("data-role") || undefined,
              options: Array.prototype.map.call(all, function (o) { return optionText(o, form); }),
              multi: type === "checkbox" && all.length > 1,
              values: [],
              score: null
            };
            fields.push(g);
          }
          if (el.checked) {
            g.values.push(optionText(el, form));
            var s = el.getAttribute("data-score");
            if (s !== null && s !== "" && !isNaN(Number(s))) g.score = (g.score || 0) + Number(s);
          }
          return;
        }

        var field = {
          key: el.name,
          type: type === "select-one" || type === "select-multiple" ? "select" : type,
          label: labelFor(el, form),
          role: el.getAttribute("data-role") || undefined,
          value: el.value
        };
        if (el.tagName === "SELECT") {
          field.options = Array.prototype.filter
            .call(el.options, function (o) { return o.value !== ""; })
            .map(function (o) { return o.text.trim(); });
          var selected = Array.prototype.filter.call(el.options, function (o) { return o.selected && o.value !== ""; });
          field.value = el.multiple
            ? selected.map(function (o) { return o.text.trim(); })
            : selected.length ? selected[0].text.trim() : "";
          var opt = selected[0];
          if (opt && opt.getAttribute("data-score") !== null) field.score = Number(opt.getAttribute("data-score"));
        } else if (el.getAttribute("data-score") !== null) {
          field.score = Number(el.getAttribute("data-score"));
        }
        fields.push(field);
      });

      return fields.map(function (f) {
        if (!f.values) return f;
        var out = { key: f.key, type: f.type, label: f.label, role: f.role, options: f.options };
        if (f.multi) out.value = f.values;
        else if (f.type === "checkbox") out.value = f.values.length ? f.values[0] : "";
        else out.value = f.values.length ? f.values[0] : "";
        if (f.score !== null) out.score = f.score;
        return out;
      });
    }

    function consentFor(form) {
      var box = form.querySelector("[data-consent]");
      if (!box) return undefined;
      var text = box.getAttribute("data-consent") || labelFor(box, form);
      return { given: !!box.checked, text: text, at: new Date().toISOString() };
    }

    function turnstileToken(form) {
      var input = form.querySelector('[name="cf-turnstile-response"]');
      if (input && input.value) return input.value;
      try { if (window.turnstile && turnstile.getResponse) return turnstile.getResponse() || undefined; } catch (e) { /* ignore */ }
      return undefined;
    }

    // ---------- sending and retry queue ----------
    function post(payload) {
      return fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
        credentials: "omit"
      }).then(function (res) {
        if (res.status >= 500) throw new Error("server " + res.status);
        return res.json().catch(function () { return {}; }).then(function (body) {
          return { ok: res.status === 202, status: res.status, body: body };
        });
      });
    }

    function queuePending(payload) {
      var pending = load(PENDING_KEY, []);
      if (pending.some(function (p) { return p.payload.submission_id === payload.submission_id; })) return;
      pending.push({ payload: payload, tries: 0, endpoint: ENDPOINT });
      save(PENDING_KEY, pending);
    }

    var flushing = false;
    function flushPending() {
      if (flushing) return;
      var pending = load(PENDING_KEY, []).filter(function (p) { return p.endpoint === ENDPOINT; });
      if (!pending.length) return;
      flushing = true;
      var item = pending[0];
      // Turnstile tokens expire; the server re-checks, so retries may need a fresh one.
      // Any non-5xx answer (202, or a 4xx that will never succeed) clears the item; idempotency makes resends safe.
      post(item.payload).then(
        function () { removePending(item.payload.submission_id); flushing = false; flushPending(); },
        function () { bumpPending(item.payload.submission_id); flushing = false; }
      );
    }
    function removePending(id) {
      save(PENDING_KEY, load(PENDING_KEY, []).filter(function (p) { return p.payload.submission_id !== id; }));
    }
    function bumpPending(id) {
      var pending = load(PENDING_KEY, []);
      pending = pending.filter(function (p) {
        if (p.payload.submission_id !== id) return true;
        p.tries += 1;
        if (p.tries >= MAX_RETRIES) { console.warn("[sabhi] dropping lead after " + MAX_RETRIES + " retries", id); return false; }
        return true;
      });
      save(PENDING_KEY, pending);
    }

    function onSuccess(form) {
      var redirect = form.getAttribute("data-redirect");
      form.dispatchEvent(new CustomEvent("sabhi:lead-sent", { bubbles: true }));
      if (redirect) { location.href = redirect; return; }
      var thanks = form.querySelector("[data-lead-thanks]") || document.querySelector("[data-lead-thanks]");
      if (thanks) { thanks.hidden = false; thanks.style.display = ""; form.reset(); return; }
      form.reset();
    }

    function handleSubmit(event) {
      var form = event.target;
      if (!form || !form.hasAttribute || !form.hasAttribute("data-lead-form")) return;
      event.preventDefault();
      if (form.getAttribute("data-sending") === "1") return;
      if (form.checkValidity && !form.checkValidity()) { if (form.reportValidity) form.reportValidity(); return; }

      var buttons = form.querySelectorAll('button[type="submit"], button:not([type]), input[type="submit"]');
      function setBusy(busy) {
        form.setAttribute("data-sending", busy ? "1" : "0");
        Array.prototype.forEach.call(buttons, function (b) { b.disabled = busy; });
      }

      var payload = {
        submission_id: uuid(),
        turnstile_token: turnstileToken(form),
        fields: readFields(form),
        tracking: buildTracking(),
        consent: consentFor(form)
      };
      setBusy(true);
      post(payload)
        .then(function (result) {
          setBusy(false);
          if (result.ok) return onSuccess(form);
          form.dispatchEvent(new CustomEvent("sabhi:lead-error", { bubbles: true, detail: result }));
          console.warn("[sabhi] lead rejected", result.status, result.body);
        }, function () {
          // Network failure or 5xx: keep it locally and retry; let the visitor continue.
          queuePending(payload);
          setBusy(false);
          onSuccess(form);
        });
    }

    document.addEventListener("submit", handleSubmit, true);
    flushPending();
    setInterval(flushPending, RETRY_MS);
    window.addEventListener("online", flushPending);
  } catch (err) {
    try { console.warn("[sabhi] lead.js failed to start", err); } catch (e) { /* ignore */ }
  }
})();
