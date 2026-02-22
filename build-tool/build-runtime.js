#!/usr/bin/env node

/* =========================================================================
   build-runtime.js — Build the shared JupyterLite runtime

   This builds a single JupyterLite distribution that is shared across
   all notebook zestables. It includes:
   - Python kernel (via jupyterlite-pyodide-kernel)
   - JavaScript kernel (via jupyterlite-javascript-kernel)
   - Zest bridge extension (federated JupyterLab extension)
   - Customized configuration (storage, theme, disabled extensions)

   Prerequisites:
     pip install jupyterlite-core jupyterlite-pyodide-kernel jupyterlite-javascript-kernel

   The Zest bridge extension is built and installed automatically from
   the extension/ directory.

   Output:
     runtime/_output/   — Full JupyterLite static site

   Usage:
     node build-runtime.js
     node build-runtime.js --check           (verify prerequisites only)
     node build-runtime.js --skip-extension   (skip building the extension)
   ========================================================================= */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const OUTPUT_DIR = path.join(RUNTIME_DIR, '_output');
const EXTENSION_DIR = path.join(ROOT, 'extension');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const skipExtension = args.includes('--skip-extension');

// -----------------------------------------------------------------------
// Check prerequisites
// -----------------------------------------------------------------------

function checkPrereqs() {
  console.log('Checking prerequisites...\n');

  let allGood = true;
  const missing = [];

  // Check Python
  try {
    const pyVersion = execSync('python3 --version 2>&1', { encoding: 'utf8' }).trim();
    console.log('  \u2713 ' + pyVersion);
  } catch (e) {
    console.log('  \u2717 Python 3 not found. Install Python 3.8+');
    allGood = false;
  }

  // Check pip
  try {
    const pipVersion = execSync('pip3 --version 2>&1', { encoding: 'utf8' }).trim();
    console.log('  \u2713 ' + pipVersion.split('\n')[0]);
  } catch (e) {
    console.log('  \u2717 pip3 not found');
    allGood = false;
  }

  // Check Node.js (needed for jlpm / extension build)
  try {
    const nodeVersion = execSync('node --version 2>&1', { encoding: 'utf8' }).trim();
    console.log('  \u2713 Node.js ' + nodeVersion);
  } catch (e) {
    console.log('  \u2717 Node.js not found. Install Node.js 18+');
    allGood = false;
  }

  // Check jupyterlite-core
  try {
    execSync('python3 -c "import jupyterlite_core" 2>&1', { encoding: 'utf8' });
    console.log('  \u2713 jupyterlite-core');
  } catch (e) {
    console.log('  \u2717 jupyterlite-core not installed');
    missing.push('jupyterlite-core');
    allGood = false;
  }

  // Check jupyterlite-pyodide-kernel (Python kernel)
  try {
    execSync('python3 -c "import jupyterlite_pyodide_kernel" 2>&1', { encoding: 'utf8' });
    console.log('  \u2713 jupyterlite-pyodide-kernel (Python kernel)');
  } catch (e) {
    console.log('  \u2717 jupyterlite-pyodide-kernel not installed (Python kernel)');
    missing.push('jupyterlite-pyodide-kernel');
    allGood = false;
  }

  // Check jupyterlite-javascript-kernel (JavaScript kernel)
  try {
    execSync('python3 -c "import jupyterlite_javascript_kernel" 2>&1', { encoding: 'utf8' });
    console.log('  \u2713 jupyterlite-javascript-kernel (JavaScript kernel)');
  } catch (e) {
    // Try alternate import name
    try {
      execSync('pip3 show jupyterlite-javascript-kernel 2>&1', { encoding: 'utf8' });
      console.log('  \u2713 jupyterlite-javascript-kernel (JavaScript kernel)');
    } catch (e2) {
      console.log('  \u2717 jupyterlite-javascript-kernel not installed (JavaScript kernel)');
      missing.push('jupyterlite-javascript-kernel');
      allGood = false;
    }
  }

  // Check jupyter lite CLI
  try {
    const jlVersion = execSync('jupyter lite --version 2>&1', { encoding: 'utf8' }).trim();
    console.log('  \u2713 jupyter lite CLI v' + jlVersion);
  } catch (e) {
    console.log('  \u2717 jupyter lite CLI not available');
    allGood = false;
  }

  if (missing.length > 0) {
    console.log('\n  Install missing packages:');
    console.log('  pip install ' + missing.join(' '));
  }

  return allGood;
}

