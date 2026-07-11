import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.goto('https://example.com', { waitUntil: 'networkidle' });
await page.screenshot({ path: 'D:/study-assistant/example-screenshot.png', fullPage: true });
console.log('Screenshot saved to example-screenshot.png');
await browser.close();
