'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');

const {
	createStaticServer,
	DEFAULT_HOST
} = require('../serve');

let server;

before(async () => {
	server = createStaticServer();

	await new Promise((resolve, reject) => {
		const onError = (error) => {
			reject(error);
		};

		server.once('error', onError);
		server.listen(0, DEFAULT_HOST, () => {
			server.off('error', onError);
			resolve();
		});
	});
});

after(async () => {
	if (server === undefined || !server.listening) {
		return;
	}

	await new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
});

function request(target, { method = 'GET', headers = {} } = {}) {
	const address = server.address();

	return new Promise((resolve, reject) => {
		const req = http.request({
			host: DEFAULT_HOST,
			port: address.port,
			method,
			path: target,
			headers,
			agent: false
		}, (res) => {
			const chunks = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => {
				resolve({
					statusCode: res.statusCode,
					headers: res.headers,
					body: Buffer.concat(chunks)
				});
			});
		});

		req.on('error', reject);
		req.end();
	});
}

test('the factory does not listen until the caller chooses an address', () => {
	const idleServer = createStaticServer();
	assert.equal(idleServer.listening, false);
});

test('serves every allowlisted public asset with the correct content type', async () => {
	const publicAssets = [
		['/', 'text/html; charset=utf-8'],
		['/index.html', 'text/html; charset=utf-8'],
		['/styles.css', 'text/css; charset=utf-8'],
		['/tracker-core.js', 'application/javascript; charset=utf-8'],
		['/providers.js', 'application/javascript; charset=utf-8'],
		['/app.js', 'application/javascript; charset=utf-8']
	];

	for (const [target, contentType] of publicAssets) {
		const response = await request(target);
		assert.equal(response.statusCode, 200, target);
		assert.equal(response.headers['content-type'], contentType, target);
		assert.equal(Number(response.headers['content-length']), response.body.byteLength, target);
		assert.ok(response.body.byteLength > 0, target);
	}

	const rootResponse = await request('/');
	const indexResponse = await request('/index.html');
	assert.deepEqual(rootResponse.body, indexResponse.body);
});

test('parses query strings and encoded public filenames without broadening access', async () => {
	const queryResponse = await request('/styles.css?cache-bust=123');
	assert.equal(queryResponse.statusCode, 200);

	const encodedResponse = await request('/%69ndex.html');
	assert.equal(encodedResponse.statusCode, 200);
	assert.equal(encodedResponse.headers['content-type'], 'text/html; charset=utf-8');

	const malformedResponse = await request('/%zz');
	assert.equal(malformedResponse.statusCode, 400);

	const authorityResponse = await request('//example.test/index.html');
	assert.equal(authorityResponse.statusCode, 400);
});

test('denies private repository files and path traversal attempts', async () => {
	const deniedTargets = [
		'/package.json',
		'/serve.js',
		'/docs/implementation-summary.md',
		'/chrome-extension/manifest.json',
		'/../package.json',
		'/%2e%2e/package.json',
		'/%2e%2e%2fpackage.json',
		'/nested/../../package.json',
		'/app.js/../index.html',
		'/%2e/index.html'
	];

	for (const target of deniedTargets) {
		const response = await request(target);
		assert.equal(response.statusCode, 404, target);
		assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8', target);
		assert.equal(response.body.toString('utf8'), '404 Not Found\n', target);
	}
});

test('allows GET and HEAD only', async () => {
	for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
		const response = await request('/index.html', { method });
		assert.equal(response.statusCode, 405, method);
		assert.equal(response.headers.allow, 'GET, HEAD', method);
		assert.equal(response.body.toString('utf8'), '405 Method Not Allowed\n', method);
	}
});

test('HEAD returns GET-equivalent headers without a body', async () => {
	const getResponse = await request('/app.js');
	const headResponse = await request('/app.js', { method: 'HEAD' });

	assert.equal(headResponse.statusCode, 200);
	assert.equal(headResponse.headers['content-type'], getResponse.headers['content-type']);
	assert.equal(headResponse.headers['content-length'], getResponse.headers['content-length']);
	assert.equal(headResponse.body.byteLength, 0);

	const missingHeadResponse = await request('/package.json', { method: 'HEAD' });
	assert.equal(missingHeadResponse.statusCode, 404);
	assert.equal(missingHeadResponse.body.byteLength, 0);
	assert.equal(Number(missingHeadResponse.headers['content-length']), Buffer.byteLength('404 Not Found\n'));
});

test('adds no-store and browser hardening headers to success and error responses', async () => {
	for (const target of ['/', '/not-public']) {
		const response = await request(target);
		assert.equal(response.headers['cache-control'], 'no-store', target);
		assert.equal(response.headers['x-content-type-options'], 'nosniff', target);
		assert.equal(response.headers['x-frame-options'], 'DENY', target);
		assert.equal(response.headers['referrer-policy'], 'no-referrer', target);
		assert.match(response.headers['content-security-policy'], /default-src 'self'/u, target);
		assert.match(response.headers['permissions-policy'], /camera=\(\)/u, target);
	}
});