// -----------------------------------------------------------------------
// Build the Zest bridge extension
// -----------------------------------------------------------------------

function buildExtension() {
  console.log('\nBuilding Zest bridge extension...');

  if (!fs.existsSync(EXTENSION_DIR)) {
    console.log('  \u2717 Extension directory not found:', EXTENSION_DIR);
    return false;
  }

  try {
    // Install extension dependencies
    console.log('  Installing extension dependencies...');
    execSync('cd "' + EXTENSION_DIR + '" && jlpm install', {
      stdio: 'pipe',
      timeout: 120000
    });

    // Build TypeScript
    console.log('  Compiling TypeScript...');
    execSync('cd "' + EXTENSION_DIR + '" && jlpm run build:ts', {
      stdio: 'pipe',
      timeout: 60000
    });

    // Build labextension (creates federated extension in jupyterlite_zest_bridge/labextension/)
    console.log('  Building federated extension...');
    execSync('cd "' + EXTENSION_DIR + '" && jlpm run build:labextension', {
      stdio: 'pipe',
      timeout: 120000
    });

    // Install the extension so jupyter lite build picks it up
    console.log('  Installing extension into environment...');
    execSync('cd "' + EXTENSION_DIR + '" && pip install -e .', {
      stdio: 'pipe',
      timeout: 120000
    });

    console.log('  \u2713 Zest bridge extension built and installed');
    return true;
  } catch (e) {
    console.error('  \u2717 Extension build failed:', e.message);
    if (e.stdout) console.error('  stdout:', e.stdout.toString().slice(-500));
    if (e.stderr) console.error('  stderr:', e.stderr.toString().slice(-500));
    return false;
  }
}

// -----------------------------------------------------------------------
// Create runtime configuration
// -----------------------------------------------------------------------

function createConfig() {
  console.log('\nCreating runtime configuration...');

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });

  // jupyter-lite.json — Runtime configuration
  const jupyterLiteJson = {
    'jupyter-lite-schema-version': 0,
    'jupyter-config-data': {
      'appName': 'Zest Notebook',
      'appUrl': './lab',
      'disabledExtensions': [
        // Disable extensions students don't need
        '@jupyterlab/extensionmanager-extension',
        '@jupyterlab/help-extension:open',
        '@jupyterlab/hub-extension'
      ],
      'settingsOverrides': {
        '@jupyterlab/apputils-extension:themes': {
          'theme': 'JupyterLab Light'
        },
        '@jupyterlab/notebook-extension:tracker': {
          'codeCellConfig': {
            'lineNumbers': true,
            'autoClosingBrackets': true
          }
        }
      }
    }
  };

  fs.writeFileSync(
    path.join(RUNTIME_DIR, 'jupyter-lite.json'),
    JSON.stringify(jupyterLiteJson, null, 2)
  );
  console.log('  \u2713 jupyter-lite.json');

  // jupyter_lite_config.json — Build configuration
  const buildConfig = {
    'LiteBuildConfig': {
      'output_dir': '_output'
    }
  };

  fs.writeFileSync(
    path.join(RUNTIME_DIR, 'jupyter_lite_config.json'),
    JSON.stringify(buildConfig, null, 2)
  );
  console.log('  \u2713 jupyter_lite_config.json');

  // overrides.json — UI customization
  const overrides = {
    '@jupyterlab/apputils-extension:themes': {
      'theme': 'JupyterLab Light'
    },
    '@jupyterlab/notebook-extension:tracker': {
      'codeCellConfig': {
        'lineNumbers': true,
        'autoClosingBrackets': true
      }
    },
    '@jupyterlab/filebrowser-extension:browser': {
      'navigateToCurrentDirectory': false
    }
  };

  fs.writeFileSync(
    path.join(RUNTIME_DIR, 'overrides.json'),
    JSON.stringify(overrides, null, 2)
  );
  console.log('  \u2713 overrides.json');

  // Create empty files/ directory (notebooks go here per-project)
  fs.mkdirSync(path.join(RUNTIME_DIR, 'files'), { recursive: true });
  console.log('  \u2713 files/ directory');
}

