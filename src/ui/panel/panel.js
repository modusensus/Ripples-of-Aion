// 岁月涟漪 · 记忆图谱面板（交互式三栏版）
// channel 与 src/ui/ipc.ts 对应：插件侧通过 ctx.registerIpc 注册短名，
// 框架命名空间化为 plugin:ripples-of-aion:<channel>，这里用完整名 invoke。
// 安全约定：记忆内容是 LLM 派生的不可信数据，渲染只允许 textContent。
const { ipcRenderer } = require("electron");

const GET_STATE_CHANNEL = "plugin:ripples-of-aion:get-state";
const FORGET_CHANNEL = "plugin:ripples-of-aion:forget";
const DREAM_NOW_CHANNEL = "plugin:ripples-of-aion:dream-now";
const GET_CONFIG_CHANNEL = "plugin:ripples-of-aion:get-config";
const SAVE_CONFIG_CHANNEL = "plugin:ripples-of-aion:save-config";
const BROWSE_CHANNEL = "plugin:ripples-of-aion:browse-memories";
const GET_GRAPH_CHANNEL = "plugin:ripples-of-aion:get-graph";
const SEARCH_MEMORIES_CHANNEL = "plugin:ripples-of-aion:search-memories";

// ── 图标：Lucide v1.42 路径数据（ISC license），沿用 dsh-mneme 的内联惯例——
// 插件运行时不能 require 第三方库，morphicons/lucide 素材以静态元组随包分发，
// stroke 取 currentColor 跟随主题。
const ICON_PATHS = {
  search: [["path", { d: "m21 21-4.34-4.34" }], ["circle", { cx: "11", cy: "11", r: "8" }]],
  refresh: [["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }], ["path", { d: "M21 3v5h-5" }], ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }], ["path", { d: "M8 16H3v5" }]],
  chevronDown: [["path", { d: "m6 9 6 6 6-6" }]],
  flame: [["path", { d: "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" }]],
  inbox: [["polyline", { points: "22 12 16 12 14 15 10 15 8 12 2 12" }], ["path", { d: "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" }]],
  // share2 = 图谱页标签图标，slidersHorizontal = 检索台页标签图标（与 index.html 内联 svg 同源）
  share2: [["circle", { cx: "18", cy: "5", r: "3" }], ["circle", { cx: "6", cy: "12", r: "3" }], ["circle", { cx: "18", cy: "19", r: "3" }], ["line", { x1: "8.59", x2: "15.42", y1: "13.51", y2: "17.49" }], ["line", { x1: "15.41", x2: "8.59", y1: "6.51", y2: "10.49" }]],
  slidersHorizontal: [["line", { x1: "21", x2: "14", y1: "4", y2: "4" }], ["line", { x1: "10", x2: "3", y1: "4", y2: "4" }], ["line", { x1: "21", x2: "12", y1: "12", y2: "12" }], ["line", { x1: "8", x2: "3", y1: "12", y2: "12" }], ["line", { x1: "21", x2: "16", y1: "20", y2: "20" }], ["line", { x1: "12", x2: "3", y1: "20", y2: "20" }], ["line", { x1: "14", x2: "14", y1: "2", y2: "6" }], ["line", { x1: "8", x2: "8", y1: "10", y2: "14" }], ["line", { x1: "16", x2: "16", y1: "18", y2: "22" }]],
};

function icon(name, className) {
  const parts = ICON_PATHS[name];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  for (const [tag, attrs] of parts || []) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.appendChild(node);
  }
  return svg;
}

const closeBtn = document.getElementById("close-btn");

const searchInput = document.getElementById("search-input");
const searchLimit = document.getElementById("search-limit");
const timeRange = document.getElementById("time-range");
const browseCountEl = document.getElementById("browse-count");
const refreshBtn = document.getElementById("refresh-btn");
const heatFilterEl = document.getElementById("heat-filter");
const sourceFilterEl = document.getElementById("source-filter");
const entityFilterEl = document.getElementById("entity-filter");
const memoryTreeEl = document.getElementById("memory-tree");
const memoryCardsEl = document.getElementById("memory-cards");

const claimListEl = document.getElementById("claim-list");
const insightsMetaEl = document.getElementById("insights-meta");
const clusterListEl = document.getElementById("cluster-list");
const conflictListEl = document.getElementById("conflict-list");
const dreamBtn = document.getElementById("dream-btn");
const saveBtn = document.getElementById("save-btn");
const saveStatusEl = document.getElementById("save-status");
const viewToggle = document.getElementById("view-toggle");

/** 时间戳 -> 本地时间字符串；失败时退回原始值。 */
function formatTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(timestamp ?? "");
  }
}

