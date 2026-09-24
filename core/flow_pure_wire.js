/**
 * Pure Wire Batchexecute RPC Client for Google Flow (flow.google.com)
 * Architecture based on crisng95/flowboard v1.3.0 & Google Flow Wire Protocol.
 * 
 * Strict Doctrine:
 * 1. ZERO UI interaction: No clicking, typing, or DOM scraping.
 * 2. Idle session host: The Flow tab is kept open only for cookies, WIZ_global_data, and reCAPTCHA.
 * 3. Pure MAIN-world fetch: Batchexecute requests are sent directly via fetch() in page context.
 * 4. Anti-bot trap bypass: Automatically recovers the native unhijacked reCAPTCHA execute function
 *    from closure scopes to avoid Google's "extension_hijack_detected" honeypot.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';

export const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

// Aspect code mappings: 1=Square (1:1), 2=Portrait (9:16), 3=Landscape (16:9), 4=3:4, 5=4:3
export const IMAGE_ASPECT_CODES = {
  '1:1': 1,
  'square': 1,
  'SQUARE': 1,
  '9:16': 2,
  'portrait': 2,
  'PORTRAIT': 2,
  'vertical': 2,
  '16:9': 3,
  'landscape': 3,
  'LANDSCAPE': 3,
  '3:4': 4,
  '4:3': 5
};

// Video aspect codes: 1=Portrait (9:16), 2=Landscape (16:9)
export const VIDEO_ASPECT_CODES = {
  '9:16': 1,
  'portrait': 1,
  'PORTRAIT': 1,
  'vertical': 1,
  '16:9': 2,
  'landscape': 2,
  'LANDSCAPE': 2,
  '1:1': 1 // fallback to portrait for vertical reels
};

export async function getFlowTab(cdpPort = 9333) {
  const resp = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  const tabs = await resp.json();
  const tab = tabs.find(t => t.url && t.url.includes('flow.google.com'));
  if (!tab) throw new Error(`No live Flow tab found on CDP port ${cdpPort}`);
  return tab;
}

export async function connectCDP(tab) {
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let idCounter = 1;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const curId = idCounter++;
    const handler = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.id === curId) {
          ws.removeEventListener('message', handler);
          if (msg.error) reject(msg.error);
          else resolve(msg.result);
        }
      } catch (err) {
        // ignore malformed ws messages
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id: curId, method, params }));
  });

  return { ws, send, close: () => ws.close() };
}

/**
 * Recovers Google's unhijacked reCAPTCHA execute function from closure scopes if monkey-patched.
 * Also waits for reCAPTCHA enterprise to be ready after page load/account switch.
 */
export async function unhijackCaptcha(cdp, maxWaitMs = 15000) {
  const start = Date.now();
  // 1. Wait for window.grecaptcha?.enterprise to be loaded
  while (Date.now() - start < maxWaitMs) {
    const readyCheck = await cdp.send('Runtime.evaluate', {
      expression: '!!(window.grecaptcha && window.grecaptcha.enterprise && typeof window.grecaptcha.enterprise.execute === "function")'
    });
    if (readyCheck?.result?.value === true) break;
    await new Promise(r => setTimeout(r, 500));
  }

  const evalRes = await cdp.send('Runtime.evaluate', {
    expression: 'window.grecaptcha?.enterprise?.execute ? window.grecaptcha.enterprise.execute.toString() : null'
  });
  const fnStr = evalRes?.result?.value || '';

  if (fnStr.includes('extension_hijack_detected')) {
    // Hijack detected! Recover original function d from [[Scopes]][0]
    const fnObj = await cdp.send('Runtime.evaluate', {
      expression: 'window.grecaptcha.enterprise.execute'
    });
    const objId = fnObj.result.objectId;
    const props = await cdp.send('Runtime.getProperties', { objectId: objId });
    const scopesProp = props.internalProperties?.find(p => p.name === '[[Scopes]]');
    if (!scopesProp?.value?.objectId) throw new Error('Cannot find [[Scopes]] on grecaptcha.enterprise.execute');

    const scopeList = await cdp.send('Runtime.getProperties', { objectId: scopesProp.value.objectId });
    const scope0 = scopeList.result[0];
    const s0Props = await cdp.send('Runtime.getProperties', { objectId: scope0.value.objectId });
    const dVar = s0Props.result?.find(v => v.name === 'd');
    if (!dVar?.value?.objectId) throw new Error('Cannot find original execute function d in scope');

    await cdp.send('Runtime.callFunctionOn', {
      functionDeclaration: 'function(realFn) { window.grecaptcha.enterprise.execute = realFn; return true; }',
      objectId: objId,
      arguments: [dVar.value]
    });
  }
  return true;
}

/**
 * Uploads a local image (Base64) to Google Flow via RPC maseQ (Pure Wire).
 * Returns { success: true, mediaId, projectId }
 */
