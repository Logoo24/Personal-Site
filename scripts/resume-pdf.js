// Renders _src/resume-pdf.html to files/logan-randall-resume.pdf with
// headless Chrome (or Edge). Run locally after editing the source:
//   npm run resume-pdf
// Not part of the Vercel build - the PDF is committed.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, '_src', 'resume-pdf.html');
const OUT = path.join(ROOT, 'files', 'logan-randall-resume.pdf');

const candidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean);
const chrome = candidates.find(p => fs.existsSync(p));
if (!chrome) { console.error('No Chrome/Edge found; set CHROME_PATH.'); process.exit(1); }

fs.mkdirSync(path.dirname(OUT), { recursive: true });
execFileSync(chrome, [
  '--headless=new', '--disable-gpu', '--no-pdf-header-footer',
  '--virtual-time-budget=5000', // let the web font load before printing
  '--print-to-pdf=' + OUT,
  'file:///' + SRC.replace(/\\/g, '/'),
], { stdio: 'ignore' });
console.log('wrote', path.relative(ROOT, OUT), fs.statSync(OUT).size + ' bytes');
