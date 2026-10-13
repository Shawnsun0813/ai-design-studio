// Minimal Chrome DevTools Protocol helper shared by Phase02 checks (no dependencies).
// Starts its own headless Chrome with an isolated profile and only ever kills that process.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

export async function assertFree(port) {
  for (const host of ['127.0.0.1', '::1']) {
    const used = await new Promise((resolve) => {
      const s = net.createServer().once('error', (e) => resolve(e.code === 'EADDRINUSE')).once('listening', () => s.close(() => resolve(false)));
      s.listen(port, host);
    });
    if (used) throw new Error(`port ${port} already in use on ${host}`);
  }
}

export async function launch({ port, width = 1440, height = 900 }) {
  await assertFree(port);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'p02-chrome-'));
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let ws;
  for (let i = 0; i < 60 && !ws; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch {}
    if (!ws) await wait(200);
  }
  if (!ws) { proc.kill(); throw new Error('chrome did not start'); }
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) listeners.forEach((f) => f(m));
  });
  // A command the browser never answers used to hang the whole check for hours (an iframe being replaced by
  // Vite's reload while a Runtime.evaluate was in flight). A stuck call now fails loudly and names itself.
  const send = (method, params = {}, ms = 30000) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} did not answer within ${Math.round(ms / 1000)}s`)); }, ms);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m.error ? { error: m.error } : m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expr, contextId) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result?.value;
  };
  async function until(fn, label, ms = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = await fn().catch(() => undefined); if (v) return v; await wait(120); }
    throw new Error(`timeout: ${label}`);
  }
  const goto = async (url) => { await send('Page.navigate', { url }); await wait(300); await until(() => evaluate('document.readyState === "complete"'), 'load'); };
  async function click(x, y) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await wait(150);
  }
  const boxOf = (expr) => evaluate(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
  async function clickSel(sel) { const b = await until(() => boxOf(`document.querySelector(${JSON.stringify(sel)})`), sel); await click(b.x, b.y); }
  async function clickText(text, scope = 'button') {
    const b = await until(() => boxOf(`[...document.querySelectorAll(${JSON.stringify(scope)})].find((e) => e.textContent.includes(${JSON.stringify(text)}))`), text);
    await click(b.x, b.y);
  }
  async function shot(file, clip) {
    const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    const buf = Buffer.from(r.data, 'base64');
    if (file) fs.writeFileSync(file, buf);
    return buf;
  }
  // Isolated-world evaluation inside the first child iframe (used for the target page).
  async function inFrame(expr) {
    const tree = await send('Page.getFrameTree');
    const child = tree.frameTree.childFrames?.[0]?.frame;
    if (!child) return undefined;
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: child.id, worldName: 'p02' });
    return evaluate(expr, executionContextId);
  }
  const close = () => { try { ws.close(); } catch {} proc.kill(); };
  return { send, evaluate, inFrame, goto, until, click, clickSel, clickText, shot, close, on: (f) => listeners.push(f), proc };
}