/** 短日期：2026/09/07。 */
function formatDay(timestamp) {
  try {
    return new Date(timestamp).toLocaleDateString("zh-CN");
  } catch {
    return String(timestamp ?? "");
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setEmpty(container, text, tag) {
  container.innerHTML = "";
  container.appendChild(el(tag || "li", "empty", text));
}

/** 实体着色：固定粉系友好调色板按名字哈希取色，稳定可复现。 */
const DOT_PALETTE = ["#e05a85", "#5aa7e0", "#7ac074", "#e0a23e", "#9a6ee0", "#e07a5a", "#4ab8a8", "#b85ad0"];

function dotColorOf(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return DOT_PALETTE[hash % DOT_PALETTE.length];
}

function dotNode(color) {
  const node = el("span", "dot");
  node.style.background = color;
  return node;
}

/** 热度三档：与 dsh-mneme HeatBadge 同口径（热 ≥66%、温 ≥33%、冷）。 */
function heatTier(heat) {
  if (heat >= 0.66) return "hot";
  if (heat >= 0.33) return "warm";
  return "cold";
}

function heatBadge(heat) {
  const tier = heatTier(heat);
  const badge = el("span", `heat-badge heat-badge--${tier}`);
  badge.title = `热度 ${Math.round(heat * 100)}%`;
  badge.appendChild(icon("flame"));
  badge.appendChild(el("span", null, `${Math.round(heat * 100)}%`));
  return badge;
}

// ── 导航切换 ────────────────────────────────────
// 记忆/实体/状态每次切入都刷新；设置只在首次进入时拉取配置。

let currentPage = "memory";
const pageLoaded = {};

function switchPage(name) {
  currentPage = name;
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.page === name);
  }
  for (const page of document.querySelectorAll(".page")) {
    page.hidden = page.id !== `page-${name}`;
  }
  // 视图切换（卡片/时间线）只对记忆页有意义
  viewToggle.style.visibility = name === "memory" ? "visible" : "hidden";
  if (name === "memory") browse();
  // 图谱页每次切入都重新拉数据渲染（实体共现会随记忆变化）
  if (name === "graph") renderGraph();
  // 检索台切进去就聚焦输入框，查询由用户显式触发（空查询只给提示不发请求）
  if (name === "search-console") consoleQueryEl.focus();
  // 时间轴面板与洞察都要 get-state 数据，切换时顺带刷新
  if (name !== "settings") refresh();
  if (name === "settings" && !pageLoaded.settings) loadSettings();
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => switchPage(tab.dataset.page));
}

// ── 记忆浏览器：数据与过滤 ──────────────────────

let browseRecords = [];
const filters = { heat: "all", source: "all", entity: "all", time: "all", view: "tree" };

const HEAT_TIERS = [
  { id: "all", label: "全部" },
  { id: "hot", label: "热" },
  { id: "warm", label: "温" },
  { id: "cold", label: "冷" },
];
const SOURCE_TIERS = [
  { id: "all", label: "全部" },
  { id: "active", label: "活跃" },
  { id: "forgotten", label: "已遗忘" },
];

/** 文本与时间范围先行过滤（这两个维度不参与 facet 计数，与 dsh-mneme 同思路）。 */
function baseRecords() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = todayStart - 6 * 24 * 3600 * 1000;
  const minTime = filters.time === "today" ? todayStart : filters.time === "week" ? weekStart : 0;
  return browseRecords.filter(
    (record) => record.createdAt >= minTime && record.content.toLowerCase().includes(searchInput.value.trim().toLowerCase()),
  );
}

/** 客户端过滤：热度 / 来源 / 实体三维度。 */
function applyFilters(records) {
  return records.filter((record) => {
    if (filters.heat !== "all" && heatTier(record.heat) !== filters.heat) return false;
    if (filters.source === "active" && record.deleted) return false;
    if (filters.source === "forgotten" && !record.deleted) return false;
    if (filters.entity !== "all" && !record.entities.includes(filters.entity)) return false;
    return true;
  });
}

/** 实体 facet：按出现次数降序，取前 12 个。 */
function entityFacet(records) {
  const counts = new Map();
  for (const record of records) {
    for (const entity of record.entities) counts.set(entity, (counts.get(entity) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
}

function renderChips(container, tiers, activeId, counts, withDots) {
  container.innerHTML = "";
  for (const tier of tiers) {
    const chip = el("button", `chip${activeId === tier.id ? " active" : ""}`);
    chip.type = "button";
    if (tier.color) chip.appendChild(dotNode(tier.color));
    chip.appendChild(el("span", null, tier.label));
    const count = counts.get(tier.id);
    if (count !== undefined) chip.appendChild(el("span", "chip-count", String(count)));
    chip.addEventListener("click", () => {
      if (tier.id === "entity") return;
      filters[container.id === "heat-filter" ? "heat" : container.id === "source-filter" ? "source" : "entity"] = tier.id;
      renderBrowser();
    });
    container.appendChild(chip);
  }
}

function renderFilterChips() {
  const base = baseRecords();
  const heatCounts = new Map(HEAT_TIERS.map((tier) => [tier.id, 0]));
  const sourceCounts = new Map(SOURCE_TIERS.map((tier) => [tier.id, 0]));
  for (const record of base) {
    heatCounts.set(heatTier(record.heat), (heatCounts.get(heatTier(record.heat)) ?? 0) + 1);
    sourceCounts.set(record.deleted ? "forgotten" : "active", (sourceCounts.get(record.deleted ? "forgotten" : "active") ?? 0) + 1);
  }
  heatCounts.set("all", base.length);
  sourceCounts.set("all", base.length);
  renderChips(heatFilterEl, HEAT_TIERS, filters.heat, heatCounts);
  renderChips(sourceFilterEl, SOURCE_TIERS, filters.source, sourceCounts);

  // 实体 facet：全部 + top12（带稳定色点）
  const entityCounts = entityFacet(base);
  entityFilterEl.innerHTML = "";
  const allChip = el("button", `chip${filters.entity === "all" ? " active" : ""}`);
  allChip.type = "button";
  allChip.appendChild(el("span", null, "全部"));
  allChip.appendChild(el("span", "chip-count", String(base.length)));
  allChip.addEventListener("click", () => {
    filters.entity = "all";
    renderBrowser();
  });
  entityFilterEl.appendChild(allChip);
  for (const [entity, count] of entityCounts) {
    if (filters.entity !== "all" && entity === filters.entity) {
      // 当前选中的实体即使不在 top12 也要保留，否则过滤器会凭空消失
    }
    const chip = el("button", `chip${filters.entity === entity ? " active" : ""}`);
    chip.type = "button";
    chip.appendChild(dotNode(dotColorOf(entity)));
    chip.appendChild(el("span", null, entity));
    chip.appendChild(el("span", "chip-count", String(count)));
    chip.addEventListener("click", () => {
      filters.entity = filters.entity === entity ? "all" : entity;
      renderBrowser();
    });
    entityFilterEl.appendChild(chip);
  }
  if (filters.entity !== "all" && !entityCounts.some(([entity]) => entity === filters.entity)) {
    const chip = el("button", "chip active");
    chip.type = "button";
    chip.appendChild(dotNode(dotColorOf(filters.entity)));
    chip.appendChild(el("span", null, filters.entity));
    chip.appendChild(el("span", "chip-count", "0"));
    entityFilterEl.appendChild(chip);
  }
}

// ── 记忆浏览器：渲染 ────────────────────────────

function forgetButton(record, rerender) {
  if (record.deleted) return el("span", "chip-count", "已遗忘");
  const btn = el("button", "forget-btn", "遗忘");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const res = await ipcRenderer.invoke(FORGET_CHANNEL, record.id);
      if (res && res.ok) {
        record.deleted = true;
        rerender();
      } else btn.disabled = false;
    } catch {
      btn.disabled = false;
    }
  });
  return btn;
}