export async function uploadImageWire({
  imagePath,
  imageBase64 = null,
  fileName = 'upload.jpg',
  mimeType = 'image/jpeg',
  cdpPort = 9333
}) {
  const b64 = imageBase64 || fs.readFileSync(imagePath).toString('base64');
  const tab = await getFlowTab(cdpPort);
  const cdp = await connectCDP(tab);

  try {
    await unhijackCaptcha(cdp);

    const pageScript = `
    (async () => {
      try {
        const SITE_KEY = '${SITE_KEY}';
        const token = await window.grecaptcha.enterprise.execute(SITE_KEY, { action: 'IMAGE_GENERATION' });

        const wiz = globalThis.WIZ_global_data || {};
        const at = wiz.SNlM0e;
        const sid = wiz.FdrFJe;
        const bl = wiz.cfb2h;
        if (!at) throw new Error('NO_AT_TOKEN');

        const reqid = Math.floor(Math.random() * 900000) + 100000;
        const sourcePath = location.pathname || '/';
        const hl = 'en';
        const url =
          '/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=maseQ' +
          '&source-path=' + encodeURIComponent(sourcePath) +
          '&bl=' + encodeURIComponent(bl || '') +
          '&f.sid=' + encodeURIComponent(sid || '') +
          '&hl=' + encodeURIComponent(hl) +
          '&_reqid=' + reqid + '&rt=c';

        const projId = location.pathname.split('/project/')[1] || '';
        const uuid1 = crypto.randomUUID().toUpperCase();
        const uuid2 = crypto.randomUUID().toUpperCase();

        const context = [null, 22, null, null, null, projId, null, null, null, null, [token, 1]];
        const inner = [
          context,
          ${JSON.stringify(b64)},
          '${mimeType}',
          1,
          null, null, null, null,
          '${fileName}',
          null,
          uuid1,
          uuid2
        ];

        const freqStr = JSON.stringify([[["maseQ", JSON.stringify(inner), null, "generic"]]]);

        const resp = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'x-same-domain': '1',
          },
          body: new URLSearchParams({ 'f.req': freqStr, at }),
        });

        const text = await resp.text();
        return { status: resp.status, text };
      } catch (err) {
        return { error: err.message, stack: err.stack };
      }
    })()
    `;

    const res = await cdp.send('Runtime.evaluate', {
      expression: pageScript,
      awaitPromise: true,
      returnByValue: true
    });

    const result = res.result?.value;
    if (!result) throw new Error('No result returned from evaluate');
    if (result.error) throw new Error(`Upload RPC Error: ${result.error}`);

    // Parse envelope: [["mediaId", "projectId", "opId", "CAE", ...]]
    const uuidRegex = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;
    const matches = result.text.match(uuidRegex) || [];
    if (!matches.length) {
      throw new Error(`Upload failed to return mediaId: ${result.text.slice(0, 300)}`);
    }

    const mediaId = matches[0];
    const projectId = matches[1] || '';

    return {
      success: true,
      mediaId,
      projectId
    };
  } finally {
    cdp.close();
  }
}

/**
 * Generates an ad image via pure Batchexecute wire RPC ogiZ0b (0 credits).
 * Returns { success: true, mediaId, url }
 */
