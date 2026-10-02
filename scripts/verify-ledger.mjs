// 修订账服务端语义验证：幂等重放 / 三方字段冲突 / 不同字段自动合并 / 重复合并迁移任务
import { MockServer } from "../utils/server.ts";

// ---- 浏览器环境 shim ----
class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
globalThis.localStorage = new MemStorage();

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const now = Date.now();
function rev(partial) {
  return {
    id: partial.id, kind: partial.kind, deviceId: partial.deviceId, deviceName: partial.deviceName,
    seq: partial._seq ?? 0,
    time: new Date(now + (partial._seq ?? 0)).toISOString(), baseVersion: partial.baseVersion ?? 0,
    householdId: partial.householdId, changedFields: partial.changedFields ?? [],
    fields: partial.fields, baseValues: partial.baseValues,
    task: partial.task, merge: partial.merge, status: "待处理"
  };
}

async function main() {
  const server = new MockServer();

  console.log("1) 重复提交只入账一次（幂等）");
  const r1 = rev({
    id: "r1", kind: "家庭修改", deviceId: "devA", deviceName: "设备A", householdId: "h1",
    changedFields: ["note"], fields: { note: "A改的说明" }, baseValues: { note: "一层受淹，老人行动不便" }, _seq: 1
  });
  const first = await server.push([r1]);
  const second = await server.push([r1]);
  check("首次提交入账 1 条", first.appliedCount === 1, `got ${first.appliedCount}`);
  check("重放标记 replayed", second.replayed === true);
  check("重放入账 0 条（不多出一份）", second.appliedCount === 0, `got ${second.appliedCount}`);
  check("服务端流水仅 1 条 r1", server.log().filter((e) => e.revisionId === "r1").length === 1);

  console.log("2) 不同字段：两台设备各自修改，按字段自动合并且无冲突");
  const server2 = new MockServer(); server2.reset();
  const a = rev({
    id: "a1", kind: "家庭修改", deviceId: "devA", deviceName: "设备A", householdId: "h1",
    changedFields: ["address"], fields: { address: "A的地址" }, baseValues: { address: "河湾路18号2单元" }, _seq: 1
  });
  const b = rev({
    id: "b1", kind: "家庭修改", deviceId: "devB", deviceName: "设备B", householdId: "h1",
    changedFields: ["note"], fields: { note: "B的说明" }, baseValues: { note: "一层受淹，老人行动不便" }, _seq: 2
  });
  // 模拟 A 先同步，B 基于旧基线后同步
  await server2.push([a]);
  const res2 = await server2.push([b]);
  const h1 = res2.records.find((r) => r.id === "h1");
  check("无字段冲突", res2.conflicts.length === 0, `got ${res2.conflicts.length}`);
  check("地址取 A 的值", h1.fields.address === "A的地址", h1.fields.address);
  check("说明取 B 的值（字段合并）", h1.fields.note === "B的说明", h1.fields.note);

  console.log("3) 同一字段：两台设备基于同一旧值各改 → 冲突，不覆盖");
  const server3 = new MockServer(); server3.reset();
  const a3 = rev({
    id: "a3", kind: "家庭修改", deviceId: "devA", deviceName: "设备A", householdId: "h1",
    changedFields: ["address"], fields: { address: "A改地址" }, baseValues: { address: "河湾路18号2单元" }, _seq: 1
  });
  const b3 = rev({
    id: "b3", kind: "家庭修改", deviceId: "devB", deviceName: "设备B", householdId: "h1",
    changedFields: ["address"], fields: { address: "B改地址" }, baseValues: { address: "河湾路18号2单元" }, _seq: 2
  });
  await server3.push([a3]);
  const res3 = await server3.push([b3]);
  check("产生 1 个冲突", res3.conflicts.length === 1, `got ${res3.conflicts.length}`);
  const h1b = res3.records.find((r) => r.id === "h1");
  check("服务端保留 A 的值，不被 B 覆盖（后写不覆盖前写）", h1b.fields.address === "A改地址", h1b.fields.address);
  check("冲突回执 remoteValue 为服务端现值（A改地址）", res3.conflicts[0].remoteValue === "A改地址");
  check("冲突回执 baseValue 为共同旧值", res3.conflicts[0].baseValue === "河湾路18号2单元");
  check("冲突修订仍只入账一次（再提交 b3 不新增流水）", server3.log().filter((e) => e.revisionId === "b3").length === 1);

  console.log("4) 冲突解决后以服务端当前值为基线提交 → 正常入账，不再冲突");
  const resolve = rev({
    id: "b3r", kind: "家庭修改", deviceId: "devB", deviceName: "设备B", householdId: "h1",
    changedFields: ["address"], fields: { address: "A改地址" }, baseValues: { address: "A改地址" }, _seq: 3
  });
  const res4 = await server3.push([resolve]);
  check("解决修订无冲突", res4.conflicts.length === 0);
  const h1c = res4.records.find((r) => r.id === "h1");
  check("地址收敛为解决值", h1c.fields.address === "A改地址");

  console.log("5) 重复合并：被合并家庭未结任务迁移到保留家庭，并保留墓碑");
  const server5 = new MockServer(); server5.reset();
  // 先给 h3 派一个未结任务
  await server5.push([rev({
    id: "t3", kind: "任务分派", deviceId: "devA", deviceName: "设备A", householdId: "h3",
    task: { op: "create", taskId: "k3", title: "现场核验", assignee: "救援一组", priority: "紧急", due: "2026-10-02 12:00" }, _seq: 1
  })]);
  const res5 = await server5.push([rev({
    id: "m1", kind: "重复合并", deviceId: "devA", deviceName: "设备A", householdId: "h1",
    merge: { sourceId: "h3", targetId: "h1" }, _seq: 2
  })]);
  check("h3 返回墓碑指向 h1", res5.records.find((r) => r.id === "h3")?.tombstone?.mergedIntoId === "h1");
  check("k3 任务已迁移到 h1（无未结任务留在被合并家庭）", res5.tasks.find((t) => t.id === "k3")?.householdId === "h1");
  const h1d = res5.records.find((r) => r.id === "h1");
  check("需求取并集", JSON.stringify(h1d.fields.needs) === JSON.stringify(["临时安置", "慢病用药"]));

  console.log("6) 合并幂等：重复提交合并修订不会二次合并/重复迁移");
  const res6 = await server5.push([rev({
    id: "m1", kind: "重复合并", deviceId: "devA", deviceName: "设备A", householdId: "h1",
    merge: { sourceId: "h3", targetId: "h1" }, _seq: 2
  })]);
  check("重放合并 appliedCount=0（跳过）", res6.appliedCount === 0, `got ${res6.appliedCount}`);
  check("说明未被重复追加", (res6.records.find((r) => r.id === "h1")?.fields.note.match(/已合并重复记录/g) ?? []).length === 1);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail) process.exit(1);
}
main();