/** 时间树：年 -> 日 两级折叠组（头 + children 容器，折叠才能整棵收起）。
 *  条目 = 实体色点 + 时间 + 内容（+热度徽章）。 */
function renderTree(records) {
  memoryTreeEl.innerHTML = "";
  if (records.length === 0) {
    setEmpty(memoryTreeEl, "没有匹配的记忆——放宽过滤条件试试", "div");
    return;
  }
  const byYear = new Map();
  for (const record of records) {
    const date = new Date(record.createdAt);
    const year = `${date.getFullYear()}年`;
    const day = `${date.getMonth() + 1}月${date.getDate()}日`;
    if (!byYear.has(year)) byYear.set(year, new Map());
    const byDay = byYear.get(year);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(record);
  }

  const makeGroupHead = (label, count, defaultCollapsed) => {
    const head = el("div", `tree-group-head${defaultCollapsed ? " collapsed" : ""}`);
    head.appendChild(icon("chevronDown", "chev"));
    head.appendChild(el("span", "tree-year", label));
    head.appendChild(el("span", "tree-count", String(count)));
    head.addEventListener("click", () => head.classList.toggle("collapsed"));
    return head;
  };

  for (const [year, byDay] of byYear) {
    const yearTotal = [...byDay.values()].reduce((sum, list) => sum + list.length, 0);
    const yearGroup = el("div", "tree-group");
    yearGroup.appendChild(makeGroupHead(year, yearTotal, false));
    const children = el("div", "tree-children");
    for (const [day, list] of byDay) {
      const dayGroup = el("div", "tree-group");
      dayGroup.appendChild(makeGroupHead(day, list.length, yearTotal > 40));
      const entries = el("ul", "tree-entries");
      for (const record of list) {
        const li = el("li", `tree-entry${record.deleted ? " deleted" : ""}`);
        li.appendChild(dotNode(dotColorOf(record.entities[0] ?? "未分类")));
        li.appendChild(el("span", "tree-time", formatTime(record.createdAt).slice(-8)));
        li.appendChild(el("span", "tree-content", record.content));
        if (heatTier(record.heat) !== "cold") li.appendChild(heatBadge(record.heat));
        li.appendChild(forgetButton(record, renderBrowser));
        entries.appendChild(li);
      }
      dayGroup.appendChild(entries);
      children.appendChild(dayGroup);
    }
    yearGroup.appendChild(children);
    memoryTreeEl.appendChild(yearGroup);
  }
}

/** 卡片视图：网格卡片，内容 + 时间 + 热度 + 遗忘。 */
function renderCards(records) {
  memoryCardsEl.innerHTML = "";
  if (records.length === 0) {
    setEmpty(memoryCardsEl, "没有匹配的记忆", "div");
    return;
  }
  for (const record of records) {
    const card = el("div", `mem-card${record.deleted ? " deleted" : ""}`);
    card.appendChild(el("div", "mem-content", record.content));
    const foot = el("div", "mem-foot");
    foot.appendChild(el("span", "time", formatTime(record.createdAt)));
    foot.appendChild(heatBadge(record.heat));
    foot.appendChild(forgetButton(record, renderBrowser));
    card.appendChild(foot);
    memoryCardsEl.appendChild(card);
  }
}

/** 过滤 + 视图渲染的统一入口：facet 计数与主列表同帧更新。 */
function renderBrowser() {
  renderFilterChips();
  const records = applyFilters(baseRecords()).sort((a, b) => b.createdAt - a.createdAt);
  if (filters.view === "cards") {
    memoryTreeEl.hidden = true;
    memoryCardsEl.hidden = false;
    renderCards(records);
  } else {
    memoryCardsEl.hidden = true;
    memoryTreeEl.hidden = false;
    renderTree(records);
  }
}

let browseSeq = 0;

