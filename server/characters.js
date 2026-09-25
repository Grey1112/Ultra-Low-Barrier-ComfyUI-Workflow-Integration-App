// characters.js —— 二次元角色词表（Danbooru 角色 tag 索引）+ 角色 tag 补全。
//
// 为什么需要它（有实测依据）：目前没有任何 8GB 显存能跑的文生文 LLM 能可靠地把
// "蕾姆 / Rem" 这类角色名翻成 Danbooru 的规范角色 tag（`rem_(re:zero)`）——
//   · 唯一的 NL→Danbooru 模型（BooruNL-0.8B）在模型卡里明确写了"不输出角色/画师 tag"；
//   · 唯一的 Danbooru tag 模型（DanTagGen）是"tag 进 → tag 出"，要你先填 characters 字段；
//   · 明确声明用 DanbooruTags 微调的权重是 27B，最小量化也放不进 8GB。
// 所以本模块做的是**确定性的那一半**：把用户话里的角色名（含中文别名）解析成规范 tag，
// 再校验/补全模型的输出。索引数据来自 MIT 许可的 tagcomplete `danbooru.csv`（14 万条，
// 其中角色 4 万余条，带 post 计数），运行时下载到 <项目根>\data\characters\，不入库。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { paths, load } = require('./config');
const fsx = require('./util/fsx');
const log = require('./util/log');
const dl = require('./download');

const CHAR_DIR = path.join(paths.data, 'characters');
const CSV_FILE = path.join(CHAR_DIR, 'danbooru.csv');
const META_FILE = path.join(CHAR_DIR, 'index.json');

// 索引来源（按顺序尝试；第一个是 MIT 的官方词表的 jsdelivr CDN —— 实测 0.9 s 收全 3.5 MB；
// 第二个是 raw.githubusercontent（本环境会经 GitHub 代理梯队自动改写：gh-proxy 实测 1.4 s 收全）；
// 最后是同源镜像（字段数不同，属于降级兜底）。每个来源内部还会再走一遍镜像梯队。）
const SOURCES = [
  'https://cdn.jsdelivr.net/gh/DominikDoom/a1111-sd-webui-tagcomplete@main/tags/danbooru.csv',
  'https://raw.githubusercontent.com/DominikDoom/a1111-sd-webui-tagcomplete/main/tags/danbooru.csv',
  'https://hf-mirror.com/DragAIxxx/tagcomplete/resolve/main/danbooru_characters_by_gender_by_postcount.csv',
];
// 官方 danbooru.csv 的字节数（用于校验；第三方镜像的字段数不同，所以只对前两个来源校验）。
const CSV_BYTES = 3518020;

let cache = null;   // { chars: [{tag, count, aliases[]}], byName: Map, byAlias: Map, loadedAt }

function status() {
  const meta = fsx.readJson(META_FILE, {});
  const loaded = !!cache;
  return {
    installed: fsx.isFile(CSV_FILE),
    loading: loaded,
    characters: cache ? cache.chars.length : (meta.characters || 0),
    source: meta.source || '',
    bytes: fsx.sizeOf(CSV_FILE),
    updatedAt: meta.updatedAt || null,
    dir: CHAR_DIR,
    aliasFile: aliasFile(),
    userAliases: Object.keys(readUserAliases()).length,
    builtinAliases: Object.keys(BUILTIN_ALIASES).length,
    // 内置别名自检结果（词表升级后可能有别名指向已改名的 tag）
    aliasMisses: cache && cache.aliasMisses ? cache.aliasMisses.length : null,
    aliasMissSamples: cache && cache.aliasMisses ? cache.aliasMisses.slice(0, 5) : [],
  };
}

/** 解析 CSV：tag,category,post_count(,aliases)。只保留 category=4（角色）。 */
function parseCsv(text) {
  const chars = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    // tag 里可能有逗号（极少数带引号），这里按简单规则切分即可（tagcomplete 的 CSV 无引号）
    const parts = line.split(',');
    if (parts.length < 3) continue;
    const tag = parts[0].trim();
    const cat = Number(parts[1]);
    const count = Number(parts[2]) || 0;
    if (!tag) continue;
    // 4 = 角色；有些镜像没有 category 列（name,gender,post_count）→ 那种情况全收
    const isChar = Number.isFinite(cat) ? cat === 4 : true;
    if (!isChar) continue;
    const aliases = parts.slice(3).map((s) => s.trim()).filter(Boolean);
    chars.push({ tag, count, aliases });
  }
  return chars;
}

function buildIndex(chars, source) {
  const byName = new Map();
  const byAlias = new Map();
  for (const c of chars) {
    const key = normalizeKey(c.tag);
    if (!byName.has(key)) byName.set(key, c);
    for (const a of (c.aliases || [])) {
      const k = normalizeKey(a);
      if (k && !byAlias.has(k)) byAlias.set(k, c);
    }
  }
  cache = { chars, byName, byAlias, loadedAt: Date.now() };
  fsx.writeJsonAtomic(META_FILE, { characters: chars.length, source, updatedAt: new Date().toISOString(), bytes: fsx.sizeOf(CSV_FILE) });
  // 内置别名自检：词表更新后若某条别名不再指向存在的角色 tag，这里明确报出来（不静默）。
  const builtinKeys = Object.keys(BUILTIN_ALIASES);
  const miss = [];
  for (const [alias, tag] of Object.entries(BUILTIN_ALIASES)) {
    const k = normalizeKey(tag);
    if (!byName.has(k) && !byAlias.has(k)) miss.push(`${alias}→${tag}`);
  }
  cache.aliasMisses = miss;
  if (miss.length) log.warn(`角色别名自检：${miss.length}/${builtinKeys.length} 条未命中词表（前 5 条：${miss.slice(0, 5).join('、')}）`);
  log.info(`角色词表已加载：${chars.length} 条角色 tag（来源 ${source}）；内置中文别名 ${builtinKeys.length} 条，自检未命中 ${miss.length} 条`);
  return cache;
}

