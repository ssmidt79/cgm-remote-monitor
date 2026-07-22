'use strict';

// Diabetesudstyr Lager — client-only supply-cycle tracker.
// State lives entirely in localStorage; nothing is sent to the Nightscout server.
(function () {

  var DAY_MS = 86400000;
  var STORAGE_KEY = 'diabetes-inventory-v1';
  var MIN_THRESHOLD = 2;
  var ALLOW_SCHEDULED_START = true;
  var REFRESH_MS = 15000;

  var DEFAULTS = [
    { id: 'insulin', name: 'Insulin', icon: 'insulin', fullStock: 7, maxStock: 70, cycleDays: 13 },
    { id: 'sensor', name: 'Sensor', icon: 'sensor', fullStock: 10, maxStock: 70, cycleDays: 7 },
    { id: 'infusion', name: 'Infusion set', icon: 'infusion', fullStock: 20, maxStock: 70, cycleDays: 7 },
    { id: 'syringe', name: 'Sprøjter', icon: 'syringe', fullStock: 30, maxStock: 70, cycleDays: 3.5 }
  ];

  var state = { products: [] };
  var listEl, todayEl, startAllBtn, stopAllBtn, intervalId;

  function todayISO () {
    return new Date().toISOString().slice(0, 10);
  }

  function esc (value) {
    var div = document.createElement('div');
    div.textContent = String(value);
    return div.innerHTML;
  }

  function computeElapsedMs (p, now) {
    if (!p.running || !p.lastResumeAt) { return p.accumulatedMs; }
    return p.accumulatedMs + Math.max(0, now - new Date(p.lastResumeAt).getTime());
  }

  function tickProduct (p, now) {
    if (!p.running) { return p; }
    if (p.lastResumeAt && new Date(p.lastResumeAt).getTime() > now) { return p; }
    var cycleMs = p.cycleDays * DAY_MS;
    var elapsed = computeElapsedMs(p, now);
    var stock = p.stock;
    while (elapsed >= cycleMs && stock > 0) {
      stock -= 1;
      elapsed -= cycleMs;
    }
    if (stock <= 0) {
      return Object.assign({}, p, { stock: 0, accumulatedMs: 0, lastResumeAt: null });
    }
    return Object.assign({}, p, { stock: stock, accumulatedMs: elapsed, lastResumeAt: new Date(now).toISOString() });
  }

  function startProduct (p, now) {
    var scheduled = p.scheduledDate ? new Date(p.scheduledDate + 'T00:00:00').getTime() : now;
    var resumeAt = scheduled > now ? scheduled : now;
    return Object.assign({}, p, { running: true, lastResumeAt: new Date(resumeAt).toISOString() });
  }

  function stopProduct (p, now) {
    var elapsed = computeElapsedMs(p, now);
    return Object.assign({}, p, { accumulatedMs: elapsed, lastResumeAt: null, running: false });
  }

  function persist () {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.products));
    } catch (e) {
      console.error('lager: unable to persist inventory', e);
    }
  }

  function load () {
    var saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (e) {
      saved = null;
    }
    var now = Date.now();
    var products = DEFAULTS.map(function (d) {
      var s = saved && saved.filter(function (x) { return x.id === d.id; })[0];
      var runtime = {
        stock: d.fullStock,
        accumulatedMs: 0,
        lastResumeAt: null,
        running: false,
        scheduledDate: ''
      };
      if (s) {
        runtime = {
          stock: s.stock, accumulatedMs: s.accumulatedMs, lastResumeAt: s.lastResumeAt,
          running: s.running, scheduledDate: s.scheduledDate || ''
        };
      }
      return Object.assign({}, d, runtime);
    });
    state.products = products.map(function (p) { return tickProduct(p, now); });
    persist();
  }

  function update (id, fn) {
    var now = Date.now();
    state.products = state.products.map(function (p) {
      var ticked = tickProduct(p, now);
      return p.id === id ? tickProduct(fn(ticked, now), now) : ticked;
    });
    persist();
    render();
  }

  function startAll () {
    var now = Date.now();
    state.products = state.products.map(function (p) { return tickProduct(startProduct(p, now), now); });
    persist();
    render();
  }

  function stopAll () {
    var now = Date.now();
    state.products = state.products.map(function (p) { return tickProduct(stopProduct(p, now), now); });
    persist();
    render();
  }

  function refresh () {
    var now = Date.now();
    state.products = state.products.map(function (p) { return tickProduct(p, now); });
    persist();
    render();
  }

  function computeView (p, now) {
    var cycleMs = p.cycleDays * DAY_MS;
    var isEmpty = p.stock <= 0;
    var isLow = !isEmpty && p.stock <= MIN_THRESHOLD;
    var notYetStarted = p.running && p.lastResumeAt && new Date(p.lastResumeAt).getTime() > now;

    var statusText;
    if (isEmpty) {
      statusText = 'Tomt – kræver genopfyldning';
    } else if (!p.running) {
      statusText = p.accumulatedMs > 0 ? 'Sat på pause' : 'Ikke startet';
    } else if (notYetStarted) {
      var daysUntil = Math.ceil((new Date(p.lastResumeAt).getTime() - now) / DAY_MS);
      statusText = 'Starter om ' + daysUntil + (daysUntil === 1 ? ' dag' : ' dage');
    } else {
      var elapsed = computeElapsedMs(p, now);
      var daysLeft = Math.max(0, Math.ceil((cycleMs - elapsed) / DAY_MS));
      statusText = daysLeft <= 0 ? 'Skiftes i dag' : daysLeft + (daysLeft === 1 ? ' dag til næste træk' : ' dage til næste træk');
    }

    var circumference = 2 * Math.PI * 25;
    var circleLabel, circleProgress;
    if (isEmpty) {
      circleLabel = '0d';
      circleProgress = 1;
    } else if (!p.running) {
      circleLabel = '–';
      circleProgress = Math.min(1, p.accumulatedMs / cycleMs);
    } else if (notYetStarted) {
      var du = Math.ceil((new Date(p.lastResumeAt).getTime() - now) / DAY_MS);
      circleLabel = du + 'd';
      circleProgress = 0;
    } else {
      var elapsed2 = computeElapsedMs(p, now);
      var daysLeft2 = Math.max(0, Math.ceil((cycleMs - elapsed2) / DAY_MS));
      circleLabel = daysLeft2 + 'd';
      circleProgress = Math.min(1, elapsed2 / cycleMs);
    }
    var minVisible = (circleProgress > 0 || !isEmpty) ? 0.03 : 0;
    var circleDashOffset = circumference * (1 - Math.max(circleProgress, minVisible));

    var countdownText = '';
    if (p.running && !isEmpty && !notYetStarted) {
      var elapsed3 = computeElapsedMs(p, now);
      var remainMs = Math.max(0, cycleMs - elapsed3);
      var totalMin = Math.ceil(remainMs / 60000);
      var d3 = Math.floor(totalMin / 1440);
      var h3 = Math.floor((totalMin % 1440) / 60);
      var m3 = totalMin % 60;
      var parts = [];
      if (d3) { parts.push(d3 + 'd'); }
      if (d3 || h3) { parts.push(h3 + 't'); }
      parts.push(m3 + 'm');
      countdownText = parts.join(' ');
    }

    return {
      isEmpty: isEmpty,
      isLow: isLow,
      running: p.running,
      countdownText: countdownText,
      cycleLabel: (p.icon === 'insulin' ? 'Tømmes hver ' : 'Skiftes hver ') + p.cycleDays + '. dag',
      statusText: statusText,
      circleLabel: circleLabel,
      circumference: circumference,
      circleDashOffset: circleDashOffset,
      toggleLabel: p.running ? 'Stop' : 'Start',
      toggleBtnClass: p.running ? 'btn-secondary' : 'btn-primary',
      showDateInput: ALLOW_SCHEDULED_START && !p.running,
      scheduledDate: p.scheduledDate || ''
    };
  }

  function cardHTML (p, view) {
    var dot = view.running
      ? '<span class="lager-dot-wrap"><span class="lager-dot lager-dot-pulse"></span><span class="lager-dot"></span></span>'
      : '';
    var countdown = view.running
      ? '<div class="lager-countdown">' + esc(view.countdownText) + '</div>'
      : '';
    var tag = '';
    if (view.isEmpty) {
      tag = '<span class="tag tag-accent">Tomt</span>';
    } else if (view.isLow) {
      tag = '<span class="tag tag-accent">Lav beholdning</span>';
    }
    var dashoffset = view.circleDashOffset.toFixed(2);
    var circumference = view.circumference.toFixed(2);
    var dateInput = view.showDateInput
      ? '<input type="date" class="lager-date-input" data-id="' + esc(p.id) + '" value="' + esc(view.scheduledDate) +
        '" min="' + esc(todayISO()) + '" aria-label="Planlagt startdato for ' + esc(p.name) + '">'
      : '';

    return '' +
      '<div class="card lager-card" data-id="' + esc(p.id) + '">' +
        '<div class="lager-card-top">' +
          '<div class="lager-kicker">' + dot + '<span>' + esc(view.cycleLabel) + '</span></div>' +
          countdown +
        '</div>' +
        '<div class="lager-title">' +
          '<span class="lager-name">' + esc(p.name) + '</span>' + tag +
        '</div>' +
        '<div class="lager-stock-row">' +
          '<div class="lager-stock">' + p.stock + '</div>' +
        '</div>' +
        '<div class="lager-controls-row">' +
          '<div class="lager-ring">' +
            '<svg width="56" height="56" viewBox="0 0 56 56">' +
              '<circle cx="28" cy="28" r="25" fill="none" stroke="var(--lager-divider)" stroke-width="2"></circle>' +
              '<circle cx="28" cy="28" r="25" fill="none" stroke="var(--lager-accent)" stroke-width="2" stroke-linecap="round" transform="rotate(-90 28 28)" ' +
                'style="stroke-dasharray:' + circumference + ';stroke-dashoffset:' + dashoffset + '"></circle>' +
            '</svg>' +
            '<div class="lager-ring-label">' + esc(view.circleLabel) + '</div>' +
          '</div>' +
          '<div class="lager-stepper">' +
            '<button type="button" class="btn btn-ghost btn-icon lager-round-btn" data-action="decrement" aria-label="Fjern en ' + esc(p.name) + '">−</button>' +
            '<button type="button" class="btn btn-ghost btn-icon lager-round-btn" data-action="increment" aria-label="Tilføj en ' + esc(p.name) + '">+</button>' +
          '</div>' +
        '</div>' +
        '<div class="lager-status-row">' +
          '<div class="lager-status-text">' + esc(view.statusText) + '</div>' +
          '<div class="lager-status-actions">' +
            dateInput +
            '<button type="button" class="btn btn-sm ' + view.toggleBtnClass + '" data-action="toggle">' + esc(view.toggleLabel) + '</button>' +
            '<button type="button" class="btn btn-ghost btn-sm" data-action="refill">Genopfyld</button>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function render () {
    var now = Date.now();
    listEl.innerHTML = state.products.map(function (p) {
      return cardHTML(p, computeView(p, now));
    }).join('');
    if (todayEl) {
      todayEl.textContent = new Date().toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    }
  }

  function onListClick (e) {
    var btn = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!btn || !listEl.contains(btn)) { return; }
    var card = btn.closest('[data-id]');
    if (!card) { return; }
    var id = card.getAttribute('data-id');
    var action = btn.getAttribute('data-action');

    if (action === 'increment') {
      update(id, function (cur) {
        var stock = Math.min(cur.maxStock || cur.fullStock, cur.stock + 1);
        if (cur.stock <= 0 && stock > 0 && cur.running) {
          return Object.assign({}, cur, { stock: stock, accumulatedMs: 0, lastResumeAt: new Date().toISOString() });
        }
        return Object.assign({}, cur, { stock: stock });
      });
    } else if (action === 'decrement') {
      update(id, function (cur) {
        return Object.assign({}, cur, { stock: Math.max(0, cur.stock - 1) });
      });
    } else if (action === 'toggle') {
      update(id, function (cur, now) {
        return cur.running ? stopProduct(cur, now) : startProduct(cur, now);
      });
    } else if (action === 'refill') {
      update(id, function (cur) {
        return Object.assign({}, cur, {
          stock: cur.fullStock,
          accumulatedMs: 0,
          lastResumeAt: cur.running ? new Date().toISOString() : null
        });
      });
    }
  }

  function onListChange (e) {
    if (!e.target.classList || !e.target.classList.contains('lager-date-input')) { return; }
    var id = e.target.getAttribute('data-id');
    var value = e.target.value;
    update(id, function (cur) {
      return Object.assign({}, cur, { scheduledDate: value });
    });
  }

  function init () {
    listEl = document.getElementById('lager-list');
    todayEl = document.getElementById('lager-today');
    startAllBtn = document.getElementById('lager-start-all');
    stopAllBtn = document.getElementById('lager-stop-all');
    if (!listEl) { return; }

    load();
    render();

    listEl.addEventListener('click', onListClick);
    listEl.addEventListener('change', onListChange);
    if (startAllBtn) { startAllBtn.addEventListener('click', startAll); }
    if (stopAllBtn) { stopAllBtn.addEventListener('click', stopAll); }

    intervalId = setInterval(refresh, REFRESH_MS);
    window.addEventListener('beforeunload', function () {
      clearInterval(intervalId);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