/** 拉取浏览数据：文本/条数/含遗忘由服务端处理，其余过滤在面板端做。 */
async function browse() {
  const seq = ++browseSeq;
  refreshBtn.classList.add("spin");
  try {
    const res = await ipcRenderer.invoke(BROWSE_CHANNEL, {
      text: searchInput.value,
      limit: Number(searchLimit.value) || 20,
      includeDeleted: true,
    });
    if (seq !== browseSeq) return;
    browseRecords = Array.isArray(res && res.records) ? res.records : [];
    browseCountEl.textContent = `共 ${browseRecords.length} 条`;
    renderBrowser();
  } catch {
    if (seq !== browseSeq) return;
    browseCountEl.textContent = "共 – 条";
    setEmpty(memoryTreeEl, "记忆拉取失败，请重开窗口", "div");
    setEmpty(memoryCardsEl, "记忆拉取失败，请重开窗口", "div");
  } finally {
    if (seq === browseSeq) refreshBtn.classList.remove("spin");
  }
}

let searchTimer = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(browse, 300);
});
searchLimit.addEventListener("change", browse);
timeRange.addEventListener("change", () => {
  filters.time = timeRange.value;
  renderBrowser();
});
refreshBtn.addEventListener("click", browse);
for (const btn of viewToggle.querySelectorAll(".vt-btn")) {
  btn.addEventListener("click", () => {
    filters.view = btn.dataset.view;
    for (const item of viewToggle.querySelectorAll(".vt-btn")) {
      item.classList.toggle("active", item === btn);
    }
    renderBrowser();
  });
}

// ── 实体页（属性时间轴） ────────────────────────

/**
 * 把拍平的 claims 分组成 entity -> attribute -> 有序条目。
 * 组内按 validFrom 升序；validUntil == null 的为当前值（可能没有）。
 */
function groupClaims(claims) {
  const byEntity = new Map();
  for (const claim of claims) {
    if (!byEntity.has(claim.entity)) byEntity.set(claim.entity, new Map());
    const byAttr = byEntity.get(claim.entity);
    if (!byAttr.has(claim.attribute)) byAttr.set(claim.attribute, []);
    byAttr.get(claim.attribute).push(claim);
  }
  const grouped = [];
  for (const [entity, byAttr] of byEntity) {
    const attrs = [];
    for (const [attribute, entries] of byAttr) {
      entries.sort((a, b) => a.validFrom - b.validFrom);
      attrs.push({ attribute, entries });
    }
    attrs.sort((a, b) => {
      const latestA = a.entries[a.entries.length - 1].validFrom;
      const latestB = b.entries[b.entries.length - 1].validFrom;
      return latestB - latestA;
    });
    grouped.push({ entity, attrs });
  }
  grouped.sort((a, b) => {
    const latest = (g) => Math.max(...g.attrs.map((x) => x.entries[x.entries.length - 1].validFrom));
    return latest(b) - latest(a);
  });
  return grouped;
}

/** 渲染一个属性的轨道：当前值在上，历史按新→旧排列。 */
function renderAttrRow(attr) {
  const row = el("div", "attr-row");
  const rail = el("div", "attr-rail");
  const body = el("div", "attr-body");

  const current = [...attr.entries].reverse().find((c) => c.validUntil == null);
  const history = [...attr.entries]
    .filter((c) => c.validUntil != null)
    .sort((a, b) => b.validUntil - a.validUntil);

  const lines = [];
  if (current) lines.push({ kind: "current", claim: current });
  else lines.push({ kind: "current-empty" });
  for (const claim of history) lines.push({ kind: "past", claim });

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const dot = el("div", `attr-dot ${line.kind === "current" ? "current" : "past"}`);
    rail.appendChild(dot);
    if (i < lines.length - 1) rail.appendChild(el("div", "rail-line"));

    if (line.kind === "current-empty") {
      const p = el("div", "attr-line past-line");
      p.appendChild(el("b", null, attr.attribute));
      p.appendChild(document.createTextNode("：暂无有效值"));
      body.appendChild(p);
      continue;
    }
    const claim = line.claim;
    const p = el("div", `attr-line ${line.kind === "past" ? "past-line" : ""}`);
    p.appendChild(el("b", null, attr.attribute));
    p.appendChild(document.createTextNode("："));
    p.appendChild(el("span", "attr-value", claim.value));
    if (line.kind === "current") {
      p.appendChild(el("span", "attr-span", `自 ${formatDay(claim.validFrom)} 至今`));
    } else {
      p.appendChild(el("span", "attr-span", `${formatDay(claim.validFrom)} ~ ${formatDay(claim.validUntil)}`));
    }
    body.appendChild(p);
  }

  row.appendChild(rail);
  row.appendChild(body);
  return row;
}

function renderClaims(state) {
  const claims = Array.isArray(state && state.claims) ? state.claims : [];
  claimListEl.innerHTML = "";
  if (claims.length === 0) {
    const block = el("div", "entity-block");
    block.appendChild(el("div", "attr-line empty", "还没有可画成时间轴的属性声明——多聊聊会变化的细节（住哪、在做什么、养了什么），涟漪会自己漾开"));
    claimListEl.appendChild(block);
    updateClaimToggle(0);
    return;
  }
  const grouped = groupClaims(claims);
  for (const entity of grouped) {
    const block = el("div", "entity-block");
    const name = el("div", "entity-name");
    name.appendChild(dotNode(dotColorOf(entity.entity)));
    name.appendChild(document.createTextNode(entity.entity));
    block.appendChild(name);
    for (const attr of entity.attrs) block.appendChild(renderAttrRow(attr));
    claimListEl.appendChild(block);
  }
  updateClaimToggle(grouped.length);
}

// 属性时间轴折叠面板：默认收起，按钮带实体计数
const claimToggle = document.getElementById("claim-toggle");
const claimPanel = document.getElementById("claim-panel");