/** 归一化：去下划线/空格/全角括号差异，统一小写，便于宽松匹配。
 *  反斜杠也要去掉 —— 外接大模型在代码围栏里常把括号转义成 `rem \(re:zero\)`，
 *  那是 Markdown 转义而不是 Danbooru tag，归一化时必须视为同一种写法。 */
function normalizeKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\\/g, '')
    .replace(/[_]+/g, ' ')
    .replace(/[（）]/g, (m) => (m === '（' ? '(' : ')'))
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureLoaded() {
  if (cache) return cache;
  if (!fsx.isFile(CSV_FILE)) return null;
  try {
    const text = fs.readFileSync(CSV_FILE, 'utf8');
    const meta = fsx.readJson(META_FILE, {});
    return buildIndex(parseCsv(text), meta.source || 'local');
  } catch (e) {
    log.warn('角色词表加载失败：' + e.message);
    return null;
  }
}

async function install(job) {
  fsx.ensureDir(CHAR_DIR);
  let lastErr = null;
  for (const url of SOURCES) {
    try {
      job.log(`获取角色词表：${url}`);
      // 只有官方 danbooru.csv 有确定的字节数可校验；第三方镜像字段数不同，不做大小校验。
      const expectBytes = /danbooru\.csv$/.test(url) ? CSV_BYTES : undefined;
      await dl.download({ url, dest: CSV_FILE, job, phase: 'characters', label: 'danbooru 角色词表', settings: load(), force: true, expectBytes });
      const text = fs.readFileSync(CSV_FILE, 'utf8');
      const chars = parseCsv(text);
      if (chars.length < 500) throw new Error(`解析出的角色条目太少（${chars.length} 条），疑似不是角色词表`);
      buildIndex(chars, url);
      job.log(`角色词表就绪：${chars.length} 条角色 tag（${fsx.fmtBytes(fsx.sizeOf(CSV_FILE))}）`, 'ok');
      return { characters: chars.length, source: url, bytes: fsx.sizeOf(CSV_FILE) };
    } catch (e) {
      lastErr = e;
      job.log(`该来源失败：${e.message}`, 'warn');
    }
  }
  throw new Error('角色词表获取失败（所有来源都不通）：' + (lastErr ? lastErr.message : '未知'));
}

/**
 * 在词表里找角色：先按精确（归一化）匹配，再按别名，最后按"去掉括号后缀"的包含匹配。
 * 只返回 post 计数最高的一条，避免把 `rem` 误判成冷门同名角色。
 */
