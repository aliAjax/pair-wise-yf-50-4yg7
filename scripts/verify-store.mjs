// 客户端 store 全链路：失败恢复 / 幂等重放 / 冲突阻断 / 合并迁移 / 版本回退
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { useAssessmentStore } from "../stores/assessment.ts";

class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
globalThis.localStorage = new MemStorage();
// 应用以 typeof window 作为浏览器/SSR 守卫（含持久化），测试里补 window shim
globalThis.window = globalThis;

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
async function flush() { await nextTick(); await new Promise((r) => setTimeout(r, 20)); }

function newStore() {
  const pinia = createPinia();
  setActivePinia(pinia);
  return useAssessmentStore();
}

async function main() {
  // ============ A. 失败恢复 + 幂等重放（响应丢失不多入账） ============
  let store = newStore();
  console.log("A. 同步失败恢复 + 重复提交只入账一次");
  store.updateHousehold("h1", { note: "离线写下的现场说明A" });
  check("保存后进入待处理队列", store.pendingRevisions.length === 1);
  let res = await store.syncNow();
  check("正常同步成功", res.ok);
  check("修订标记已入账", store.revisions[0].status === "已入账", store.revisions[0].status);

  store.updateHousehold("h1", { address: "河湾路18号附1号" });
  const revId = store.revisions[0].id;
  store.setFailureMode("响应丢失");
  res = await store.syncNow();
  check("响应丢失：同步报错", !res.ok);
  const afterFail = store.revisions.find((r) => r.id === revId);
  check("失败后修订恢复为待处理（可接着处理）", afterFail.status === "待处理", afterFail.status);
  // 再试一次仍丢失 —— 服务端已有账，但不能重复入账
  res = await store.syncNow();
  check("再次失败仍安全", !res.ok);
  const dupCount = store.serverLog.filter((e) => e.revisionId === revId).length;
  check("服务端只有 1 条入账（重试未多一份）", dupCount === 1, `got ${dupCount}`);
  // 网络恢复后重试：重放成功
  store.setFailureMode("正常");
  res = await store.syncNow();
  check("恢复后重放成功", res.ok, res.message);
  check("重放后修订已入账", store.revisions.find((r) => r.id === revId).status === "已入账");
  check("服务端仍然只有 1 条", store.serverLog.filter((e) => e.revisionId === revId).length === 1);

  // ============ B. 字段冲突阻断任务，解决后解锁 ============
  console.log("B. 两设备同改字段 → 冲突阻断任务推进 → 解决后解锁");
  await store.simulateRemoteEdit("h2", "note", "远端B改的饮水说明");
  store.updateHousehold("h2", { note: "本机离线改的饮水说明" });
  await store.syncNow();
  check("出现 1 个未决冲突", store.openConflicts.length === 1, `got ${store.openConflicts.length}`);
  check("h2 存在阻断原因", store.taskBlockReason("h2") !== null);
  let blocked = store.advanceTask("k1");
  check("冲突未处理：推进任务被拒绝", !blocked.ok, blocked.message);
  blocked = store.addTask({ householdId: "h2", title: "新增复核", assignee: "组X", priority: "一般", due: "2026-10-03 09:00" });
  check("冲突未处理：分派新任务被拒绝", !blocked.ok);
  const cfId = store.openConflicts[0].id;
  const resolved = store.resolveConflict(cfId, "采用本机");
  check("冲突可人工解决", resolved.ok);
  check("未决冲突清零", store.openConflicts.length === 0);
  check("解决动作生成了新修订", store.pendingRevisions.length >= 1);
  await store.syncNow();
  check("解决修订同步后无未决冲突", store.openConflicts.length === 0);
  const okAdv = store.advanceTask("k1");
  check("冲突处理后任务可推进", okAdv.ok, okAdv.message);
  await store.syncNow();

  // ============ C. 合并掉的家庭不留未结任务 ============
  console.log("C. 重复合并迁移全部未结任务，墓碑保留");
  const add = store.addTask({ householdId: "h3", title: "现场核验门牌", assignee: "救援三组", priority: "紧急", due: "2026-10-02 12:00" });
  check("给被合并家庭分派任务成功", add.ok);
  const migratedTask = store.tasks.find((t) => t.title === "现场核验门牌");
  const merge = store.mergeDuplicate("h3", "h1");
  check("合并成功", merge.ok, merge.message);
  check("未结任务已迁移到保留家庭 h1", migratedTask.householdId === "h1", migratedTask.householdId);
  check("h3 本地墓碑保留", store.households.find((h) => h.id === "h3")?.merged === true);
  check("有效家庭列表不再包含 h3", !store.activeHouseholds.some((h) => h.id === "h3"));
  const leftBehind = store.tasks.filter((t) => t.householdId === "h3" && t.status !== "已完成");
  check("h3 下没有任何未结任务残留", leftBehind.length === 0);
  await store.syncNow();
  await flush();
  check("同步后任务仍在 h1（服务端迁移一致）", migratedTask.householdId === "h1");
  check("同步后 h3 仍为墓碑", store.households.find((h) => h.id === "h3")?.merged === true);

  // ============ D. 已完成记录回退到上一版 ============
  console.log("D. 已完成记录回退到上一版");
  // 先制造两个已确认版本
  await store.syncNow().catch(() => {});
  store.updateHousehold("h2", { note: "版本二的说明" });
  await store.syncNow();
  // k1 在 B 段已完成；新建一个任务并走完闭环，使 h2 进入已完成
  const addD = store.addTask({ householdId: "h2", title: "收尾验收", assignee: "后勤一组", priority: "一般", due: "2026-10-02 18:00" });
  check("h2 新建收尾任务", addD.ok);
  const closeTaskId = store.tasks.find((t) => t.title === "收尾验收").id;
  check("收尾任务推进到进行中", store.advanceTask(closeTaskId).ok);
  const advance2 = store.advanceTask(closeTaskId);
  check("收尾任务推进到已完成", advance2.ok);
  await store.syncNow();
  const h2 = store.households.find((h) => h.id === "h2");
  check("h2 已完成", h2.status === "已完成", h2.status);
  check("已有 ≥2 个历史版本", h2.history.length >= 2, `got ${h2.history.length}`);
  const prevVersion = h2.history[h2.history.length - 2].version;
  const rb = store.rollbackHousehold("h2");
  check("回退成功", rb.ok, rb.message);
  check("回退后状态不再是已完成", store.households.find((h) => h.id === "h2").status !== "已完成");
  check("回退登记了补偿修订", store.pendingRevisions.some((r) => r.kind === "家庭修改"));
  check("已闭环的收尾任务退回进行中", store.tasks.find((t) => t.id === closeTaskId)?.status === "进行中");
  const rbSync = await store.syncNow();
  check("补偿修订可正常同步", rbSync.ok, rbSync.message);
  void prevVersion;

  // ============ E. 崩溃恢复：提交中断项重启后回到待处理 ============
  console.log("E. 重启后恢复“提交中”修订");
  store.updateHousehold("h1", { address: "崩溃恢复测试地址" });
  const crashId = store.revisions[0].id;
  store.revisions[0].status = "提交中";
  await flush(); // 等待持久化
  const store2 = newStore(); // 模拟重启：从 localStorage 重新装载
  const recovered = store2.revisions.find((r) => r.id === crashId);
  check("重启后提交中修订恢复为待处理", recovered.status === "待处理", recovered.status);
  const retry = await store2.syncNow();
  check("恢复后可继续提交", retry.ok, retry.message);

  // ============ F. 冲突中的合并被拒 ============
  console.log("F. 冲突未决时禁止合并相关家庭");
  await store2.simulateRemoteEdit("h1", "note", "远端又改了h1");
  store2.updateHousehold("h1", { note: "本机又改了h1" });
  // 造一个 h1 的未结任务 + 一个可被合并的重复家庭
  store2.addHousehold({ head: "王建国", community: "河湾社区", address: "另一个重复地址", members: 4, vulnerable: [], needLevel: "紧急", needs: ["帐篷"], note: "重复户" });
  const dup = store2.activeHouseholds.filter((h) => h.head === "王建国" && h.community === "河湾社区" && h.id !== "h1");
  await store2.syncNow();
  check("h1 进入冲突状态", store2.taskBlockReason("h1") !== null);
  // 给重复户挂未结任务后，冲突方在目标家庭：目标有冲突时合并也应拒绝
  const blockedMerge = store2.mergeDuplicate(dup[0].id, "h1");
  check("目标家庭冲突未决时合并被拒绝", !blockedMerge.ok, blockedMerge.message);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
