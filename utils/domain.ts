// 领域模型：家庭需求记录、现场任务与本地修订账（revision ledger）
// 修订账是唯一的事实来源：每次保存登记设备标识、基础版本与改动字段，
// 离线期间持续追加，回网后按字段提交合并；同一条修订重复提交只能入账一次。

export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type NeedLevel = "紧急" | "高" | "一般";
export type TaskStatus = "待接收" | "进行中" | "已完成";

/** 可参与字段级合并的家庭记录字段 */
export const HOUSEHOLD_FIELDS = [
  "head", "community", "address", "members",
  "vulnerable", "needLevel", "needs", "status", "note"
] as const;
export type HouseholdField = (typeof HOUSEHOLD_FIELDS)[number];

export const FIELD_LABELS: Record<HouseholdField, string> = {
  head: "户主姓名",
  community: "社区",
  address: "地址",
  members: "家庭人数",
  vulnerable: "特殊照护",
  needLevel: "需求等级",
  needs: "需求清单",
  status: "状态",
  note: "现场说明"
};

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
  /** 已确认（服务端入账）版本号；本地离线改动不提前抬版本 */
  version: number;
  deviceUpdatedAt: string;
  note: string;
  /** 最近一次改动该记录的设备名 */
  lastDevice: string;
  /** 被重复合并后保留墓碑，不删除，其未结任务必须已迁走 */
  merged?: boolean;
  mergedIntoId?: string;
  mergedAt?: string;
  /** 已确认快照的历史版本，已完成记录可回退到上一版 */
  history: HouseholdSnapshot[];
}

export interface HouseholdSnapshot {
  version: number;
  fields: Pick<Household, HouseholdField>;
  deviceName: string;
  time: string;
}

export interface FieldTask {
  id: string;
  householdId: string;
  title: string;
  assignee: string;
  priority: NeedLevel;
  status: TaskStatus;
  due: string;
  version: number;
  lastDevice: string;
}

/** 修订种类：家庭字段 / 任务 / 重复合并 */
export type RevisionKind = "家庭新增" | "家庭修改" | "任务分派" | "任务流转" | "重复合并";
/** 修订生命周期：待提交 → 提交中（崩溃/失败可恢复）→ 已入账；冲突解决单独立条 */
export type RevisionStatus = "待处理" | "提交中" | "已入账";

export interface Revision {
  id: string;
  /** 本地单调序号，保证同毫秒内连续保存的因果顺序 */
  seq: number;
  kind: RevisionKind;
  /** 发起修订的设备标识 */
  deviceId: string;
  deviceName: string;
  time: string;
  /** 修订所基于的家庭记录版本（新增记录为 0），用于判定字段冲突 */
  baseVersion: number;
  householdId: string;
  /** 改过的字段（合并类、任务类为结构性描述，不计入字段冲突） */
  changedFields: HouseholdField[];
  /** 字段修订负载：字段 → 新值（JSON 可序列化） */
  fields?: Partial<Record<HouseholdField, unknown>>;
  /** 三方合并基线：发起修订时各字段的旧值，服务端据此判定是否被他人改过 */
  baseValues?: Partial<Record<HouseholdField, unknown>>;
  /** 任务类修订负载 */
  task?: {
    op: "create" | "advance";
    taskId: string;
    title?: string;
    assignee?: string;
    priority?: NeedLevel;
    due?: string;
    advanceTo?: TaskStatus;
  };
  /** 合并类修订负载：被合并家庭 → 保留家庭（含未结任务迁移） */
  merge?: { sourceId: string; targetId: string };
  status: RevisionStatus;
  /** 服务端入账后回填的服务端修订序号 */
  ackedSeq?: number;
  error?: string;
}

/** 字段级冲突：两个设备改了同一字段且基线过期，必须人工处理，不静默覆盖 */
export interface FieldConflict {
  id: string;
  householdId: string;
  field: HouseholdField;
  /** 冲突来源的服务端修订（另一台设备） */
  remoteRevisionId: string;
  remoteDevice: string;
  localValue: unknown;
  remoteValue: unknown;
  baseValue: unknown;
  status: "待处理" | "已解决";
  resolution?: "采用本机" | "采用远端";
  time: string;
}

/** 服务端模拟的远端账本，供 UI 展示与演示 */
export interface ServerLogEntry {
  seq: number;
  revisionId: string;
  deviceName: string;
  kind: RevisionKind;
  householdId: string;
  time: string;
  duplicate: boolean;
  applied: boolean;
  conflictFields?: HouseholdField[];
  detail: string;
}

/** 提交结果：按 revisionId 幂等，重复提交返回同一次入账结果 */
export interface PushResult {
  /** 本次新入账的修订（重复提交为 0） */
  appliedCount: number;
  /** 是否为重放请求（账本里已有该修订） */
  replayed: boolean;
  /** 本批涉及的全部家庭与任务的最新服务端状态，用于字段级对账 */
  records: Array<{
    id: string;
    version: number;
    fields: Record<string, unknown>;
    lastDevice: string;
    deviceUpdatedAt: string;
    tombstone?: { mergedIntoId: string; mergedAt: string };
  }>;
  tasks: Array<{
    id: string;
    householdId: string;
    title: string;
    assignee: string;
    priority: NeedLevel;
    status: TaskStatus;
    due: string;
    version: number;
    lastDevice?: string;
  }>;
  /** 服务端检测到的字段冲突（同字段、不同设备、基线过期） */
  conflicts: Array<{
    householdId: string;
    field: HouseholdField;
    remoteRevisionId: string;
    remoteDevice: string;
    remoteValue: unknown;
    baseValue: unknown;
  }>;
  serverTime: string;
}

export function revisionDetail(rev: Pick<Revision, "kind" | "changedFields" | "fields" | "task" | "merge">): string {
  if (rev.kind === "任务分派" && rev.task) return `${rev.task.title ?? "任务"} → ${rev.task.assignee ?? ""}`;
  if (rev.kind === "任务流转" && rev.task) return `任务状态 → ${rev.task.advanceTo ?? ""}`;
  if (rev.kind === "重复合并" && rev.merge) return `记录 ${rev.merge.sourceId} → ${rev.merge.targetId}（含未结任务迁移）`;
  return rev.changedFields.map((f) => FIELD_LABELS[f]).join("、") || "—";
}

export function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * 账本数据统一为 JSON 可序列化结构；不能用 structuredClone —— 它无法克隆
 * Vue 的响应式 Proxy（会抛 DataCloneError），弱网真机上同样如此。
 */
export function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