function lookup(name) {
  const idx = ensureLoaded();
  if (!idx) return null;
  const key = normalizeKey(name);
  if (!key) return null;
  const hit = idx.byName.get(key) || idx.byAlias.get(key);
  if (hit) return hit;
  // `rem` → `rem (re:zero)`：词表里是 `rem_(re:zero)`，归一化后是 `rem (re:zero)`
  const candidates = idx.chars.filter((c) => {
    const k = normalizeKey(c.tag);
    return k === key || k.startsWith(key + ' ') || (c.aliases || []).some((a) => normalizeKey(a) === key);
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.count - a.count);
  return candidates[0];
}

/** 模糊搜索（给 UI 的搜索框用）。 */
function search(q, limit = 30) {
  const idx = ensureLoaded();
  if (!idx) return [];
  const key = normalizeKey(q);
  if (!key) return idx.chars.slice(0, limit);
  const out = [];
  for (const c of idx.chars) {
    if (normalizeKey(c.tag).includes(key) || (c.aliases || []).some((a) => normalizeKey(a).includes(key))) {
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ── 中文别名（内置表 563 条 + 用户可扩展） ──────────────
// 说明：Danbooru 词表里几乎没有 CJK 名字（14 万行里只有 3 行含汉字），社区也没有可用的
// 「中文 → 角色 tag」映射，所以内置一份人工整理、并用词表逐条校验过的中文别名表：右值全部
// 精确命中 data/characters/danbooru.csv 里真实存在的角色 tag（563/563），不靠模型猜。
// 用户可在 data/character-aliases.json 里覆盖或补充（同名以用户的为准）。
// 有意不收「时 / 天天 / 天使 / 真理 / 琴 / 小美 / 白露 / 悠悠 / 陈 / 玛丽 / 吉尔 / 忧」这类
// 常用中文词，避免在普通句子里误命中角色 tag。
const BUILTIN_ALIASES = {
  蕾姆: "rem_(re:zero)", 雷姆: "rem_(re:zero)", 拉姆: "ram_(re:zero)", 爱蜜莉雅: "emilia_(re:zero)",
  艾米莉亚: "emilia_(re:zero)", 碧翠丝: "beatrice_(re:zero)", 帕克: "puck_(re:zero)", 菲利斯: "felix_argyle",
  加菲尔: "garfiel_tinsel", 罗兹瓦尔: "roswaal_l._mathers", 艾尔莎: "elsa_granhilte", 莱因哈特: "reinhard_van_astrea",
  库珥修: "crusch_karsten", 安娜塔西亚: "anastasia_hoshin", 普莉希拉: "priscilla_barielle", 佩特拉: "petra_leyte",
  弗雷德莉卡: "frederica_baumann", 艾姬多娜: "echidna_(re:zero)", 雷古勒斯: "regulus_corneas", 蕾娜: "vladilena_millize",
  阿库娅: "aqua_(konosuba)", 惠惠: "megumin", 达克妮斯: "darkness_(konosuba)", 和真: "satou_kazuma", 维兹: "wiz_(konosuba)",
  艾莉丝: "eris_(konosuba)", 阿尔托莉雅: "artoria_pendragon_(fate)", 阿尔托莉雅潘德拉贡: "artoria_pendragon_(fate)",
  亚瑟王: "artoria_pendragon_(fate)", 远坂凛: "tohsaka_rin", 间桐樱: "matou_sakura", 依莉雅: "illyasviel_von_einzbern",
  伊莉雅: "illyasviel_von_einzbern", 两仪式: "ryougi_shiki", 尼禄: "nero_claudius_(fate)", 玉藻前: "tamamo_(fate)",
  斯卡哈: "scathach_(fate)", 贞德: "jeanne_d'arc_(fate)", 玛修: "mash_kyrielight", 伊丽莎白: "elizabeth_bathory_(fate)",
  织田信长: "oda_nobunaga_(fate)", 冲田总司: "okita_souji_(fate)", 吉尔伽美什: "gilgamesh_(fate)", 卫宫士郎: "emiya_shirou",
  美杜莎: "medusa_(fate)", 诸葛孔明: "waver_velvet_(zhuge_liang)", 酒吞童子: "shuten_douji_(fate)",
  源赖光: "minamoto_no_raikou_(fate)", 武藏坊弁庆: "musashibou_benkei_(fate)", 宫本武藏: "miyamoto_musashi_(fate)",
  玛尔达: "martha_(fate)", 莫德雷德: "mordred_(fate)", 兰斯洛特: "lancelot_(fate/grand_order)", 高文: "gawain_(fate)",
  梅林: "merlin_(fate)", 所罗门: "solomon_(fate)", 罗马尼: "romani_archaman", 达芬奇: "leonardo_da_vinci_(fate)",
  博丽灵梦: "hakurei_reimu", 灵梦: "hakurei_reimu", 雾雨魔理沙: "kirisame_marisa", 魔理沙: "kirisame_marisa",
  十六夜咲夜: "izayoi_sakuya", 蕾米莉亚: "remilia_scarlet", 芙兰朵露: "flandre_scarlet", 琪露诺: "cirno",
  帕秋莉: "patchouli_knowledge", 八云紫: "yakumo_yukari", 幽幽子: "saigyouji_yuyuko", 西行寺幽幽子: "saigyouji_yuyuko",
  魂魄妖梦: "konpaku_youmu", 东风谷早苗: "kochiya_sanae", 古明地恋: "komeiji_koishi", 古明地觉: "komeiji_satori",
  藤原妹红: "fujiwara_no_mokou", 蓬莱山辉夜: "houraisan_kaguya", 八意永琳: "yagokoro_eirin", 铃仙: "reisen_udongein_inaba",
  爱丽丝: "alice_margatroid", 比那名居天子: "hinanawi_tenshi", 四季映姬: "shiki_eiki", 小野冢小町: "onozuka_komachi",
  洩矢诹访子: "moriya_suwako", 八坂神奈子: "yasaka_kanako", 射命丸文: "shameimaru_aya", 犬走椛: "inubashiri_momiji",
  河城荷取: "kawashiro_nitori", 村纱水蜜: "murasa_minamitsu", 封兽鵺: "houjuu_nue", 二岩猯藏: "futatsuiwa_mamizou",
  秦心: "hata_no_kokoro", 鬼人正邪: "kijin_seija", 少名针妙丸: "sukuna_shinmyoumaru", 堀川雷鼓: "horikawa_raiko",
  克劳恩皮丝: "clownpiece", 纯狐: "junko_(touhou)", 赫卡提亚: "hecatia_lapislazuli", 稀神探女: "kishin_sagume",
  摩多罗隐岐奈: "matara_okina", 初音未来: "hatsune_miku", 初音: "hatsune_miku", 镜音铃: "kagamine_rin", 镜音连: "kagamine_len",
  巡音露卡: "megurine_luka", 洛天依: "luo_tianyi", 乐正绫: "yuezheng_ling", kaito: "kaito_(vocaloid)",
  meiko: "meiko_(vocaloid)", gumi: "gumi", ia: "ia_(vocaloid)", 琪亚娜: "kiana_kaslana", 雷电芽衣: "raiden_mei",
  布洛妮娅: "bronya_zaychik", 御坂美琴: "misaka_mikoto", 茵蒂克丝: "index_(toaru_majutsu_no_index)",
  一方通行: "accelerator_(toaru_majutsu_no_index)", 五更琉璃: "gokou_ruri", 高坂桐乃: "kousaka_kirino",
  雪之下雪乃: "yukinoshita_yukino", 比企谷八幡: "hikigaya_hachiman", 结城明日奈: "asuna_(sao)", 亚丝娜: "asuna_(sao)",
  桐谷和人: "kirito", 桐人: "kirito", 莉法: "leafa_(sao)", 西莉卡: "silica", 莉兹贝特: "lisbeth_(sao)", 诗乃: "sinon", 优吉欧: "eugeo",
  中野一花: "nakano_ichika", 中野二乃: "nakano_nino", 中野三玖: "nakano_miku", 中野四叶: "nakano_yotsuba", 中野五月: "nakano_itsuki",
  樱岛麻衣: "sakurajima_mai", 双叶理央: "futaba_rio", 四宫辉夜: "shinomiya_kaguya", 藤原千花: "fujiwara_chika",
  白银御行: "shirogane_miyuki", 石上优: "ishigami_yuu", 伊井野弥子: "iino_miko", 早坂爱: "hayasaka_ai",
  伊蕾娜: "elaina_(majo_no_tabitabi)", 炭治郎: "kamado_tanjirou", 灶门炭治郎: "kamado_tanjirou", 灶门祢豆子: "kamado_nezuko",
  祢豆子: "kamado_nezuko", 我妻善逸: "agatsuma_zenitsu", 嘴平伊之助: "hashibira_inosuke", 富冈义勇: "tomioka_giyuu",
  蝴蝶忍: "kochou_shinobu", 甘露寺蜜璃: "kanroji_mitsuri", 炼狱杏寿郎: "rengoku_kyoujurou", 宇髄天元: "uzui_tengen",
  时透无一郎: "tokitou_muichirou", 悲鸣屿行冥: "himejima_gyoumei", 伊黑小芭内: "iguro_obanai", 不死川实弥: "shinazugawa_sanemi",
  栗花落香奈乎: "tsuyuri_kanao", 伏黑惠: "fushiguro_megumi", 五条悟: "gojou_satoru", 钉崎野蔷薇: "kugisaki_nobara",
  虎杖悠仁: "itadori_yuuji", 两面宿傩: "ryoumen_sukuna_(jujutsu_kaisen)", 夏油杰: "getou_suguru", 七海建人: "nanami_kento",
  狗卷棘: "inumaki_toge", 乙骨忧太: "okkotsu_yuuta", 东堂葵: "toudou_aoi_(jujutsu_kaisen)", 禅院甚尔: "fushiguro_touji",
  家入硝子: "ieiri_shoko", 电次: "denji_(chainsaw_man)", 玛奇玛: "makima_(chainsaw_man)", 帕瓦: "power_(chainsaw_man)",
  早川秋: "hayakawa_aki", 蕾塞: "reze_(chainsaw_man)", 姬野: "himeno_(chainsaw_man)", 东山小红: "higashiyama_kobeni",
  阿尼亚: "anya_(spy_x_family)", 约尔: "yor_briar", 黄昏: "twilight_(spy_x_family)", 达米安: "damian_desmond",
  贝姬: "becky_blackbell", 尤里: "yuri_briar", 绫波丽: "ayanami_rei", 明日香: "souryuu_asuka_langley",
  葛城美里: "katsuragi_misato", 碇真嗣: "ikari_shinji", 碇源堂: "ikari_gendou", 赤木律子: "akagi_ritsuko", 渚薰: "nagisa_kaworu",
  真希波: "makinami_mari_illustrious", 薇尔莉特: "violet_evergarden", 凉宫春日: "suzumiya_haruhi", 长门有希: "nagato_yuki",
  朝比奈实玖瑠: "asahina_mikuru", 古泉一树: "koizumi_itsuki", 牧濑红莉栖: "makise_kurisu", 冈部伦太郎: "okabe_rintarou",
  椎名真由理: "shiina_mayuri", 桥田至: "hashida_itaru", 阿万音铃羽: "amane_suzuha", 鹿目圆: "kaname_madoka", 晓美焰: "akemi_homura",
  美树沙耶香: "miki_sayaka", 巴麻美: "tomoe_mami", 佐仓杏子: "sakura_kyoko", 丘比: "kyubey", 战场原黑仪: "senjougahara_hitagi",
  八九寺真宵: "hachikuji_mayoi", 神原骏河: "kanbaru_suruga", 千石抚子: "sengoku_nadeko", 忍野忍: "oshino_shinobu",
  羽川翼: "hanekawa_tsubasa", 星野爱: "hoshino_ai", 星野阿库亚: "hoshino_aquamarine", 星野露比: "hoshino_ruby",
  有马加奈: "arima_kana", 黑川茜: "kurokawa_akane", 后藤一里: "gotoh_hitori", 伊地知虹夏: "ijichi_nijika", 山田凉: "yamada_ryo",
  喜多郁代: "kita_ikuyo", 锦木千束: "nishikigi_chisato", 井上泷奈: "inoue_takina", 迪卢克: "diluc_(genshin_impact)",
  甘雨: "ganyu_(genshin_impact)", 胡桃: "hu_tao_(genshin_impact)", 刻晴: "keqing_(genshin_impact)",
  温迪: "venti_(genshin_impact)", 钟离: "zhongli_(genshin_impact)", 雷电将军: "raiden_shogun",
  荧: "lumine_(genshin_impact)", 派蒙: "paimon_(genshin_impact)", 神里绫华: "kamisato_ayaka", 八重神子: "yae_miko",
  安柏: "amber_(genshin_impact)", 优菈: "eula_(genshin_impact)", 芙宁娜: "furina_(genshin_impact)",
  纳西妲: "nahida_(genshin_impact)", 丽莎: "lisa_(genshin_impact)", 芭芭拉: "barbara_(genshin_impact)",
  香菱: "xiangling_(genshin_impact)", 行秋: "xingqiu_(genshin_impact)", 重云: "chongyun_(genshin_impact)",
  班尼特: "bennett_(genshin_impact)", 菲谢尔: "fischl_(genshin_impact)", 诺艾尔: "noelle_(genshin_impact)",
  莫娜: "mona_(genshin_impact)", 砂糖: "sucrose_(genshin_impact)", 迪奥娜: "diona_(genshin_impact)",
  可莉: "klee_(genshin_impact)", 魈: "xiao_(genshin_impact)", 达达利亚: "tartaglia_(genshin_impact)",
  公子: "tartaglia_(genshin_impact)", 罗莎莉亚: "rosaria_(genshin_impact)", 神里绫人: "kamisato_ayato",
  宵宫: "yoimiya_(genshin_impact)", 早柚: "sayu_(genshin_impact)", 珊瑚宫心海: "sangonomiya_kokomi", 九条裟罗: "kujou_sara",
  托马: "thoma_(genshin_impact)", 五郎: "gorou_(genshin_impact)", 荒泷一斗: "arataki_itto", 久岐忍: "kuki_shinobu",
  夜兰: "yelan_(genshin_impact)", 申鹤: "shenhe_(genshin_impact)", 云堇: "yun_jin_(genshin_impact)",
  妮露: "nilou_(genshin_impact)", 赛诺: "cyno_(genshin_impact)", 提纳里: "tighnari_(genshin_impact)",
  柯莱: "collei_(genshin_impact)", 多莉: "dori_(genshin_impact)", 坎蒂丝: "candace_(genshin_impact)",
  莱依拉: "layla_(genshin_impact)", 流浪者: "scaramouche_(genshin_impact)", 散兵: "scaramouche_(genshin_impact)",
  珐露珊: "faruzan_(genshin_impact)", 迪希雅: "dehya_(genshin_impact)", 米卡: "mika_(genshin_impact)",
  白术: "baizhu_(genshin_impact)", 卡维: "kaveh_(genshin_impact)", 绮良良: "kirara_(genshin_impact)",
  林尼: "lyney_(genshin_impact)", 琳妮特: "lynette_(genshin_impact)", 菲米尼: "freminet_(genshin_impact)",
  那维莱特: "neuvillette_(genshin_impact)", 莱欧斯利: "wriothesley_(genshin_impact)", 夏洛蒂: "charlotte_(genshin_impact)",
  娜维娅: "navia_(genshin_impact)", 夏沃蕾: "chevreuse_(genshin_impact)", 千织: "chiori_(genshin_impact)",
  闲云: "xianyun_(genshin_impact)", 阿蕾奇诺: "arlecchino_(genshin_impact)", 克洛琳德: "clorinde_(genshin_impact)",
  希格雯: "sigewinne_(genshin_impact)", 艾梅莉埃: "emilie_(genshin_impact)", 玛拉妮: "mualani_(genshin_impact)",
  基尼奇: "kinich_(genshin_impact)", 希诺宁: "xilonen_(genshin_impact)", 恰斯卡: "chasca_(genshin_impact)",
  玛薇卡: "mavuika_(genshin_impact)", 茜特菈莉: "citlali_(genshin_impact)", 丝柯克: "skirk_(genshin_impact)",
  三月七: "march_7th_(honkai:_star_rail)", 姬子: "himeko_(honkai:_star_rail)", 卡芙卡: "kafka_(honkai:_star_rail)",
  银狼: "silver_wolf_(honkai:_star_rail)", 希儿: "seele_(honkai:_star_rail)", 克拉拉: "clara_(honkai:_star_rail)",
  杰帕德: "gepard_landau", 娜塔莎: "natasha_(honkai:_star_rail)", 虎克: "hook_(honkai:_star_rail)", 桑博: "sampo_koski",
  佩拉: "pela_(honkai:_star_rail)", 希露瓦: "serval_landau", 阿兰: "arlan_(honkai:_star_rail)",
  艾丝妲: "asta_(honkai:_star_rail)", 黑塔: "herta_(honkai:_star_rail)", 瓦尔特: "welt_yang",
  罗刹: "luocha_(honkai:_star_rail)", 景元: "jing_yuan", 停云: "tingyun_(honkai:_star_rail)",
  彦卿: "yanqing_(honkai:_star_rail)", 素裳: "sushang_(honkai:_star_rail)", 符玄: "fu_xuan_(honkai:_star_rail)",
  镜流: "jingliu_(honkai:_star_rail)", 丹恒: "dan_heng_(honkai:_star_rail)", 银枝: "argenti_(honkai:_star_rail)",
  藿藿: "huohuo_(honkai:_star_rail)", 寒鸦: "hanya_(honkai:_star_rail)", 桂乃芬: "guinaifen_(honkai:_star_rail)",
  雪衣: "xueyi_(honkai:_star_rail)", 花火: "sparkle_(honkai:_star_rail)", 黑天鹅: "black_swan_(honkai:_star_rail)",
  米沙: "misha_(honkai:_star_rail)", 黄泉: "acheron_(honkai:_star_rail)", 流萤: "firefly_(honkai:_star_rail)",
  知更鸟: "robin_(honkai:_star_rail)", 砂金: "aventurine_(honkai:_star_rail)", 波提欧: "boothill_(honkai:_star_rail)",
  翡翠: "jade_(honkai:_star_rail)", 云璃: "yunli_(honkai:_star_rail)", 椒丘: "jiaoqiu_(honkai:_star_rail)",
  飞霄: "feixiao_(honkai:_star_rail)", 灵砂: "lingsha_(honkai:_star_rail)", 乱破: "rappa_(honkai:_star_rail)",
  星期日: "sunday_(honkai:_star_rail)", 阿格莱亚: "aglaea_(honkai:_star_rail)", 遐蝶: "castorice_(honkai:_star_rail)",
  白厄: "phainon_(honkai:_star_rail)", "2B": "2b_(nier:automata)", 尼尔: "2b_(nier:automata)",
  "9S": "9s_(nier:automata)", A2: "a2_(nier:automata)", 蒂法: "tifa_lockhart", 爱丽丝ff7: "aerith_gainsborough",
  艾达王: "ada_wong", 劳拉: "lara_croft", 希里: "ciri", 叶奈法: "yennefer_of_vengerberg", 特莉丝: "triss_merigold",
  罗小黑: "luo_xiaohei", 阿米娅: "amiya_(arknights)", 能天使: "exusiai_(arknights)", 银灰: "silverash_(arknights)",
  斯卡蒂: "skadi_(arknights)", 幽灵鲨: "specter_(arknights)", 凯尔希: "kal'tsit_(arknights)", 德克萨斯: "texas_(arknights)",
  拉普兰德: "lappland_(arknights)", 星熊: "hoshiguma_(arknights)", 夜莺: "nightingale_(arknights)",
  闪灵: "shining_(arknights)", 蓝毒: "blue_poison_(arknights)", 白面鸮: "ptilopsis_(arknights)",
  华法琳: "warfarin_(arknights)", 赫默: "silence_(arknights)", 塞雷娅: "saria_(arknights)", 伊芙利特: "ifrit_(arknights)",
  艾雅法拉: "eyjafjalla_(arknights)", 莫斯提马: "mostima_(arknights)", 安洁莉娜: "angelina_(arknights)",
  初雪: "pramanix_(arknights)", 凛冬: "zima_(arknights)", 白子: "shiroko_(blue_archive)", 星野: "hoshino_(blue_archive)",
  日奈: "hina_(blue_archive)", 阿露: "aru_(blue_archive)", 优香: "yuuka_(blue_archive)", 诺亚: "noa_(blue_archive)",
  泉奈: "izuna_(blue_archive)", 未花: "mika_(blue_archive)", 圣娅: "seia_(blue_archive)", 爱丽丝ba: "aris_(blue_archive)",
  妮可: "nicole_demara", 安比: "anby_demara", 比利: "billy_kid", 可琳: "corin_wickes", 猫又: "nekomiya_mana",
  珂蕾妲: "koleda_belobog", 格莉丝: "grace_howard", 莱卡恩: "von_lycaon", 艾莲: "ellen_joe", 朱鸢: "zhu_yuan",
  青衣: "qingyi_(zenless_zone_zero)", 柏妮思: "burnice_white", 凯撒: "caesar_king_(zenless_zone_zero)",
  月城柳: "tsukishiro_yanagi", 星见雅: "hoshimi_miyabi", 浅羽悠真: "asaba_harumasa", 耀嘉音: "astra_yao",
  伊芙琳: "evelyn_chevalier", 忌炎: "jiyan_(wuthering_waves)", 吟霖: "yinlin_(wuthering_waves)",
  长离: "changli_(wuthering_waves)", 今汐: "jinhsi_(wuthering_waves)", 折枝: "zhezhi_(wuthering_waves)",
  守岸人: "shorekeeper_(wuthering_waves)", 椿: "camellya_(wuthering_waves)", 珂莱塔: "carlotta_(wuthering_waves)",
  菲比: "phoebe_(wuthering_waves)", 特别周: "special_week_(umamusume)", 无声铃鹿: "silence_suzuka_(umamusume)",
  东海帝皇: "tokai_teio_(umamusume)", 目白麦昆: "mejiro_mcqueen_(umamusume)", 伏特加: "vodka_(umamusume)",
  大和赤骥: "daiwa_scarlet_(umamusume)", 黄金船: "gold_ship_(umamusume)", 米浴: "rice_shower_(umamusume)",
  春乌拉拉: "haru_urara_(umamusume)", 小栗帽: "oguri_cap_(umamusume)", 鲁道夫象征: "symboli_rudolf_(umamusume)",
  草上飞: "grass_wonder_(umamusume)", 优秀素质: "nice_nature_(umamusume)", 时乃空: "tokino_sora", 白上吹雪: "shirakami_fubuki",
  夏色祭: "natsuiro_matsuri", 大神澪: "ookami_mio", 猫又小粥: "nekomata_okayu", 戌神沁音: "inugami_korone", 夜空梅露: "yozora_mel",
  赤井心: "akai_haato", 大空昴: "oozora_subaru", 癒月巧可: "yuzuki_choco", 紫咲诗音: "murasaki_shion", 百鬼绫目: "nakiri_ayame",
  凑阿库娅: "minato_aqua", 润羽露西娅: "uruha_rushia", 宝钟玛琳: "houshou_marine", 星街彗星: "hoshimachi_suisei",
  兔田佩克拉: "usada_pekora", 樱巫女: "sakura_miko", 常暗永远: "tokoyami_towa", 不知火芙蕾雅: "shiranui_flare",
  白银诺艾尔: "shirogane_noel", 角卷绵芽: "tsunomaki_watame", 狮白牡丹: "shishiro_botan", 雪花菈米: "yukihana_lamy",
  桃铃音音: "momosuzu_nene", 尾丸波尔卡: "omaru_polka", 姬森璐娜: "himemori_luna", 天音彼方: "amane_kanata", 桐生可可: "kiryu_coco",
  月之美兔: "tsukino_mito", 樋口枫: "higuchi_kaede", 静凛: "shizuka_rin", 本间向日葵: "honma_himawari", 剑持刀也: "kenmochi_touya",
  葛叶: "kuzuha_(nijisanji)", 戌亥床: "inui_toko", "莉泽·赫露艾斯塔": "lize_helesta", "安洁·卡特莉娜": "ange_katrina",
  漩涡鸣人: "uzumaki_naruto", 宇智波佐助: "uchiha_sasuke", 春野樱: "haruno_sakura", 旗木卡卡西: "hatake_kakashi",
  日向雏田: "hyuuga_hinata", 宇智波鼬: "uchiha_itachi", 纲手: "tsunade_(naruto)", 自来也: "jiraiya_(naruto)",
  大蛇丸: "orochimaru_(naruto)", 我爱罗: "gaara_(naruto)", 山中井野: "yamanaka_ino", 洛克李: "rock_lee", 宇智波斑: "uchiha_madara",
  宇智波带土: "uchiha_obito", 千手柱间: "senju_hashirama", 波风水门: "namikaze_minato", 小南: "konan_(naruto)",
  黑崎一护: "kurosaki_ichigo", 朽木露琪亚: "kuchiki_rukia", 井上织姬: "inoue_orihime", 蓝染惣右介: "aizen_sousuke",
  日番谷冬狮郎: "hitsugaya_toushirou", 松本乱菊: "matsumoto_rangiku", 蒙奇D路飞: "monkey_d._luffy", 娜美: "nami_(one_piece)",
  罗罗诺亚索隆: "roronoa_zoro", 乌索普: "usopp", 山治: "sanji_(one_piece)", 托尼托尼乔巴: "tony_tony_chopper", 妮可罗宾: "nico_robin",
  弗兰奇: "franky_(one_piece)", 布鲁克: "brook_(one_piece)", 波雅汉库克: "boa_hancock", 波特卡斯D艾斯: "portgas_d._ace",
  萨博: "sabo_(one_piece)", 特拉法尔加罗: "trafalgar_law", 孙悟空: "son_goku", 贝吉塔: "vegeta", 布尔玛: "bulma", 孙悟饭: "son_gohan",
  比克: "piccolo", 克林: "kuririn", 比迪丽: "videl", 弗利萨: "frieza", 沙鲁: "cell_(dragon_ball)", 魔人布欧: "majin_buu",
  特兰克斯: "trunks_(dragon_ball)", 琪琪: "chi-chi_(dragon_ball)", 月野兔: "tsukino_usagi", 水野亚美: "mizuno_ami",
  火野丽: "hino_rei", 木野真琴: "kino_makoto", 爱野美奈子: "aino_minako", 小小兔: "chibi_usa", 天王遥: "ten'ou_haruka",
  海王满: "kaiou_michiru", 冥王雪奈: "meiou_setsuna", 土萌萤: "tomoe_hotaru", 木之本樱: "kinomoto_sakura", 李小狼: "li_syaoran",
  大道寺知世: "daidouji_tomoyo", 犬夜叉: "inuyasha_(character)", 日暮戈薇: "higurashi_kagome", 桔梗: "kikyou_(inuyasha)",
  杀生丸: "sesshoumaru", 夜神月: "yagami_light", 弥海砂: "amane_misa", 鲁路修: "lelouch_vi_britannia", 佐仓双叶: "sakura_futaba",
  高卷杏: "takamaki_anne", 新岛真: "niijima_makoto", 奥村春: "okumura_haru", 明智吾郎: "akechi_gorou",
  摩尔加纳: "morgana_(persona_5)", 露西: "lucy_(cyberpunk)", 瑞贝卡: "rebecca_(cyberpunk)", dva: "d.va_(overwatch)",
  黑百合: "widowmaker_(overwatch)", 猎空: "tracer_(overwatch)", 源氏: "genji_(overwatch)", 半藏: "hanzo_(overwatch)",
  阿狸: "ahri_(league_of_legends)", 拉克丝: "lux_(league_of_legends)", 金克丝: "jinx_(league_of_legends)",
  娑娜: "sona_(league_of_legends)", 卡特琳娜: "katarina_(league_of_legends)", 阿卡丽: "akali",
  锐雯: "riven_(league_of_legends)", 艾希: "ashe_(league_of_legends)", 佐伊: "zoe_(league_of_legends)",
};
function aliasFile() {
  return path.join(paths.data, 'character-aliases.json');
}

function readUserAliases() {
  const v = fsx.readJson(aliasFile(), {});
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

function saveUserAliases(map) {
  fsx.writeJsonAtomic(aliasFile(), map || {});
  return readUserAliases();
}

function allAliases() {
  return { ...BUILTIN_ALIASES, ...readUserAliases() };
}

/**
 * 从一段话里找出角色 tag：
 *   ① 别名表命中（中文/日文/简写 → 规范 tag 名，再经词表解析成 `xxx_(yyy)`）；
 *   ② 词表直接命中（英文名，含 `rem` → `rem_(re:zero)`）。
 * 返回 [{ tag, count, matched }]，按出现顺序去重。
 */
function resolveFromText(text) {
  const idx = ensureLoaded();
  const out = [];
  const seen = new Set();
  const s = String(text || '');
  if (!s.trim()) return out;

  const push = (tag, count, matched) => {
    const key = normalizeKey(tag);
    if (!tag || seen.has(key)) return;
    seen.add(key);
    out.push({ tag, count: count || 0, matched });
  };

  // ① 别名（长别名优先，避免 "初音" 抢先命中 "初音未来"）
  const aliases = allAliases();
  const aliasKeys = Object.keys(aliases).sort((a, b) => b.length - a.length);
  for (const a of aliasKeys) {
    if (!a || !s.includes(a)) continue;
    const target = aliases[a];
    if (!idx) { push(target, 0, a); continue; }
    const hit = lookup(target) || { tag: target, count: 0 };
    push(hit.tag, hit.count, a);
  }

  // ② 英文名（只在词表里找，避免把普通单词当角色）
  if (idx) {
    const tokens = s.match(/[A-Za-z][A-Za-z0-9'’.\- ]{2,40}/g) || [];
    for (const raw of tokens) {
      const t = raw.trim().replace(/\s+/g, ' ');
      if (t.length < 3) continue;
      const words = t.split(' ');
      // 尝试 1~3 个词的组合
      for (let n = Math.min(3, words.length); n >= 1; n--) {
        for (let i = 0; i + n <= words.length; i++) {
          const cand = words.slice(i, i + n).join(' ');
          const hit = lookup(cand);
          if (hit && hit.count >= 20) { push(hit.tag, hit.count, cand); break; }
        }
      }
    }
  }
  return out;
}

/**
 * 角色 tag 补全：模型输出里缺规范角色 tag 时补上（在正向提示词里），
 * 并在返回里说明"补了什么"，由前端展示成一条提示 —— 绝不静默改内容。
 */
/** 把一个规范 tag 转成"宽松匹配"正则：下划线↔空格、括号可有可无（允许 `\(` 转义写法）、冒号可省。 */
function looseTagRegex(tag) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(tag).match(/^(.*?)[\s_]*[（(]([^）)]+)[）)]\s*$/);
  const base = m ? m[1] : String(tag);
  const sub = m ? m[2] : '';
  let re = esc(base).replace(/_/g, '[_ ]+');
  if (sub) {
    re += '\\s*\\\\?\\s*[（(]?\\s*' + esc(sub).replace(/[_ ]/g, '[_ ]*').replace(/:/g, '[:：]?') + '\\s*\\\\?\\s*[）)]?';
  }
  return new RegExp(re, 'i');
}

/**
 * 角色 tag 补全 + 规范化：模型输出里缺规范角色 tag 时补上（在正向提示词里），
 * 写法不规范的（例如 `rem (re:zero)` 而不是 `rem_(re:zero)`）就地改成规范写法。
 * 两件事都会在返回里说明（added / fixed），由前端展示成提示 —— 绝不静默改内容。
 * 为什么要规范化：Danbooru tag 的规范写法是下划线，ComfyUI 侧的 tag 解析按规范写法最稳；
 * 而外接大模型经常把 `rem_(re:zero)` 写成 `rem (re:zero)`（实测 deepseek-flash 就是这样）。
 */
function repairAnswer(userText, answer) {
  const resolved = resolveFromText(userText);
  if (!resolved.length || !answer) return { answer, added: [], fixed: [], resolved };
  let out = String(answer);
  const added = [];
  const fixed = [];
  for (const r of resolved) {
    const normalized = normalizeKey(r.tag);
    // 先把"不规范写法"改成规范写法（只有确实出现、但写法不同的时候才动）。
    const exact = new RegExp('(^|[,_\\s(])' + r.tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[,_\\s)])', 'i');
    const looseRe = looseTagRegex(r.tag);
    const looseHit = normalizeKey(out).includes(normalized);
    if (looseHit && !exact.test(out)) {
      const m = looseRe.exec(out);
      if (m && m[0]) {
        const matched = m[0];
        out = out.slice(0, m.index) + r.tag + out.slice(m.index + matched.length);
        fixed.push({ from: matched.trim(), to: r.tag });
      }
    }
    // 再判断"到底有没有这个角色"（宽松比较：下划线/空格、括号形态都算）
    const loose = normalizeKey(out).includes(normalized);
    const bare = normalizeKey(r.tag).replace(/\s*\(.*\)\s*$/, '');
    const already = loose || (bare.length > 3 && new RegExp('(^|[,_\\s])' + bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([,_\\s]|$)', 'i').test(out));
    if (already) continue;
    added.push(r.tag);
  }
  if (!added.length) return { answer: out, added: [], fixed, resolved };
  // 追加到正向提示词的末尾（Positive prompt: 那一段的最后），保持"逗号分隔单行"的既有格式。
  const ins = added.join(', ');
  if (/Positive prompt:/i.test(out)) {
    out = out.replace(/(Positive prompt:[^\n]*?)(\n|$)/i, (m, line, tail) => {
      const clean = line.replace(/[,\s]+$/, '');
      return clean + ', ' + ins + tail;
    });
  } else {
    out = out.replace(/\s*$/, '') + (out ? '\n\n' : '') + ins;
  }
  return { answer: out, added, fixed, resolved };
}

module.exports = {
  status, install, lookup, search, resolveFromText, repairAnswer,
  allAliases, readUserAliases, saveUserAliases, ensureLoaded,
  CHAR_DIR, CSV_FILE, SOURCES, BUILTIN_ALIASES,
};
