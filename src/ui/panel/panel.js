// 岁月涟漪 · 记忆图谱面板
// channel 与 src/ui/ipc.ts 对应：插件侧通过 ctx.registerIpc 注册短名，
// 框架命名空间化为 plugin:suiyue-lianyi:<channel>，这里用完整名 invoke。
const { ipcRenderer } = require("electron");

const GET_STATE_CHANNEL = "plugin:suiyue-lianyi:get-state";
const FORGET_CHANNEL = "plugin:suiyue-lianyi:forget";

const statsEl = document.getElementById("stats");
const listEl = document.getElementById("memory-list");

/** 时间戳 -> 本地时间字符串；失败时退回原始值。 */
function formatTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(timestamp ?? "");
  }
}

function setEmpty(text) {
  listEl.innerHTML = "";
  const li = document.createElement("li");
  li.className = "empty";
  li.textContent = text;
  listEl.appendChild(li);
}

function renderMemory(memory) {
  const li = document.createElement("li");

  const body = document.createElement("div");
  body.className = "memory-body";
  const content = document.createElement("div");
  content.className = "memory-content";
  content.textContent = memory.content;
  const time = document.createElement("div");
  time.className = "memory-time";
  time.textContent = formatTime(memory.createdAt);
  body.appendChild(content);
  body.appendChild(time);

  const btn = document.createElement("button");
  btn.className = "forget-btn";
  btn.textContent = "遗忘";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const res = await ipcRenderer.invoke(FORGET_CHANNEL, memory.id);
      if (res && res.ok) refresh();
      else btn.disabled = false;
    } catch (err) {
      btn.disabled = false;
    }
  });

  li.appendChild(body);
  li.appendChild(btn);
  return li;
}

/** 渲染统计与记忆列表。 */
function render(state) {
  const total = Number(state && state.total) || 0;
  const active = Number(state && state.active) || 0;
  statsEl.textContent = "共 " + total + " 条记忆 · 活跃 " + active + " 条";
  listEl.innerHTML = "";
  const memories = Array.isArray(state && state.memories) ? state.memories : [];
  if (memories.length === 0) {
    setEmpty("暂无记忆");
    return;
  }
  for (const memory of memories) listEl.appendChild(renderMemory(memory));
}

/** 拉取状态并渲染；失败时显示空态文案。 */
async function refresh() {
  try {
    const state = await ipcRenderer.invoke(GET_STATE_CHANNEL);
    render(state);
  } catch (err) {
    statsEl.textContent = "加载失败";
    setEmpty("状态拉取失败，请重开窗口");
  }
}

refresh();
