/**
 * bridge-shim.js — Lightweight bridge shim injected into JupyterLite
 *
 * This script runs INSIDE the JupyterLite iframe. It replaces the need for
 * a full federated JupyterLab extension by using:
 *   1. The ServiceWorker contents API (fetch /api/contents/) to read/write notebooks
 *   2. postMessage to communicate with the wrapper page
 *
 * It handles:
 *   - getNotebook: reads the notebook JSON via the contents API
 *   - loadNotebook: writes notebook JSON via the contents API, then reloads
 *   - save: triggers the JupyterLab save command if available
 *   - getStatus: reports basic status
 *
 * It does NOT handle cell execution tracking or dirty state monitoring —
 * those require the full TypeScript extension. This is a pragmatic fallback
 * that makes the core save/submit flow work immediately.
 */

(function () {
  'use strict';

  var NOTEBOOK_PATH = 'assignment.ipynb';
  var POLL_INTERVAL_MS = 2000;
  var _ready = false;

  function sendToWrapper(action, data, requestId) {
    try {
      window.parent.postMessage({
        type: 'zest-jupyter',
        action: action,
        data: data || {},
        requestId: requestId
      }, '*');
    } catch (e) {
      console.warn('[bridge-shim] postMessage failed:', e);
    }
  }

  // -------------------------------------------------------------------
  // Contents API helpers (via ServiceWorker)
  // -------------------------------------------------------------------

  function getNotebookViaAPI() {
    return fetch('api/contents/' + NOTEBOOK_PATH + '?content=1')
      .then(function (res) {
        if (!res.ok) throw new Error('Contents API returned ' + res.status);
        return res.json();
      })
      .then(function (model) {
        return model.content; // nbformat JSON
      });
  }

  function saveNotebookViaAPI(notebookJSON) {
    return fetch('api/contents/' + NOTEBOOK_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'notebook',
        format: 'json',
        content: notebookJSON
      })
    }).then(function (res) {
      if (!res.ok) throw new Error('Contents API PUT returned ' + res.status);
      return res.json();
    });
  }

  // -------------------------------------------------------------------
  // Message handler
  // -------------------------------------------------------------------

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.type !== 'zest-jupyter') return;

    switch (msg.action) {
      case 'getNotebook':
        getNotebookViaAPI()
          .then(function (notebook) {
            sendToWrapper('notebookContent', {
              notebook: notebook,
              path: NOTEBOOK_PATH,
              cellCount: notebook && notebook.cells ? notebook.cells.length : 0,
              executionCount: 0
            }, msg.requestId);
          })
          .catch(function (err) {
            console.warn('[bridge-shim] getNotebook failed:', err);
            sendToWrapper('notebookContent', {
              notebook: null,
              error: err.message
            }, msg.requestId);
          });
        break;

      case 'loadNotebook':
        var nb = msg.data && msg.data.notebook;
        var filePath = (msg.data && msg.data.path) || NOTEBOOK_PATH;
        if (!nb) {
          sendToWrapper('notebookLoaded', { success: false, error: 'No notebook data' }, msg.requestId);
          break;
        }
        saveNotebookViaAPI(nb)
          .then(function () {
            sendToWrapper('notebookLoaded', { path: filePath, success: true }, msg.requestId);
            // Reload the page so JupyterLite picks up the new content
            setTimeout(function () { window.location.reload(); }, 500);
          })
          .catch(function (err) {
            sendToWrapper('notebookLoaded', { success: false, error: err.message }, msg.requestId);
          });
        break;

      case 'save':
        // Try JupyterLab save command, then read back via API
        try {
          // JupyterLab exposes commands on the app — try to trigger save
          if (window._jupyterLabApp) {
            window._jupyterLabApp.commands.execute('docmanager:save');
          }
        } catch (e) {
          // Ignore — we'll read whatever is in the contents store
        }
        // Small delay to let JupyterLab flush to ServiceWorker/IndexedDB
        setTimeout(function () {
          getNotebookViaAPI()
            .then(function (notebook) {
              sendToWrapper('saved', { notebook: notebook, success: true }, msg.requestId);
            })
            .catch(function (err) {
              sendToWrapper('saved', { success: false, error: err.message }, msg.requestId);
            });
        }, 500);
        break;

      case 'getStatus':
        sendToWrapper('status', {
          hasNotebook: true,
          isDirty: false,
          path: NOTEBOOK_PATH,
          cellCount: 0,
          executionCount: 0,
          kernelStatus: 'unknown',
          shimMode: true
        }, msg.requestId);
        break;

      case 'runAll':
        try {
          if (window._jupyterLabApp) {
            window._jupyterLabApp.commands.execute('notebook:run-all-cells');
          }
        } catch (e) { /* ignore */ }
        sendToWrapper('runAllComplete', { success: true }, msg.requestId);
        break;

      case 'clearOutputs':
        try {
          if (window._jupyterLabApp) {
            window._jupyterLabApp.commands.execute('notebook:clear-all-cell-outputs');
          }
        } catch (e) { /* ignore */ }
        sendToWrapper('outputsCleared', { success: true }, msg.requestId);
        break;
    }
  });

  // -------------------------------------------------------------------
  // Wait for ServiceWorker then signal ready
  // -------------------------------------------------------------------

  function checkReady() {
    // Try to hit the contents API — if it responds, ServiceWorker is active
    fetch('api/contents/' + NOTEBOOK_PATH)
      .then(function (res) {
        if (res.ok && !_ready) {
          _ready = true;
          console.log('[bridge-shim] ServiceWorker contents API ready');
          sendToWrapper('ready', {
            version: '1.0.0-shim',
            capabilities: [
              'getNotebook',
              'loadNotebook',
              'save',
              'getStatus',
              'runAll',
              'clearOutputs'
            ]
          });
        }
      })
      .catch(function () {
        // ServiceWorker not ready yet — retry
        setTimeout(checkReady, POLL_INTERVAL_MS);
      });
  }

  // Also try to capture the JupyterLab app reference
  function captureApp() {
    // JupyterLite exposes the app after initialization
    if (window.jupyterapp) {
      window._jupyterLabApp = window.jupyterapp;
      console.log('[bridge-shim] Captured JupyterLab app reference');
      return;
    }
    // Keep polling
    setTimeout(captureApp, 3000);
  }

  // Start
  console.log('[bridge-shim] Zest bridge shim loaded');
  setTimeout(checkReady, 1000);
  setTimeout(captureApp, 5000);

})();
