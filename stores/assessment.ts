import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";

export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type NeedLevel = "紧急" | "高" | "一般";
export type TaskStatus = "待接收" | "进行中" | "已完成";

export interface Household {
  id: string;
  head: string;
  community: string;
  address: string;
  members: number;
  vulnerable: string[];
  needLevel: NeedLevel;
  needs: string[];
  status: HouseholdStatus;
  version: number;
  deviceUpdatedAt: string;
  note: string;
}

export interface FieldTask {
  id: string;
  householdId: string;
  title: string;
  assignee: string;
  priority: NeedLevel;
  status: TaskStatus;
  due: string;
}

export interface PendingChange {
  id: string;
  entity: string;
  action: string;
  detail: string;
  time: string;
}

export interface FieldConflict {
  id: string;
  householdId: string;
  field: string;
  localValue: string;
  remoteValue: string;
  status: "待处理" | "采用本地" | "采用远端";
}

/** 字段级改动：登记改了哪个字段、改前/改后的值 */
export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export type RevisionEntity = "家庭" | "任务";
export type RevisionAction = "新增" | "修改" | "合并" | "回退" | "分派" | "状态流转";
export type RevisionStatus = "待同步" | "已入账";

/**
 * 本地修订账条目。
 * 每次保存都登记：设备标识、基础版本、改过的字段（字段级改动）。
 * id 同时作为幂等键：重复提交只会入账一次。
 */
export interface Revision {
  id: string;
  entity: RevisionEntity;
  householdId: string;
  taskId?: string;
  deviceId: string;
  action: RevisionAction;
  baseVersion: number;
  changes: FieldChange[];
  /** 合并操作中被并入、需要从服务端状态清理掉的源家庭 */
  mergedFrom?: string[];
  /** 家庭改动后的完整快照（新增/修改/合并/回退） */
  afterSnapshot?: Household;
  /** 任务改动后的完整快照（分派/状态流转） */
  afterTask?: FieldTask;
  detail: string;
  time: string;
  status: RevisionStatus;
}

const KEY = "pair-wise-yf-50/assessment";
const DEVICE_KEY = "pair-wise-yf-50/device-id";
export const REMOTE_DEVICE = "remote-001";

const HOUSEHOLD_FIELDS = ["head", "community", "address", "members", "vulnerable", "needLevel", "needs", "status", "note"] as const;