function updateClaimToggle(count) {
  const arrow = claimPanel.hidden ? "▾" : "▴";
  claimToggle.textContent = `实体属性时间轴 ${arrow}（${count} 个实体）`;
}

claimToggle.addEventListener("click", () => {
  claimPanel.hidden = !claimPanel.hidden;
  claimToggle.textContent = claimToggle.textContent.replace(/[▾▴]/, claimPanel.hidden ? "▾" : "▴");
});

// ── 状态页（autoDream 记忆沉淀） ────────────────

function renderInsightsMeta(insights) {
  insightsMetaEl.innerHTML = "";
  if (insights.dreaming) {
    const line = el("span", null, "autoDream 正在做梦，主题与矛盾稍后浮现…");
    line.insertBefore(el("span", "dreaming-dot"), line.firstChild);
    insightsMetaEl.appendChild(line);
    return;
  }
  if (!insights.lastRunAt) {
    insightsMetaEl.textContent = "还没有做过梦——对话静默后自动开始，或点右上角立即体验。";
    return;
  }
  insightsMetaEl.textContent = `上次做梦：${formatTime(insights.lastRunAt)}`;
}

function renderClusters(insights) {
  const clusters = Array.isArray(insights && insights.clusters) ? insights.clusters : [];
  clusterListEl.innerHTML = "";
  if (clusters.length === 0) {
    const block = el("div", "entity-block");
    block.appendChild(el("div", "attr-line empty", insights.lastRunAt ? "这次梦到的主题都还太小，没攒够成簇——继续聊，涟漪会慢慢聚起来" : "还没有洞察"));
    clusterListEl.appendChild(block);
    return;
  }
  for (const cluster of clusters) {
    const block = el("div", "entity-block");
    const head = el("div", "cluster-head");
    head.appendChild(el("span", "cluster-label", cluster.label));
    head.appendChild(el("span", "cluster-size", `${cluster.size} 条`));
    block.appendChild(head);

    const members = el("ul", "cluster-members");
    for (const member of cluster.members || []) members.appendChild(el("li", null, member));
    block.appendChild(members);
    if (cluster.size > (cluster.members || []).length) {
      block.appendChild(el("div", "cluster-more", `还有 ${cluster.size - cluster.members.length} 条记忆在这个主题里`));
    }
    clusterListEl.appendChild(block);
  }
}

function renderConflicts(insights) {
  const conflicts = Array.isArray(insights && insights.conflicts) ? insights.conflicts : [];
  conflictListEl.innerHTML = "";
  if (conflicts.length === 0) {
    const block = el("div", "entity-block");
    block.appendChild(el("div", "attr-line empty", "没有发现互相矛盾的记忆——时间轴在替你悄悄收拾旧结论"));
    conflictListEl.appendChild(block);
    return;
  }
  for (const conflict of conflicts) {
    const card = el("div", "conflict-card");
    const note = el("div", "conflict-note");
    note.appendChild(el("span", "conflict-tag", "矛盾"));
    note.appendChild(document.createTextNode(conflict.note));
    card.appendChild(note);
    for (const record of conflict.records || []) card.appendChild(el("div", "conflict-record", record));
    conflictListEl.appendChild(card);
  }
}

function renderInsightsPage(insights) {
  const data = insights || { lastRunAt: 0, dreaming: false, clusters: [], conflicts: [] };
  renderInsightsMeta(data);
  renderClusters(data);
  renderConflicts(data);
}

let dreaming = false;

async function startDream() {
  if (dreaming) return;
  dreaming = true;
  dreamBtn.disabled = true;
  try {
    const res = await ipcRenderer.invoke(DREAM_NOW_CHANNEL);
    if (!res || !res.ok) {
      insightsMetaEl.textContent =
        res && res.reason === "unavailable"
          ? "整合能力不可用（宿主服务缺失），请检查插件依赖"
          : "已经在做梦中，或当前无法开始新的整合";
      return;
    }
    await pollDreamDone();
  } catch {
    insightsMetaEl.textContent = "做梦请求失败，请稍后再试";
  } finally {
    dreaming = false;
    dreamBtn.disabled = false;
  }
}

/** 每 2.5 秒拉一次状态；dreaming 消失即认为结束，最长等 90 秒。 */
async function pollDreamDone() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    try {
      const state = await ipcRenderer.invoke(GET_STATE_CHANNEL);
      renderInsightsPage(state.insights);
      if (!state.insights.dreaming) return;
    } catch {
      /* 单次轮询失败忽略，下一轮再试 */
    }
  }
}

// ── 图谱页（实体共现力导向图，零依赖手搓布局） ──

const graphSummaryEl = document.getElementById("graph-summary");
const graphCanvasEl = document.getElementById("graph-canvas");

/** 画布逻辑坐标系：svg viewBox 固定，实际显示尺寸由 CSS 拉伸自适应。 */
const GRAPH_VIEW_W = 1000;
const GRAPH_VIEW_H = 640;
const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
  return node;
}

/** 节点半径 ∝ sqrt(degree)：平方根把度数差压平，枢纽不会大到遮住别人。 */
function graphNodeRadius(degree) {
  const d = Number.isFinite(degree) ? Math.max(0, degree) : 0;
  return 6 + Math.sqrt(d) * 3.4;
}

/** 确定性抖动：同一份数据每次打开布局一致（Math.random 会让图的形态每次都变）。 */
function graphJitter(i, salt) {
  const h = ((i + 1) * 2654435761 + salt * 40503) >>> 0;
  return (h % 2000) / 2000 - 0.5;
}

