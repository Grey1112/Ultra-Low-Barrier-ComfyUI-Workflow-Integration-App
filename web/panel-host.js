// panel-host.js —— 最小宿主适配层。
//
// 作用：让插件版 `lib/client.js`（面板半）在**没有插件宿主**的普通网页里原样运行。
// 面板源码本身保留 `window.__ModuleLoader__.load({ factory: (require) => ... })`
// 的插件式客户端模块包装，本文件只补三件事：
//   1. `window.__ModuleLoader__.load` —— 立即执行 factory，注入本地 React；
//   2. `ctx.effect` / `ctx.slots.inject` / `ctx.slots.register` —— 面板注册入口的替身；
//   3. 把注册到的组件（Fab/面板）挂到 `window.__DCP_PANEL__` 供外壳（app-shell.js）使用。
//
// 这样面板的 2000+ 行成熟 UI 不需要重写成另一种框架，改造只在必要处做锚点替换。
(function () {
  'use strict';

  var captured = null;   // 面板 `ctx.slots.register(...)` 注册进来的组件
  var disposers = [];    // ctx.effect 返回的清理函数
  var registered = {};   // 面板注册元数据

  function makeCtx() {
    return {
      effect: function (fn) {
        try {
          var d = typeof fn === 'function' ? fn() : undefined;
          if (typeof d === 'function') disposers.push(d);
        } catch (e) {
          console.warn('[panel-host] effect 失败：', e);
        }
      },
      slots: {
        inject: function (_name, cb) {
          // 插件宿主里 inject 会等 ui-layout 声明槽位；独立版没有该服务，直接落位。
          try { return cb(); } catch (e) { console.error('[panel-host] slots.inject 失败：', e); }
        },
        register: function (meta, component) {
          registered = meta || {};
          captured = component;
          return { dispose: function () { if (captured === component) captured = null; } };
        },
      },
      // 面板不消费，但保留最小实现，避免以后加代码时炸掉。
      get: function () { return undefined; },
      logger: console,
    };
  }

  window.__ModuleLoader__ = {
    load: function (mod) {
      if (!mod || typeof mod.factory !== 'function') throw new Error('bad client module');
      var module = { exports: {} };
      var requireFn = function (id) {
        if (id === 'react') return window.React;
        throw new Error('module not available in standalone host: ' + id);
      };
      var exports = mod.factory(requireFn);
      if (!exports) exports = module.exports;
      if (typeof exports.apply === 'function') {
        try { exports.apply(makeCtx()); } catch (e) { console.error('[panel-host] apply 失败：', e); }
      }
      window.__DCP_PANEL__ = {
        id: mod.id,
        meta: registered,
        Fab: exports.__test && exports.__test.Fab,
        Panel: (exports.__test && exports.__test.Panel) || captured,
        CSS: exports.__test && exports.__test.CSS,
        BUILD_TAG: exports.__test && exports.__test.BUILD_TAG,
        test: exports.__test,
        dispose: function () { disposers.splice(0).forEach(function (d) { try { d(); } catch (e) {} }); },
      };
      window.dispatchEvent(new CustomEvent('dcp-panel-ready', { detail: window.__DCP_PANEL__ }));
    },
  };
})();
