<script setup lang="ts">
const route = useRoute()
const { data: run, error } = await useFetch(`/api/backtests/${route.params.id}`)
const selected = ref(0)
const result = computed(() => run.value?.results[selected.value])
</script>

<template>
  <main class="mx-auto flex max-w-6xl flex-col gap-6 p-6">
    <header class="flex flex-wrap items-center gap-3">
      <NuxtLink to="/backtests" class="text-sm text-muted-foreground underline-offset-4 hover:underline">
        ← 백테스트 목록
      </NuxtLink>
      <h1 v-if="run" class="text-2xl font-semibold">
        #{{ run.id }} · {{ run.params.strategy.toUpperCase() }}({{ run.params.smaShort }}, {{ run.params.smaLong }})
      </h1>
    </header>

    <p v-if="error" class="text-destructive">
      결과를 찾을 수 없어요.
    </p>

    <template v-if="run">
      <p class="text-sm text-muted-foreground">
        {{ formatYmd(run.params.from) }} ~ {{ formatYmd(run.params.to) }} · 주문 예산 {{ formatMoney(run.params.orderBudgetKrw) }}
        · 수수료 {{ (Number(run.params.feeRate) * 100).toFixed(3) }}% · 국내 매도세 {{ (Number(run.params.krSellTaxRate) * 100).toFixed(2) }}%
        · USD/KRW {{ run.params.usdKrw }} · 종가 체결 기준
      </p>

      <Card>
        <CardHeader>
          <CardTitle>종목별 결과</CardTitle>
          <CardDescription>행을 누르면 아래에 손익 추이와 거래 내역이 나와요.</CardDescription>
        </CardHeader>
        <CardContent class="overflow-x-auto">
          <BacktestTable :results="run.results" :selected="selected" @select="selected = $event" />
        </CardContent>
      </Card>

      <Card v-if="result">
        <CardHeader>
          <CardTitle>{{ result.symbol }} 누적 손익</CardTitle>
          <CardDescription>
            수익률 {{ formatPct(result.metrics.returnPct) }} · 그냥 보유 {{ formatPct(result.metrics.buyHoldReturnPct) }}
            · 보유 기간 비율 {{ result.metrics.exposurePct }}% · 수수료·세금 {{ formatMoney(result.metrics.feesKrw) }}
          </CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-4">
          <p v-for="w in result.warnings" :key="w" class="rounded-md border border-amber-500/50 p-2 text-sm text-amber-700">
            {{ w }}
          </p>
          <EquityChart v-if="result.equity.length" :points="result.equity" />
        </CardContent>
      </Card>

      <Card v-if="result">
        <CardHeader>
          <CardTitle>{{ result.symbol }} 거래 내역</CardTitle>
          <CardDescription>{{ result.trades.length }}건</CardDescription>
        </CardHeader>
        <CardContent class="overflow-x-auto">
          <table class="w-full text-sm" data-testid="trades">
            <thead class="text-left text-muted-foreground">
              <tr class="border-b">
                <th class="py-2">
                  날짜
                </th>
                <th>구분</th>
                <th class="text-right">
                  수량
                </th>
                <th class="text-right">
                  가격
                </th>
                <th class="text-right">
                  손익 (수수료 후)
                </th>
                <th class="pl-4">
                  사유
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(t, i) in result.trades" :key="i" class="border-b last:border-0">
                <td class="py-2 whitespace-nowrap">
                  {{ formatYmd(t.date) }}
                </td>
                <td>
                  <Badge :variant="t.side === 'BUY' ? 'default' : 'secondary'">
                    {{ t.side === 'BUY' ? '매수' : '매도' }}
                  </Badge>
                </td>
                <td class="text-right">
                  {{ formatNumber(t.quantity) }}
                </td>
                <td class="text-right">
                  {{ formatMoney(t.price, result.currency) }}
                </td>
                <td class="text-right" :class="pnlClass(t.pnlKrw)">
                  {{ t.pnlKrw === null ? '' : formatMoney(t.pnlKrw) }}
                </td>
                <td class="pl-4 text-muted-foreground">
                  {{ t.reason }}
                </td>
              </tr>
              <tr v-if="!result.trades.length">
                <td colspan="6" class="py-6 text-center text-muted-foreground">
                  거래가 없어요
                </td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>
    </template>
  </main>
</template>