/**
 * 手写力导向布局（Fruchterman-Reingold 简化版）：
 * 初始按圆环布点 → 迭代 300 次（O(n²) 斥力 + 边弹簧 + 向心力，步长逐轮冷却）
 * → 收尾把包围盒缩放平移到 viewBox 居中。n ≤ 40，同步一次算完，无动画循环。
 * 理想边长按两端节点半径和自适应，大节点离邻居远一点，避免圆面互相压住。
 */
function layoutGraph(nodes, edges) {
  const n = nodes.length;
  const cx = GRAPH_VIEW_W / 2;
  const cy = GRAPH_VIEW_H / 2;
  const radii = nodes.map((node) => graphNodeRadius(node.degree));

  const px = new Array(n);
  const py = new Array(n);
  const ringR = Math.min(GRAPH_VIEW_W, GRAPH_VIEW_H) * 0.34;
  for (let i = 0; i < n; i += 1) {
    const angle = (2 * Math.PI * i) / n;
    px[i] = cx + Math.cos(angle) * ringR + graphJitter(i, 7) * 40;
    py[i] = cy + Math.sin(angle) * ringR + graphJitter(i, 13) * 40;
  }

  // 边 → 端点下标；端点缺失直接丢弃（服务端保证过，渲染端再防御一次）
  const indexBy = new Map(nodes.map((node, i) => [node.name, i]));
  const springs = [];
  for (const edge of edges) {
    const i = indexBy.get(edge.a);
    const j = indexBy.get(edge.b);
    if (i === undefined || j === undefined || i === j) continue;
    const weight = Number(edge.weight);
    springs.push({ i, j, weight: Number.isFinite(weight) ? Math.max(1, weight) : 1 });
  }

  const idealLength = (i, j) => (radii[i] + radii[j]) * 2.1 + 46;
  const REPULSION = 260000;
  const GRAVITY = 0.012;
  const SPRING = 0.012;
  let temp = Math.min(GRAPH_VIEW_W, GRAPH_VIEW_H) * 0.12;

  for (let iter = 0; iter < 300; iter += 1) {
    const fx = new Array(n).fill(0);
    const fy = new Array(n).fill(0);
    // 斥力：所有节点两两相斥，力 ∝ 1/d²
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let dx = px[i] - px[j];
        let dy = py[i] - py[j];
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          // 完全重合时给一个确定性的 breakup 方向，避免除零 NaN
          dx = graphJitter(i + j, 3) + 0.6;
          dy = graphJitter(j + i, 11) + 0.6;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const f = REPULSION / d2;
        const ux = dx / d;
        const uy = dy / d;
        fx[i] += ux * f; fy[i] += uy * f;
        fx[j] -= ux * f; fy[j] -= uy * f;
      }
    }
    // 弹簧：沿边把两端拉向理想长度；权重越高绑得越紧（封顶防枢纽边独大）
    for (const spring of springs) {
      const dx = px[spring.j] - px[spring.i];
      const dy = py[spring.j] - py[spring.i];
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d - idealLength(spring.i, spring.j)) * SPRING * Math.min(spring.weight, 3);
      const ux = dx / d;
      const uy = dy / d;
      fx[spring.i] += ux * f; fy[spring.i] += uy * f;
      fx[spring.j] -= ux * f; fy[spring.j] -= uy * f;
    }
    // 向心力 + 限步长积分（冷却温度收敛）
    for (let i = 0; i < n; i += 1) {
      fx[i] += (cx - px[i]) * GRAVITY;
      fy[i] += (cy - py[i]) * GRAVITY;
      const disp = Math.hypot(fx[i], fy[i]);
      if (disp > 1e-6) {
        const step = Math.min(disp, temp);
        px[i] += (fx[i] / disp) * step;
        py[i] += (fy[i] / disp) * step;
      }
    }
    temp *= 0.985;
  }

  // 收尾：全节点（含半径）包围盒 → 等比缩放平移到 viewBox 居中
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    minX = Math.min(minX, px[i] - radii[i]);
    maxX = Math.max(maxX, px[i] + radii[i]);
    minY = Math.min(minY, py[i] - radii[i]);
    maxY = Math.max(maxY, py[i] + radii[i]);
  }
  const bw = Math.max(maxX - minX, 1);
  const bh = Math.max(maxY - minY, 1);
  const pad = 24;
  const scale = Math.min((GRAPH_VIEW_W - pad * 2) / bw, (GRAPH_VIEW_H - pad * 2) / bh, 3);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  return nodes.map((_, i) => ({
    x: (px[i] - midX) * scale + cx,
    y: (py[i] - midY) * scale + cy,
    r: Math.min(30, Math.max(4, radii[i] * scale)),
  }));
}

let graphSeq = 0;

/** 拉取图谱数据并渲染；seq guard 防乱序（快速切页时旧请求不得覆盖新图）。 */
async function renderGraph() {
  const seq = ++graphSeq;
  graphSummaryEl.textContent = "加载中…";
  try {
    const res = await ipcRenderer.invoke(GET_GRAPH_CHANNEL);
    if (seq !== graphSeq) return;
    drawGraph(res);
  } catch {
    if (seq !== graphSeq) return;
    graphSummaryEl.textContent = "图谱拉取失败，请重开窗口";
    graphCanvasEl.innerHTML = "";
  }
}

