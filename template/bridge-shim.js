/**
 * bridge-shim.js — Lightweight bridge shim injected into JupyterLite
 *
 * This script runs INSIDE the JupyterLite iframe. It replaces the need for
 * a full federated JupyterLab extension by using JupyterLab's internal
 * app object (window.jupyterapp) to access:
 *   1. The ContentsManager (app.serviceManager.contents) for file I/O
 *   2. The notebook widget model for direct notebook access
 *   3. JupyterLab commands for save, run, clear operations
 *
 * IMPORTANT: JupyterLite's ServiceWorker does NOT handle /api/contents/
 * requests — it drops all /api/ fetches. JupyterLite uses /api/drive/
 * via BroadcastChannel internally. We must go through the JupyterLab
 * app's ContentsManager which knows how to use the correct backend.
 *
 * It handles:
 *   - getNotebook: reads notebook JSON from the active widget model
 *   - loadNotebook: writes notebook via ContentsManager + reloads
 *   - save: triggers docmanager:save command
 *   - getFiles: lists all files via ContentsManager
 *   - loadFiles: writes files via ContentsManager
 *   - getStatus: reports notebook status
 *   - runAll / clearOutputs: triggers JupyterLab commands
 */

(function () {
  'use strict';

  var NOTEBOOK_PATH = 'assignment.ipynb';
  var POLL_INTERVAL_MS = 1000;
  var _ready = false;
  var _app = null;
  var _contents = null;

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
  // JupyterLab App access helpers
  // -------------------------------------------------------------------

  /**
   * Get the notebook JSON from the active notebook widget's in-memory model.
   * This is the most reliable way — no ServiceWorker or API calls needed.
   */
  function getNotebookFromWidget() {
    if (!_app) return Promise.reject(new Error('App not ready'));

    // Try the current widget first
    var widget = _app.shell.currentWidget;
    if (widget && widget.content && widget.content.model) {
      try {
        var json = widget.content.model.toJSON();
        return Promise.resolve(json);
      } catch (e) {
        console.warn('[bridge-shim] currentWidget.toJSON failed:', e);
      }
    }

    // Fall back to ContentsManager
    return getNotebookFromContents();
  }

  /**
   * Get notebook via the ContentsManager (JupyterLab's internal file API).
   * This goes through JupyterLite's drive system, not raw HTTP.
   */
  function getNotebookFromContents() {
    if (!_contents) return Promise.reject(new Error('ContentsManager not ready'));

    return _contents.get(NOTEBOOK_PATH, { content: true }).then(function (model) {
      return model.content;
    });
  }

  /**
   * Save notebook JSON via the ContentsManager.
   */
  function saveNotebookViaContents(notebookJSON) {
    if (!_contents) return Promise.reject(new Error('ContentsManager not ready'));

    return _contents.save(NOTEBOOK_PATH, {
      type: 'notebook',
      format: 'json',
      content: notebookJSON
    });
  }

  /**
   * Get a file's content via the ContentsManager.
   */
  function getFileViaContents(filePath) {
    if (!_contents) return Promise.reject(new Error('ContentsManager not ready'));
    return _contents.get(filePath, { content: true });
  }

  /**
   * Save a file via the ContentsManager.
   */
  function saveFileViaContents(filePath, model) {
    if (!_contents) return Promise.reject(new Error('ContentsManager not ready'));
    return _contents.save(filePath, model);
  }

  /**
   * Recursively collect all files from the JupyterLite filesystem.
   * Skips the main notebook (handled separately) and hidden/system dirs.
   */
  function getAllFiles() {
    if (!_contents) return Promise.reject(new Error('ContentsManager not ready'));

    return _contents.get('', { content: true }).then(function (rootModel) {
      var items = rootModel.content || [];

      function processItems(itemList) {
        var promises = [];
        for (var i = 0; i < itemList.length; i++) {
          var item = itemList[i];
          // Skip system directories and the main notebook
          if (item.name === '.ipynb_checkpoints' || item.name === '.virtual_documents') continue;
          if (item.name === NOTEBOOK_PATH) continue;

          if (item.type === 'directory') {
            promises.push(
              _contents.get(item.path, { content: true }).then(function (dirModel) {
                return processItems(dirModel.content || []);
              }).catch(function () { return []; })
            );
          } else {
            promises.push(
              _contents.get(item.path, { content: true }).then(function (fileModel) {
                return {
                  path: fileModel.path,
                  name: fileModel.name,
                  type: fileModel.type,
                  format: fileModel.format,
                  content: fileModel.content,
                  mimetype: fileModel.mimetype
                };
              }).catch(function (err) {
                console.warn('[bridge-shim] Failed to read file:', item.path, err);
                return null;
              })
            );
          }
        }
        return Promise.all(promises).then(function (results) {
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
   * Restore files to the JupyterLite filesystem via ContentsManager.
   */
  function restoreFiles(files) {
    if (!_contents || !files || files.length === 0) return Promise.resolve([]);

    var promises = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      promises.push(
        saveFileViaContents(f.path, {
          type: f.type || 'file',
          format: f.format || 'text',
          content: f.content
        }).catch(function (err) {
          console.warn('[bridge-shim] Failed to restore file:', f.path, err);
          return null;
        })
      );
    }
    return Promise.all(promises);
  }

  // -------------------------------------------------------------------
  // Message handler
  // -------------------------------------------------------------------

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.type !== 'zest-jupyter') return;

    switch (msg.action) {
      case 'getNotebook':
        // First trigger save to flush any unsaved changes from the widget
        if (_app) {
          try { _app.commands.execute('docmanager:save'); } catch (e) { /* ok */ }
        }
        // Small delay to let save complete, then read the notebook
        setTimeout(function () {
          getNotebookFromWidget()
            .then(function (notebook) {
              sendToWrapper('notebookContent', {
                notebook: notebook,
                path: NOTEBOOK_PATH,
                cellCount: notebook && notebook.cells ? notebook.cells.length : 0,
                executionCount: countExecutions(notebook)
              }, msg.requestId);
            })
            .catch(function (err) {
              console.warn('[bridge-shim] getNotebook failed:', err);
              sendToWrapper('notebookContent', {
                notebook: null,
                error: err.message
              }, msg.requestId);
            });
        }, 300);
        break;

      case 'loadNotebook':
        var nb = msg.data && msg.data.notebook;
        if (!nb) {
          sendToWrapper('notebookLoaded', { success: false, error: 'No notebook data' }, msg.requestId);
          break;
        }
        saveNotebookViaContents(nb)
          .then(function () {
            sendToWrapper('notebookLoaded', { success: true }, msg.requestId);
            // Reload so JupyterLite picks up the new content
            setTimeout(function () { window.location.reload(); }, 500);
          })
          .catch(function (err) {
            sendToWrapper('notebookLoaded', { success: false, error: err.message }, msg.requestId);
          });
        break;

      case 'save':
        if (_app) {
          try { _app.commands.execute('docmanager:save'); } catch (e) { /* ok */ }
        }
        setTimeout(function () {
          getNotebookFromWidget()
            .then(function (notebook) {
              sendToWrapper('saved', { notebook: notebook, success: true }, msg.requestId);
            })
            .catch(function (err) {
              sendToWrapper('saved', { success: false, error: err.message }, msg.requestId);
            });
        }, 500);
        break;

      case 'getStatus':
        var nbWidget = _app ? _app.shell.currentWidget : null;
        var hasModel = !!(nbWidget && nbWidget.content && nbWidget.content.model);
        sendToWrapper('status', {
          hasNotebook: hasModel,
          isDirty: hasModel ? nbWidget.content.model.dirty : false,
          path: NOTEBOOK_PATH,
          shimMode: true,
          appReady: !!_app
        }, msg.requestId);
        break;

      case 'runAll':
        if (_app) {
          try { _app.commands.execute('notebook:run-all-cells'); } catch (e) { /* ok */ }
        }
        sendToWrapper('runAllComplete', { success: !!_app }, msg.requestId);
        break;

      case 'clearOutputs':
        if (_app) {
          try { _app.commands.execute('notebook:clear-all-cell-outputs'); } catch (e) { /* ok */ }
        }
        sendToWrapper('outputsCleared', { success: !!_app }, msg.requestId);
        break;

      case 'getFiles':
        getAllFiles()
          .then(function (files) {
            sendToWrapper('filesContent', { files: files, count: files.length }, msg.requestId);
          })
          .catch(function (err) {
            console.warn('[bridge-shim] getFiles failed:', err);
            sendToWrapper('filesContent', { files: [], error: err.message }, msg.requestId);
          });
        break;

      case 'loadFiles':
        var filesToLoad = msg.data && msg.data.files;
        if (!filesToLoad || filesToLoad.length === 0) {
          sendToWrapper('filesLoaded', { success: true, count: 0 }, msg.requestId);
          break;
        }
        restoreFiles(filesToLoad)
          .then(function () {
            sendToWrapper('filesLoaded', { success: true, count: filesToLoad.length }, msg.requestId);
          })
          .catch(function (err) {
            sendToWrapper('filesLoaded', { success: false, error: err.message }, msg.requestId);
          });
        break;
    }
  });

  // -------------------------------------------------------------------
  // Helper: count cell executions in a notebook
  // -------------------------------------------------------------------
  function countExecutions(notebook) {
    if (!notebook || !notebook.cells) return 0;
    var count = 0;
    for (var i = 0; i < notebook.cells.length; i++) {
      if (notebook.cells[i].execution_count) count++;
    }
    return count;
  }

  // -------------------------------------------------------------------
  // Wait for JupyterLab app, then signal ready
  // -------------------------------------------------------------------

  function checkReady() {
    // Look for the JupyterLab app object
    var app = window.jupyterapp || window._JUPYTERLAB;

    if (app && app.serviceManager && app.serviceManager.contents) {
      _app = app;
      _contents = app.serviceManager.contents;

      if (!_ready) {
        _ready = true;
        console.log('[bridge-shim] JupyterLab app captured, ContentsManager ready');

        // Also check if a notebook widget is available
        var widget = app.shell.currentWidget;
        var hasWidget = !!(widget && widget.content && widget.content.model);
        console.log('[bridge-shim] Notebook widget available:', hasWidget);

        sendToWrapper('ready', {
          version: '2.0.0-shim',
          capabilities: [
            'getNotebook',
            'loadNotebook',
            'save',
            'getStatus',
            'runAll',
            'clearOutputs',
            'getFiles',
            'loadFiles'
          ],
          hasWidget: hasWidget
        });
      }
      return;
    }

    // Not ready yet — retry
    setTimeout(checkReady, POLL_INTERVAL_MS);
  }

  // Start
  console.log('[bridge-shim] Zest bridge shim v2 loaded (app-based, no fetch)');
  setTimeout(checkReady, 2000); // Give JupyterLite time to initialize

})();
