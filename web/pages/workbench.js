// workbench.js —— 生图工作台：一个面板 = 三栏（生图设置 1 : 提示词 1 : 图片 2）。
//
// v1.0.1（用户要求）：把画师 UI 从工作台里拿出去、做成独立「画师」页；腾出的空间给图片，
// 三栏宽度按 1:1:2 分配（图片占两倍）。原先工作台自己排三栏（面板/LLM/画师），现在
// 面板内部就是三栏，工作台只负责：
//   · 渲染面板，并把「布局（三栏 / 两栏 / 仅图片）」传给面板（面板按 class 隐藏整列）；
//   · 把「本地 LLM（提示词生成）」通过 portal 挂进面板提示词栏的插槽里 —— 同屏、但不挤生图设置；
//   · 记住布局偏好（localStorage，纯界面偏好，不入 settings）。
'use strict';

import LlmPage from './llm.js';

const h = React.createElement;
const { useState, useEffect, useRef } = React;

const LAYOUT_KEY = 'dcp-workbench-layout';

export default function WorkbenchPage(props) {
  const { t, state, api, refresh, toast, post, put, openJobModal } = props;
  // layout: 3 | 2 | 1（1 = 只留图片栏）。旧版本存过 'gen'，这里归一化，避免读到旧值后布局失灵。
  const [layout, setLayout] = useState(() => {
    try {
      const v = localStorage.getItem(LAYOUT_KEY);
      return (v === '1' || v === '2' || v === '3') ? v : '3';
    } catch { return '3'; }
  });
  const [slot, setSlot] = useState(null);
  const slotTimer = useRef(null);
  const Panel = window.__DCP_PANEL__ && window.__DCP_PANEL__.Panel;

  useEffect(() => { try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* 忽略隐私模式 */ } }, [layout]);

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

  return h('div', { className: 'wb wb-layout-' + layout },
    h('div', { className: 'wb-bar' },
      h('span', { className: 'wb-hint' }, t('wb.layout')),
      h('div', { className: 'wb-seg' },
        h('button', { className: layout === '3' ? 'on' : '', onClick: () => setLayout('3') }, t('wb.cols3')),
        h('button', { className: layout === '2' ? 'on' : '', onClick: () => setLayout('2') }, t('wb.cols2')),
        h('button', { className: layout === '1' ? 'on' : '', onClick: () => setLayout('1') }, t('wb.colsImg'))),
      h('span', { className: 'sp' }),
      h('span', { className: 'wb-hint' }, t('wb.tip'))),

    h('div', { className: 'wb-single' },
      Panel
        ? h(Panel, { embed: true, layout, onClose: () => { /* 工作台内不需要关闭语义 */ } })
        : h('div', { className: 'page' }, h('div', { className: 'error' }, t('wb.panelMissing')))),

    (slot && window.ReactDOM && window.ReactDOM.createPortal)
      ? window.ReactDOM.createPortal(
        h('div', { className: 'wb-llm-in-slot' },
          h(LlmPage, { api, state, refresh, toast, t, embedded: true, post, put, openJobModal })),
        slot)
      : null);
}
