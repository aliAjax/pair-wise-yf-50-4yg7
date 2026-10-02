import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import {
  clone, FIELD_LABELS, HOUSEHOLD_FIELDS, revisionDetail, uid,
  type FieldConflict, type FieldTask, type Household, type HouseholdField,
  type HouseholdSnapshot, type HouseholdStatus, type NeedLevel,
  type PushResult, type Revision, type ServerLogEntry, type TaskStatus
} from "~/utils/domain";
import { MockServer, type FailureMode } from "~/utils/server";

const KEY = "pair-wise-yf-50/assessment";
const DEVICE_KEY = "pair-wise-yf-50/device";

interface DeviceIdentity { id: string; name: string }
interface PersistShape {
  v: 2;
  households: Household[];
  tasks: FieldTask[];
  revisions: Revision[];
  conflicts: FieldConflict[];
  lastSyncedAt: string;
}

interface Seed {
  households: Household[];
  tasks: FieldTask[];
}

function snapshotOf(h: Household, version: number, deviceName: string, time: string): HouseholdSnapshot {
  const fields = {} as Pick<Household, HouseholdField>;
  HOUSEHOLD_FIELDS.forEach((f) => { (fields as Record<string, unknown>)[f] = clone(h[f]); });
  return { version, fields, deviceName, time };
}

function seedHouseholds(): Household[] {
  const now = Date.now();
  const mk = (
    id: string, head: string, community: string, address: string, members: number,
    vulnerable: string[], needLevel: NeedLevel, needs: string[],
    status: HouseholdStatus, version: number, agoMin: number, note: string
  ): Household => ({
    id, head, community, address, members, vulnerable, needLevel, needs, status, version,
    deviceUpdatedAt: new Date(now - agoMin * 60000).toISOString(), note,
    lastDevice: "现场设备A", history: []
  });
  return [
    mk("h1", "王建国", "河湾社区", "河湾路18号2单元", 4, ["老人"], "紧急", ["临时安置", "慢病用药"], "待复核", 2, 12, "一层受淹，老人行动不便"),
    mk("h2", "赵敏", "新城社区", "新城三街9号", 2, [], "一般", ["饮用水"], "已分派", 1, 35, "饮水库存不足"),
    mk("h3", "王建国", "河湾社区", "河湾路18号2幢2单元", 4, ["老人"], "紧急", ["临时安置", "慢病用药"], "待评估", 1, 1, "疑似重复登记")
  ];
}

function seed(): Seed {
  return {
    households: seedHouseholds(),
    tasks: [
      { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-09-29 16:00", version: 1, lastDevice: "现场设备A" }
    ]
  };
}

function loadDevice(): DeviceIdentity {
  if (typeof window === "undefined") return { id: "device-ssr", name: "本设备" };
  const raw = localStorage.getItem(DEVICE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as DeviceIdentity;
      if (parsed.id && parsed.name) return parsed;
    } catch { /* 重建 */ }
  }
  const identity = { id: uid("device"), name: `现场设备-${Math.floor(Math.random() * 90 + 10)}` };
  localStorage.setItem(DEVICE_KEY, JSON.stringify(identity));
  return identity;
}

