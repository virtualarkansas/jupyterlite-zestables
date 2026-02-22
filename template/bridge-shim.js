/**
 * bridge-shim.js v3.1 — Direct IndexedDB bridge for JupyterLite
 *
 * This script runs INSIDE the JupyterLite iframe. It reads/writes notebook
 * and file content directly from JupyterLite's IndexedDB storage, completely
 * bypassing both the ServiceWorker (which drops /api/ requests) and the
 * JupyterLab app object (which isn't exposed globally).
 *
 * JupyterLite stores files via localforage in IndexedDB:
 *   - Database name: "JupyterLite Storage" (with possible suffix)
 *   - Object store: "files"
 *   - Keys: file paths (e.g., "assignment.ipynb")
 *   - Values: IModel objects with { name, path, type, format, content, ... }
 *
 * CRITICAL: We must NOT keep the IndexedDB connection open persistently.
 * localforage creates multiple object stores (files, counters, checkpoints)
 * by incrementally upgrading the database version. A persistent connection
 * blocks these upgrades via the versionchange event, which would break
 * JupyterLite's file operations (including drag-and-drop upload).
 * Instead, we open → operate → close for each operation.
 *
 * To trigger saves (flush in-memory model to IndexedDB), we dispatch
 * Ctrl+S keyboard events which JupyterLab's shortcut system handles.
 */

