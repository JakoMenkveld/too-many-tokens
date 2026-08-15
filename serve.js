'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 5074;
const REQUEST_ORIGIN = `http://${DEFAULT_HOST}`;

const PUBLIC_ASSETS = new Map([
	['/', { fileName: 'index.html', contentType: 'text/html; charset=utf-8' }],
	['/index.html', { fileName: 'index.html', contentType: 'text/html; charset=utf-8' }],
	['/styles.css', { fileName: 'styles.css', contentType: 'text/css; charset=utf-8' }],
	['/tracker-core.js', { fileName: 'tracker-core.js', contentType: 'application/javascript; charset=utf-8' }],
	['/providers.js', { fileName: 'chrome-extension/providers.js', contentType: 'application/javascript; charset=utf-8' }],
	['/app.js', { fileName: 'app.js', contentType: 'application/javascript; charset=utf-8' }]
]);

const SECURITY_HEADERS = Object.freeze({
	'Cache-Control': 'no-store',
	'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
	'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
	'Referrer-Policy': 'no-referrer',
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'DENY'
});

class InvalidRequestTargetError extends Error {}

function parseRequestPath(requestTarget) {
	if (
		typeof requestTarget !== 'string' ||
		!requestTarget.startsWith('/') ||
		requestTarget.startsWith('//') ||
		/[\u0000-\u001f\u007f]/u.test(requestTarget)
	) {
		throw new InvalidRequestTargetError();
	}

	let parsed;
	try {
		parsed = new URL(requestTarget, REQUEST_ORIGIN);
	} catch {
		throw new InvalidRequestTargetError();
	}

	if (parsed.origin !== REQUEST_ORIGIN) {
		throw new InvalidRequestTargetError();
	}

	const delimiterIndex = requestTarget.search(/[?#]/u);
	const encodedPath = delimiterIndex === -1
		? requestTarget
		: requestTarget.slice(0, delimiterIndex);

	let pathname;
	try {
		pathname = decodeURIComponent(encodedPath);
	} catch {
		throw new InvalidRequestTargetError();
	}

	const pathSegments = pathname.split('/');
	if (
		pathname.includes('\\') ||
		pathname.includes('\0') ||
		pathSegments.some((segment) => segment === '.' || segment === '..')
	) {
		return null;
	}

	return pathname;
}

function sendResponse(req, res, statusCode, body, headers = {}) {
	const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');

	res.writeHead(statusCode, {
		...SECURITY_HEADERS,
		...headers,
		'Content-Length': String(payload.byteLength)
	});

	res.end(req.method === 'HEAD' ? undefined : payload);
}

function sendTextResponse(req, res, statusCode, message, headers = {}) {
	sendResponse(req, res, statusCode, `${message}\n`, {
		'Content-Type': 'text/plain; charset=utf-8',
		...headers
	});
}

function createStaticServer(options = {}) {
	const rootDir = options.rootDir === undefined
		? __dirname
		: path.resolve(options.rootDir);

	return http.createServer((req, res) => {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			sendTextResponse(req, res, 405, '405 Method Not Allowed', {
				Allow: 'GET, HEAD'
			});
			return;
		}

		let requestPath;
		try {
			requestPath = parseRequestPath(req.url);
		} catch (error) {
			if (error instanceof InvalidRequestTargetError) {
				sendTextResponse(req, res, 400, '400 Bad Request');
				return;
			}
			throw error;
		}

		const asset = requestPath === null ? undefined : PUBLIC_ASSETS.get(requestPath);
		if (asset === undefined) {
			sendTextResponse(req, res, 404, '404 Not Found');
			return;
		}

		// The request never contributes to this path; only fixed allowlisted names do.
		const filePath = path.join(rootDir, asset.fileName);
		fs.readFile(filePath, (error, content) => {
			if (error) {
				if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR') {
					sendTextResponse(req, res, 404, '404 Not Found');
					return;
				}

				sendTextResponse(req, res, 500, '500 Internal Server Error');
				return;
			}

			sendResponse(req, res, 200, content, {
				'Content-Type': asset.contentType
			});
		});
	});
}

function parsePort(value) {
	if (value === undefined || value === '') {
		return DEFAULT_PORT;
	}

	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new RangeError(`Invalid PORT value: ${value}`);
	}

	return port;
}

if (require.main === module) {
	const host = DEFAULT_HOST;
	const port = parsePort(process.env.PORT);
	const server = createStaticServer();

	server.listen(port, host, () => {
		const address = server.address();
		const listeningPort = typeof address === 'object' && address !== null
			? address.port
			: port;
		console.log(`Static server running at http://${host}:${listeningPort}`);
	});
}

module.exports = {
	createStaticServer,
	DEFAULT_HOST,
	DEFAULT_PORT,
	PUBLIC_ASSETS,
	SECURITY_HEADERS
};