export const useAssessmentStore = defineStore("assessment", () => {
  const initial = (() => {
    if (typeof window === "undefined") return null;
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed?.v === 2 ? (parsed as PersistShape) : null;
    } catch { return null; }
  })();
  const boot = initial ?? seed();

  const device = ref<DeviceIdentity>(loadDevice());
  const households = ref<Household[]>(initial?.households ?? boot.households);
  const tasks = ref<FieldTask[]>(initial?.tasks ?? boot.tasks);
  /** 本地修订账（ledger）：含全部状态的修订，待处理项即 outbox 队列 */
  const revisions = ref<Revision[]>(initial?.revisions ?? []);
  // 本地单调序号：即使同毫秒内连续保存，入账顺序也与操作因果一致
  let seqCounter = revisions.value.reduce((max, r) => Math.max(max, r.seq ?? 0), 0);
  const conflicts = ref<FieldConflict[]>(initial?.conflicts ?? []);
  const serverLog = ref<ServerLogEntry[]>([]);
  const online = ref(true);
  const lastSyncedAt = ref(initial?.lastSyncedAt ?? new Date().toISOString());
  const syncing = ref(false);
  const failureMode = ref<FailureMode>("正常");
  const lastSyncMessage = ref("");

  let server: MockServer | null = null;
  function api(): MockServer {
    if (!server) {
      server = new MockServer();
      server.failureMode = failureMode.value;
      serverLog.value = server.log();
    }
    return server;
  }

  // ---------- 派生视图 ----------
  const activeHouseholds = computed(() => households.value.filter((h) => !h.merged));

  const pendingRevisions = computed(() => revisions.value.filter((r) => r.status !== "已入账"));
  const submittingRevisions = computed(() => revisions.value.filter((r) => r.status === "提交中"));
  const openConflicts = computed(() => conflicts.value.filter((c) => c.status === "待处理"));

  const metrics = computed(() => ({
    households: activeHouseholds.value.length,
    urgent: activeHouseholds.value.filter((item) => item.needLevel === "紧急").length,
    openTasks: tasks.value.filter((item) => item.status !== "已完成").length,
    queued: pendingRevisions.value.length,
    conflicts: openConflicts.value.length
  }));

  const duplicates = computed(() => {
    const groups = new Map<string, Household[]>();
    activeHouseholds.value.forEach((household) => {
      const key = `${household.head}-${household.community}`;
      groups.set(key, [...(groups.get(key) ?? []), household]);
    });
    return [...groups.values()].filter((group) => group.length > 1);
  });

  function conflictsOf(householdId: string): FieldConflict[] {
    return openConflicts.value.filter((c) => c.householdId === householdId);
  }

  /** 冲突未处理前不得推进相关任务：返回阻断原因，无冲突返回 null */
  function taskBlockReason(householdId: string): string | null {
    const list = conflictsOf(householdId);
    if (!list.length) return null;
    return `字段冲突未处理（${list.map((c) => FIELD_LABELS[c.field]).join("、")}），处理前不能推进相关任务`;
  }

  /** 某家庭当前待提交修订改过的字段（用于回网对账时保留本地未确认值） */
  function dirtyFields(householdId: string): Set<HouseholdField> {
    const set = new Set<HouseholdField>();
    pendingRevisions.value.forEach((rev) => {
      if (rev.householdId === householdId && rev.fields) rev.changedFields.forEach((f) => set.add(f));
    });
    return set;
  }

  // ---------- 修订账登记 ----------
  function appendRevision(rev: Omit<Revision, "id" | "seq" | "deviceId" | "deviceName" | "time" | "status"> & { id?: string }) {
    const entry: Revision = {
      id: rev.id ?? uid("rev"),
      seq: ++seqCounter,
      deviceId: device.value.id,
      deviceName: device.value.name,
      time: new Date().toISOString(),
      status: "待处理",
      ...rev
    };
    revisions.value.unshift(entry);
    return entry;
  }

  function applyFieldsLocal(household: Household, patch: Partial<Pick<Household, HouseholdField>>) {
    HOUSEHOLD_FIELDS.forEach((field) => {
      if (field in patch) (household as unknown as Record<string, unknown>)[field] = clone(patch[field]);
    });
    household.deviceUpdatedAt = new Date().toISOString();
    household.lastDevice = device.value.name;
  }

  // ---------- 家庭需求记录 ----------
  function addHousehold(input: Omit<Household, "id" | "status" | "version" | "deviceUpdatedAt" | "lastDevice" | "history" | "merged" | "mergedIntoId" | "mergedAt">) {
    const id = uid("h");
    const household: Household = {
      ...input, id, status: "待评估", version: 0,
      deviceUpdatedAt: new Date().toISOString(), lastDevice: device.value.name, history: []
    };
    households.value.unshift(household);
    // 新增即入账一条修订：基线版本 0，登记设备标识与全部字段
    appendRevision({
      kind: "家庭新增", baseVersion: 0, householdId: id,
      changedFields: [...HOUSEHOLD_FIELDS],
      fields: {
        head: household.head, community: household.community, address: household.address,
        members: household.members, vulnerable: household.vulnerable, needLevel: household.needLevel,
        needs: household.needs, status: household.status, note: household.note
      }
    });
  }

  /**
   * 保存家庭记录：只登记改过的字段（字段级修订），携带当前基础版本与设备标识。
   * 离线期间可继续修改，每次保存追加一条修订，互不覆盖。
   */
  function updateHousehold(id: string, patch: Partial<Pick<Household, HouseholdField>>) {
    const household = households.value.find((item) => item.id === id);
    if (!household) return;
    const changed = HOUSEHOLD_FIELDS.filter((field) =>
      field in patch && JSON.stringify(household[field]) !== JSON.stringify(patch[field]));
    if (!changed.length) return;
    const baseVersion = household.version;
    const baseValues: Partial<Record<HouseholdField, unknown>> = {};
    changed.forEach((f) => { baseValues[f] = clone(household[f]); });
    applyFieldsLocal(household, patch);
    const fields: Partial<Record<HouseholdField, unknown>> = {};
    changed.forEach((f) => { fields[f] = clone(patch[f]); });
    appendRevision({ kind: "家庭修改", baseVersion, householdId: id, changedFields: changed, fields, baseValues });
  }

  function renameDevice(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    device.value.name = trimmed;
    localStorage.setItem(DEVICE_KEY, JSON.stringify(device.value));
  }

  // ---------- 重复合并 ----------
  /**
   * 合并掉的家庭不能继续保留未结任务：其未结任务必须全部迁移到保留家庭；
   * 若存在未决冲突阻断迁移（相关任务不能推进），拒绝合并。
   */
  function mergeDuplicate(sourceId: string, targetId: string): { ok: boolean; message: string } {
    const source = households.value.find((item) => item.id === sourceId);
    const target = households.value.find((item) => item.id === targetId);
    if (!source || !target) return { ok: false, message: "记录不存在，无法合并。" };
    if (sourceId === targetId) return { ok: false, message: "不能合并自身。" };

    if (taskBlockReason(sourceId) || taskBlockReason(targetId)) {
      const which = taskBlockReason(sourceId) ? "被合并" : "保留";
      return { ok: false, message: `${which}家庭存在未处理字段冲突，先解决冲突才能合并。` };
    }

    // 本地执行：需求/特殊照护取并集，未结任务全部迁移到保留家庭
    target.needs = Array.from(new Set([...target.needs, ...source.needs]));
    target.vulnerable = Array.from(new Set([...target.vulnerable, ...source.vulnerable]));
    target.note = `${target.note}；已合并重复记录 ${source.address}`;
    target.lastDevice = device.value.name;
    target.deviceUpdatedAt = new Date().toISOString();
    tasks.value.forEach((task) => {
      if (task.householdId === sourceId && task.status !== "已完成") task.householdId = targetId;
    });
    source.merged = true;
    source.mergedIntoId = targetId;
    source.mergedAt = new Date().toISOString();

    appendRevision({
      kind: "重复合并", baseVersion: target.version, householdId: targetId,
      changedFields: [], merge: { sourceId, targetId }
    });
    return { ok: true, message: `已合并：${source.head} 的未结任务已全部迁移到保留记录。` };
  }

  // ---------- 任务分派与流转 ----------
  function addTask(input: Omit<FieldTask, "id" | "status" | "version" | "lastDevice">) {
    const household = households.value.find((item) => item.id === input.householdId);
    if (!household) return { ok: false, message: "家庭记录不存在。" };
    if (taskBlockReason(input.householdId)) {
      return { ok: false, message: taskBlockReason(input.householdId)! };
    }
    const taskId = uid("k");
    tasks.value.unshift({ ...input, id: taskId, status: "待接收", version: 0, lastDevice: device.value.name });
    appendRevision({
      kind: "任务分派", baseVersion: household.version, householdId: input.householdId,
      changedFields: [],
      task: { op: "create", taskId, title: input.title, assignee: input.assignee, priority: input.priority, due: input.due }
    });
    if (household.status !== "已完成" && household.status !== "已分派") {
      updateHousehold(household.id, { status: "已分派" });
    }
    return { ok: true, message: `任务「${input.title}」已分派并进入待同步队列。` };
  }

  /** 冲突没处理前不得推进相关任务 */
  function advanceTask(id: string): { ok: boolean; message: string } {
    const task = tasks.value.find((item) => item.id === id);
    if (!task) return { ok: false, message: "任务不存在。" };
    if (task.status === "已完成") return { ok: false, message: "任务已完成。" };
    const reason = taskBlockReason(task.householdId);
    if (reason) return { ok: false, message: reason };

    const next: TaskStatus = task.status === "待接收" ? "进行中" : "已完成";
    task.status = next;
    task.lastDevice = device.value.name;
    const household = households.value.find((item) => item.id === task.householdId);
    appendRevision({
      kind: "任务流转", baseVersion: household?.version ?? 0, householdId: task.householdId,
      changedFields: [], task: { op: "advance", taskId: task.id, advanceTo: next }
    });
    if (next === "已完成" && household) {
      const open = tasks.value.some((item) => item.householdId === household.id && item.status !== "已完成");
      if (!open && household.status !== "已完成") updateHousehold(household.id, { status: "已完成" });
    }
    return { ok: true, message: `任务「${task.title}」已推进到 ${next}。` };
  }

  // ---------- 同步：字段级合并 + 幂等重放 + 失败恢复 ----------
  /**
   * 应用服务端对账结果。
   * - 对本地没有待提交修订的字段，采用服务端值（不静默覆盖本地未确认修改）；
   * - 同字段不同设备、基线过期 → 登记字段冲突，任务推进随即被阻断；
   * - 被合并记录补做本地墓碑与未结任务迁移（幂等）。
   */
  function reconcile(result: PushResult) {
    for (const rec of result.records) {
      const household = households.value.find((h) => h.id === rec.id);
      if (!household) continue;

      if (rec.tombstone) {
        // 服务端墓碑可能来自另一台设备发起的合并：本地补做合并，保持幂等
        if (!household.merged) {
          household.merged = true;
          household.mergedIntoId = rec.tombstone.mergedIntoId;
          household.mergedAt = rec.tombstone.mergedAt;
          // 合并掉的家庭不能保留未结任务：以服务端迁移结果为准补齐
          tasks.value.forEach((t) => {
            if (t.householdId === household.id && t.status !== "已完成") t.householdId = rec.tombstone!.mergedIntoId;
          });
        }
        // 保留家庭的并集字段与说明由同批 target 记录对账，无需在此重复处理
      }

      const dirty = dirtyFields(rec.id);
      const incomingConflicts = new Map(result.conflicts.filter((c) => c.householdId === rec.id).map((c) => [c.field, c]));

      HOUSEHOLD_FIELDS.forEach((field) => {
        if (!(field in rec.fields)) return;
        const remoteValue = rec.fields[field];
        const c = incomingConflicts.get(field);
        if (c) {
          // 字段冲突：保留双方原值，登记待人工处理，不覆盖
          const exists = conflicts.value.some((x) =>
            x.householdId === rec.id && x.field === field && x.status === "待处理" &&
            x.remoteRevisionId === c.remoteRevisionId);
          if (!exists) {
            conflicts.value.unshift({
              id: uid("cf"), householdId: rec.id, field,
              remoteRevisionId: c.remoteRevisionId, remoteDevice: rec.lastDevice,
              localValue: clone(household[field]),
              remoteValue: clone(remoteValue),
              baseValue: clone(c.baseValue),
              status: "待处理", time: result.serverTime
            });
          }
          return;
        }
        // 本地该字段还有未确认修改时保留本地值，等其修订入账后再对账；否则采用服务端
        if (!dirty.has(field) && JSON.stringify(household[field]) !== JSON.stringify(remoteValue)) {
          (household as Record<string, unknown>)[field] = clone(remoteValue);
        }
      });

      household.version = rec.version;
      household.lastDevice = rec.lastDevice;
      household.deviceUpdatedAt = rec.deviceUpdatedAt;
      // 入账后的版本留一份快照，供已完成记录回退
      const lastSnap = household.history[household.history.length - 1];
      if (!lastSnap || lastSnap.version !== rec.version) {
        household.history.push(snapshotOf(household, rec.version, rec.lastDevice, rec.deviceUpdatedAt));
        if (household.history.length > 20) household.history.shift();
      }
    }

    // 对账任务（合并迁移、远端分派等）
    result.tasks.forEach((remote) => {
      const local = tasks.value.find((t) => t.id === remote.id);
      if (local) {
        local.householdId = remote.householdId;
        local.status = remote.status;
        local.version = remote.version;
        local.lastDevice = remote.lastDevice ?? local.lastDevice;
      } else {
        tasks.value.unshift({
          id: remote.id, householdId: remote.householdId, title: remote.title,
          assignee: remote.assignee, priority: remote.priority, status: remote.status,
          due: remote.due, version: remote.version, lastDevice: remote.lastDevice ?? "负责人端"
        });
      }
    });
  }

  /**
   * 推送待处理修订。重复提交安全：服务端按 revisionId 幂等，
   * “响应丢失”后重试只重放、不重复入账。
   */
  async function syncNow(): Promise<{ ok: boolean; message: string }> {
    if (!online.value) {
      return { ok: false, message: "仍在弱网/离线状态，修订保留在设备本地，回网后自动可续传。" };
    }
    const pending = pendingRevisions.value;
    if (!pending.length) {
      // 没有本地修订时也拉取一次远端变化（纯对账）
      return pullRemote();
    }

    syncing.value = true;
    lastSyncMessage.value = "";
    // 提交中：崩溃/断电后重启时这些项会被恢复为待处理（见 recoverPending）
    const batch = [...pending].sort((a, b) => a.seq - b.seq);
    batch.forEach((r) => { r.status = "提交中"; r.error = undefined; });

    try {
      const result = await api().push(batch.map((r) => ({ ...r })));
      reconcile(result);
      const seqOf = new Map(api().log().map((e) => [e.revisionId, e.seq]));
      batch.forEach((r) => {
        // 该修订是否仍有未决字段冲突（首批或重放都以本地冲突表为准）
        const stillConflicted = conflicts.value.some((c) => c.status === "待处理" && c.remoteRevisionId === r.id);
        if (stillConflicted) {
          r.status = "待处理";
          r.error = "部分字段冲突，待人工处理";
        } else {
          r.status = "已入账";
          if (seqOf.has(r.id)) r.ackedSeq = seqOf.get(r.id);
          r.error = undefined;
        }
      });
      lastSyncedAt.value = result.serverTime;
      serverLog.value = api().log();
      const dupNote = result.replayed ? "检测到重复提交，服务端仅入账一次（幂等）。" : "";
      const cfNote = result.conflicts.length
        ? `发现 ${result.conflicts.length} 个字段冲突，已保留双方数值，处理前相关任务不可推进。`
        : "字段已按字段级合并，无冲突。";
      lastSyncMessage.value = `${dupNote}${cfNote}`;
      return { ok: true, message: lastSyncMessage.value };
    } catch (err) {
      // 同步失败：提交中的修订恢复为待处理，可原样重试（含“已入账但响应丢失”）
      batch.forEach((r) => {
        if (r.status === "提交中") {
          r.status = "待处理";
          r.error = err instanceof Error ? err.message : "同步失败";
        }
      });
      // 即使没收到响应，服务端也可能已入账（响应丢失）：刷新流水便于核对幂等结果
      serverLog.value = api().log();
      const message = err instanceof Error ? err.message : "同步失败，待处理项已恢复。";
      lastSyncMessage.value = message;
      return { ok: false, message: "同步失败：待处理修订已恢复到队列，可重试。" + message };
    } finally {
      syncing.value = false;
    }
  }

  /** 启动时恢复：上次“提交中”但没走到确认的修订一律退回待处理 */
  function recoverPending() {
    let n = 0;
    submittingRevisions.value.forEach((r) => { r.status = "待处理"; r.error = "上次同步中断，已恢复待处理"; n += 1; });
    if (server) serverLog.value = server.log();
    return n;
  }

  async function pullRemote(): Promise<{ ok: boolean; message: string }> {
    syncing.value = true;
    try {
      // 无本地修订时拉取负责人端全量账本做字段对账
      const result = api().snapshot();
      reconcile(result);
      serverLog.value = api().log();
      lastSyncedAt.value = result.serverTime;
      return { ok: true, message: "无待同步修订，已与负责人端账本对账。" };
    } finally {
      syncing.value = false;
    }
  }

  // ---------- 冲突处理 ----------
  /**
   * 人工解决字段冲突：选择的一方生成一条新的字段修订（基线为服务端最新版本），
   * 原冲突修订中该字段视为已并入账本；全部字段解决后原修订入账。
   */
  function resolveConflict(id: string, resolution: "采用本机" | "采用远端"): { ok: boolean; message: string } {
    const conflict = conflicts.value.find((item) => item.id === id);
    if (!conflict || conflict.status !== "待处理") return { ok: false, message: "冲突已处理。" };
    const household = households.value.find((h) => h.id === conflict.householdId);
    if (!household) return { ok: false, message: "家庭记录不存在。" };

    const chosen = resolution === "采用本机" ? conflict.localValue : conflict.remoteValue;
    // 解决修订的基线取冲突时的服务端当前值，保证无论采用哪一方都能正确入账
    const baseValues = { [conflict.field]: clone(conflict.remoteValue) } as Partial<Record<HouseholdField, unknown>>;
    (household as Record<string, unknown>)[conflict.field] = clone(chosen);
    household.lastDevice = device.value.name;
    household.deviceUpdatedAt = new Date().toISOString();

    appendRevision({
      kind: "家庭修改", baseVersion: household.version, householdId: household.id,
      changedFields: [conflict.field],
      fields: { [conflict.field]: clone(chosen) },
      baseValues
    });

    conflict.status = "已解决";
    conflict.resolution = resolution;

    // 原冲突修订：去掉已解决字段；无剩余待处理冲突字段则标记入账（其意图已由解决修订承载）
    const origin = revisions.value.find((r) => r.id === conflict.remoteRevisionId);
    if (origin && origin.status !== "已入账") {
      origin.changedFields = origin.changedFields.filter((f) =>
        !(f === conflict.field && !conflicts.value.some((c) => c.status === "待处理" && c.remoteRevisionId === origin.id && c.field === f)));
      if (origin.fields) delete origin.fields[conflict.field];
      if (origin.baseValues) delete origin.baseValues[conflict.field];
      if (!origin.changedFields.length) {
        origin.status = "已入账";
        origin.error = undefined;
      }
    }
    return { ok: true, message: `已${resolution}「${FIELD_LABELS[conflict.field]}」，解决结果已登记为待同步修订。` };
  }

  // ---------- 回退 ----------
  /**
   * 已完成的记录可以回退到上一版：恢复上一确认快照并生成一条补偿修订，
   * 保证回退动作同样进账本、可同步，不会凭空丢历史。
   */
  function rollbackHousehold(id: string): { ok: boolean; message: string } {
    const household = households.value.find((h) => h.id === id);
    if (!household) return { ok: false, message: "记录不存在。" };
    if (household.status !== "已完成") return { ok: false, message: "只有已完成的记录可以回退到上一版。" };
    if (household.history.length < 2) return { ok: false, message: "没有可回退的上一版本。" };
    if (taskBlockReason(id)) return { ok: false, message: taskBlockReason(id)! };

    const previous = household.history[household.history.length - 2];
    const patch: Partial<Pick<Household, HouseholdField>> = { ...previous.fields };
    const changed = HOUSEHOLD_FIELDS.filter((f) =>
      f in patch && JSON.stringify(household[f]) !== JSON.stringify(patch[f]));
    const baseValues: Partial<Record<HouseholdField, unknown>> = {};
    changed.forEach((f) => { baseValues[f] = clone(household[f]); });
    applyFieldsLocal(household, patch);
    appendRevision({
      kind: "家庭修改", baseVersion: household.version, householdId: id,
      changedFields: changed,
      fields: Object.fromEntries(changed.map((f) => [f, clone(patch[f])])),
      baseValues
    });
    // 回退会把已闭环的任务退回进行中，同样要登记任务流转修订以便同步
    tasks.value.forEach((t) => {
      if (t.householdId === id && t.status === "已完成") {
        t.status = "进行中";
        t.lastDevice = device.value.name;
        appendRevision({
          kind: "任务流转", baseVersion: household.version, householdId: id,
          changedFields: [], task: { op: "advance", taskId: t.id, advanceTo: "进行中" }
        });
      }
    });
    return { ok: true, message: `已回退到 v${previous.version}，回退已登记为补偿修订，等待同步。` };
  }

  // ---------- 演示支持 ----------
  /**
   * 模拟另一台设备在远端直接改了某字段。这里故意不把远端值立即对账到本地：
   * 远端变化要等本设备回网同步时由服务端三方合并发现，才能真实演示
   * “两台设备同改一字段、后写不覆盖前写”。
   */
  async function simulateRemoteEdit(householdId: string, field: HouseholdField, value: unknown) {
    syncing.value = true;
    try {
      await api().remoteEdit(householdId, field, value);
      serverLog.value = api().log();
      return { ok: true as const, message: `负责人平板B 已在远端修改「${FIELD_LABELS[field]}」；本设备离线改同字段后回网同步，将产生字段冲突。` };
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : "远端修改失败" };
    } finally {
      syncing.value = false;
    }
  }

  function setFailureMode(mode: FailureMode) {
    failureMode.value = mode;
    if (server) server.failureMode = mode;
  }

  function refreshServerLog() {
    if (server) serverLog.value = server.log();
  }

  // ---------- 持久化 ----------
  if (typeof window !== "undefined") {
    // 启动恢复：上次同步在“提交中”中断（崩溃/掉电/杀进程）→ 一律退回待处理，接着处理
    const recovered = revisions.value.filter((r) => r.status === "提交中").length;
    if (recovered) recoverPending();
    watch(
      [households, tasks, revisions, conflicts, lastSyncedAt],
      () => {
        const payload: PersistShape = {
          v: 2,
          households: households.value,
          tasks: tasks.value,
          revisions: revisions.value,
          conflicts: conflicts.value,
          lastSyncedAt: lastSyncedAt.value
        };
        localStorage.setItem(KEY, JSON.stringify(payload));
      },
      { deep: true }
    );
  }

  return {
    // state
    device, households, tasks, revisions, conflicts, serverLog,
    online, lastSyncedAt, syncing, failureMode, lastSyncMessage,
    // derived
    activeHouseholds, pendingRevisions, submittingRevisions, openConflicts,
    metrics, duplicates,
    // queries
    conflictsOf, taskBlockReason, dirtyFields,
    // lifecycle
    recoverPending, refreshServerLog,
    // household
    addHousehold, updateHousehold, renameDevice, rollbackHousehold,
    // merge / tasks
    mergeDuplicate, addTask, advanceTask,
    // sync / conflict
    syncNow, resolveConflict, simulateRemoteEdit, setFailureMode
  };
});