function drawGraph(res) {
  graphCanvasEl.innerHTML = "";
  const nodes = Array.isArray(res && res.nodes) ? res.nodes : [];
  const edges = Array.isArray(res && res.edges) ? res.edges : [];
  if (nodes.length < 2) {
    graphSummaryEl.textContent = nodes.length === 1 ? `只有 1 个实体（${nodes[0].name}），还连不成图` : "还没有可建图的实体";
    graphCanvasEl.appendChild(el("div", "graph-empty", "实体太少，涟漪还漾不开——多聊聊，等人名、地名、事物在记忆里反复出现后，这里会自己连成网"));
    return;
  }
  graphSummaryEl.textContent = `共 ${nodes.length} 个实体 · ${edges.length} 条共现关系 · 悬停高亮邻接，点击圆点跳转记忆页`;

  const positions = layoutGraph(nodes, edges);
  const svg = svgEl("svg", { viewBox: `0 0 ${GRAPH_VIEW_W} ${GRAPH_VIEW_H}`, preserveAspectRatio: "xMidYMid meet", role: "img", "aria-label": "实体共现图谱" });
  const indexBy = new Map(nodes.map((node, i) => [node.name, i]));
  const maxWeight = edges.reduce((max, edge) => Math.max(max, Number(edge.weight) || 0), 1);

  // 邻接表（名字口径）：悬停高亮用
  const neighborNames = nodes.map(() => new Set());
  const edgeEls = [];
  for (const edge of edges) {
    const i = indexBy.get(edge.a);
    const j = indexBy.get(edge.b);
    if (i === undefined || j === undefined || i === j) continue;
    neighborNames[i].add(edge.b);
    neighborNames[j].add(edge.a);
    const weight = Number(edge.weight) || 1;
    const t = maxWeight > 1 ? (Math.min(weight, maxWeight) - 1) / (maxWeight - 1) : 0;
    const p = positions[i];
    const q = positions[j];
    const line = svgEl("line", {
      x1: p.x.toFixed(1), y1: p.y.toFixed(1),
      x2: q.x.toFixed(1), y2: q.y.toFixed(1),
      class: "graph-edge",
      "stroke-opacity": (0.22 + t * 0.5).toFixed(2),
      "stroke-width": (1 + t * 2.4).toFixed(2),
    });
    svg.appendChild(line);
    edgeEls.push({ el: line, a: edge.a, b: edge.b });
  }

  const nodeEls = new Map();
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const name = String(node.name ?? "");
    const pos = positions[i];
    const g = svgEl("g", { class: "graph-node" });
    const title = svgEl("title");
    // 实体名是 LLM 派生的不可信数据：只经 textContent 进 DOM
    title.textContent = `${name} · ${node.count} 条记忆 · 热度 ${Math.round((Number(node.heat) || 0) * 100)}%`;
    const circle = svgEl("circle", { cx: pos.x.toFixed(1), cy: pos.y.toFixed(1), r: pos.r.toFixed(1), fill: dotColorOf(name) });
    const label = svgEl("text", { x: pos.x.toFixed(1), y: (pos.y + pos.r + 13).toFixed(1), "text-anchor": "middle" });
    label.textContent = name;
    g.appendChild(title);
    g.appendChild(circle);
    g.appendChild(label);
    g.addEventListener("mouseenter", () => highlightGraph(name));
    g.addEventListener("mouseleave", () => highlightGraph(null));
    g.addEventListener("click", () => jumpToEntityFromGraph(name));
    svg.appendChild(g);
    nodeEls.set(name, g);
  }

  /** 悬停高亮：点亮邻接边与邻居，压暗其余；activeName 为 null 时复原。 */
  function highlightGraph(activeName) {
    for (const edge of edgeEls) {
      const hot = activeName !== null && (edge.a === activeName || edge.b === activeName);
      edge.el.classList.toggle("graph-edge--hot", hot);
      edge.el.classList.toggle("graph-edge--dim", activeName !== null && !hot);
    }
    for (const [name, g] of nodeEls) {
      const keep = activeName === null || name === activeName || neighborNames[indexBy.get(name)]?.has(activeName);
      g.classList.toggle("graph-node--dim", !keep);
    }
  }

  graphCanvasEl.appendChild(svg);
}

/** 图谱节点点击 → 跳记忆页并按实体过滤（复用实体 facet 联动，browse 会带过滤刷新）。 */
function jumpToEntityFromGraph(entity) {
  filters.entity = entity;
  switchPage("memory");
}

// ── 检索台（复现 Agent 检索链路的调试页） ──────

const consoleQueryEl = document.getElementById("console-query");
const consoleRunEl = document.getElementById("console-run");
const consoleLimitEl = document.getElementById("console-limit");
const consoleRerankEl = document.getElementById("console-rerank");
const consoleMetaEl = document.getElementById("console-meta");
const consoleResultsEl = document.getElementById("console-results");

const CONSOLE_SOURCE_LABELS = { keyword: "关键词", vector: "向量", hybrid: "混合" };

function consoleSourceBadge(source) {
  const known = source === "vector" || source === "hybrid" ? source : "keyword";
  return el("span", `console-source console-source--${known}`, CONSOLE_SOURCE_LABELS[known]);
}

function consoleEntityChip(entity) {
  const chip = el("span", "console-entity");
  chip.appendChild(dotNode(dotColorOf(entity)));
  chip.appendChild(el("span", null, entity));
  return chip;
}

