import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

// Use native Node resolution through each real consumer, including nested dependencies.
function runNode(source: string): void {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const assert = require('node:assert/strict');
      const { createRequire } = require('node:module');
      ${source}`
    ],
    { encoding: 'utf8', timeout: 10_000 }
  )
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stderr || result.stdout).toBe(0)
}

describe('security dependency compatibility', () => {
  it('preserves printable file-viewer content while removing executable markup', () => {
    runNode(`
      const { dirname, join } = require('node:path');
      const { pathToFileURL } = require('node:url');
      const { JSDOM } = require('jsdom');
      (async () => {
        const moduleUrl = pathToFileURL(join(dirname(require.resolve('@file-viewer/core')), 'exportDocument.js'));
        const { sanitizeFileViewerExportDocumentDom } = await import(moduleUrl.href);
        const dom = new JSDOM('<!DOCTYPE html><body></body>');
        const root = sanitizeFileViewerExportDocumentDom(
          '<html><body><b>data</b><a href="https://example.com" target="_blank">link</a><script>ATTACKER()</script><img onerror="ATTACKER()"></body></html>',
          dom.window.document
        );
        assert.equal(root.querySelector('b').textContent, 'data');
        assert.equal(root.querySelector('script'), null);
        assert.equal(root.querySelector('[onerror]'), null);
        assert.equal(root.querySelector('a').getAttribute('rel'), 'noopener noreferrer');
        dom.window.close();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `)
  })

  it('normalizes percent-encoded hosts through the AJV dependency', () => {
    runNode(`
      const ajvRequire = createRequire(require.resolve('ajv'));
      const uri = ajvRequire('fast-uri');
      assert.equal(uri.parse('//%41.com').host, 'a.com');
      assert.equal(uri.equal('//%41.com', '//a.com'), true);
      const Ajv = require('ajv');
      const validate = new Ajv().compile({
        type: 'object', properties: { count: { type: 'integer' } },
        required: ['count'], additionalProperties: false
      });
      assert.equal(validate({ count: 1 }), true);
      assert.equal(validate({ count: '1' }), false);
    `)
  })

  it('escapes root JSX strings through the MCP SDK Hono dependency', () => {
    runNode(`
      const sdkRequire = createRequire(require.resolve('@modelcontextprotocol/sdk/server/streamableHttp.js'));
      const { renderToString } = sdkRequire('hono/jsx/dom/server');
      const { jsx } = sdkRequire('hono/jsx');
      assert.equal(renderToString('<b>data</b>'), '&lt;b&gt;data&lt;/b&gt;');
      assert.equal(renderToString(jsx('b', null, 'data')), '<b>data</b>');
    `)
  })

  it('rejects cross-family subnets and preserves rate-limit IP keys', () => {
    runNode(`
      const sdkRequire = createRequire(require.resolve('@modelcontextprotocol/sdk/server/streamableHttp.js'));
      const rateLimitRequire = createRequire(sdkRequire.resolve('express-rate-limit'));
      const { Address4, Address6 } = rateLimitRequire('ip-address');
      assert.equal(new Address6('a00::1').isInSubnet(new Address4('10.0.0.0/8')), false);
      assert.equal(new Address4('32.0.0.1').isInSubnet(new Address6('2000::/3')), false);
      assert.equal(new Address6('2001:db8::1').isInSubnet(new Address6('2001:db8::/32')), true);
      const { ipKeyGenerator } = sdkRequire('express-rate-limit');
      assert.equal(ipKeyGenerator('192.0.2.1'), '192.0.2.1');
      assert.equal(ipKeyGenerator('::ffff:192.0.2.1'), '192.0.2.1');
      assert.equal(ipKeyGenerator('2001:db8::1'), ipKeyGenerator('2001:db8::2'));
      assert.notEqual(ipKeyGenerator('2001:db8::1'), ipKeyGenerator('2001:db9::1'));
    `)
  })

  it.each(['afterSanitizeElements', 'afterSanitizeAttributes'])(
    'neutralizes detached handlers in %s for file-viewer and Mermaid',
    (hook) => {
      runNode(`
        const { JSDOM } = require('jsdom');
        for (const consumer of ['@file-viewer/core', 'mermaid']) {
          const consumerRequire = createRequire(require.resolve(consumer));
          const dom = new JSDOM('<!DOCTYPE html><body></body>');
          const purifier = consumerRequire('dompurify')(dom.window);
          const root = dom.window.document.createElement('div');
          root.innerHTML = '<section><img src="x" onerror="ATTACKER()"></section>';
          dom.window.document.body.appendChild(root);
          const wrapper = root.firstElementChild;
          const image = wrapper.firstElementChild;
          purifier.addHook(${JSON.stringify(hook)}, (node) => {
            if (node === wrapper) node.remove();
          });
          purifier.sanitize(root, { IN_PLACE: true });
          assert.equal(wrapper.parentNode, null);
          assert.equal(image.hasAttribute('onerror'), false, consumer);
          assert.equal(purifier.sanitize('<b>data</b><script>ATTACKER()</script>'), '<b>data</b>');
          dom.window.close();
        }
      `)
    }
  )
})
