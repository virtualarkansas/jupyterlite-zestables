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

  // JupyterLite's ServiceWorker intercepts requests at the lite/ root level.
  // When this script runs inside lite/lab/index.html, relative fetches resolve
  // to lite/lab/api/... which the ServiceWorker doesn't intercept.
  // Use ../api/ to resolve to lite/api/ which IS in the ServiceWorker's scope.
  var API_BASE = '../api/contents/';

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
    return fetch(API_BASE + NOTEBOOK_PATH + '?content=1')
      .then(function (res) {
        if (!res.ok) throw new Error('Contents API returned ' + res.status);
        return res.json();
      })
      .then(function (model) {
        return model.content; // nbformat JSON
      });
  }

  function saveNotebookViaAPI(notebookJSON) {
    return fetch(API_BASE + NOTEBOOK_PATH, {
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

  /**
   * List all files in the JupyterLite filesystem root directory.
   * Returns an array of { name, path, type, size } objects.
   */
  function listFilesViaAPI(dirPath) {
    var url = API_BASE + (dirPath || '');
    return fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('Contents API list returned ' + res.status);
        return res.json();
      })
      .then(function (model) {
        // Directory listing returns { content: [...items...] }
        return model.content || [];
      });
  }

  /**
   * Get a single file's content via the contents API.
   * For notebooks: returns JSON. For text: returns string. For binary: returns base64.
   */
  function getFileViaAPI(filePath) {
    return fetch(API_BASE + filePath + '?content=1')
      .then(function (res) {
        if (!res.ok) throw new Error('Contents API GET returned ' + res.status);
        return res.json();
      });
  }

  /**
   * Write a file via the contents API.
   */
  function putFileViaAPI(filePath, fileModel) {
    return fetch(API_BASE + filePath, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fileModel)
    }).then(function (res) {
      if (!res.ok) throw new Error('Contents API PUT returned ' + res.status);
      return res.json();
    });
  }

  /**
   * Recursively collect all files (not directories) from the filesystem.
   * Skips the default assignment.ipynb since that's handled separately.
   * Returns array of file models with content.
   */
  function getAllFiles() {
    return listFilesViaAPI('').then(function (items) {
      var filePromises = [];

      function processItems(itemList) {
        var promises = [];
        for (var i = 0; i < itemList.length; i++) {
          var item = itemList[i];
          if (item.type === 'directory') {
            // Recursively list directory contents
            promises.push(
              listFilesViaAPI(item.path).then(function (subItems) {
                return processItems(subItems);
              })
            );
          } else if (item.name !== NOTEBOOK_PATH) {
            // Get file content (skip the main notebook — handled separately)
            promises.push(
              getFileViaAPI(item.path).then(function (model) {
                return {
                  path: model.path,
                  name: model.name,
                  type: model.type,
                  format: model.format,
                  content: model.content
                };
              }).catch(function (err) {
                console.warn('[bridge-shim] Failed to read file:', item.path, err);
                return null;
              })
            );
          }
        }
        return Promise.all(promises).then(function (results) {
          // Flatten nested arrays from directory recursion
          var flat = [];
          for (var j = 0; j < results.length; j++) {
            if (Array.isArray(results[j])) {
              flat = flat.concat(results[j]);
            } else if (results[j]) {
              flat.push(results[j]);
            }
          }
          return flat;
        });
      }

      return processItems(items);
    });
  }

  /**
   * Restore files to the JupyterLite filesystem.
   * Creates directories as needed and writes each file.
   */
  function restoreFiles(files) {
    if (!files || files.length === 0) return Promise.resolve([]);

    var promises = [];
    // Ensure directories exist first
    var dirs = {};
    for (var i = 0; i < files.length; i++) {
      var parts = files[i].path.split('/');
      if (parts.length > 1) {
        var dir = parts.slice(0, -1).join('/');
        if (!dirs[dir]) {
          dirs[dir] = true;
          promises.push(
            fetch(API_BASE + dir, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: 'directory' })
            }).catch(function () { /* directory may already exist */ })
          );
        }
      }
    }

    return Promise.all(promises).then(function () {
      var filePromises = [];
      for (var j = 0; j < files.length; j++) {
        var f = files[j];
        filePromises.push(
          putFileViaAPI(f.path, {
            type: f.type || 'file',
            format: f.format || 'text',
            content: f.content
          }).catch(function (err) {
            console.warn('[bridge-shim] Failed to restore file:', f.path, err);
            return null;
          })
        );
      }
      return Promise.all(filePromises);
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

      case 'getFiles':
        // Get all user files (excluding the main notebook)
        getAllFiles()
          .then(function (files) {
            sendToWrapper('filesContent', {
              files: files,
              count: files.length
            }, msg.requestId);
          })
          .catch(function (err) {
            console.warn('[bridge-shim] getFiles failed:', err);
            sendToWrapper('filesContent', {
              files: [],
              error: err.message
            }, msg.requestId);
          });
        break;

      case 'loadFiles':
        // Restore files to the filesystem
        var filesToLoad = msg.data && msg.data.files;
        if (!filesToLoad || filesToLoad.length === 0) {
          sendToWrapper('filesLoaded', { success: true, count: 0 }, msg.requestId);
          break;
        }
        restoreFiles(filesToLoad)
          .then(function (results) {
            sendToWrapper('filesLoaded', {
              success: true,
              count: filesToLoad.length
            }, msg.requestId);
          })
          .catch(function (err) {
            sendToWrapper('filesLoaded', { success: false, error: err.message }, msg.requestId);
          });
        break;
    }
  });

  // -------------------------------------------------------------------
  // Wait for ServiceWorker then signal ready
  // -------------------------------------------------------------------

  function checkReady() {
    // Try to hit the contents API — if it responds, ServiceWorker is active
    fetch(API_BASE + NOTEBOOK_PATH)
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
              'clearOutputs',
              'getFiles',
              'loadFiles'
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