const seedHouseholds: Household[] = [
  { id: "h1", head: "王建国", community: "河湾社区", address: "河湾路18号2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待复核", version: 1, deviceUpdatedAt: new Date(Date.now() - 12 * 60000).toISOString(), note: "一层受淹，老人行动不便" },
  { id: "h2", head: "赵敏", community: "新城社区", address: "新城三街9号", members: 2, vulnerable: [], needLevel: "一般", needs: ["饮用水"], status: "已分派", version: 1, deviceUpdatedAt: new Date(Date.now() - 35 * 60000).toISOString(), note: "饮水库存不足" },
  { id: "h3", head: "王建国", community: "河湾社区", address: "河湾路18号2幢2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待评估", version: 1, deviceUpdatedAt: new Date().toISOString(), note: "疑似重复登记" }
];
const seedTasks: FieldTask[] = [
  { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-09-29 16:00" }
];

function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function display(value: unknown): string {
  if (Array.isArray(value)) return value.join("、");
  if (value === null || value === undefined) return "";
  return String(value);
}

/** 远端更正参考值：与种子基线不同，碰撞时再兜底，保证一定能看出两端差异 */
const REMOTE_CONSTANT: Record<string, unknown> = {
  head: "王建国（远端核对）",
  community: "河湾社区",
  address: "河湾路18号2栋2单元",
  members: 5,
  vulnerable: ["老人", "慢性病"],
  needLevel: "高",
  needs: ["临时安置", "慢病用药", "应急照明"],
  status: "已分派",
  note: "一层受淹，老人行动不便，需远端协助转运"
};

function remoteAlt(field: string, base: unknown, local: unknown): unknown {
  let value = REMOTE_CONSTANT[field];
  if (value === undefined) value = local;
  if (isEqual(value, local) || isEqual(value, base)) {
    if (typeof value === "string") value = `${value}·远端`;
    else if (typeof value === "number") value = value + 1;
    else if (Array.isArray(value)) value = [...value, "远端补充"];
  }
  return clone(value);
}

function loadDeviceId(): string {
  if (typeof window === "undefined") return "server";
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = uid();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export const useAssessmentStore = defineStore("assessment", () => {
  const initial = typeof window !== "undefined" && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;

  const deviceId = ref(loadDeviceId());
  const households = ref<Household[]>(initial?.households ?? seedHouseholds);
  const tasks = ref<FieldTask[]>(initial?.tasks ?? seedTasks);
  /** 本地修订账 */
  const revisions = ref<Revision[]>(initial?.revisions ?? []);
  const conflicts = ref<FieldConflict[]>(initial?.conflicts ?? []);
  /** 服务端最新状态（最近一次同步确认的基线） */
  const serverState = ref<Record<string, Household>>(initial?.serverState ?? Object.fromEntries(seedHouseholds.map((h) => [h.id, clone(h)])));
  const serverTasks = ref<Record<string, FieldTask>>(initial?.serverTasks ?? Object.fromEntries(seedTasks.map((t) => [t.id, clone(t)])));
  /** 远端修订：一次同步轮次内保持稳定，失败重试时不变，避免重复判定冲突 */
  const remoteRevisions = ref<Revision[]>(initial?.remoteRevisions ?? []);
  /** 每个家庭的历史快照，用于回退到上一版 */
  const snapshots = ref<Record<string, Household[]>>(initial?.snapshots ?? Object.fromEntries(seedHouseholds.map((h) => [h.id, [clone(h)]])));

  const online = ref(true);
  const lastSyncedAt = ref(initial?.lastSyncedAt ?? new Date().toISOString());
  const syncing = ref(false);
  const syncError = ref("");
  const lastSyncFailed = ref(false);
  const blockedMessage = ref("");

  /** 待同步队列：由修订账中所有“待同步”条目派生，重复提交只保留一条 */
  const queue = computed<PendingChange[]>(() =>
    revisions.value
      .filter((r) => r.status === "待同步")
      .map((r) => ({ id: r.id, entity: r.entity, action: r.action, detail: r.detail, time: r.time }))
      .reverse()
  );

  const conflictedHouseholdIds = computed(() => new Set(conflicts.value.filter((c) => c.status === "待处理").map((c) => c.householdId)));

  const metrics = computed(() => ({
    households: households.value.length,
    urgent: households.value.filter((item) => item.needLevel === "紧急").length,
    openTasks: tasks.value.filter((item) => item.status !== "已完成").length,
    queued: queue.value.length
  }));

  const duplicates = computed(() => {
    const groups = new Map<string, Household[]>();
    households.value.forEach((household) => {
      const key = `${household.head}-${household.community}`;
      groups.set(key, [...(groups.get(key) ?? []), household]);
    });
    return [...groups.values()].filter((group) => group.length > 1);
  });

  function isBlocked(householdId: string): boolean {
    return conflictedHouseholdIds.value.has(householdId);
  }

  function canRollback(householdId: string): boolean {
    const hist = snapshots.value[householdId];
    return !!hist && hist.length > 1 && !isBlocked(householdId);
  }

  function pushSnapshot(household: Household) {
    const list = snapshots.value[household.id] ?? [];
    list.push(clone(household));
    snapshots.value[household.id] = list;
  }

  function householdChanges(before: Household, after: Household): FieldChange[] {
    const changes: FieldChange[] = [];
    for (const field of HOUSEHOLD_FIELDS) {
      if (!isEqual(before[field], after[field])) changes.push({ field, before: clone(before[field]), after: clone(after[field]) });
    }
    return changes;
  }

  function addHousehold(input: Omit<Household, "id" | "status" | "version" | "deviceUpdatedAt">) {
    blockedMessage.value = "";
    const now = new Date().toISOString();
    const household: Household = { ...input, id: uid(), status: "待评估", version: 1, deviceUpdatedAt: now };
    households.value.unshift(household);
    snapshots.value[household.id] = [clone(household)];
    const changes = HOUSEHOLD_FIELDS.map((field) => ({ field, before: null, after: clone(household[field]) }));
    revisions.value.push({
      id: uid(),
      entity: "家庭",
      householdId: household.id,
      deviceId: deviceId.value,
      action: "新增",
      baseVersion: 0,
      changes,
      afterSnapshot: clone(household),
      detail: `新增家庭 ${household.head}`,
      time: now,
      status: "待同步"
    });
  }

  function updateHousehold(id: string, patch: Partial<Household>) {
    blockedMessage.value = "";
    const household = households.value.find((item) => item.id === id);
    if (!household) return;
    const before = clone(household);
    const changes: FieldChange[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const field = key as keyof Household;
      if (!isEqual(household[field], value)) changes.push({ field, before: clone(household[field]), after: clone(value) });
    }
    if (!changes.length) return; // 没有字段变化不入账
    const now = new Date().toISOString();
    Object.assign(household, patch, { version: household.version + 1, deviceUpdatedAt: now });
    pushSnapshot(household);
    revisions.value.push({
      id: uid(),
      entity: "家庭",
      householdId: household.id,
      deviceId: deviceId.value,
      action: "修改",
      baseVersion: before.version,
      changes,
      afterSnapshot: clone(household),
      detail: `${household.head}：${changes.map((c) => c.field).join("、")}`,
      time: now,
      status: "待同步"
    });
  }

  function mergeDuplicate(sourceId: string, targetId: string) {
    blockedMessage.value = "";
    const source = households.value.find((item) => item.id === sourceId);
    const target = households.value.find((item) => item.id === targetId);
    if (!source || !target) return;
    const before = clone(target);
    const now = new Date().toISOString();
    target.needs = Array.from(new Set([...target.needs, ...source.needs]));
    target.vulnerable = Array.from(new Set([...target.vulnerable, ...source.vulnerable]));
    target.note = `${target.note}；已合并重复记录 ${source.address}`;
    target.version += 1;
    target.deviceUpdatedAt = now;
    // 合并掉的家庭不能继续保留未结任务：清理源家庭名下全部任务
    const removedCount = tasks.value.filter((item) => item.householdId === sourceId).length;
    tasks.value = tasks.value.filter((item) => item.householdId !== sourceId);
    delete snapshots.value[sourceId];
    pushSnapshot(target);
    // 源家庭自身的未结修订（如离线新增后被合并）随合并一并入账，避免成为孤儿条目卡住队列
    for (const r of revisions.value) {
      if (r.householdId === sourceId && r.status === "待同步") r.status = "已入账";
    }
    households.value = households.value.filter((item) => item.id !== sourceId);
    revisions.value.push({
      id: uid(),
      entity: "家庭",
      householdId: target.id,
      deviceId: deviceId.value,
      action: "合并",
      baseVersion: before.version,
      changes: householdChanges(before, target),
      mergedFrom: [sourceId],
      afterSnapshot: clone(target),
      detail: `合并 ${source.head} → ${target.address}，清理未结任务 ${removedCount} 项`,
      time: now,
      status: "待同步"
    });
  }

  function rollbackHousehold(id: string): boolean {
    blockedMessage.value = "";
    const household = households.value.find((item) => item.id === id);
    if (!household) return false;
    if (isBlocked(id)) {
      blockedMessage.value = "该家庭存在未处理的字段冲突，不能回退。";
      return false;
    }
    const hist = snapshots.value[id];
    if (!hist || hist.length < 2) return false; // 没有上一版
    const before = clone(household);
    hist.pop(); // 丢弃当前版
    const prev = clone(hist[hist.length - 1]);
    const now = new Date().toISOString();
    Object.assign(household, prev, { version: household.version - 1, deviceUpdatedAt: now });
    snapshots.value[id] = hist;
    revisions.value.push({
      id: uid(),
      entity: "家庭",
      householdId: household.id,
      deviceId: deviceId.value,
      action: "回退",
      baseVersion: before.version,
      changes: householdChanges(before, household),
      afterSnapshot: clone(household),
      detail: `${household.head} 回退到 v${household.version}`,
      time: now,
      status: "待同步"
    });
    return true;
  }

  function addTask(input: Omit<FieldTask, "id" | "status">) {
    blockedMessage.value = "";
    const now = new Date().toISOString();
    const task: FieldTask = { ...input, id: uid(), status: "待接收" };
    tasks.value.unshift(task);
    const household = households.value.find((item) => item.id === input.householdId);
    if (household && household.status !== "已完成") household.status = "已分派";
    revisions.value.push({
      id: uid(),
      entity: "任务",
      householdId: input.householdId,
      taskId: task.id,
      deviceId: deviceId.value,
      action: "分派",
      baseVersion: 0,
      changes: [],
      afterTask: clone(task),
      detail: `${task.title} / ${task.assignee}`,
      time: now,
      status: "待同步"
    });
  }

  function advanceTask(id: string): boolean {
    blockedMessage.value = "";
    const task = tasks.value.find((item) => item.id === id);
    if (!task) return false;
    // 冲突没处理前不得推进相关任务
    if (isBlocked(task.householdId)) {
      const household = households.value.find((item) => item.id === task.householdId);
      blockedMessage.value = `该家庭（${household?.head ?? task.householdId}）存在未处理的字段冲突，任务「${task.title}」暂不能推进。`;
      return false;
    }
    const now = new Date().toISOString();
    task.status = task.status === "待接收" ? "进行中" : "已完成";
    if (task.status === "已完成") {
      const open = tasks.value.some((item) => item.householdId === task.householdId && item.status !== "已完成");
      const household = households.value.find((item) => item.id === task.householdId);
      if (household && !open) household.status = "已完成";
    }
    revisions.value.push({
      id: uid(),
      entity: "任务",
      householdId: task.householdId,
      taskId: task.id,
      deviceId: deviceId.value,
      action: "状态流转",
      baseVersion: 0,
      changes: [],
      afterTask: clone(task),
      detail: `${task.title} → ${task.status}`,
      time: now,
      status: "待同步"
    });
    return true;
  }

  /** 生成本轮远端修订：对每个有本地待同步修订的家庭制造一个同字段冲突 + 一个不同字段自动合并，再加上一个干净采纳与一个远端新增 */
  function ensureRemoteRevisions() {
    if (remoteRevisions.value.length) return;
    const revs: Revision[] = [];
    const touched = new Set<string>();
    for (const household of households.value) {
      const localFields = new Set(
        revisions.value
          .filter((r) => r.householdId === household.id && r.status === "待同步" && r.entity === "家庭")
          .flatMap((r) => r.changes.map((c) => c.field))
      );
      if (!localFields.size) continue;
      touched.add(household.id);
      const changes: FieldChange[] = [];
      const conflictField = Array.from(localFields)[0];
      const baseValue = serverState.value[household.id] ? clone(serverState.value[household.id][conflictField]) : household[conflictField];
      changes.push({ field: conflictField, before: clone(household[conflictField]), after: remoteAlt(conflictField, baseValue, household[conflictField]) });
      const autoField = HOUSEHOLD_FIELDS.find((f) => !localFields.has(f));
      if (autoField) {
        const autoBase = serverState.value[household.id] ? clone(serverState.value[household.id][autoField]) : household[autoField];
        changes.push({ field: autoField, before: clone(household[autoField]), after: remoteAlt(autoField, autoBase, household[autoField]) });
      }
      // 远端快照以服务端基线为底，叠加远端改动（不能直接用本机快照，否则会把本机改动当成远端值）
      const remoteSnapshot = serverState.value[household.id] ? clone(serverState.value[household.id]) : clone(household);
      for (const c of changes) remoteSnapshot[c.field] = clone(c.after);
      revs.push({
        id: uid(),
        entity: "家庭",
        householdId: household.id,
        deviceId: REMOTE_DEVICE,
        action: "修改",
        baseVersion: household.version,
        changes,
        afterSnapshot: remoteSnapshot,
        detail: `远端更正 ${changes.map((c) => c.field).join("、")}`,
        time: new Date().toISOString(),
        status: "待同步"
      });
    }
    // 本地未触碰的家庭：干净采纳
    const untouched = households.value.find((h) => !touched.has(h.id));
    if (untouched) {
      const field = "note";
      const baseValue = serverState.value[untouched.id] ? clone(serverState.value[untouched.id][field]) : untouched[field];
      const remoteSnapshot = serverState.value[untouched.id] ? clone(serverState.value[untouched.id]) : clone(untouched);
      remoteSnapshot[field] = remoteAlt(field, baseValue, untouched[field]);
      revs.push({
        id: uid(),
        entity: "家庭",
        householdId: untouched.id,
        deviceId: REMOTE_DEVICE,
        action: "修改",
        baseVersion: untouched.version,
        changes: [{ field, before: clone(untouched[field]), after: clone(remoteSnapshot[field]) }],
        afterSnapshot: remoteSnapshot,
        detail: `远端更正 ${field}`,
        time: new Date().toISOString(),
        status: "待同步"
      });
    }
    // 远端离线新增的家庭
    const remoteOnly: Household = {
      id: uid(),
      head: "远端登记",
      community: "河湾社区",
      address: "河湾路7号",
      members: 3,
      vulnerable: [],
      needLevel: "一般",
      needs: ["饮用水"],
      status: "待评估",
      version: 1,
      deviceUpdatedAt: new Date().toISOString(),
      note: "远端设备离线新增"
    };
    revs.push({
      id: uid(),
      entity: "家庭",
      householdId: remoteOnly.id,
      deviceId: REMOTE_DEVICE,
      action: "新增",
      baseVersion: 0,
      changes: HOUSEHOLD_FIELDS.map((field) => ({ field, before: null, after: clone(remoteOnly[field]) })),
      afterSnapshot: clone(remoteOnly),
      detail: "远端新增家庭",
      time: new Date().toISOString(),
      status: "待同步"
    });
    remoteRevisions.value = revs;
  }

  /** 三向字段合并：base（服务端基线）/ local（本机）/ remote（远端） */
  function mergeHousehold(id: string): { applied: number; conflicts: number } {
    const localRevs = revisions.value.filter((r) => r.householdId === id && r.entity === "家庭" && r.status === "待同步");
    const remoteRevs = remoteRevisions.value.filter((r) => r.householdId === id && r.status === "待同步");
    const local = households.value.find((h) => h.id === id);
    if (!local) return { applied: 0, conflicts: 0 }; // 远端新增，另行采纳
    if (!localRevs.length && !remoteRevs.length) return { applied: 0, conflicts: 0 };

    const base = serverState.value[id] ? clone(serverState.value[id]) : null;
    let remote: Household | null = null;
    if (base) {
      remote = clone(base);
      for (const r of remoteRevs) {
        if (r.afterSnapshot) remote = clone(r.afterSnapshot);
      }
    }

    if (!base) {
      // 本地新增家庭：直接入账
      serverState.value[id] = clone(local);
      for (const r of localRevs) r.status = "已入账";
      for (const r of remoteRevs) r.status = "已入账";
      return { applied: localRevs.length, conflicts: 0 };
    }

    const merged: Household = clone(base);
    const serverMerged: Household = clone(base);
    const conflictFields: string[] = [];
    const fieldNames = new Set<string>([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote ?? {})]);
    for (const field of fieldNames) {
      if (field === "id") continue;
      const b = base[field];
      const l = local[field];
      const r = remote ? remote[field] : undefined;
      const localChanged = !isEqual(l, b);
      const remoteChanged = remote !== null && !isEqual(r, b);
      if (localChanged && remoteChanged) {
        if (isEqual(l, r)) {
          merged[field] = clone(l);
          serverMerged[field] = clone(l);
        } else {
          // 同字段两端改了不同值：记冲突，本机暂持本地值，服务端暂持基线值，不静默覆盖
          conflictFields.push(field);
          merged[field] = clone(l);
          serverMerged[field] = clone(b);
        }
      } else if (localChanged) {
        merged[field] = clone(l);
        serverMerged[field] = clone(l);
      } else if (remoteChanged) {
        merged[field] = clone(r);
        serverMerged[field] = clone(r);
      }
    }

    // 写入服务端状态（冲突字段保持基线值）
    serverState.value[id] = serverMerged;

    // 本机更新为合并结果（冲突字段保持本地值）
    let adopted = false;
    for (const field of Object.keys(merged)) {
      if (field === "id") continue;
      if (conflictFields.includes(field)) continue;
      if (!isEqual(local[field], merged[field])) {
        local[field] = merged[field];
        adopted = true;
      }
    }
    if (adopted) {
      local.version += 1;
      local.deviceUpdatedAt = new Date().toISOString();
      pushSnapshot(local);
    }

    // 清理被合并源家庭的服务端状态
    for (const r of localRevs) {
      if (r.mergedFrom) {
        for (const src of r.mergedFrom) {
          delete serverState.value[src];
          delete snapshots.value[src];
        }
      }
    }

    // 登记字段冲突
    for (const field of conflictFields) {
      conflicts.value.unshift({
        id: uid(),
        householdId: id,
        field,
        localValue: display(local[field]),
        remoteValue: display(remote ? remote[field] : ""),
        status: "待处理"
      });
    }

    for (const r of localRevs) r.status = "已入账";
    for (const r of remoteRevs) r.status = "已入账";
    return { applied: localRevs.length, conflicts: conflictFields.length };
  }

  /** 网络恢复后按字段合并；失败时已入账的条目不回退、待同步条目保留，可接着处理 */
  async function simulateSync(): Promise<{ ok: boolean; applied: number; remaining: number; conflicts: number; error?: string }> {
    if (!online.value) {
      const remaining = revisions.value.filter((r) => r.status === "待同步").length;
      return { ok: false, applied: 0, remaining, conflicts: 0, error: "弱网状态，队列保留在设备中，恢复连接后可继续提交。" };
    }
    syncing.value = true;
    syncError.value = "";
    await new Promise((resolve) => setTimeout(resolve, 650));
    ensureRemoteRevisions();

    const pending = revisions.value.filter((r) => r.status === "待同步");
    if (!pending.length) {
      syncing.value = false;
      lastSyncedAt.value = new Date().toISOString();
      return { ok: true, applied: 0, remaining: 0, conflicts: conflicts.value.filter((c) => c.status === "待处理").length };
    }

    const localHouseholdIds = Array.from(
      new Set(revisions.value.filter((r) => r.entity === "家庭" && r.status === "待同步").map((r) => r.householdId))
    );

    // 失败模拟：上一轮失败过则本轮必成功；否则 30% 概率在中途中断，至少留下一个有本地待同步修订的家庭
    const willFail = !lastSyncFailed.value && Math.random() < 0.3 && localHouseholdIds.length > 0;
    const failAt = willFail ? Math.floor(Math.random() * localHouseholdIds.length) : localHouseholdIds.length;

    let applied = 0;
    let newConflicts = 0;
    for (let i = 0; i < localHouseholdIds.length; i++) {
      if (i >= failAt) break; // 剩余家庭保持待同步，下轮接着处理
      const res = mergeHousehold(localHouseholdIds[i]);
      applied += res.applied;
      newConflicts += res.conflicts;
    }

    // 远端更正 / 远端新增但本地无待同步修订的家庭：始终处理（干净采纳或采纳新增）
    const remoteHouseholdIds = Array.from(
      new Set(remoteRevisions.value.filter((r) => r.entity === "家庭" && r.status === "待同步").map((r) => r.householdId))
    );
    for (const id of remoteHouseholdIds) {
      if (localHouseholdIds.includes(id)) continue;
      mergeHousehold(id);
    }

    // 任务修订：按入账顺序同步到服务端（任务状态不做字段冲突）
    const taskRevs = revisions.value.filter((r) => r.entity === "任务" && r.status === "待同步");
    for (const r of taskRevs) {
      if (r.afterTask) serverTasks.value[r.taskId!] = clone(r.afterTask);
      r.status = "已入账";
      applied += 1;
    }

    // 采纳远端新增家庭
    for (const r of remoteRevisions.value.filter((r) => r.action === "新增" && r.status === "待同步")) {
      if (r.afterSnapshot && !households.value.find((h) => h.id === r.householdId)) {
        households.value.push(clone(r.afterSnapshot));
        snapshots.value[r.householdId] = [clone(r.afterSnapshot)];
        serverState.value[r.householdId] = clone(r.afterSnapshot);
        r.status = "已入账";
      }
    }

    const remaining = revisions.value.filter((r) => r.status === "待同步").length;
    const conflictCount = conflicts.value.filter((c) => c.status === "待处理").length;
    lastSyncedAt.value = new Date().toISOString();
    syncing.value = false;

    if (willFail && failAt < localHouseholdIds.length) {
      lastSyncFailed.value = true;
      syncError.value = `同步中断：${applied} 项已入账，${remaining} 项待处理已恢复，可继续同步。`;
      return { ok: false, applied, remaining, conflicts: conflictCount, error: syncError.value };
    }
    lastSyncFailed.value = false;
    return { ok: true, applied, remaining, conflicts: conflictCount };
  }

  function resolveConflict(id: string, resolution: "采用本地" | "采用远端") {
    const conflict = conflicts.value.find((item) => item.id === id);
    if (!conflict || conflict.status !== "待处理") return;
    const household = households.value.find((item) => item.id === conflict.householdId);
    if (household) {
      if (resolution === "采用远端") (household as unknown as Record<string, unknown>)[conflict.field] = clone(conflict.remoteValue);
      household.version += 1;
      household.deviceUpdatedAt = new Date().toISOString();
      pushSnapshot(household);
      // 把裁决结果写入服务端基线，该字段正式入账
      if (serverState.value[household.id]) {
        (serverState.value[household.id] as unknown as Record<string, unknown>)[conflict.field] =
          resolution === "采用远端" ? clone(conflict.remoteValue) : clone(household[conflict.field]);
      }
    }
    conflict.status = resolution;
  }

  if (typeof window !== "undefined") {
    watch(
      [households, tasks, revisions, conflicts, serverState, serverTasks, remoteRevisions, snapshots, lastSyncedAt],
      () => {
        localStorage.setItem(
          KEY,
          JSON.stringify({
            households: households.value,
            tasks: tasks.value,
            revisions: revisions.value,
            conflicts: conflicts.value,
            serverState: serverState.value,
            serverTasks: serverTasks.value,
            remoteRevisions: remoteRevisions.value,
            snapshots: snapshots.value,
            lastSyncedAt: lastSyncedAt.value
          })
        );
      },
      { deep: true }
    );
  }

  return {
    deviceId,
    households,
    tasks,
    revisions,
    queue,
    conflicts,
    online,
    lastSyncedAt,
    syncing,
    syncError,
    blockedMessage,
    metrics,
    duplicates,
    conflictedHouseholdIds,
    isBlocked,
    canRollback,
    addHousehold,
    updateHousehold,
    mergeDuplicate,
    rollbackHousehold,
    addTask,
    advanceTask,
    simulateSync,
    resolveConflict
  };
});
