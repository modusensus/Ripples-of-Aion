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

// ── 图标：Lucide v1.42 路径数据（ISC license），沿用 dsh-mneme 的内联惯例——
// 插件运行时不能 require 第三方库，morphicons/lucide 素材以静态元组随包分发，
// stroke 取 currentColor 跟随主题。
const ICON_PATHS = {
  search: [["path", { d: "m21 21-4.34-4.34" }], ["circle", { cx: "11", cy: "11", r: "8" }]],
  refresh: [["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }], ["path", { d: "M21 3v5h-5" }], ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }], ["path", { d: "M8 16H3v5" }]],
  chevronDown: [["path", { d: "m6 9 6 6 6-6" }]],
  flame: [["path", { d: "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" }]],
  inbox: [["polyline", { points: "22 12 16 12 14 15 10 15 8 12 2 12" }], ["path", { d: "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" }]],
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
