(() => {
  "use strict";

  const API_URL = "/api/state";
  const DEFAULT_INTERVAL_SECONDS = 30;
  let lastSavedJson = null;
  let saveIntervalSeconds = DEFAULT_INTERVAL_SECONDS;
  let dirty = false;
  let flushTimer = null;

  const snapshotLocalStorage = () => {
    const snapshot = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      snapshot[key] = localStorage.getItem(key);
    }
    return snapshot;
  };

  const snapshotJson = () => JSON.stringify(snapshotLocalStorage());

  const clearLocalStorage = () => {
    localStorage.clear();
  };

  const applyState = (data) => {
    clearLocalStorage();
    if (!data || typeof data !== "object") {
      return;
    }
    Object.keys(data).forEach((key) => {
      if (typeof data[key] === "string") {
        localStorage.setItem(key, data[key]);
      }
    });
  };

  const hasLocalKeys = () => localStorage.length > 0;

  const putState = (sync) => {
    const body = snapshotJson();
    if (body === lastSavedJson) {
      dirty = false;
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("PUT", API_URL, !sync);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        lastSavedJson = body;
        dirty = false;
      }
    };
    try {
      xhr.send(body);
      if (sync) {
        lastSavedJson = body;
        dirty = false;
      }
    } catch (err) {
      // Keep dirty so the next interval retry can succeed.
    }
  };

  const maybeSave = () => {
    const current = snapshotJson();
    if (current === lastSavedJson) {
      dirty = false;
      return;
    }
    dirty = true;
    putState(false);
  };

  const scheduleFlush = () => {
    if (flushTimer) {
      clearInterval(flushTimer);
    }
    flushTimer = setInterval(maybeSave, saveIntervalSeconds * 1000);
  };

  const flushOnLeave = () => {
    const current = snapshotJson();
    if (current === lastSavedJson) {
      return;
    }
    dirty = true;
    putState(true);
  };

  const loadState = () => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", API_URL, false);
    try {
      xhr.send(null);
    } catch (err) {
      return;
    }

    if (xhr.status < 200 || xhr.status >= 300) {
      return;
    }

    let response;
    try {
      response = JSON.parse(xhr.responseText);
    } catch (err) {
      return;
    }

    if (
      typeof response.saveIntervalInSeconds === "number" &&
      response.saveIntervalInSeconds >= 1
    ) {
      saveIntervalSeconds = Math.floor(response.saveIntervalInSeconds);
    }

    if (response.data && typeof response.data === "object") {
      applyState(response.data);
      lastSavedJson = snapshotJson();
      dirty = false;
      return;
    }

    if (hasLocalKeys()) {
      lastSavedJson = null;
      putState(true);
      return;
    }

    lastSavedJson = snapshotJson();
  };

  loadState();
  scheduleFlush();

  window.addEventListener("pagehide", flushOnLeave);
  window.addEventListener("beforeunload", flushOnLeave);
})();