// -----------------------------------------------------------------------
// Build JupyterLite
// -----------------------------------------------------------------------

function buildRuntime() {
  console.log('\nBuilding JupyterLite runtime...');
  console.log('This includes Python (Pyodide) and JavaScript kernels.');
  console.log('First build may take several minutes to download Pyodide.\n');

  try {
    execSync(
      `cd "${RUNTIME_DIR}" && jupyter lite build --output-dir _output`,
      { stdio: 'inherit', timeout: 600000 }
    );
    console.log('\n  \u2713 JupyterLite runtime built successfully');
  } catch (e) {
    console.error('\n  \u2717 Build failed:', e.message);
    process.exit(1);
  }

  // Verify output
  const expectedFiles = ['index.html', 'lab', 'notebooks', 'repl'];
  let allPresent = true;
  for (const f of expectedFiles) {
    if (fs.existsSync(path.join(OUTPUT_DIR, f))) {
      console.log('  \u2713 ' + f);
    } else {
      console.log('  \u2717 Missing: ' + f);
      allPresent = false;
    }
  }

  // Verify kernels
  const kernelsDir = path.join(OUTPUT_DIR, 'api', 'kernelspecs');
  if (fs.existsSync(kernelsDir)) {
    try {
      const kernels = fs.readdirSync(kernelsDir);
      console.log('  \u2713 Kernels: ' + kernels.join(', '));
    } catch (e) {
      // May be a file instead of directory
      console.log('  \u2713 Kernel specs present');
    }
  }

  // Verify Zest bridge extension
  const labextensionsDir = path.join(OUTPUT_DIR, 'extensions');
  if (fs.existsSync(labextensionsDir)) {
    try {
      const extensions = fs.readdirSync(labextensionsDir);
      const hasZest = extensions.some(e => e.includes('zest'));
      if (hasZest) {
        console.log('  \u2713 Zest bridge extension included');
      } else {
        console.log('  ! Zest bridge extension not found in output (may still work)');
      }
    } catch (e) {
      // Ignore
    }
  }

  if (allPresent) {
    // Calculate total size
    let totalSize = 0;
    function calcSize(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          calcSize(p);
        } else {
          totalSize += fs.statSync(p).size;
        }
      }
    }
    calcSize(OUTPUT_DIR);
    const sizeMB = (totalSize / 1024 / 1024).toFixed(1);
    console.log(`\n  Runtime size: ${sizeMB} MB`);
  }
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
console.log('  Zest JupyterLite Runtime Builder');
console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n');

const prereqsOk = checkPrereqs();

if (checkOnly) {
  process.exit(prereqsOk ? 0 : 1);
}

if (!prereqsOk) {
  console.log('\nMissing prerequisites. Install them:');
  console.log('  pip install jupyterlite-core jupyterlite-pyodide-kernel jupyterlite-javascript-kernel');
  console.log('\nThen re-run: node build-tool/build-runtime.js');
  process.exit(1);
}

// Build the Zest bridge extension (unless skipped)
if (!skipExtension) {
  const extOk = buildExtension();
  if (!extOk) {
    console.log('\nExtension build failed. You can skip it with --skip-extension');
    console.log('The runtime will still work, but without the Zest bridge extension.');
  }
} else {
  console.log('\nSkipping extension build (--skip-extension)');
}

createConfig();
buildRuntime();

console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
console.log('  Runtime build complete!');
console.log('  Included: Python (Pyodide) + JavaScript kernels');
console.log('  Now run: npm run build');
console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
