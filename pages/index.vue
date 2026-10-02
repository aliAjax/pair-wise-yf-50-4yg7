<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NSelect, NStatistic, NSwitch, NTag } from "naive-ui";
import { useOnline } from "@vueuse/core";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useAssessmentStore } from "~/stores/assessment";
import {
  FIELD_LABELS, revisionDetail,
  type Household, type HouseholdField, type NeedLevel, type Revision
} from "~/utils/domain";
import { probeCache } from "~/utils/api";

const store = useAssessmentStore();
const browserOnline = useOnline();
const panel = ref("需求记录");
const selectedId = ref(store.activeHouseholds[0]?.id ?? "");
const cacheProbe = ref<{ cachedAt: string; source: string } | null>(null);
const toast = ref("");
const deviceDraft = ref(store.device.name);

const schema = toTypedSchema(z.object({
  head: z.string().min(2, "请输入户主姓名"),
  community: z.string().min(2),
  address: z.string().min(4),
  members: z.coerce.number().min(1).max(30),
  needLevel: z.enum(["紧急", "高", "一般"]),
  needs: z.string().min(2),
  note: z.string().min(2)
}));
const { defineField, errors, handleSubmit, resetForm } = useForm({
  validationSchema: schema,
  initialValues: { head: "", community: "河湾社区", address: "", members: 1, needLevel: "一般" as NeedLevel, needs: "", note: "" }
});
const [head] = defineField("head");
const [community] = defineField("community");
const [address] = defineField("address");
const [members] = defineField("members");
const [needLevel] = defineField("needLevel");
const [needs] = defineField("needs");
const [note] = defineField("note");

const selected = computed(() => store.activeHouseholds.find((item) => item.id === selectedId.value) ?? store.activeHouseholds[0]);
const taskAssignee = ref("救援一组");
const taskTitle = ref("现场复核");

// 选中家庭的字段编辑（每次保存只登记改过的字段 + 基础版本 + 设备标识）
const editAddress = ref("");
const editNeedLevel = ref<NeedLevel>("一般");
const editNeeds = ref("");
const editNote = ref("");
function loadEditor(item: Household | undefined) {
  if (!item) return;
  editAddress.value = item.address;
  editNeedLevel.value = item.needLevel;
  editNeeds.value = item.needs.join("，");
  editNote.value = item.note;
}
loadEditor(selected.value);
function onSelect(id: string) {
  selectedId.value = id;
  loadEditor(store.activeHouseholds.find((h) => h.id === id));
}

function notify(message: string) {
  toast.value = message;
  window.setTimeout(() => { if (toast.value === message) toast.value = ""; }, 5200);
}

function fmt(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join("、") : "（空）";
  return value === undefined || value === null || value === "" ? "（空）" : String(value);
}

function revTagType(rev: Revision): "default" | "warning" | "success" | "error" {
  if (rev.status === "已入账") return "success";
  if (rev.status === "提交中") return "warning";
  return rev.error ? "error" : "default";
}

const submit = handleSubmit((values) => {
  store.addHousehold({
    head: values.head, community: values.community, address: values.address,
    members: Number(values.members), vulnerable: [], needLevel: values.needLevel as NeedLevel,
    needs: values.needs.split(/[，,]/).map((item) => item.trim()).filter(Boolean), note: values.note
  });
  resetForm();
  notify("已保存到本地修订账（待同步），离线期间可继续修改。");
});

function saveEdit() {
  if (!selected.value) return;
  const patch: Partial<Pick<Household, HouseholdField>> = {};
  if (editAddress.value !== selected.value.address) patch.address = editAddress.value;
  if (editNeedLevel.value !== selected.value.needLevel) patch.needLevel = editNeedLevel.value;
  const nextNeeds = editNeeds.value.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
  if (JSON.stringify(nextNeeds) !== JSON.stringify(selected.value.needs)) patch.needs = nextNeeds;
  if (editNote.value !== selected.value.note) patch.note = editNote.value;
  if (!Object.keys(patch).length) { notify("没有字段发生变化，未登记修订。"); return; }
  store.updateHousehold(selected.value.id, patch);
  notify(`已登记字段修订（基线 v${selected.value.version}）：${Object.keys(patch).map((f) => FIELD_LABELS[f as HouseholdField]).join("、")}`);
}

