'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PUBLIC_ASSETS, SECURITY_HEADERS } = require('../serve.js');

const projectRoot = path.join(__dirname, '..');
const defaultOutputDirectory = path.join(projectRoot, 'dist');

const GENERATED_FILE_NAMES = new Set([
  ...[...PUBLIC_ASSETS.keys()]
    .filter((requestPath) => requestPath !== '/')
    .map((requestPath) => requestPath.slice(1)),
  'staticwebapp.config.json'
]);

// The build clears its output directory, and the CLI forwards an arbitrary path here,
// so look at the target before deleting it. Without this, `npm run build -- .` would
// delete the repository and `npm run build -- ..` everything beside it.
function assertSafeOutputDirectory(resolvedOutput) {
  const toProjectRoot = path.relative(resolvedOutput, projectRoot);
  const isProjectRootOrAncestor = toProjectRoot === ''
    || !(toProjectRoot.startsWith('..') || path.isAbsolute(toProjectRoot));
  if (isProjectRootOrAncestor) {
    throw new Error(
      `Refusing to build into ${resolvedOutput}: it is the project directory or one of its ancestors.`
    );
  }

  let existingEntries;
  try {
    existingEntries = fs.readdirSync(resolvedOutput);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    if (error.code === 'ENOTDIR') {
      throw new Error(`Refusing to build into ${resolvedOutput}: it is not a directory.`);
    }
    throw error;
  }

  const unexpected = existingEntries.filter((entry) => !GENERATED_FILE_NAMES.has(entry));
  if (unexpected.length > 0) {
    throw new Error(
      `Refusing to delete ${resolvedOutput}: it holds files this build does not generate `
      + `(${unexpected.slice(0, 5).join(', ')}). Use an empty or previously generated output directory.`
    );
  }
}

function buildStatic(outputDirectory = defaultOutputDirectory) {
  const resolvedOutput = path.resolve(outputDirectory);
  assertSafeOutputDirectory(resolvedOutput);
  fs.rmSync(resolvedOutput, { recursive: true, force: true });
  fs.mkdirSync(resolvedOutput, { recursive: true });

  for (const [requestPath, asset] of PUBLIC_ASSETS) {
    if (requestPath === '/') continue;
    const destination = path.join(resolvedOutput, requestPath.slice(1));
    fs.copyFileSync(path.join(projectRoot, asset.fileName), destination);
  }

  fs.writeFileSync(path.join(resolvedOutput, 'staticwebapp.config.json'), `${JSON.stringify({
    globalHeaders: SECURITY_HEADERS
  }, null, 2)}\n`);

  return resolvedOutput;
}

if (require.main === module) {
  const outputDirectory = buildStatic(process.argv[2]);
  console.log(`Built static deployment package in ${path.relative(process.cwd(), outputDirectory)}`);
}

module.exports = { buildStatic };
