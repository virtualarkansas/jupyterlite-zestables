# JupyterLite Zestables

JupyterLite notebooks packaged as Zest content for Canvas LMS integration.

## Architecture

```
jupyterlite-zestables/
  template/               Zest wrapper files (shared by all notebooks)
    index.html            Wrapper page with toolbar + JupyterLite iframe
    bridge.js             Zest API integration (state, grading, events, storage isolation)
    bridge-shim.js        Runs INSIDE JupyterLite iframe — direct IndexedDB access (v3.1)
    review.html           SpeedGrader review page (notebook viewer + event timeline)
    zest.json             Manifest template
  build-tool/
    build.js              Package notebooks into standalone Zest zips
    build-runtime.js      Build the shared JupyterLite runtime with kernels
  runtime/                JupyterLite build directory (generated)
    _output/              Built JupyterLite static site
  examples/               Example notebook projects
    python-basics/
    data-analysis/
    physics-simulation/
  dist/                   Output zips (generated)
  extension/              DEPRECATED — original TypeScript extension approach (unused)
```

## How It Works

1. **bridge-shim.js** runs inside the JupyterLite iframe and communicates with the wrapper via postMessage. It accesses JupyterLite's IndexedDB directly (via the localforage database) to read/write notebook content and files.
2. The **wrapper** (index.html + bridge.js) handles Zest API calls — state save/load, submission, grading
3. The **build tool** packages each notebook with the JupyterLite runtime into a standalone zip
4. Each zip is a complete Zest content package — upload to the Zest picker and it works

## bridge-shim.js v3.1 — Direct IndexedDB Access

The shim bypasses JupyterLite's APIs entirely and reads/writes directly to the localforage IndexedDB store. This approach was chosen because:

- JupyterLite's ServiceWorker blocks all `/api/` fetch requests (`shouldDrop()` returns true)
- The `window.jupyterapp` object is not exposed globally
- Direct IndexedDB is reliable and doesn't depend on JupyterLite's internal API surface

### IndexedDB Schema (JupyterLite 0.7.x)

```
Database name: "JupyterLite Storage - {baseUrl}"
  Store: "files"      — key: file path (string), value: IModel object
  Store: "counters"   — untitled file numbering
  Store: "checkpoints" — file checkpoints (up to 5 per file)
```

IModel objects have: `{ name, path, type, format, content, mimetype, size, writable, created, last_modified }`

**Version sensitivity:** The database name format changed in v0.6.0 (was static `"JupyterLite Storage"`). The store names and value schema have been stable since v0.1.0. localforage itself (v1.10.0) is in maintenance mode and won't change. Pin to `jupyterlite-core>=0.7.0,<0.8.0` — v0.8.0 may restructure the drive package (issue #1806).

### Key Design: Open/Close Per Operation

bridge-shim.js opens and closes the IndexedDB connection for each operation (`withDB` pattern). This prevents blocking localforage's version upgrades when it creates the `counters` and `checkpoints` stores. A persistent connection would trigger `versionchange` events and break JupyterLite's file operations (including drag-and-drop upload).

### State Restore Reload Pattern

When restoring saved state, bridge-shim writes the notebook to IndexedDB and then reloads the iframe (`window.location.reload()`) so JupyterLite picks up the new content. bridge.js uses a `_stateRestored` flag to prevent an infinite reload loop (ready → loadNotebook → reload → ready → ...).

## Key Design Decisions

- **Storage isolation**: IndexedDB is cleared before each session. The Zest server is the source of truth for student state, not the browser. This prevents Student B from seeing Student A's work on shared lab computers.
- **Direct IndexedDB, not extension**: bridge-shim.js reads/writes IndexedDB directly instead of going through a JupyterLab extension. This is simpler, more reliable, and doesn't require extension build infrastructure.
- **Both kernels**: Python (Pyodide) and JavaScript kernels are both included. Teachers choose via the kernel parameter or students select when opening a notebook.
- **Teacher-graded by default**: Notebooks use `submitWork()` not `submitScore()`. The teacher reviews in SpeedGrader via review.html which renders the submitted notebook with all outputs.

## Build Process

```bash
# 1. Install Python dependencies (pinned to JupyterLite 0.7.x)
pip install -r requirements.txt

# 2. Build the JupyterLite runtime (includes kernels)
node build-tool/build-runtime.js

# 3. Package notebooks into Zest zips
node build-tool/build.js

# Output: dist/*.zip files ready for upload to Zest
```

The build tool injects bridge-shim.js into the JupyterLite lab/index.html during packaging.

## Creating New Notebooks

Drop a directory into `examples/` (or any directory you point --dir at):

```
my-notebook/
  assignment.ipynb     # Required: the main notebook
  data/                # Optional: data files accessible from the notebook
  requirements.txt     # Optional: pip packages (for documentation)
  zest.json            # Optional: override metadata (title, tags, etc.)
```

Or just drop a bare `.ipynb` file — the build tool handles both patterns.

## PostMessage Protocol

bridge.js (wrapper) ↔ bridge-shim.js (inside JupyterLite iframe):

**Wrapper → Shim:**
- `getNotebook` — Read notebook from IndexedDB, return as JSON
- `loadNotebook` — Write notebook JSON to IndexedDB, reload iframe
- `save` — Trigger Ctrl+S to flush JupyterLab's in-memory model to IndexedDB
- `getStatus` — Get IndexedDB status and file count
- `getFiles` — Read all non-notebook files from IndexedDB
- `loadFiles` — Write files to IndexedDB for state restoration
- `runAll` / `clearOutputs` — Dispatch keyboard shortcuts

**Shim → Wrapper:**
- `ready` — Shim initialized, IndexedDB discovered
- Response messages with `requestId` for each request

## Server-Side Requirements

The Zest server needs the body parser limit set to 110mb (notebooks with images/files can be large). This is configured in `zipembed/index.js` by replacing ltijs's default body parser handlers in-place after `lti.setup()`.

APIs used:
- `Zest.saveState()` / `Zest.loadState()` — notebook JSON + files stored as state
- `Zest.submitWork()` — notebook JSON + files + events submitted as artifacts
- `review.html` — renders submitted notebook in SpeedGrader

State size: notebook JSON is typically 10-500 KB. With uploaded images/files, submissions can be 1-50 MB.