function assignTask() {
  if (!selected.value) return;
  const result = store.addTask({
    householdId: selected.value.id, title: taskTitle.value, assignee: taskAssignee.value,
    priority: selected.value.needLevel, due: "2026-10-02 18:00"
  });
  notify(result.message);
}

function advance(id: string) {
  notify(store.advanceTask(id).message);
}

async function sync() {
  notify((await store.syncNow()).message);
}

function doMerge(sourceId: string, targetId: string) {
  notify(store.mergeDuplicate(sourceId, targetId).message);
}

function resolve(id: string, resolution: "采用本机" | "采用远端") {
  notify(store.resolveConflict(id, resolution).message);
}

function rollback() {
  if (selected.value) notify(store.rollbackHousehold(selected.value.id).message);
}

async function makeRemoteConflict() {
  if (!selected.value) return;
  // 远端（负责人平板B）改地址；本设备随后离线改同一字段，同步时即三方冲突
  const r1 = await store.simulateRemoteEdit(selected.value.id, "address", `${selected.value.address}（B改）`);
  notify(r1.message);
}

function offlineEditSameField() {
  if (!selected.value) return;
  store.updateHousehold(selected.value.id, { address: `${editAddress.value || selected.value.address}（本机改）` });
  loadEditor(store.activeHouseholds.find((h) => h.id === selected.value.id));
  notify("本机已离线修改同一字段（地址），回网同步将产生字段级冲突而非覆盖。");
}

onMounted(async () => {
  cacheProbe.value = await probeCache();
  store.online = browserOnline.value;
});
</script>

