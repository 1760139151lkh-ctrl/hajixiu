import './runtime.js';
import '../../web/css/app.css';
import stage from '../../web/index.html?stage';
import { startApplication } from '../../web/js/main.js';
import { setupConnection } from './platform.js';

export default async function openStudio() {
  const root = document.createElement('div');
  root.className = 'hjx-root';
  root.innerHTML = stage;
  document.body.appendChild(root);
  window.$$hjx.root = root;
  window.$$hjx.adaptTree(root);
  const info = wx.getWindowInfo();
  const menu = wx.getMenuButtonBoundingClientRect();
  root.style.setProperty('--sat', Math.max(info.safeArea?.top || 0, menu.bottom || 0) + 'px');
  root.style.setProperty('--sab', Math.max(0, info.screenHeight - (info.safeArea?.bottom || info.screenHeight)) + 'px');
  try {
    await setupConnection();
    await startApplication();
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    throw error;
  }
}
