const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { transformSync } = require('esbuild');
const webpack = require('webpack');
const MpPlugin = require('mp-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'miniprogram');
const appid = process.env.HAJIXIU_WECHAT_APPID || 'touristappid';
const url = process.env.HAJIXIU_STUDIO_URL || '';
if (url && !/^https:\/\/[^/?#@]+\/?$/.test(url)) {
  throw new Error('HAJIXIU_STUDIO_URL must be an HTTPS origin without credentials or a path.');
}
const packArt = ['run', 'python', path.join(__dirname, 'package_assets.py'), path.join(root, 'web/img'), output];
if (appid !== 'touristappid' && url) packArt.push('--remote-originals');
const artwork = JSON.parse(execFileSync('uv', packArt, { cwd: root, encoding: 'utf8', windowsHide: true }));
const retiredPacks = fs.readdirSync(output).filter(name => /^art\d+$/.test(name) && !artwork.roots.includes(name));
const ignoredArt = ['img', ...retiredPacks].map(value => ({ type: 'folder', value }));
const globals = [
  ['matchMedia', "query => window.matchMedia ? window.matchMedia(query) : { matches: false }"],
  ['addEventListener', 'window.addEventListener.bind(window)'],
  ['removeEventListener', 'window.removeEventListener.bind(window)'],
  ['devicePixelRatio', 'wx.getWindowInfo().pixelRatio'],
  ['innerWidth', 'wx.getWindowInfo().windowWidth'],
  ['innerHeight', 'wx.getWindowInfo().windowHeight'],
  ['structuredClone', 'value => JSON.parse(JSON.stringify(value))'],
  ['Image', "function (width, height) { return window.$$hjx.adaptImage(width, height) }"],
  ['ResizeObserver', 'function (callback) { return window.$$hjx.observeSize(callback) }'],
];
const platform = Object.fromEntries(
  ['fetch', 'Blob', 'FormData', 'FileReader', 'AbortController', 'AbortSignal', 'createImageBitmap'].map(
    name => [name, [path.join(__dirname, 'platform.js'), name]]
  )
);
platform.URL = [path.join(__dirname, 'runtime.js'), 'URL'];

class ProjectAssets {
  apply(compiler) {
    compiler.hooks.afterEmit.tap('HajixiuProjectAssets', () => {
      // The upload compiler rejects ES2020 syntax left in Kbone's app bundle.
      const bundle = path.join(output, 'common', 'index.js');
      const compatible = transformSync(fs.readFileSync(bundle, 'utf8'), {
        target: 'es2018', minifyWhitespace: true,
      });
      fs.writeFileSync(bundle, compatible.code);
      for (const name of ['miniprogram-render', 'miniprogram-element']) {
        const entry = require.resolve(name + '/package.json');
        const packageDir = path.dirname(entry);
        const dest = path.join(output, 'miniprogram_npm', name);
        fs.cpSync(path.join(packageDir, 'dist'), dest, { recursive: true, filter: file => !file.endsWith('.map') });
        fs.copyFileSync(path.join(packageDir, 'LICENSE'), path.join(dest, 'LICENSE'));
      }
      // Kbone normally expands HTML root-relative URLs against the web origin.
      // The packaged images must stay rooted in the mini-program instead.
      const app = path.join(output, 'app.js');
      const bridge = [
        "const assetTool = require('miniprogram-render').$$adapter.tool;",
        'const completeAssetURL = assetTool.completeURL;',
        "assetTool.completeURL = (url, ...args) => url.startsWith('/img/') ? url : completeAssetURL(url, ...args);",
        '',
      ].join('\n');
      let appCode = fs.readFileSync(app, 'utf8');
      if (!appCode.startsWith(bridge)) appCode = bridge + appCode;
      if (!appCode.includes('loadHairModel()')) {
        appCode = appCode.replace('App({', "App({\n    loadHairModel() { return require.async('./vision/model.js'); },");
      }
      if (!appCode.includes('loadArtPack(pack)')) {
        const artworkMethods = [
          '    async loadArtPack(pack) {',
          '        switch (pack) {',
          `            case '${artwork.bootstrap}': return require('./${artwork.bootstrap}.js');`,
          ...artwork.roots.map(name => `            case '${name}': return require.async('./${name}/assets.js');`),
          "            default: throw new Error('Unknown artwork subpackage');",
          '        }',
          '    },',
        ].join('\n');
        appCode = appCode.replace('App({', 'App({\n' + artworkMethods);
      }
      fs.writeFileSync(app, appCode);
      const vision = path.join(output, 'vision');
      fs.mkdirSync(vision, { recursive: true });
      fs.copyFileSync(path.join(__dirname, 'hair-segmentation', 'graph.cjs'), path.join(vision, 'model.js'));
      fs.writeFileSync(path.join(vision, 'entry.js'), "Page({});\n");
      fs.writeFileSync(path.join(vision, 'entry.wxml'), "<view />\n");
      fs.writeFileSync(path.join(output, 'sitemap.json'), JSON.stringify({
        rules: [{ action: 'disallow', page: '*' }],
      }, null, 2));
    });
  }
}

module.exports = {
  mode: 'production',
  target: ['web', 'es2018'],
  entry: { index: path.join(__dirname, 'entry.js') },
  output: {
    path: path.join(output, 'common'),
    filename: '[name].js',
    library: 'createApp',
    libraryExport: 'default',
    libraryTarget: 'window',
  },
  optimization: { runtimeChunk: false, splitChunks: false },
  performance: { hints: false },
  module: {
    rules: [
      { test: /index\.html$/, resourceQuery: /stage/, use: path.join(__dirname, 'stage.cjs') },
      {
        test: /app\.css$/,
        use: [MiniCssExtractPlugin.loader, { loader: 'css-loader', options: { url: false } },
          path.join(__dirname, 'styles.cjs')],
      },
    ],
  },
  plugins: [
    new webpack.NormalModuleReplacementPlugin(/^\.\/(?:core\/)?db\.js$|^\.\.\/core\/db\.js$/, path.join(__dirname, 'storage.js')),
    new webpack.NormalModuleReplacementPlugin(/^\.\.\/live\/camera\.js$/, path.join(__dirname, 'camera.js')),
    new webpack.DefinePlugin({
      HJX_STUDIO_URL: JSON.stringify(url.replace(/\/$/, '')),
      HJX_ART_INDEX: JSON.stringify(artwork.index),
    }),
    new webpack.ProvidePlugin(platform),
    new MiniCssExtractPlugin({ filename: '[name].wxss' }),
    new MpPlugin({
      entry: '/',
      router: { index: ['/'] },
      origin: 'https://hajixiu.miniprogram',
      generate: {
        autoBuildNpm: false,
        appWxss: 'display',
        globalVars: globals,
      },
      projectConfig: {
        appid, projectname: '哈基秀', libVersion: '3.17.3',
        packOptions: { ignore: ignoredArt },
        setting: { urlCheck: appid !== 'touristappid', es6: true, enhance: true, minified: true, uploadWithSourceMap: false },
      },
      app: {
        navigationStyle: 'custom', navigationBarTitleText: '哈基秀',
        backgroundColor: '#0d0a1a', backgroundTextStyle: 'light',
      },
      appExtraConfig: {
        resizable: true, sitemapLocation: 'sitemap.json',
        entryPagePath: 'pages/index/index',
        subpackages: ['vision', ...artwork.roots].map(root => ({ root, pages: ['entry'] })),
      },
      global: { windowScroll: false, loadingText: '', share: false, extra: { disableScroll: true } },
    }),
    new ProjectAssets(),
  ],
};
