// "The customer's phone": opens the pairing link in a phone-sized browser, types a FICTIONAL test number,
// hears (reads) the mock verification call, types the code. Screenshots go to <shots>/.
// Usage: node tests/phone.js <link> <test-number> <shots-dir>
'use strict';
const { chromium, devices } = require('playwright');
(async () => {
  const [link, phone, shots] = process.argv.slice(2);
  const origin = new URL(link).origin;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ar-EG' });
  const page = await ctx.newPage();
  await page.goto(link);
  await page.screenshot({ path: `${shots}/1-link-page.png` });
  await page.fill('#phone', phone); await page.check('#consent');
  await page.screenshot({ path: `${shots}/2-number-entered.png` });
  await page.click('#b1'); await page.waitForSelector('#f2:not(.hidden)');
  await page.screenshot({ path: `${shots}/3-enter-otp.png` });
  const mock = await ctx.newPage();   // the "phone ringing" (mock): what the verification call says
  await mock.goto(`${origin}/mock/phone?to=${encodeURIComponent(phone.replace(/[^+0-9]/g, ''))}`);
  await mock.waitForSelector('.call'); await mock.screenshot({ path: `${shots}/4-mock-verification-call.png` });
  const said = await mock.textContent('.call');
  const otp = said.match(/(\d) (\d) (\d) (\d)/).slice(1).join('');
  await page.bringToFront(); await page.fill('#otp', otp); await page.click('#b2');
  await page.waitForSelector('#f3:not(.hidden)'); await page.screenshot({ path: `${shots}/5-linked.png` });
  console.log('phone: linked, verification call said:', said.replace(/\s+/g, ' ').trim());
  await browser.close();
})().catch((e) => { console.error('phone step failed:', e.message); process.exit(1); });