export async function generateImage({
  prompt,
  referenceMediaIds = [],
  aspect = '9:16',
  model = 'NARWHAL',
  cdpPort = 9333,
  timeoutMs = 60000
}) {
  const tab = await getFlowTab(cdpPort);
  const cdp = await connectCDP(tab);

  try {
    await unhijackCaptcha(cdp);

    const aspectCode = typeof aspect === 'number' ? aspect : (IMAGE_ASPECT_CODES[aspect] || 2);

    const pageScript = `
    (async () => {
      try {
        const SITE_KEY = '${SITE_KEY}';
        const token = await window.grecaptcha.enterprise.execute(SITE_KEY, { action: 'IMAGE_GENERATION' });

        const wiz = globalThis.WIZ_global_data || {};
        const at = wiz.SNlM0e;
        const sid = wiz.FdrFJe;
        const bl = wiz.cfb2h;
        if (!at) throw new Error('NO_AT_TOKEN');

        const reqid = Math.floor(Math.random() * 900000) + 100000;
        const sourcePath = location.pathname || '/';
        const hl = (document.documentElement.lang || navigator.language || 'en').split('-')[0];
        const url =
          '/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=ogiZ0b' +
          '&source-path=' + encodeURIComponent(sourcePath) +
          '&bl=' + encodeURIComponent(bl || '') +
          '&f.sid=' + encodeURIComponent(sid || '') +
          '&hl=' + encodeURIComponent(hl) +
          '&_reqid=' + reqid + '&rt=c';

        const projId = location.pathname.split('/project/')[1] || '';
        const seed = Math.floor(Math.random() * 2000000000);
        const uuid1 = crypto.randomUUID().toUpperCase();
        const uuid2 = crypto.randomUUID().toUpperCase();
        const uuid3 = crypto.randomUUID().toUpperCase();

        const refs = [...new Set(${JSON.stringify(referenceMediaIds)}.map(v => String(v || '').trim()).filter(Boolean))];
        const refPart = refs.length ? refs.map(id => [id, null, null, null, 1]) : null;

        const item0 = [
          null, null, refPart, seed, ${aspectCode}, '${model}', null,
          [null, 22, null, null, null, projId, null, null, null, null, [token, 1]],
          [[[${JSON.stringify(prompt)}]]],
          null, null, null, uuid1, uuid2
        ];

        const inner = [
          null,
          [item0],
          1,
          [null, 22, null, null, null, projId, null, null, null, null, [token, 1]],
          [uuid3]
        ];

        const freqStr = JSON.stringify([[["ogiZ0b", JSON.stringify(inner), null, "generic"]]]);

        const resp = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'x-same-domain': '1',
          },
          body: new URLSearchParams({ 'f.req': freqStr, at }),
        });

        const text = await resp.text();
        return { status: resp.status, text };
      } catch (err) {
        return { error: err.message, stack: err.stack };
      }
    })()
    `;

    const res = await cdp.send('Runtime.evaluate', {
      expression: pageScript,
      awaitPromise: true,
      returnByValue: true
    });

    const result = res.result?.value;
    if (!result) throw new Error('No result returned from evaluate');
    if (result.error) throw new Error(`RPC Script Error: ${result.error}`);

    // Parse Batchexecute envelope
    const startIdx = result.text.indexOf('https://flow-content.google/image/');
    if (startIdx === -1) {
      if (result.text.includes('PUBLIC_ERROR_UNUSUAL_ACTIVITY')) {
        throw new Error('Google returned PUBLIC_ERROR_UNUSUAL_ACTIVITY');
      }
      throw new Error(`Failed to extract image CDN URL from response: ${result.text.slice(0, 300)}`);
    }

    let endIdx = result.text.indexOf('"', startIdx);
    if (endIdx === -1) endIdx = result.text.length;
    let rawUrl = result.text.slice(startIdx, endIdx);
    const unescapedUrl = rawUrl
      .replace(/\\+u003d/gi, '=')
      .replace(/\\+u0026/gi, '&')
      .replace(/\\+/g, '');

    const midMatch = unescapedUrl.match(/https:\/\/flow-content\.google\/image\/([a-zA-Z0-9_-]+)/);
    const mediaId = midMatch ? midMatch[1] : '';

    return {
      success: true,
      mediaId,
      url: unescapedUrl
    };
  } finally {
    cdp.close();
  }
}

/**
 * Generates an Omni Flash video (Reference-to-Video) via RPC MZZa6b.
 * Returns { success: true, mediaId, operationId, projectId, model }
 */
export async function submitOmniVideo({
  prompt,
  referenceMediaIds = [],
  durationS = 10,
  aspect = '9:16',
  cdpPort = 9333
}) {
  if (!referenceMediaIds.length) {
    throw new Error('Omni Flash reference-to-video requires at least one reference mediaId');
  }

  const tab = await getFlowTab(cdpPort);
  const cdp = await connectCDP(tab);

  try {
    await unhijackCaptcha(cdp);

    const aspectCode = typeof aspect === 'number' ? aspect : (VIDEO_ASPECT_CODES[aspect] || 1);
    const model = `abra_r2v_${durationS}s`;

    const pageScript = `
    (async () => {
      try {
        const SITE_KEY = '${SITE_KEY}';
        const token = await window.grecaptcha.enterprise.execute(SITE_KEY, { action: 'VIDEO_GENERATION' });

        const wiz = globalThis.WIZ_global_data || {};
        const at = wiz.SNlM0e;
        const sid = wiz.FdrFJe;
        const bl = wiz.cfb2h;
        if (!at) throw new Error('NO_AT_TOKEN');

        const reqid = Math.floor(Math.random() * 900000) + 100000;
        const sourcePath = location.pathname || '/';
        const hl = 'en';
        const url =
          '/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=MZZa6b' +
          '&source-path=' + encodeURIComponent(sourcePath) +
          '&bl=' + encodeURIComponent(bl || '') +
          '&f.sid=' + encodeURIComponent(sid || '') +
          '&hl=' + encodeURIComponent(hl) +
          '&_reqid=' + reqid + '&rt=c';

        const projId = location.pathname.split('/project/')[1] || '';
        const uuid1 = crypto.randomUUID().toUpperCase();
        const uuid2 = crypto.randomUUID().toUpperCase();
        const uuid3 = crypto.randomUUID().toUpperCase();

        const refs = ${JSON.stringify(referenceMediaIds)}.map(mid => [null, mid]);
        const request = [
          [null, null, [[[${JSON.stringify(prompt)}]]]],
          refs,
          '${model}',
          ${aspectCode},
          null,
          [null, null, null, null, uuid1, uuid2]
        ];

        const context = [null, 22, null, null, null, projId, null, null, null, null, [token, 1]];
        const inner = [
          [request],
          context,
          [uuid3, 2]
        ];

        const freqStr = JSON.stringify([[["MZZa6b", JSON.stringify(inner), null, "generic"]]]);

        const resp = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'x-same-domain': '1',
          },
          body: new URLSearchParams({ 'f.req': freqStr, at }),
        });

        const text = await resp.text();
        return { status: resp.status, text };
      } catch (err) {
        return { error: err.message, stack: err.stack };
      }
    })()
    `;

    const res = await cdp.send('Runtime.evaluate', {
      expression: pageScript,
      awaitPromise: true,
      returnByValue: true
    });

    const result = res.result?.value;
    if (!result) throw new Error('No result returned from evaluate');
    if (result.error) throw new Error(`Video Submit RPC Error: ${result.error}`);

    // Parse envelope
    const uuidRegex = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;
    const matches = result.text.match(uuidRegex) || [];
    if (!matches.length) {
      throw new Error(`Video submit failed: ${result.text.slice(0, 300)}`);
    }

    // In MZZa6b response:
    // matches[0] = operationId, matches[1] = mediaId, matches[3] = projectId
    const operationId = matches[0];
    const mediaId = matches[1];
    const projectId = matches[3] || matches[2] || '';

    return {
      success: true,
      operationId,
      mediaId,
      projectId,
      model
    };
  } finally {
    cdp.close();
  }
}

