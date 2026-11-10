// Convert TeX to self-contained SVG so ebook readers need no JavaScript.
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.EBOOK_NODE_MODULES || path.resolve(__dirname, '../../.cache/ebooks/node_modules');
const mj = name => require(path.join(root, 'mathjax-full/js', name));
const {mathjax} = mj('mathjax.js');
const {TeX} = mj('input/tex.js');
const {SVG} = mj('output/svg.js');
const {liteAdaptor} = mj('adaptors/liteAdaptor.js');
const {RegisterHTMLHandler} = mj('handlers/html.js');
const {AllPackages} = mj('input/tex/AllPackages.js');
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const document = mathjax.document('', {
  InputJax: new TeX({packages: AllPackages}),
  OutputJax: new SVG({fontCache: 'none'}),
});
const results = JSON.parse(fs.readFileSync(0, 'utf8')).map(({tex, display}) => {
  const html = adaptor.outerHTML(document.convert(tex, {display}));
  if (html.includes('data-mjx-error')) throw new Error(`Invalid formula: ${tex}`);
  return html.slice(html.indexOf('<svg'), html.lastIndexOf('</svg>') + 6);
});
process.stdout.write(JSON.stringify(results));
