// artists.js —— 画师收藏与黑名单页（收藏 / 黑名单 / 检索 / 从浏览器迁移）。
//
// 无构建步骤：本文件由浏览器直接当 ES module 加载，React 是全局（window.React）。
// 契约见 docs/INTERNAL-CONTRACT.md §2（页面约定）、§4（画师接口）、§6（i18n）。

import { t as tGlobal } from '../i18n.js';

const h = React.createElement;
const { useState, useEffect, useRef, useCallback } = React;

const LS_KEY = 'dcp-artist-favs';

function readBrowserFavs() {
  let raw = null;
  try { raw = window.localStorage.getItem(LS_KEY); } catch { return { ok: false, items: [] }; }
  if (!raw) return { ok: true, items: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ok: false, items: [] };
    const items = parsed
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter(Boolean);
    return { ok: true, items };
  } catch {
    return { ok: false, items: [] };
  }
}

export default function ArtistsPage(props) {
  // t 优先用外壳注入的；缺省时回落到 i18n.js 的模块级 t（同一份词典）。
  const { api, refresh, toast } = props;
  const t = typeof props.t === 'function' ? props.t : tGlobal;

  const [favs, setFavs] = useState([]);
  const [blacklist, setBlacklist] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [hits, setHits] = useState(null);        // null=未检索；否则 {items,total}
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  // 本机作品（v1.0.1）：某位画师在本机 output 目录里有哪些图
  const [worksQuery, setWorksQuery] = useState('');
  const [works, setWorks] = useState(null);      // null=还没查；否则 {items,total,artists,dir}
  const [worksBusy, setWorksBusy] = useState(false);
  const [delArm, setDelArm] = useState('');      // v1.2.0：待确认删除的作品 URL（两步确认，不弹原生对话框）
  // v1.2.0：画师分组（最多 50 组）+ 加组菜单状态
  const [groups, setGroups] = useState([]);
  const [pickFor, setPickFor] = useState('');        // 正在为哪个画师选分组（点开菜单）
  const [newGroupName, setNewGroupName] = useState('');
  const [menuNewName, setMenuNewName] = useState('');
  const [groupArm, setGroupArm] = useState('');      // 待确认删除的分组名
  const [groupBusy, setGroupBusy] = useState('');

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const fail = useCallback((e) => {
    const msg = (e && e.message) ? e.message : t('toast.failed');
    if (mounted.current) setErr(msg);
    toast && toast(msg, 'error');
  }, [toast, t]);

  const loadLists = useCallback(async () => {
    try {
      const r = await api('/app/artists/lists');
      if (!mounted.current) return;
      setFavs(Array.isArray(r && r.favs) ? r.favs : []);
      setBlacklist(Array.isArray(r && r.blacklist) ? r.blacklist : []);
      setGroups(Array.isArray(r && r.groups) ? r.groups : []);
      setLoaded(true);
    } catch (e) { fail(e); }
  }, [api, fail]);

  useEffect(() => { loadLists(); }, [loadLists]);

  const isFav = useCallback((tag) => favs.indexOf(tag) >= 0, [favs]);
  const isBlocked = useCallback((tag) => blacklist.indexOf(tag) >= 0, [blacklist]);

  // ── v1.2.0：画师分组 ─────────────────────────────────────
  const GROUP_MAX = 50;                              // 与后端 store.MAX_GROUPS 一致
  const groupNamesOf = useCallback((tag) => groups.filter((g) => (g.items || []).indexOf(tag) >= 0).map((g) => g.name), [groups]);

  /** 分组接口统一入口：成功后刷新本地列表 + 通知面板（面板的「分组随机」下拉立刻更新）。 */
  const groupOp = useCallback(async (act, payload, okMsg) => {
    setGroupBusy(act + ':' + (payload && (payload.name || payload.group || '')));
    setErr('');
    try {
      const r = await api('/app/artists/groups/' + act, { method: 'POST', body: payload });
      if (r && Array.isArray(r.groups)) setGroups(r.groups);
      await loadLists();
      refresh && refresh();
      try { window.__DCP_REFRESH_ARTISTS__ && window.__DCP_REFRESH_ARTISTS__(); } catch { /* 面板不在场也没关系 */ }
      if (okMsg) toast && toast(okMsg, 'ok');
      return r;
    } catch (e) { fail(e); return null; } finally { if (mounted.current) setGroupBusy(''); }
  }, [api, fail, loadLists, refresh, toast]);

  const createGroupFromCard = useCallback(async () => {
    const n = newGroupName.trim();
    if (!n) return;
    const r = await groupOp('create', { name: n }, t('artists.groups.created') + '：' + n);
    if (r) setNewGroupName('');
  }, [groupOp, newGroupName, t]);

  const addToGroup = useCallback(async (tag, name) => {
    await groupOp('add', { tag, group: name }, t('artists.groups.added') + '：' + tag + ' → ' + name);
    setPickFor('');
    setMenuNewName('');
  }, [groupOp, t]);

  const createAndAdd = useCallback(async (tag) => {
    const n = menuNewName.trim();
    if (!n) return;
    const r = await groupOp('create', { name: n }, t('artists.groups.created') + '：' + n);
    if (r) await addToGroup(tag, n);
  }, [addToGroup, groupOp, menuNewName, t]);

  const removeMember = useCallback(async (tag, name) => {
    await groupOp('remove', { tag, group: name });
  }, [groupOp]);

  const deleteGroup = useCallback(async (name) => {
    if (groupArm !== name) { setGroupArm(name); return; }
    setGroupArm('');
    await groupOp('delete', { name }, t('artists.groups.deleted') + '：' + name);
  }, [groupArm, groupOp, t]);

  /** 加组菜单：先列已存在的组（点一下即加入），也可以就地新建一个组并加入。 */
  const groupPickMenu = (tag) => h('div', { className: 'group-menu' },
    groups.length
      ? h('div', { className: 'chip-wrap' }, groups.map((g) => {
        const already = (g.items || []).indexOf(tag) >= 0;
        return h('span', { className: 'chip' + (already ? ' blocked' : ''), key: 'gm' + g.name },
          h('button', {
            className: 'chip-name', disabled: !!groupBusy,
            title: already ? t('artists.groups.removeHint') : t('artists.groups.addHint'),
            onClick: () => (already ? removeMember(tag, g.name) : addToGroup(tag, g.name)),
          }, (already ? '✓ ' : '＋ ') + g.name + '（' + (g.items || []).length + '）'));
      }))
      : h('div', { className: 'muted' }, t('artists.groups.none')),
    h('div', { className: 'row tight' },
      h('input', {
        className: 'input', value: menuNewName,
        disabled: groups.length >= GROUP_MAX,
        placeholder: groups.length >= GROUP_MAX ? t('artists.groups.full') : t('artists.groups.newPlaceholder'),
        onChange: (e) => setMenuNewName(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); createAndAdd(tag); } },
      }),
      h('button', {
        className: 'btn tiny', disabled: !menuNewName.trim() || groups.length >= GROUP_MAX || !!groupBusy,
        onClick: () => createAndAdd(tag),
      }, t('artists.groups.createAndAdd')),
      h('button', { className: 'btn tiny', onClick: () => { setPickFor(''); setMenuNewName(''); } }, t('common.close'))));

  /** 打开本机图片文件夹（走本程序的 /app/open-folder）。 */
  const openFolder = useCallback(async () => {
    try {
      const r = await api('/app/open-folder', { method: 'POST', body: { which: 'output' } });
      toast && toast((r && r.ok ? t('artists.works.opened') : t('toast.failed')) + ' ' + ((r && r.dir) || ''), r && r.ok ? 'ok' : 'error');
    } catch (e) { fail(e); }
  }, [api, fail, t, toast]);

  /** action="fav"|"blacklist"：服务端是切换语义（已在其中则移出，两态互斥）。 */
  const toggle = useCallback(async (tag, action) => {
    setBusy(action + ':' + tag);
    setErr('');
    try {
      const r = await api('/app/artists/toggle', { method: 'POST', body: { tag, action } });
      if (r && Array.isArray(r.favs) && mounted.current) setFavs(r.favs);
      if (r && Array.isArray(r.blacklist) && mounted.current) setBlacklist(r.blacklist);
      await loadLists();
      refresh && refresh();
    } catch (e) { fail(e); } finally { if (mounted.current) setBusy(''); }
  }, [api, fail, loadLists, refresh]);

  const search = useCallback(async () => {
    setSearching(true);
    setErr('');
    try {
      const q = query.trim();
      const r = await api('/app/artists/search?q=' + encodeURIComponent(q)
        + '&source=' + encodeURIComponent(source) + '&limit=50');
      if (mounted.current) setHits({ items: (r && r.items) || [], total: (r && r.total) || 0 });
    } catch (e) { fail(e); } finally { if (mounted.current) setSearching(false); }
  }, [api, fail, query, source]);

  /** 查本机作品：按画师 tag（@名字）或关键词。查不到就是"本地没有产品"。 */
  const loadWorks = useCallback(async (q) => {
    const query = String(q === undefined ? worksQuery : q).trim();
    setWorksBusy(true);
    setErr('');
    try {
      const url = '/app/artists/works?limit=120'
        + (query ? (query.startsWith('@') ? '&artist=' : '&q=') + encodeURIComponent(query) : '');
      const r = await api(url);
      if (mounted.current) setWorks(r || { items: [], total: 0, artists: [] });
    } catch (e) { fail(e); } finally { if (mounted.current) setWorksBusy(false); }
  }, [api, fail, worksQuery]);

  /**
   * v1.2.0：删除一张本机作品（web UI 与磁盘一起删）。后端只允许删 output 目录内的图片；
   * 删完重新拉一次列表，被删空的模型子目录由后端顺手收掉。
   */
  const deleteWork = useCallback(async (it) => {
    setDelArm('');
    setErr('');
    try {
      const r = await api('/app/output/delete', { method: 'POST', body: { name: it.name, sub: it.sub || '' } });
      if (!r || !r.ok) throw new Error((r && r.error) || t('toast.failed'));
      toast && toast(t('artists.works.deleted') + '：' + it.name, 'ok');
      await loadWorks();
    } catch (e) { fail(e); }
  }, [api, fail, loadWorks, t, toast]);

  const importFromBrowser = useCallback(async () => {    const read = readBrowserFavs();
    if (!read.ok) { toast && toast(t('toast.failed'), 'error'); return; }
    setBusy('import');
    setErr('');
    try {
      const r = await api('/app/artists/import', { method: 'POST', body: { items: read.items } });
      if (r && Array.isArray(r.favs) && mounted.current) setFavs(r.favs);
      await loadLists();
      refresh && refresh();
      const n = r && typeof r.imported === 'number' ? r.imported : read.items.length;
      toast && toast(t('artists.imported') + ' ' + String(n), 'ok');
    } catch (e) { fail(e); } finally { if (mounted.current) setBusy(''); }
  }, [api, fail, loadLists, refresh, toast, t]);

  // ── 渲染 ────────────────────────────────────────────────

  const chipList = (tags, action, blocked) => (tags.length
    ? h('div', { className: 'chip-wrap' }, tags.map((tag, i) => h('span', {
      className: blocked ? 'chip blocked' : 'chip', key: action + i,
    },
    tag,
    h('button', {
      disabled: busy === action + ':' + tag,
      title: t('common.remove'),
      onClick: () => toggle(tag, action),
    }, '✕'))))
    : h('div', { className: 'muted' }, t('common.none')));

  const items = (hits && hits.items) || [];
  const listCount = favs.length + blacklist.length;

  const favCard = h('div', { className: 'card' },
    h('div', { className: 'row' },
      h('div', { className: 'card-title' }, t('artists.favs')),
      h('span', { className: 'sp' }),
      h('span', { className: 'count' }, String(favs.length)),
      h('button', { className: 'btn tiny', onClick: loadLists }, t('common.refresh'))),
    loaded ? chipList(favs, 'fav', false) : h('div', { className: 'muted' }, t('common.loading')));

  const blackCard = h('div', { className: 'card' },
    h('div', { className: 'row' },
      h('div', { className: 'card-title' }, t('artists.blacklist')),
      h('span', { className: 'sp' }),
      h('span', { className: 'count' }, String(blacklist.length))),
    loaded ? chipList(blacklist, 'blacklist', true) : h('div', { className: 'muted' }, t('common.loading')),
    h('div', { className: 'hint' }, t('artists.exclusive')));

  const searchCard = h('div', { className: 'card' },
    h('div', { className: 'card-title' }, t('artists.search')),
    h('div', { className: 'search-row' },
      h('input', {
        className: 'input', value: query, placeholder: t('artists.search.placeholder'),
        onChange: (e) => setQuery(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } },
      }),
      h('div', { className: 'src-toggle' },
        h('button', { className: source === 'all' ? 'on' : '', onClick: () => setSource('all') }, t('artists.source.all')),
        h('button', { className: source === 'top' ? 'on' : '', onClick: () => setSource('top') }, t('artists.source.top')),
        h('button', { className: source === 'favs' ? 'on' : '', onClick: () => setSource('favs') }, t('artists.source.favs'))),
      h('button', { className: 'btn', disabled: searching, onClick: search }, t('common.search'))),
    hits
      ? h('div', { className: 'row tight' },
        h('span', { className: 'count' }, t('artists.count') + ' ' + String((hits && hits.total) || items.length)))
      : null,
    hits && !items.length ? h('div', { className: 'hint' }, t('artists.empty')) : null,
    items.length
      ? h('div', { className: 'list list-scroll' }, items.map((it, i) => {
        const tag = it && it.tag ? it.tag : '';
        const fav = isFav(tag);
        const blocked = isBlocked(tag) || !!(it && it.blacklisted);
        return h('div', { key: 'h' + i },
          h('div', { className: 'hit-row' },
            h('span', { className: 'hit-name' }, tag),
            blocked ? h('span', { className: 'chip blocked' }, t('artists.blacklisted')) : null,
            h('button', {
              className: fav ? 'star' : 'star off',
              disabled: busy === 'fav:' + tag || busy === 'blacklist:' + tag,
              title: t(fav ? 'artists.unfav' : 'artists.fav'),
              onClick: () => toggle(tag, 'fav'),
            }, t(fav ? 'artists.unfav' : 'artists.fav')),
            // v1.2.0：把画师加入分组 —— 点开列出已存在的组，选一个即加入（同一行的按钮）
            h('button', {
              className: 'btn tiny' + (pickFor === tag ? ' primary' : ''),
              title: t('artists.groups.addHint'),
              onClick: () => setPickFor(pickFor === tag ? '' : tag),
            }, t('artists.groups.add') + (groupNamesOf(tag).length ? '（' + groupNamesOf(tag).length + '）' : '')),
            h('button', {
              className: 'btn tiny',
              disabled: busy === 'fav:' + tag || busy === 'blacklist:' + tag,
              onClick: () => toggle(tag, 'blacklist'),
            }, t(blocked ? 'artists.blacklist.remove' : 'artists.blacklist.add'))),
          pickFor === tag ? groupPickMenu(tag) : null);
      }))
      : null,
    h('div', { className: 'hint' }, t('artists.manage.title') + ' · ' + String(listCount)));

  const importCard = h('div', { className: 'card' },
    h('div', { className: 'card-title' }, t('artists.importFromBrowser')),
    h('div', { className: 'row' },
      h('button', {
        className: 'btn primary', disabled: busy === 'import', onClick: importFromBrowser,
      }, t('artists.importFromBrowser'))));

  // ── 本机作品（v1.0.1）────────────────────────────────────
  // 用户要求：在画师页能看到"这位画师在本机有哪些作品"，可一键收藏画师、可搜索画师；
  // 本机没有作品就明确写「本地没有产品」，不留空白让人猜。
  const worksItems = (works && works.items) || [];
  const worksCard = h('div', { className: 'card' },
    h('div', { className: 'row' },
      h('div', { className: 'card-title' }, t('artists.works.title')),
      h('span', { className: 'sp' }),
      works && works.installed ? h('span', { className: 'count' }, String((works && works.scanned) || 0)) : null,
      h('button', { className: 'btn tiny', onClick: () => loadWorks() }, t('common.refresh'))),
    h('div', { className: 'hint' }, t('artists.works.hint')),
    h('div', { className: 'search-row' },
      h('input', {
        className: 'input', value: worksQuery,
        placeholder: t('artists.works.placeholder'),
        onChange: (e) => setWorksQuery(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); loadWorks(e.target.value); } },
      }),
      h('button', { className: 'btn', disabled: worksBusy, onClick: () => loadWorks() }, t('common.search')),
      h('button', { className: 'btn tiny', disabled: worksBusy, onClick: () => openFolder() }, t('artists.works.openFolder'))),
    // 本机有作品的画师（点一下就等于"按这位画师查作品"，旁边的 ☆ 直接收藏）
    (works && works.artists && works.artists.length)
      ? h('div', { className: 'chip-wrap', style: { marginTop: 6 } },
        works.artists.slice(0, 40).map((a) => h('span', { className: 'chip', key: 'w' + a.tag },
          h('button', { className: 'chip-name', title: t('artists.works.show') + ' ' + a.tag, onClick: () => { setWorksQuery(a.tag); loadWorks(a.tag); } }, a.tag + ' · ' + a.count),
          h('button', {
            className: isFav(a.tag) ? 'star' : 'star off', disabled: busy === 'fav:' + a.tag,
            title: t(isFav(a.tag) ? 'artists.unfav' : 'artists.fav'),
            onClick: () => toggle(a.tag, 'fav'),
          }, t(isFav(a.tag) ? 'artists.unfav' : 'artists.fav')))))
      : null,
    worksBusy ? h('div', { className: 'muted' }, t('common.loading')) : null,
    (works && !worksBusy)
      ? (worksItems.length
        ? h('div', { className: 'works-grid' }, worksItems.map((it, i) => h('div', { className: 'work', key: 'wk' + i },
          h('img', {
            className: 'work-img', src: it.url, title: it.name, loading: 'lazy',
            onClick: () => window.open(it.url, '_blank', 'noopener'),
          }),
          h('div', { className: 'work-meta' },
            h('span', { className: 'work-name', title: it.name }, it.name),
            it.artist
              ? h('button', {
                className: isFav(it.artist) ? 'star' : 'star off', disabled: busy === 'fav:' + it.artist,
                title: t(isFav(it.artist) ? 'artists.unfav' : 'artists.fav') + ' ' + it.artist,
                onClick: () => toggle(it.artist, 'fav'),
              }, t(isFav(it.artist) ? 'artists.unfav' : 'artists.fav'))
              : h('span', { className: 'muted' }, t('artists.works.noArtist')),
            // v1.2.0：删除这张作品（两步确认；删除后 web UI 与图片文件夹里都没有它）
            h('button', {
              className: delArm === it.url ? 'star' : 'star off',
              title: t('artists.works.deleteHint'),
              onClick: () => { if (delArm === it.url) deleteWork(it); else setDelArm(it.url); },
            }, delArm === it.url ? t('artists.works.deleteConfirm') : '🗑')))))
        : h('div', { className: 'hint' }, t('artists.works.empty')))
      : null,
    works && works.dir ? h('div', { className: 'muted mono', style: { fontSize: 10 } }, t('artists.works.dir') + ': ' + works.dir) : null);

  // ── v1.2.0：画师分组（建组 / 删组 / 看成员）──────────────────
  // 用户要求：最多 50 个分组；加入分组的入口与"收藏"在同一行，点开列出已存在的组再选一个。
  const groupsCard = h('div', { className: 'card' },
    h('div', { className: 'row' },
      h('div', { className: 'card-title' }, t('artists.groups')),
      h('span', { className: 'sp' }),
      h('span', { className: 'count' }, String(groups.length) + ' / ' + String(GROUP_MAX))),
    h('div', { className: 'hint' }, t('artists.groups.hint')),
    h('div', { className: 'search-row' },
      h('input', {
        className: 'input', value: newGroupName, disabled: groups.length >= GROUP_MAX,
        placeholder: groups.length >= GROUP_MAX ? t('artists.groups.full') : t('artists.groups.placeholder'),
        onChange: (e) => setNewGroupName(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); createGroupFromCard(); } },
      }),
      h('button', {
        className: 'btn',
        disabled: !newGroupName.trim() || groups.length >= GROUP_MAX || !!groupBusy,
        onClick: createGroupFromCard,
      }, t('artists.groups.create'))),
    groups.length >= GROUP_MAX ? h('div', { className: 'hint' }, t('artists.groups.full')) : null,
    groups.length
      ? h('div', { className: 'list list-scroll' }, groups.map((g) => {
        const members = g.items || [];
        return h('div', { className: 'hit-row', key: 'g' + g.name },
          h('span', { className: 'hit-name', title: members.join(', ') },
            g.name + '（' + members.length + ' ' + t('artists.groups.count') + '）'),
          h('span', { className: 'muted', style: { maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            members.slice(0, 4).join('、') + (members.length > 4 ? ' …' : '')),
          h('button', {
            className: groupArm === g.name ? 'star' : 'btn tiny',
            disabled: !!groupBusy,
            title: t('artists.groups.delHint'),
            onClick: () => deleteGroup(g.name),
          }, groupArm === g.name ? t('artists.groups.delConfirm') : t('artists.groups.del')));
      }))
      : h('div', { className: 'muted' }, t('artists.groups.none')));

  return h('div', { className: 'page' },
    h('h1', { className: 'page-title' }, t('artists.title')),
    err ? h('div', { className: 'error' }, err) : null,
    h('div', { className: 'artist-cols' }, favCard, blackCard, groupsCard, searchCard, importCard),
    worksCard);
}
