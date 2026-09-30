(() => {
  "use strict";

  const API_URL = "/api/state";
  const DEFAULT_INTERVAL_SECONDS = 30;

  let lastSavedJson = null;
  let saveIntervalSeconds = DEFAULT_INTERVAL_SECONDS;
  let flushTimer = null;
  let leaveSnapshotSent = null;
  let lastRevision = 0;
  let inFlight = null;

  const snapshotLocalStorage = () => {
    const snapshot = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null) {
        continue;
      }
      snapshot[key] = localStorage.getItem(key);
    }
    return snapshot;
  };

  const snapshotJson = () => JSON.stringify(snapshotLocalStorage());

  const applyState = (data) => {
    localStorage.clear();
    if (!data || typeof data !== "object") {
      return;
    }
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string") {
        localStorage.setItem(key, value);
      }
    }
  };

  const rememberSaved = (body) => {
    lastSavedJson = body;
    leaveSnapshotSent = body;
  };

  const httpOk = (status) => status >= 200 && status < 300;

  const allocateRevision = () => {
    lastRevision += 1;
    return lastRevision;
  };

  const stateUrl = (revision) => `${API_URL}?rev=${revision}`;

  const saveNow = () => {
    const body = snapshotJson();
    if (body === lastSavedJson && !inFlight) {
      return;
    }

    if (inFlight) {
      const xhr = inFlight;
      inFlight = null;
      xhr.abort();
    }

    const xhr = new XMLHttpRequest();
    xhr.open("PUT", stateUrl(allocateRevision()), false);
    xhr.setRequestHeader("Content-Type", "application/json");
    try {
      xhr.send(body);
    } catch (err) {
      return;
    }

    if (httpOk(xhr.status)) {
      rememberSaved(body);
    }
  };

  const saveSoon = () => {
    const body = snapshotJson();
    if (body === lastSavedJson || inFlight) {
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("PUT", stateUrl(allocateRevision()), true);
    xhr.setRequestHeader("Content-Type", "application/json");
    inFlight = xhr;

    const finish = () => {
      if (inFlight !== xhr) {
        return;
      }
      inFlight = null;
      if (httpOk(xhr.status) && snapshotJson() === body) {
        rememberSaved(body);
        return;
      }
      if (httpOk(xhr.status)) {
        saveSoon();
      }
    };

    xhr.timeout = 10000;
    xhr.onload = finish;
    xhr.onerror = finish;
    xhr.ontimeout = finish;
    xhr.onabort = finish;
    try {
      xhr.send(body);
    } catch (err) {
      inFlight = null;
    }
  };

  const saveOnLeave = () => {
    const body = snapshotJson();
    if (body === lastSavedJson || body === leaveSnapshotSent) {
      return;
    }

    if (inFlight) {
      const xhr = inFlight;
      inFlight = null;
      xhr.abort();
    }

    const url = stateUrl(allocateRevision());
    const blob = new Blob([body], { type: "application/json" });
    if (
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(url, blob)
    ) {
      leaveSnapshotSent = body;
      return;
    }

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
    leaveSnapshotSent = body;
  };

  const readSaveInterval = (response) => {
    if (
      typeof response.saveIntervalInSeconds === "number" &&
      response.saveIntervalInSeconds >= 1
    ) {
      saveIntervalSeconds = Math.floor(response.saveIntervalInSeconds);
    }
  };

  const loadState = () => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", API_URL, false);
    try {
      xhr.send(null);
    } catch (err) {
      return;
    }

    if (!httpOk(xhr.status)) {
      return;
    }

    let response;
    try {
      response = JSON.parse(xhr.responseText);
    } catch (err) {
      return;
    }

    readSaveInterval(response);
    if (Number.isInteger(response.revision) && response.revision >= 0) {
      lastRevision = response.revision;
    }

    const localBody = snapshotJson();
    if (response.data && typeof response.data === "object" && !Array.isArray(response.data)) {
      if (localStorage.length > 0 && localBody !== JSON.stringify(response.data)) {
        lastSavedJson = null;
        saveNow();
        return;
      }
      applyState(response.data);
      rememberSaved(snapshotJson());
      return;
    }

    if (localStorage.length > 0) {
      lastSavedJson = null;
      saveNow();
      return;
    }

    rememberSaved(snapshotJson());
  };

  const scheduleFlush = () => {
    if (flushTimer) {
      clearInterval(flushTimer);
    }
    flushTimer = setInterval(saveSoon, saveIntervalSeconds * 1000);
  };

  const isSameDocumentHashChange = (url) =>
    url.pathname === window.location.pathname &&
    url.search === window.location.search &&
    url.hash !== window.location.hash;

  const installNavigationFlush = () => {
    const patch = (name) => {
      const original = Location.prototype[name];
      if (typeof original !== "function") {
        return;
      }
      try {
        Location.prototype[name] = function (...args) {
          saveNow();
          return original.apply(this, args);
        };
      } catch (err) {}
    };

    patch("reload");
    patch("assign");
    patch("replace");

    document.addEventListener(
      "click",
      (event) => {
        if (event.defaultPrevented || event.button !== 0) {
          return;
        }
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        const target = event.target;
        if (!target || typeof target.closest !== "function") {
          return;
        }
        const link = target.closest("a[href]");
        if (!link || link.target === "_blank" || link.hasAttribute("download")) {
          return;
        }
        let url;
        try {
          url = new URL(link.href, window.location.href);
        } catch (err) {
          return;
        }
        if (url.origin !== window.location.origin || isSameDocumentHashChange(url)) {
          return;
        }
        saveNow();
      },
      true
    );
  };

  loadState();
  scheduleFlush();
  installNavigationFlush();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      saveOnLeave();
    }
  });
  window.addEventListener("pagehide", saveOnLeave);
})();
