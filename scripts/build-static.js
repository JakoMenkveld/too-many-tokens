'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PUBLIC_ASSETS, SECURITY_HEADERS } = require('../serve.js');

const projectRoot = path.join(__dirname, '..');
const defaultOutputDirectory = path.join(projectRoot, 'dist');

function buildStatic(outputDirectory = defaultOutputDirectory) {
  const resolvedOutput = path.resolve(outputDirectory);
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