(function () {
  'use strict';

  var NOTEBOOK_PATH = 'assignment.ipynb';
  var _ready = false;
  var _dbName = null;     // Discovered database name
  var FILES_STORE = 'files';

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
  // IndexedDB helpers — open/close per operation to avoid blocking
  // localforage's database upgrades
  // -------------------------------------------------------------------

  /**
   * Discover the JupyterLite IndexedDB database name.
   * Uses indexedDB.databases() to find it dynamically.
   */
  function discoverDatabaseName() {
    return new Promise(function (resolve, reject) {
      if (_dbName) {
        resolve(_dbName);
        return;
      }

      if (!window.indexedDB || !window.indexedDB.databases) {
        // Can't enumerate — try known names
        tryOpenWithFilesStore('JupyterLite Storage')
          .then(function (name) { _dbName = name; resolve(name); })
          .catch(function () {
            reject(new Error('Cannot discover database name'));
          });
        return;
      }

      window.indexedDB.databases().then(function (databases) {
        var candidates = [];
        for (var i = 0; i < databases.length; i++) {
          var name = databases[i].name;
          if (name && name.indexOf('JupyterLite Storage') !== -1) {
            candidates.push(name);
          }
        }

        if (candidates.length === 0) {
          reject(new Error('No JupyterLite Storage database found'));
          return;
        }

        console.log('[bridge-shim] Found candidate DBs:', candidates);

        // Try each candidate to find one with the 'files' store
        function tryNext(idx) {
          if (idx >= candidates.length) {
            reject(new Error('No DB with files store found'));
            return;
          }
          tryOpenWithFilesStore(candidates[idx])
            .then(function (name) { _dbName = name; resolve(name); })
            .catch(function () { tryNext(idx + 1); });
        }
        tryNext(0);
      }).catch(function () {
        reject(new Error('indexedDB.databases() failed'));
      });
    });
  }

  /**
   * Try to open a database and check if it has the 'files' store.
   * ALWAYS closes the connection after checking.
   */
  function tryOpenWithFilesStore(name) {
    return new Promise(function (resolve, reject) {
      try {
        var request = window.indexedDB.open(name);
        request.onerror = function () { reject(); };
        request.onupgradeneeded = function (event) {
          // DB doesn't exist — abort creation
          event.target.transaction.abort();
          reject();
        };
        request.onsuccess = function (event) {
          var db = event.target.result;
          var hasStore = db.objectStoreNames.contains(FILES_STORE);
          db.close(); // ALWAYS close immediately
          if (hasStore) {
            resolve(name);
          } else {
            reject();
          }
        };
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Open the database, run a callback with it, then close.
   * This prevents blocking localforage's database version upgrades.
   */
  function withDB(callback) {
    return discoverDatabaseName().then(function (name) {
      return new Promise(function (resolve, reject) {
        var request = window.indexedDB.open(name);
        request.onerror = function () {
          reject(new Error('Failed to open DB: ' + name));
        };
        request.onupgradeneeded = function (event) {
          event.target.transaction.abort();
          reject(new Error('DB upgrade needed — localforage may be initializing'));
        };
        request.onsuccess = function (event) {
          var db = event.target.result;

          // Handle versionchange: close immediately so localforage can upgrade
          db.onversionchange = function () {
            console.log('[bridge-shim] versionchange event — closing DB connection');
            db.close();
          };

          try {
            var result = callback(db);
            if (result && typeof result.then === 'function') {
              result.then(function (val) {
                db.close();
                resolve(val);
              }).catch(function (err) {
                db.close();
                reject(err);
              });
            } else {
              db.close();
              resolve(result);
            }
          } catch (e) {
            db.close();
            reject(e);
          }
        };
      });
    });
  }

  /**
   * Run a transaction-based operation: open DB, create transaction, run op, close.
   */
  function withTransaction(mode, operation) {
    return withDB(function (db) {
      return new Promise(function (resolve, reject) {
        if (!db.objectStoreNames.contains(FILES_STORE)) {
          reject(new Error('No files store in database'));
          return;
        }
        var tx = db.transaction(FILES_STORE, mode);
        var store = tx.objectStore(FILES_STORE);
        operation(store, resolve, reject);
      });
    });
  }

  /**
   * Read a single item from the files store.
   */
  function readItem(path) {
    return withTransaction('readonly', function (store, resolve, reject) {
      var request = store.get(path);
      request.onsuccess = function () { resolve(request.result || null); };
      request.onerror = function () { reject(new Error('Failed to read: ' + path)); };
    });
  }

  /**
   * Write a single item to the files store.
   */
  function writeItem(path, model) {
    return withTransaction('readwrite', function (store, resolve, reject) {
      var request = store.put(model, path);
      request.onsuccess = function () { resolve(); };
      request.onerror = function () { reject(new Error('Failed to write: ' + path)); };
    });
  }

  /**
   * Get all keys from the files store.
   */
  function getAllKeys() {
    return withTransaction('readonly', function (store, resolve, reject) {
      var request = store.getAllKeys();
      request.onsuccess = function () { resolve(request.result || []); };
      request.onerror = function () { reject(new Error('Failed to get keys')); };
    });
  }

  /**
   * Get all items from the files store via cursor.
   */
  function getAllItems() {
    return withTransaction('readonly', function (store, resolve, reject) {
      var items = [];
      var cursorRequest = store.openCursor();
      cursorRequest.onsuccess = function (event) {
        var cursor = event.target.result;
        if (cursor) {
          items.push({ key: cursor.key, value: cursor.value });
          cursor.continue();
        } else {
          resolve(items);
        }
      };
      cursorRequest.onerror = function () {
        reject(new Error('Failed to iterate files'));
      };
    });
  }

  // -------------------------------------------------------------------
  // Keyboard shortcut helpers (for triggering JupyterLab commands)
  // -------------------------------------------------------------------

  /**
   * Dispatch a Ctrl+S keyboard event to trigger JupyterLab save.
   */
  function triggerSave() {
    try {
      var event = new KeyboardEvent('keydown', {
        key: 's',
        code: 'KeyS',
        keyCode: 83,
        which: 83,
        ctrlKey: true,
        metaKey: false,
        bubbles: true,
        cancelable: true
      });
      document.dispatchEvent(event);
      console.log('[bridge-shim] Dispatched Ctrl+S save event');
    } catch (e) {
      console.warn('[bridge-shim] Failed to dispatch save event:', e);
    }
  }

  // -------------------------------------------------------------------
  // Notebook and file operations via IndexedDB
  // -------------------------------------------------------------------

  function getNotebookFromDB() {
    return readItem(NOTEBOOK_PATH).then(function (model) {
      if (!model) {
        console.warn('[bridge-shim] No notebook found in IndexedDB at key:', NOTEBOOK_PATH);
        return null;
      }
      console.log('[bridge-shim] Read notebook from IndexedDB, type:', model.type, 'format:', model.format);
      return model.content || null;
    });
  }

  function saveNotebookToDB(notebookJSON) {
    var now = new Date().toISOString();
    var model = {
      name: NOTEBOOK_PATH,
      path: NOTEBOOK_PATH,
      last_modified: now,
      created: now,
      format: 'json',
      mimetype: 'application/json',
      content: notebookJSON,
      size: JSON.stringify(notebookJSON).length,
      writable: true,
      type: 'notebook'
    };
    return writeItem(NOTEBOOK_PATH, model);
  }

  function getAllFilesFromDB() {
    return getAllItems().then(function (items) {
      var files = [];
      for (var i = 0; i < items.length; i++) {
        var key = items[i].key;
        var model = items[i].value;
        if (key === NOTEBOOK_PATH) continue;
        if (model && model.type === 'directory') continue;
        if (key.indexOf('.ipynb_checkpoints') !== -1) continue;
        if (key.indexOf('.virtual_documents') !== -1) continue;

        if (model && model.content !== null && model.content !== undefined) {
          files.push({
            path: model.path || key,
            name: model.name || key.split('/').pop(),
            type: model.type || 'file',
            format: model.format || 'text',
            content: model.content,
            mimetype: model.mimetype || ''
          });
        }
      }
      console.log('[bridge-shim] Found', files.length, 'files in IndexedDB');
      return files;
    });
  }

  function restoreFilesToDB(files) {
    if (!files || files.length === 0) return Promise.resolve([]);

    // Sequential writes to avoid multiple concurrent DB opens
    var chain = Promise.resolve();
    for (var i = 0; i < files.length; i++) {
      (function (f) {
        var now = new Date().toISOString();

        // Create parent directories first
        var parts = f.path.split('/');
        if (parts.length > 1) {
          for (var d = 1; d < parts.length; d++) {
            (function (dirPath, dirName) {
              chain = chain.then(function () {
                return writeItem(dirPath, {
                  name: dirName,
                  path: dirPath,
                  last_modified: now,
                  created: now,
                  format: 'json',
                  mimetype: '',
                  content: null,
                  size: 0,
                  writable: true,
                  type: 'directory'
                });
              });
            })(parts.slice(0, d).join('/'), parts[d - 1]);
          }
        }

        // Write the file
        chain = chain.then(function () {
          return writeItem(f.path, {
            name: f.name || f.path.split('/').pop(),
            path: f.path,
            last_modified: now,
            created: now,
            format: f.format || 'text',
            mimetype: f.mimetype || '',
            content: f.content,
            size: typeof f.content === 'string' ? f.content.length : JSON.stringify(f.content).length,
            writable: true,
            type: f.type || 'file'
          });
        });
      })(files[i]);
    }
    return chain;
  }

  // -------------------------------------------------------------------
  // Message handler
  // -------------------------------------------------------------------

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.type !== 'zest-jupyter') return;

    console.log('[bridge-shim] Received message:', msg.action);

    switch (msg.action) {
      case 'getNotebook':
        triggerSave();
        setTimeout(function () {
          getNotebookFromDB()
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
        }, 1500);
        break;

      case 'loadNotebook':
        var nb = msg.data && msg.data.notebook;
        if (!nb) {
          sendToWrapper('notebookLoaded', { success: false, error: 'No notebook data' }, msg.requestId);
          break;
        }
        saveNotebookToDB(nb)
          .then(function () {
            console.log('[bridge-shim] Notebook written to IndexedDB, reloading...');
            sendToWrapper('notebookLoaded', { success: true }, msg.requestId);
            setTimeout(function () { window.location.reload(); }, 500);
          })
          .catch(function (err) {
            sendToWrapper('notebookLoaded', { success: false, error: err.message }, msg.requestId);
          });
        break;

      case 'save':
        triggerSave();
        setTimeout(function () {
          getNotebookFromDB()
            .then(function (notebook) {
              sendToWrapper('saved', { notebook: notebook, success: true }, msg.requestId);
            })
            .catch(function (err) {
              sendToWrapper('saved', { success: false, error: err.message }, msg.requestId);
            });
        }, 1500);
        break;

      case 'getStatus':
        getNotebookFromDB()
          .then(function (notebook) {
            sendToWrapper('status', {
              hasNotebook: !!notebook,
              isDirty: false,
              path: NOTEBOOK_PATH,
              shimMode: true,
              appReady: !!_dbName,
              dbName: _dbName
            }, msg.requestId);
          })
          .catch(function () {
            sendToWrapper('status', {
              hasNotebook: false,
              isDirty: false,
              path: NOTEBOOK_PATH,
              shimMode: true,
              appReady: false,
              dbName: null
            }, msg.requestId);
          });
        break;

      case 'runAll':
        try {
          var runAllBtn = document.querySelector('[data-command="notebook:run-all-cells"]');
          if (runAllBtn) runAllBtn.click();
        } catch (e) { /* ok */ }
        sendToWrapper('runAllComplete', { success: true }, msg.requestId);
        break;

      case 'clearOutputs':
        try {
          var clearBtn = document.querySelector('[data-command="notebook:clear-all-cell-outputs"]');
          if (clearBtn) clearBtn.click();
        } catch (e) { /* ok */ }
        sendToWrapper('outputsCleared', { success: true }, msg.requestId);
        break;

      case 'getFiles':
        triggerSave();
        setTimeout(function () {
          getAllFilesFromDB()
            .then(function (files) {
              sendToWrapper('filesContent', { files: files, count: files.length }, msg.requestId);
            })
            .catch(function (err) {
              console.warn('[bridge-shim] getFiles failed:', err);
              sendToWrapper('filesContent', { files: [], error: err.message }, msg.requestId);
            });
        }, 1500);
        break;

      case 'loadFiles':
        var filesToLoad = msg.data && msg.data.files;
        if (!filesToLoad || filesToLoad.length === 0) {
          sendToWrapper('filesLoaded', { success: true, count: 0 }, msg.requestId);
          break;
        }
        restoreFilesToDB(filesToLoad)
          .then(function () {
            console.log('[bridge-shim] Restored', filesToLoad.length, 'files to IndexedDB');
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
  // Wait for IndexedDB to be available, then signal ready
  // -------------------------------------------------------------------

  function checkReady() {
    discoverDatabaseName()
      .then(function (name) {
        if (!_ready) {
          _ready = true;
          console.log('[bridge-shim] IndexedDB ready. Database:', name);

          // Check if notebook exists
          readItem(NOTEBOOK_PATH).then(function (model) {
            var hasNotebook = !!(model && model.content);
            console.log('[bridge-shim] Notebook in IndexedDB:', hasNotebook);

            getAllKeys().then(function (keys) {
              console.log('[bridge-shim] All keys in files store:', keys);
            }).catch(function () { /* ok */ });

            sendToWrapper('ready', {
              version: '3.1.0-indexeddb',
              capabilities: [
                'getNotebook', 'loadNotebook', 'save', 'getStatus',
                'runAll', 'clearOutputs', 'getFiles', 'loadFiles'
              ],
              hasWidget: hasNotebook,
              dbName: name
            });
          }).catch(function () {
            sendToWrapper('ready', {
              version: '3.1.0-indexeddb',
              capabilities: [
                'getNotebook', 'loadNotebook', 'save', 'getStatus',
                'runAll', 'clearOutputs', 'getFiles', 'loadFiles'
              ],
              hasWidget: false,
              dbName: name
            });
          });
        }
      })
      .catch(function (err) {
        console.log('[bridge-shim] IndexedDB not ready yet:', err.message, '- retrying...');
        setTimeout(checkReady, 2000);
      });
  }

  // Start
  console.log('[bridge-shim] Zest bridge shim v3.1 loaded (IndexedDB, no persistent connection)');
  // Give JupyterLite time to initialize and create the IndexedDB
  setTimeout(checkReady, 4000);

})();
