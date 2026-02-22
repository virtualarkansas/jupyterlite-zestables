/* =========================================================================
   bridge.js — Zest Bridge for JupyterLite Notebook Wrapper
   Integrates JupyterLite with Zest API for:
   - State persistence (save/load notebook state)
   - Cell execution tracking
   - Interaction counting & time tracking
   - Event logging (ring buffer)
   - Score/work submission
   - Review mode (read-only notebook display)
   ========================================================================= */

(function () {
  'use strict';

  console.log('[bridge.js] JupyterLite-Zest bridge IIFE executing');

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------
  var JUPYTERLITE_URL = 'lite/lab/index.html';
  var NOTEBOOK_FILE = 'assignment.ipynb';
  var SAVE_DEBOUNCE_MS = 3000;
  var AUTO_SAVE_INTERVAL_MS = 30000;
  var READY_TIMEOUT_MS = 60000;
  var MAX_EVENTS = 500;

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------
  var _zestAvailable = typeof Zest !== 'undefined';
  var _params = {};
  var _state = {
    notebook: null,
    files: [],        // Additional files (images, CSVs, etc.) from JupyterLite
    timeSpent: 0,
    interactions: 0,
    cellExecutions: 0,
    lastSaved: null,
    submitted: false
  };
  var _isReview = false;
  var _saveTimer = null;
  var _timeTimer = null;
  var _autoSaveTimer = null;
  var _jupyterFrame = null;
  var _jupyterReady = false;
  var _extensionReady = false;
  var _requestId = 0;
  var _pendingRequests = {};
  var _stateRestored = false;  // Prevents reload loop during state restoration

  // Event & response tracking
  var _events = [];

  console.log('[bridge.js] Zest available:', _zestAvailable);

  // -----------------------------------------------------------------------
  // Event Logging (ring buffer, max 500)
  // -----------------------------------------------------------------------

  function logEvent(type, data) {
    _events.push({
      t: Math.floor(Date.now() / 1000),
      type: type,
      data: data || {}
    });
    if (_events.length > MAX_EVENTS) _events.shift();
  }

  // -----------------------------------------------------------------------
  // Request/Response helpers for extension communication
  // -----------------------------------------------------------------------

  function sendToExtension(action, data) {
    if (!_jupyterFrame || !_jupyterFrame.contentWindow) return null;

    var id = 'req_' + (++_requestId);
    var msg = {
      type: 'zest-jupyter',
      action: action,
      requestId: id,
      data: data || {}
    };

    return new Promise(function (resolve, reject) {
      var timeout = setTimeout(function () {
        delete _pendingRequests[id];
        reject(new Error('Extension request timeout: ' + action));
      }, 10000);

      _pendingRequests[id] = function (responseData) {
        clearTimeout(timeout);
        resolve(responseData);
      };

      _jupyterFrame.contentWindow.postMessage(msg, '*');
    });
  }

  function sendToExtensionNoWait(action, data) {
    if (!_jupyterFrame || !_jupyterFrame.contentWindow) return;
    _jupyterFrame.contentWindow.postMessage({
      type: 'zest-jupyter',
      action: action,
      data: data || {}
    }, '*');
  }

  // -----------------------------------------------------------------------
  // PostMessage Handler (from JupyterLite extension)
  // -----------------------------------------------------------------------

  function handleMessage(event) {
    if (!_jupyterFrame || event.source !== _jupyterFrame.contentWindow) return;

    var msg = event.data;
    if (!msg || msg.type !== 'zest-jupyter') return;

    // Handle responses to pending requests
    if (msg.requestId && _pendingRequests[msg.requestId]) {
      _pendingRequests[msg.requestId](msg.data);
      delete _pendingRequests[msg.requestId];
      return;
    }

    // Handle events from extension
    switch (msg.action) {
      case 'ready':
        console.log('[bridge.js] Extension ready, capabilities:', msg.data.capabilities);
        _extensionReady = true;
        onExtensionReady();
        break;

      case 'cellExecutionScheduled':
        logEvent('cell_exec_scheduled', msg.data);
        _state.interactions++;
        break;

      case 'cellExecuted':
        console.log('[bridge.js] Cell executed:', msg.data.cellIndex, 'success:', msg.data.success);
        logEvent('cell_executed', msg.data);
        _state.cellExecutions = msg.data.executionCount || (_state.cellExecutions + 1);
        _state.interactions++;
        debouncedSave();
        break;

      case 'notebookOpened':
        console.log('[bridge.js] Notebook opened:', msg.data.path);
        logEvent('notebook_opened', msg.data);
        updateCellInfo(msg.data.cellCount);
        break;

      case 'dirty':
        updateSaveStatus(msg.data.isDirty ? 'dirty' : 'saved');
        if (msg.data.isDirty) {
          _state.interactions++;
        }
        break;

      case 'kernelStatus':
        updateKernelStatus(msg.data.status);
        break;

      default:
        // Ignore unknown actions
        break;
    }
  }

  // -----------------------------------------------------------------------
  // UI Updates
  // -----------------------------------------------------------------------

  function updateKernelStatus(status) {
    var badge = document.getElementById('kernel-status');
    if (!badge) return;

    var statusMap = {
      'idle': { text: 'Idle', cls: 'idle' },
      'busy': { text: 'Running', cls: 'busy' },
      'starting': { text: 'Starting', cls: 'busy' },
      'restarting': { text: 'Restarting', cls: 'busy' },
      'dead': { text: 'Error', cls: 'error' },
      'unknown': { text: 'Loading', cls: 'busy' }
    };

    var info = statusMap[status] || { text: status, cls: 'busy' };
    badge.textContent = info.text;
    badge.className = 'status-badge ' + info.cls;
  }

  function updateSaveStatus(status) {
    var badge = document.getElementById('save-status');
    if (!badge) return;

    if (status === 'saved') {
      badge.textContent = 'Saved';
      badge.className = 'status-badge saved';
    } else if (status === 'dirty') {
      badge.textContent = 'Modified';
      badge.className = 'status-badge dirty';
    } else if (status === 'syncing') {
      badge.textContent = 'Saving...';
      badge.className = 'status-badge syncing';
    }
  }

  function updateCellInfo(count) {
    var el = document.getElementById('cell-info');
    if (el && count) {
      el.textContent = count + ' cells | ' + _state.cellExecutions + ' runs';
    }
  }

  function dismissLoading() {
    var overlay = document.getElementById('loading-overlay');
    if (overlay) {
      overlay.classList.add('hidden');
      setTimeout(function () {
        overlay.style.display = 'none';
      }, 600);
    }
  }

  // -----------------------------------------------------------------------
  // Debounced Save
  // -----------------------------------------------------------------------

  function debouncedSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(function () {
      saveState();
    }, SAVE_DEBOUNCE_MS);
  }

  function saveState() {
    if (!_zestAvailable || _isReview) return;

    updateSaveStatus('syncing');

    // Get current notebook content and files from extension
    var nbPromise = sendToExtension('getNotebook').catch(function (err) {
      console.warn('[bridge.js] getNotebook failed:', err.message);
      return null;
    });
    var filesPromise = sendToExtension('getFiles').catch(function (err) {
      console.warn('[bridge.js] getFiles failed:', err.message);
      return null;
    });

    Promise.all([nbPromise, filesPromise]).then(function (results) {
      var nbData = results[0];
      var filesData = results[1];

      if (nbData && nbData.notebook) {
        _state.notebook = nbData.notebook;
        _state.cellExecutions = nbData.executionCount || _state.cellExecutions;
      }
      if (filesData && filesData.files) {
        _state.files = filesData.files;
      }

      _state.lastSaved = Date.now();
      _state.events = _events;

      console.log('[bridge.js] Saving state, timeSpent:', _state.timeSpent,
        'cells:', _state.cellExecutions, 'files:', (_state.files || []).length);
      Zest.saveState(JSON.parse(JSON.stringify(_state)));
      updateSaveStatus('saved');
    });
  }

  // -----------------------------------------------------------------------
  // Time Tracking
  // -----------------------------------------------------------------------

  function startTimeTracking() {
    console.log('[bridge.js] Starting time tracking');
    _timeTimer = setInterval(function () {
      _state.timeSpent++;
    }, 1000);
  }

  function stopTimeTracking() {
    if (_timeTimer) clearInterval(_timeTimer);
  }

  // -----------------------------------------------------------------------
  // Auto-save (periodic)
  // -----------------------------------------------------------------------

  function startAutoSave() {
    _autoSaveTimer = setInterval(function () {
      if (_extensionReady) {
        saveState();
      }
    }, AUTO_SAVE_INTERVAL_MS);
  }

  function stopAutoSave() {
    if (_autoSaveTimer) clearInterval(_autoSaveTimer);
  }

  // -----------------------------------------------------------------------
  // Extension Ready
  // -----------------------------------------------------------------------

  function onExtensionReady() {
    console.log('[bridge.js] JupyterLite extension is ready (stateRestored:', _stateRestored, ')');
    dismissLoading();
    logEvent('extension_ready');

    // If state was already restored (iframe reloaded after loadNotebook),
    // just start auto-save and return. This prevents the reload loop:
    // ready → loadNotebook → write to IndexedDB → reload → ready → ...
    if (_stateRestored) {
      console.log('[bridge.js] State already restored, starting auto-save');
      if (!_isReview) {
        startAutoSave();
      }
      return;
    }

    var restorePromises = [];

    // If we have saved notebook state, load it into JupyterLite
    if (_state.notebook) {
      _stateRestored = true; // Set BEFORE sending to prevent re-entry
      console.log('[bridge.js] Restoring saved notebook state');
      restorePromises.push(
        sendToExtension('loadNotebook', {
          notebook: _state.notebook,
          path: NOTEBOOK_FILE
        }).then(function (result) {
          if (result && result.success) {
            console.log('[bridge.js] Notebook state restored — iframe will reload');
            logEvent('state_restored');
            // bridge-shim will reload the iframe to pick up the new IndexedDB content.
            // When it signals ready again, _stateRestored will be true so we skip restore.
          } else {
            console.warn('[bridge.js] Notebook restore failed:', result);
          }
        }).catch(function (err) {
          console.warn('[bridge.js] Notebook restore error:', err.message);
        })
      );
    }

    // If we have saved files (images, CSVs, etc.), restore them too
    if (_state.files && _state.files.length > 0) {
      console.log('[bridge.js] Restoring', _state.files.length, 'saved files');
      restorePromises.push(
        sendToExtension('loadFiles', {
          files: _state.files
        }).then(function (result) {
          if (result && result.success) {
            console.log('[bridge.js] Files restored:', result.count);
            logEvent('files_restored', { count: result.count });
          } else {
            console.warn('[bridge.js] Files restore failed:', result);
          }
        }).catch(function (err) {
          console.warn('[bridge.js] Files restore error:', err.message);
        })
      );
    }

    // Start auto-save after restore completes (or immediately if nothing to restore)
    // Note: if loadNotebook triggers a reload, auto-save starts after the second ready signal
    Promise.all(restorePromises).then(function () {
      if (!_isReview && !_state.notebook) {
        // No notebook to restore — start auto-save immediately
        startAutoSave();
      }
    });
  }

  // -----------------------------------------------------------------------
  // Submission Progress Overlay
  // -----------------------------------------------------------------------

  function showSubmitProgress(message) {
    var overlay = document.getElementById('submit-progress');
    var text = document.getElementById('submit-progress-text');
    if (overlay) overlay.classList.add('visible');
    if (text) text.textContent = message || 'Submitting...';
  }

  function updateSubmitProgress(message) {
    var text = document.getElementById('submit-progress-text');
    if (text) text.textContent = message;
  }

  function hideSubmitProgress() {
    var overlay = document.getElementById('submit-progress');
    if (overlay) overlay.classList.remove('visible');
  }

  function showSubmitSuccess() {
    updateSubmitProgress('Submitted! You may now close this page.');
    var spinner = document.getElementById('submit-progress-spinner');
    if (spinner) spinner.style.display = 'none';
    var check = document.getElementById('submit-progress-check');
    if (check) check.style.display = 'block';
    // Auto-hide after 4 seconds
    setTimeout(hideSubmitProgress, 4000);
  }

  function showSubmitError(msg) {
    updateSubmitProgress('Submission failed: ' + (msg || 'Unknown error. Please try again.'));
    var spinner = document.getElementById('submit-progress-spinner');
    if (spinner) spinner.style.display = 'none';
    setTimeout(hideSubmitProgress, 4000);
  }

  // -----------------------------------------------------------------------
  // Submission
  // -----------------------------------------------------------------------

  function handleSubmission() {
    var submitBtn = document.getElementById('btn-submit');
    if (submitBtn) submitBtn.disabled = true;

    showSubmitProgress('Getting notebook content...');

    // Try to get notebook content AND files from the extension/shim
    var nbPromise = sendToExtension('getNotebook').catch(function (err) {
      console.warn('[bridge.js] getNotebook failed:', err.message);
      return {
        notebook: _state.notebook,
        cellCount: _state.notebook ? (_state.notebook.cells || []).length : 0,
        executionCount: _state.cellExecutions
      };
    });

    var filesPromise = sendToExtension('getFiles').catch(function (err) {
      console.warn('[bridge.js] getFiles failed:', err.message);
      return { files: _state.files || [] };
    });

    Promise.all([nbPromise, filesPromise]).then(function (results) {
      var nbData = results[0] || {};
      var filesData = results[1] || {};
      nbData.files = filesData.files || _state.files || [];
      doSubmit(nbData);
    });
  }

  function doSubmit(data) {
    var submitBtn = document.getElementById('btn-submit');
    var notebook = (data && data.notebook) || _state.notebook;
    var files = (data && data.files) || _state.files || [];

    if (notebook) {
      _state.notebook = notebook;
    }
    _state.files = files;

    _state.submitted = true;
    _state.events = _events;
    _state.lastSaved = Date.now();

    logEvent('submission', {
      cellCount: data ? data.cellCount : 0,
      executionCount: data ? data.executionCount : 0,
      fileCount: files.length
    });

    updateSubmitProgress('Saving final state...');

    // Save final state (includes notebook + files)
    Zest.saveState(JSON.parse(JSON.stringify(_state)));

    updateSubmitProgress('Submitting to gradebook...');

    // Submit work (teacher-graded by default for notebooks)
    Zest.submitWork({
      artifacts: {
        notebook: notebook,
        files: files,
        events: _events,
        stats: {
          timeSpent: _state.timeSpent,
          cellExecutions: _state.cellExecutions,
          interactions: _state.interactions,
          cellCount: notebook ? (notebook.cells || []).length : 0,
          fileCount: files.length
        }
      }
    }).then(function (result) {
      console.log('[bridge.js] Work submitted:', result.success ? 'OK' : result.error);
      if (result.success) {
        showSubmitSuccess();
        if (submitBtn) {
          submitBtn.textContent = 'Submitted';
          submitBtn.disabled = true;
        }
      } else {
        showSubmitError(result.error);
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Retry Submit';
        }
      }
    }).catch(function (err) {
      console.error('[bridge.js] Submission failed:', err);
      showSubmitError(err.message);
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Retry Submit';
      }
    });
  }

  // -----------------------------------------------------------------------
  // UI Event Handlers
  // -----------------------------------------------------------------------

  function setupUI() {
    // Save button
    var saveBtn = document.getElementById('btn-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        saveState();
      });
    }

    // Submit button
    var submitBtn = document.getElementById('btn-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        // Show confirmation dialog
        var dialog = document.getElementById('submit-dialog');
        if (dialog) dialog.classList.add('visible');
      });
    }

    // Submit dialog
    var cancelBtn = document.getElementById('submit-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        var dialog = document.getElementById('submit-dialog');
        if (dialog) dialog.classList.remove('visible');
      });
    }

    var confirmBtn = document.getElementById('submit-confirm');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', function () {
        var dialog = document.getElementById('submit-dialog');
        if (dialog) dialog.classList.remove('visible');
        handleSubmission();
      });
    }

    // Review mode: hide interactive elements
    if (_isReview) {
      if (saveBtn) saveBtn.style.display = 'none';
      if (submitBtn) submitBtn.style.display = 'none';
    }

    // Note: _state.submitted is reset to false on each new session,
    // so students can always resubmit. Each submission creates a new record.
  }

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------

  function init() {
    console.log('[bridge.js] init() called');

    _jupyterFrame = document.getElementById('jupyter-frame');
    if (!_jupyterFrame) {
      console.error('[bridge.js] #jupyter-frame iframe not found');
      return;
    }

    // Listen for postMessage from JupyterLite extension
    window.addEventListener('message', handleMessage);

    if (!_zestAvailable) {
      console.warn('[bridge.js] Zest not available — standalone mode');
      _params = {};
      setupUI();
      loadJupyterLite();
      startTimeTracking();
      return;
    }

    // Wait for Zest with timeout fallback
    var _readyFired = false;
    var _fallbackTimeout = setTimeout(function () {
      if (!_readyFired) {
        console.warn('[bridge.js] Zest.onReady timeout (5s) — standalone fallback');
        _zestAvailable = false;
        _params = {};
        setupUI();
        loadJupyterLite();
        startTimeTracking();
      }
    }, 5000);

    Zest.onReady(function (context) {
      _readyFired = true;
      clearTimeout(_fallbackTimeout);
      console.log('[bridge.js] Zest.onReady fired');

      _isReview = context.isReview || false;
      _params = context.parameters || {};

      console.log('[bridge.js] Params:', JSON.stringify(_params));

      if (_isReview) {
        console.log('[bridge.js] Review mode');
        var submission = Zest.getSubmission();

        // In review mode, load the submitted notebook
        if (submission && submission.artifacts && submission.artifacts.notebook) {
          _state.notebook = submission.artifacts.notebook;
        }

        setupUI();
        loadJupyterLite();
        return;
      }

      // Student mode: load saved state, then load JupyterLite
      console.log('[bridge.js] Student mode — loading state');
      Zest.loadState().then(function (savedState) {
        console.log('[bridge.js] Loaded state:', !!savedState);
        if (savedState) {
          _state = savedState;
          if (savedState.events) _events = savedState.events;
        }

        // Always allow resubmission — reset submitted flag on new session
        // Each submission creates a new record; students should be able to submit again
        _state.submitted = false;

        logEvent('session_start');
        startTimeTracking();
        setupUI();
        loadJupyterLite();
      }).catch(function (err) {
        console.error('[bridge.js] loadState failed:', err);
        logEvent('session_start');
        startTimeTracking();
        setupUI();
        loadJupyterLite();
      });
    });
  }

  // -----------------------------------------------------------------------
  // Storage Isolation for Shared Computers
  // -----------------------------------------------------------------------
  // In computer labs, multiple students use the same browser. JupyterLite
  // stores notebooks in IndexedDB keyed by origin + storage name. Without
  // isolation, Student B would see Student A's notebook edits.
  //
  // Solution: Clear JupyterLite's IndexedDB before each session. The
  // authoritative notebook state comes from the Zest server (via loadState),
  // not from the browser's IndexedDB. This ensures:
  //   1. Each student starts fresh (no leftover state from other users)
  //   2. The Zest server state is always the source of truth
  //   3. Auto-save goes server → Zest API, not just to IndexedDB
  // -----------------------------------------------------------------------

  function clearJupyterLiteStorage() {
    return new Promise(function (resolve) {
      // Delete all IndexedDB databases that JupyterLite might have created
      if (!window.indexedDB || !window.indexedDB.databases) {
        // Firefox doesn't support indexedDB.databases() — just proceed
        console.log('[bridge.js] indexedDB.databases() not available, skipping cleanup');
        resolve();
        return;
      }

      window.indexedDB.databases().then(function (databases) {
        var jupyterDbs = databases.filter(function (db) {
          return db.name && (
            db.name.indexOf('JupyterLite') !== -1 ||
            db.name.indexOf('jupyter') !== -1 ||
            db.name.indexOf('localforage') !== -1
          );
        });

        if (jupyterDbs.length === 0) {
          console.log('[bridge.js] No JupyterLite IndexedDB databases to clear');
          resolve();
          return;
        }

        console.log('[bridge.js] Clearing', jupyterDbs.length, 'JupyterLite IndexedDB databases');
        var remaining = jupyterDbs.length;

        jupyterDbs.forEach(function (db) {
          var req = window.indexedDB.deleteDatabase(db.name);
          req.onsuccess = function () {
            console.log('[bridge.js] Cleared IndexedDB:', db.name);
            if (--remaining === 0) resolve();
          };
          req.onerror = function () {
            console.warn('[bridge.js] Failed to clear IndexedDB:', db.name);
            if (--remaining === 0) resolve();
          };
          req.onblocked = function () {
            console.warn('[bridge.js] IndexedDB blocked:', db.name);
            if (--remaining === 0) resolve();
          };
        });

        // Safety timeout — don't block forever
        setTimeout(resolve, 3000);
      }).catch(function (err) {
        console.warn('[bridge.js] indexedDB.databases() failed:', err);
        resolve();
      });
    });
  }

  function loadJupyterLite() {
    // Clear previous user's IndexedDB data before loading JupyterLite
    clearJupyterLiteStorage().then(function () {
      var url = JUPYTERLITE_URL;

      // Add path parameter to open the notebook directly
      url += '?path=' + encodeURIComponent(NOTEBOOK_FILE);

      // Add kernel parameter if specified
      if (_params.kernel) {
        url += '&kernel=' + encodeURIComponent(_params.kernel);
      }

      console.log('[bridge.js] Loading JupyterLite:', url);
      _jupyterFrame.src = url;

      // Fallback: if extension doesn't signal ready, dismiss loading after timeout
      setTimeout(function () {
        if (!_extensionReady) {
          console.warn('[bridge.js] Extension ready timeout — dismissing loading');
          _extensionReady = true;
          dismissLoading();
        }
      }, READY_TIMEOUT_MS);
    });
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  window.addEventListener('beforeunload', function () {
    stopTimeTracking();
    stopAutoSave();
    if (_saveTimer) clearTimeout(_saveTimer);

    // Final save
    if (_zestAvailable && _state.timeSpent > 0 && !_isReview) {
      _state.lastSaved = Date.now();
      _state.events = _events;
      Zest.saveState(JSON.parse(JSON.stringify(_state)));
    }
  });

  // -----------------------------------------------------------------------
  // Start
  // -----------------------------------------------------------------------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
