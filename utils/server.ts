// 模拟的团队负责人合并服务端：真实部署中对应负责人端/服务端 API。
// 账本按 revisionId 幂等入账；家庭字段按字段级三方合并（base / 本机 / 远端）；
// 同字段被两台设备基于同一旧值各自修改时登记字段冲突，不覆盖任何一方。
// 状态持久化在独立 localStorage 键中，与设备本地账本隔离（另一台设备/负责人视角）。

import {
  clone, FIELD_LABELS, HOUSEHOLD_FIELDS, uid,
  type FieldTask, type HouseholdField, type HouseholdStatus, type NeedLevel,
  type PushResult, type Revision, type ServerLogEntry
} from "./domain";

const SERVER_KEY = "pair-wise-yf-50/mock-server";
const LATENCY = 600;

interface ServerRecord {
  id: string;
  version: number;
  fields: Record<string, unknown>;
  lastDeviceId: string;
  lastDevice: string;
  deviceUpdatedAt: string;
  tombstone?: { mergedIntoId: string; mergedAt: string };
}

interface ServerState {
  records: Record<string, ServerRecord>;
  tasks: Record<string, FieldTask>;
  ledger: ServerLogEntry[];
  seq: number;
}

/** 同步故障模拟：正常 / 提交后响应丢失（重放必须幂等）/ 服务端暂不可用 */
export type FailureMode = "正常" | "响应丢失" | "服务端故障";

