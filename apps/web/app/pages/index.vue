<script setup lang="ts">
import { toast } from 'vue-sonner'

const { data: summary, refresh: refreshSummary } = await useFetch('/api/summary')
const { data: fills, refresh: refreshFills } = await useFetch('/api/fills?limit=100')

const STALE_MS = 60_000
const now = ref(Date.now())
const botAlive = computed(() => {
  const at = summary.value?.status?.heartbeatAt
  return at ? now.value - new Date(at).getTime() < STALE_MS : false
})

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
    refreshSummary()
    refreshFills()
  }, 5000)
})
onBeforeUnmount(() => clearInterval(timer))

const toggling = ref(false)
async function setKillSwitch(on: boolean) {
  toggling.value = true
  try {
    await $fetch('/api/kill-switch', { method: 'POST', body: { on } })
    toast.success(on ? '매매를 중지했어요' : '매매를 재개했어요')
    await refreshSummary()
  }
  catch (e) {
    toast.error(`kill switch 변경 실패: ${e instanceof Error ? e.message : e}`)
  }
  finally {
    toggling.value = false
  }
}
</script>

<template>
  <main class="mx-auto flex max-w-6xl flex-col gap-6 p-6">
    <header class="flex flex-wrap items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <h1 class="text-2xl font-semibold">
          toss-autotrade
        </h1>
        <Badge v-if="summary?.status" variant="outline">
          {{ summary.status.mode }}
        </Badge>
        <Badge :variant="botAlive ? 'default' : 'destructive'" data-testid="bot-status">
          {{ botAlive ? '봇 실행 중' : '봇 응답 없음' }}
        </Badge>
      </div>
      <label class="flex items-center gap-3 text-sm font-medium">
        <span :class="summary?.killSwitch ? 'text-destructive' : ''">
          {{ summary?.killSwitch ? 'Kill switch 켜짐 (매매 중지)' : 'Kill switch 꺼짐' }}
        </span>
        <Switch
          data-testid="kill-switch"
          :model-value="summary?.killSwitch ?? false"
          :disabled="toggling"
          @update:model-value="setKillSwitch"
        />
      </label>
    </header>

    <p v-if="summary?.status?.lastError" class="rounded-md border border-destructive/50 p-3 text-sm text-destructive">
      마지막 오류: {{ summary.status.lastError }}
    </p>

    <section class="grid gap-4 sm:grid-cols-3">
      <Card>
        <CardHeader>
          <CardDescription>오늘 실현 손익 ({{ summary?.today }})</CardDescription>
          <CardTitle class="text-2xl" :class="pnlClass(summary?.realizedPnlKrwToday)" data-testid="pnl-today">
            {{ formatMoney(summary?.realizedPnlKrwToday) }}
          </CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>오늘 매수 횟수</CardDescription>
          <CardTitle class="text-2xl">
            {{ summary?.buysToday ?? 0 }}
          </CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>마지막 heartbeat</CardDescription>
          <CardTitle class="text-2xl">
            {{ summary?.status ? formatTime(summary.status.heartbeatAt) : '-' }}
          </CardTitle>
        </CardHeader>
      </Card>
    </section>

    <Card>
      <CardHeader>
        <CardTitle>보유 포지션</CardTitle>
      </CardHeader>
      <CardContent class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-left text-muted-foreground">
            <tr class="border-b">
              <th class="py-2">
                종목
              </th>
              <th class="text-right">
                수량
              </th>
              <th class="text-right">
                평균가
              </th>
              <th class="text-right">
                현재가
              </th>
              <th class="text-right">
                평가손익
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in summary?.positions" :key="p.symbol" class="border-b last:border-0">
              <td class="py-2 font-medium">
                {{ p.symbol }}
              </td>
              <td class="text-right">
                {{ formatNumber(p.quantity) }}
              </td>
              <td class="text-right">
                {{ formatMoney(p.avgPrice, p.currency) }}
              </td>
              <td class="text-right">
                {{ formatMoney(p.lastPrice, p.currency) }}
              </td>
              <td class="text-right" :class="pnlClass(p.unrealizedPnl)">
                {{ formatMoney(p.unrealizedPnl, p.currency) }}
              </td>
            </tr>
            <tr v-if="!summary?.positions.length">
              <td colspan="5" class="py-6 text-center text-muted-foreground">
                보유 포지션이 없어요
              </td>
            </tr>
          </tbody>
        </table>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>체결 내역</CardTitle>
        <CardDescription>최근 100건</CardDescription>
      </CardHeader>
      <CardContent class="overflow-x-auto">
        <table class="w-full text-sm" data-testid="fills">
          <thead class="text-left text-muted-foreground">
            <tr class="border-b">
              <th class="py-2">
                시각
              </th>
              <th>종목</th>
              <th>구분</th>
              <th class="text-right">
                수량
              </th>
              <th class="text-right">
                가격
              </th>
              <th class="text-right">
                실현손익
              </th>
              <th class="pl-4">
                사유
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in fills" :key="f.clientOrderId" class="border-b last:border-0">
              <td class="py-2 whitespace-nowrap">
                {{ formatTime(f.timestamp) }}
              </td>
              <td>{{ f.symbol }}</td>
              <td>
                <Badge :variant="f.side === 'BUY' ? 'default' : 'secondary'">
                  {{ f.side === 'BUY' ? '매수' : '매도' }}
                </Badge>
              </td>
              <td class="text-right">
                {{ formatNumber(f.quantity) }}
              </td>
              <td class="text-right">
                {{ formatMoney(f.price, f.currency) }}
              </td>
              <td class="text-right" :class="pnlClass(f.realizedPnlKrw)">
                {{ f.side === 'SELL' ? formatMoney(f.realizedPnlKrw) : '' }}
              </td>
              <td class="pl-4 text-muted-foreground">
                {{ f.reason }}
              </td>
            </tr>
            <tr v-if="!fills?.length">
              <td colspan="7" class="py-6 text-center text-muted-foreground">
                체결 내역이 없어요
              </td>
            </tr>
          </tbody>
        </table>
      </CardContent>
    </Card>
  </main>
</template>
