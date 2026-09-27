// workbench.js —— 生图工作台：一个面板 = 三栏（生图设置 1 : 提示词 1 : 图片 2）。
//
// v2.0.0（用户要求）：移除「三栏 / 两栏 / 仅图片」布局切换 —— 工作台固定三栏，
// 窄窗口由 workbench.css 的断点自动并栏（那不是用户可选功能，是防挤爆的降级）。
// 工作台现在只负责：
//   · 渲染面板（embed 模式，无面板头部）；
//   · 把「本地 LLM（提示词生成）」通过 portal 挂进面板提示词栏的插槽里。
'use strict';

import LlmPage from './llm.js';

const h = React.createElement;
const { useState, useEffect, useRef } = React;

export default function WorkbenchPage(props) {
  const { t, state, api, refresh, toast, post, put, openJobModal } = props;
  const [slot, setSlot] = useState(null);
  const slotTimer = useRef(null);
  const Panel = window.__DCP_PANEL__ && window.__DCP_PANEL__.Panel;

  // 面板挂载后在提示词栏里放出插槽节点 → 这里 re-render 一次，把 LLM 页 portal 进去。
  useEffect(() => {
    const pick = () => {
      const s = window.__DCP_PANEL_SLOTS__ && window.__DCP_PANEL_SLOTS__.prompt;
      setSlot((cur) => (cur === s ? cur : (s || null)));
    };
    pick();
    window.addEventListener('dcp-panel-slots', pick);
    slotTimer.current = setInterval(pick, 700);    // 面板重挂载（换页/重渲染）后兜住
    return () => { window.removeEventListener('dcp-panel-slots', pick); if (slotTimer.current) clearInterval(slotTimer.current); };
  }, []);

  return h('div', { className: 'wb' },
    h('div', { className: 'wb-single' },
      Panel
        ? h(Panel, { embed: true })
        : h('div', { className: 'page' }, h('div', { className: 'error' }, t('wb.panelMissing')))),

    (slot && window.ReactDOM && window.ReactDOM.createPortal)
      ? window.ReactDOM.createPortal(
        h('div', { className: 'wb-llm-in-slot' },
          h(LlmPage, { api, state, refresh, toast, t, embedded: true, post, put, openJobModal })),
        slot)
      : null);
}