function seed(): ServerState {
  const now = Date.now();
  const mk = (
    id: string, head: string, community: string, address: string,
    members: number, vulnerable: string[], needLevel: NeedLevel,
    needs: string[], status: HouseholdStatus,
    note: string, version: number, agoMin: number
  ): ServerRecord => ({
    id, version,
    fields: { head, community, address, members, vulnerable, needLevel, needs, status, note },
    lastDeviceId: "device-seed", lastDevice: "现场设备A",
    deviceUpdatedAt: new Date(now - agoMin * 60000).toISOString()
  });
  return {
    records: {
      h1: mk("h1", "王建国", "河湾社区", "河湾路18号2单元", 4, ["老人"], "紧急", ["临时安置", "慢病用药"], "待复核", "一层受淹，老人行动不便", 2, 12),
      h2: mk("h2", "赵敏", "新城社区", "新城三街9号", 2, [], "一般", ["饮用水"], "已分派", "饮水库存不足", 1, 35),
      h3: mk("h3", "王建国", "河湾社区", "河湾路18号2幢2单元", 4, ["老人"], "紧急", ["临时安置", "慢病用药"], "待评估", "疑似重复登记", 1, 1)
    },
    tasks: {
      k1: { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-09-29 16:00", version: 1, lastDevice: "现场设备A" }
    },
    ledger: [],
    seq: 0
  };
}

function load(): ServerState {
  if (typeof window === "undefined") return seed();
  const raw = localStorage.getItem(SERVER_KEY);
  if (raw) {
    try { return JSON.parse(raw) as ServerState; } catch { /* 损坏则重建 */ }
  }
  const fresh = seed();
  localStorage.setItem(SERVER_KEY, JSON.stringify(fresh));
  return fresh;
}

export class MockServer {
  private state: ServerState;
  failureMode: FailureMode = "正常";

  constructor() {
    this.state = load();
  }

  private save() {
    localStorage.setItem(SERVER_KEY, JSON.stringify(this.state));
  }

  /** 负责人视角的入账流水（含被去重的重复提交） */
  log(): ServerLogEntry[] {
    return [...this.state.ledger].reverse();
  }

  reset() {
    this.state = seed();
    this.save();
  }

  /** 全量快照（无本地修订时拉取对账） */
  snapshot(): PushResult {
    return {
      appliedCount: 0, replayed: false,
      records: Object.values(this.state.records).map((r) => this.exportRecord(r)),
      tasks: Object.values(this.state.tasks).map((t) => ({ ...t })),
      conflicts: [],
      serverTime: new Date().toISOString()
    };
  }

  /**
   * 提交一批修订。按 revisionId 幂等：已入账的修订直接跳过重放，
   * 返回的对账结果始终由当前账本状态重建，因此“响应丢失”后重试不会多出一份。
   */
  async push(revisions: Revision[]): Promise<PushResult> {
    await new Promise((r) => setTimeout(r, LATENCY));
    if (this.failureMode === "服务端故障") {
      throw new Error("服务端暂不可用（503），修订已保留在本地待处理队列");
    }

    const touched = new Set<string>();
    const conflicts: PushResult["conflicts"] = [];
    let appliedCount = 0;
    let replayed = false;
    // 按本地单调序号入账，保证离线期间连续修改的因果顺序（同毫秒也不乱序）
    const ordered = [...revisions].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.time.localeCompare(b.time));

    // 同批次内同一家庭的同一字段被连续修改时，只有最后一条修订代表本机最终意图，
    // 前面的修订视为被覆盖（避免一次同步对同字段产生重复冲突）。
    const latestFieldRev = new Map<string, Revision>();
    ordered.forEach((rev) => {
      if (rev.kind !== "家庭修改") return;
      rev.changedFields.forEach((field) => {
        const key = `${rev.householdId}:${field}`;
        const prev = latestFieldRev.get(key);
        if (prev && prev.id !== rev.id) {
          prev.changedFields = prev.changedFields.filter((f) => f !== field);
          if (prev.fields) delete prev.fields[field];
          if (prev.baseValues) delete prev.baseValues[field];
        }
        latestFieldRev.set(key, rev);
      });
    });

    for (const rev of ordered) {
      rev.householdId && touched.add(rev.householdId);
      rev.merge && touched.add(rev.merge.sourceId);
      if (this.state.ledger.some((e) => e.revisionId === rev.id)) { replayed = true; continue; }
      let applied = true;
      const conflictFields: HouseholdField[] = [];

      if (rev.kind === "家庭新增") {
        if (!this.state.records[rev.householdId]) {
          this.state.records[rev.householdId] = {
            id: rev.householdId, version: 1,
            fields: { ...rev.fields } as Record<string, unknown>,
            lastDeviceId: rev.deviceId, lastDevice: rev.deviceName, deviceUpdatedAt: rev.time
          };
        }
      } else if (rev.kind === "家庭修改") {
        const record = this.state.records[rev.householdId];
        if (record && !record.tombstone) {
          let changed = false;
          for (const field of rev.changedFields) {
            const incoming = rev.fields?.[field];
            const base = rev.baseValues?.[field];
            const current = record.fields[field];
            // 三方合并：服务端值已偏离基线且不是本机此前的修改 → 对方也改了同字段
            const remoteChanged = JSON.stringify(base) !== JSON.stringify(current) && record.lastDeviceId !== rev.deviceId;
            const localChanged = JSON.stringify(base) !== JSON.stringify(incoming);
            if (remoteChanged && localChanged && JSON.stringify(incoming) !== JSON.stringify(current)) {
              applied = false;
              conflictFields.push(field);
              conflicts.push({
                householdId: rev.householdId,
                field,
                remoteRevisionId: rev.id,
                remoteDevice: rev.deviceName,
                remoteValue: current, // 服务端当前值（另一设备写入）
                baseValue: base
              });
            } else if (JSON.stringify(incoming) !== JSON.stringify(current)) {
              record.fields[field] = incoming;
              changed = true;
            }
          }
          if (changed) {
            record.version += 1;
            record.lastDeviceId = rev.deviceId;
            record.lastDevice = rev.deviceName;
            record.deviceUpdatedAt = rev.time;
          }
        }
      } else if (rev.kind === "重复合并" && rev.merge) {
        const source = this.state.records[rev.merge.sourceId];
        const target = this.state.records[rev.merge.targetId];
        touched.add(rev.merge.sourceId);
        if (source && target && !source.tombstone) {
          target.fields.needs = Array.from(new Set([...(target.fields.needs as string[]), ...(source.fields.needs as string[])]));
          target.fields.vulnerable = Array.from(new Set([...(target.fields.vulnerable as string[]), ...(source.fields.vulnerable as string[])]));
          target.fields.note = `${target.fields.note}；已合并重复记录 ${source.fields.address as string}`;
          target.version += 1;
          target.lastDeviceId = rev.deviceId;
          target.lastDevice = rev.deviceName;
          target.deviceUpdatedAt = rev.time;
          source.tombstone = { mergedIntoId: target.id, mergedAt: rev.time };
          // 被合并家庭的未结任务全部迁移到保留家庭，不允许遗留未结任务
          Object.values(this.state.tasks).forEach((task) => {
            if (task.householdId === source.id && task.status !== "已完成") task.householdId = target.id;
          });
        }
      } else if (rev.kind === "任务分派" && rev.task) {
        if (!this.state.tasks[rev.task.taskId]) {
          this.state.tasks[rev.task.taskId] = {
            id: rev.task.taskId,
            householdId: rev.householdId,
            title: rev.task.title ?? "",
            assignee: rev.task.assignee ?? "",
            priority: rev.task.priority ?? "一般",
            due: rev.task.due ?? "",
            status: "待接收",
            version: 1,
            lastDevice: rev.deviceName
          };
          const record = this.state.records[rev.householdId];
          if (record && record.fields.status !== "已完成") record.fields.status = "已分派";
        }
      } else if (rev.kind === "任务流转" && rev.task) {
        const task = this.state.tasks[rev.task.taskId];
        if (task && rev.task.advanceTo) {
          task.status = rev.task.advanceTo;
          task.version += 1;
          task.lastDevice = rev.deviceName;
          if (task.status === "已完成") {
            const open = Object.values(this.state.tasks).some((t) => t.householdId === task.householdId && t.status !== "已完成");
            const record = this.state.records[task.householdId];
            if (record && !open) record.fields.status = "已完成";
          }
        }
      }

      this.state.seq += 1;
      this.state.ledger.push({
        seq: this.state.seq,
        revisionId: rev.id,
        deviceName: rev.deviceName,
        kind: rev.kind,
        householdId: rev.householdId,
        time: rev.time,
        duplicate: false,
        applied,
        conflictFields: conflictFields.length ? conflictFields : undefined,
        detail: this.describe(conflictFields)
      });
      if (applied) appliedCount += 1;
    }

    this.save();
    const result: PushResult = {
      appliedCount,
      replayed,
      records: [...touched].map((id) => {
        const r = this.state.records[id];
        return r ? this.exportRecord(r) : null;
      }).filter(Boolean) as PushResult["records"],
      tasks: Object.values(this.state.tasks).filter((t) => touched.has(t.householdId)).map((t) => ({ ...t })),
      conflicts,
      serverTime: new Date().toISOString()
    };
    // 提交已入账但响应丢失：客户端收不到确认，重试时必须幂等重放
    if (this.failureMode === "响应丢失") {
      throw new Error("网络中断：服务端可能已入账但未收到确认，可安全重试（重复提交不会重复入账）");
    }
    return result;
  }

  private exportRecord(r: ServerRecord): PushResult["records"][number] {
    return {
      id: r.id, version: r.version, fields: r.fields, lastDevice: r.lastDevice,
      deviceUpdatedAt: r.deviceUpdatedAt,
      ...(r.tombstone ? { tombstone: r.tombstone } : {})
    };
  }

  private describe(conflictFields: HouseholdField[]): string {
    if (conflictFields.length) return `字段冲突待人工处理：${conflictFields.map((f) => FIELD_LABELS[f]).join("、")}`;
    return "修订已入账";
  }

  /** 演示：另一台设备（负责人的平板）直接在服务端改了某家庭的字段 */
  async remoteEdit(
    householdId: string, field: HouseholdField, value: unknown,
    deviceId = "device-remote-b", deviceName = "负责人平板B"
  ): Promise<PushResult> {
    await new Promise((r) => setTimeout(r, 300));
    const record = this.state.records[householdId];
    if (!record) throw new Error("远端无此记录");
    record.fields[field] = value;
    record.version += 1;
    record.lastDeviceId = deviceId;
    record.lastDevice = deviceName;
    record.deviceUpdatedAt = new Date().toISOString();
    this.state.seq += 1;
    this.state.ledger.push({
      seq: this.state.seq, revisionId: uid("rev"), deviceName, kind: "家庭修改", householdId,
      time: record.deviceUpdatedAt, duplicate: false, applied: true,
      detail: `远端直接修改：${FIELD_LABELS[field]}`
    });
    this.save();
    return {
      appliedCount: 0, replayed: false,
      records: [this.exportRecord(record)],
      tasks: [], conflicts: [], serverTime: record.deviceUpdatedAt
    };
  }
}