function renderConsoleResults(res) {
  consoleResultsEl.innerHTML = "";
  const hits = Array.isArray(res && res.hits) ? res.hits : [];
  if (hits.length === 0) {
    consoleMetaEl.textContent = "没有命中的记忆——换个说法再试";
    const block = el("div", "entity-block");
    block.appendChild(el("div", "attr-line empty", "没有命中的记忆——试试更具体的人名、地名或正在做的事"));
    consoleResultsEl.appendChild(block);
    return;
  }
  consoleMetaEl.textContent = `命中 ${hits.length} 条${res && res.reranked ? " · 已精排" : ""}`;
  for (const hit of hits) {
    const row = el("div", "console-row");
    const head = el("div", "console-row-head");
    const score = Number(hit && hit.score);
    head.appendChild(el("span", "console-score", Number.isFinite(score) ? score.toFixed(2) : "0.00"));
    head.appendChild(consoleSourceBadge(hit && hit.source));
    const heat = Number(hit && hit.heat);
    head.appendChild(heatBadge(Number.isFinite(heat) ? Math.min(1, Math.max(0, heat)) : 0));
    const entities = Array.isArray(hit && hit.entities) ? hit.entities : [];
    for (const entity of entities) {
      if (typeof entity !== "string" || entity === "") continue;
      head.appendChild(consoleEntityChip(entity));
    }
    row.appendChild(head);
    row.appendChild(el("div", "console-content", typeof (hit && hit.content) === "string" ? hit.content : ""));
    row.appendChild(el("div", "console-time", formatTime(hit && hit.createdAt)));
    consoleResultsEl.appendChild(row);
  }
}

let consoleSeq = 0;

/** 检索台查询：走 search-memories 通道；seq guard 防乱序（同 browse() 模式）。 */
async function runConsoleSearch() {
  const text = consoleQueryEl.value.trim();
  if (text === "") {
    consoleMetaEl.textContent = "先输入要检索的内容，再回车或点「查询」";
    return;
  }
  const seq = ++consoleSeq;
  consoleRunEl.disabled = true;
  consoleMetaEl.textContent = "检索中…";
  try {
    const res = await ipcRenderer.invoke(SEARCH_MEMORIES_CHANNEL, {
      text,
      limit: Number(consoleLimitEl.value) || 10,
      rerank: consoleRerankEl.checked,
    });
    if (seq !== consoleSeq) return;
    renderConsoleResults(res);
  } catch {
    if (seq !== consoleSeq) return;
    consoleMetaEl.textContent = "检索失败，请稍后再试";
    setEmpty(consoleResultsEl, "检索失败，请稍后再试", "div");
  } finally {
    if (seq === consoleSeq) consoleRunEl.disabled = false;
  }
}

consoleRunEl.addEventListener("click", runConsoleSearch);
consoleQueryEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") runConsoleSearch();
});
// 返回条数变化后重跑当前查询（若有），否则改条数看起来像没生效
consoleLimitEl.addEventListener("change", () => {
  if (consoleQueryEl.value.trim() !== "") runConsoleSearch();
});

// ── 设置页 ──────────────────────────────────────

const CONFIG_INPUTS = [
  "consolidationEnabled",
  "consolidationIdleMinutes",
  "consolidationMaxRecords",
  "heatDecayPerDay",
  "heatWeight",
  "heatBump",
  "hotContextBudgetChars",
  "maxMemoriesPerTurn",
  "embeddingProvider",
  "embeddingBaseUrl",
  "embeddingModel",
  "embeddingApiKeyName",
];

function fillSettings(config) {
  for (const key of CONFIG_INPUTS) {
    const input = document.getElementById(`cfg-${key}`);
    if (!input || !(key in config)) continue;
    if (input.type === "checkbox") input.checked = Boolean(config[key]);
    else input.value = config[key] ?? "";
  }
}

async function loadSettings() {
  try {
    const config = await ipcRenderer.invoke(GET_CONFIG_CHANNEL);
    fillSettings(config);
    pageLoaded.settings = true;
  } catch {
    saveStatusEl.textContent = "配置加载失败，请重开窗口";
  }
}

async function saveSettings() {
  saveBtn.disabled = true;
  saveStatusEl.textContent = "";
  try {
    const patch = {};
    for (const key of CONFIG_INPUTS) {
      const input = document.getElementById(`cfg-${key}`);
      if (!input) continue;
      if (input.type === "checkbox") patch[key] = input.checked;
      else if (input.type === "number") {
        const value = Number(input.value);
        if (input.value !== "" && Number.isFinite(value)) patch[key] = value;
      } else patch[key] = input.value;
    }
    const res = await ipcRenderer.invoke(SAVE_CONFIG_CHANNEL, patch);
    saveStatusEl.textContent = res && res.ok ? "已保存 ✓" : "保存失败，请检查填写内容";
  } catch {
    saveStatusEl.textContent = "保存失败，请稍后再试";
  } finally {
    saveBtn.disabled = false;
    setTimeout(() => {
      saveStatusEl.textContent = "";
    }, 2600);
  }
}

// ── 总刷新与事件挂接 ────────────────────────────

/** 拉取时间轴与洞察（记忆浏览走 browse 通道）。 */
async function refresh() {
  try {
    const state = await ipcRenderer.invoke(GET_STATE_CHANNEL);
    renderClaims(state);
    renderInsightsPage(state.insights);
  } catch {
    setEmpty(claimListEl, "状态拉取失败，请重开窗口", "div");
    setEmpty(clusterListEl, "状态拉取失败，请重开窗口", "div");
    setEmpty(conflictListEl, "状态拉取失败，请重开窗口", "div");
  }
}

// 自绘标题栏关闭按钮：面板本身就是 BrowserWindow 页面，close() 直接关窗
closeBtn.addEventListener("click", () => window.close());
dreamBtn.addEventListener("click", startDream);
saveBtn.addEventListener("click", saveSettings);

// 周期刷新：洞察保持新鲜（做梦中由 pollDreamDone 负责）
setInterval(() => {
  if (currentPage === "insights") refresh();
}, 30_000);

switchPage("memory");
