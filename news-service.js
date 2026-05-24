/**
 * 基金投资助手 — 真实新闻数据服务 (news-service.js)
 * =================================================
 * 多源新闻接入层，支持海内外免费 API，自动降级。
 *
 * 数据源优先级:
 *   1. Finnhub.io      — 全球财经新闻 (免费 60 req/min)      [海外]
 *   2. NewsAPI.org      — 8万+新闻源 (免费 100 req/day)      [海外]
 *   3. RSS2JSON         — RSS 代理 (免费 1000 req/month)     [通用]
 *   4. 新浪财经 RSS      — 直接 RSS 抓取                      [国内]
 *   5. 本地模拟数据      — 兜底方案                           [离线]
 *
 * 使用方式:
 *   1. 在页面中引入此脚本
 *   2. 填入 API Key（可只填一个）
 *   3. 调用 fetchRealNews() 获取新闻
 */

const NewsService = (function() {
  'use strict';

  // ═══════════════════════════════════════════════════
  //  API 配置 — 在此填入你的免费 Key
  // ═══════════════════════════════════════════════════
  const API_KEYS = {
    // Finnhub: 免费注册 https://finnhub.io/register
    finnhub: '',           // 示例: 'ct3q2q9r01qk1g5mv5pg'
    // NewsAPI: 免费注册 https://newsapi.org/register
    newsapi: '',           // 示例: 'a1b2c3d4e5f6...'
  };

  // ═══════════════════════════════════════════════════
  //  RSS 源配置
  // ═══════════════════════════════════════════════════
  const RSS_FEEDS = {
    // 国内财经
    cls: {
      name: '财联社',
      url: 'https://www.cls.cn/api/sw?app=CailianpressWeb&os=web&sv=8.4.6',
      type: 'json',
      parser: parseClsResponse,
    },
    eastmoney_express: {
      name: '东方财富快讯',
      url: 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f12,f14,f3,f2,f15,f16,f17,f4,f8,f10,f9,f5,f18&secids=1.000001,0.399001,0.399006,1.000688,1.000300',
      type: 'json',
      parser: () => [], // market data only, use separate endpoint
    },
    sina_finance: {
      name: '新浪财经',
      url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2509&k=&num=20&page=1',
      type: 'json_cors',
      parser: parseSinaResponse,
    },
    wallstreetcn: {
      name: '华尔街见闻',
      url: 'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=20',
      type: 'json_cors',
      parser: parseWallstreetResponse,
    },
    // 海外财经
    reuters_rss: {
      name: '路透社',
      url: 'https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fnews.google.com%2Frss%2Ftopics%2FCAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB',
      type: 'json',
      parser: parseRssResponse,
    },
  };

  // ═══════════════════════════════════════════════════
  //  缓存 & 状态
  // ═══════════════════════════════════════════════════
  let newsCache = [];
  let lastFetchTime = null;
  let activeSource = null;
  let sourceStatus = {};  // source_name -> {ok, error, latency}

  // ═══════════════════════════════════════════════════
  //  Finnhub 适配器
  // ═══════════════════════════════════════════════════
  async function fetchFinnhub() {
    if (!API_KEYS.finnhub) return null;
    const token = API_KEYS.finnhub;

    // Finnhub 免费版只支持 "general" 分类
    const url = `https://finnhub.io/api/v1/news?category=general&token=${token}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Finnhub HTTP ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data)) throw new Error('Finnhub 响应格式异常');

    return data.slice(0, 20).map(item => ({
      title: item.headline || '',
      source: item.source || 'Finnhub',
      url: item.url || '',
      content: item.summary || '',
      time: new Date(item.datetime * 1000),
      priority: classifyPriority(item.headline + ' ' + (item.summary || '')),
      sectors: classifySectors(item.headline),
      tags: item.category ? [item.category] : [],
    }));
  }

  // ═══════════════════════════════════════════════════
  //  NewsAPI 适配器
  // ═══════════════════════════════════════════════════
  async function fetchNewsAPI() {
    if (!API_KEYS.newsapi) return null;
    const key = API_KEYS.newsapi;

    // 查询中文和英文财经新闻
    const queries = [
      'finance OR stock OR market',
      'A股 OR 沪深 OR 股市',
    ];
    const allResults = [];

    for (const q of queries) {
      const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=zh&sortBy=publishedAt&pageSize=15&apiKey=${key}`;
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.articles) {
        allResults.push(...data.articles);
      }
    }

    return allResults.slice(0, 20).map(item => ({
      title: item.title || '',
      source: item.source?.name || 'NewsAPI',
      url: item.url || '',
      content: item.description || '',
      time: new Date(item.publishedAt),
      priority: classifyPriority((item.title || '') + ' ' + (item.description || '')),
      sectors: classifySectors(item.title || ''),
      tags: [],
    }));
  }

  // ═══════════════════════════════════════════════════
  //  通用 RSS / JSON 抓取
  // ═══════════════════════════════════════════════════
  async function fetchRss(feedConfig) {
    const { url, type, parser, name } = feedConfig;
    let resp;
    if (type === 'json_cors') {
      // 需要 CORS 代理 — 使用 allorigins 或类似服务
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
      resp = await fetch(proxyUrl);
    } else {
      resp = await fetch(url);
    }
    if (!resp.ok) throw new Error(`${name} HTTP ${resp.status}`);
    const raw = await resp.json();
    return parser(raw, name);
  }

  function parseClsResponse(data, sourceName) {
    // 财联社电报格式
    const items = data?.data?.roll_data || data?.data || [];
    return items.slice(0, 20).map(item => ({
      title: item.title || item.content || '',
      source: sourceName,
      url: item.url || item.shareurl || '',
      content: item.brief || item.content || '',
      time: new Date(item.ctime * 1000 || Date.now()),
      priority: classifyPriority((item.title || '') + (item.brief || '')),
      sectors: classifySectors(item.title || ''),
      tags: item.subjects?.map?.(s => s.subject_name) || [],
    }));
  }

  function parseSinaResponse(data, sourceName) {
    const items = data?.result?.data || data?.data || [];
    return items.slice(0, 20).map(item => ({
      title: item.title || item.intro || '',
      source: sourceName,
      url: item.url || item.link || '',
      content: item.intro || item.keywords || '',
      time: new Date(item.ctime * 1000 || Date.now()),
      priority: classifyPriority((item.title || '') + (item.intro || '')),
      sectors: classifySectors(item.title || ''),
      tags: item.keywords?.split?.(',') || [],
    }));
  }

  function parseWallstreetResponse(data, sourceName) {
    const items = data?.data?.items || data?.data || [];
    return items.slice(0, 20).map(item => ({
      title: item.title || item.content_text || '',
      source: sourceName,
      url: item.uri ? `https://wallstreetcn.com${item.uri}` : '',
      content: item.content_text || item.title || '',
      time: new Date(item.display_time * 1000 || Date.now()),
      priority: classifyPriority((item.title || '') + (item.content_text || '')),
      sectors: classifySectors(item.title || ''),
      tags: item.channels?.map?.(c => c.title) || [],
    }));
  }

  function parseRssResponse(data, sourceName) {
    const items = data?.items || [];
    return items.slice(0, 20).map(item => ({
      title: item.title || '',
      source: sourceName,
      url: item.link || item.url || '',
      content: item.description || item.content || '',
      time: new Date(item.pubDate || item.published || Date.now()),
      priority: classifyPriority((item.title || '') + ' ' + (item.description || '')),
      sectors: classifySectors(item.title || ''),
      tags: item.categories || [],
    }));
  }

  // ═══════════════════════════════════════════════════
  //  优先级 & 板块分类
  // ═══════════════════════════════════════════════════
  const HIGH_KW = ['央行','降息','加息','降准','MLF','LPR','美联储','监管',
    '爆雷','清盘','崩盘','暴跌','大涨','突破','政策','北向','外资','净流入'];
  const MED_KW = ['板块','行业','指数','基金','ETF','分红','净值','重仓',
    '季报','年报','业绩','调研','评级','策略'];

  function classifyPriority(text) {
    for (const kw of HIGH_KW) if (text.includes(kw)) return 'high';
    for (const kw of MED_KW) if (text.includes(kw)) return 'medium';
    return 'low';
  }

  const SECTOR_KW = {
    '能源': ['能源','煤炭','石油','电力','光伏','锂电','储能','风电','氢能'],
    '黄金': ['黄金','贵金属','金价','避险','现货金','COMEX'],
    '有色': ['有色','铜','铝','稀土','锂矿','钴','镍','锌','钨'],
    '半导体': ['半导体','芯片','光刻','晶圆','封装','EDA','HBM','先进制程'],
    '光模块': ['光模块','CPO','光通信','800G','1.6T','硅光','光芯片'],
    '机器人': ['机器人','具身智能','人形','自动化','伺服','减速器','传感器'],
    '消费': ['消费','白酒','食品','家电','汽车','旅游','餐饮','零售'],
    '医药': ['医药','创新药','CRO','器械','生物','疫苗','基因','CXO'],
    '金融': ['银行','券商','保险','金融','地产','REITs'],
    'AI': ['AI','大模型','算力','GPU','应用','ChatGPT','生成式','智能体','Agent'],
  };

  function classifySectors(text) {
    const matched = [];
    for (const [sector, keywords] of Object.entries(SECTOR_KW)) {
      for (const kw of keywords) {
        if (text.includes(kw)) { matched.push(sector); break; }
      }
    }
    return matched.length > 0 ? [...new Set(matched)] : ['金融'];
  }

  // ═══════════════════════════════════════════════════
  //  主入口: 多源并发 → 合并去重 → 降级
  // ═══════════════════════════════════════════════════
  async function fetchRealNews(options = {}) {
    const { forceRefresh = false } = options;
    const now = Date.now();

    // 有缓存且未过期（5分钟），直接返回
    if (!forceRefresh && newsCache.length > 0 && lastFetchTime && (now - lastFetchTime) < 300000) {
      return { news: newsCache, source: activeSource, status: sourceStatus, cached: true };
    }

    const results = [];
    sourceStatus = {};

    // ——— 第1层: Finnhub (最快，全球财经) ———
    try {
      const t0 = performance.now();
      const data = await fetchFinnhub();
      const ms = (performance.now() - t0).toFixed(0);
      if (data?.length) {
        results.push(data);
        sourceStatus.finnhub = { ok: true, count: data.length, latency: ms + 'ms' };
      } else {
        sourceStatus.finnhub = { ok: false, error: '无数据返回', latency: ms + 'ms' };
      }
    } catch(e) {
      sourceStatus.finnhub = { ok: false, error: e.message };
    }

    // ——— 第2层: NewsAPI (覆盖面广) ———
    try {
      const t0 = performance.now();
      const data = await fetchNewsAPI();
      const ms = (performance.now() - t0).toFixed(0);
      if (data?.length) {
        results.push(data);
        sourceStatus.newsapi = { ok: true, count: data.length, latency: ms + 'ms' };
      } else {
        sourceStatus.newsapi = { ok: false, error: '无数据返回', latency: ms + 'ms' };
      }
    } catch(e) {
      sourceStatus.newsapi = { ok: false, error: e.message };
    }

    // ——— 第3层: 国内 RSS 源并发 ———
    const rssFeeds = [RSS_FEEDS.cls, RSS_FEEDS.wallstreetcn];
    const rssPromises = rssFeeds.map(async (feed) => {
      try {
        const t0 = performance.now();
        const data = await fetchRss(feed);
        const ms = (performance.now() - t0).toFixed(0);
        if (data?.length) {
          results.push(data);
          sourceStatus[feed.name] = { ok: true, count: data.length, latency: ms + 'ms' };
        } else {
          sourceStatus[feed.name] = { ok: false, error: '无数据', latency: ms + 'ms' };
        }
      } catch(e) {
        sourceStatus[feed.name] = { ok: false, error: e.message };
      }
    });

    // 等待所有 RSS 源（设置超时）
    await Promise.race([
      Promise.all(rssPromises),
      new Promise(resolve => setTimeout(resolve, 8000)),
    ]);

    // ——— 合并 & 去重 ———
    if (results.length > 0) {
      const seen = new Set();
      const merged = [];
      for (const batch of results) {
        for (const item of batch) {
          const key = item.title.slice(0, 60);
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(item);
          }
        }
      }
      // 按时间倒序
      merged.sort((a, b) => (b.time?.getTime?.() || 0) - (a.time?.getTime?.() || 0));

      newsCache = merged;
      lastFetchTime = now;
      activeSource = Object.entries(sourceStatus)
        .filter(([,v]) => v.ok)
        .map(([k]) => k)
        .join(' + ') || '无可用源';

      return { news: merged, source: activeSource, status: sourceStatus, cached: false };
    }

    // ——— 降级: 无真实数据，返回 null ———
    activeSource = null;
    return { news: [], source: null, status: sourceStatus, cached: false };
  }

  // ═══════════════════════════════════════════════════
  //  对外 API
  // ═══════════════════════════════════════════════════
  return {
    fetch: fetchRealNews,
    setKey: (provider, key) => { API_KEYS[provider] = key; },
    getStatus: () => ({ activeSource, sourceStatus, cacheSize: newsCache.length, lastFetchTime }),
    clearCache: () => { newsCache = []; lastFetchTime = null; },
    SOURCES: Object.keys(RSS_FEEDS).concat(['finnhub', 'newsapi']),
    RSS_FEEDS,
    API_KEYS,
  };

})();

// 导出到全局（兼容非模块环境）
if (typeof window !== 'undefined') {
  window.NewsService = NewsService;
}
