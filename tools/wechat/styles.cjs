const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const selectorParser = require('postcss-selector-parser');

const nativeScroll = new Set(['.carousel__track', '.res__styles', '.versions', '.pp__parts', '.pills', '.chat__thread']);
const nativeSelectors = {
  '.toast:not(:has(.toast__act))': '.toast:not(.hjx-toast-action)',
  '.tpanel__body:has(> .tp--split)': '.tpanel__body.hjx-panel-split',
};

module.exports = function styles(css) {
  const sheet = postcss.parse(css);
  sheet.walkRules(rule => {
    if (nativeScroll.has(rule.selector)) {
      rule.walkDecls('gap', decl => { decl.prop = '--hjx-scroll-gap'; });
    }
    const selectors = [];
    for (const original of rule.selectors) {
      const selector = nativeSelectors[original] || original;
      const ast = selectorParser().astSync(selector);
      ast.walkPseudos(node => {
        if (node.value === ':root') node.replaceWith(selectorParser.className({ value: 'hjx-root' }));
        if (node.value === ':disabled') node.replaceWith(selectorParser.className({ value: 'hjx-attr-disabled' }));
      });
      ast.walkTags(node => {
        if (node.value === 'html') node.replaceWith(selectorParser.className({ value: 'hjx-root' }));
      });
      ast.walkAttributes(node => {
        const name = 'hjx-attr-' + node.attribute + (node.value == null ? '' : '-' + node.value);
        node.replaceWith(selectorParser.className({ value: name }));
      });
      const group = ast.first.nodes.find(node => node.type === 'pseudo' && node.value === ':is');
      const expanded = group ? group.nodes.map(option => {
        const branch = ast.first.clone();
        const trimmed = option.nodes.filter((node, idx, arr) =>
          !((idx === 0 || idx === arr.length - 1) && node.type === 'combinator' && !node.value.trim())
        );
        const replacement = trimmed.map((node, idx, arr) => {
          const cloned = node.clone();
          if (idx === 0 && cloned.spaces) cloned.spaces.before = '';
          if (idx === arr.length - 1 && cloned.spaces) cloned.spaces.after = '';
          return cloned;
        });
        branch.nodes.find(node => node.type === 'pseudo' && node.value === ':is')
          .replaceWith(...replacement);
        return branch.toString().trim();
      }) : [ast.toString()];
      for (const item of expanded) selectors.push(item.replace(/>\s*:/g, '> *:'));
    }
    if (selectors.length) rule.selectors = selectors;
    else rule.remove();
  });
  sheet.append('.hjx-svg { background-color: currentColor; -webkit-mask-size: contain; -webkit-mask-position: center; -webkit-mask-repeat: no-repeat; }');
  sheet.append('.hjx-root { color: var(--ink); min-height: 100vh; display: grid; place-items: center; }');
  sheet.append('.seg__opt { display: inline-flex; align-items: center; justify-content: center; line-height: 1; }');
  sheet.append('.hjx-camera { inset: 0; width: 100%; height: 100%; opacity: 1; }');
  sheet.append('.live .live__gl.hjx-raw-camera { opacity: 0; }');
  // Native <image> has an intrinsic 240 × 320 box even when CSS sets aspect-ratio.
  sheet.append('.drop__demo img { height: 109.333px; } .drop__demo .drop__b { height: 138.667px; }');
  sheet.append('.sample img { height: auto; }');
  sheet.append('.carousel__track { box-sizing: border-box; width: 100%; height: 104px; }');
  sheet.append('.pills { box-sizing: border-box; width: 100%; height: 36px; } .tp--split > .pills { height: 42px; }');
  sheet.append('.res__styles { height: 80px; } .versions { height: 62px; }');
  sheet.append('.pp__parts { height: 42px; } .frame__brush-preview { z-index: 4; pointer-events: none; }');
  sheet.append('.frame:not(.hjx-attr-data-mode) .frame__brush-preview { visibility: hidden; }');
  sheet.append('@media (max-height: 700px) { .versions { height: 58px; } }');
  return sheet.toString().replace(/url\('\.\.\/fonts\/([^']+)'\)/g, (_, filename) => {
    const font = path.resolve(this.context, '../fonts', filename);
    this.addDependency(font);
    return `url('data:font/woff2;base64,${fs.readFileSync(font).toString('base64')}')`;
  });
};
