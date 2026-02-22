#!/usr/bin/env node

/* =========================================================================
   build.js — Zest JupyterLite Build Tool

   Packages JupyterLite notebooks into standalone Zest content zips.

   Usage:
     node build.js                          # Build all notebooks in examples/
     node build.js --dir my-notebooks/      # Build from custom directory
     node build.js --single my-notebook.ipynb  # Build a single notebook
     node build.js --dry-run                # Preview what would be built

   Directory Structure Expected:
     my-notebooks/
       notebook-name/
         assignment.ipynb          # Required: the notebook
         data/                     # Optional: data files
           dataset.csv
         requirements.txt          # Optional: pip packages to install
         zest.json                 # Optional: override metadata

   OR simply:
     my-notebooks/
       my-notebook.ipynb           # Just a bare .ipynb file

   Output:
     dist/
       notebook-name.zip           # Standalone Zest content package

   Each zip contains:
     index.html         — Zest wrapper with JupyterLite iframe
     bridge.js          — Zest-JupyterLite bridge
     review.html        — SpeedGrader review page
     zest.json          — Zest manifest
     lite/              — JupyterLite runtime (shared)
     lite/files/        — Pre-loaded notebooks and data files
   ========================================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// -----------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_DIR = path.join(ROOT, 'template');
const RUNTIME_DIR = path.join(ROOT, 'runtime', '_output');
const DIST_DIR = path.join(ROOT, 'dist');
const DEFAULT_NOTEBOOKS_DIR = path.join(ROOT, 'examples');

// -----------------------------------------------------------------------
// CLI Arguments
// -----------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dir' && args[i + 1]) {
    flags.dir = args[++i];
  } else if (args[i] === '--single' && args[i + 1]) {
    flags.single = args[++i];
  } else if (args[i] === '--dry-run') {
    flags.dryRun = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    flags.help = true;
  }
}

if (flags.help) {
  console.log(`
Zest JupyterLite Build Tool

Usage:
  node build.js                            Build all notebooks in examples/
  node build.js --dir <path>               Build from custom directory
  node build.js --single <notebook.ipynb>  Build a single notebook
  node build.js --dry-run                  Preview what would be built

Directory Structure:
  Each subdirectory is a notebook project:
    my-notebook/
      assignment.ipynb       Required: the main notebook
      data/                  Optional: data files
      requirements.txt       Optional: pip packages
      zest.json             Optional: metadata override

  Or just bare .ipynb files at the top level.
`);
  process.exit(0);
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\.ipynb$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function titleCase(slug) {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function readTemplate(filename) {
  return fs.readFileSync(path.join(TEMPLATE_DIR, filename), 'utf8');
}

function extractNotebookTitle(nbPath) {
  try {
    const nb = JSON.parse(fs.readFileSync(nbPath, 'utf8'));
    // Look for a title in the first markdown cell
    if (nb.cells && nb.cells.length > 0) {
      for (const cell of nb.cells) {
        if (cell.cell_type === 'markdown') {
          const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
          const match = source.match(/^#\s+(.+)$/m);
          if (match) return match[1].trim();
        }
      }
    }
  } catch (e) {
    // Ignore
  }
  return null;
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// -----------------------------------------------------------------------
// Discover notebook projects
// -----------------------------------------------------------------------

function discoverProjects(baseDir) {
  const projects = [];

  if (!fs.existsSync(baseDir)) {
    console.error('Directory not found:', baseDir);
    process.exit(1);
  }

  const entries = fs.readdirSync(baseDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(baseDir, entry.name);

    if (entry.isDirectory()) {
      // Directory: look for assignment.ipynb or any .ipynb file
      const ipynbFiles = fs.readdirSync(fullPath).filter(f => f.endsWith('.ipynb'));
      if (ipynbFiles.length > 0) {
        const mainFile = ipynbFiles.includes('assignment.ipynb')
          ? 'assignment.ipynb'
          : ipynbFiles[0];

        projects.push({
          name: entry.name,
          slug: slugify(entry.name),
          dir: fullPath,
          mainNotebook: path.join(fullPath, mainFile),
          mainNotebookName: mainFile,
          hasZestJson: fs.existsSync(path.join(fullPath, 'zest.json')),
          hasRequirements: fs.existsSync(path.join(fullPath, 'requirements.txt')),
          hasData: fs.existsSync(path.join(fullPath, 'data'))
        });
      }
    } else if (entry.name.endsWith('.ipynb')) {
      // Bare .ipynb file
      projects.push({
        name: entry.name.replace('.ipynb', ''),
        slug: slugify(entry.name),
        dir: null,
        mainNotebook: fullPath,
        mainNotebookName: entry.name,
        hasZestJson: false,
        hasRequirements: false,
        hasData: false
      });
    }
  }

  return projects;
}

// -----------------------------------------------------------------------
// Build a single notebook project
// -----------------------------------------------------------------------

function buildProject(project) {
  const buildDir = path.join(DIST_DIR, '.build', project.slug);
  const zipPath = path.join(DIST_DIR, project.slug + '.zip');

  // Clean build directory
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true });
  }
  fs.mkdirSync(buildDir, { recursive: true });

  // Determine title
  const nbTitle = extractNotebookTitle(project.mainNotebook);
  const title = nbTitle || titleCase(project.slug);

  // 1. Copy JupyterLite runtime
  if (fs.existsSync(RUNTIME_DIR)) {
    copyDirRecursive(RUNTIME_DIR, path.join(buildDir, 'lite'));
  } else {
    console.warn('  ⚠ JupyterLite runtime not built yet — run `npm run build:runtime` first');
    // Create a placeholder
    fs.mkdirSync(path.join(buildDir, 'lite', 'files'), { recursive: true });
  }

  // 1b. Inject bridge-shim.js into JupyterLite lab/index.html
  const bridgeShimSrc = path.join(TEMPLATE_DIR, 'bridge-shim.js');
  const labIndexPath = path.join(buildDir, 'lite', 'lab', 'index.html');
  if (fs.existsSync(bridgeShimSrc) && fs.existsSync(labIndexPath)) {
    // Copy bridge-shim.js into lite/lab/
    fs.copyFileSync(bridgeShimSrc, path.join(buildDir, 'lite', 'lab', 'bridge-shim.js'));
    // Inject script tag before </body>
    let labHtml = fs.readFileSync(labIndexPath, 'utf8');
    if (!labHtml.includes('bridge-shim.js')) {
      labHtml = labHtml.replace('</body>', '  <script src="bridge-shim.js"></script>\n</body>');
      fs.writeFileSync(labIndexPath, labHtml);
    }
    console.log('    Injected bridge-shim.js into lab/index.html');
  }

  // 2. Copy notebook into lite/files/
  const filesDir = path.join(buildDir, 'lite', 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.copyFileSync(project.mainNotebook, path.join(filesDir, 'assignment.ipynb'));

  // 3. Copy additional data files if present
  if (project.hasData) {
    copyDirRecursive(path.join(project.dir, 'data'), path.join(filesDir, 'data'));
  }

  // 4. Copy any other files from the project directory (not .ipynb, zest.json, or requirements.txt)
  if (project.dir) {
    const extras = fs.readdirSync(project.dir).filter(f => {
      return !f.endsWith('.ipynb') && f !== 'zest.json' && f !== 'requirements.txt'
        && f !== 'data' && !f.startsWith('.');
    });
    for (const extra of extras) {
      const src = path.join(project.dir, extra);
      const dest = path.join(filesDir, extra);
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        copyDirRecursive(src, dest);
      } else {
        fs.copyFileSync(src, dest);
      }
    }
  }

  // 5. Generate index.html from template
  let indexHtml = readTemplate('index.html');
  indexHtml = indexHtml.replace(/\{\{NOTEBOOK_TITLE\}\}/g, title);
  fs.writeFileSync(path.join(buildDir, 'index.html'), indexHtml);

  // 6. Copy bridge.js
  fs.copyFileSync(path.join(TEMPLATE_DIR, 'bridge.js'), path.join(buildDir, 'bridge.js'));

  // 7. Copy review.html
  fs.copyFileSync(path.join(TEMPLATE_DIR, 'review.html'), path.join(buildDir, 'review.html'));

  // 8. Generate zest.json (use project override or generate from template)
  let zestJson;
  if (project.hasZestJson) {
    zestJson = JSON.parse(fs.readFileSync(path.join(project.dir, 'zest.json'), 'utf8'));
  } else {
    zestJson = JSON.parse(readTemplate('zest.json'));
    zestJson.name = title;
    zestJson.description = 'Interactive ' + title + ' notebook powered by JupyterLite.';
  }
  // Ensure required fields
  if (!zestJson.reviewFile) zestJson.reviewFile = 'review.html';
  fs.writeFileSync(path.join(buildDir, 'zest.json'), JSON.stringify(zestJson, null, 2));

  // 9. Create zip
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  try {
    execSync(`cd "${buildDir}" && zip -r "${zipPath}" . -x '.*'`, { stdio: 'pipe' });
  } catch (e) {
    console.error('  ✗ Zip creation failed:', e.message);
    return false;
  }

  // 10. Get zip size
  const zipStat = fs.statSync(zipPath);
  const sizeMB = (zipStat.size / 1024 / 1024).toFixed(1);

  console.log(`  ✓ ${project.slug}.zip (${sizeMB} MB)`);
  return true;
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Zest JupyterLite Build Tool');
  console.log('═══════════════════════════════════════════════════');

  // Discover projects
  let projects;

  if (flags.single) {
    // Single notebook mode
    const nbPath = path.resolve(flags.single);
    if (!fs.existsSync(nbPath)) {
      console.error('Notebook not found:', nbPath);
      process.exit(1);
    }
    const name = path.basename(nbPath, '.ipynb');
    projects = [{
      name,
      slug: slugify(name),
      dir: null,
      mainNotebook: nbPath,
      mainNotebookName: path.basename(nbPath),
      hasZestJson: false,
      hasRequirements: false,
      hasData: false
    }];
  } else {
    const baseDir = flags.dir ? path.resolve(flags.dir) : DEFAULT_NOTEBOOKS_DIR;
    console.log('Source:', baseDir);
    projects = discoverProjects(baseDir);
  }

  console.log('Found', projects.length, 'notebook project(s)\n');

  if (projects.length === 0) {
    console.log('No notebooks found. Place .ipynb files in the examples/ directory.');
    process.exit(0);
  }

  if (flags.dryRun) {
    console.log('DRY RUN — would build:');
    for (const p of projects) {
      console.log(`  ${p.slug} — ${p.mainNotebookName}` +
        (p.hasData ? ' +data' : '') +
        (p.hasRequirements ? ' +requirements' : '') +
        (p.hasZestJson ? ' +zest.json' : ''));
    }
    process.exit(0);
  }

  // Ensure dist directory
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(path.join(DIST_DIR, '.build'), { recursive: true });

  // Build each project
  let success = 0;
  let failed = 0;

  for (const project of projects) {
    console.log(`Building: ${project.slug}`);
    if (buildProject(project)) {
      success++;
    } else {
      failed++;
    }
  }

  // Clean up build directory
  const buildTmpDir = path.join(DIST_DIR, '.build');
  if (fs.existsSync(buildTmpDir)) {
    fs.rmSync(buildTmpDir, { recursive: true });
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  Done: ${success} built, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════');
}

main();