/**
 * Polls for completed video URL via RPC as29s and downloads it to destination.
 */
export async function pollAndDownloadVideo({
  mediaId,
  outputPath,
  cdpPort = 9333,
  maxWaitSec = 180,
  pollIntervalSec = 6,
  onProgress = null
}) {
  const tab = await getFlowTab(cdpPort);
  const cdp = await connectCDP(tab);

  try {
    const fetchMediaScript = (mid) => `
    (async () => {
      try {
        const wiz = globalThis.WIZ_global_data || {};
        const at = wiz.SNlM0e;
        const sid = wiz.FdrFJe;
        const bl = wiz.cfb2h;
        if (!at) throw new Error('NO_AT_TOKEN');

        const reqid = Math.floor(Math.random() * 900000) + 100000;
        const url = "/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=as29s&source-path=" + encodeURIComponent(location.pathname) + "&bl=" + encodeURIComponent(bl||"") + "&f.sid=" + encodeURIComponent(sid||"") + "&hl=en&_reqid=" + reqid + "&rt=c";
        const inner = ["${mid}"];
        const freqStr = JSON.stringify([[["as29s", JSON.stringify(inner), null, "generic"]]]);
        const resp = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "x-same-domain": "1" },
          body: new URLSearchParams({ "f.req": freqStr, at })
        });
        return await resp.text();
      } catch (err) {
        return "ERROR: " + err.message;
      }
    })()
    `;

    const startTime = Date.now();
    let videoUrl = null;

    while (Date.now() - startTime < maxWaitSec * 1000) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (onProgress) onProgress(elapsed);

      const res = await cdp.send('Runtime.evaluate', {
        expression: fetchMediaScript(mediaId),
        awaitPromise: true,
        returnByValue: true
      });

      const text = res.result?.value || '';
      if (text.includes('/video/')) {
        const startIdx = text.indexOf('https://flow-content.google/video/');
        if (startIdx !== -1) {
          let endIdx = text.indexOf('"', startIdx);
          if (endIdx === -1) endIdx = text.length;
          let rawUrl = text.slice(startIdx, endIdx);
          videoUrl = rawUrl
            .replace(/\\+u003d/gi, '=')
            .replace(/\\+u0026/gi, '&')
            .replace(/\\+/g, '');
          break;
        }
      }

      await new Promise(r => setTimeout(r, pollIntervalSec * 1000));
    }

    if (!videoUrl) {
      throw new Error(`Video generation timed out after ${maxWaitSec}s for media ${mediaId}`);
    }

    // Download to disk via curl (reliable across TLS/IPv6 networks)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const { execSync } = await import('child_process');
    execSync(`curl -sL --retry 3 "${videoUrl}" -o "${outputPath}"`);
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      throw new Error(`Failed to download MP4 from ${videoUrl}`);
    }
    const stat = fs.statSync(outputPath);

    return {
      success: true,
      videoUrl,
      sizeBytes: stat.size,
      outputPath
    };
  } finally {
    cdp.close();
  }
}