<template>
  <div class="shell">
    <aside class="side">
      <div class="brand"><b>FIELD OPS</b><span>灾后评估</span></div>
      <nav>
        <button v-for="item in ['需求记录', '重复合并', '任务分派', '同步队列', '冲突处理']" :key="item"
          :class="{ active: panel === item }" @click="panel = item">
          {{ item }}
          <span v-if="item === '同步队列' && store.pendingRevisions.length">({{ store.pendingRevisions.length }})</span>
          <em v-if="item === '冲突处理' && store.openConflicts.length" class="badge">{{ store.openConflicts.length }}</em>
        </button>
      </nav>
      <div class="network">
        <small>设备标识（修订入账依据）</small>
        <b>{{ store.device.name }}</b>
        <div class="device-rename"><NInput v-model:value="deviceDraft" size="tiny" @keyup.enter="store.renameDevice(deviceDraft)" /><NButton size="tiny" @click="store.renameDevice(deviceDraft)">改名</NButton></div>
        <small class="device-id">ID：{{ store.device.id }}</small>
        <hr />
        <small>设备与网络</small>
        <b>{{ browserOnline && store.online ? '在线' : '弱网 / 离线' }}</b>
        <NSwitch v-model:value="store.online" />
        <small>最近同步 {{ new Date(store.lastSyncedAt).toLocaleTimeString('zh-CN') }}</small>
      </div>
    </aside>
    <main>
      <header>
        <div>
          <small>评估批次 2026-10-01 · 河湾片区 · 本地修订账（可恢复）</small>
          <h1>灾后需求评估与任务分派</h1>
          <p>每次保存登记设备标识、基础版本与改动字段；回网后按字段三方合并，重复提交只入账一次，冲突未决不推进任务。</p>
        </div>
        <div class="status-chip">
          <NProgress type="circle" :percentage="store.pendingRevisions.length ? Math.max(12, 100 - store.pendingRevisions.length * 8) : 100" :stroke-width="8" :width="42" />
          <span>{{ store.pendingRevisions.length ? `${store.pendingRevisions.length} 条修订待同步` : '修订账已全部入账' }}</span>
        </div>
      </header>

      <NAlert v-if="toast" type="info" :show-icon="true" class="toast" @close="toast = ''">{{ toast }}</NAlert>
      <NAlert v-if="store.openConflicts.length" type="error" show-icon>
        有 {{ store.openConflicts.length }} 个字段冲突待人工处理；相关家庭的任务推进、分派与重复合并均已被阻断，处理完成前不得推进。
      </NAlert>
      <NAlert v-else-if="!browserOnline || !store.online" type="warning" show-icon>
        当前网络不可用。所有保存继续追加进本地修订账（含基础版本与设备标识），回网后自动按字段合并。
      </NAlert>

      <section class="metrics">
        <NCard><NStatistic label="有效家庭" :value="store.metrics.households" /></NCard>
        <NCard><NStatistic label="紧急需求" :value="store.metrics.urgent" /></NCard>
        <NCard><NStatistic label="未完成任务" :value="store.metrics.openTasks" /></NCard>
        <NCard><NStatistic label="待同步修订" :value="store.metrics.queued" /></NCard>
      </section>

      <!-- ================= 需求记录 ================= -->
      <div v-if="panel === '需求记录'" class="page-grid">
        <NCard title="家庭走访记录（含修订版本与设备）" :bordered="false">
          <div class="households">
            <article v-for="item in store.households" :key="item.id" class="household"
              :class="{ selected: selectedId === item.id, merged: item.merged }" @click="!item.merged && onSelect(item.id)">
              <div>
                <b>{{ item.head }} · {{ item.members }}人</b>
                <small>{{ item.community }} / {{ item.address }}</small>
                <p>{{ item.needs.join('、') }} · {{ item.note }}</p>
                <small v-if="item.merged" class="merged-line">已合并到 {{ item.mergedIntoId }}，未结任务已迁走（保留墓碑）</small>
              </div>
              <div class="household-meta">
                <NTag :type="item.needLevel === '紧急' ? 'error' : item.needLevel === '高' ? 'warning' : 'success'">{{ item.needLevel }}</NTag>
                <small>{{ item.status }} · v{{ item.version }}</small>
                <small>最近：{{ item.lastDevice }}</small>
                <NTag v-if="store.conflictsOf(item.id).length" type="error" size="small">
                  {{ store.conflictsOf(item.id).map((c) => FIELD_LABELS[c.field]).join('、') }} 冲突
                </NTag>
              </div>
            </article>
          </div>
        </NCard>

        <div class="side-stack">
          <NCard title="字段修订保存（只登记改过的字段）">
            <template v-if="selected">
              <p class="hint">当前：<b>{{ selected.head }}</b> · 基础版本 v{{ selected.version }} · 设备 {{ store.device.name }}</p>
              <label class="field"><span>地址描述</span><NInput v-model:value="editAddress" /></label>
              <label class="field"><span>需求等级</span>
                <NSelect v-model:value="editNeedLevel" :options="[{value:'紧急',label:'紧急'},{value:'高',label:'高'},{value:'一般',label:'一般'}]" />
              </label>
              <label class="field"><span>主要需求（逗号分隔）</span><NInput v-model:value="editNeeds" /></label>
              <label class="field"><span>现场说明</span><NInput v-model:value="editNote" type="textarea" /></label>
              <div class="actions">
                <NButton type="primary" @click="saveEdit">保存为字段修订</NButton>
                <NButton :disabled="selected.status !== '已完成' || selected.history.length < 2" @click="rollback">回退到上一版</NButton>
              </div>
              <small v-if="selected.status === '已完成' && selected.history.length < 2" class="hint">已完成但仅有一个已确认版本，暂无可回退版本。</small>
            </template>
            <p v-else class="empty">请选择一条家庭记录。</p>
          </NCard>

          <NCard title="新增需求记录">
            <form class="field-grid" @submit.prevent="submit">
              <label class="field"><span>户主姓名</span><NInput v-model:value="head" /><small>{{ errors.head }}</small></label>
              <label class="field"><span>社区</span><NInput v-model:value="community" /></label>
              <label class="field wide"><span>地址描述</span><NInput v-model:value="address" placeholder="楼栋与单元" /><small>{{ errors.address }}</small></label>
              <label class="field"><span>家庭人数</span><NInput :value="String(members)" @update:value="members = Number($event)" type="text" inputmode="numeric" /></label>
              <label class="field"><span>需求等级</span><NSelect v-model:value="needLevel" :options="[{value:'紧急',label:'紧急'},{value:'高',label:'高'},{value:'一般',label:'一般'}]" /></label>
              <label class="field wide"><span>主要需求（逗号分隔）</span><NInput v-model:value="needs" placeholder="临时安置，饮用水" /><small>{{ errors.needs }}</small></label>
              <label class="field wide"><span>现场说明</span><NInput v-model:value="note" type="textarea" /><small>{{ errors.note }}</small></label>
              <div class="actions wide"><NButton attr-type="submit" type="primary">保存本地记录（入修订账）</NButton></div>
            </form>
          </NCard>
        </div>
      </div>

      <!-- ================= 重复合并 ================= -->
      <NCard v-if="panel === '重复合并'" title="疑似重复记录（合并必须迁走未结任务）">
        <div v-for="group in store.duplicates" :key="group.map((item) => item.id).join('-')" class="duplicate">
          <b>{{ group[0].head }} · {{ group[0].community }}</b>
          <p>{{ group.map((item) => `${item.address} / ${item.note}`).join('；') }}</p>
          <small class="hint">
            保留 {{ group[0].address }}；被合并家庭的未结任务将全部迁移到保留家庭，冲突未决时禁止合并。
          </small>
          <div class="actions"><NButton type="primary" size="small" @click="doMerge(group[1].id, group[0].id)">合并为一条并迁移全部未结任务</NButton></div>
        </div>
        <p v-if="!store.duplicates.length" class="empty">没有检测到疑似重复记录。</p>
      </NCard>

      <!-- ================= 任务分派 ================= -->
      <div v-if="panel === '任务分派'" class="page-grid">
        <NCard title="任务列表（冲突未处理不得推进）">
          <NAlert v-for="task in store.tasks" :key="task.id" :show-icon="false" class="task-alert"
            :type="store.taskBlockReason(task.householdId) ? 'error' : 'default'">
            <div class="task-row">
              <div>
                <b :class="{ complete: task.status === '已完成' }">{{ task.title }}</b>
                <small>{{ store.households.find((item) => item.id === task.householdId)?.head }} · {{ task.due }} · {{ task.assignee }}</small>
                <small v-if="store.taskBlockReason(task.householdId)" class="block-reason">⛔ {{ store.taskBlockReason(task.householdId) }}</small>
              </div>
              <NTag>{{ task.priority }}</NTag>
              <span>{{ task.status }} · v{{ task.version }}</span>
              <NButton size="small" :disabled="task.status === '已完成' || !!store.taskBlockReason(task.householdId)" @click="advance(task.id)">推进状态</NButton>
            </div>
          </NAlert>
        </NCard>
        <NCard title="分派新任务">
          <p class="hint">当前家庭：<b>{{ selected?.head }}</b></p>
          <p v-if="selected && store.taskBlockReason(selected.id)" class="block-reason">⛔ {{ store.taskBlockReason(selected.id) }}</p>
          <label class="field"><span>任务内容</span><NInput v-model:value="taskTitle" /></label>
          <label class="field"><span>执行人/小组</span><NInput v-model:value="taskAssignee" /></label>
          <NButton type="primary" block class="mt8" :disabled="!selected || !!store.taskBlockReason(selected?.id ?? '')" @click="assignTask">加入任务并本地排队</NButton>
        </NCard>
      </div>

      <!-- ================= 同步队列 ================= -->
      <div v-if="panel === '同步队列'" class="page-grid">
        <NCard title="待同步修订账（outbox：待处理 / 提交中 / 已入账）">
          <p class="hint">{{ store.lastSyncMessage || '恢复连接后按顺序提交；每条修订带 revisionId，重复提交只入账一次。' }}</p>
          <div v-for="item in store.revisions" :key="item.id" class="queue-row">
            <NTag :type="revTagType(item)">{{ item.status }}</NTag>
            <div class="queue-main">
              <span><b>{{ item.kind }}</b> · {{ revisionDetail(item) }}</span>
              <small>{{ item.deviceName }}（{{ item.deviceId }}）· 基础版本 v{{ item.baseVersion }} · 字段：{{ item.changedFields.map((f) => FIELD_LABELS[f]).join('、') || '—' }}</small>
              <small class="mono">rev {{ item.id }} · {{ new Date(item.time).toLocaleTimeString('zh-CN') }}<template v-if="item.ackedSeq"> · 入账序号 #{{ item.ackedSeq }}</template></small>
              <small v-if="item.error" class="block-reason">{{ item.error }}</small>
            </div>
          </div>
          <p v-if="!store.revisions.length" class="empty">修订账为空，先保存一条家庭记录。</p>
          <div class="actions mt8">
            <NButton type="primary" :loading="store.syncing" @click="sync">{{ store.online ? '提交并字段合并' : '离线中，点击保留' }}</NButton>
          </div>
        </NCard>

        <div class="side-stack">
          <NCard title="弱网 / 故障演练">
            <label class="field"><span>模拟链路状态</span>
              <NSelect :value="store.failureMode" :options="[{value:'正常',label:'正常'},{value:'响应丢失',label:'提交成功但响应丢失（验证幂等重放）'},{value:'服务端故障',label:'服务端 503（验证失败恢复）'}]" @update:value="store.setFailureMode" />
            </label>
            <p class="hint">「响应丢失」：服务端已入账但客户端没收到确认，修订回到待处理；再次点击提交只重放，负责人账本不会多出一份。</p>
            <div class="actions">
              <NButton size="small" @click="makeRemoteConflict">① 远端B改地址</NButton>
              <NButton size="small" @click="offlineEditSameField">② 本机离线改同一地址</NButton>
              <NButton size="small" type="primary" @click="sync">③ 回网提交</NButton>
            </div>
            <small v-if="cacheProbe" class="hint">本地缓存探测：{{ new Date(cacheProbe.cachedAt).toLocaleTimeString('zh-CN') }} / {{ cacheProbe.source }}</small>
          </NCard>

          <NCard title="负责人合并账本（服务端入账流水）">
            <div v-for="entry in store.serverLog" :key="entry.seq" class="ledger-row">
              <NTag size="small" :type="entry.applied ? 'success' : 'error'">#{{ entry.seq }}</NTag>
              <div>
                <span>{{ entry.deviceName }} · {{ entry.kind }}</span>
                <small>{{ entry.detail }} · {{ new Date(entry.time).toLocaleTimeString('zh-CN') }}</small>
                <small class="mono">{{ entry.revisionId }}</small>
              </div>
            </div>
            <p v-if="!store.serverLog.length" class="empty">暂无入账记录。</p>
          </NCard>
        </div>
      </div>

      <!-- ================= 冲突处理 ================= -->
      <NCard v-if="panel === '冲突处理'" title="字段级冲突（三方合并：基础值 / 本机 / 远端）">
        <div v-for="item in store.conflicts" :key="item.id" class="conflict">
          <b>{{ store.households.find((household) => household.id === item.householdId)?.head }} · {{ FIELD_LABELS[item.field] }}</b>
          <div class="conflict-values">
            <div><small>共同基础值（v-）</small><span>{{ fmt(item.baseValue) }}</span></div>
            <div class="mine"><small>本机记录（{{ store.device.name }}）</small><span>{{ fmt(item.localValue) }}</span></div>
            <div class="theirs"><small>远端记录（{{ item.remoteDevice }}）</small><span>{{ fmt(item.remoteValue) }}</span></div>
          </div>
          <div class="actions">
            <NButton size="small" :disabled="item.status !== '待处理'" @click="resolve(item.id, '采用本机')">采用本机</NButton>
            <NButton size="small" type="primary" :disabled="item.status !== '待处理'" @click="resolve(item.id, '采用远端')">采用远端</NButton>
            <NTag :type="item.status === '待处理' ? 'error' : 'success'">{{ item.status }}<template v-if="item.resolution"> · {{ item.resolution }}</template></NTag>
          </div>
          <small class="hint">处理结果会生成一条新的字段修订（以远端当前值为基线）进入队列，回网入账；处理前该家庭的任务全部锁定。</small>
        </div>
        <p v-if="!store.conflicts.length" class="empty">暂无字段冲突。可用「同步队列 → 弱网演练」三步复现两台设备同改一字段。</p>
      </NCard>
    </main>
  </div>
</template>
