import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const TEST_FILE = path.resolve(REPO_ROOT, 'test_data/small_plus.edf');

const PORT = 4173;
const URL = `http://localhost:${PORT}/`;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (_) {}
    await sleep(200);
  }
  throw new Error(`Timeout waiting for preview server at ${url}`);
}

async function main() {
  console.log('--- STARTING PLAYWRIGHT BROWSER UI SMOKE TEST ---');

  // 1. Start preview server
  console.log(`Starting vite preview on port ${PORT}...`);
  const server = spawn('npm', ['run', 'preview', '--', '--port', String(PORT)], {
    cwd: __dirname,
    stdio: 'pipe',
  });

  server.stdout.on('data', (d) => {
    // console.log(`[preview] ${d.toString().trim()}`);
  });
  server.stderr.on('data', (d) => {
    // console.error(`[preview error] ${d.toString().trim()}`);
  });

  let browser = null;

  try {
    await waitForServer(URL);
    console.log(`Preview server ready at ${URL}`);

    // 2. Launch chromium browser
    console.log('Launching headless Chromium browser...');
    const candidatePaths = [
      '/Users/michi/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell',
      '/Users/michi/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    let executablePath = candidatePaths.find((p) => fs.existsSync(p));
    console.log(`Using browser executable: ${executablePath || 'default'}`);

    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader'],
      ...(executablePath ? { executablePath } : {}),
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });

    page.on('console', (msg) => {
      console.log(`[PAGE ${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      console.error('[PAGE ERROR]', err);
    });

    // 3. Navigate to application
    console.log(`Navigating to ${URL}...`);
    await page.goto(URL, { waitUntil: 'networkidle' });

    // 4. Upload test_data/small_plus.edf
    console.log(`Uploading test file: ${TEST_FILE}...`);
    expectFile(TEST_FILE);
    const fileInput = await page.$('input[type="file"][accept*=".edf"]');
    if (!fileInput) {
      throw new Error('EDF file input element not found in DOM');
    }
    await fileInput.setInputFiles(TEST_FILE);

    // Wait for canvas rendering and metadata pill to appear
    console.log('Waiting for metadata pill and canvas...');
    await page.waitForSelector('.file-pill', { timeout: 10000 });
    await page.waitForSelector('canvas', { timeout: 10000 });

    const pillText = await page.$eval('.file-pill', (el) => el.textContent?.trim());
    console.log(`Metadata pill displayed: "${pillText}"`);

    // Let the canvas render traces and annotations
    await sleep(1000);

    const canvasInfo = await page.evaluate(() => {
      const glCanvas = document.querySelector('.gl-canvas');
      const overlayCanvas = document.querySelector('.overlay-canvas');
      return {
        glCanvas: glCanvas ? { w: glCanvas.width, h: glCanvas.height, clientW: glCanvas.clientWidth, clientH: glCanvas.clientHeight } : null,
        overlayCanvas: overlayCanvas ? { w: overlayCanvas.width, h: overlayCanvas.height } : null,
        channelCards: document.querySelectorAll('.channel-card').length,
        loading: document.querySelector('.loading-spinner') !== null,
      };
    });
    console.log('Canvas & UI status:', JSON.stringify(canvasInfo));

    // Take screenshot 1: live viewer
    const liveScreenshotPath = '/tmp/edf_viewer_live.png';
    await page.screenshot({ path: liveScreenshotPath });
    console.log(`Screenshot saved to ${liveScreenshotPath} (${fs.statSync(liveScreenshotPath).size} bytes)`);

    // 6. Test clicking page navigation button (▶)
    console.log('Testing page navigation (Next Page ▶)...');
    const timeBefore = await page.$eval('.elapsed-time', (el) => el.textContent?.trim());
    console.log(`Time before navigation: ${timeBefore}`);

    const nextBtn = await page.$('button[title*="Next Page"]');
    if (!nextBtn) {
      throw new Error('Next Page button not found');
    }
    await nextBtn.click();
    await sleep(500);

    const timeAfter = await page.$eval('.elapsed-time', (el) => el.textContent?.trim());
    console.log(`Time after navigation: ${timeAfter}`);
    if (timeBefore === timeAfter) {
      throw new Error(`Time display did not advance after clicking next page: ${timeBefore} -> ${timeAfter}`);
    }

    // 7. Test opening Annotation Sidebar (hotkey 'A' or toolbar button)
    console.log('Testing opening Annotation Sidebar...');
    const annotBtn = await page.$('button[title*="Toggle Annotations Sidebar"]');
    if (annotBtn) {
      await annotBtn.click();
    } else {
      await page.keyboard.press('a');
    }
    await page.waitForSelector('.annotation-sidebar, .sidebar-container', { timeout: 5000 });
    await sleep(600);

    const annotScreenshotPath = '/tmp/edf_viewer_annotations.png';
    await page.screenshot({ path: annotScreenshotPath });
    console.log(`Annotations screenshot saved to ${annotScreenshotPath} (${fs.statSync(annotScreenshotPath).size} bytes)`);

    // 8. Test toggling a channel in the left sidebar
    console.log('Testing toggling a channel in the left sidebar...');
    const firstCheckbox = await page.$('.vis-checkbox');
    if (!firstCheckbox) {
      throw new Error('Channel visibility checkbox not found in left sidebar');
    }
    const initialChecked = await firstCheckbox.isChecked();
    console.log(`First channel visibility before toggle: checked=${initialChecked}`);
    await firstCheckbox.click();
    await sleep(300);
    const afterChecked = await firstCheckbox.isChecked();
    console.log(`First channel visibility after toggle: checked=${afterChecked}`);
    if (initialChecked === afterChecked) {
      throw new Error('Checkbox state did not toggle');
    }
    // Toggle it back on
    await firstCheckbox.click();
    await sleep(300);

    // 9. Test horizontal zooming (Window: 1s, 60s)
    console.log('Testing horizontal zooming...');
    await page.selectOption('select.duration-select', '1');
    await sleep(400);
    await page.screenshot({ path: '/tmp/edf_zoom_1s.png' });
    console.log('Captured /tmp/edf_zoom_1s.png');

    await page.selectOption('select.duration-select', '60');
    await sleep(400);
    await page.screenshot({ path: '/tmp/edf_zoom_60s.png' });
    console.log('Captured /tmp/edf_zoom_60s.png');

    // 10. Test applying a 50Hz notch filter
    console.log('Testing filter configuration (50 Hz Notch)...');
    const filterBtn = await page.$('button.filter-icon-btn');
    if (filterBtn) {
      await filterBtn.click();
      await sleep(300);
      await page.click('button.opt-btn:has-text("50 Hz")');
      await sleep(200);
      await page.click('button:has-text("Apply to Channel")');
      await sleep(600);
      await page.screenshot({ path: '/tmp/edf_filtered_view.png' });
      console.log('Captured /tmp/edf_filtered_view.png');
    }

    // 11. Test smooth horizontal panning/dragging
    console.log('Testing horizontal drag/pan...');
    const viewportEl = await page.$('.viewport-container');
    const box = await viewportEl?.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      await sleep(500);
      await page.screenshot({ path: '/tmp/edf_filtered_panned.png' });
      console.log('Captured /tmp/edf_filtered_panned.png');
    }

    // 12. Test Line Thickness selector and localStorage persistence
    console.log('Testing Line Thickness selector (2.5 px)...');
    await page.selectOption('select.line-select', '2.5');
    await sleep(300);
    const storedThickness = await page.evaluate(() =>
      localStorage.getItem('edf_viewer_line_thickness')
    );
    console.log(`Stored line thickness in localStorage: ${storedThickness}`);
    if (storedThickness !== '2.5') {
      throw new Error(`Expected line thickness '2.5', got '${storedThickness}'`);
    }

    // 13. Test Redraw button and R hotkey
    console.log('Testing Redraw button and R hotkey...');
    const redrawBtn = await page.$('.redraw-btn');
    if (!redrawBtn) {
      throw new Error('Redraw button not found');
    }
    await redrawBtn.click();
    await sleep(300);
    await page.keyboard.press('r');
    await sleep(300);

    // 14. Test Help modal (?) and acknowledgment text
    console.log('Testing Help (?) modal and acknowledgment text...');
    const helpBtn = await page.$('.help-btn');
    if (!helpBtn) {
      throw new Error('Help (?) button not found');
    }
    await helpBtn.click();
    await page.waitForSelector('.ack-box', { timeout: 3000 });

    const ackContent = await page.$eval('.ack-box', (el) => el.textContent?.trim());
    console.log(`Acknowledgment box content: "${ackContent}"`);
    if (
      !ackContent?.includes('M. Giugliano and O. Kryukova for G. Curia\'s lab') ||
      !ackContent?.includes('0.1') ||
      !ackContent?.includes('Nov 2026')
    ) {
      throw new Error(`Acknowledgment text missing required details: "${ackContent}"`);
    }
    await page.screenshot({ path: '/tmp/edf_help_modal.png' });
    console.log('Captured /tmp/edf_help_modal.png');

    await page.keyboard.press('Escape');
    await sleep(300);

    console.log('\n--- ALL BROWSER SMOKE TEST ACTIONS PASSED SUCCESSFULLY ---');
  } finally {
    if (browser) {
      await browser.close();
      console.log('Browser closed.');
    }
    server.kill('SIGTERM');
    console.log('Vite preview server terminated.');
  }
}

function expectFile(p) {
  if (!fs.existsSync(p)) {
    throw new Error(`File does not exist: ${p}`);
  }
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
