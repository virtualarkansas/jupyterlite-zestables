/**
 * bridge-shim.js v3 — Direct IndexedDB bridge for JupyterLite
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
 * For notebooks, content is the parsed JSON object (not a string).
 * For text files, content is a string.
 * For binary files, content is a base64 string.
 *
 * To trigger saves (flush in-memory model to IndexedDB), we dispatch
 * Ctrl+S keyboard events which JupyterLab's shortcut system handles.
 *
 * It handles:
 *   - getNotebook: reads notebook from IndexedDB
 *   - loadNotebook: writes notebook to IndexedDB + reloads
 *   - save: triggers Ctrl+S then reads from IndexedDB
 *   - getFiles: lists all non-notebook files from IndexedDB
 *   - loadFiles: writes files to IndexedDB
 *   - getStatus: reports notebook status
 *   - runAll / clearOutputs: dispatches keyboard shortcuts
 */

(function () {
  'use strict';

  var NOTEBOOK_PATH = 'assignment.ipynb';
  var _ready = false;
  var _db = null;         // IndexedDB database reference
  var _dbName = null;     // Discovered database name

  // Possible database names JupyterLite might use
  var DB_NAME_CANDIDATES = [
    'JupyterLite Storage',
    'JupyterLite Storage - ./',
    'JupyterLite Storage - /',
    'JupyterLite Storage - /lab',
    'JupyterLite Storage - ./lab'
  ];

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
  // IndexedDB helpers
  // -------------------------------------------------------------------

  /**
   * Discover the JupyterLite IndexedDB database name.
   * Tries indexedDB.databases() first, falls back to trying known names.
   */
  function discoverDatabase() {
    return new Promise(function (resolve, reject) {
      // Method 1: Use indexedDB.databases() to find JupyterLite DB
      if (window.indexedDB && window.indexedDB.databases) {
        window.indexedDB.databases().then(function (databases) {
          console.log('[bridge-shim] All IndexedDB databases:', databases.map(function (d) { return d.name; }));

          for (var i = 0; i < databases.length; i++) {
            var name = databases[i].name;
            if (name && name.indexOf('JupyterLite Storage') !== -1) {
              console.log('[bridge-shim] Found JupyterLite database:', name);
              openDatabase(name).then(resolve).catch(function () {
                // If first match fails, try others
                tryNextCandidate(0, resolve, reject);
              });
              return;
            }
          }

          // No matching DB found via databases() — try candidates
          console.log('[bridge-shim] No JupyterLite DB found via databases(), trying candidates');
          tryNextCandidate(0, resolve, reject);
        }).catch(function () {
          // databases() not supported — try candidates
          tryNextCandidate(0, resolve, reject);
        });
      } else {
        // databases() not available — try candidates
        tryNextCandidate(0, resolve, reject);
      }
    });
  }

  function tryNextCandidate(index, resolve, reject) {
    if (index >= DB_NAME_CANDIDATES.length) {
      reject(new Error('Could not find JupyterLite IndexedDB database'));
      return;
    }
    openDatabase(DB_NAME_CANDIDATES[index]).then(resolve).catch(function () {
      tryNextCandidate(index + 1, resolve, reject);
    });
  }

  /**
   * Open a specific IndexedDB database and verify it has the 'files' store.
   */
  function openDatabase(name) {
    return new Promise(function (resolve, reject) {
      try {
        var request = window.indexedDB.open(name);
        request.onerror = function () {
          reject(new Error('Failed to open DB: ' + name));
        };
        request.onsuccess = function (event) {
          var db = event.target.result;
          // Check if this DB has the 'files' object store
          if (db.objectStoreNames.contains(FILES_STORE)) {
            console.log('[bridge-shim] Successfully opened DB:', name, 'with files store');
            _db = db;
            _dbName = name;
            resolve(db);
          } else {
            console.log('[bridge-shim] DB', name, 'exists but has no files store. Stores:', Array.from(db.objectStoreNames));
            db.close();
            reject(new Error('No files store in DB: ' + name));
          }
        };
        // If the DB doesn't exist, this will create it (version 1) — we don't want that
        // But we can't prevent it, so we check for the files store above
        request.onupgradeneeded = function (event) {
          // This fires when the DB is being created for the first time
          // We don't want to create it — abort
          event.target.transaction.abort();
          reject(new Error('DB does not exist: ' + name));
        };
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Get the database, re-opening if needed.
   */
  function getDB() {
    if (_db) return Promise.resolve(_db);
    return discoverDatabase();
  }

  /**
   * Read a single item from the files store.
   */
  function readItem(path) {
    return getDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(FILES_STORE, 'readonly');
          var store = tx.objectStore(FILES_STORE);
          var request = store.get(path);
          request.onsuccess = function () {
            resolve(request.result || null);
          };
          request.onerror = function () {
            reject(new Error('Failed to read: ' + path));
          };
        } catch (e) {
          // DB might have been closed, try reopening
          _db = null;
          reject(e);
        }
      });
    });
  }

  /**
   * Write a single item to the files store.
   */
  function writeItem(path, model) {
    return getDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(FILES_STORE, 'readwrite');
          var store = tx.objectStore(FILES_STORE);
          var request = store.put(model, path);
          request.onsuccess = function () {
            resolve();
          };
          request.onerror = function () {
            reject(new Error('Failed to write: ' + path));
          };
        } catch (e) {
          _db = null;
          reject(e);
        }
      });
    });
  }

  /**
   * Get all keys from the files store.
   */
  function getAllKeys() {
    return getDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(FILES_STORE, 'readonly');
          var store = tx.objectStore(FILES_STORE);
          var request = store.getAllKeys();
          request.onsuccess = function () {
            resolve(request.result || []);
          };
          request.onerror = function () {
            reject(new Error('Failed to get keys'));
          };
        } catch (e) {
          _db = null;
          reject(e);
        }
      });
    });
  }

  /**
   * Get all items from the files store.
   */
  function getAllItems() {
    return getDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(FILES_STORE, 'readonly');
          var store = tx.objectStore(FILES_STORE);
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
        } catch (e) {
          _db = null;
          reject(e);
        }
      });
    });
  }

  // -------------------------------------------------------------------
  // Keyboard shortcut helpers (for triggering JupyterLab commands)
  // -------------------------------------------------------------------

  /**
   * Dispatch a Ctrl+S / Cmd+S keyboard event to trigger JupyterLab save.
   */
  function triggerSave() {
    try {
      // Try Ctrl+S (works on all platforms in JupyterLab)
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

  /**
   * Read notebook content from IndexedDB.
   */
  function getNotebookFromDB() {
    return readItem(NOTEBOOK_PATH).then(function (model) {
      if (!model) {
        console.warn('[bridge-shim] No notebook found in IndexedDB at key:', NOTEBOOK_PATH);
        return null;
      }
      console.log('[bridge-shim] Read notebook from IndexedDB, type:', model.type, 'format:', model.format);
      // The content field contains the parsed notebook JSON
      return model.content || null;
    });
  }

  /**
   * Write notebook content to IndexedDB.
   */
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

  /**
   * Get all non-notebook files from IndexedDB.
   */
  function getAllFilesFromDB() {
    return getAllItems().then(function (items) {
      var files = [];
      for (var i = 0; i < items.length; i++) {
        var key = items[i].key;
        var model = items[i].value;

        // Skip the notebook itself
        if (key === NOTEBOOK_PATH) continue;

        // Skip directories
        if (model && model.type === 'directory') continue;

        // Skip system files
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

  /**
   * Write files to IndexedDB.
   */
  function restoreFilesToDB(files) {
    if (!files || files.length === 0) return Promise.resolve([]);

    var promises = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var now = new Date().toISOString();
      var model = {
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
      };

      // Ensure parent directories exist
      var parts = f.path.split('/');
      if (parts.length > 1) {
        // Create parent directory entries
        for (var d = 1; d < parts.length; d++) {
          var dirPath = parts.slice(0, d).join('/');
          promises.push(
            writeItem(dirPath, {
              name: parts[d - 1],
              path: dirPath,
              last_modified: now,
              created: now,
              format: 'json',
              mimetype: '',
              content: null,
              size: 0,
              writable: true,
              type: 'directory'
            })
          );
        }
      }

      promises.push(writeItem(f.path, model));
    }
    return Promise.all(promises);
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
        // Trigger save to flush in-memory changes to IndexedDB
        triggerSave();
        // Wait for save to write to IndexedDB, then read
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
        }, 1000); // 1 second for save to complete
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
            // Reload so JupyterLite picks up the new content from IndexedDB
            setTimeout(function () { window.location.reload(); }, 500);
          })
          .catch(function (err) {
            sendToWrapper('notebookLoaded', { success: false, error: err.message }, msg.requestId);
          });
        break;

      case 'save':
        // Trigger save to flush in-memory changes
        triggerSave();
        // Wait, then read current state from IndexedDB
        setTimeout(function () {
          getNotebookFromDB()
            .then(function (notebook) {
              sendToWrapper('saved', { notebook: notebook, success: true }, msg.requestId);
            })
            .catch(function (err) {
              sendToWrapper('saved', { success: false, error: err.message }, msg.requestId);
            });
        }, 1000);
        break;

      case 'getStatus':
        getNotebookFromDB()
          .then(function (notebook) {
            sendToWrapper('status', {
              hasNotebook: !!notebook,
              isDirty: false,
              path: NOTEBOOK_PATH,
              shimMode: true,
              appReady: !!_db,
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
        // Try keyboard shortcut: Ctrl+Shift+Enter is not standard
        // JupyterLab uses Shift+Enter for run, but "run all" doesn't have a default shortcut
        // Try clicking the "Run All" menu option if available
        try {
          // Try to find and execute via the JupyterLab command system
          // Since we can't access the app, simulate the menu action
          var runAllBtn = document.querySelector('[data-command="notebook:run-all-cells"]');
          if (runAllBtn) {
            runAllBtn.click();
          }
        } catch (e) { /* ok */ }
        sendToWrapper('runAllComplete', { success: true }, msg.requestId);
        break;

      case 'clearOutputs':
        try {
          var clearBtn = document.querySelector('[data-command="notebook:clear-all-cell-outputs"]');
          if (clearBtn) {
            clearBtn.click();
          }
        } catch (e) { /* ok */ }
        sendToWrapper('outputsCleared', { success: true }, msg.requestId);
        break;

      case 'getFiles':
        // Trigger save first to flush any changes
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
        }, 1000);
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
    discoverDatabase()
      .then(function (db) {
        if (!_ready) {
          _ready = true;
          console.log('[bridge-shim] IndexedDB ready. Database:', _dbName);

          // Check if notebook exists in the DB
          readItem(NOTEBOOK_PATH).then(function (model) {
            var hasNotebook = !!(model && model.content);
            console.log('[bridge-shim] Notebook in IndexedDB:', hasNotebook);

            // Also list all keys for debugging
            getAllKeys().then(function (keys) {
              console.log('[bridge-shim] All keys in files store:', keys);
            }).catch(function () { /* ok */ });

            sendToWrapper('ready', {
              version: '3.0.0-indexeddb',
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
              hasWidget: hasNotebook,
              dbName: _dbName
            });
          }).catch(function () {
            sendToWrapper('ready', {
              version: '3.0.0-indexeddb',
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
              hasWidget: false,
              dbName: _dbName
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
  console.log('[bridge-shim] Zest bridge shim v3 loaded (IndexedDB direct access)');
  // Give JupyterLite time to initialize and create the IndexedDB
  setTimeout(checkReady, 3000);

})();
