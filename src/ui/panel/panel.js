// 岁月涟漪 · 记忆图谱面板
// channel 与 src/ui/ipc.ts 对应：插件侧通过 ctx.registerIpc 注册短名，
// 框架命名空间化为 plugin:ripples-of-aion:<channel>，这里用完整名 invoke。
// 安全约定：记忆内容是 LLM 派生的不可信数据，渲染只允许 textContent。
const { ipcRenderer } = require("electron");

const GET_STATE_CHANNEL = "plugin:ripples-of-aion:get-state";
const FORGET_CHANNEL = "plugin:ripples-of-aion:forget";

const statsEl = document.getElementById("stats");
const claimListEl = document.getElementById("claim-list");
const listEl = document.getElementById("memory-list");

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

/** 渲染统计徽章。 */
function renderStats(state) {
  const total = Number(state && state.total) || 0;
  const active = Number(state && state.active) || 0;
  statsEl.innerHTML = "";
  statsEl.appendChild(el("span", "pill", `共 ${total} 条记忆`));
  statsEl.appendChild(el("span", "pill", `活跃 ${active} 条`));
}

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
  // 组内排序，并记录是否有当前值
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
  if (current) {
    lines.push({ kind: "current", claim: current });
  } else {
    lines.push({ kind: "current-empty" });
  }
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

/** 渲染实体时间轴区块。 */
function renderClaims(state) {
  const claims = Array.isArray(state && state.claims) ? state.claims : [];
  claimListEl.innerHTML = "";
  if (claims.length === 0) {
    const block = el("div", "entity-block");
    block.appendChild(el("div", "attr-line empty", "还没有可画成时间轴的属性声明——多聊聊会变化的细节（住哪、在做什么、养了什么），涟漪会自己漾开"));
    claimListEl.appendChild(block);
    return;
  }
  const grouped = groupClaims(claims);
  for (const entity of grouped) {
    const block = el("div", "entity-block");
    block.appendChild(el("div", "entity-name", entity.entity));
    for (const attr of entity.attrs) {
      block.appendChild(renderAttrRow(attr));
    }
    claimListEl.appendChild(block);
  }
}

function renderMemory(memory) {
  const li = el("li");

  const body = el("div", "memory-body");
  body.appendChild(el("div", "memory-content", memory.content));
  body.appendChild(el("div", "memory-time", formatTime(memory.createdAt)));

  const btn = el("button", "forget-btn", "遗忘");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const res = await ipcRenderer.invoke(FORGET_CHANNEL, memory.id);
      if (res && res.ok) refresh();
      else btn.disabled = false;
    } catch {
      btn.disabled = false;
    }
  });

  li.appendChild(body);
  li.appendChild(btn);
  return li;
}

/** 渲染最近记忆列表。 */
function renderMemories(state) {
  const memories = Array.isArray(state && state.memories) ? state.memories : [];
  listEl.innerHTML = "";
  if (memories.length === 0) {
    setEmpty(listEl, "暂无记忆");
    return;
  }
  for (const memory of memories) listEl.appendChild(renderMemory(memory));
}

/** 拉取状态并渲染；失败时显示空态文案。 */
async function refresh() {
  try {
    const state = await ipcRenderer.invoke(GET_STATE_CHANNEL);
    renderStats(state);
    renderClaims(state);
    renderMemories(state);
  } catch {
    statsEl.innerHTML = "";
    statsEl.appendChild(el("span", "pill", "加载失败"));
    setEmpty(claimListEl, "状态拉取失败，请重开窗口", "div");
    setEmpty(listEl, "状态拉取失败，请重开窗口");
  }
}

refresh();
